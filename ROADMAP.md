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
- [x] **S2. Split `web/worker.ts` (1,850 lines) into single-concern
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
  Outbound (worker→page) messages are now typed too: `protocol.ts` carries an
  `OutMsg` union, `post` takes it, and `main.ts`'s `onmessage` switch is typed
  on it with a `satisfies never` default, so an unhandled message stops
  compiling instead of being dropped at runtime. That removed eight casts on
  the page — `msg.stats as Stats | null`, `msg.lines as string[]`,
  `msg.reasons as Array<{...}>` — each of which was a place the two files
  could drift silently. Writing the union found two shapes the casts had
  wrong: `conflict` is `string[] | null`, not a string, and `checked.error` is
  `{detail, at}`. `postReady`'s replay turned out to need nothing special
  beyond `lastReady: ReadyMsg | null`, which let its object-shape guard go.
- [x] **S3. Lift query-language knowledge out of `web/main.ts`.** *(done
  2026-08-16)* `src/query-shape.ts` owns `splitSlots`, `literalsOf` and
  `shapeOfQuery`, which peels `{at}`/`{rank}` in one fixed order and reports
  the lone-`{caesar}` ciphertext the page annotates with. `main.ts` had that
  sniffer written out twice four lines apart, and peeled the wrappers in two
  places that could drift; both now call one function. 15 tests, where the
  regexes had none. `transliterate` deliberately stays: it is a property of
  the index rather than of the language, must run before parsing, and now
  carries the `TODO(F1: manifest)` marker.
- [~] **S4. Directory reshape into an enforced onion.** *(enforcement done
  2026-08-16; the move deferred, deliberately)* `npm run check-layers` runs in
  CI and enforces the two rules that catch real drift: the engine (`src/`)
  may not import the apps (`web/`, `cli/`), and nothing may form an import
  cycle. It found one — `find-expr.ts` and `expr-parse.ts` imported each other
  for the sake of `ParseError`, which now has its own module.
  The physical move is **not** done and should be weighed rather than assumed:
  measured first, there are no app→engine violations to fix, so the move buys
  a finer engine/data/io split at the cost of rewriting every import path in
  52 files plus the vite, esbuild, service-worker and test harnesses. Worth
  doing when something concrete needs the finer split; the drift it was meant
  to prevent is already prevented.
  Original text:
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
- [x] **S5. Write the doctrine down.** *(done 2026-08-16)* `CONTRIBUTING.md`:
  what "green" actually means (`npm test` neither typechecks nor touches
  `web/`), the layering rules and why cycles are banned, the two-speed
  doctrine, the frozen-format contract *with* an honest note on how far it is
  verified, the parity requirement and what the parity test really asserts,
  how to add a construct, and the habits this codebase learned the hard way —
  test the thing with the slow feedback loop, check a regression test fails
  without its fix, prefer a check that is a number.
  Original text: `CONTRIBUTING.md` (or extend
  CLAUDE.md): the two-speed doctrine (GR3), the layering rules (S4), the
  frozen-format contract (GR1), the parity requirement (GR4), and "a
  feature is a file" (E1) as the extendability acceptance test.
- [x] **S6. Engine perf counters.** *(done 2026-08-16)* `src/stats.ts`: steps,
  results, frontier peak, lazy DFA states, bytes fetched, requests, chunk
  hit/miss, predicate checks/passed. `find-expr --stats` prints them to stderr
  (stdout is the result stream); `?debug=1` shows them in the page.
  Collected from the components that already keep the numbers rather than
  accumulated through the walk — the inner loops are kernel tier, and the only
  addition to one is a single comparison per frontier push, benchmarked at no
  measurable cost (~1.2M steps/s either way). The WASM kernel reports steps
  only, and the panel says so instead of showing zeros as measurements.
  Original text: A `Stats` object on the session:
  steps, lazy-DFA states interned, frontier peak size, bytes fetched,
  chunk-cache hit/miss, predicate checks run/passed, results emitted.
  Several exist ad hoc (`bytesFetched`, `requests`, `steps`) — unify.
  Expose via CLI `--stats` and a `?debug=1` panel in the web UI.
- [x] **S7. Benchmark matrix as CI regression gate.** *(done 2026-08-16)*
  `npm run bench` runs nine query shapes — literal, prefix, class-heavy,
  anagram, big list, negation, counter, multiset, phrase — against the
  *committed* `demo.index` and pins steps, results, lazy DFA states and
  frontier peak against `test/fixtures/bench-baseline.json`. In CI.
  Two decisions the item left open. **Step counts gate, wall-clock does
  not**: a step count is exact and reproducible for a given index and query,
  so a change means the engine explores differently; wall-clock on a shared
  runner is not reproducible and gating on it buys flaky builds. Time is
  printed, because a slowdown at identical step counts is still worth seeing.
  **demo.index, not simple-wiki**: the old script read a gitignored index and
  so failed outright in a clean checkout. `scripts/bench-all.mjs` now runs the
  gate first and the big-corpus measurements only when `data/` is present.
  Verified by planting an engine change (restart penalty 1e-6 → 1e-5) and
  confirming the gate fails.
  Index modes beyond memory are not covered; steps are source-independent, so
  a range-mode row would pin fetch counts rather than traversal.
  Original text: Promote
  `scripts/bench-all.mjs` from measurement to gate: a grid of
  (query shape × index mode) cells — literal/prefix, heavy anagram,
  big-list construct, multi-word phrase, negation-heavy, multi-slot ×
  memory, disk, range(simulated), local-file — each with a step-count and
  wall-clock threshold checked in CI. Kernel-tier PRs must run it.
