// Port of upstream expr-parse.cpp and expr-anagram.cpp: recursive-descent
// parser for the Nutrimatic pattern language.
//
// Grammar (from the website help):
//   a-z 0-9 space   literal
//   [] () {} | . ? * +   as in regexps
//   "expr"          quoted: no implicit optional spaces between atoms
//   expr&expr       intersection
//   <...>           anagram of the contained pieces
//   _  alphanumeric   #  digit   A  letter   C  consonant   V  vowel
//   -  optional space (implemented as an epsilon-or-space atom, label 0)
//
// Unless quoted, every atom gets space self-loops on its start/final states,
// making word breaks optional everywhere.
//
// Intersections (`&`, and the constraints an anagram compiles into) are kept
// as a LIST of NFA conjuncts (a Box) instead of being materialized into a
// product automaton — eager products are where big patterns explode, mostly
// into states no search ever visits. The conjunct list survives as long as
// the intersection is the whole factor (the common heavy shape, e.g.
// `(<...>&_{20})`); any composition that can't legally distribute over the
// intersection (quantifiers, unions, concatenation with variable-length
// neighbors) falls back to materializing via the eager product, preserving
// upstream semantics exactly. The search then runs on a lazy product filter
// (see expr-filter.ts).

import {
  EPSILON,
  Nfa,
  complement,
  equivalent,
  intersectExprs,
  optimize,
} from "./automata.js";
import { ParseError } from "./find-expr.js";
import {
  homophonesOf,
  phoneticsLoaded,
  rhymesOf,
} from "./phonetics.js";
import { relatedTo, thesaurusLoaded } from "./thesaurus.js";
import { entriesNfa, listNfa, normalizeEntry } from "./word-lists.js";
import {
  CONSTRUCT_NAMES,
  MAX_COUNTER_STATES,
  MAX_PATTERN_LENGTH,
  bankConstraint,
  cipherNfa,
  classConstraint,
  editConstraint,
  elementsNfa,
  encodingNfa,
  morseNfa,
  namedConstraint,
  suggestConstruct,
} from "./value-constraint.js";

const CODE_SPACE = 0x20;

/** An expression as an intersection of one or more NFAs. */
export class Box {
  and: Nfa[] = [];

  static single(nfa: Nfa): Box {
    const box = new Box();
    box.and.push(nfa);
    return box;
  }

  /** Collapse to a single NFA (eager product); cached. */
  materialize(): Nfa {
    if (this.and.length > 1) {
      const merged = new Nfa();
      intersectExprs(this.and, merged);
      this.and = [merged];
    }
    return this.and[0];
  }
}

function epsilonNfa(): Nfa {
  const nfa = new Nfa();
  nfa.setStart(nfa.addState());
  nfa.setFinal(nfa.start);
  return nfa;
}

/** Parse a full expression into `box`; returns end position or null. */
export function parseExprBox(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  let p = parseBranch(s, i, box, quoted);
  while (p !== null && s[p] === "|") {
    const branch = new Box();
    p = parseBranch(s, p + 1, branch, quoted);
    // Union does not distribute over the conjunct lists: materialize.
    const merged = box.materialize();
    merged.union(branch.materialize());
    box.and = [merged];
  }
  return p;
}

/** Back-compat wrapper: parse and materialize into an NFA. */
export function parseExpr(
  s: string,
  i: number,
  fst: Nfa,
  quoted: boolean,
): number | null {
  const box = new Box();
  const p = parseExprBox(s, i, box, quoted);
  if (p !== null) fst.copyFrom(box.materialize());
  return p;
}

function parseBranch(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  const first = new Box();
  let p = parseFactor(s, i, first, quoted);
  box.and = first.and;
  while (p !== null && s[p] === "&") {
    const next = new Box();
    p = parseFactor(s, p + 1, next, quoted);
    // Intersection is associative: just flatten the conjunct lists.
    box.and.push(...next.and);
  }
  return p;
}

function parseFactor(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  if (s[i] === "!") {
    // Negation applies to the whole factor, so `!.*ee.*` reads as "no double
    // e" rather than binding to the first piece.
    const inner = new Box();
    const p = parseFactor(s, i + 1, inner, quoted);
    if (p === null || p === i + 1) return null; // nothing to negate
    const negated = complement(inner.materialize());
    if (!negated) return null; // too large to determinize
    box.and = [negated];
    return p;
  }
  box.and = [epsilonNfa()];
  let isEpsilon = true; // box is still the empty-string identity
  let p = i;
  for (;;) {
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted);
    if (n === null) return p;
    if (isEpsilon) {
      // ε · X = X: adopt the piece wholesale, conjunct structure intact.
      box.and = piece.and;
      isEpsilon = false;
    } else {
      // General concatenation does not distribute over intersections:
      // materialize both sides. (The one sound distribution — a fixed-length
      // suffix — is applied by compileQuery for the trailing space.)
      const merged = box.materialize();
      merged.concat(piece.materialize());
      box.and = [merged];
    }
    p = n;
  }
}

