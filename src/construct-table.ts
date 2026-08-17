// What each `{name:…}` construct builds, one row per construct.
//
// The parser used to carry this as a chain of eleven `if (name === …)` blocks,
// each finding its own closing brace, reading its own argument, calling its
// builder and throwing its own error — about 250 lines in which the only
// thing that varied was the middle step. Adding a construct meant finding the
// right place in the chain and repeating the surrounding ceremony correctly.
//
// Here the ceremony is the parser's and the meaning is a row. A construct is a
// name, how its argument is read, and a function from that argument to
// conjunct automata. The name and level already live in constructs.ts; this is
// the compile half the roadmap's C4 asks for, and `construct-table.test.ts`
// holds the two sides together — every automaton-level name has a row here,
// and every row here is a name there.
//
// Three ways an argument can be read, because the constructs genuinely differ:
//
//   literal — the text up to the closing brace is data, not a pattern:
//             {rhyme:tree}, {sub:cryptography}, {t9:2665}. Nothing inside is
//             parsed as a query.
//   wrap    — the argument is a pattern, and the construct intersects with it:
//             {sum=100:A*}, {elements:A{6}}. The parser parses it into the
//             same box, so the construct's conjuncts join the pattern's.
//   inner   — the argument is a pattern, but the construct consumes it rather
//             than intersecting: {del1:beast} is one letter off the argument,
//             so the argument is built separately and handed over.
//
// A row returns null to mean "this is not a parse of a construct" — the
// parser then reports the text it could not read — and throws ParseError to
// explain something it did recognise. The distinction matters: `{near x:cat}`
// is not a near-construct at all, while `{near:qqzz}` is one whose word is not
// in the vocabulary, and only the second can say anything useful.

import { Nfa } from "./automata.js";
import { ParseError } from "./parse-error.js";
import { SessionContext } from "./session-context.js";
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
import { dispatchName, namesAtLevel } from "./constructs.js";
import { EPSILON } from "./automata.js";
import { normalizeEntry as normalize } from "./word-lists.js";

/** How a construct's argument is read. See the note at the top. */
export type ArgKind = "literal" | "wrap" | "inner";

export interface ConstructArg {
  /** The construct's name, after digits have been folded back into it. */
  name: string;
  /** Between the name and the colon: "=52" in `{sum=52:…}`, "1" in `{del1:…}`. */
  spec: string;
  /** The literal text between the colon and the closing brace. */
  arg: string;
  /** The argument automaton, for `inner` constructs. */
  inner: Nfa | null;
  ctx: SessionContext;
  /** The whole `{…}` as written, for error messages. */
  text: string;
}

export interface ConstructBuild {
  argKind: ArgKind;
  /** Conjuncts to intersect, or null when this is not a parse of one. */
  build(a: ConstructArg): Nfa[] | null;
}

/** One entriesNfa, or null when the word list builds nothing. */
function fromEntries(words: string[]): Nfa[] | null {
  const nfa = entriesNfa(words);
  return nfa ? [nfa] : null;
}

/**
 * A dataset a construct needs that this build could not load.
 *
 * Flagged as retryable, because the datasets are fetched on demand: the usual
 * cause is that the fetch has not finished rather than that it failed.
 */
function needsData(text: string, what: string): never {
  throw new ParseError(text, what, true);
}

