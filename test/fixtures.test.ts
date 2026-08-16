// Golden-fixture regression lock: search results (and step counts, which
// pin the exact traversal) against the committed fixtures for the demo
// index. Any engine change that alters scoring, ordering semantics, or
// traversal shows up here as a diff. Regenerate deliberately with
// `npx tsx scripts/gen-fixtures.mjs` when a semantic change is intended.

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

const fixtures: Record<string, { steps: number; results: [string, number][] }> =
  JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/demo-results.json", import.meta.url),
      "utf8",
    ),
  );

describe("golden search fixtures (demo index)", () => {
  for (const [query, expected] of Object.entries(fixtures)) {
    it(`matches committed results for ${query}`, async () => {
      const data = fs.readFileSync(
        new URL("../web/public/demo.index", import.meta.url),
      );
      const reader = await IndexReader.open(new MemorySource(data));
      const session = new SearchSession(reader, query, ctx);
      const results: [string, number][] = [];
      await session.run(200000, 200, (r) => results.push([r.text, r.score]));
      results.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      expect(results).toEqual(expected.results);
      expect(session.steps).toBe(expected.steps);
    });
  }
});