function parsePiece(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  const atom = new Box();
  let p = parseAtom(s, i, atom, quoted);
  if (p === null) return null;

  let min: number;
  let max: number;
  const INF = Number.MAX_SAFE_INTEGER;
  if (s[p] === "*") {
    min = 0;
    max = INF;
    ++p;
  } else if (s[p] === "+") {
    min = 1;
    max = INF;
    ++p;
  } else if (s[p] === "?") {
    min = 0;
    max = 1;
    ++p;
  } else if (s[p] === "{" && /^\{\d*(,\d*)?\}/.test(s.slice(p))) {
    // Only a `{m,n}` shape is a quantifier. Anything else starting with `{`
    // is a named construct and belongs to the *next* piece, so `A* {rhyme:day}`
    // and `x{sum=1:A*}` read the way they look.
    const m = /^(\d*)(?:(,)(\d*))?/.exec(s.slice(p + 1))!;
    min = m[1] === "" ? 0 : parseInt(m[1], 10);
    if (m[2] === ",") {
      max = m[3] === "" ? INF : parseInt(m[3], 10);
    } else {
      max = min;
    }
    p += 1 + m[0].length;
    // Cap min like max: an unbounded lower bound (a{100000,}) would loop
    // building a huge NFA with no cancellation path.
    if (s[p] !== "}" || max < min || (max > 255 && max < INF) || min > 255) {
      return null;
    }
    ++p;
  } else {
    // No quantifier: the atom passes through with conjuncts intact.
    box.and = atom.and;
    return p;
  }

  // Quantifiers don't distribute over intersections: materialize the atom.
  const one = atom.materialize();

  // fst = union of one^i for min <= i <= max; `many` accumulates one^i.
  const fst = new Nfa();
  const many = epsilonNfa();

  for (let n = 0; n <= min || (n <= max && max < INF); ++n) {
    if (n >= min) fst.union(many);
    many.concat(one);
  }

  if (max >= INF) {
    const star = one.clone();
    star.closureStar();
    many.concat(star);
    fst.union(many);
  }

  box.and = [fst];
  return p;
}

function parseAtom(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  if (i >= s.length) return null;

  if (s[i] === '"' && !quoted) {
    const p = parseExprBox(s, i + 1, box, true);
    if (p === null || s[p] !== '"') return null;
    return p + 1;
  } else if (s[i] === "(") {
    const p = parseExprBox(s, i + 1, box, quoted);
    if (p === null || s[p] !== ")") return null;
    return p + 1;
  } else if (s[i] === "<" && s[i + 1] === "<") {
    // <<letters>> is the puzzle notation for a letter bank.
    const close = s.indexOf(">>", i + 2);
    if (close < 0) return null;
    const bank = bankConstraint(s.slice(i + 2, close), "bank");
    if (!bank) return null;
    box.and = bank;
    return close + 2;
  } else if (s[i] === "<") {
    const p = parseAnagram(s, i + 1, box, quoted);
    if (p === null || s[p] !== ">") return null;
    return p + 1;
  } else if (s[i] === "{") {
    // A brace at atom position is a named constraint; as a quantifier it can
    // only follow an atom, so there is no ambiguity with `A{4,8}`.
    return parseNamedConstraint(s, i, box, quoted);
  }

  const chars: number[] = [];
  let negate = false;
  let p = i;

  if (s[p] === "[") {
    if (s[++p] === "^") {
      negate = true;
      ++p;
    }
    while (s[p] !== "]") {
      if (p >= s.length) return null;
      if (s[p] === "-") {
        const first = s.charCodeAt(p - 1);
        const last = s.charCodeAt(p + 1);
        for (let c = first + 1; c <= last; ++c) {
          const isOk =
            (c >= 0x61 && c <= 0x7a) ||
            (c >= 0x30 && c <= 0x39) ||
            c === CODE_SPACE;
          if (!isOk) return null;
          chars.push(c);
        }
        p += 2;
      } else {
        const n = parseCharClass(s, p, chars);
        if (n === null) return null;
        p = n;
      }
    }
    ++p;
  } else {
    const n = parseCharClass(s, p, chars);
    if (n === null) return null;
    p = n;
  }

  const fst = new Nfa();
  const start = fst.addState();
  const final = fst.addState();
  fst.setStart(start);
  fst.setFinal(final);
  if (negate) {
    const all: number[] = [];
    parseCharClass(".", 0, all);
    for (const c of all) {
      if (!chars.includes(c)) fst.addArc(start, c, final);
    }
  } else {
    for (const c of chars) fst.addArc(start, c, final);
  }

  if (!quoted) {
    fst.addArc(start, CODE_SPACE, start);
    fst.addArc(final, CODE_SPACE, final);
  }

  box.and = [fst];
  return p;
}