const wordLookups: Record<string, ConstructBuild> = {
  kind: {
    argKind: "literal",
    build: ({ arg, ctx, text }) => {
      const word = normalizeEntry(arg);
      if (!ctx.categories) {
        needsData(text, "{kind:…} needs the category data, which this build could not load");
      }
      if (word === "") {
        throw new ParseError(
          text,
          "{kind:…} needs a category name — e.g. {kind:bird}",
        );
      }
      const kinds = kindsOf(ctx.categories, word);
      if (!kinds) {
        throw new ParseError(
          text,
          `no category "${word}" — either WordNet has no such noun or verb, or ` +
            `it covers more than ${MAX_CATEGORY} names and is too broad to be a clue`,
        );
      }
      return fromEntries(kinds);
    },
  },

  near: {
    argKind: "literal",
    build: ({ spec, arg, ctx, text }) => {
      // An optional count: {near 60:word} widens the net.
      const limit = /^\s*(\d+)\s*$/.exec(spec);
      if (spec.trim() !== "" && !limit) return null;
      const word = normalizeEntry(arg);
      if (!ctx.neighbours) {
        needsData(text, "{near:…} needs the meaning table, which this build could not load");
      }
      const words = nearestTo(ctx.neighbours, word, limit ? +limit[1] : 32);
      if (!words) {
        throw new ParseError(
          text,
          `"${word}" is not in the meaning vocabulary (the 60,000 commonest ` +
            "words); {like:…} covers a much larger dictionary",
        );
      }
      return fromEntries(words);
    },
  },

  like: {
    argKind: "literal",
    build: ({ arg, ctx, text }) => {
      const word = normalizeEntry(arg);
      if (!ctx.thesaurus) {
        needsData(text, "{like:…} needs the thesaurus, which this build could not load");
      }
      const words = relatedTo(ctx.thesaurus, word);
      if (!words) {
        throw new ParseError(text, `the thesaurus doesn't know "${word}"`);
      }
      return fromEntries(words);
    },
  },

  list: {
    argKind: "literal",
    build: ({ arg, ctx, text }) => {
      const list = listNfa(arg, ctx.lists);
      if (list) return [list];
      const asked = arg.trim();
      if (asked === "") {
        throw new ParseError(
          text,
          "{list:…} needs a list name — e.g. {list:greek} — or your own " +
            "entries separated by commas",
        );
      }
      const near = suggestList(asked, ctx.lists);
      throw new ParseError(
        text,
        `no such list "${asked}"` +
          (near ? ` — did you mean "${near}"?` : "") +
          " — or write entries with commas to give your own",
        // The harvested catalogue may simply not be fetched yet.
        ctx.lists === null,
      );
    },
  },
};

/** rhyme and homo differ only in which lookup they call and how they fail. */
const phoneticLookup = (kind: "rhyme" | "homo"): ConstructBuild => ({
  argKind: "literal",
  build: ({ arg, ctx, text }) => {
    const word = normalizeEntry(arg);
    if (!ctx.phonetics) {
      needsData(
        text,
        `{${kind}:…} needs the pronunciation dictionary, which this build ` +
          "could not load",
      );
    }
    const words =
      kind === "rhyme"
        ? rhymesOf(ctx.phonetics, word)
        : homophonesOf(ctx.phonetics, word);
    if (!words) {
      throw new ParseError(
        text,
        `the pronouncing dictionary doesn't know "${word}"` +
          (kind === "rhyme" ? "" : ", or it has no homophone"),
      );
    }
    return fromEntries(words);
  },
});

/** Ciphers transform a literal, so the argument is the transformed text. */
const cipher: ConstructBuild = {
  argKind: "literal",
  build: ({ name, spec, arg, text }) => {
    const built = cipherNfa(name, spec, arg);
    if (!built) {
      throw new ParseError(
        text,
        `{${name}…} takes literal text, and rot/caesar take a shift`,
      );
    }
    return [built];
  },
};

/** Encodings take a literal argument: keypad digits, or word lengths. */
const encoding: ConstructBuild = {
  argKind: "literal",
  build: ({ name, spec, arg, text }) => {
    const enc = encodingNfa(name, spec, arg);
    if (!enc) {
      throw new ParseError(
        text,
        name === "t9"
          ? `{t9:…} takes keypad digits 2-9 (up to ${MAX_PATTERN_LENGTH})`
          : "{enum:…} takes word lengths — each 1-40, " +
            `${MAX_PATTERN_LENGTH} letters in total — e.g. {enum:4,3,5}`,
      );
    }
    return [enc];
  },
};

