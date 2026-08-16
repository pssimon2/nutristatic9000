# Nutristatic 9000

**A fork of [Nutristatic](https://github.com/pssimon2/nutristatic) where new
features are developed.** It is deployed alongside the original at
**[nutristatic.org/9000/](https://nutristatic.org/9000/)** and shares the index
files served from the site root, so no index data is duplicated. The two
projects are developed independently: separate repositories, separate
dependencies, separate dev/preview ports (`npm run dev` → 5174,
`npm run preview` → 4318).

Deployment notes specific to this fork:

- Vite's `base` is relative (`"./"`), so the built app runs from any path;
  the service worker derives its scope from its own URL and precaches
  relative paths.
- The index picker points at root-absolute index URLs (`/de-wiki.index`, …)
  because those files are served from the site root; only `demo.index` ships
  with the app.
- Deploy target is `/srv/nutristatic9000` on the web host, served by Caddy
  under `handle_path /9000/*`.

## Added so far

| Feature | Syntax | Notes |
|---|---|---|
| Repeated-phrase folding | *(none)* | Collapses overlapping index windows of one phrase; a link restores them |
| Output extraction | `{at 3:expr}` | Shows the Nth letter of each match (negative counts from the end; lists allowed) |
| Rank windows | `{rank 200-2000:expr}` | Reaches mid-frequency answers without scrolling |
| Letter-value arithmetic | `{sum=100:expr}`, `{scrabble>25:expr}` | A1Z26 or tile values; `=`, `<`, `<=`, `>`, `>=`, `a..b`; prunes the search |
| Letter banks / sub-anagrams | `<<washington>>`, `{bank:…}`, `{sub:cryptography}` | Per-letter bounds plus an alphabet restriction |
| Structural / keyboard classes | `{roman:…}`, `{rot180:…}`, `{mirror:…}`, `{sevenseg:…}`, `{row1:…}`, `{holes=0:…}`, `{ascending:…}`, `{descending:…}` | Letter-set restrictions and monotone chains |
| Encodings | `{t9:2665}`, `{enum:4,3,5}`, `{morse:...-...}`, `{elements:…}` | Keypad digits → every spelling; crossword enumerations |
| Negation | `!expr` | Complement via determinize + completed DFA; capped at 5000 states |
| Corpus self-reference | `{compound 2:A{9}}` | Match must cut into N indexed words; the split is shown. Verified in the worker against the index |
| Palindromes / reversals | `{palindrome:…}`, `{reversible:…}` | Result filters, so no 26^(n/2) automaton and no reverse index |
| Named category lists | `{list:greek}`, `{list:nato}`, … | Alternation of curated entries; composes (`.*{list:nato}.*`) |
| Ciphers | `{caesar:kdhv}`, `{rot13:…}`, `{caesar+5:…}`, `{atbash:…}` | Desugars to an alternation of literals; the UI reports the matched shift |
| Edit distance | `{del1:beast}`, `{add1:…}`, `{subst1:…}`, `{edit<=2:…}` | Levenshtein automaton over a literal word; letters/digits only, never spaces |
| Occurrence / multiset | `{count(e)=2:expr}`, `{distinct:expr}`, `{maxrep=2:expr}`, `{all(aeiou):expr}`, `{letters=11:expr}`, `{words=3:expr}` | Same counter machinery; multiset forms decompose into one small automaton per letter |

`{at …}` and `{rank …}` are output wrappers stripped before the engine runs.
`{sum …}` / `{scrabble …}` compile to conjunct NFAs, so the WASM kernel runs
them with no C-side work — locked in by a parity test.

Everything below describes the engine, which is unchanged from upstream.

---

A rewrite of [Nutrimatic](https://nutrimatic.org/) ([upstream
source](https://github.com/PuzzleTechHub/nutrimatic)) that runs with **no
server-side code**, deployed at [nutristatic.org](https://nutristatic.org/).
The user-facing "what is this and how does it differ from Nutrimatic"
documentation lives in the site's
[usage guide](https://nutristatic.org/usage.html); this README covers the
implementation. The pattern engine is TypeScript running in a Web Worker
in the visitor's browser; the phrase-frequency index is a plain static file.
(A WebAssembly port of the engine — `wasm-kernel/kernel.c` driven by
`src/wasm-session.ts` — takes over automatically for fully-local indexes,
worth ~1.6x on heavy anagrams; the JS engine remains the reference
implementation, the fallback, and the range-mode engine.)
Deploy the built site to any static host (GitHub Pages, S3, nginx `root`,
`python -m http.server`, …) and it works.

The index file format is **byte-compatible with upstream**: indexes built by
the original C++ tools work here, and indexes built by these TypeScript tools
work with the C++ binaries (verified byte-for-byte in CI tests).

## How it works

- `src/` — the engine, a faithful port of upstream's C++:
  - `index-reader.ts` / `index-writer.ts` / `index-walker.ts` — the trie
    index format (nodes written children-first; the root is the end of the
    file).
  - `automata.ts` — replaces OpenFST: NFA combinators, subset-construction
    determinization, minimization, product intersection, language
    equivalence. Sufficient because Nutrimatic's expressions are unweighted
    acceptors over `[a-z0-9 ]` (label 0 = epsilon, which is how `-` means
    "optional space").
  - `expr-parse.ts` — the pattern language (literals, regexp operators,
    `"quoted"`, `&` intersection, `<anagram>` with its part-collapsing and
    length/containment constraint construction, `_ # A C V` classes).
  - `search-driver.ts` — best-first search over the trie, filtered by the
    compiled DFA; results stream out in descending frequency order, with the
    `1e-6` restart penalty for phrases spanning index windows.
  - `byte-source.ts` — where "serverless" happens: an index is read either
    from memory (small indexes are downloaded whole) or via **HTTP Range
    requests** with an LRU chunk cache, so a multi-gigabyte index can be
    searched from static hosting without downloading it.
- `web/` — the Vite site: `worker.ts` owns the index + search session,
  `main.ts` renders the upstream-style UI (`?q=` URLs, font size ∝ log
  score, computation limit with "Try harder »").
- `cli/` — Node ports of the upstream binaries: `find-expr`, `make-index`,
  `merge-indexes`, `dump-index`, plus `wordlist-index` (build an index from
  frequency wordlists, used for the bundled demo index) and `compress-index`
  (build the `.idxz` sidecar the web deploy serves next to each index).

## Develop

```sh
npm install
npm test               # vitest: format round-trip, upstream test-expr golden
                       # cases, HTTP-range integration
npm run dev            # vite dev server
npm run build          # static site -> web/dist/
npm run build-offline  # self-contained single file -> web/dist-offline/
node scripts/browser-test.mjs   # drives the built site headless (needs
                                # `npm run build` + `vite preview web --port 4517`)
```

### Offline single-file build

`npm run build-offline` generates `web/dist-offline/nutristatic-offline.html`:
one self-contained file that runs by double-clicking it (`file://`, no server).
Open it, then pick (or drop) a local `.index` file — `File.slice()` serves the
same on-demand range reads the network path uses, so even a multi-GB local
index opens instantly. The site also links it under "Offline version »".

It is *generated from the same sources* — `web/main.ts`, `web/worker.ts`, and
the `src/` engine, with an `OFFLINE` build flag flipping on the file-picker
path (`scripts/build-offline.mjs` inlines the worker as a Blob and the WASM as
a data URI). Re-run it after any change; there is no separate offline codebase
to keep in sync. `npm run build` runs it automatically (via `postbuild`) and
drops the file into `web/dist/`, so the served site's "Offline version" link
resolves with no extra steps.

## Searching from the command line

```sh
npm run find-expr -- web/public/demo.index '<aaagmnr>'
npm run find-expr -- --max-steps 10000000 my.index '"C*aC*eC*iC*oC*uC*yC*"'
```

## Building an index

The demo index bundled at `web/public/demo.index` (~20 MB) is built from
[Norvig's web-corpus ngram counts](https://norvig.com/ngrams/):

```sh
curl -O https://norvig.com/ngrams/count_1w.txt
curl -O https://norvig.com/ngrams/count_2w.txt
npm run wordlist-index -- web/public/demo.index count_1w.txt count_2w.txt
```

A full Wikipedia index works exactly as upstream describes (extract text,
`make-index`, `merge-indexes` with frequency cutoffs) — either with the
upstream C++ tools or these CLI ports (the C++ tools are much faster for a
full-size corpus; the outputs are interchangeable):

```sh
find text -type f | xargs cat | npm run make-index -- wikipedia
npm run merge-indexes -- 5 wikipedia.*.index wiki-merged.index
```

## Measured performance (2026-08-15 baseline)

Production, cold browser context, first result on screen: **0.3–0.8 s on
every bundled index** — all 22 Wikipedias (1.3 GB English down to 36 MB
Slovak), Simple English, and the web-words demo, each probed with a
native-language query (`scripts/prod-matrix.mjs` for the full table).

Constrained networks (CDP emulation, English index, cold), first result on
screen:

| Profile | First result |
|---|---|
| 2 Mbps / 150 ms RTT | 13.2 s |
| 8 Mbps / 300 ms RTT | 4.9 s |

A search that would stream a large slice of the index over the network stops
at a bytes/time budget (~32 MB or ~20 s) and offers to download the index for
instant local searching.

Heavy anagram (`<aciimnrttu>`, English index): ~5 s cold range mode,
~2 s from a device-stored (OPFS) copy including page load, 0.1 s warm
revisit. Engine: 1.3–3.5M steps/s in-memory (JS; the WASM kernel adds
~1.6x on heavy anagrams for fully-local indexes); a 500k-step,
100k-result search costs ~7 MB of heap. Whole-index download: 1.3 GB
transferred as 785 MB compressed in ~30 s on fast links, cancellable.
Compressed range transport (`.idxz` sidecars) cuts per-query transfer
31–39%.

Regenerate: `node scripts/bench-all.mjs` (engine + fixtures),
`node scripts/prod-matrix.mjs` (live site, all indexes), and
`node scripts/throttle-matrix.mjs` (bandwidth emulation).

## Server caching headers

The Caddy site block sets `Cache-Control` explicitly: Vite's content-hashed
`/assets/*` are `public, max-age=31536000, immutable` (no revalidation
round trips, ever — a new deploy changes the hash), the HTML shell is
`no-cache` (revalidates so deploys appear immediately), and small statics get
a day. Index/sidecar files intentionally get none: range responses are
managed by the app's own Cache Storage layer.

## Deploying with a big index

Indexes up to 4 MB are downloaded into memory. Above that the app switches
to Range mode and fetches only the trie nodes a query actually touches
(32 KB chunks, LRU-cached), unless a full copy is already on the device.
Requirements for the index host:

- HTTP Range request support (any real static file server has this).
- CORS headers if the index lives on a different origin than the page
  (`Access-Control-Allow-Origin`, and `Range` in allowed request headers).

Point the app at it with `?index=https://example.com/wiki-merged.index` or
the "index URL" box at the bottom of the page.

## License

GPL-2.0, same as upstream Nutrimatic, which this is derived from.
Original Nutrimatic is by Dan Egnor and contributors.
