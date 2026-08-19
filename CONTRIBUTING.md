# Working on Nutristatic 9000

This is the doctrine the codebase is built to, and the reasoning behind the
parts that look odd. This document is about how to build, not what.

## What "green" means

`npm test` is not sufficient on its own, and the gap has bitten more than once.

| Command | Covers |
|---|---|
| `npm run typecheck` | types — **`npm test` does not typecheck**; vitest transpiles without checking |
| `npm test` | the unit suite over `src/` (~800 tests and growing; the exact count is not the point — what matters is that it does not typecheck) |
| `npm run check-layers` | engine↛app imports, and import cycles |
| `npm run check-docs` | the usage guide's construct reference matches the catalogue |
| `npm run bench` | nine query shapes still explore the index identically |
| `npm run check-links` | every example link searches what its label says, relatively |
| `npm run check-examples` | every construct example and every page's example links actually find results on demo.index |
| `npm run build && npm run test:browser` | the only end-to-end coverage of `web/worker.ts` and `web/main.ts` |
| `npm run test:offline` | the single-file `file://` build |

CI runs all of them. **Anything touching `web/` needs the browser suite**: the
unit tests import nothing from `web/main.ts` or `web/worker.ts`, so they will
happily stay green through a change that breaks the site.

## Layering

`src/` is the engine and its data. `web/` and `cli/` are front ends. The engine
must not import a front end — enforced by `check-layers`, along with a ban on
import cycles.

An import from `src/` into `web/` makes the engine unusable outside a browser,
and is the first step towards the CLI and the site behaving differently. They
already have, twice: the CLI lacked `{near}` ordering, and the two front ends
kept separate copies of the result-filter rule that drifted in their
annotations. When both sides need a rule, the rule goes in `src/`.

One divergence remains on purpose: `{near:…}` orders results by closeness in
the browser but not in the CLI, because ordering needs a page to be collected
first and the CLI streams. Adding buffering to it would change what the CLI
*is*, so the difference is recorded rather than papered over.

Cycles are banned because they are silently survivable. `find-expr.ts` and
`expr-parse.ts` imported each other for one error class; ESM hoisting forgives
that right up until a bundler splits the modules differently, and then it is an
undefined class at run time.

## Two-speed code

**Kernel tier** — `search-driver.ts` (Frontier), `expr-filter.ts`, the
`index-reader.ts` inner loops, `wasm-kernel/kernel.c` and its bridge. Typed
arrays, struct-of-arrays, no allocation in loops, monomorphic call sites. The
frontier is millions of entries at 44 bytes each; one object per entry would be
roughly ten times worse. Benchmark before and after — `npm run bench` pins how
the engine explores, and if a change is *meant* to alter that,
`npm run bench:update` rewrites the baseline and the diff becomes the evidence
that it did what was intended. Say so in the commit message.

**Glue tier** — everything else. Written for clarity; allocation is fine.

Never hybridise a file. If glue gets hot, move the hot part into the kernel
tier rather than making a clear file clever.

A concrete example of the split in action: `src/explain.ts` reconstructs why a
match matched by re-running edits backwards and re-compiling conjuncts. That
would be absurd inside the search loop. It runs once, for one string, when
someone clicks "why?" — so it can afford to be exhaustive precisely because it
is not on the hot path.

## The index format is frozen

Byte-compatible with upstream Nutrimatic, forever. New capabilities ship as
**sidecar files** (`.idxz` compression, `.head` first-page answers, `.rindex`
reversed copies, `lists.txt`), never as changes to `.index`.

`.idxz` is the template worth copying: a magic string with a version
(`nutriz02`), a header validated against the real index's length, and sanity
ceilings against crafted files. A new sidecar should do all three.

**Be precise about what is verified.** Three tests carry the compatibility
claim, each a different kind of evidence: `upstream-format.test.ts` reads
fixtures built by the C++ `make-index` (committed under `test/fixtures/`) and
requires this reader to decode them to what upstream's `dump-index` reports
*and* this writer to reproduce their bytes exactly; `index-format.test.ts`
round-trips the writer and reader over decoded meaning; and
`expr-search.test.ts`, a port of `test-expr.cpp`, pins query semantics. Bytes,
meaning, behaviour — a change that breaks compatibility has to get past all
three.

