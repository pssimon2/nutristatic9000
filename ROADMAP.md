# Nutristatic 9000 — Architecture Roadmap

Instructions for an implementation agent. Work items are grouped in phases;
within a phase, items are ordered so each lands green on its own. Every item
has an ID for tracking — check them off as they ship.

## Ground rules (read first, apply to every item)

- **GR1.** The index byte format is a frozen contract: byte-compatible with
  upstream Nutrimatic, forever. New capabilities ship as *sidecar files*
  (like `.idxz`), never as changes to `.index` itself. The round-trip /
  golden tests in `test/index-format.test.ts` and `test/fixtures.test.ts`
  are the contract suite; they must never be weakened.
  **Correction (2026-08-16):** they are not the contract that sentence claims.
  `index-format.test.ts` runs this repo's writer into this repo's reader and
  asserts decoded *meaning*, with no byte-level assertion; `fixtures.test.ts`
  is a result/step-count lock over `demo.index`. No upstream-generated index is
  checked in anywhere, so byte compatibility is currently **unverified** — a
  coordinated writer+reader bug passes green. The genuinely upstream-derived
  test is `expr-search.test.ts` (a port of `test-expr.cpp`), which pins query
  semantics, not bytes. Closing this (T3) means committing a small
  upstream-built index as a fixture and asserting against its bytes; until
  then GR1 is a maintained intention, not an enforced contract.
- **GR2.** Every refactor item is behavior-preserving unless its text says
  otherwise. `npm test` green before and after; when a query's observable
  output could change, add a test capturing the old behavior first.
  Note: `npm test` does not typecheck and does not touch `web/worker.ts` or
  `web/main.ts`. For anything under `web/`, "green" means `npm run typecheck`
  plus `npm run test:browser` and `npm run test:offline` — now enforced by S0.
- **GR3.** Two-speed code doctrine. Kernel tier (Frontier, ExprFilter /
  ProductFilter, index-reader inner loops, wasm bridge): typed arrays, no
  allocation in loops, monomorphic shapes, benchmark run required for every
  change. Glue tier (everything else): written for clarity, allocation is
  fine, no cleverness. Never hybridize a file — if glue gets hot, move the
  hot part into the kernel tier.
- **GR4.** Both engines (JS and WASM) must emit identical score streams for
  any query they both accept. Any change touching compilation or search
  needs the parity tests (`test/wasm-session.test.ts`) green.
- **GR5.** The JS engine remains the reference implementation and the
  fallback; the WASM kernel, planner strategies, and any parallel mode are
  accelerations that must degrade gracefully to it.
- **GR6.** Each shipped item updates docs it invalidates (README table,
  `web/public/usage.html`) — until item E6 makes those generated.

---

## Phase 0 — Seams: state, structure, layering

Goal: mechanical, low-risk changes that everything later depends on.

- [x] **S0. Stand up CI.** *(Added 2026-08-16 — not in the original plan, but
  S7, T2, T3, T4 and E6 all say "checked in CI" and there was no CI at all.)*
  `.github/workflows/ci.yml`: a fast job (`npm run typecheck`, `npm test`) and
  a browser job (build + `test:browser` + `test:offline`) — the latter being
  the only end-to-end coverage `web/worker.ts` and `web/main.ts` have.
  Typechecking was passing but unenforced: vitest transpiles without checking
  types, so `npm test` never looked at them. Four scripts hardcoded a
  Playwright build path (`chromium-1228`) that only matched by luck —
  `playwright-core` already expected a newer one — so they now share
  `scripts/chromium-path.mjs`, which honours `PLAYWRIGHT_CHROMIUM`, then
  playwright's own path, then the newest build present.
  Also corrected README's claim that byte-compatibility with upstream was
  "verified byte-for-byte in CI tests": see GR1's note below.