const morse: ConstructBuild = {
  argKind: "literal",
  build: ({ spec, arg, text }) => {
    const m = morseNfa(arg);
    if (!m || spec.trim() !== "") {
      throw new ParseError(
        text,
        `{morse:…} takes dots and dashes (up to ${MAX_PATTERN_LENGTH})`,
      );
    }
    return [m];
  },
};

/** A literal bag of letters: the argument *is* the constraint. */
const bag = (mode: "sub" | "bank"): ConstructBuild => ({
  argKind: "literal",
  build: ({ arg, text }) => {
    const built = bankConstraint(arg, mode);
    if (!built) {
      throw new ParseError(
        text,
        `{${mode}:…} takes letters — e.g. {sub:cryptography}`,
      );
    }
    return built;
  },
});

/**
 * Edits wrap whatever is inside, not just a literal: `{del1:beast}` is one
 * letter off a word, `{del1:{kind:instrument}}` is one letter off *any*
 * instrument. Parsed quoted, so a bare word is the exact letter chain it looks
 * like rather than a pattern that may skip spaces.
 */
const edit: ConstructBuild = {
  argKind: "inner",
  build: ({ name, spec, inner, text }) => {
    const built = inner === null ? null : editConstraint(name, spec, inner);
    if (!built) {
      throw new ParseError(
        text,
        `{${name}…} takes a word or a pattern and up to 5 edits — e.g. ` +
          `{del1:beast} or {del1:{kind:instrument}}. A big set with ` +
          `substitutions or insertions is too large to build; try {del…}, or ` +
          `narrow the set.`,
      );
    }
    return [built];
  },
};

/**
 * Unlike the other encodings, `{elements:…}` wraps a pattern: it constrains
 * how the match is spelled rather than supplying the text.
 */
const elements: ConstructBuild = {
  argKind: "wrap",
  build: ({ spec }) => (spec.trim() === "" ? [elementsNfa()] : null),
};

/**
 * Counters, letter classes and keyboard rows: everything whose whole argument
 * is the pattern it constrains, and whose spec is the constraint.
 */
const valueOrClass: ConstructBuild = {
  argKind: "wrap",
  build: ({ name, spec }) =>
    namedConstraint(name, spec) ?? classConstraint(name, spec),
};

/** W2: the constructs that have a soft (`{~name:…}`) variant. */
export const SOFT_NAMES = ["near", "rhyme", "homo", "like", "kind", "list"];

/** Score multiplier for a match the soft construct does not know. */
export const SOFT_PENALTY = 0.01;

/**
 * A soft construct's automaton (W2): matches *everything*, weighting members
 * of the looked-up set at (near) 1 and everything else at SOFT_PENALTY — a
 * boost-not-filter version of the word lookups. `{~near:king}` additionally
 * decays the weight down the closeness ranking, so nearer words surface
 * first among equals. Weighted, so conjunct-level only (see Box.materialize).
 */
export function softConjunct(
  name: string,
  spec: string,
  arg: string,
  ctx: SessionContext,
  text: string,
): Nfa {
  const word = normalize(arg);
  let entries: string[] | null = null;
  let ranked = false;
  if (name === "near") {
    if (!ctx.neighbours) {
      needsData(text, "{~near:…} needs the meaning table, which this build could not load");
    }
    const limit = /^\s*(\d+)\s*$/.exec(spec);
    entries = nearestTo(ctx.neighbours, word, limit ? +limit[1] : 32);
    ranked = true;
  } else if (name === "rhyme" || name === "homo") {
    if (!ctx.phonetics) {
      needsData(text, `{~${name}:…} needs the pronunciation dictionary, which this build could not load`);
    }
    entries = name === "rhyme" ? rhymesOf(ctx.phonetics, word) : homophonesOf(ctx.phonetics, word);
  } else if (name === "like") {
    if (!ctx.thesaurus) {
      needsData(text, "{~like:…} needs the thesaurus, which this build could not load");
    }
    entries = relatedTo(ctx.thesaurus, word);
  } else if (name === "kind") {
    if (!ctx.categories) {
      needsData(text, "{~kind:…} needs the category data, which this build could not load");
    }
    entries = kindsOf(ctx.categories, word);
  } else if (name === "list") {
    entries = arg.includes(",")
      ? arg.split(",").map(normalize).filter((e) => e !== "")
      : null;
    if (entries === null || entries.length === 0) {
      throw new ParseError(
        text,
        "{~list:…} takes your own comma-separated entries to boost — " +
          "e.g. {~list:red,green,blue}",
      );
    }
  } else {
    throw new ParseError(
      text,
      `no soft form of "{${name}…}" — the soft constructs are ` +
        SOFT_NAMES.map((n) => `{~${n}:…}`).join(", "),
    );
  }
  if (entries === null) {
    throw new ParseError(text, `"${word}" is not in the ${name} vocabulary`);
  }
  return softNfa(entries, ranked);
}

