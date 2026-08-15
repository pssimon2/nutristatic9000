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
 * Parse a whole-query `{at …:PATTERN}` wrapper. Returns null when the query
 * isn't one, and throws ExtractError when it looks like one but is malformed
 * (so the user gets a reason rather than a confusing pattern-syntax error).
 */
export function parseExtract(query: string): ExtractQuery | null {
  const q = query.trim();
  const m = /^\{\s*at\s*([^:}]*):/i.exec(q);
  if (!m) {
    // Nested use is the likely mistake; name it rather than letting the
    // engine fail on an unknown token.
    if (/\{\s*at\s*[^:}]*:/i.test(q)) {
      throw new ExtractError("{at …} must wrap the whole pattern");
    }
    return null;
  }
  const end = matchingBrace(q, 0);
  if (end !== q.length - 1) {
    throw new ExtractError("{at …} must wrap the whole pattern");
  }
  const positions = m[1]
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
  const inner = q.slice(m[0].length, end).trim();
  if (inner === "") throw new ExtractError("{at …} needs a pattern");
  return { spec: { positions }, inner };
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
