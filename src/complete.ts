// What can be typed next, and what it means.
//
// The completions come from the same catalogue the parser dispatches on
// (`constructs.ts`) and the same list registry the engine resolves against
// (`word-lists.ts`). That is the whole point: a hand-kept list of suggestions
// would start out right and drift with the first construct anyone adds, and a
// suggestion the engine then rejects is worse than no suggestion at all.
//
// This decides *what to offer*, not whether the query is valid — that stays
// with the real parser, which the worker runs.

import {
  CONSTRUCTS,
  ConstructGroup,
  GROUP_BLURB,
  qualifiedName,
} from "./constructs.js";
import { WikiLists, listNames } from "./word-lists.js";

export interface Completion {
  /** The text to insert in place of the token being typed. */
  insert: string;
  /** What is shown in the menu. */
  label: string;
  /** One line of explanation, shown beside the label. */
  detail: string;
  /** A worked example, when there is one worth showing. */
  example?: string;
}

/** The token under the cursor, and where it starts. */
export interface Token {
  /** What is being completed. */
  kind: "construct" | "listname" | "none";
  /** The partial text typed so far. */
  prefix: string;
  /** Index in the query where `prefix` begins. */
  start: number;
}

/**
 * Find what the cursor is in the middle of typing.
 *
 * Only two positions can be completed usefully: the name right after a `{`,
 * and the argument of `{list:…}`, which is the one construct whose argument is
 * drawn from a fixed vocabulary rather than being free text or a pattern.
 */
export function tokenAt(query: string, cursor: number): Token {
  const before = query.slice(0, cursor);

  // `{list:foo` — the argument of a list, up to the cursor.
  const list = /\{\s*(?:word\.)?list\s*:\s*([^},]*)$/i.exec(before);
  if (list) {
    return {
      kind: "listname",
      prefix: list[1],
      start: cursor - list[1].length,
    };
  }

  // `{foo`, `{cipher.ro`, `{rot13` — a construct name, before any `:` closes
  // it. Digits belong to the name: rot13, rot180, row1 and t9 are all typed
  // with them, and stopping at the first digit offers nothing exactly when
  // the two rot constructs need telling apart.
  const name = /\{\s*([a-z][a-z0-9.]*|)$/i.exec(before);
  if (name) {
    // `A{5` is a quantifier, not a construct: a bare number completes nothing.
    return {
      kind: "construct",
      prefix: name[1].toLowerCase(),
      start: cursor - name[1].length,
    };
  }

  return { kind: "none", prefix: "", start: cursor };
}

/** Rank: a prefix match beats a match in the middle, and shorter beats longer. */
function rank(candidate: string, prefix: string): number {
  if (!prefix) return 1;
  const at = candidate.indexOf(prefix);
  if (at === -1) return -1;
  return (at === 0 ? 100 : 50) - candidate.length / 100;
}

const GROUPS = [...new Set(CONSTRUCTS.map((c) => c.group))];

function constructCompletions(prefix: string): Completion[] {
  const out: Array<Completion & { score: number }> = [];

  // A bare group prefix offers the family itself, so `{ci` reaches every
  // cipher without knowing any of their names.
  for (const g of GROUPS) {
    const score = rank(g, prefix);
    if (score < 0) continue;
    out.push({
      score: score - 1, // just below a real construct of equal match
      insert: `${g}.`,
      label: `${g}.`,
      detail: `${GROUP_BLURB[g as ConstructGroup]} — ${
        CONSTRUCTS.filter((c) => c.group === g).length
      } constructs`,
    });
  }

  for (const c of CONSTRUCTS) {
    // Offer both spellings, so typing the family or the bare name both work.
    const qualified = qualifiedName(c);
    const bareScore = rank(c.name, prefix);
    const qualScore = rank(qualified, prefix);
    const score = Math.max(bareScore, qualScore);
    if (score < 0) continue;
    // Insert whichever spelling the typing actually matched: someone who typed
    // "ci" was reaching for the cipher family, so completing to a bare "rot:"
    // would silently drop what they wrote.
    const insert = qualScore > bareScore ? qualified : c.name;
    out.push({
      score,
      insert: `${insert}:`,
      label: `${insert}:`,
      detail: c.summary,
      example: c.example,
    });
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.map(({ score, ...rest }) => rest);
}

function listCompletions(prefix: string, lists: WikiLists | null): Completion[] {
  const key = prefix.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: Array<Completion & { score: number }> = [];
  for (const name of listNames()) {
    const score = rank(name, key);
    if (score < 0) continue;
    out.push({ score: score + 1, insert: name, label: name, detail: "built in" });
  }
  if (lists) {
    for (const [slug, subject] of lists.subjects) {
      const score = rank(slug, key);
      if (score < 0) continue;
      out.push({ score, insert: slug, label: slug, detail: subject });
    }
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.map(({ score, ...rest }) => rest);
}

/**
 * Completions for the cursor position, best first. `lists` may be null: the
 * harvested catalogue is fetched on demand, so before any query has needed it
 * only the built-in list names can be offered.
 */
export function completionsAt(
  query: string,
  cursor: number,
  lists: WikiLists | null = null,
  limit = 12,
): { token: Token; items: Completion[] } {
  const token = tokenAt(query, cursor);
  if (token.kind === "none") return { token, items: [] };
  const items =
    token.kind === "construct"
      ? constructCompletions(token.prefix)
      : listCompletions(token.prefix, lists);
  return { token, items: items.slice(0, limit) };
}
