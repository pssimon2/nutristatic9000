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

const GROUPS: Array<[ConstructGroup, ConstructLevel, string[]]> = [
  ["word", "automaton", ["rhyme", "homo", "like", "near", "kind", "list"]],
  ["count", "automaton",
    ["sum", "scrabble", "count", "letters", "words", "all", "distinct", "maxrep"]],
  ["bag", "automaton", ["sub", "bank"]],
  ["edit", "automaton", ["del", "add", "subst", "edit"]],
  ["cipher", "automaton", ["caesar", "rot", "rot13", "atbash"]],
  ["spell", "automaton", ["t9", "enum", "morse", "elements"]],
  ["shape", "automaton",
    ["roman", "rot180", "mirror", "sevenseg", "holes",
     "row1", "row2", "row3", "ascending", "descending"]],
  ["match", "predicate",
    ["compound", "palindrome", "reversible", "syllables", "stress"]],
  ["out", "transform", ["at", "rank"]],
];

export const CONSTRUCTS: ConstructInfo[] = GROUPS.flatMap(
  ([group, level, names]) => names.map((name) => ({ name, level, group })),
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
