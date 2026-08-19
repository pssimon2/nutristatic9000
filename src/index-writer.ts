// Port of Nutrimatic index-writer.cpp. Emits the exact same bytes as the C++
// writer for the same input sequence, so indexes are interchangeable.
//
// next(text, same, count) must be called with strings in sorted order; `same`
// is a lower bound on the shared prefix length with the previous call (the
// writer extends it itself). Finish with next(null, 0, 0).

export interface ByteSink {
  put(b: number): void;
}

export class BufferSink implements ByteSink {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  put(b: number): void {
    if (this.len === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = b & 0xff;
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

const NONE = -1;

interface Saved {
  ch: number;
  count: number;
  pos: number; // end offset of the child node, or NONE
}

interface Pending {
  ch: number;
  count: number;
  choices: Saved[];
}

export class IndexWriter {
  private readonly chain: Pending[] = [{ ch: 0, count: 0, choices: [] }];
  private chainSize = 1;
  private pos = 0;

  constructor(private readonly sink: ByteSink) {}

  next(text: string | null, same: number, count: number): void {
    if (text === null ? !(count === 0 && same === 0) : !(count > 0)) {
      throw new Error("bad next() arguments");
    }

    while (
      text !== null &&
      same + 1 < this.chainSize &&
      text.charCodeAt(same) === this.chain[same + 1].ch
    ) {
      ++same;
    }

    while (this.chainSize - 1 > same) {
      const pending = this.chain[--this.chainSize];
      const parent = this.chain[this.chainSize - 1];
      parent.choices.push(this.write(pending));
      pending.choices = [];
    }

    while (text !== null && this.chainSize - 1 < text.length) {
      if (++this.chainSize > this.chain.length) {
        this.chain.push({ ch: 0, count: 0, choices: [] });
      }
      const node = this.chain[this.chainSize - 1];
      node.ch = text.charCodeAt(this.chainSize - 2);
      node.count = 0;
    }

    this.chain[this.chainSize - 1].count += count;

    if (text === null) {
      this.write(this.chain[0]);
      this.chain.length = 0;
    }
  }

  /** Write `value` (or NONE as all-ones) as `n` little-endian bytes. */
  private putLE(value: number, n: number): void {
    if (value === NONE) {
      for (let j = 0; j < n; ++j) this.sink.put(0xff);
      return;
    }
    for (let j = 0; j < n; ++j) {
      this.sink.put(Math.floor(value / 2 ** (j * 8)) & 0xff);
    }
  }

  private write(pending: Pending): Saved {
    const out: Saved = { ch: pending.ch, count: pending.count, pos: NONE };
    const choices = pending.choices;

    if (choices.length === 0) {
      if (!(out.count > 0)) throw new Error("empty leaf");
      return out;
    }

    if (
      choices.length === 1 &&
      pending.count === 0 &&
      choices[0].ch >= 0x20 &&
      choices[0].ch < 0x80 &&
      choices[0].pos === this.pos
    ) {
      this.sink.put(choices[0].ch);
      out.pos = ++this.pos;
      out.count = choices[0].count;
      return out;
    }

    let maxCount = 0;
    let maxOffset = 0;
    for (let i = 0; i < choices.length; ++i) {
      if (i > 0 && !(choices[i].ch > choices[i - 1].ch)) {
        throw new Error("choices out of order");
      }
      if (!(choices[i].count > 0)) throw new Error("bad choice count");
      out.count += choices[i].count;
      maxCount = Math.max(maxCount, choices[i].count);
      if (choices[i].pos !== NONE) {
        maxOffset = Math.max(maxOffset, Math.max(this.pos - choices[i].pos, 1));
      }
    }

    let mode: number;
    if (maxOffset === 0 && maxCount < 0x100) {
      mode = 0;
      for (const c of choices) {
        this.sink.put(c.ch);
        this.sink.put(c.count);
      }
      this.pos += 2 * choices.length;
    } else if (maxOffset < 0xff && maxCount < 0x100) {
      mode = 0x80;
      for (const c of choices) {
        this.sink.put(c.ch);
        this.sink.put(c.count);
        this.putLE(c.pos === NONE ? NONE : this.pos - c.pos, 1);
      }
      this.pos += 3 * choices.length;
    } else if (maxOffset < 0xffff && maxCount < 0x100) {
      mode = 0xa0;
      for (const c of choices) {
        this.sink.put(c.ch);
        this.sink.put(c.count);
        this.putLE(c.pos === NONE ? NONE : this.pos - c.pos, 2);
      }
      this.pos += 4 * choices.length;
    } else if (maxOffset < 0xffff && maxCount < 0x10000) {
      mode = 0xc0;
      for (const c of choices) {
        this.sink.put(c.ch);
        this.putLE(c.count, 2);
        this.putLE(c.pos === NONE ? NONE : this.pos - c.pos, 2);
      }
      this.pos += 5 * choices.length;
    } else {
      mode = 0xe0;
      for (const c of choices) {
        this.sink.put(c.ch);
        this.putLE(c.count, 8);
        this.putLE(c.pos === NONE ? NONE : this.pos - c.pos, 8);
      }
      this.pos += 17 * choices.length;
    }

    // >= not >: a count byte of exactly 0x100 would wrap to 0, which the
    // reader parses as "count follows" (Nutrimatic's assert shares the
    // off-by-one; the format truly maxes out at 255 children).
    if (choices.length >= 0x100) throw new Error("too many choices");
    if (choices.length < 0x20) {
      this.sink.put(choices.length + mode);
      this.pos += 1;
    } else {
      this.sink.put(choices.length);
      this.sink.put(mode);
      this.pos += 2;
    }

    out.pos = this.pos;
    if (!(out.count > 0)) throw new Error("bad node count");
    return out;
  }
}

/**
 * Write a batch of (string, count) entries. Entries are sorted and identical
 * strings merged by the writer's accumulation, matching Nutrimatic make-index.
 */
export function writeEntries(
  writer: IndexWriter,
  entries: Array<[string, number]>,
  finish = true,
): void {
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let prev = "";
  for (let i = 0; i < entries.length; ++i) {
    const [text, count] = entries[i];
    let same = 0;
    if (i > 0) {
      const len = Math.min(prev.length, text.length);
      while (same < len && prev.charCodeAt(same) === text.charCodeAt(same)) {
        ++same;
      }
    }
    writer.next(text, same, count);
    prev = text;
  }
  if (finish) writer.next(null, 0, 0);
}
