// The one list of construct names, and what level each one works at.
//
// The names used to be enumerated in several places that drifted apart:
// `CONSTRUCT_NAMES` in value-constraint.ts (which the "did you mean" search
// read), `NAMES` in result-filter.ts, and the literal strings the wrapper
// parsers match. `syllables` and `stress` were in the second list and not the
// first, so `A{4} {syllables=3:A{7}}` reported *no such constraint
// "syllables"* — for a construct that plainly exists, and works when it wraps
// the whole query — and a typo of it got no suggestion at all.
//
// Level is what a construct does, and it is why a construct can be real and
// still wrong where you put it:
//
//   automaton — intersects with the pattern, so it can appear anywhere
//   predicate — asked of a finished match, so it has to wrap the whole query
//   transform — changes what is printed, so it wraps the whole query too
//
// This is the seed of the construct registry (roadmap C4): the compile
// functions and per-construct docs join it there. Grouping for the UI hangs
// off the same table.

export type ConstructLevel = "automaton" | "predicate" | "transform";

/**
 * The group a construct belongs to, and the prefix you may write for it:
 * `{cipher.rot13:…}`. Grouped by what a solver is trying to do, not by the
 * internal level — someone reaches for "a cipher", not for "a generator".
 *
 * The prefix exists because a flat namespace of 45 names put unrelated things
 * next to each other: `rot13` is a cipher over a literal and `rot180` is the
 * set of letters that survive being turned upside down, and nothing but the
 * documentation said so. `{cipher.rot13:…}` and `{shape.rot180:…}` say it.
 */
export type ConstructGroup =
  | "word"
  | "count"
  | "bag"
  | "edit"
  | "cipher"
  | "spell"
  | "shape"
  | "match"
  | "out";

export interface ConstructInfo {
  name: string;
  level: ConstructLevel;
  group: ConstructGroup;
  /** One line, lower case, no trailing stop: shown beside the name. */
  summary: string;
  /** A query fragment that works as written. */
  example: string;
}

/** One line per group, for grouped help and generated docs. */
export const GROUP_BLURB: Record<ConstructGroup, string> = {
  word: "look words up in a dictionary or the corpus",
  count: "count letters, values or occurrences",
  bag: "restrict which letters are available",
  edit: "match something a few letters away",
  cipher: "decode a literal that has been shifted or reflected",
  spell: "spell the match some other way",
  shape: "restrict letters by how they look or where they are typed",
  match: "ask a question of each finished match",
  out: "change what is shown rather than what matches",
};

/**
 * The catalogue proper: one row per construct, carrying the one-line summary
 * and the worked example the UI offers while you type and the docs are built
 * from. Written here rather than in the usage guide so the two cannot drift —
 * a construct without a summary is a construct nobody can discover.
 */
const GROUPS: Array<
  [ConstructGroup, ConstructLevel, Array<[string, string, string]>]
