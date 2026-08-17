// The side datasets, and the queries that need them.
//
// Compilation is synchronous, so the dataset a construct reads has to be in
// hand before the query is built — which means the only thing available to
// decide is the query text. That test is easy to write and easy to write
// slightly differently six times, and that is what happened: five of the six
// did not know a construct may carry its group prefix, so `{word.rhyme:tree}`
// answered *needs the pronunciation dictionary, which this build could not
// load* on a build carrying it, while `{rhyme:tree}` worked. Only `{list:…}`
// had the prefix, and only for its own group.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  DATA_PROVIDERS,
  providersFor,
} from "../src/data-providers.js";
import { findConstruct } from "../src/constructs.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";

describe("the rows describe datasets that exist", () => {
  it("names a file that ships", () => {
    for (const p of DATA_PROVIDERS) {
      expect(
        fs.existsSync(`web/public/${p.file}`),
        `${p.key} says it ships as ${p.file}`,
      ).toBe(true);
    }
  });

  it("claims only constructs the catalogue knows", () => {
    // A renamed construct would otherwise leave its dataset pointing at a name
    // nothing can write, and nothing would say so.
    for (const p of DATA_PROVIDERS) {
      for (const name of p.constructs) {
        expect(findConstruct(name), `${p.key} claims "${name}"`).toBeTruthy();
      }
    }
  });

  it("covers each dataset once", () => {
    const keys = DATA_PROVIDERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(6);
  });
});

describe("which datasets a query needs", () => {
  it("asks for nothing when the query names no construct", () => {
    expect(providersFor("A{5}&C*")).toEqual([]);
  });

  // The bug this file exists for. Every construct a dataset serves, written
  // both ways, must select that dataset.
  for (const p of DATA_PROVIDERS) {
    for (const name of p.constructs) {
      // `{list:…}` only needs the catalogue for a list the bundle does not
      // carry, so it gets an argument no bundled list could match.
      const arg = name === "list" ? "romandeities" : "tree";
      it(`selects ${p.key} for {${name}:…} and its prefixed form`, () => {
        const info = findConstruct(name);
        expect(info, name).toBeTruthy();
        const bare = `{${name}:${arg}}`;
        const prefixed = `{${info!.group}.${name}:${arg}}`;
        expect(providersFor(bare).map((x) => x.key), bare).toContain(p.key);
        expect(providersFor(prefixed).map((x) => x.key), prefixed).toContain(p.key);
      });
    }
  }

  it("does not select a dataset for a longer name that starts the same", () => {
    // `{listen:…}` is not `{list:…}`; a word-boundary-free test would fetch a
    // catalogue for it.
    expect(providersFor("{listen:x}").map((p) => p.key)).not.toContain("lists");
    expect(providersFor("{likeness:x}").map((p) => p.key)).not.toContain("thesaurus");
  });
});

// The end-to-end property, which is what a reader actually experiences: load
// what the query asks for, and it compiles. This is the check that would have
// caught the prefix bug without anyone thinking to test prefixes.
describe("loading what a query asks for is enough to compile it", () => {
  function load(query: string): SessionContext {
    const ctx = new SessionContext();
    for (const p of providersFor(query)) {
      const path = `web/public/${p.file}`;
      if (p.binary) {
        const buf = fs.readFileSync(path);
        p.install(ctx, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } else {
        p.install(ctx, fs.readFileSync(path, "utf8"));
      }
    }
    return ctx;
  }

  const QUERIES = [
    "{rhyme:tree}", "{word.rhyme:tree}",
    "{homo:knight}", "{word.homo:knight}",
    "{like:reluctant}", "{word.like:reluctant}",
    "{near:king}", "{word.near:king}",
    "{kind:bird}", "{word.kind:bird}",
    "{list:romandeities}", "{word.list:romandeities}",
  ];

  for (const query of QUERIES) {
    it(`compiles ${query}`, () => {
      expect(() => compileQuery(query, load(query))).not.toThrow();
    }, 60000);
  }

  it("still refuses when the dataset is genuinely absent", () => {
    // The message the prefix bug was wrongly producing. It has to keep
    // working for a build that really cannot load the data.
    let thrown: unknown;
    try {
      compileQuery("{word.rhyme:tree}", new SessionContext());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as ParseError).message).toMatch(/pronunciation dictionary/);
  });
});
