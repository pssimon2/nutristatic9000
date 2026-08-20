import { describe, expect, it } from "vitest";
import {
  ALPHABET,
  CHAR_TO_SYM,
  Dfa,
  EPSILON,
  NSYM,
  Nfa,
  determinize,
  intersectExprs,
  equivalent,
  minimize,
} from "../src/automata.js";

function acceptsDfa(dfa: Dfa, s: string): boolean {
  if (dfa.start === -1) return false;
  let state = dfa.start;
  for (let i = 0; i < s.length; ++i) {
    const sym = CHAR_TO_SYM[s.charCodeAt(i)];
    if (sym === -1) return false;
    state = dfa.trans[state * NSYM + sym];
    if (state === -1) return false;
  }
  return dfa.accepting[state] !== 0;
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNfa(rand: () => number): Nfa {
  const nfa = new Nfa();
  const nStates = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < nStates; ++i) nfa.addState();
  nfa.setStart(0);
  const labels = [EPSILON, 0x61, 0x62, 0x63]; // epsilon, a, b, c
  const nArcs = Math.floor(rand() * 14);
  for (let i = 0; i < nArcs; ++i) {
    nfa.addArc(
      Math.floor(rand() * nStates),
      labels[Math.floor(rand() * labels.length)],
      Math.floor(rand() * nStates),
    );
  }
  const nFinals = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < nFinals; ++i) nfa.setFinal(Math.floor(rand() * nStates));
  return nfa;
}

function* allStrings(chars: string, maxLen: number): Generator<string> {
  const queue = [""];
  while (queue.length > 0) {
    const s = queue.shift()!;
    yield s;
    if (s.length < maxLen) {
      for (const c of chars) queue.push(s + c);
    }
  }
}

describe("lazy ExprFilter", () => {
  it("accepts exactly the language of the eagerly minimized DFA", async () => {
    const { ExprFilter } = await import("../src/expr-filter.js");
    const rand = mulberry32(999);
    for (let round = 0; round < 200; ++round) {
      const nfa = randomNfa(rand);
      const eager = minimize(determinize(nfa));
      const filter = new ExprFilter(nfa);
      for (const s of allStrings("abc", 5)) {
        let state: number = filter.startState;
        for (let i = 0; i < s.length && state >= 0; ++i) {
          state = filter.transition(state, s.charCodeAt(i));
        }
        const got = state >= 0 && filter.isAccepting(state);
        expect(got, `round ${round}, string "${s}"`).toBe(acceptsDfa(eager, s));
      }
    }
  });
});

describe("minimize (Hopcroft)", () => {
  it("preserves the language of random NFAs", () => {
    const rand = mulberry32(12345);
    for (let round = 0; round < 300; ++round) {
      const nfa = randomNfa(rand);
      const full = determinize(nfa);
      const min = minimize(full);
      for (const s of allStrings("abc", 5)) {
        const want = acceptsDfa(full, s);
        const got = acceptsDfa(min, s);
        expect(got, `round ${round}, string "${s}"`).toBe(want);
      }
      // Minimizing again must be a no-op (canonical fixed point).
      const twice = minimize(min);
      expect(twice.start).toBe(min.start);
      expect([...twice.accepting]).toEqual([...min.accepting]);
      expect([...twice.trans]).toEqual([...min.trans]);
    }
  });

  it("returns EMPTY_DFA when no accepting state is reachable", () => {
    const nfa = new Nfa();
    const a = nfa.addState();
    const b = nfa.addState();
    nfa.setStart(a);
    nfa.addArc(a, 0x61, b); // 'a' arc but no finals
    expect(minimize(determinize(nfa)).start).toBe(-1);
  });

  it("trims states that cannot reach acceptance", () => {
    const nfa = new Nfa();
    const a = nfa.addState();
    const b = nfa.addState();
    const trap = nfa.addState();
    nfa.setStart(a);
    nfa.setFinal(b);
    nfa.addArc(a, 0x61, b);
    nfa.addArc(a, 0x62, trap);
    nfa.addArc(trap, 0x62, trap);
    const min = minimize(determinize(nfa));
    expect(min.accepting.length).toBe(2); // start + accept, trap gone
  });

  it("keeps equivalence working across different constructions", () => {
    // a|b built two different ways
    const x = new Nfa();
    const x0 = x.addState();
    const x1 = x.addState();
    x.setStart(x0);
    x.setFinal(x1);
    x.addArc(x0, 0x61, x1);
    x.addArc(x0, 0x62, x1);

    const y1 = new Nfa();
    const a0 = y1.addState();
    const a1 = y1.addState();
    y1.setStart(a0);
    y1.setFinal(a1);
    y1.addArc(a0, 0x61, a1);
    const y2 = new Nfa();
    const b0 = y2.addState();
    const b1 = y2.addState();
    y2.setStart(b0);
    y2.setFinal(b1);
    y2.addArc(b0, 0x62, b1);
    y1.union(y2);

    expect(equivalent(x, y1)).toBe(true);
    expect(ALPHABET.length).toBe(NSYM);
  });

  it("intersects an empty conjunct list to the empty language", () => {
    const out = new Nfa();
    intersectExprs([], out);
    expect(out.start).toBe(-1);
  });

  it("rejects an out-of-alphabet arc label in determinize", () => {
    const nfa = new Nfa();
    const s = nfa.addState();
    nfa.setStart(s);
    nfa.setFinal(s);
    nfa.addArc(s, 255, s);
    expect(() => determinize(nfa)).toThrow(/bad label/);
  });
});