> = [
  ["word", "automaton", [
    ["rhyme", "words that rhyme with one you name", "{rhyme:tree}"],
    ["homo", "words that sound the same", "{homo:knight}"],
    ["like", "words WordNet groups with this sense", "{like:reluctant}"],
    ["near", "words close in meaning, by embedding", "{near:king}"],
    ["kind", "anything below this word in WordNet", "{kind:bird}"],
    ["list", "a named category, or your own commas", "{list:greek}"],
  ]],
  ["count", "automaton", [
    ["sum", "letter values total a number (a=1…z=26)", "{sum=100:A*}"],
    ["scrabble", "Scrabble tile values total a number", "{scrabble>25:A{5}}"],
    ["count", "how many letters of a set appear", "{count(e)=2:A*}"],
    ["letters", "how many letters, ignoring spaces", "{letters=11:A*}"],
    ["words", "how many words", "{words=3:A*}"],
    ["all", "every letter of a set appears", "{all(aeiou):A*}"],
    ["distinct", "no letter is repeated", "{distinct:A{6}}"],
    ["maxrep", "no letter repeats more than N times", "{maxrep=2:A*}"],
  ]],
  ["bag", "automaton", [
    ["sub", "spellable from these letters, each used once", "{sub:cryptography}"],
    ["bank", "uses every one of these letters, repeats allowed", "{bank:washington}"],
  ]],
  ["edit", "automaton", [
    ["del", "the word with N letters removed", "{del1:beast}"],
    ["add", "the word with N letters added", "{add1:cargo}"],
    ["subst", "the word with N letters swapped", "{subst1:cargo}"],
    ["edit", "within N edits of any kind", "{edit<=2:cargo}"],
  ]],
  ["cipher", "automaton", [
    ["caesar", "every shift of a literal at once", "{caesar:kdhv}"],
    ["rot", "a literal shifted by a known amount", "{rot13:cvmmn}"],
    ["rot13", "a literal shifted by thirteen", "{rot13:cvmmn}"],
    ["atbash", "a literal with the alphabet reflected", "{atbash:gsv}"],
  ]],
  ["spell", "automaton", [
    ["t9", "every word those phone keys could spell", "{t9:2665}"],
    ["enum", "a crossword enumeration", "{enum:4,3,5}"],
    ["morse", "every word those dots and dashes spell", "{morse:...-...}"],
    ["elements", "spellable from chemical symbols", "{elements:A{6}}"],
  ]],
  ["shape", "automaton", [
    ["roman", "only Roman-numeral letters", "{roman:A*}"],
    ["rot180", "only letters that survive a half turn", "{rot180:A{4}}"],
    ["mirror", "only letters with a vertical mirror line", "{mirror:A{5}}"],
    ["sevenseg", "only letters a seven-segment display can show", "{sevenseg:A{4}}"],
    ["holes", "how many enclosed holes the letters have", "{holes=0:A{5}}"],
    ["row1", "only the top keyboard row", "{row1:A{5}}"],
    ["row2", "only the home keyboard row", "{row2:A{5}}"],
    ["row3", "only the bottom keyboard row", "{row3:A{4}}"],
    ["ascending", "letters never go backwards through the alphabet", "{ascending:A{5}}"],
    ["descending", "letters never go forwards through the alphabet", "{descending:A{4}}"],
  ]],
  ["match", "predicate", [
    ["compound", "the match cuts into N words the index knows", "{compound 2:A{9}}"],
    ["palindrome", "reads the same backwards", "{palindrome:A{5}}"],
    ["reversible", "its reversal is a word the corpus knows too", "{reversible:A{4}}"],
    ["syllables", "how many syllables, by pronunciation", "{syllables=3:A{7}}"],
    ["stress", "a metrical stress shape, 1 strong 0 weak", "{stress 010:A{8}}"],
    ["anagram", "rearranges a word, a list or whatever a pattern names", "{anagram countries:A{6}}"],
  ]],
  ["out", "transform", [
    ["at", "show the Nth letter of each match", "{at 3:A{7}}"],
    ["rank", "a window into the ranked results", "{rank 200-2000:A{6}}"],
  ]],
];

export const CONSTRUCTS: ConstructInfo[] = GROUPS.flatMap(
  ([group, level, rows]) =>
    rows.map(([name, summary, example]) => ({
      name,
      level,
      group,
      summary,
      example,
    })),
);

const GROUP_NAMES = new Set(GROUPS.map(([g]) => g));

export function isGroupName(s: string): s is ConstructGroup {
  return GROUP_NAMES.has(s as ConstructGroup);
}

const BY_NAME = new Map(CONSTRUCTS.map((c) => [c.name, c]));

/** Every construct name, at every level. */
export const CONSTRUCT_NAMES: string[] = CONSTRUCTS.map((c) => c.name);

export function findConstruct(name: string): ConstructInfo | undefined {
  return BY_NAME.get(name);
}

/** The names usable at a given level. */
export function namesAtLevel(level: ConstructLevel): string[] {
  return CONSTRUCTS.filter((c) => c.level === level).map((c) => c.name);
}

export function namesInGroup(group: ConstructGroup): string[] {
  return CONSTRUCTS.filter((c) => c.group === group).map((c) => c.name);
}

/** How a construct is written in full: `{cipher.rot13:…}`. */
export function qualifiedName(info: ConstructInfo): string {
  // A construct whose name is its group reads better bare: `{edit<=2:…}`,
  // not `{edit.edit<=2:…}`.
  return info.name === info.group ? info.name : `${info.group}.${info.name}`;
}

/**
 * Names lex as letters, so trailing digits land in the spec — that is what
 * makes `{del1:…}` and `{rot13:…}` work. Two names are genuinely
 * digit-bearing and have to be folded back before dispatch.
 *
 * This is the one copy of that rule: the parser and the group check must agree
 * about what `{cipher.rot180:…}` means, or the check passes on the `rot`
 * reading and the parser then builds the `rot180` one.
 */
export function foldName(
  name: string,
  spec: string,
): { name: string; spec: string } {
  const trimmed = spec.trim();
  if (name === "t" && trimmed === "9") return { name: "t9", spec: "" };
  // The visual class, not a 180-place shift.
  if (name === "rot" && trimmed === "180") return { name: "rot180", spec: "" };
  return { name, spec };
}