## Both engines must agree

The WASM kernel and the JS engine must emit identical score streams for any
query they both accept; `test/wasm-session.test.ts` pins it. Note what that
test actually asserts: score sequences are order-exact, but result *text* is
compared as a set, because equal-scored results may legitimately emit in either
order.

The kernel takes flattened conjunct NFAs and knows nothing about the query
language, so **any feature that compiles to an NFA conjunct works in both
engines with no C changes**. Predicates and output wrappers sit outside the
engine entirely. If a change needs C, check first whether it could be an NFA.

The JS engine is the reference implementation and the fallback. The kernel,
and anything else fast, must degrade to it.

## Adding a construct

`src/constructs.ts` is the catalogue: name, group, level, a one-line summary
and a runnable example. Everything reads from it — the parser's dispatch, "did
you mean", the completion menu, and the generated reference in the usage guide.
`npm run check-docs` fails CI if the guide drifts, so a construct without
documentation cannot ship.

Names carry an optional group prefix (`{cipher.rot13:…}`). The bare name always
keeps working: queries live in shared URLs, and breaking them to tidy a
namespace is a bad trade.

Predicates (level `"predicate"`) take a different path from automaton
constructs: their spec goes through `parseFilterSpec` (shared by the
whole-query peel and the nested parse), and their verdict runs in
`result-predicate.ts` / `span-verify.ts`. A predicate whose argument is data
rather than a pattern (`{iso:…}` carries ciphertext) must be excluded from
the wrapper peel — `predicateTakesData` in `constructs.ts` is the one copy of
that rule, consulted by the parser and the tests alike.

## Documentation is generated where it can be

The construct reference in `web/public/usage.html` is rendered by
`scripts/build-docs.mjs` between markers. Edit `src/constructs.ts` and run
`npm run build-docs`. The README feature table is still hand-written, because
it describes features rather than constructs.

## Habits that were learned the hard way

**Test the thing with the slow feedback loop.** The Wikipedia harvest takes
twenty minutes over a 24 GB dump. Its parser shipped wrong three times — the
Pokémon list arrived with LOCH NESS MONSTER and ERROR HANDLER among its members
— because each guess cost a whole cycle to check and the result looked
plausible. Moving the parsing into `src/wiki-extract.ts` with tests, and
checking against one article fetched from the API, turned twenty minutes into
two seconds.

**Check that a test fails without the fix.** A regression test that passes
before and after proves nothing. The chunk-eviction race has a test that was
confirmed to produce the exact CI error when the fix is removed.

**Prefer a check that is a number.** "The list looks right" survives review;
"generation I Pokémon has 151 members" does not, because 151 is either right or
wrong.

**Measure before a large refactor.** A directory reshape was once deferred
after measuring that there were no layering violations to fix — the
enforcement was the value, and it cost sixty lines instead of rewriting every
import path.

**A passing browser test does not mean it is visible.** Playwright clicks a
fully transparent button perfectly well, which is how the "why?" button shipped
invisible. Assertions about appearance should measure something (the dark-mode
test compares luminance), not merely find the element.

## Deploying

One command, with the mistakes made unmakeable:

    NUTRISTATIC9000_DEPLOY=user@host:/srv/nutristatic9000 npm run deploy

It builds, copies the head sidecars from `web/heads/` into dist (refusing to
deploy without them — a missing head makes every streamed search ~20x slower,
quietly), rsyncs, and runs `check-deployed`, which asks the live site whether
every index the picker offers is served with its `.idxz` and `.head`, and
compares every hand-written data file's served size against the build.
Indexes and their `.rindex` reverse sidecars are served from the site root
and shared with the parent deployment — the fork ships only `demo.index`, and
nothing in this repo should ever `--delete` against a directory holding them.
The storage manager (`web/storage.html`) is how users get device copies; its
download worker reuses the same `web/worker/downloads.ts` machinery, so a
change there affects both.
