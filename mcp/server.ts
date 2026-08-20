// An MCP server over the engine: pattern search as a tool call.
//
//   npx tsx mcp/server.ts [indexDir ...]
//
// Exposes the same search the CLI and the site run — predicates, soft
// constructs, captures, the reverse sidecar when one sits beside the index —
// against local index files, over stdio. Index directories come from the
// arguments, or NUTRI_INDEX_DIRS (colon-separated), or default to the
// bundled demo index's directory.
//
// Register with a client, e.g. for Claude Code:
//
//   claude mcp add nutristatic -- npx tsx /path/to/nutristatic9000/mcp/server.ts
//
// Tools: `search` (run a query), `explain` (the compiled plan), `indexes`
// (what can be searched), `syntax` (a query-language cheat sheet).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  IndexReader,
  SearchSession,
  SessionContext,
  applyResultFilters,
  formatPlan,
  makeWordChecker,
  parseFilterWrappers,
  planQuery,
  } from "../src/engine.js";
import { cliOpenIndex, loadDatasetsFromDisk } from "../src/node-io.js";
import { makeFilter } from "../src/expr-filter.js";
import {
  compileConjunctsReversed,
  reverseFavored,
  reverseSidecarName,
  unreverseText,
} from "../src/reverse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const indexDirs = (
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : (process.env.NUTRI_INDEX_DIRS ?? path.join(repo, "web/public")).split(":")
).map((d) => path.resolve(d));

/** Every .index file the configured directories offer, by short name. */
function availableIndexes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of indexDirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".index")) continue;
      const name = f.slice(0, -".index".length);
      // Chunked build intermediates (corpus.00042.index) are not for searching.
      if (/\.\d{5}$/.test(name)) continue;
      if (!out.has(name)) out.set(name, path.join(dir, f));
    }
  }
  return out;
}

function resolveIndex(name: string | undefined): string {
  const indexes = availableIndexes();
  if (name === undefined) {
    const first = indexes.keys().next();
    if (first.done) throw new Error("no .index files in the configured directories");
    return indexes.get(first.value)!;
  }
  if (name.endsWith(".index") && fs.existsSync(name)) return name;
  const hit = indexes.get(name.replace(/\.index$/, ""));
  if (hit === undefined) {
    throw new Error(
      `no index "${name}" — available: ${[...indexes.keys()].join(", ") || "(none)"}`,
    );
  }
  return hit;
}

/** One context per process: the side datasets load once, from web/public. */
const ctx = new SessionContext();
const loadedProviders = new Set<string>();
function ensureData(query: string): void {
  loadDatasetsFromDisk(ctx, query, path.join(repo, "web/public"), loadedProviders);
}

const readers = new Map<string, IndexReader>();
async function readerFor(file: string): Promise<IndexReader> {
  const hit = readers.get(file);
  if (hit !== undefined) return hit;
  const reader = await cliOpenIndex(file);
  readers.set(file, reader);
  return reader;
}

interface Hit {
  score: number;
  text: string;
  note?: string;
}

const server = new McpServer({ name: "nutristatic", version: "1.0.0" });