- [x] **S1. Kill module-global mutable state → `SessionContext`.**
  `phonetics.ts:20`, `stress.ts:13`, `categories.ts:22`, `neighbours.ts:33`,
  `thesaurus.ts`, and `word-lists.ts` `CACHE` each hold a `let loaded`
  singleton with `setX/parseX/xLoaded` accessors. Create a
  `SessionContext` object owning all loaded side data (and later: the
  index reader, stats, registries). Thread it through `compileQuery`,
  the parser, worker, and CLI. Delete the `setX`/`xLoaded` module API.
  Acceptance: two `SearchSession`s with different data sets can coexist in
  one process; tests no longer need load-order care.
- [ ] **S2. Split `web/worker.ts` (1,850 lines) into single-concern
  modules.** Target: `web/worker/storage.ts` (OPFS handles, markers,
  progress records, resume ranges — `opfs*`, `addRange`, `rangeCovered`,
  `checkPartial`, `downloadToOpfs`), `web/worker/sources.ts` (probe
  parsing, source selection, cache/chunk stores, `downloadWhole`,
  `downloadViaSidecar`, `fetchPieces`, retry loops),
  `web/worker/orchestrator.ts` (open/search/continue lifecycle, tokens,
  generations, engine selection, `runSession`), `web/worker/protocol.ts`
  (all message interfaces — imported by `ui/` too, not re-declared).
  No logic changes; pure extraction.
  *Partly done (2026-08-16):* `worker/protocol.ts` (inbound messages; `main.ts`
  now posts through a typed `postToWorker`, so the wire is compiler-checked),
  `worker/storage.ts` (OPFS + marker/progress parsing + range arithmetic),
  `worker/net.ts` (retry/watchdog/`fetchPieces`, progress via callback so it no
  longer knows the page protocol), and `worker/sources.ts` (probe parsing,
  cache validators, `CacheChunkStore`). The validator string was spelled twice
  — once in `byte-source.ts`, once inline in the worker — and a divergence
  would have made every cached copy compare stale against itself; both now go
  through `validatorFrom`. worker.ts 1,849 → 1,437 lines, and 36 unit tests
  (`test/worker-storage.test.ts`, `test/worker-sources.test.ts`) now cover
  logic that no test could reach before.
  `worker/downloads.ts` now holds the download paths (`downloadWhole`,
  `downloadViaSidecar`, `downloadToOpfs`, `openOpfsIndex`), reporting through
  a `DownloadReporter` and taking the validator as an argument, so they carry
  no worker state. worker.ts 1,849 → 1,097 lines across five modules.
  The result-filter rule (five branches, duplicated verbatim between
  `cli/find-expr.ts` and `web/worker.ts`) is now one `applyResultFilter` in
  `src/result-predicate.ts`, returning `{keep, note}` so each front end
  formats the annotation its own way — 20 tests, where both copies had none.
  That is also the shape C1 needs.
  **Deliberately not done:** a separate `worker/orchestrator.ts`. worker.ts is
  *already* the orchestrator — what remains in it is exactly the open/search/
  continue lifecycle plus the message entry — so that split would rename a
  file and leave a three-line shim, moving ~20 mutable bindings for no
  testability gain. Revisit if S4's directory reshape makes it natural.
  Outbound (worker→page) messages are still untyped; typing them has to
  account for `postReady`'s replay.
- [ ] **S3. Lift query-language knowledge out of `web/main.ts`.**
  `splitSlots` (`main.ts:495`), the `{at}`/`{rank}` stripping
  (`main.ts:642`), and slot orchestration move to `src/` (they will be
  absorbed by C2/C5). `main.ts` keeps only rendering and candidate-choice
  state. The German-transliteration filename regex (`main.ts:449`) gets a
  `// TODO(F1: manifest)` marker.
- [ ] **S4. Directory reshape into an enforced onion.**
  ```
  src/engine/{automata,language,plan,exec,index}/   pure; no I/O, no globals
  src/data/                                          providers + registry
  src/io/                                            byte sources (memory, file,
                                                     http-range, idxz, opfs, node)
  apps/cli/   apps/web/{worker,ui}/
  ```
  Move files once (after S2/S3 so they move in final shape). Add
  `dependency-cruiser` (or eslint `import/no-restricted-paths`) to CI:
  engine imports nothing outside engine; data/io import engine types only,
  never each other; apps import all, export nothing.