- [x] **S8. `--explain`.** *(done 2026-08-16)* `find-expr --explain` and the
  `?debug=1` panel print the compiled plan: the peeled pattern, each conjunct's
  automaton size, the predicate (marked as checked per match rather than
  searched), the transforms, and the side datasets the query needs.
  The number that carries the weight is **finiteness**, which is also a
  down-payment on P3: a conjunct is finite when its trimmed automaton has no
  productive cycle, and then its language is counted exactly (capped).
  `{list:countries}` reports 197 strings — a set a planner could enumerate
  instead of walking the trie — while `C*` reports unbounded, and a query
  whose conjuncts are *all* unbounded says so, since that is what usually
  explains a search that will not end.
  One subtlety worth keeping: every unquoted literal carries a space
  self-loop so it tolerates the corpus's spacing, which makes almost every
  language infinite in the strict sense. Finiteness here means the *letter*
  sequences are bounded, or `solar s_stem` would report "unbounded" and
  explain nothing.
  Original text: CLI flag (and debug-panel view) printing the
  compiled plan: conjuncts, chosen strategy (after Phase P), predicted
  cardinalities, predicates, transforms, data needs. Grows with the
  planner; start with what exists (conjunct count/sizes, filter type).

## Phase C — Composability core: one language, one plan, one executor

- [~] **C1. Predicates become a list, not a slot.** *(stacking done
  2026-08-16)* `parseFilterWrappers` peels every result filter, outermost
  first, and `applyResultFilters` ANDs them and collects each one's note —
  `{palindrome:{syllables=1:A{3}}}` gives DID, NON, POP, and
  `{reversible:{syllables=1:A{4}}}` annotates with both "← taht" and "1 syll".
  Before, only one wrapper could be peeled, so the inner one reached the
  pattern parser and was reported as a construct that cannot be nested — a
  correct message about the wrong problem.
  Application short-circuits, because the filters differ wildly in cost:
  `{compound}` probes the index and may fetch bytes where `{palindrome}` is a
  string comparison, so a cheap rejection must not pay for an expensive one.
  Repeating the same filter is rejected rather than silently ANDed with
  itself. Fixed alongside: the wrapper checked only that the query ended in
  `}`, so `{palindrome:A}{bank:xyz}` parsed as one wrapper with the inner
  pattern `A}{bank:xyz`; it now requires the *matching* brace.
  **Not done:** the generalisation to arbitrary `Predicate` functions with a
  `ctx`. The stacking is what users can see; the function-shaped interface is
  worth doing when something needs a predicate that is not a `FilterSpec` —
  C3's shared executor is the natural moment.
  Original text: Replace
  `resultFilter: FilterSpec | null` (`worker.ts:244`, `cli/find-expr.ts:87`)
  with `predicates: Predicate[]` where
  `Predicate = (text: string, ctx) => boolean | Promise<boolean>` and `ctx`
  carries `isIndexedWord` etc. Parse nested filter wrappers recursively so
  `{palindrome:{syllables=5:…}}` and `{stress 10:{compound 2:…}}` work
  (AND semantics). Tests for stacked filters in both CLI and worker.
