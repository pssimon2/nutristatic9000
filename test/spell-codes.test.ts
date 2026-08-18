// The hunt codes decode to what they say — including every reading of an
// ambiguous argument, and neither more nor fewer.

import { describe, expect, it } from "vitest";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

function matches(pattern: string, text: string): boolean {
  const filter = compileQuery(pattern, ctx);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

describe("a1z26", () => {
  it("decodes separated numbers", () => {
    expect(matches("{a1z26:20 8 5}", "the")).toBe(true);
    expect(matches("{a1z26:20 8 5}", "tie")).toBe(false);
    expect(matches("{a1z26:20,8,5}", "the")).toBe(true);
  });

  it("reads every split of unseparated digits", () => {
    // 1121215: 1|1|2|1|2|1|5, 11|2|12|15, 1|12|12|15, …
    expect(matches("{a1z26:1121215}", "aabababe")).toBe(false); // 8 letters from 7 digits
    expect(matches("{a1z26:1121215}", "aababae")).toBe(true);
    expect(matches("{a1z26:1121215}", "kblo")).toBe(true); // 11|2|12|15
    expect(matches("{a1z26:1121215}", "alberto")).toBe(false);
    // Tokens split independently: "85" can only be 8|5.
    expect(matches("{a1z26:2085}", "the")).toBe(true);
    expect(matches("{a1z26:20 85}", "the")).toBe(true);
  });

  it("marks a word break at /", () => {
    expect(matches("{a1z26:15 6 / 1}", "of a")).toBe(true);
  });

  it("rejects digits no reading covers", () => {
    expect(() => compileQuery("{a1z26:0}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{a1z26:270}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{a1z26:abc}", ctx)).toThrow(ParseError);
  });
});

describe("braille", () => {
  it("decodes dot cells in any dot order", () => {
    expect(matches("{braille:2345 125 15}", "the")).toBe(true);
    expect(matches("{braille:5432 512 51}", "the")).toBe(true);
    expect(matches("{braille:2345 125 15}", "tie")).toBe(false);
  });

  it("rejects a dot pattern that is no letter", () => {
    expect(() => compileQuery("{braille:56}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{braille:7}", ctx)).toThrow(ParseError);
  });
});

describe("bacon and bin5", () => {
  it("decodes the modern 26-letter table", () => {
    expect(matches("{bacon:baabb aabbb aabaa}", "the")).toBe(true);
  });

  it("decodes the classic 24-letter table as well", () => {
    // Classic 'u' is value 19; modern reads 19 as 't'.
    expect(matches("{bacon:baabb}", "u")).toBe(true);
    expect(matches("{bacon:baabb}", "v")).toBe(true);
    expect(matches("{bacon:baabb}", "t")).toBe(true);
    expect(matches("{bacon:baabb}", "w")).toBe(false);
    // Classic I/J share a code.
    expect(matches("{bacon:abaaa}", "i")).toBe(true);
    expect(matches("{bacon:abaaa}", "j")).toBe(true);
  });

  it("chunks an unseparated string by five", () => {
    expect(matches("{bacon:baabbaabbbaabaa}", "the")).toBe(true);
    expect(() => compileQuery("{bacon:baab}", ctx)).toThrow(ParseError);
  });

  it("bin5 is the 1-indexed binary alphabet", () => {
    expect(matches("{bin5:10100 01000 00101}", "the")).toBe(true);
    expect(() => compileQuery("{bin5:00000}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{bin5:11011}", ctx)).toThrow(ParseError); // 27
  });
});

describe("semaphore", () => {
  it("decodes compass pairs with arms in either order", () => {
    expect(matches("{semaphore:n-nw sw-w ne-s}", "the")).toBe(true);
    expect(matches("{semaphore:nw-n w-sw s-ne}", "the")).toBe(true);
    expect(matches("{semaphore:n-nw sw-w ne-s}", "tie")).toBe(false);
  });

  it("rejects an unknown arm or a doubled arm", () => {
    expect(() => compileQuery("{semaphore:n-up}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{semaphore:n-n}", ctx)).toThrow(ParseError);
  });
});

describe("ascii", () => {
  it("decodes decimal, hex and binary codes, case-folded", () => {
    expect(matches("{ascii:116 104 101}", "the")).toBe(true);
    expect(matches("{ascii:84 72 69}", "the")).toBe(true); // uppercase codes
    expect(matches("{ascii:0x74 0x68 0x65}", "the")).toBe(true);
    expect(matches("{ascii:01110100 01101000 01100101}", "the")).toBe(true);
    expect(matches("{ascii:116 104 32 101}", "th e")).toBe(true); // 32 = space
  });

  it("rejects codes outside the corpus alphabet", () => {
    expect(() => compileQuery("{ascii:33}", ctx)).toThrow(ParseError); // "!"
    expect(() => compileQuery("{ascii:7}", ctx)).toThrow(ParseError);
  });
});

describe("polybius", () => {
  it("decodes row-column pairs", () => {
    expect(matches("{polybius:44 23 15}", "the")).toBe(true);
    expect(matches("{polybius:442315}", "the")).toBe(true);
  });

  it("reads the merged cells both ways", () => {
    expect(matches("{polybius:24}", "i")).toBe(true);
    expect(matches("{polybius:24}", "j")).toBe(true);
    expect(matches("{polybius:13}", "c")).toBe(true);
    expect(matches("{polybius:13}", "k")).toBe(true); // the tap-code square
    expect(matches("{polybius:25}", "k")).toBe(true);
  });

  it("rejects digits off the square or an odd count", () => {
    expect(() => compileQuery("{polybius:46}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{polybius:441}", ctx)).toThrow(ParseError);
  });
});

describe("vigenere", () => {
  it("decodes with a repeating key", () => {
    expect(matches("{vigenere(key):dlc}", "the")).toBe(true);
    expect(matches("{vigenere(key):dlc}", "tie")).toBe(false);
    // The key advances over letters, not spaces.
    expect(matches("{vigenere(key):dlc msbo}", "the code")).toBe(true);
  });

  it("needs its key", () => {
    expect(() => compileQuery("{vigenere:dlc}", ctx)).toThrow(/key/);
    expect(() => compileQuery("{vigenere(k3y):dlc}", ctx)).toThrow(ParseError);
  });
});

describe("playfair", () => {
  it("decodes the textbook example, padding X skippable", () => {
    // "instruments" keyed with "monarchy" encrypts to gatlmzclrqxa, the
    // trailing digraph padded with x.
    expect(matches("{playfair(monarchy):gatlmzclrqxa}", "instruments")).toBe(true);
    expect(matches("{playfair(monarchy):gatlmzclrqxa}", "instrumentsx")).toBe(true);
    expect(matches("{playfair(monarchy):gatlmzclrqxa}", "instrument")).toBe(false);
  });

  it("reads a decoded I as J too", () => {
    // "jam" → digraphs "ia mx" → encrypts to "sbau"; decode offers j back.
    expect(matches("{playfair(monarchy):sbau}", "jam")).toBe(true);
    expect(matches("{playfair(monarchy):sbau}", "iam")).toBe(true);
  });

  it("rejects an odd ciphertext and doubled digraph letters", () => {
    expect(() => compileQuery("{playfair(monarchy):gat}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{playfair(monarchy):aa}", ctx)).toThrow(ParseError);
  });
});
