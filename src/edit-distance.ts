// Plain Levenshtein distance, shared by every "did you mean" in the app
// (construct-name typos in constructs.ts, list-name typos in word-lists.ts).
// A leaf module so the construct catalogue can use it without importing
// anything heavier.

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; ++i) {
    const row = [i + 1];
    for (let j = 0; j < b.length; ++j) {
      row.push(
        Math.min(prev[j + 1] + 1, row[j] + 1, prev[j] + (a[i] === b[j] ? 0 : 1)),
      );
    }
    prev = row;
  }
  return prev[b.length];
}