- [~] **C2. Unified query AST + Plan.** *(much of it delivered piecewise;
  scope was understated)* A review counted **13** distinct sites reading the
  raw query with a regex, not the 9 the item names, and ~22 call sites.
  Already gone: the `{at}`/`{rank}` peeling and the twice-written `{caesar}`
  sniffer (S3, `query-shape.ts`), the duplicate parse in `wasm-session.ts`
  (S1, `compileConjuncts`), the single-slot filter peel (C1), and now the
  `{near}` re-regex — whose `\d*` was uncaptured, so `{near 200:king}` built
  its pattern from 200 neighbours and ordered by 32, leaving the rest tied.
  `plan.ts` (S8) already produces conjuncts, predicate, transforms and
  dataNeeds, which is most of the QueryPlan shape.
  **Still regex-driven:** the five `needsX()` sniffers. They over-fetch rather
  than under-fetch, so they are safe but imprecise, and they run on *different
  strings* in the two front ends (the CLI sees the original query, the worker
  one already stripped of wrappers) — latent rather than active divergence.
  **Deliberately not done:** making wrapper nesting order significant. That is
  a silent semantic change to queries already shared as URLs, and it should be
  a decision rather than a side effect of a refactor.
  Original text: New `src/engine/language/query.ts`:
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
- [~] **C3. Shared executor.** *(the duplicated stages are shared; one loop
  each remains)* `src/output.ts` owns the rank window and `{at}` extraction
  for both front ends, and counts ranks itself — the count is the subtle part,
  since `{rank 200-2000:…}` is a window into the *surviving* stream and two
  implementations of "advanced exactly once" is one more than is safe. The CLI
  now peels wrappers with `shapeOfQuery` too, so both use one order.
  Verified byte-identical CLI output across `{at}`, `{rank}`, nesting, a
  filter and a plain query before and after.
  **Not done:** the single `executePlan(ctx, plan, budget, sink)`. The CLI
  still runs its own driver loop, and folding it into `SearchSession` would
  buy one loop at the cost of changing what the CLI is — it streams, where the
  session pages. The stages that were genuinely duplicated (predicates in C1,
  output here) are shared; the loop is where the two front ends legitimately
  differ.
  Original text: One `executePlan(ctx, plan, budget, sink)` in
  `src/engine/exec/` running: search → predicates → transforms (innermost
  first) → sink. CLI sink = stdout lines; worker sink = postMessage. Kills
  the triplicated pipeline (`present()` in `cli/find-expr.ts:159`,
  `emit`/`flushPending` in `worker.ts:1511`, rank/at logic in `main.ts`).
  Fixes known divergences: CLI gains `{near}` ordering; rank/filter
  interplay identical everywhere.
- [~] **C4. Construct registry.** *(dispatch done 2026-08-17; the per-feature
  file split is not.)* The parser's eleven-branch `if (name === …)` chain is
  now `src/construct-table.ts`: one row per construct, each saying how its
  argument is read and what it builds. `expr-parse.ts` 841 → 656 lines, and
  what is left of it parses rather than knowing what `{rhyme:…}` means.
  Arguments come in three kinds, and naming them is most of what the chain was
  repeating by hand: `literal` (the text is data — `{rhyme:tree}`,
  `{sub:cryptography}`), `wrap` (the argument is a pattern this intersects
  with — `{sum=100:A*}`), `inner` (the argument is a pattern this is *about*,
  built separately — `{del1:beast}`).
  `construct-table.test.ts` holds the catalogue and the table together: every
  automaton-level name reaches a row, every row is reachable by writing
  something, and no predicate or transform has strayed into the automaton
  path. Writing it found four dead rows — `rot13`, `row1`, `row2`, `row3` are
  names a reader writes but never what dispatch receives, since a name lexes
  as letters and the digits land in the spec. `dispatchName` is now the one
  place that rule lives.
  Measured against the item's own acceptance test: adding a construct took two
  edits — one catalogue row, one table row with its builder — and worked
  end to end with no other change, the cross-check and completion tests
  passing unmodified.
  Still open: splitting `value-constraint.ts` (713 lines) into per-feature
  modules under `src/engine/language/constructs/`, which wants S4's directory
  reshape; and `dataNeeds` on the rows, which C6 needs.
- [~] **C5. Slots first-class.** *(planner and CLI done 2026-08-17; the
  grammar-level `;` of C2 is not.)* `src/slot-plan.ts` `planSlots` is the one
  place a query becomes slots: it splits, peels each slot's output wrappers
  and predicates, and returns a `SlotPlan` per slot. `main.ts` consumes it
  instead of splitting and shaping itself, the CLI gained multi-slot, and
  `check-examples.mjs` reads it too — so a documented multi-slot query is now
  checked the way the page runs it rather than by a hand-rolled split.
  The CLI runs each slot in turn, prints `# slot N: …` headers when there is
  more than one, and prints the assembled extraction line after the last.
  A single-slot query's output is byte for byte what it was, since anything
  piping this reads the result stream. The step limit is per slot, matching
  the page: a dozen patterns is a dozen searches, and one shared budget would
  mean the last few never ran.
  `splitSlots` now splits at the top level only, which is what makes one
  wrapper over several slots possible: `{at 1:A{5};B{6}}` was split down the
  middle into two unparseable halves, and is now one wrapper applied to each
  slot — with a slot's own wrapper still winning over it. Both forms are
  covered in the browser test, and they give different answers (`aop` against
  `asp`), which is what proves the outer one is really applied per slot.
  Still open: `;` in C2's grammar rather than a pre-pass, and the slot UI
  consuming a plan object richer than the per-slot query it holds now.
