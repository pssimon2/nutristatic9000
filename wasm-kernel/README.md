# WASM search kernel

The full search engine — best-first walk plus the lazy-filter machinery
(on-demand subset construction per conjunct NFA, lazy product of conjuncts,
tuple/subset interning via open-addressed hashes) — compiled to WebAssembly
from freestanding C. The web worker runs it for fully-local indexes (memory
mode, or an OPFS disk copy up to the kernel's ~2.4 GB memory cap, where the index is copied into linear
memory); range mode and any WASM failure use the JS engine, which is the
reference implementation and the fallback.

- `kernel.c` — the engine in freestanding C, compiled with plain clang
  (`--target=wasm32-unknown-unknown`, no Emscripten). Index bytes and the
  lazy DFA / product tables live in linear memory; each accepted result
  returns to JS for dedup and emission. `heap_mark` / `heap_reset` bracket
  per-query allocations so tables are reused rather than leaked.

`src/wasm-session.ts` drives the kernel behind `SearchSession`'s interface,
and `test/wasm-session.test.ts` locks parity (identical score streams), the
per-query heap reset, resumability, and the engine-ownership guard that stops
a superseded run from stepping a re-seeded kernel.

The JS typed-array hot loop is near-native for this workload, so the JS
engine stays the reference and the fallback.

Build with `npm run build-wasm` (the web build bundles `kernel.wasm` as an
asset).
