// The acceptance test for SessionContext: side data belongs to the caller's
// context, not to the module that parses it. Two contexts holding different
// data must produce different compilations in the same process, and a context
// with nothing loaded must report that rather than silently borrowing another
// context's data — the failure mode the old `let loaded` singletons had.

import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";
import { SearchSession } from "../src/search-session.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseStress } from "../src/stress.js";
import { SessionContext } from "../src/session-context.js";

/** Does `text` match the language `pattern` compiles to under `ctx`? */
function matches(pattern: string, text: string, ctx: SessionContext): boolean {
  const filter = compileQuery(pattern, ctx);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

async function readerOver(entries: Array<[string, number]>) {
  const sink = new BufferSink();
  writeEntries(new IndexWriter(sink), entries);
  return IndexReader.open(new MemorySource(sink.bytes()));
}

describe("SessionContext", () => {
  it("compiles the same query differently under different data", () => {
    const a = new SessionContext();
    a.phonetics = parsePhonetics("R cat bat\nH cat kat\n");
    const b = new SessionContext();
    b.phonetics = parsePhonetics("R cat mat\nH cat qat\n");

    expect(matches("{rhyme:cat}", "bat", a)).toBe(true);
    expect(matches("{rhyme:cat}", "mat", a)).toBe(false);
    expect(matches("{rhyme:cat}", "mat", b)).toBe(true);
    expect(matches("{rhyme:cat}", "bat", b)).toBe(false);
  });

  it("keeps an unloaded context unloaded, whatever its neighbours hold", () => {
    const loaded = new SessionContext();
    loaded.phonetics = parsePhonetics("R cat bat\n");
    const empty = new SessionContext();

    // Compiling against the loaded context first is exactly the load-order
    // hazard the singletons had: it must not leak into `empty`.
    expect(matches("{rhyme:cat}", "bat", loaded)).toBe(true);
    expect(() => compileQuery("{rhyme:cat}", empty)).toThrow(ParseError);
    expect(() => compileQuery("{rhyme:cat}", empty)).toThrow(
      /pronunciation dictionary/,
    );
  });

  it("reports a word the context's own data lacks", () => {
    const ctx = new SessionContext();
    ctx.phonetics = parsePhonetics("R cat bat\n");
    expect(() => compileQuery("{rhyme:zzzqq}", ctx)).toThrow(
      /doesn't know "zzzqq"/,
    );
  });

  it("runs two sessions with different data over one index at once", async () => {
    const reader = await readerOver([
      ["bat ", 10],
      ["mat ", 10],
      ["cat ", 10],
    ]);

    const a = new SessionContext();
    a.phonetics = parsePhonetics("R cat bat\n");
    const b = new SessionContext();
    b.phonetics = parsePhonetics("R cat mat\n");

    // Interleaved, not sequential: both sessions are live at the same time,
    // so a shared singleton would show up as one of them seeing the other's
    // rhyme set.
    const sa = new SearchSession(reader, "{rhyme:cat}", a);
    const sb = new SearchSession(reader, "{rhyme:cat}", b);
    const ra: string[] = [];
    const rb: string[] = [];
    await sa.run(10000, 10, (r) => ra.push(r.text));
    await sb.run(10000, 10, (r) => rb.push(r.text));

    expect(ra.sort()).toEqual(["bat", "cat"]);
    expect(rb.sort()).toEqual(["cat", "mat"]);
  });

  it("holds each dataset independently", () => {
    const ctx = new SessionContext();
    expect(ctx.stress).toBeNull();
    ctx.stress = parseStress("cat 1\n");
    expect(ctx.stress).not.toBeNull();
    // Loading one dataset says nothing about the others.
    expect(ctx.phonetics).toBeNull();
    expect(ctx.categories).toBeNull();
    expect(ctx.neighbours).toBeNull();
    expect(ctx.thesaurus).toBeNull();
  });
});