- [x] **C6. Data-provider registry.** `src/data-providers.ts` is one row per
  side dataset — key, file, text or bytes, the constructs it serves, whether a
  query needs it, how to install it — and both loading loops collapse to
  iterating `providersFor(query)`. The worker's forty-line block of six
  near-identical `if (needsX) await ensureExtra(…)` clauses and the CLI's
  different forty lines doing the same by hand are gone; each front end now
  supplies only what it alone knows, a URL and `fetch` or a path and
  `readFileSync`. The worker's two other load sites (`want-lists`,
  `complete-kind`) go through the same rows.
  It fixed a live bug, which is what the two hand-maintained lists cost. A
  construct may be written with its group prefix, and five of the six "does
  this query need it" tests were spelled `\{\s*rhyme\b` and never saw it — so
  `{word.rhyme:tree}`, `{word.near:king}`, `{word.kind:bird}` and
  `{word.like:…}` all answered *needs the … which this build could not load*
  on a build carrying it, while the bare form worked. Only `{list:…}` had the
  prefix, and only for its own group. `mentionsConstruct` in constructs.ts is
  now the one place that knows how a construct may be written, and the
  dataset tests are built on it.
  `test/data-providers.test.ts` tests the end-to-end property rather than the
  regexes: load what a query asks for, and it compiles — for every construct
  each dataset serves, written both ways. Checked that it bites by restoring
  the old regex, which failed four of its cases.
  Not done: `dataNeeds` on the construct rows (C4's sketch). The mapping lives
  on the provider instead, checked against the catalogue so a renamed
  construct cannot leave a dataset pointing at a name nothing can write.
- [x] **C7. WASM eligibility from the plan.** *(delivered by C1 and the
  single parser; verified 2026-08-17 rather than assumed.)* The duplicate
  parse this item was written against is gone: `parseExprBox` now has exactly
  one caller, `compileConjuncts`, and `compileQuery`, `planQuery`,
  `WasmSession` and `languageEmptiness` all go through it. The kernel does not
  re-parse; it stops before `makeFilter` because it wants the conjuncts
  unmaterialized, which is the same parse, not another one.
  "Automaton-only slots → kernel, predicates and transforms handled around it"
  is also how it already works: the page peels the output wrappers and the
  worker peels the predicates before a session is built, so what the kernel is
  handed is automaton-only. Checked: `{palindrome:A{5}}`, `{compound 2:A{9}}`
  and `{syllables=3:A{7}}` all reach it as a bare `A{n}`.
  Eligibility itself stays a try-and-fall-back rather than a prediction, which
  is GR5's rule — the kernel is an acceleration that must degrade gracefully,
  and an attempt that throws `WasmCapacityError` is a more honest test than a
  static guess at what the kernel can hold.

- [x] **C8. Stop a streamed run that has stopped producing.** *(Added
  2026-08-17, not in the original plan.)* Over a streamed index the head
  sidecar answers in well under a second, and what the index adds afterwards
  varies enormously. Measured on the deployed English index: `A{5}&C*` went
  from 77 results to 1,027 over the next seventeen seconds, while
  `{palindrome:A{5}}` and `A{7}&.*zz.*` spent the whole twenty-second budget
  adding nothing — the walk paying a round trip per region and finding none of
  them relevant. The page said "searching…" for twenty seconds and then showed
  exactly what it had shown at 0.8 s.
  `src/run-limiter.ts` adds a stall cap beside the byte and time caps: stop
  when nothing has reached the reader for six seconds. Six comes from the
  productive case, not the wasteful one — `A{5}&C*`'s longest gap before the
  flood was 3.9 s. It is counted on results *posted*, not matches made, because
  a `{palindrome:…}` run matches candidates the whole time and shows none.
  A "continue" carries no stall cap at all: a reader who asked to keep
  searching has said the wait is worth it.
  Extracting it found the real bug. The clock was read every 1,024 steps, on
  the reasoning that this is far finer than the seconds it measures — true of a
  memory walk, false of a step that is a round trip. `{palindrome:A{5}}`
  stopped at exactly 1,024 steps having spent 15 s and 49.8 MB reaching the
  first check. It is 64 now, which costs nothing: the limiter is only built
  when the index is remote.
  Measured on the deployed site, before and after:

  | query | settled | fetched | results |
  |---|---|---|---|
  | `{palindrome:A{5}}` | 20.2 s → **7.4 s** | 49.8 → **21.1 MB** | 60 → 60 |
  | `A{7}&.*zz.*` | 20.6 s → **7.0 s** | 48.2 → **20.8 MB** | 21 → 21 |
  | `A{5}&C*` | 17.4 s → 16.6 s | — | 1,027 → 1,027 |

## Phase E — Engine algebra & clarity dividends

- [x] **E1. Lazy complement.** *(done 2026-08-16)* `src/expr-filter.ts`:
  `ComplementFilter` wraps any `Filter`, flipping acceptance and mapping DEAD
  to an accepting absorbing sink, so `!expr` is walked as the search asks for
  it. A conjunct is now `Nfa | {not: Nfa}` (`src/conjunct.ts`) and
  `ProductFilter` takes `Filter[]` (the half of E2 that E1 needs, since
  `A{6}&!{distinct:A{6}}` is a product *containing* a complement).
  Measured on the 1.3 GB index: that query was refused outright before; the
  eager complement would run it in 27.8 s at 2,005 MB peak, the lazy one does
  it in 9.9 s at 1,645 MB. Appending the required trailing space needed an
  argument, since ¬A·" " ≠ ¬(A·" "): the two agree on words that end in a
  space, which every positive conjunct already forces, so an all-negated query
  gets an explicit "ends in a space" conjunct instead. Pinned by a
  differential test against the eager `complement()` over every word up to
  length 4. The eager path stays where an NFA is structurally required —
  `Box.materialize` (quantifier, union, concatenation) and the WASM kernel,
  which cannot take a lazy filter and so keeps running the small negations it
  always could, falling back to JS only when the complement will not build.
  Trade recorded: the eager path's `determinize` merges equivalent states
  (37 vs 76 on the bench), so small negations explore ~2% less per step on the
  JS engine. Over the limit the error now names it rather than claiming
  `can't parse`, and `complement()` stops determinizing at the cap instead of
  running to 500,000 states and then rejecting.
  Original text: `complement()` (`automata.ts:454`) eagerly
  determinizes with a 5,000-state cap; over the cap the user gets a
  generic parse error (`expr-parse.ts:157` returns null, erasing the
  reason). Implement `ComplementFilter implements Filter`: lazy subset
  construction (reuse ExprFilter), acceptance flipped, DEAD becomes an
  accepting self-loop sink. Removes the cap entirely. Keep the eager path
  only where an NFA is structurally required (inside quantifiers), with a
  proper ParseError naming the limit when it trips.
- [x] **E2. Filter-level boolean algebra.** *(completed by E1; verified
  2026-08-17 rather than assumed.)* `ProductFilter.subs` is `Filter[]`,
  `makeFilter` composes at the Filter level — `new ProductFilter(conjuncts.map(
  conjunctFilter))` — and `conjunctFilter` gives a negated conjunct a lazy
  `ComplementFilter` rather than building it out. Nothing materializes for
  boolean reasons anywhere on the JS path.
  Products of products remain unreachable rather than unimplemented: a query
  compiles to a flat list of conjuncts, so no sub is ever itself a product.
  `subs` being `Filter[]` means one would work if a caller ever made one;
  writing the case that cannot arise would be untested code.
- [x] **E3. Trie-shaped `entriesNfa`.** *(done 2026-08-16)* Prefix trie
  instead of union-of-chains: bird 26,276 arcs → 14,905, tree 43,543 →
  22,350 (~57%), and one start branch instead of one per entry. Equivalence
  tests vs the old construction in `test/word-lists.test.ts`. A DAWG sharing
  suffixes is still on the table if sets get bigger.
- [~] **E4. Int-pool interning in `ExprFilter`.** *(measured and declined
  2026-08-16.)* The premise does not hold. CPU profiles over the demo index,
  with `ExprFilter.intern` renamed so the two `intern`s could be told apart:
  `{distinct:A{6}}` 0.0%, `<aciimnrttu>` 0.8%, `!{distinct:A{5}}` 1.2%,
  `{list:countries}` 0.0%, `A{5}&!.*ee.*` 0.0%. The comment this item cites is
  about *ProductFilter*, where string keys really did dominate and were really
  replaced; the cost was generalized to `ExprFilter` without measuring it. The
  states accumulate in the product, not in the subs — `{distinct:A{6}}` spends
  21% in `ProductFilter.intern`, which is already an open-addressed int pool
  and hashes a 26-wide tuple per transition. If this is revisited, that is the
  place, and narrowing the tuple (most sub-filters do not move on a given
  letter) is the idea worth trying, not the key encoding.
  **Follow-up (2026-08-17): the successor idea is wrong too, and measured so.**
  This note said the place to look was `ProductFilter.intern` and the thing to
  try was narrowing the tuple. A fresh profile confirms the first half —
  `{distinct:A{6}}` spends 17.9% there against 8.6% in `compute` — and refutes
  the second. Two experiments, on a 1.2M-step run over the demo index,
  median of five:

  * Folding the hash into the loop that builds the tuple, so the 26 entries
    are hashed as they are produced instead of walked a second time: 2,546 ms
    against a 2,517 ms baseline. No gain, inlined or as a static helper.
  * Comparing only 4 of the 26 entries on a probe — wrong, but it prices the
    compare: 2,517 ms, identical to baseline.

  Neither the hashing nor the comparing is the cost, so the tuple's *width* is
  not what to attack. What is left in `intern` is the random access itself:
  one probe into `slots`, one into a `pool` that holds 79,680 states times 26
  ints — 8.3 MB, far past any cache. It is memory latency, not arithmetic.
  Anything that helps has to shrink the pool's footprint (packing several sub
  states per int, which lazy filters make awkward since ids grow without
  bound) rather than touch how the tuple is hashed or compared.

  Original text: `intern()` keys DFA states with `sorted.join(",")`
  (`expr-filter.ts:113`) — string building + Map hashing per novel subset.
  Port ProductFilter's open-addressed Int32 pool (`expr-filter.ts:158`, whose
  comment records that string keys dominated anagram time). Benchmark gate
  (S7) proves it.
