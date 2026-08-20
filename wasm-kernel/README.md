# WASM search kernel

The full search engine — best-first walk plus the lazy-filter machinery
(on-demand subset construction per conjunct NFA, lazy product of conjuncts,
tuple/subset interning via open-addressed hashes) — compiled to WebAssembly
from freestanding C. Two drivers run it: the web worker, for fully-local
indexes (memory mode, or an OPFS disk copy, with the index copied into
linear memory), and the CLI (`cli/find-expr.ts`), for single-index walks
with a raised or unlimited `--max-steps` budget. Linear memory is capped at
3 GB at link time; the index may use up to ~2.4 GB of it
(`KERNEL_INDEX_CAP` in src/wasm-session.ts), the rest being reserved
frontier/DFA/parse-cache capacity. Range mode and any WASM failure use the
JS engine.

- `kernel.c` — the engine in freestanding C, compiled with plain clang
  (`--target=wasm32-unknown-unknown`, no Emscripten). Index bytes and the
  lazy DFA / product tables live in linear memory; each accepted result
  returns to JS for dedup and emission. `heap_mark` / `heap_reset` bracket
  per-query allocations so tables are reused rather than leaked.

`src/wasm-session.ts` drives the kernel behind `SearchSession`'s interface,
and `test/wasm-session.test.ts` locks parity (identical score streams), the
per-query heap reset, resumability, and the engine-ownership guard that stops
a superseded run from stepping a re-seeded kernel.

The kernel runs the same walk several times faster than the JS engine on
deep, fully-local walks (a 12M-step exhaustive walk of `"_{34}"` over the
English index: 13.6 s → 3.7 s). The JS engine stays the *correctness*
reference and the fallback: both emit identical score streams, locked by the
parity tests.

Build with `npm run build-wasm` (the web build bundles `kernel.wasm` as an
asset).