- [ ] **S5. Write the doctrine down.** `CONTRIBUTING.md` (or extend
  CLAUDE.md): the two-speed doctrine (GR3), the layering rules (S4), the
  frozen-format contract (GR1), the parity requirement (GR4), and "a
  feature is a file" (E1) as the extendability acceptance test.
- [ ] **S6. Engine perf counters.** A `Stats` object on the session:
  steps, lazy-DFA states interned, frontier peak size, bytes fetched,
  chunk-cache hit/miss, predicate checks run/passed, results emitted.
  Several exist ad hoc (`bytesFetched`, `requests`, `steps`) — unify.
  Expose via CLI `--stats` and a `?debug=1` panel in the web UI.
- [ ] **S7. Benchmark matrix as CI regression gate.** Promote
  `scripts/bench-all.mjs` from measurement to gate: a grid of
  (query shape × index mode) cells — literal/prefix, heavy anagram,
  big-list construct, multi-word phrase, negation-heavy, multi-slot ×
  memory, disk, range(simulated), local-file — each with a step-count and
  wall-clock threshold checked in CI. Kernel-tier PRs must run it.
- [ ] **S8. `--explain`.** CLI flag (and debug-panel view) printing the
  compiled plan: conjuncts, chosen strategy (after Phase P), predicted
  cardinalities, predicates, transforms, data needs. Grows with the
  planner; start with what exists (conjunct count/sizes, filter type).

## Phase C — Composability core: one language, one plan, one executor

- [ ] **C1. Predicates become a list, not a slot.** Replace
  `resultFilter: FilterSpec | null` (`worker.ts:244`, `cli/find-expr.ts:87`)
  with `predicates: Predicate[]` where
  `Predicate = (text: string, ctx) => boolean | Promise<boolean>` and `ctx`
  carries `isIndexedWord` etc. Parse nested filter wrappers recursively so
  `{palindrome:{syllables=5:…}}` and `{stress 10:{compound 2:…}}` work
  (AND semantics). Tests for stacked filters in both CLI and worker.
- [ ] **C2. Unified query AST + Plan.** New `src/engine/language/query.ts`:
  `parseQuery(string, ctx) → QueryAst` covering the *whole* language —
  slots (`;`), output wrappers (`{at}`, `{rank}`), result filters, and the
  pattern grammar. Compile to:
  ```ts
  interface SlotPlan {
    conjuncts: Nfa[];        // automaton, unchanged machinery
    predicates: Predicate[]; // 0..n, ANDed
    transforms: Transform[]; // rank, at, ordering — nesting order preserved
    dataNeeds: Set<DataKey>; // derived from AST, not regexes
  }
  interface QueryPlan { slots: SlotPlan[] }
  ```
  Replaces: `parseExtract`/`parseRank` call sites in `main.ts:642`,
  `parseFilterWrapper` in `worker.ts:1726` and `cli/find-expr.ts:99`, the
  five `needsX()` regex sniffers (`phonetics.ts:60` etc.), and the `{near}`
  re-regex (`worker.ts:1719`). Grammar/semantics unchanged (GR2) except:
  wrapper nesting order now *means* its order (add tests for
  `{rank:{at:…}}` vs `{at:{rank:…}}`).
- [ ] **C3. Shared executor.** One `executePlan(ctx, plan, budget, sink)` in
  `src/engine/exec/` running: search → predicates → transforms (innermost
  first) → sink. CLI sink = stdout lines; worker sink = postMessage. Kills
  the triplicated pipeline (`present()` in `cli/find-expr.ts:159`,
  `emit`/`flushPending` in `worker.ts:1511`, rank/at logic in `main.ts`).
  Fixes known divergences: CLI gains `{near}` ordering; rank/filter
  interplay identical everywhere.
