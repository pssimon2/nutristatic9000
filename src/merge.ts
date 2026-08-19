// Port of Nutrimatic merge-indexes.cpp: k-way merge of sorted index walkers
// through a frequency-cutoff filter into a new index. Strings below the
// cutoff have their counts folded into their parent word-boundary prefix
// (so the prefix totals stay right even when rare phrases are dropped).

import { IndexWalker } from "./index-walker.js";
import { IndexWriter } from "./index-writer.js";

export class FrequencyCutoffWriter {
  private saved = "";
  private outputSame = 0;
  // Stack of word-boundary positions in `saved` with accumulated counts.
  private readonly words: Array<{ pos: number; count: number }> = [
    { pos: 0, count: 0 },
  ];

  constructor(
    private readonly output: IndexWriter,
    private readonly cutoff: number,
  ) {}

  next(text: string | null, same: number, count: number): void {
    if (text !== null) {
      while (
        same < this.saved.length &&
        text.charCodeAt(same) === this.saved.charCodeAt(same)
      ) {
        ++same;
      }
    }

    while (this.words[this.words.length - 1].pos > same) {
      const lastWord = this.words.pop()!;
      this.saved = this.saved.slice(0, lastWord.pos);
      this.outputSame = Math.min(this.outputSame, this.saved.length);
      if (
        lastWord.count >= this.cutoff ||
        (lastWord.count > 0 && this.outputSame === lastWord.pos)
      ) {
        this.output.next(this.saved, this.outputSame, lastWord.count);
        this.outputSame = this.words[this.words.length - 1].pos;
      } else {
        this.words[this.words.length - 1].count += lastWord.count;
        this.outputSame = Math.min(
          this.outputSame,
          this.words[this.words.length - 1].pos,
        );
      }
    }

    this.saved = this.saved.slice(0, same);
    if (text !== null) {
      this.saved += text.slice(same);
      let space = text.indexOf(" ", same);
      while (space !== -1) {
        this.words.push({ pos: space + 1, count: 0 });
        space = text.indexOf(" ", space + 1);
      }
    }

    this.words[this.words.length - 1].count += count;
    if (text === null) this.output.next(null, 0, 0);
  }
}

/** Merge already-open walkers (sorted streams) into `output` with a cutoff. */
export async function mergeWalkers(
  walkers: IndexWalker[],
  cutoff: number,
  output: IndexWriter,
): Promise<void> {
  const writer = new FrequencyCutoffWriter(output, cutoff);
  const heap = walkers.filter((w) => w.text !== null);
  const less = (a: IndexWalker, b: IndexWalker) => a.text! < b.text!;
  const sift = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  };
  for (let i = (heap.length >> 1) - 1; i >= 0; --i) sift(i);

  while (heap.length > 0) {
    const top = heap[0];
    writer.next(top.text, top.same, top.count);
    await top.next();
    if (top.text === null) {
      heap[0] = heap[heap.length - 1];
      heap.pop();
    }
    if (heap.length > 0) sift(0);
  }

  writer.next(null, 0, 0);
}
