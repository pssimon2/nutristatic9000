// The three caps on a run that is reading the index over the network.
//
// This logic used to live inside the worker's run function, where nothing
// could reach it — and it was wrong there in a way no test could have caught:
// the clock was read every 1,024 steps, which is far finer than seconds when
// steps are memory reads and far coarser when a step is a round trip. On the
// deployed index a stalled search stopped at exactly 1,024 steps, having spent
// 15 seconds and 49.8 MB getting to the first check.

import { describe, expect, it } from "vitest";
import { makeRunLimiter } from "../src/run-limiter.js";

/** A clock and a byte counter the test moves by hand. */
function harness(limits: {
  byteBudget?: number;
  timeMs?: number;
  stallMs?: number;
}) {
  let t = 1000;
  let bytes = 0;
  const limiter = makeRunLimiter(
    () => bytes,
    { byteBudget: 0, timeMs: 0, stallMs: 0, ...limits },
    () => t,
  );
  return {
    limiter,
    advance: (ms: number) => {
      t += ms;
    },
    fetch: (n: number) => {
      bytes += n;
    },
    /** Run `n` steps, returning true if the limiter stopped within them. */
    steps: (n: number) => {
      for (let i = 0; i < n; ++i) if (limiter!.shouldStop()) return true;
      return false;
    },
  };
}

describe("nothing to cap", () => {
  it("builds no limiter when every cap is off", () => {
    expect(makeRunLimiter(() => 0, { byteBudget: 0, timeMs: 0, stallMs: 0 }))
      .toBeNull();
  });
});

describe("the byte cap", () => {
  it("stops once the run has fetched its budget", () => {
    const h = harness({ byteBudget: 1000 });
    h.fetch(999);
    expect(h.steps(10)).toBe(false);
    h.fetch(1);
    // Checked every step, not on the clock tick: bytes are two field reads.
    expect(h.limiter!.shouldStop()).toBe(true);
  });

  it("counts only what this run fetched", () => {
    let bytes = 5000;
    const limiter = makeRunLimiter(
      () => bytes,
      { byteBudget: 1000, timeMs: 0, stallMs: 0 },
    );
    expect(limiter!.shouldStop()).toBe(false);
    bytes += 1000;
    expect(limiter!.shouldStop()).toBe(true);
  });
});

describe("the time cap", () => {
  it("stops once the run has taken its budget", () => {
    const h = harness({ timeMs: 5000 });
    h.advance(4999);
    expect(h.steps(200)).toBe(false);
    h.advance(1);
    expect(h.steps(200)).toBe(true);
  });
});

describe("the stall cap", () => {
  it("stops a run that never produced anything", () => {
    const h = harness({ stallMs: 6000 });
    h.advance(6000);
    expect(h.steps(200)).toBe(true);
  });

  it("leaves a run that keeps producing alone", () => {
    // The productive case this threshold was chosen for: results arriving
    // every few seconds, for far longer than the stall window.
    const h = harness({ stallMs: 6000 });
    for (let i = 0; i < 10; ++i) {
      h.advance(4000);
      expect(h.steps(200), `at ${i * 4}s`).toBe(false);
      h.limiter!.noteResult();
    }
  });

  it("stops once a producing run goes quiet", () => {
    const h = harness({ stallMs: 6000 });
    h.advance(4000);
    h.limiter!.noteResult();
    h.advance(5999);
    expect(h.steps(200)).toBe(false);
    h.advance(1);
    expect(h.steps(200)).toBe(true);
  });

  it("measures from the last result, not from the start", () => {
    const h = harness({ stallMs: 6000 });
    // Well past the stall window in absolute terms, but producing throughout.
    for (let i = 0; i < 5; ++i) {
      h.advance(5000);
      h.limiter!.noteResult();
    }
    expect(h.steps(200)).toBe(false);
  });
});

describe("how often the clock is read", () => {
  it("reads it often enough for a step that is a round trip", () => {
    // The bug this file exists for. A search fetching tens of kilobytes per
    // step does only a handful of steps a second, so a cap consulted every
    // 1,024 steps cannot fire for many seconds — which is exactly what
    // happened on the deployed index. Sixty-four steps of a round trip each
    // is still a wait, but it is the difference between 7 seconds and 15.
    const h = harness({ stallMs: 6000 });
    h.advance(6000);
    let stoppedAt = -1;
    for (let i = 1; i <= 1000; ++i) {
      if (h.limiter!.shouldStop()) {
        stoppedAt = i;
        break;
      }
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThanOrEqual(64);
  });

  it("does not read it every step", () => {
    // The other half: an in-memory search does millions of steps a second,
    // and this is consulted on every one of them.
    let reads = 0;
    const limiter = makeRunLimiter(
      () => 0,
      { byteBudget: 0, timeMs: 10_000, stallMs: 0 },
      () => {
        ++reads;
        return 1000;
      },
    );
    reads = 0; // the constructor reads it once, for the start time
    for (let i = 0; i < 640; ++i) limiter!.shouldStop();
    expect(reads).toBe(10);
  });
});
