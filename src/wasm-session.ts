// WASM search engine: drives wasm-kernel/kernel.wasm (the full lazy-filter
// engine in freestanding C) behind the same interface as SearchSession, so
// the worker can swap engines per search. The kernel needs the whole index
// in linear memory, so it only serves fully-local indexes; callers fall back
// to the JS engine on any failure (instantiation, memory growth, capacity
// overflow) — both engines emit identical score-streams, so a fallback can
// replay a query and suppress already-emitted results.

import { ALPHABET, Nfa, NSYM, trim } from "./automata.js";
import { DEFAULT_RESTART, compileConjuncts } from "./find-expr.js";
import type { SearchResult, SessionStatus } from "./search-session.js";
import { SessionContext } from "./session-context.js";

/** The kernel ran out of a fixed-capacity table; retry on the JS engine. */
export class WasmCapacityError extends Error {
  constructor() {
    super("WASM kernel capacity exceeded");
  }
}

// Capacities are generous: linear memory is reserved, not touched, until the
// kernel actually writes it, so oversizing costs address space, not RAM.
const F_CAP = 8_000_000; // frontier entries (37 bytes each)
const C_CAP = 16_000_000; // crumb entries (5 bytes each)
const P_CAP = 1 << 20; // product states per query
const DFA_CAP = 16384; // lazy subset-DFA states per conjunct
const POOL_CAP = 1 << 20; // subset-member pool per conjunct (u32s)
const IO_BYTES = 16 + 512; // result mailbox: steps, len, score, text
// Parse cache reservation (kernel.c PC_SLOTS/PC_MAX_ENTRIES/PC_POOL): slots
// (2×2M×4) + entries (1M×16) + child pool (4M×13). Reserved address space,
// physical pages only as the cache fills.
const PARSE_CACHE_BYTES = 88 * 1024 * 1024;
const PAGE = 65536;

interface KernelExports {
  memory: WebAssembly.Memory;
  walloc(n: number): number;
  heap_mark(): number;
  heap_reset(mark: number): void;
  setup(
    idxPtr: number,
    idxLen: number,
    alphaPtr: number,
    restart: number,
    fCap: number,
    cCap: number,
    ioPtr: number,
  ): void;
  begin_query(pCap: number): void;
  add_conjunct(
    nStates: number,
    start: number,
    arcStartPtr: number,
    arcLabelPtr: number,
    arcToPtr: number,
    finalPtr: number,
    dfaCap: number,
    poolCap: number,
  ): number;
  seed(total: number): number;
  run(budget: number): number;
}

function slotsFor(cap: number): number {
  let slots = 1;
  while (slots < cap * 2) slots <<= 1;
  return slots;
}

function growTo(mem: WebAssembly.Memory, needBytes: number): void {
  const have = mem.buffer.byteLength;
  if (needBytes > have) mem.grow(Math.ceil((needBytes - have) / PAGE) + 1);
}

interface FlatNfa {
  n: number;
  start: number;
  arcStart: Uint32Array;
  label: Uint8Array;
  to: Uint32Array;
  fin: Uint8Array;
}

/** CSR-flatten a trimmed NFA for the kernel's add_conjunct. */
function flatten(nfa: Nfa): FlatNfa {
  const n = nfa.arcs.length;
  const arcStart = new Uint32Array(n + 1);
  let m = 0;
  for (let s = 0; s < n; ++s) {
    arcStart[s] = m;
    m += nfa.arcs[s].length;
  }
  arcStart[n] = m;
  const label = new Uint8Array(m);
  const to = new Uint32Array(m);
  let k = 0;
  for (let s = 0; s < n; ++s) {
    for (const a of nfa.arcs[s]) {
      label[k] = a.label;
      to[k] = a.to;
      ++k;
    }
  }
  const fin = new Uint8Array(n);
  for (const f of nfa.finals) fin[f] = 1;
  return { n, start: nfa.start, arcStart, label, to, fin };
}