server.registerTool(
  "search",
  {
    description:
      "Search a phrase-frequency index with a Nutrimatic-style pattern. " +
      "Supports the full Nutristatic 9000 language: regex-like patterns " +
      "([abc], A/C/V/#/_/., *, +, ?, {m,n}, |, &, !), <anagram>, " +
      "<<letterbank>>, quoted \"exact\" strings, constructs like " +
      "{kind:bird}, {list:...}, {rhyme:...}, {sum=100:...}, {del1:word}, " +
      "predicates like {palindrome:...}, {compound 2:...}, " +
      "{anagram countries:...} which compose anywhere, captures " +
      "{=a:...} with relations {eq/rev/shift a,b:...}, soft boosts " +
      "{~near:king}, and graded {edit:word}. Results stream by corpus " +
      "frequency; a word must be spellable in [a-z0-9 ]. Use `syntax` for " +
      "the full cheat sheet and `indexes` for what can be searched.",
    inputSchema: {
      query: z.string().describe("the pattern, e.g. {palindrome:A{5}} A{4}"),
      index: z
        .string()
        .optional()
        .describe("index name from `indexes`, or a path; defaults to the first available"),
      maxResults: z.number().int().min(1).max(500).optional()
        .describe("results to return (default 40)"),
      maxSteps: z.number().int().min(1000).max(20_000_000).optional()
        .describe("search-step budget (default 1,000,000)"),
    },
  },
  async ({ query, index, maxResults = 40, maxSteps = 1_000_000 }) => {
    const file = resolveIndex(index);
    ensureData(query);
    const { specs, inner } = parseFilterWrappers(query.trim());
    const reader = await readerFor(file);
    const isWord = makeWordChecker(reader);

    let session: SearchSession;
    let reversed = false;
    const sidecar = reverseSidecarName(file);
    if (sidecar !== file && fs.existsSync(sidecar) && reverseFavored(inner, ctx)) {
      session = new SearchSession(
        await readerFor(sidecar),
        makeFilter(compileConjunctsReversed(inner, ctx)),
        ctx,
      );
      reversed = true;
    } else {
      session = new SearchSession(reader, inner, ctx);
    }

    const hits: Hit[] = [];
    const raw: Array<{ score: number; text: string }> = [];
    const status = await session.run(
      maxSteps,
      specs.length > 0 ? maxResults * 40 : maxResults,
      (r) => raw.push(r),
    );
    for (const r of raw) {
      if (hits.length >= maxResults) break;
      const text = reversed ? unreverseText(r.text) : r.text;
      if (specs.length > 0) {
        const verdict = await applyResultFilters(specs, text, ctx, isWord);
        if (!verdict.keep) continue;
        hits.push({
          score: r.score,
          text,
          ...(verdict.notes.length > 0 ? { note: verdict.notes.join("  ") } : {}),
        });
      } else {
        hits.push({ score: r.score, text });
      }
    }

    const lines = hits.map((h) =>
      `${h.score} ${h.text}${h.note ? `  (${h.note})` : ""}`,
    );
    const summary =
      `${hits.length} result${hits.length === 1 ? "" : "s"} ` +
      `(${status}${reversed ? ", via reverse sidecar" : ""}) ` +
      `on ${path.basename(file)}`;
    return {
      content: [
        { type: "text", text: [summary, ...lines].join("\n") },
      ],
    };
  },
);

server.registerTool(
  "explain",
  {
    description:
      "Describe what a query compiles to before searching: its conjunct " +
      "automata, whether each is finite, its predicates, the datasets it " +
      "needs, and the strategy the search will use.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    ensureData(query);
    return {
      content: [{ type: "text", text: formatPlan(planQuery(query, ctx)).join("\n") }],
    };
  },
);

server.registerTool(
  "indexes",
  {
    description: "List the index files available to `search`, with sizes.",
    inputSchema: {},
  },
  async () => {
    const rows = [...availableIndexes().entries()].map(([name, file]) => {
      const mb = (fs.statSync(file).size / 1048576).toFixed(0);
      const rev = fs.existsSync(reverseSidecarName(file)) ? "  +reverse" : "";
      return `${name}  ${mb} MB${rev}`;
    });
    return {
      content: [
        { type: "text", text: rows.join("\n") || "no indexes configured" },
      ],
    };
  },
);

server.registerTool(
  "syntax",
  {
    description: "The query-language cheat sheet: every operator and construct.",
    inputSchema: {},
  },
  async () => {
    const grammar = fs.readFileSync(path.join(repo, "GRAMMAR.md"), "utf8");
    return { content: [{ type: "text", text: grammar }] };
  },
);

await server.connect(new StdioServerTransport());