- [ ] **C4. Construct registry.** One table replaces three dispatchers
  (the ~240-line chain in `expr-parse.ts:361`, the `NAMES` list in
  `result-filter.ts:21`, the wrapper parsers in `extract-spec.ts`):
  ```ts
  interface Construct {
    name: string;
    level: "automaton" | "predicate" | "transform";
    argKind: "pattern" | "literal" | "none";
    dataNeeds?: DataKey[];
    docs: { summary: string; example: string };
    compile(spec: string, inner: AstNode | null, ctx): CompileResult;
  }
  ```
  Split `value-constraint.ts` (635 lines: counters, banks, ciphers, edits,
  encodings, classes) into per-feature modules under
  `src/engine/language/constructs/`, each registering itself.
  `suggestConstruct` ("did you mean") now covers *every* name at every
  level. Acceptance test: adding a construct = one new file + one
  registration line + tests.
- [ ] **C5. Slots first-class.** `;` parsed in C2's grammar; CLI gains
  multi-slot with the assembled extraction line; a whole-query wrapper
  outside slots applies per-slot. `main.ts` slot UI consumes SlotPlan
  results instead of owning the splitting.
- [ ] **C6. Data-provider registry.** One
  `DataProvider { key, url(ctx), parse(Response), sizeHint }` per side
  dataset; loading loops in `worker.ts:1671-1710` and
  `cli/find-expr.ts:113-136` collapse to iterating `plan.dataNeeds`.
  Lazily fetched, cached on the SessionContext (S1).
- [ ] **C7. WASM eligibility from the plan.** `wasm-session.ts:251`
  ("parse exactly like compileQuery") re-parses the query — decide kernel
  eligibility from the AST/Plan instead (automaton-only slots → kernel;
  predicates/transforms handled around it). Delete the duplicate parse.

## Phase E — Engine algebra & clarity dividends

- [ ] **E1. Lazy complement.** `complement()` (`automata.ts:454`) eagerly
  determinizes with a 5,000-state cap; over the cap the user gets a
  generic parse error (`expr-parse.ts:157` returns null, erasing the
  reason). Implement `ComplementFilter implements Filter`: lazy subset
  construction (reuse ExprFilter), acceptance flipped, DEAD becomes an
  accepting self-loop sink. Removes the cap entirely. Keep the eager path
  only where an NFA is structurally required (inside quantifiers), with a
  proper ParseError naming the limit when it trips.
- [ ] **E2. Filter-level boolean algebra.** Generalize
  `ProductFilter.subs: ExprFilter[]` (`expr-filter.ts:151`) to `Filter[]`:
  products of products, products containing complements — all lazy, none
  materialized. `makeFilter` composes at the Filter level whenever the NFA
  level would have to materialize for boolean reasons.
- [x] **E3. Trie-shaped `entriesNfa`.** *(done 2026-08-16)* Prefix trie
  instead of union-of-chains: bird 26,276 arcs → 14,905, tree 43,543 →
  22,350 (~57%), and one start branch instead of one per entry. Equivalence
  tests vs the old construction in `test/word-lists.test.ts`. A DAWG sharing
  suffixes is still on the table if sets get bigger.
- [ ] ~~**E3. Trie-shaped `entriesNfa`.**~~ `word-lists.ts:69` builds
  union-of-chains — for a 10k-entry `{kind:…}` that means thousands of
  parallel start states and fat subset closures. Build a prefix trie
  directly (share prefixes; optionally a DAWG sharing suffixes). Same
  language; add an equivalence test vs the old construction on a sample.
- [ ] **E4. Int-pool interning in `ExprFilter`.**
  `intern()` keys DFA states with `sorted.join(",")` (`expr-filter.ts:113`)
  — string building + Map hashing per novel subset. Port ProductFilter's
  open-addressed Int32 pool (`expr-filter.ts:158`, whose comment records
  that string keys dominated anagram time). Benchmark gate (S7) proves it.
- [ ] **E5. Frontier memory diet.** `search-driver.ts:25`: `ch` fits
  Uint8Array; evaluate narrowing `state`/`crumb`. Only with S7 numbers
  showing benefit; kernel-tier change (GR3).