/**
 * One kernel instance bound to one index copied into linear memory. Create
 * per opened index (a fresh instance frees the previous index's memory);
 * queries reuse the instance via heap checkpoint/reset.
 */
export class WasmEngine {
  /**
   * The session whose query currently lives in the kernel. A session checks
   * this before every step: a superseded run resumed late must never step
   * the kernel, which by then holds the NEW query's state.
   */
  owner: WasmSession | null = null;

  private constructor(
    private readonly ex: KernelExports,
    private readonly ioPtr: number,
    private readonly queryHeapBase: number,
    private readonly total: number,
  ) {}

  /**
   * Instantiate the kernel and load the index. `loadIndex` fills the target
   * view with the full index bytes (a memory copy, or sliced OPFS reads).
   */
  static async create(
    module: WebAssembly.Module,
    indexSize: number,
    total: number,
    loadIndex: (target: Uint8Array) => void,
    restart = DEFAULT_RESTART,
  ): Promise<WasmEngine> {
    const instance = await WebAssembly.instantiate(module, {});
    const ex = instance.exports as unknown as KernelExports;
    const mem = ex.memory;
    const heapBase = ex.heap_mark();
    growTo(
      mem,
      heapBase +
        indexSize +
        F_CAP * 37 +
        C_CAP * 5 +
        PARSE_CACHE_BYTES +
        NSYM +
        IO_BYTES +
        16 * 16,
    );
    const idxPtr = ex.walloc(indexSize);
    loadIndex(new Uint8Array(mem.buffer, idxPtr, indexSize));
    const alphaPtr = ex.walloc(NSYM);
    new Uint8Array(mem.buffer, alphaPtr, NSYM).set(Uint8Array.from(ALPHABET));
    const ioPtr = ex.walloc(IO_BYTES);
    ex.setup(idxPtr, indexSize, alphaPtr, restart, F_CAP, C_CAP, ioPtr);
    return new WasmEngine(ex, ioPtr, ex.heap_mark(), total);
  }

  /** Reset per-query state and load the query's conjunct NFAs. */
  beginQuery(conjuncts: Nfa[]): void {
    const ex = this.ex;
    ex.heap_reset(this.queryHeapBase);

    const flats = conjuncts.map(flatten);
    // The kernel's subset-construction scratch is a fixed u32[65536] indexed
    // by NFA state; a conjunct NFA at or beyond that would overflow it (an
    // in-sandbox OOB write). Refuse and let the caller fall back to the JS
    // engine, which has no such fixed bound.
    for (const f of flats) {
      if (f.n >= 65536) throw new WasmCapacityError();
    }
    // Reserve every per-query allocation up front: walloc cannot grow the
    // memory itself (out-of-bounds writes would trap).
    let need = 64 * 1024;
    for (const f of flats) {
      need += (f.n + 1) * 4 + f.label.length + f.to.length * 4 + f.n + 4 * 16;
      need +=
        DFA_CAP * NSYM * 4 +
        DFA_CAP +
        (DFA_CAP + 1) * 4 +
        POOL_CAP * 4 +
        slotsFor(DFA_CAP) * 4 +
        Math.ceil(f.n / 32) * 4 +
        6 * 16;
    }
    need +=
      P_CAP * NSYM * 4 +
      P_CAP +
      P_CAP * flats.length * 4 +
      slotsFor(P_CAP) * 4 +
      4 * 16;
    try {
      growTo(ex.memory, this.queryHeapBase + need);
    } catch {
      throw new WasmCapacityError();
    }

    ex.begin_query(P_CAP);
    const mem = ex.memory;
    for (const f of flats) {
      const asPtr = ex.walloc((f.n + 1) * 4);
      new Uint32Array(mem.buffer, asPtr, f.n + 1).set(f.arcStart);
      const lbPtr = ex.walloc(f.label.length || 1);
      new Uint8Array(mem.buffer, lbPtr, f.label.length).set(f.label);
      const toPtr = ex.walloc(f.to.length * 4 || 4);
      new Uint32Array(mem.buffer, toPtr, f.to.length).set(f.to);
      const fnPtr = ex.walloc(f.n);
      new Uint8Array(mem.buffer, fnPtr, f.n).set(f.fin);
      if (
        !ex.add_conjunct(f.n, f.start, asPtr, lbPtr, toPtr, fnPtr, DFA_CAP, POOL_CAP)
      ) {
        throw new WasmCapacityError(); // more than MAX_CONJ conjuncts
      }
    }
    if (ex.seed(this.total) !== 0) throw new WasmCapacityError();
  }

