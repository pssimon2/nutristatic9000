// The side datasets, one row each.
//
// Six datasets sit beside the index — a pronouncing dictionary, a thesaurus,
// WordNet categories, stress patterns, meaning vectors, a list catalogue —
// and each is needed only by the queries that name the constructs it serves.
// They are fetched on demand and kept, because a solver who rhymes once will
// rhyme again.
//
// Knowing how to load one used to mean knowing four separate things in two
// places: whether a query needs it, what file it ships as, whether to read it
// as text or bytes, and how to parse it. The worker had a forty-line block of
// six near-identical `if (needsX) await ensureExtra(…)` clauses and the CLI
// had a different forty lines doing the same by hand — and they drifted, in a
// way nobody could see from either file: five of the six "does this query need
// it" tests did not know a construct may be written with its group prefix, so
// `{word.rhyme:tree}` reported *needs the pronunciation dictionary, which this
// build could not load* on a build carrying it. `{list:…}` had the prefix and
// the others did not, which is what two lists maintained by hand look like.
//
// Here it is one row per dataset, and each front end supplies only what it
// alone knows: the worker a URL and `fetch`, the CLI a path and `readFile`.

import type { DataKey, SessionContext } from "./session-context.js";
import { needsPhonetics, parsePhonetics } from "./phonetics.js";
import { needsThesaurus, parseThesaurus } from "./thesaurus.js";
import { needsCategories, parseCategories } from "./categories.js";
import { needsStress, parseStress } from "./stress.js";
import { needsNeighbours, parseNeighbours } from "./neighbours.js";
import { needsWikiLists, parseWikiLists } from "./word-lists.js";

export interface DataProvider {
  /** Where it lands on the session context. */
  key: DataKey;
  /** The file it ships as, beside the other web assets. */
  file: string;
  /** Read as bytes rather than text. */
  binary: boolean;
  /**
   * The constructs it serves, as the catalogue spells them. Not used to build
   * `needed` — the dataset modules own that, since `{list:…}` only needs the
   * catalogue for a list the bundle does not already carry — but checked
   * against the catalogue by the tests, so a renamed construct cannot leave a
   * dataset pointing at a name that no longer exists.
   */
  constructs: string[];
  /** Does this query need it, before anything can be compiled? */
  needed(query: string): boolean;
  /** Put it on the context. `data` is a string unless `binary`. */
  install(ctx: SessionContext, data: string | ArrayBuffer): void;
}

export const DATA_PROVIDERS: readonly DataProvider[] = [
  {
    key: "phonetics",
    file: "phonetics.txt",
    binary: false,
    constructs: ["rhyme", "homo"],
    needed: needsPhonetics,
    install: (ctx, d) => {
      ctx.phonetics = parsePhonetics(d as string);
    },
  },
  {
    key: "lists",
    file: "lists.txt",
    binary: false,
    constructs: ["list"],
    needed: needsWikiLists,
    install: (ctx, d) => {
      ctx.lists = parseWikiLists(d as string);
    },
  },
  {
    key: "stress",
    file: "stress.txt",
    binary: false,
    constructs: ["syllables", "stress"],
    needed: needsStress,
    install: (ctx, d) => {
      ctx.stress = parseStress(d as string);
    },
  },
  {
    key: "categories",
    file: "categories.txt",
    binary: false,
    constructs: ["kind"],
    needed: needsCategories,
    install: (ctx, d) => {
      ctx.categories = parseCategories(d as string);
    },
  },
  {
    key: "neighbours",
    file: "neighbours.bin",
    binary: true,
    constructs: ["near"],
    needed: needsNeighbours,
    install: (ctx, d) => {
      ctx.neighbours = parseNeighbours(d as ArrayBuffer);
    },
  },
  {
    key: "thesaurus",
    file: "thesaurus.txt",
    binary: false,
    constructs: ["like"],
    needed: needsThesaurus,
    install: (ctx, d) => {
      ctx.thesaurus = parseThesaurus(d as string);
    },
  },
];

/** The datasets this query cannot be compiled without. */
export function providersFor(query: string): DataProvider[] {
  return DATA_PROVIDERS.filter((p) => p.needed(query));
}