- [ ] **E6. Generated docs.** Build step rendering the construct registry's
  `docs` metadata into the README feature table and
  `web/public/usage.html` sections (currently hand-synced, already
  drift-prone). Each construct's `example` runs against `demo.index` as a
  smoke test in CI.

## Phase P — Query planner: right engine per query

- [ ] **P1. Word-membership/score sidecar (DAWG).** New sidecar built by a
  CLI tool (pattern: `compress-index.ts`): compact DAWG (or bloom +
  rank table) of indexed words above a frequency floor, few hundred KB,
  served next to the index like `.idxz`. Loaded lazily. Used by: P2
  probes, C1 predicates, compound splitting.
  Then: remove the batch-then-`flushPending` path — `{compound}` /
  `{reversible}` predicates stream through the pipeline.
- [ ] **P2. Direct score probe.** `IndexReader` helper: walk the trie
  along a given word/phrase (single path, O(length)) returning its
  count/score, range-mode aware. This is the planner's cheap oracle.
- [ ] **P3. Cardinality estimation.** For each conjunct: finite ⇔ acyclic
  NFA; estimate |language| with a capped path count (anagram conjuncts:
  cap kicks in). Attach estimates to the SlotPlan; show in `--explain`.
- [ ] **P4. Finite-list generate-and-test strategy.** When one conjunct's
  language is finite and below threshold (`{kind:…}`, `{list:…}`,
  `{near:…}`, `{rhyme:…}`, small anagrams): enumerate entries, test the
  other conjuncts' DFAs per entry (microseconds), score via P2, emit in
  score order. Differential test (T1): identical result sets/scores vs
  the trie walk on overlapping fixtures.
- [ ] **P5. Phrase factoring + best-first join.** A pattern that is a
  concatenation of word-level pieces separated by spaces: solve each word
  independently → scored candidate lists → join by probing the phrase trie
  (P2), best-first on score product using the existing Frontier heap as a
  lazy k-best join. Fall back to the monolithic walk when factoring
  doesn't apply.
- [ ] **P6. Plan diagnostics.** Static analysis on the plan: infinite
  pattern language + only predicate-level narrowing ⇒ warn "unbounded
  search; the {palindrome} filter cannot prune — add a length or a
  value ceiling" (automating the folklore documented in
  `value-constraint.ts` comments). Surface in UI status line and CLI.
- [ ] **P7. Strategy choice wiring.** Planner picks per slot: trie walk /
  generate-and-test / factored join, using P3 estimates + index mode
  (range mode weights fetch cost). `--explain` shows the decision; a
  query flag forces a strategy for debugging.

## Phase A — Search smarts

- [ ] **A1. Restart-aware priority (admissible A*).** Frontier priority is
  `count*scale` (h = 0). Compute per-filter-state minimum remaining
  *restarts* (spaces to acceptance, derivable lazily per conjunct NFA);
  multiply priority by `restart^minRemainingRestarts` (restart = 1e-6, so
  forced future restarts demote entries by orders of magnitude
  immediately). Still an upper bound ⇒ result order unchanged (add test).
  Same idea for `{words=N}` counters, whose state encodes remaining words.
- [ ] **A2. Score-floor knob.** Optional budget: drop frontier entries
  whose priority falls below `floor × best-emitted-score` (e.g. 1e-9).
  Off by default; bounds frontier growth on hopeless tails. Document that
  it can truncate the deep tail.
- [ ] **A3. Refinement caching.** Cache last N result sets per session
  keyed by conjunct fingerprint. On a new query, detect refinement
  (old conjunct set ⊆ new, via `equivalent()` from `automata.ts:572`):
  filter cached results instantly for first paint, then run the real
  search to fill the tail. Huge for the iterate-on-anagram loop.
- [ ] **A4. Conjunct-level filter cache.** A changed query rebuilds every
  lazy DFA from zero even when conjuncts are shared with the previous
  query. Cache `ExprFilter`s keyed by conjunct NFA identity (stable once
  the Plan makes conjuncts values); `<huge-anagram>&newthing` reuses the
  anagram filters it built seconds ago.