- [x] **E8. Running out of automaton is a status, not an error.**
  *(done 2026-08-16, not previously on the list.)* The lazy DFA is capped at
  500,000 states, and `{distinct:A{6}}` — an example the docs offer — reaches
  it after ~7.8M steps against the demo index, since it has one state per
  set-of-letters-seen-so-far. It threw a bare `Error`, which the worker turned
  into `post({type:"error"})`: a search reported as *failed* even though every
  result already on screen was correct, with a "try harder" button that would
  rebuild to the same wall and fail again. Now `FilterCapacityError`
  (`expr-filter.ts`), which `SearchSession.run` ends on with a new `"complex"`
  status, keeping the results; the page explains that the results are complete
  as far as the search got and suggests narrowing rather than offering to try
  harder, and a repeat run says so immediately instead of spending the budget
  again. The CLI streams results before the wall either way, and now says they
  stand rather than printing a bare `error:`. `SearchSession` accepts a
  prebuilt `Filter` so this is testable without an eight-million-step query
  (and as a step toward A4's filter reuse).
- [x] **E5. Frontier memory diet.** *(done 2026-08-17, for memory; the speed
  case it asked for does not exist.)* `ch` is a byte read out of the index, so
  it is a `Uint8Array` in both the frontier and the breadcrumb trail rather
  than an `Int32Array`.
  The item asked for S7 numbers showing benefit. On speed there are none: a
  1.2M-step run of `{distinct:A{6}}` is 2,658 ms against 2,517 ms before,
  `{maxrep=2:A*}` 993 against 971, both inside the run-to-run spread, and the
  nine bench cases match baseline. Narrowing the frontier's row from 44 bytes
  to 41 does not move a heap whose peak is around 20,000 entries.
  On memory it is real, and the trail is where it lives rather than the
  frontier. The trail grows for the length of a run and is never compacted:
  measured over the demo index, `A{4} A{5}` reaches 1,016,567 entries after
  1.2M steps and `{distinct:A{6}}` 912,826 — 8.1 MB and 7.3 MB at 8 bytes an
  entry, 5.1 MB and 4.6 MB at 5. Roughly 3 MB saved per million steps, in a
  worker that may be running on a phone.
  `state` and `crumb` are left alone: both are indices that legitimately reach
  past 65,535, and the DFA state cap is 500,000.
- [x] **E6. Generated docs.** *(done 2026-08-16)* Every construct carries a
  `summary` and a runnable `example` in `src/constructs.ts`;
  `scripts/build-docs.mjs` renders the grouped reference into
  `web/public/usage.html` between markers, and `npm run check-docs` fails CI
  if it drifts — so a construct added without documentation cannot ship.
  A unit test additionally compiles every construct's example *at that
  construct's level* (predicates and output wrappers are peeled before the
  engine sees them, so compiling one directly is meant to fail), which is
  stricter than the "runs against demo.index" the item asked for and needs no
  index. The README feature table is still hand-written: it describes
  features, not constructs, so there is nothing to generate it from.

