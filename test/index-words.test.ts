// Telling a word from something the corpus merely contains.
//
// `{compound …}` and `{reversible …}` both ask "is this a word", and both used
// to answer it with "does the index contain it, with a word boundary". An
// index is a corpus, not a dictionary: web text carries every typo and every
// word broken across a line. So `{reversible:A{4}}` led with THAT — because
// "taht" is in there — and `{compound 2:A{9}}` cut AVAILABLE into "avai" and
// "lable". Every one of those strings really is in the index.
//
// The fix is that a word carries a *share* of the corpus and debris does not.
// These tests run against the committed demo.index, so the frequencies are
// fixed and the thresholds can be pinned to real strings.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { splitWords } from "../src/compound.js";
import {
  COMPOUND_PIECE_FLOOR,
  MIN_COMPOUND_PIECE,
  REVERSAL_FLOOR,
  makeWordChecker,
} from "../src/index-words.js";

const reader = await IndexReader.open(
  new MemorySource(fs.readFileSync("web/public/demo.index")),
);
const isWord = makeWordChecker(reader);
const piece = (w: string) =>
  w.length < MIN_COMPOUND_PIECE ? false : isWord(w, COMPOUND_PIECE_FLOOR);

describe("presence alone", () => {
  it("still answers yes to the debris, which is why it was not enough", async () => {
    // Not a regression to fix: this is the honest answer to "is it in the
    // index", and some callers want exactly that. It is the wrong question
    // for "is it a word".
    for (const junk of ["taht", "morf", "avai", "lable"]) {
      expect(await isWord(junk), junk).toBe(true);
    }
  });
});

describe("the reversal floor", () => {
  it("rejects reversals of very common words", async () => {
    // The three that led the results for {reversible:A{4}}: THAT, FROM, HAVE.
    for (const junk of ["taht", "morf", "evah"]) {
      expect(await isWord(junk, REVERSAL_FLOOR), junk).toBe(false);
    }
  });

  it("keeps genuine reversals, including the rare end of them", async () => {
    // EMIT is the scarcest of these at ~2.1e-6 of the corpus, which is what
    // sets the floor an order of magnitude below the compound one.
    for (const real of ["emit", "trap", "evil", "moor", "strap", "stops"]) {
      expect(await isWord(real, REVERSAL_FLOOR), real).toBe(true);
    }
  });
});

describe("the compound piece floor", () => {
  it("rejects fragments the corpus contains but does not use as words", async () => {
    for (const frag of ["avai", "lable", "erent"]) {
      expect(await isWord(frag, COMPOUND_PIECE_FLOOR), frag).toBe(false);
    }
  });

  it("keeps ordinary words", async () => {
    for (const real of ["copy", "right", "some", "thing", "boy", "friend"]) {
      expect(await isWord(real, COMPOUND_PIECE_FLOOR), real).toBe(true);
    }
  });
});

describe("splitting a word into words", () => {
  it("no longer reads AVAILABLE as avai·lable", async () => {
    expect(await splitWords("available", 2, piece)).toBeNull();
  });

  it("no longer reads EDUCATION as educ·ation", async () => {
    expect(await splitWords("education", 2, piece)).toBeNull();
  });

  it("still finds the real compounds", async () => {
    expect(await splitWords("copyright", 2, piece)).toEqual(["copy", "right"]);
    expect(await splitWords("something", 2, piece)).toEqual(["some", "thing"]);
    expect(await splitWords("boyfriend", 2, piece)).toEqual(["boy", "friend"]);
  });

  it("does not cut a single letter off the front", async () => {
    // "p" clears any frequency floor — initials and list markers make single
    // letters common standalone tokens — so PRESIDENT came back as
    // "p·resident". Nothing else splits it, so it drops out entirely.
    expect(await splitWords("president", 2, piece)).toBeNull();
    expect(await splitWords("questions", 2, piece)).toBeNull();
  });
});

describe("what the floor does not fix", () => {
  it("still accepts a name frequent enough to look like a word", async () => {
    // Recorded, not asserted as desirable: "trac" and "liam" are as common as
    // genuine rare reversals, so no threshold separates them. {reversible}
    // needs a dictionary to go further, and the page says to read the mirror.
    expect(await isWord("trac", REVERSAL_FLOOR)).toBe(true);
    expect(await isWord("liam", REVERSAL_FLOOR)).toBe(true);
  });

  it("still lets a suffix through as a compound piece", async () => {
    // FOLLOW·ING survives, which the docs call a weak reading and show.
    expect(await splitWords("following", 2, piece)).toEqual(["follow", "ing"]);
  });
});