## Phase W — Weighted search (scores as a composable dimension)

- [ ] **W1. Weighted transitions.** `Filter.transition` optionally returns
  a weight (≤ 1) with the state; multiply into `scale` at `Frontier.push`.
  Unweighted filters return 1 — zero overhead path preserved (GR3;
  benchmark). Priority remains an upper bound ⇒ ordering semantics hold.
- [ ] **W2. Soft constructs.** `{~near:king}`, `{~rhyme:day}` (syntax:
  leading `~` in the registry): boost/penalize instead of filter. Ranking
  falls out of the engine identically in CLI and web.
- [ ] **W3. Graded edit distance.** `{edit:beast}` with per-edit weight
  (vs the hard `{edit<=2:…}` cliff): one automaton, results ordered by
  damage.
- [ ] **W4. Delete the `nearOrder` hack.** `worker.ts:1719`'s post-hoc
  sort is subsumed by W2 (or, pre-W1, by a transform from C3). Ensure the
  CLI/web behavior matches before deleting.

## Phase X — Parallel search

- [ ] **X1. First-letter sharding.** N workers, each owning a subset of
  the trie root's children; restarts jump to the root *within* a walk and
  never change a result's partition, so shards are disjoint and complete.
  Each worker streams descending scores; UI-side merge with a small heap
  is exact. Requires S1 (no globals). Weight partitions by root-child
  counts so workers finish together.
- [ ] **X2. Planner-gated.** Sharding only when the plan predicts a heavy
  search (P3 + query shape); pointless for cheap queries. Memory cost is
  N frontiers — respect a device-memory budget.
- [ ] **X3. (Optional) WASM threads.** SharedArrayBuffer + threads for the
  kernel path needs COOP/COEP headers — a one-line Caddy change on the
  deploy host. Only if X1 profiling shows the merge/duplication overhead
  matters; X1 is the simpler win and covers JS + range modes.

## Phase M — Match reconstruction, captures, relations

- [ ] **M1. Span reconstruction.** After a result arrives, re-parse the
  ≤~40-char match text against the pattern AST (matching a short concrete
  string against small NFAs = regex captures; trivial cost per result).
  Produce spans for every AST node, handling ambiguity as "any consistent
  parse".
- [ ] **M2. Predicates on subexpressions.** `{palindrome:A{5}} {kind:bird}`
  — predicate attaches to its AST node, tests its span; accept if any
  consistent assignment satisfies all predicates.