/**
 * `{name spec:PATTERN}` — the pattern, intersected with a constraint automaton
 * named by `name`. Returns null (a parse error) for an unknown name, so the
 * user gets the standard "can't parse" pointer at the offending text.
 */
/** The `{…}` construct starting at `i`, for error messages. */
function constructText(s: string, i: number): string {
  const close = s.indexOf("}", i);
  return close < 0 ? s.slice(i) : s.slice(i, close + 1);
}

function parseNamedConstraint(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  const head = /^\{\s*([a-z]+)\s*([^:}]*):/i.exec(s.slice(i));
  if (!head) return null;
  // Names lex as letters, so trailing digits land in the spec — that is what
  // makes {del1:…} and {rot13:…} work. Two names are genuinely digit-bearing;
  // fold them back before dispatching.
  let name = head[1].toLowerCase();
  let spec = head[2];
  if (name === "t" && spec.trim() === "9") {
    name = "t9";
    spec = "";
  } else if (name === "rot" && spec.trim() === "180") {
    name = "rot180"; // the visual class, not a 180-place shift
    spec = "";
  }
  if (name === "like") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const word = normalizeEntry(s.slice(i + head[0].length, close));
    if (!thesaurusLoaded()) {
      throw new ParseError(
        constructText(s, i),
        "{like:…} needs the thesaurus, which this build could not load",
      );
    }
    const words = relatedTo(word);
    if (!words) {
      throw new ParseError(
        constructText(s, i),
        `the thesaurus doesn't know "${word}"`,
      );
    }
    const nfa = entriesNfa(words);
    if (!nfa) return null;
    box.and = [nfa];
    return close + 1;
  }
  if (name === "rhyme" || name === "homo") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const word = normalizeEntry(s.slice(i + head[0].length, close));
    if (!phoneticsLoaded()) {
      throw new ParseError(
        constructText(s, i),
        `{${name}:…} needs the pronunciation dictionary, which this build ` +
          "could not load",
      );
    }
    const words = name === "rhyme" ? rhymesOf(word) : homophonesOf(word);
    if (!words) {
      throw new ParseError(
        constructText(s, i),
        `the pronouncing dictionary doesn't know "${word}"` +
          (name === "rhyme" ? "" : ", or it has no homophone"),
      );
    }
    const nfa = entriesNfa(words);
    if (!nfa) return null;
    box.and = [nfa];
    return close + 1;
  }
  if (name === "list") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const list = listNfa(s.slice(i + head[0].length, close));
    if (!list) {
      throw new ParseError(
        constructText(s, i),
        `no such list "${s.slice(i + head[0].length, close).trim()}" — ` +
          "write entries with commas to give your own",
      );
    }
    box.and = [list];
    return close + 1;
  }
  if (name === "morse") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const m = morseNfa(s.slice(i + head[0].length, close));
    if (!m || spec.trim() !== "") {
      throw new ParseError(
        constructText(s, i),
        `{morse:…} takes dots and dashes (up to ${MAX_PATTERN_LENGTH})`,
      );
    }
    box.and = [m];
    return close + 1;
  }
  if (name === "elements") {
    // Unlike the other encodings this wraps a pattern: it constrains how the
    // match is spelled rather than supplying the text.
    if (spec.trim() !== "") return null;
    const p = parseExprBox(s, i + head[0].length, box, quoted);
    if (p === null || s[p] !== "}") return null;
    box.and.push(elementsNfa());
    return p + 1;
  }
  if (["t9", "enum"].includes(name)) {
    // Encodings take a literal argument (digits, or a list of word lengths).
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const enc = encodingNfa(name, spec, s.slice(i + head[0].length, close));
    if (!enc) {
      throw new ParseError(
        constructText(s, i),
        name === "t9"
          ? `{t9:…} takes keypad digits 2-9 (up to ${MAX_PATTERN_LENGTH})`
          : "{enum:…} takes word lengths — each 1-40, " +
            `${MAX_PATTERN_LENGTH} letters in total — e.g. {enum:4,3,5}`,
      );
    }
    box.and = [enc];
    return close + 1;
  }
  if (["caesar", "rot", "atbash"].includes(name)) {
    // Ciphers transform a literal, so the atom is the transformed text.
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const cipher = cipherNfa(name, spec, s.slice(i + head[0].length, close));
    if (!cipher) {
      throw new ParseError(
        constructText(s, i),
        `{${name}…} takes literal text, and rot/caesar take a shift`,
      );
    }
    box.and = [cipher];
    return close + 1;
  }
  if (["del", "add", "subst", "edit"].includes(name)) {
    // Edits also take a literal word rather than a pattern.
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const edit = editConstraint(name, spec, s.slice(i + head[0].length, close));
    if (!edit) {
      throw new ParseError(
        constructText(s, i),
        `{${name}…} takes a literal word, up to 5 edits — e.g. {del1:beast}`,
      );
    }
    box.and = [edit];
    return close + 1;
  }
  if (name === "sub" || name === "bank") {
    // These take a literal bag of letters, not a pattern: the atom *is* the
    // constraint, so there is nothing further to parse inside.
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const bank = bankConstraint(s.slice(i + head[0].length, close), name);
    if (!bank) {
      throw new ParseError(
        constructText(s, i),
        `{${name}:…} takes letters — e.g. {sub:cryptography}`,
      );
    }
    box.and = bank;
    return close + 1;
  }
  const conjuncts = namedConstraint(name, spec) ?? classConstraint(name, spec);
  if (!conjuncts) {
    const whole = s.slice(i, s.indexOf("}", i) + 1 || undefined);
    if (!CONSTRUCT_NAMES.includes(name)) {
      const near = suggestConstruct(name);
      throw new ParseError(
        whole,
        `no such constraint "${name}"${near ? ` — did you mean "${near}"?` : ""}`,
      );
    }
    const big = /(\d{4,})/.exec(spec);
    throw new ParseError(
      whole,
      big && +big[1] >= MAX_COUNTER_STATES
        ? `${name} bound ${big[1]} is too large (max ${MAX_COUNTER_STATES - 1})`
        : `"${name}" doesn't understand "${spec.trim()}" in ${whole}`,
    );
  }
  const p = parseExprBox(s, i + head[0].length, box, quoted);
  if (p === null || s[p] !== "}") return null;
  box.and.push(...conjuncts);
  return p + 1;
}