## Phase P — Query planner: right engine per query

- [x] **P1. Word-membership/score sidecar.** *(done as the head sidecar,
  which turned out to be the same file: `<index>.head` is the top 500,000
  entries with their scores, ~3.8 MB gzipped, served next to the index and
  loaded lazily — so no DAWG or bloom filter was needed.)* `head-index.ts`
  `headWordChecker` answers `{compound …}` and `{reversible …}` from it
  instead of walking the index per piece, which over a stream cost a round
  trip each: `{compound 2:A{9}}` went from 60 s and empty to 774 ms with a
  full page. It is not an approximation — the constructs' floors are shares
  of the corpus, the head is sorted by exactly that, so once the head reaches
  below a floor, absence from it *proves* failure of the floor. Measured, it
  reaches 3x to 30x below across all 22 languages, and `build-head.mjs`
  reports the margin as it writes.
  The head also carries a signal the index cannot give cheaply: how much of a
  string's weight comes from words merely ending in it. That is what finally
  stopped `{compound}` cutting at suffixes (`publish·ed`, `relation·sh·ip`),
  which no frequency floor could do — see `MIN_STANDALONE_RATIO`.
  Still open: the same trick does not work on first pieces (`ap·pointed`,
  `gene·rally`) — measured, there is no threshold; it would need morphology or
  a word list. And the batch-then-`flushPending` path is still there:
  `{compound}` / `{reversible}` predicates do not yet stream through the
  pipeline.
