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
  MAX_COMPLEMENT_STATES,
  Nfa,
  complement,
  equivalent,
  intersectExprs,
  optimize,
} from "./automata.js";
import { Conjunct, isNegated } from "./conjunct.js";
import { ParseError } from "./parse-error.js";
import { SessionContext } from "./session-context.js";
import {
  findConstruct,
  foldName,
  levelAdvice,
  resolveConstruct,
  suggestConstruct,
} from "./constructs.js";
import { homophonesOf, rhymesOf } from "./phonetics.js";
import { MAX_CATEGORY, kindsOf } from "./categories.js";
import { nearestTo } from "./neighbours.js";
import { relatedTo } from "./thesaurus.js";
import {
  entriesNfa,
  listNfa,
  normalizeEntry,
  suggestList,
} from "./word-lists.js";
import {
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
} from "./value-constraint.js";

const CODE_SPACE = 0x20;

/** An expression as an intersection of one or more conjuncts. */
export class Box {
  and: Conjunct[] = [];

  static single(nfa: Nfa): Box {
    const box = new Box();
    box.and.push(nfa);
    return box;
  }

  /**
   * Collapse to a single NFA (eager product); cached.
   *
   * Callers are the places an NFA is structurally required and a lazy filter
   * will not do: a union, a quantifier, concatenation. A negated conjunct has
   * to be complemented for real here, which means determinizing it, which is
   * the cost the lazy path exists to avoid — so this is also the only place
   * negation can still hit a limit, and it says so.
   */
  materialize(): Nfa {
    if (this.and.some(isNegated)) {
      this.and = this.and.map((c) => {
        if (!isNegated(c)) return c;
        const done = complement(c.not);
        if (!done) {
          throw new ParseError(
            "",
            `this negation has to be built out in full here — inside a ` +
              `quantifier, a union or a longer pattern — and it is over the ` +
              `${MAX_COMPLEMENT_STATES}-state limit for that. On its own, or ` +
              `joined with "&", the same negation is checked as the search ` +
              `runs and has no limit.`,
          );
        }
        return done;
      });
    }
    if (this.and.length > 1) {
      const merged = new Nfa();
      intersectExprs(this.and as Nfa[], merged);
      this.and = [merged];
    }
    return this.and[0] as Nfa;
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
  ctx: SessionContext,
): number | null {
  let p = parseBranch(s, i, box, quoted, ctx);
  while (p !== null && s[p] === "|") {
    const branch = new Box();
    p = parseBranch(s, p + 1, branch, quoted, ctx);
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
  ctx: SessionContext,
): number | null {
  const box = new Box();
  const p = parseExprBox(s, i, box, quoted, ctx);
  if (p !== null) fst.copyFrom(box.materialize());
  return p;
}

function parseBranch(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const first = new Box();
  let p = parseFactor(s, i, first, quoted, ctx);
  box.and = first.and;
  while (p !== null && s[p] === "&") {
    const next = new Box();
    p = parseFactor(s, p + 1, next, quoted, ctx);
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
  ctx: SessionContext,
): number | null {
  if (s[i] === "!") {
    // Negation applies to the whole factor, so `!.*ee.*` reads as "no double
    // e" rather than binding to the first piece.
    const inner = new Box();
    const p = parseFactor(s, i + 1, inner, quoted, ctx);
    if (p === null || p === i + 1) return null; // nothing to negate
    // Left unmaterialized: `ComplementFilter` walks it lazily at search time,
    // and only `Box.materialize` — a union or a quantifier around the
    // negation, where an NFA is structurally required — has to pay for the
    // eager complement.
    box.and = [{ not: inner.materialize() }];
    return p;
  }
  box.and = [epsilonNfa()];
  let isEpsilon = true; // box is still the empty-string identity
  let p = i;
  for (;;) {
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted, ctx);
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
  ctx: SessionContext,
): number | null {
  const atom = new Box();
  let p = parseAtom(s, i, atom, quoted, ctx);
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
  ctx: SessionContext,
): number | null {
  if (i >= s.length) return null;

  if (s[i] === '"' && !quoted) {
    const p = parseExprBox(s, i + 1, box, true, ctx);
    if (p === null || s[p] !== '"') return null;
    return p + 1;
  } else if (s[i] === "(") {
    const p = parseExprBox(s, i + 1, box, quoted, ctx);
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
    const p = parseAnagram(s, i + 1, box, quoted, ctx);
    if (p === null || s[p] !== ">") return null;
    return p + 1;
  } else if (s[i] === "{") {
    // A brace at atom position is a named constraint; as a quantifier it can
    // only follow an atom, so there is no ambiguity with `A{4,8}`.
    return parseNamedConstraint(s, i, box, quoted, ctx);
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
/**
 * A construct spelled correctly but given no argument: `{rot13}`, `{caesar}`,
 * `{sum=52}`.
 *
 * Dispatch needs the colon, so these never reached the construct that would
 * have explained itself, and came back as `can't parse "{rot13}"` — the one
 * message that cannot help, because it suggests the name is wrong when the
 * name is the only part that was right. Every construct already carries a
 * summary and a worked example for the generated reference, so the answer is
 * to say those.
 *
 * Throws when it recognises the name and returns otherwise, leaving `{5}` and
 * every other brace-shaped thing to be parsed as whatever it is.
 */
function bareConstruct(s: string, i: number): void {
  const bare = /^\{\s*([a-z][a-z.]*)\s*([^:}]*)\}/i.exec(s.slice(i));
  if (!bare) return;
  const token = bare[1].toLowerCase();
  const typed = token.slice(token.lastIndexOf(".") + 1);
  const { name } = foldName(typed, bare[2]);
  const info = findConstruct(name);
  if (!info) return;
  // Named as it was typed, not as it folds: someone who wrote `{rot13}` is
  // not helped by a message about `{rot…}`, which is a name they have never
  // seen. `bare[2]` carries the digits back, since the name lexes as letters.
  const shown = `${typed}${bare[2].trim()}`;
  throw new ParseError(
    constructText(s, i),
    `{${shown}…} takes an argument after a colon — ${info.summary}. ` +
      `Try ${info.example}`,
  );
}

function constructText(s: string, i: number): string {
  const close = s.indexOf("}", i);
  return close < 0 ? s.slice(i) : s.slice(i, close + 1);
}

function parseNamedConstraint(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const head = /^\{\s*([a-z][a-z.]*)\s*([^:}]*):/i.exec(s.slice(i));
  if (!head) {
    bareConstruct(s, i);
    return null;
  }
  // Names lex as letters, so trailing digits land in the spec — that is what
  // makes {del1:…} and {rot13:…} work. Two names are genuinely digit-bearing;
  // fold them back before dispatching.
  const token = head[1].toLowerCase();
  let spec = head[2];
  // An optional group prefix: {cipher.rot13:…} says which family this is, and
  // is rejected if it names the wrong one. The bare form stays valid — every
  // shared query URL uses it.
  if (token.includes(".")) {
    const resolved = resolveConstruct(token, spec);
    if (resolved && "error" in resolved) {
      throw new ParseError(constructText(s, i), resolved.error);
    }
  }
  const folded = foldName(token.slice(token.lastIndexOf(".") + 1), spec);
  const name = folded.name;
  spec = folded.spec;
  if (name === "kind") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const word = normalizeEntry(s.slice(i + head[0].length, close));
    if (!ctx.categories) {
      throw new ParseError(
        constructText(s, i),
        "{kind:…} needs the category data, which this build could not load",
        true,
      );
    }
    if (word === "") {
      throw new ParseError(
        constructText(s, i),
        "{kind:…} needs a category name — e.g. {kind:bird}",
      );
    }
    const kinds = kindsOf(ctx.categories, word);
    if (!kinds) {
      throw new ParseError(
        constructText(s, i),
        `no category "${word}" — either WordNet has no such noun or verb, or ` +
          `it covers more than ${MAX_CATEGORY} names and is too broad to be a clue`,
      );
    }
    const nfa = entriesNfa(kinds);
    if (!nfa) return null;
    box.and = [nfa];
    return close + 1;
  }
  if (name === "near") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    // An optional count: {near 60:word} widens the net.
    const limit = /^\s*(\d+)\s*$/.exec(spec);
    if (spec.trim() !== "" && !limit) return null;
    const word = normalizeEntry(s.slice(i + head[0].length, close));
    if (!ctx.neighbours) {
      throw new ParseError(
        constructText(s, i),
        "{near:…} needs the meaning table, which this build could not load",
        true,
      );
    }
    const words = nearestTo(ctx.neighbours, word, limit ? +limit[1] : 32);
    if (!words) {
      throw new ParseError(
        constructText(s, i),
        `"${word}" is not in the meaning vocabulary (the 60,000 commonest ` +
          "words); {like:…} covers a much larger dictionary",
      );
    }
    const nfa = entriesNfa(words);
    if (!nfa) return null;
    box.and = [nfa];
    return close + 1;
  }
  if (name === "like") {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const word = normalizeEntry(s.slice(i + head[0].length, close));
    if (!ctx.thesaurus) {
      throw new ParseError(
        constructText(s, i),
        "{like:…} needs the thesaurus, which this build could not load",
        true,
      );
    }
    const words = relatedTo(ctx.thesaurus, word);
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
    if (!ctx.phonetics) {
      throw new ParseError(
        constructText(s, i),
        `{${name}:…} needs the pronunciation dictionary, which this build ` +
          "could not load",
        true,
      );
    }
    const words =
      name === "rhyme"
        ? rhymesOf(ctx.phonetics, word)
        : homophonesOf(ctx.phonetics, word);
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
    const list = listNfa(s.slice(i + head[0].length, close), ctx.lists);
    if (!list) {
      const asked = s.slice(i + head[0].length, close).trim();
      if (asked === "") {
        throw new ParseError(
          constructText(s, i),
          "{list:…} needs a list name — e.g. {list:greek} — or your own " +
            "entries separated by commas",
        );
      }
      const near = suggestList(asked, ctx.lists);
      throw new ParseError(
        constructText(s, i),
        `no such list "${asked}"` +
          (near ? ` — did you mean "${near}"?` : "") +
          " — or write entries with commas to give your own",
        // The harvested catalogue may simply not be fetched yet.
        ctx.lists === null,
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
    const p = parseExprBox(s, i + head[0].length, box, quoted, ctx);
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
    // Edits wrap whatever is inside, not just a literal: `{del1:beast}` is one
    // letter off a word, `{del1:{kind:instrument}}` is one letter off *any*
    // instrument. Parsed in quoted mode, so a bare word is the exact letter
    // chain it looks like rather than a pattern that may skip spaces.
    const inner = new Box();
    const p = parseExprBox(s, i + head[0].length, inner, true, ctx);
    if (p === null || s[p] !== "}") return null;
    const edit = editConstraint(name, spec, inner.materialize());
    if (!edit) {
      throw new ParseError(
        constructText(s, i),
        `{${name}…} takes a word or a pattern and up to 5 edits — e.g. ` +
          `{del1:beast} or {del1:{kind:instrument}}. A big set with ` +
          `substitutions or insertions is too large to build; try {del…}, or ` +
          `narrow the set.`,
      );
    }
    box.and = [edit];
    return p + 1;
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
    const known = findConstruct(name);
    if (!known) {
      const near = suggestConstruct(name);
      throw new ParseError(
        whole,
        `no such constraint "${name}"${near ? ` — did you mean "${near}"?` : ""}`,
      );
    }
    if (known.level !== "automaton") {
      // It exists — it just cannot be nested. Saying "no such constraint" here
      // sent people looking for a typo in a name that was spelled correctly.
      throw new ParseError(whole, levelAdvice(known));
    }
    const big = /(\d{4,})/.exec(spec);
    throw new ParseError(
      whole,
      big && +big[1] >= MAX_COUNTER_STATES
        ? `${name} bound ${big[1]} is too large (max ${MAX_COUNTER_STATES - 1})`
        : `"${name}" doesn't understand "${spec.trim()}" in ${whole}`,
    );
  }
  const p = parseExprBox(s, i + head[0].length, box, quoted, ctx);
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
  ctx: SessionContext,
): number | null {
  const parts: AnagramPart[] = [];
  let p = i;
  while (s[p] !== ">") {
    if (p >= s.length) return null;
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted, ctx);
    if (n === null) return null;
    p = n;
    parts.push({ expr: optimize(piece.materialize()), count: 1 });
  }

  collapseIdentical(parts);
  box.and = makeAnagramConjuncts(parts);
  return p;
}
