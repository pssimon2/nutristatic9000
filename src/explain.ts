// Why did this match?
//
// The engine reports that a string satisfied the query and then throws away
// everything about how. For most patterns that is fine — you can see that
// SOLAR SYSTEM matches `solar s_stem`. It is not fine for the constructs that
// do the work out of sight: `{kind:instrument}&{add1:{kind:bird}}` returns
// CLOCK with no hint that the bird was COCK and the added letter was an L.
//
// This reconstructs the reasoning after the fact, one top-level conjunct at a
// time. It is deliberately not part of the search: it runs once, for one
// string, when someone asks — so it can afford to be slow and literal where
// the engine cannot.

import { Filter } from "./expr-filter.js";
import { compileQuery } from "./find-expr.js";
import { SessionContext } from "./session-context.js";
import { A1Z26, SCRABBLE } from "./value-constraint.js";
import { findConstruct, foldName } from "./constructs.js";

/** One conjunct of the query, and why the match does or does not satisfy it. */
export interface MatchReason {
  /** The query fragment this is about. */
  part: string;
  ok: boolean;
  /** A sentence a solver can read, or null when the part speaks for itself. */
  detail: string | null;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** The index of the `}` matching the `{` at `open`. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; ++i) {
    if (s[i] === "{") ++depth;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Split a pattern on its top-level `&`. Ampersands inside a construct, a
 * character class or a quoted run belong to that piece, not to the split.
 */
export function topLevelConjuncts(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let bracket = false;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < pattern.length; ++i) {
    const c = pattern[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "{" || c === "<") ++depth;
    else if (c === "}" || c === ">") --depth;
    else if (c === "[") bracket = true;
    else if (c === "]") bracket = false;
    else if (c === "&" && depth === 0 && !bracket) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(pattern.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** A whole-part `{name spec:inner}`, if that is what this conjunct is. */
function peelConstruct(
  part: string,
): { name: string; spec: string; inner: string } | null {
  const head = /^\{\s*([a-z][a-z.]*)\s*([^:}]*):/i.exec(part);
  if (!head) return null;
  const close = matchingBrace(part, 0);
  if (close !== part.length - 1) return null;
  const folded = foldName(
    head[1].toLowerCase().slice(head[1].lastIndexOf(".") + 1),
    head[2],
  );
  return {
    name: folded.name,
    spec: folded.spec.trim(),
    inner: part.slice(head[0].length, close),
  };
}

function accepts(filter: Filter, text: string): boolean {
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** Does `inner`, compiled on its own, accept `text`? */
function innerAccepts(
  inner: string,
  text: string,
  ctx: SessionContext,
): boolean {
  try {
    return accepts(compileQuery(inner, ctx), text);
  } catch {
    return false;
  }
}

const letters = (s: string) => s.replace(/ /g, "");
const value = (s: string, table: number[]) =>
  [...s].reduce((n, c) => n + (table[c.charCodeAt(0)] ?? 0), 0);

/**
 * Undo one edit to find what the match came from: every string one edit away
 * from `text`, tested against the construct's inner language. Reporting the
 * source is the whole point — "CLOCK" is not an explanation, "COCK plus an L"
 * is.
 */
function explainEdit(
  name: string,
  spec: string,
  inner: string,
  text: string,
  ctx: SessionContext,
): string | null {
  const n = text.length;
  // `add` means the match has a letter the source did not: drop each in turn.
  if (name === "add") {
    for (let i = 0; i < n; ++i) {
      const source = text.slice(0, i) + text.slice(i + 1);
      if (source && innerAccepts(inner, source, ctx)) {
        return `“${source}” with “${text[i]}” added`;
      }
    }
  }
  // `del` means the source had a letter the match lacks: put each back.
  if (name === "del") {
    for (let i = 0; i <= n; ++i) {
      for (const c of LETTERS) {
        const source = text.slice(0, i) + c + text.slice(i);
        if (innerAccepts(inner, source, ctx)) {
          return `“${source}” with the “${c}” removed`;
        }
      }
    }
  }
  if (name === "subst") {
    for (let i = 0; i < n; ++i) {
      for (const c of LETTERS) {
        if (c === text[i]) continue;
        const source = text.slice(0, i) + c + text.slice(i + 1);
        if (innerAccepts(inner, source, ctx)) {
          return `“${source}” with “${c}” swapped for “${text[i]}”`;
        }
      }
    }
  }
  if (name === "edit") {
    // Try each single edit; a two-edit source is not worth the search here.
    for (const op of ["add", "del", "subst"] as const) {
      const found = explainEdit(op, spec, inner, text, ctx);
      if (found) return found;
    }
    if (innerAccepts(inner, text, ctx)) return `“${text}” unchanged`;
  }
  return null;
}

/** Which Caesar shift turns the given ciphertext into this match. */
function explainCipher(name: string, arg: string, text: string): string | null {
  const cipher = letters(arg.toLowerCase().replace(/[^a-z ]/g, ""));
  const plain = letters(text);
  if (cipher.length !== plain.length) return null;
  if (name === "atbash") return `“${arg.trim()}” reflected a↔z`;
  for (let shift = 0; shift < 26; ++shift) {
    let ok = true;
    for (let i = 0; i < cipher.length && ok; ++i) {
      const from = cipher.charCodeAt(i) - 97;
      const to = plain.charCodeAt(i) - 97;
      if (from < 0 || to < 0 || (from + shift) % 26 !== to) ok = false;
    }
    if (ok) return `“${arg.trim()}” shifted by ${shift}`;
  }
  return null;
}

/** The reason one conjunct is satisfied, beyond the bare fact that it is. */
function detailFor(
  part: string,
  text: string,
  ctx: SessionContext,
): string | null {
  const c = peelConstruct(part);
  if (!c) return null;
  const info = findConstruct(c.name);
  const group = info?.group;

  if (group === "edit") {
    return explainEdit(c.name, c.spec, c.inner, text, ctx);
  }
  if (group === "cipher") {
    return explainCipher(c.name, c.inner, text);
  }
  if (group === "word") {
    // These compile to an alternation of entries, so the match *is* the entry.
    const arg = c.inner.trim();
    const said =
      c.name === "kind"
        ? `is a kind of ${arg}`
        : c.name === "list"
          ? `is in the ${arg} list`
          : c.name === "rhyme"
            ? `rhymes with ${arg}`
            : c.name === "homo"
              ? `sounds like ${arg}`
              : `is related to ${arg}`;
    return `“${text}” ${said}`;
  }
  if (group === "count") {
    if (c.name === "sum") return `letters total ${value(letters(text), A1Z26)}`;
    if (c.name === "scrabble") {
      return `tiles total ${value(letters(text), SCRABBLE)}`;
    }
    if (c.name === "letters") return `${letters(text).length} letters`;
    if (c.name === "words") return `${text.split(" ").length} words`;
    if (c.name === "count") {
      const m = /^\(([a-z0-9]+)\)/i.exec(c.spec);
      if (m) {
        const set = new Set(m[1].toLowerCase());
        const n = [...letters(text)].filter((ch) => set.has(ch)).length;
        return `${n} of those letters`;
      }
    }
    if (c.name === "distinct") return "no letter repeats";
  }
  return null;
}

/**
 * Explain, conjunct by conjunct, why `text` matches `pattern`. The pattern
 * must be the engine-level one, with any result-filter or output wrapper
 * already stripped.
 */
export function explainMatch(
  pattern: string,
  text: string,
  ctx: SessionContext,
): MatchReason[] {
  return topLevelConjuncts(pattern).map((part) => {
    let ok: boolean;
    try {
      ok = accepts(compileQuery(part, ctx), text);
    } catch {
      ok = false;
    }
    return { part, ok, detail: ok ? detailFor(part, text, ctx) : null };
  });
}