function parseCharClass(s: string, i: number, out: number[]): number | null {
  if (i >= s.length) return null;
  const ch = s[i];
  const c = s.charCodeAt(i);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || ch === " ") {
    out.push(c);
  } else if (ch === "-") {
    // Optional space: epsilon (label 0) or a space.
    out.push(EPSILON);
    out.push(CODE_SPACE);
  } else if (ch === ".") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
    out.push(CODE_SPACE);
  } else if (ch === "_") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
  } else if (ch === "#") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
  } else if (ch === "A") {
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
  } else if (ch === "C") {
    for (let a = 0x61; a <= 0x7a; ++a) {
      if (!"aeiou".includes(String.fromCharCode(a))) out.push(a);
    }
  } else if (ch === "V") {
    for (let a = 0x61; a <= 0x7a; ++a) {
      if ("aeiou".includes(String.fromCharCode(a))) out.push(a);
    }
  } else {
    return null;
  }
  return i + 1;
}

// ---- Anagrams (port of expr-anagram.cpp) ----

interface AnagramPart {
  expr: Nfa;
  count: number;
}

function collapseIdentical(parts: AnagramPart[]): void {
  for (let i = 0; i < parts.length; ++i) {
    let jout = i + 1;
    for (let jin = i + 1; jin < parts.length; ++jin) {
      if (equivalent(parts[i].expr, parts[jin].expr)) {
        ++parts[i].count;
      } else {
        parts[jout++] = parts[jin];
      }
    }
    parts.length = jout;
  }
}

/** The anagram as a conjunct list (upstream materializes; we defer). */
function makeAnagramConjuncts(parts: AnagramPart[]): Nfa[] {
  const conjuncts: Nfa[] = [];

  // any = union of all parts; total = number of pieces.
  const any = new Nfa();
  let total = 0;
  for (const part of parts) {
    any.union(part.expr);
    total += part.count;
  }

  // The match consists of exactly `total` pieces...
  const hasLength = epsilonNfa();
  for (let i = 0; i < total; ++i) hasLength.concat(any);
  conjuncts.push(hasLength);

  // ...and for each part, contains it `count` times (with any others around).
  for (let i = 0; i < parts.length; ++i) {
    const others = new Nfa();
    for (let j = 0; j < parts.length; ++j) {
      if (j !== i) others.union(parts[j].expr);
    }
    others.closureStar();

    const containsPart = others.clone();
    for (let n = 0; n < parts[i].count; ++n) {
      containsPart.concat(parts[i].expr);
      containsPart.concat(others);
    }
    conjuncts.push(containsPart);
  }

  return conjuncts;
}

function parseAnagram(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
): number | null {
  const parts: AnagramPart[] = [];
  let p = i;
  while (s[p] !== ">") {
    if (p >= s.length) return null;
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted);
    if (n === null) return null;
    p = n;
    parts.push({ expr: optimize(piece.materialize()), count: 1 });
  }

  collapseIdentical(parts);
  box.and = makeAnagramConjuncts(parts);
  return p;
}
