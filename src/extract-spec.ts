// Output extraction: `{at 3:PATTERN}` emits the third letter of each match
// instead of the whole match. Puzzle hunts rarely want the word — they want
// one letter from it, and transcribing twelve answers by hand to read an
// extraction is where mistakes happen.
//
// This is an output concern, not a language one: it wraps the whole pattern
// and never composes into a subexpression, so it is parsed and stripped before
// the pattern reaches the engine. That keeps the automaton untouched.

export interface ExtractSpec {
  /** 1-based letter positions; negative counts from the end (-1 = last). */
  positions: number[];
}

export interface ExtractQuery {
  spec: ExtractSpec;
  /** The pattern with the wrapper removed, to hand to the engine. */
  inner: string;
}

export class ExtractError extends Error {}

/** Index of the `}` matching the `{` at `open`, or -1 if unbalanced. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; ++i) {
    if (s[i] === "{") ++depth;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Split a whole-query `{name spec:PATTERN}` wrapper. Wrappers are output
 * concerns: exactly one, always outermost, stripped before the engine sees
 * the pattern. Returns null when the query isn't one, and throws
 * ExtractError when it looks like one but is malformed — so the user gets a
 * reason rather than a confusing pattern-syntax error.
 */
export function parseWrapper(
  query: string,
  name: string,
): { spec: string; inner: string } | null {
  const q = query.trim();
  // \b after the name so a longer identifier starting with it is not
  // mistaken for it: {atbash:gsv} is a cipher, not `{at bash:…}`.
  const head = new RegExp(`^\\{\\s*${name}\\b\\s*([^:}]*):`, "i");
  const anywhere = new RegExp(`\\{\\s*${name}\\b\\s*[^:}]*:`, "i");
  const m = head.exec(q);
  if (!m) {
    // Nested use is the likely mistake; name it rather than letting the
    // engine fail on an unknown token.
    if (anywhere.test(q)) {
      throw new ExtractError(`{${name} …} must wrap the whole pattern`);
    }
    return null;
  }
  const end = matchingBrace(q, 0);
  if (end !== q.length - 1) {
    throw new ExtractError(`{${name} …} must wrap the whole pattern`);
  }
  const inner = q.slice(m[0].length, end).trim();
  if (inner === "") throw new ExtractError(`{${name} …} needs a pattern`);
  return { spec: m[1], inner };
}

export function parseExtract(query: string): ExtractQuery | null {
  const w = parseWrapper(query, "at");
  if (!w) return null;
  const positions = w.spec
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      if (!/^-?\d+$/.test(p)) throw new ExtractError(`bad position "${p}"`);
      const n = parseInt(p, 10);
      if (n === 0) throw new ExtractError("positions are 1-based (use 1, not 0)");
      return n;
    });
  if (positions.length === 0) throw new ExtractError("{at …} needs a position");
  return { spec: { positions }, inner: w.inner };
}

/** A window into the frequency-ranked result stream: `{rank 200-2000:…}`. */
export interface RankSpec {
  from: number; // 1-based, inclusive
  to: number; // inclusive; Infinity for an open end
}

export interface RankQuery {
  spec: RankSpec;
  inner: string;
}

/**
 * Parse `{rank 200-2000:PATTERN}` (or `{rank 200:PATTERN}` for an open end).
 * Hunt answers are often mid-frequency, and scrolling is the only way to
 * reach them otherwise.
 */
export function parseRank(query: string): RankQuery | null {
  const w = parseWrapper(query, "rank");
  if (!w) return null;
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(w.spec);
  if (!m) throw new ExtractError('{rank …} takes "from-to", e.g. {rank 200-2000:…}');
  const from = parseInt(m[1], 10);
  const to = m[2] === undefined ? Infinity : parseInt(m[2], 10);
  if (from < 1) throw new ExtractError("ranks are 1-based (use 1, not 0)");
  if (to < from) throw new ExtractError(`empty range (${from}-${to})`);
  return { spec: { from, to }, inner: w.inner };
}

/**
 * The letters at the spec's positions, or null when the match is too short.
 * Spaces are not counted: "third letter" means the third letter of the answer,
 * however its words happen to fall.
 */
export function applyExtract(spec: ExtractSpec, text: string): string | null {
  const letters = text.replace(/ /g, "");
  let out = "";
  for (const p of spec.positions) {
    const i = p > 0 ? p - 1 : letters.length + p;
    if (i < 0 || i >= letters.length) return null;
    out += letters[i];
  }
  return out;
}