/**
 * The name dispatch sees for a construct written as `written`.
 *
 * A construct's name lexes as letters, so trailing digits land in the spec:
 * `{row1:…}` arrives as "row" with spec "1", `{del1:…}` as "del" with "1".
 * The catalogue lists what a reader writes — `row1`, `rot13` — and anything
 * keyed by what dispatch receives has to fold the two together, or it keys
 * rows nothing can ever reach.
 */
export function dispatchName(written: string): string {
  const split = /^([a-z]*)(\d*)$/.exec(written);
  return split ? foldName(split[1], split[2]).name : written;
}

/**
 * Resolve a written name, which may carry a group prefix. Returns the
 * construct, or a message explaining what is wrong with the token.
 *
 * Digit-bearing names are folded before the group is checked, because the
 * lexer splits `shape.rot180` into `shape.rot` + spec `180`: the group has to
 * be tested against `rot180`, not against `rot`, which is a cipher.
 */
export function resolveConstruct(
  token: string,
  spec: string,
): { info: ConstructInfo } | { error: string } | null {
  const dot = token.lastIndexOf(".");
  const bare = dot === -1 ? token : token.slice(dot + 1);
  const prefix = dot === -1 ? null : token.slice(0, dot);

  // Fold first, so the group is tested against the construct the parser will
  // actually build. Then `row` + `1` still needs rejoining, since the class
  // constraints key on name-plus-spec.
  const folded = foldName(bare, spec);
  const candidates = [
    findConstruct(folded.name),
    findConstruct(folded.name + folded.spec.trim()),
  ].filter((c): c is ConstructInfo => c !== undefined);
  if (candidates.length === 0) return null;
  if (prefix === null) return { info: candidates[0] };
  if (!isGroupName(prefix)) {
    return {
      error:
        `no such group "${prefix}" — the groups are ` +
        `${[...GROUP_NAMES].join(", ")}`,
    };
  }
  const inGroup = candidates.find((c) => c.group === prefix);
  if (inGroup) return { info: inGroup };
  // Echo back the fullest name that matches what was written, so a wrong
  // group on `shape.rot13` suggests `{cipher.rot13…}` rather than
  // `{cipher.rot…}` and dropping the digits the user typed.
  const wrong = candidates.reduce((a, b) => (b.name.length > a.name.length ? b : a));
  return {
    error:
      `"${wrong.name}" is in ${wrong.group}, not ${prefix} — ${wrong.group} is ` +
      `to ${GROUP_BLURB[wrong.group]}. Write {${qualifiedName(wrong)}…}`,
  };
}

/**
 * How to say where a construct belongs, for the error a solver gets when they
 * nest one that cannot be nested.
 */
export function levelAdvice(info: ConstructInfo): string {
  return info.level === "predicate"
    ? `{${info.name} …} is checked on finished matches, so it has to wrap the ` +
        `whole query — try {${info.name} …:your pattern}`
    : `{${info.name} …} changes what is shown, so it has to wrap the whole ` +
        `query — try {${info.name} …:your pattern}`;
}

/**
 * Does this query use any of these constructs?
 *
 * The test every side dataset needs before compiling, because compilation is
 * synchronous: the pronouncing dictionary has to be in hand before `{rhyme:…}`
 * can be built, and the only thing available at that point is the query text.
 *
 * The group prefix is what makes this worth having in one place. A construct
 * may be written `{rhyme:tree}` or `{word.rhyme:tree}`, and five of the six
 * dataset tests were spelled `\{\s*rhyme\b` and so never saw the second — so
 * `{word.rhyme:tree}` reported *needs the pronunciation dictionary, which this
 * build could not load* on a build that could load it perfectly well. Only
 * `{list:…}` had the prefix, and only for the one group it belongs to.
 *
 * Deliberately permissive about which group is written: `{shape.rhyme:…}` is
 * wrong, but it is the parser's job to say so, with a message that names the
 * right group. Loading a dataset for a query that turns out not to compile
 * costs a fetch; refusing to load one costs an answer.
 */
export function mentionsConstruct(query: string, names: string[]): boolean {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\{\\s*(?:[a-z]+\\.)?(?:${alt})\\b`, "i").test(query);
}

/** Closest known construct name, when it's close enough to be a typo. */
export function suggestConstruct(name: string): string | null {
  const distance = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; ++i) {
      const row = [i + 1];
      for (let j = 0; j < b.length; ++j) {
        row.push(
          Math.min(prev[j + 1] + 1, row[j] + 1, prev[j] + (a[i] === b[j] ? 0 : 1)),
        );
      }
      prev = row;
    }
    return prev[b.length];
  };
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const known of CONSTRUCT_NAMES) {
    const d = distance(name, known);
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  return bestDistance <= 2 ? best : null;
}
