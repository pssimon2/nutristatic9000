// Port of the text-windowing logic from Nutrimatic make-index.cpp: normalize
// text to lowercase alphanumerics and spaces (apostrophes vanish entirely),
// then emit sliding windows of up to 40 characters, one starting at each word
// boundary. Feeding these windows into IndexWriter with count 1 builds the
// phrase-frequency trie.
//
// Known (accepted) divergences from Nutrimatic's fgets-based reader: lines
// longer than 64KB are windowed continuously here where Nutrimatic restarts at
// each 64KB buffer boundary; a final unterminated line still gets the
// synthetic separator; and readline splits on lone \r. All only affect
// pathological corpus lines, not the Wikipedia pipeline output.

export const HISTORY_WINDOW_SIZE = 40;

function isAlnum(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) // a-z
  );
}

function toLower(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

function flushBuffer(buf: number[], out: string[]): void {
  out.push(String.fromCharCode(...buf));
  const space = buf.indexOf(0x20);
  // Drop everything through the first space (or the whole buffer if none).
  buf.splice(0, space === -1 ? buf.length : space + 1);
}

/**
 * Append the chain windows for one line of raw text to `out`. The line's
 * terminating newline acts as a separator (Nutrimatic processes it via fgets),
 * so windows generally end with a trailing space.
 */
export function lineChains(line: string, out: string[]): void {
  const buf: number[] = [];
  for (let i = 0; i <= line.length; ++i) {
    if (buf.length === HISTORY_WINDOW_SIZE) flushBuffer(buf, out);
    const c = i === line.length ? 0x0a : line.charCodeAt(i);
    if (isAlnum(c)) {
      buf.push(toLower(c));
    } else if (c !== 0x27 /* ' */ && buf.length > 0 && buf[buf.length - 1] !== 0x20) {
      buf.push(0x20);
    }
  }
  while (buf.length > 0) flushBuffer(buf, out);
}