- [ ] **M3. Scoped extraction.** `{at}` on a subexpression ("3rd letter of
  the second word/piece").
- [ ] **M4. Captures + relations.** Named captures and relational
  predicates over spans: `{eq:a,b}`, `{rev:a,b}`, `{shift13:a,b}` —
  semordnilaps, "first and last 3 letters agree", cipher-pair words.
  Post-match only (no automaton blowup); planner may invert cheap sides
  (enumerate candidates for one capture, synthesize a second-stage
  search for the other).
- [ ] **M5. Unified result notes.** The per-match annotations (caesar
  shift matched, compound cuts, stress shape, reversal) become one
  span/metadata mechanism instead of ad-hoc plumbing per feature.

## Phase J — Cross-slot solving & piping

- [ ] **J1. Slot candidate lists + best-first join.** Slots stream scored
  candidates; a lazy cross-product join (Frontier heap, priority = score
  product) proposes joint assignments.
- [ ] **J2. Extraction constraints.** Constrain the *assembled extraction*:
  "extraction must be an indexed word" (P1/P2 probe) or match a pattern /
  list. The tool proposes answers instead of the solver eyeballing
  `?·R·T·E?S`.
- [ ] **J3. Shared resources across slots.** A letter bank distributed
  over N slots; mutually disjoint sub-anagrams of a shared multiset —
  constraint propagation over slot candidate lists.
- [ ] **J4. Query piping.** A query's result stream as the word-list input
  of another: `{list:@1}` referencing slot 1's results, or an explicit
  pipe stage. Subsumes J2; enables two-step charades, "reversal matches
  this other pattern", etc.

## Phase F — Flexibility

- [ ] **F1. Index manifest sidecar.** `my.index.meta.json`: language,
  description, transliteration rules, data-pack URLs, (later) alphabet.
  The *only* per-index configuration channel. Replaces the filename-regex
  transliteration in `main.ts:449`. Indexes without a manifest keep
  today's defaults.
- [ ] **F2. Per-language data packs.** Provider registry (C6) keyed by the
  manifest's language: `phonetics-de.txt`, `categories-fr.txt` built by
  the existing `scripts/build-*.mjs` pattern. Constructs light up per
  index instead of failing English-only.
- [ ] **F3. Remote word lists.** `{list:https://…/birds.txt}` — fetch,
  cache on the context, document the CORS requirement. Hunt teams' shared
  lists become directly usable.
- [ ] **F4. Declarative construct packs.** JSON packs for table-driven
  constructs (`{name, type: "value-table" | "letter-class" |
  "substitution", data}`) loadable per session — custom keyboard layouts,
  tile values, ciphers without code. Most of the old `value-constraint.ts`
  tables become the built-in pack.
- [ ] **F5. Multi-index merged search.** Merged driver: heap over
  per-index drivers, comparable scores; one query consults demo + Simple
  + full English at once. Straightforward after C3; needs S1.
- [ ] **F6. Generalized alphabet.** Per-index symbol table from the
  manifest replacing hardwired `NSYM`/`CHAR_TO_SYM`/`[a-z0-9 ]`
  (`automata.ts`): native Russian/Greek/Hebrew indexes instead of lossy
  transliteration. Invasive (typed-array sizing throughout; index-format
  *extension flag* — see GR1: sidecar/extension, core format untouched
  for Latin). Sequence last; alphabet becomes a Plan/Session parameter.
- [ ] **F7. Reverse-index sidecar (optional, heavy).** Reversed index
  built at index time; planner runs suffix-anchored patterns (`A*zzyx`)
  on it with the reversed DFA. Opt-in like `.idxz` (disk cost); the only
  fix for that query class.
- [ ] **F8. Package as a library.** `@nutristatic/engine`: public surface
  = `parseQuery`, `compilePlan`, `Session`/`SessionContext`, the two
  registries, the byte-source interface; everything else internal. CLI,
  worker, offline build, tests become thin consumers. Enables: MCP
  server / headless service, scriptable solving APIs for hunt teams.

## Phase T — Testing & verification infrastructure

- [ ] **T1. Differential strategy tests.** Property tests asserting
  *identical result sets and scores* across: trie walk vs
  generate-and-test (P4), factored join vs monolithic (P5), sharded vs
  single (X1), lazy vs eager complement (E1), refinement-cache path vs
  fresh (A3), JS vs WASM (exists — extend). Randomized queries over
  fixture indexes.
- [ ] **T2. Hard-query benchmark corpus.** Curated set (heavy anagram,
  10k-list, deep negation, 3-word phrase, cross-slot, suffix-anchored)
  with per-query step/latency budgets in CI — the standing definition of
  "fast in any use case" (extends S7).
- [ ] **T3. Contract suite labeling.** Name and pin the byte-format
  round-trip tests as the compatibility contract (GR1); make CI call out
  any diff touching them.
- [ ] **T4. Registry-driven smoke tests.** Every registered construct's
  `docs.example` (E6) executes against `demo.index` in CI — a feature
  without a working example fails the build.

---

## Suggested execution order

Phases are dependency-ordered top to bottom, but these can interleave:

1. **S1–S8** first (seams; everything depends on them).
2. **C1–C7** (composability core) — the substrate.
3. **E1–E6** and **P1–P7** in parallel (independent of each other).
4. **A1–A4**, then **W1–W4** (W builds on A's priority work).
5. **X1–X3** (needs S1, benefits from P).
6. **M1–M5**, then **J1–J4** (J consumes M and P).
7. **F1–F8** any time after C6/C3; F6 last.
8. **T1–T4** grow alongside — each phase adds its differential tests
   when it adds its second implementation of anything.
