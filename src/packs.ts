// Declarative construct packs (F4): table-driven constructs as JSON, loaded
// per session — a custom keyboard layout, a variant tile-value table, a
// cipher — without writing code.
//
// Most of the built-in constructs are already tables with a name on them:
// `{row1:…}` is a letter set, `{scrabble>25:…}` is a value table, `{atbash:…}`
// is a substitution. A pack declares more of the same:
//
//   {
//     "name": "dvorak",
//     "constructs": [
//       { "name": "dvorakrow1", "type": "letter-class",
//         "summary": "top Dvorak row", "letters": "pyfgcrl" },
//       { "name": "points", "type": "value-table",
//         "summary": "house tile values", "values": { "a": 5, "b": 2 } },
//       { "name": "swap", "type": "substitution",
//         "summary": "a toy cipher", "map": { "a": "z", "z": "a" } }
//     ]
//   }
//
// Semantics mirror the built-ins they generalize:
//   letter-class  — wraps a pattern; only these letters may appear:
//                   {dvorakrow1:A{5}}
//   value-table   — wraps a pattern; letter values must total the spec's
//                   comparison ({points=20:A*}, {points>9:…}, {points 5..9:…});
//                   unlisted letters count 0
//   substitution  — takes literal text; matches its image under the map
//                   ({swap:xyz} matches what xyz deciphers to; unmapped
//                   characters pass through)
//
// A pack may not shadow a built-in name: `{sum…}` meaning something else per
// session is exactly the confusion the one-catalogue rule exists to prevent.

import { Nfa } from "./automata.js";
import { CONSTRUCT_NAMES } from "./constructs.js";
import { SessionContext } from "./session-context.js";
import {
  type ValueRange,
  MAX_COUNTER_STATES,
  literalWordNfa,
  packAlphabetNfa,
  parseValueRange,
  valueNfa,
} from "./value-constraint.js";

export type PackConstruct =
  | { name: string; summary: string; type: "letter-class"; letters: number[] }
  | { name: string; summary: string; type: "value-table"; table: number[] }
  | {
      name: string;
      summary: string;
      type: "substitution";
      map: Map<number, string>;
    };

export interface ConstructPack {
  name: string;
  constructs: PackConstruct[];
}

const NAME = /^[a-z][a-z0-9]*$/;
const A = "a".charCodeAt(0);
const Z = "z".charCodeAt(0);

/**
 * Parse a fetched pack. Throws with a reason a pack author can act on —
 * unlike the manifest, junk here is someone's work-in-progress, not noise.
 */
export function parsePack(json: unknown): ConstructPack {
  if (typeof json !== "object" || json === null) {
    throw new Error("a pack is a JSON object with a name and constructs");
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) {
    throw new Error('a pack needs a short lower-case "name"');
  }
  if (!Array.isArray(raw.constructs) || raw.constructs.length === 0) {
    throw new Error(`pack "${raw.name}" declares no constructs`);
  }
  const out: PackConstruct[] = [];
  for (const c of raw.constructs) {
    out.push(parseConstruct(c));
  }
  return { name: raw.name, constructs: out };
}

function parseConstruct(json: unknown): PackConstruct {
  const raw = (json ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new Error(`a construct needs a short lower-case "name", got ${JSON.stringify(raw.name)}`);
  }
  if (CONSTRUCT_NAMES.includes(name)) {
    throw new Error(`"${name}" is a built-in construct — a pack cannot shadow it`);
  }
  const summary =
    typeof raw.summary === "string" && raw.summary !== ""
      ? raw.summary
      : `from a construct pack`;
  switch (raw.type) {
    case "letter-class": {
      if (typeof raw.letters !== "string" || raw.letters === "") {
        throw new Error(`"${name}" (letter-class) needs "letters"`);
      }
      const letters: number[] = [];
      for (const ch of raw.letters.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (!((c >= A && c <= Z) || (c >= 0x30 && c <= 0x39))) {
          throw new Error(`"${name}": letters must be a-z or digits, got "${ch}"`);
        }
        letters.push(c);
      }
      return { name, summary, type: "letter-class", letters };
    }
    case "value-table": {
      if (typeof raw.values !== "object" || raw.values === null) {
        throw new Error(`"${name}" (value-table) needs "values" mapping letters to numbers`);
      }
      const table = new Array<number>(128).fill(0);
      for (const [k, v] of Object.entries(raw.values as Record<string, unknown>)) {
        const c = k.toLowerCase().charCodeAt(0);
        if (k.length !== 1 || !(c >= A && c <= Z) || typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          throw new Error(`"${name}": values are single letters to non-negative integers, got ${JSON.stringify(k)}`);
        }
        table[c] = v;
      }
      return { name, summary, type: "value-table", table };
    }
    case "substitution": {
      if (typeof raw.map !== "object" || raw.map === null) {
        throw new Error(`"${name}" (substitution) needs "map" from letters to text`);
      }
      const map = new Map<number, string>();
      for (const [k, v] of Object.entries(raw.map as Record<string, unknown>)) {
        const c = k.toLowerCase().charCodeAt(0);
        if (k.length !== 1 || !(c >= A && c <= Z) || typeof v !== "string") {
          throw new Error(`"${name}": map keys are single letters, values text, got ${JSON.stringify(k)}`);
        }
        map.set(c, v.toLowerCase());
      }
      return { name, summary, type: "substitution", map };
    }
    default:
      throw new Error(
        `"${name}": type must be "letter-class", "value-table" or "substitution"`,
      );
  }
}

/** Install a parsed pack on the session; later packs win name collisions. */
export function installPack(ctx: SessionContext, pack: ConstructPack): void {
  for (const c of pack.constructs) {
    ctx.packs.set(c.name, c);
  }
}

/**
 * Compile one use of a pack construct: conjuncts to intersect (letter-class
 * and value-table wrap the pattern that follows; substitution consumed its
 * literal argument). Null when the spec/argument does not parse, so the
 * caller reports it the same way it reports a built-in's.
 */
export function packConjuncts(
  construct: PackConstruct,
  spec: string,
  arg: string,
): Nfa[] | null {
  switch (construct.type) {
    case "letter-class":
      return spec.trim() === "" ? [packAlphabetNfa(construct.letters)] : null;
    case "value-table": {
      const range: ValueRange | null = parseValueRange(spec);
      if (!range) return null;
      const built = valueNfa(construct.table, range);
      return built ? [built] : null;
    }
    case "substitution": {
      if (spec.trim() !== "") return null;
      let plain = "";
      for (const ch of arg.toLowerCase()) {
        plain += construct.map.get(ch.charCodeAt(0)) ?? ch;
      }
      const built = literalWordNfa(plain.trim());
      return built ? [built] : null;
    }
  }
}

/** The advice when a pack construct's spec or argument does not parse. */
export function packAdvice(construct: PackConstruct): string {
  switch (construct.type) {
    case "letter-class":
      return `{${construct.name}:…} wraps a pattern and takes no spec — try {${construct.name}:A{5}}`;
    case "value-table":
      return (
        `{${construct.name}…} takes a comparison up to ${MAX_COUNTER_STATES - 1} ` +
        `— try {${construct.name}=20:A*} or {${construct.name} 5..9:A*}`
      );
    case "substitution":
      return `{${construct.name}:…} takes literal text to decode`;
  }
}