  /** Run up to `budget` steps; result codes as in kernel.c's run(). */
  step(budget: number): { code: number; steps: number; score: number; text: string } {
    const code = this.ex.run(budget);
    // Views are created per call: memory.grow() detaches old buffers.
    const io = new DataView(this.ex.memory.buffer, this.ioPtr, 16);
    const steps = io.getUint32(0, true);
    let score = 0;
    let text = "";
    if (code === 1) {
      const len = io.getUint32(4, true);
      const bytes = new Uint8Array(this.ex.memory.buffer, this.ioPtr + 16, len);
      text = String.fromCharCode(...bytes);
      score = io.getFloat64(8, true);
    }
    return { code, steps, score, text };
  }
}

/** Drop-in replacement for SearchSession running on a WasmEngine. */
export class WasmSession {
  steps = 0;
  private readonly seen = new Set<string>();
  private exhausted = false;

  constructor(
    private readonly engine: WasmEngine,
    query: string,
    ctx: SessionContext,
  ) {
    // Same conjuncts as the JS engine (same ParseError contract), kept
    // unmaterialized for the kernel's lazy filters.
    engine.beginQuery(compileConjuncts(query, ctx).map((c) => trim(c)));
    engine.owner = this;
  }

  /** Same contract as SearchSession.run (resumable, streaming, yielding). */
  async run(
    maxSteps: number,
    maxResults: number,
    onResult: (r: SearchResult) => void,
    onProgress?: (steps: number) => void,
    shouldYield?: () => void | Promise<void>,
    // Only ever set in range mode, where the JS engine runs; the WASM engine
    // is used for fully-local indexes, so this is a no-op here in practice.
    shouldStop?: () => boolean,
  ): Promise<SessionStatus> {
    if (this.exhausted) return "exhausted";
    let results = 0;
    let lastYield = this.steps;
    let lastProgress = Math.floor(this.steps / 100000);
    while (this.steps < maxSteps && results < maxResults) {
      if (shouldStop && shouldStop()) return "limit";
      if (this.engine.owner !== this) {
        // The kernel was re-seeded for a newer query while this run was
        // parked at a yield; its state is gone. (The worker's cancellation
        // token silences this error.)
        throw new Error("search superseded");
      }
      const slice = Math.min(20000, maxSteps - this.steps);
      const r = this.engine.step(slice);
      this.steps += r.steps;
      if (r.code === 1) {
        // The kernel emits every accepting pop; dedup like the JS driver.
        if (!this.seen.has(r.text)) {
          this.seen.add(r.text);
          onResult({ score: r.score, text: r.text.replace(/ +$/, "") });
          ++results;
        }
      } else if (r.code === 2) {
        this.exhausted = true;
        return "exhausted";
      } else if (r.code === 3) {
        throw new WasmCapacityError();
      }
      if (Math.floor(this.steps / 100000) > lastProgress) {
        lastProgress = Math.floor(this.steps / 100000);
        onProgress?.(this.steps);
      }
      if (shouldYield && this.steps - lastYield >= 20000) {
        lastYield = this.steps;
        const y = shouldYield();
        if (y instanceof Promise) await y;
      }
    }
    return this.steps >= maxSteps ? "limit" : "results";
  }
}