- [x] **P2. Direct score probe.** `src/index-probe.ts`: `probeCount(reader,
  text)` walks a single path down the trie and returns the occurrences of
  `text` as a complete word or phrase, 0 if the index has no such entry;
  `probeShare` gives the same as a fraction of the corpus, which is the form
  worth comparing across indexes three orders of magnitude apart in size.
  Range-aware by construction — `reader.children` returns a promise when the
  bytes are not in hand — and bounded by the string's length rather than the
  index's size: measured over the demo index served by HTTP Range, an
  eight-character probe issues at most eight requests.
  `makeWordChecker` is now this plus a floor, which is what it always was: the
  walk behind `{compound …}` and `{reversible …}` was a private copy. Its
  cache is keyed by word rather than by word-and-floor now, since a count does
  not depend on what is being asked of it.
  Writing the equivalence test — the probe's answer is the score the search
  reports for the same string — found that `exhaustive.test.ts`'s "finds a
  needle that only one entry matches" was asserting nothing: its needle,
  "nutrimatic", is not in the demo index, so the search found nothing and the
  oracle expected nothing. It uses a needle that is in the haystack now, and
  checks that it is.
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
- [x] **E10. Say when a pattern cannot match anything.**
  *(done 2026-08-16, not previously on the list; overlaps P6.)*
  `A{5}&A{6}` spent the entire million-step budget — ~950ms locally, and tens
  of megabytes fetched in range mode — establishing that nothing is both five
  letters and six, after which the page offered "Try harder". `src/emptiness.ts`
  answers it from the automaton instead: breadth-first over reachable DFA
  states, which is ~40 states for that query, since emptiness is a question
  about states rather than about words. `SearchSession.run` returns a new
  `"empty"` status without walking the index at all, and the page names the two
  written parts that disagree — the difference between "no results" and "these
  two cannot both be true", which point a reader at completely different
  things.
  Three-valued on purpose: proving emptiness means visiting every reachable
  state, so past a budget it reports `"unknown"` and the search proceeds
  unchanged. A wrong "empty" would hide real results; "unknown" costs only what
  the search cost already. A test asserts no matching pattern is ever called
  empty at any budget.
  The budget is 2,000 because a *contradiction* is cheap to prove (every one
  found settles under 500) while an expensive proof means a large satisfiable
  automaton, where the check has nothing to add. At 20,000 the multiset
  benchmark pre-built 5,946 lazy DFA states it might never visit; at 2,000 it
  builds 30, and the rest of the grid 45 between them. Steps and results are
  unchanged everywhere — only the state counter moved, and the baseline is
  updated for that.
  Parts are named only when the written conjuncts line up one-to-one with the
  compiled ones: `{sum=52:A*}` is several conjuncts written as one, so guessing
  which text belongs to which automaton would mislabel them, and it says the
  shorter thing instead.
- [x] **E11. Check the range-mode cost cap every step.**
  *(done 2026-08-16, not previously on the list — found by measuring the
  deployed site.)* Range mode caps a run at 32 MB fetched or 20 s, because a
  step is a poor proxy for cost when a step can be a network round-trip. The
  cap was consulted every 2,000 steps, and in range mode a single step can
  pull a ~440 KB chunk — so the first check arrived long after the budget was
  gone. Measured on nutristatic.org against the 1.3 GB en-wiki index, the
  first homepage example (`"C*aC*eC*iC*oC*uC*yC*"`, facetiously) reported
  `steps: 2,000, fetched: 179.7 MB` — 5.6x the cap, in 424 requests, and then
  no results. `{scrabble>25:A{5}}` fetched 519 MB, most of the index.
  Now consulted every step; the predicate is a field read and a compare, and
  the worker reads the clock — the expensive half — only every 1,024 calls.
  Two tests pin it, both failing on the old stride.
  Enforcing the cap properly would on its own have *removed* answers people
  were getting — `<aaagmnr>`, a front-page example, was reaching its first
  result at ~44 MB, i.e. only because the cap was overshot — so the budget
  goes to 64 MB in the same change. Measured live, that is the line where all
  four front-page examples work (`<aaagmnr>` 43 MB, `"_ ___ ___ _*burger"`
  51 MB, the other two under 4). Past it, streaming stops being the better
  deal: `{distinct:A{6}}` wanted 172 MB and `{sum=100:A*}` 453 MB against a
  785 MB whole-index download that then makes *every* query instant, which is
  what the page recommends there. Actual transfers land ~10% over the cap,
  since fetches already in flight still complete.
- [x] **E12. Read-ahead was fetching four times more than the walk used.**
  *(done 2026-08-16, not previously on the list — found by measuring against
  the deployed 1.3 GB index.)* Both range sources extend a miss-fetch
  *backwards* by the bandwidth-delay product, which is right — the index is
  post-order, so a node's descendants lie contiguously before it — and cap it
  at 32 chunks so a fast link cannot balloon. 32 was too many: the extra
  subtree was largely unused, and since a run is capped on *bytes*, the waste
  came straight out of how deep the search could go. Now
  `MAX_READAHEAD_BLOCKS = 8`, shared by both sources.
  Measured over the compressed sidecar at the real prefetch depth:
  `<aaagmnr>` 44.0 MB / 1286 ms → 20.9 MB / 957 ms; `"_ ___ ___ _*burger"`
  10953 ms → 8641 ms; `{distinct:A{6}}` found nothing within budget → found
  results. Uncompressed: `<aaagmnr>` 0 results at 84.6 MB → 20 results at
  52.6 MB. 4 was better again on bytes but lost more to round-trips.
  Measured on both paths rather than changing one by analogy with the other.