/** Everything (weight SOFT_PENALTY) unioned with a weighted trie of entries. */
function softNfa(entries: string[], ranked: boolean): Nfa {
  const nfa = new Nfa();
  const root = nfa.addState();
  nfa.setStart(root);
  const weights = new Map<number, number>();
  // The "anything" branch: all letters, digits and spaces, penalty-weighted.
  const sigma = nfa.addState();
  nfa.addArc(root, EPSILON, sigma);
  for (let c = 0x30; c <= 0x39; ++c) nfa.addArc(sigma, c, sigma);
  for (let c = 0x61; c <= 0x7a; ++c) nfa.addArc(sigma, c, sigma);
  nfa.addArc(sigma, 0x20, sigma);
  nfa.setFinal(sigma);
  weights.set(sigma, SOFT_PENALTY);
  // The member trie, per-entry weights on the finals (states, not arcs, so
  // prefix-sharing entries keep their own weights).
  const children = new Map<number, Map<number, number>>();
  entries.forEach((entry, i) => {
    let state = root;
    for (const ch of entry) {
      const c = ch.charCodeAt(0);
      let kids = children.get(state);
      if (kids === undefined) {
        kids = new Map();
        children.set(state, kids);
      }
      let next = kids.get(c);
      if (next === undefined) {
        next = nfa.addState();
        nfa.addArc(state, c, next);
        kids.set(c, next);
      }
      state = next;
    }
    nfa.setFinal(state);
    const w = ranked ? Math.max(0.05, Math.pow(0.9, i)) : 1;
    const had = weights.get(state);
    if (w !== 1 && (had === undefined || w > had)) weights.set(state, w);
    if (w === 1) weights.delete(state);
  });
  nfa.finalWeight = weights;
  return nfa;
}

/**
 * The table. Every automaton-level construct appears exactly once; the ones
 * without a row of their own are counters and classes, which differ only in
 * their name and are handled by one shared row.
 */
export const CONSTRUCTS: Record<string, ConstructBuild> = (() => {
  const table: Record<string, ConstructBuild> = {
    ...wordLookups,
    rhyme: phoneticLookup("rhyme"),
    homo: phoneticLookup("homo"),
    morse,
    elements,
    t9: encoding,
    enum: encoding,
    caesar: cipher,
    rot: cipher,
    atbash: cipher,
    sub: bag("sub"),
    bank: bag("bank"),
    // The lexer takes a name as letters only, so `{row1:…}` arrives here as
    // "row" with spec "1" — a name no reader ever writes, and so not one the
    // catalogue lists. Same shape as `{del1:…}` and `{rot13:…}`, whose bases
    // are listed because they are also written bare.
    row: valueOrClass,
    del: edit,
    add: edit,
    subst: edit,
    edit,
  };
  // Everything else at this level is a counter or a letter class. Keyed by
  // the name dispatch receives, not the one a reader writes: `{row1:…}`
  // arrives as "row", and a row keyed "row1" would never be found.
  for (const name of namesAtLevel("automaton")) {
    table[dispatchName(name)] ??= valueOrClass;
  }
  return table;
})();
