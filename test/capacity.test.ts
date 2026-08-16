// Running out of automaton is a budget, not a failure.
//
// The lazy DFA is capped at 500,000 states. `{distinct:A{6}}` — an example the
// docs offer — has on the order of 300,000 reachable states, one per
// set-of-letters-seen-so-far, and a long enough search really does exhaust the
// cap: about 7.8 million steps against the demo index. What happened then was
// a thrown Error, which the worker turned into `post({type: "error"})`: the
// search was reported as failed even though every result already on screen was
// correct, and "try harder" would rebuild to the same wall and fail again.
//
// So the cap now ends the run the way the step budget does, with a status.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import {
  Filter,
  FilterCapacityError,
  MAX_STATES,
} from "../src/expr-filter.js";
import { compileQuery } from "../src/find-expr.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();
const data = fs.readFileSync("web/public/demo.index");
const reader = await IndexReader.open(new MemorySource(data));

/**
 * A real filter that runs out of states after `budget` transitions — what the
 * lazy DFA does at 500,000, reached in a test rather than in eight million
 * steps.
 */
class Exhaustible implements Filter {
  private left: number;
  constructor(
    private readonly inner: Filter,
    budget: number,
  ) {
    this.left = budget;
  }
  get startState(): number {
    return this.inner.startState;
  }
  get stateCount(): number {
    return this.inner.stateCount;
  }
  isAccepting(s: number): boolean {
    return this.inner.isAccepting(s);
  }
  transition(s: number, ch: number): number {
    if (--this.left < 0) throw new FilterCapacityError(MAX_STATES);
    return this.inner.transition(s, ch);
  }
}

const session = (budget: number) =>
  new SearchSession(reader, new Exhaustible(compileQuery("A*", ctx), budget), ctx);

describe("when the lazy DFA fills up", () => {
  it("reports it as a status rather than throwing", async () => {
    const s = session(5000);
    const status = await s.run(1e9, 1e9, () => {});
    expect(status).toBe("complex");
  });

  it("keeps every result found before the wall", async () => {
    const out: string[] = [];
    const s = session(20000);
    await s.run(1e9, 1e9, (r) => out.push(r.text));
    expect(out.length).toBeGreaterThan(0);
    // Correct results, not truncated garbage: the automaton was right up to
    // the state it could not build.
    for (const w of out) expect(w).toMatch(/^[a-z0-9 ]+$/);
  });

  it("says so again immediately instead of rebuilding to the same wall", async () => {
    const s = session(5000);
    await s.run(1e9, 1e9, () => {});
    const before = s.steps;
    // This is the "try harder" click. It must not spend the budget again.
    const status = await s.run(1e9, 1e9, () => {});
    expect(status).toBe("complex");
    expect(s.steps).toBe(before);
  });

  it("still throws anything that is not a capacity limit", async () => {
    const boom = new (class implements Filter {
      readonly startState = 0;
      readonly stateCount = 1;
      isAccepting(): boolean {
        return false;
      }
      transition(): number {
        throw new RangeError("something else went wrong");
      }
    })();
    const s = new SearchSession(reader, boom, ctx);
    await expect(s.run(1e9, 1e9, () => {})).rejects.toThrow(RangeError);
  });
});

describe("a search that does not fill it", () => {
  it("still reports the ordinary statuses", async () => {
    const s = new SearchSession(reader, "solar s_stem", ctx);
    const status = await s.run(1e6, 1e6, () => {});
    expect(["exhausted", "limit", "results"]).toContain(status);
  });
});
