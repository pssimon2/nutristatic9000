// Remote word lists and the index manifest.

import { describe, expect, it } from "vitest";
import {
  REMOTE_LIST_CAP,
  parseRemoteList,
  remoteListUrls,
} from "../src/word-lists.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts, compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";
import {
  parseManifest,
  transliterateQuery,
} from "../src/manifest.js";

describe("remoteListUrls", () => {
  it("finds the URLs a query names, once each", () => {
    expect(
      remoteListUrls(
        "{list:https://x.test/birds.txt}&{word.list:https://x.test/birds.txt}",
      ),
    ).toEqual(["https://x.test/birds.txt"]);
  });

  it("leaves names and inline entries alone", () => {
    expect(remoteListUrls("{list:greek}&{list:red,green,blue}")).toEqual([]);
  });
});

describe("parseRemoteList", () => {
  it("reads a line per entry, normalized, comments dropped", () => {
    expect(parseRemoteList("Blue Jay\n# a comment\n\n  Crow  \n")).toEqual([
      "blue jay",
      "crow",
    ]);
  });

  it("caps runaway files", () => {
    const big = Array.from({ length: REMOTE_LIST_CAP + 50 }, (_, i) => `w${i}`)
      .join("\n");
    expect(parseRemoteList(big).length).toBe(REMOTE_LIST_CAP);
  });
});

describe("{list:https://…}", () => {
  it("compiles from the fetched entries on the context", () => {
    const ctx = new SessionContext();
    ctx.remoteLists.set("https://x.test/birds.txt", ["crow", "wren"]);
    const conjuncts = compileConjuncts("{list:https://x.test/birds.txt}", ctx);
    expect(conjuncts.length).toBe(1);
  });

  it("explains a missing fetch as retryable, naming CORS", () => {
    const ctx = new SessionContext();
    try {
      compileQuery("{list:https://x.test/birds.txt}", ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).message).toMatch(/CORS/);
      expect((e as ParseError).dataMissing).toBe(true);
    }
  });
});

describe("the index manifest", () => {
  it("parses only what it understands", () => {
    expect(parseManifest("nope")).toBeNull();
    expect(parseManifest({ description: 3, transliterate: "x" })).toEqual({});
    expect(
      parseManifest({
        description: "German",
        language: "DE",
        transliterate: [["ä", "ae"], ["bad"], [1, 2]],
      }),
    ).toEqual({ description: "German", language: "de", transliterate: [["ä", "ae"]] });
  });

  it("applies manifest rules before the generic fold", () => {
    const m = parseManifest({ transliterate: [["ä", "ae"], ["ü", "ue"]] })!;
    expect(transliterateQuery("bär tür ño", m, "custom.index")).toBe(
      "baer tuer no",
    );
  });

  it("selects the German rules by language, and by filename without one", () => {
    const de = parseManifest({ language: "de" })!;
    expect(transliterateQuery("bär", de, "puzzle.index")).toBe("baer");
    expect(transliterateQuery("bär", null, "de-wiki.index")).toBe("baer");
    expect(transliterateQuery("bär", null, "fr-wiki.index")).toBe("bar");
  });
});