- [ ] **E13. A pin several pending reads can hold.** `CompressedRangeSource`
  (and `HttpRangeSource`) keep one pin span, overwritten by whichever `ensure`
  ran last, which is only correct while at most one read is pending. Traced on
  2026-08-17 against the demo index with a deliberately small cache: a block
  was evicted with the pin on an unrelated span
  (`EVICT 625 keep[332,340] pin[213,213]`) and the read that had ensured it
  failed with "byte … not ensured", in roughly three runs in five.
  The one-span pin is wrong, but *fixing it is not enough*, which is the thing
  worth knowing before starting. Tried and reverted 2026-08-17: a set of held
  spans with an explicit `release` on `ByteSource`, released by
  `IndexReader.childrenInto` after its read rather than by the next `ensure`.
  It left the failure exactly where it was — 8 and 16 blocks still fail, 24
  and up still do not — and the instrumented throw says why: at the moment of
  the crash the missing block *is* held (`held=[[502,502]], isHeld=true`) and
  is simply not in the cache. Since nothing can evict a held block, it was
  never inserted, so the bug is in the fetch/insert path and not in eviction
  at all. Start there.
  `MIN_CACHE_BLOCKS = 64` keeps it out of reach meanwhile — the default is
  4096 — so nothing real is exposed.
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
- [x] **T4. Registry-driven smoke tests.** *(done 2026-08-16.)*
  `scripts/check-examples.mjs`, wired into CI as `npm run check-examples`:
  every one of the 45 documented construct examples — and, since 2026-08-17,
  every runnable `?q=` link on the front page, the usage guide and the recipes
  page, 95 more — is *searched* against the committed demo.index with the side
  datasets loaded, and the build fails if one throws or finds nothing.
  `check-links` proves a link searches what its label says; this proves the
  label is worth searching. 3 seconds, because it stops at the first few survivors
  rather than draining the search. Parsing was never the bar — a unit test
  already covered that, and both constructs that broke this session
  (`{compound}`, `{reversible}`, see E9) parsed perfectly while returning
  nonsense.
  It checks that a feature runs and is not silently dead, not that its answers
  are right: no fixture says what `{rot180:A{4}}` ought to return.
  One construct is listed as unsatisfiable rather than broken, with its reason
  and the entry checked both ways — if it ever starts working the list is
  wrong and CI says so. Three entries now: `{words=3:A*}` twice (the construct
  and the front-page link), and the usage guide's Mortal Jeopardy anagram,
  whose documented answer is a nine-word phrase. `{words=3:A*}` finds nothing on demo.index because
  that index is words and bigrams, so no match *has* three words; on the full
  Wikipedia index it returns "wikipedia articles for", "articles for
  deletion". (An earlier note here called that an open defect. It was not one:
  the construct is correct and the fixture cannot exercise it.)
  Original text: Every registered construct's
  `docs.example` (E6) executes against `demo.index` in CI — a feature
  without a working example fails the build.

- [x] **E9. A word is not just something the corpus contains.**
  *(done 2026-08-16, not previously on the list.)* `{reversible:A{4}}` led
  with THAT, FROM and HAVE — "taht", "morf" and "evah" are all in a web
  corpus — and `{compound 2:A{9}}` cut AVAILABLE into "avai·lable",
  EDUCATION into "educ·ation" and PRESIDENT into "p·resident". `isWord`
  (`index-words.ts`) meant "present with a word boundary", and an index is a
  corpus, not a dictionary. Now a word must carry a *share* of the corpus:
  measured on demo.index, genuine compound pieces run 1e-4 to 9e-4 while the
  fragments that were passing run 9e-8 to 3e-6, so the floor sits in the gap
  at 1e-5, with a 1e-6 floor for reversals (whose rare end — emit at 2.1e-6,
  pots at 6.6e-6 — sits lower) and a two-character minimum per compound piece,
  since a single letter clears any floor. Relative rather than absolute so it
  survives the index being German or Portuguese, where a word list would not.
  `{compound}` is fixed. `{reversible}` is improved, not fixed, and the
  measurements say why it cannot be: junk reversals span 1.1e-6 to 7.9e-6
  ("trac", "liam") and genuine ones span 1.9e-6 to 4.4e-5, so no threshold
  separates them — "case ← esac" still gets through. Frequency is exhausted
  as a signal there; it needs a real dictionary, which is P1, and is
  English-only, which is F2. Two tests record that residue rather than
  pretending it is gone.

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
