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
- The index picker points at root-absolute **versioned** index URLs
  (`/idx/<edition>/de-wiki.index`, where the edition is the dump's
  year-month) because those files are served from the site root; only
  `demo.index` ships with the app. An edition's files are immutable once
  published — a new dump goes up under a new `/idx/<edition>/` directory and
  the picker moves to it, so a shared link pinned with `?index=` keeps
  answering from the same data.
- Deploy target is `/srv/nutristatic9000` on the web host, served under
  the `/9000/` path (any static server that can strip a path prefix works).
- **The head sidecar is part of the deployment and is not in the repo.** Each
  streamed index wants an `<name>.head` beside the *page* (not beside the
  index, which is shared between deployments):

      npm run build-head -- /path/to/en-wiki.index --out web/heads/en-wiki-<edition>.head

  Keep the built heads in `web/heads/` (gitignored). Deploy with

      NUTRISTATIC9000_DEPLOY=user@host:/srv/nutristatic9000 npm run deploy

  which builds, copies the heads into `web/dist/` (refusing to deploy if
  `web/heads/` is empty), rsyncs, and runs `check-deployed`. The heads must
  NOT live only in `web/dist/`: a rebuild empties dist, and a hand-rolled
  rsync `--delete` would then remove every head from the server, which fails
  in the quiet way described below — the deploy script exists so that
  sequence cannot be mis-typed.

  12 MB on disk, 3.8 MB over the wire, a few seconds to build; the 23 streamed
  indexes come to 272 MB on the server. A loop over `*-merged.index` misses
  `simple-wiki.index`, which is built differently and is not named that way.
  Check the deployment, not the loop:

      npm run check-deployed

  It reads the picker's own list and asks the site, by range request, whether
  each index, its `.idxz` and its `.head` are served — and compares the *size*
  of every hand-written data file against the build, since a deploy that shipped
  an old `lists.txt` looks fine and answers `{list:…}` from a stale catalogue.
  Not in CI, which has no deployment to look at; run it after uploading, while a
  gap is still cheap to fix.

  It asks for the `identity` encoding, and has to: given `Accept-Encoding: gzip`
  a compressing server answers a `HEAD` with the `content-length` of the gzip
  of the body it did not send, which reported all five text datasets as stale
  when every one was fine. Without one the site still works and is much slower —
  `{palindrome:A{5}}` goes from half a second to twenty and finds nothing — so
  a deploy that forgets it fails quietly. `?debug=1` says "answered from the
  head of the index" when it is being used, which is the quickest way to tell.
- **A head belongs to one index. Rebuild the index, rebuild the head.** The
  head is served *as* the first page of a search and that path never touches
  the index, so a head left behind by an index rebuild goes on answering with
  entries the index no longer contains, at scores it no longer has, and nothing
  can notice. Check a pair before deploying it:

      npm run check-head -- data/en-wiki.index web/dist/en-wiki-<edition>.head

  Heads are edition-qualified to match their index's versioned URL, so a link
  pinned to an older edition never picks up a newer edition's head — it just
  misses and takes the slower, correct walk.

  It samples the head — the top, the bottom, and a spread between — and asks
  the index what each entry is worth. Against the index it was built from:
  `OK: 596 of 20000 entries checked, all present with matching scores`. Against
  a different one: `STALE: 350 missing, 249 mis-scored of 599 checked`.
- **A freshly built index gets prepared, not copied.** An index does not go out
  alone: without a `.idxz` sidecar range mode fetches the raw file, and without a
  `.head` every query that sifts finished matches falls back to a walk over the
  network. `scripts/prepare-index.mjs` builds all three and verifies the pair
  before anything leaves the machine:

      npx tsx scripts/prepare-index.mjs data/enwiki-ns0.index en-wiki-ns0

  It deliberately does not upload. The indexes are served from the site root and
  shared between deployments, so replacing one changes every page pointing at it
  — which is why a rebuild should go up under a *new* name first, with only this
  deployment's picker moved to it, rather than swapped in place.

## The query language

[GRAMMAR.md](GRAMMAR.md) describes the language as it is: two levels that are
execution phases rather than syntax, predicates that compose anywhere via
hull-and-verify, and a measured table of what composes with what. The table is
generated (`npx tsx scripts/grammar-matrix.mjs`) and the claims around it are
tested (`test/grammar.test.ts`), so the description cannot drift from the
parser.

## Features beyond Nutrimatic

| Feature | Syntax | Notes |
|---|---|---|
| Repeated-phrase folding | *(none)* | Collapses overlapping index windows of one phrase; a link restores them |
| Nested predicates | `{palindrome:A{5}} {kind:bird}` | Every predicate is an atom: intersect, alternate, quantify, negate, nest. The search runs on the predicate's hull; each match is re-parsed and the predicate asked of the span its node covers (`src/span-verify.ts`) |
| Captures + relations | `{rev a,b:{=a:A{4}} {=b:A{4}}}` | `{=name:…}` names a span; `{eq…}`, `{rev…}`, `{shift…}` relate two — semordnilaps, doubled words, Caesar pairs. Unknown `{shift}` reports the matched shift |
| Soft constructs | `{~near:king}`, `{~list:red,green,blue}` | Boost instead of filter: members surface at full weight, everything else at a hundredth, ordered exactly by the engine |
| Graded edit distance | `{edit:cargo}` | No bound = up to three edits, results strictly tiered by damage: CARGO, then every one-edit word, then two |
| Letter-value arithmetic | `{sum=100:expr}`, `{scrabble>25:expr}` | A1Z26 or tile values; `=`, `<`, `<=`, `>`, `>=`, `a..b`. A finite ceiling bounds the search (`{sum<=25:A*}` terminates; bare `A*` does not) |
| Letter banks / sub-anagrams | `<<washington>>`, `{bank:…}`, `{sub:cryptography}` | Per-letter bounds plus an alphabet restriction |
| Structural / keyboard classes | `{roman:…}`, `{rot180:…}`, `{mirror:…}`, `{sevenseg:…}`, `{row1:…}`, `{holes=0:…}`, `{ascending:…}`, `{descending:…}` | Letter-set restrictions and monotone chains |
| Encodings | `{t9:2665}`, `{enum:4,3,5}`, `{morse:...-...}`, `{elements:…}` | Keypad digits → every spelling; crossword enumerations |
| Negation | `!expr` | Walked lazily by `ComplementFilter`: acceptance flipped, and the inner DFA's dead end becomes an accepting sink, so nothing is materialized and there is no size limit. `!{distinct:A{6}}` — six letters with a repeat — is 98,575 states inside and never built. Only a negation wrapped in a quantifier, a union or a longer pattern must be built out in full, and that says so when it cannot |
| Rhyme / homophones | `{rhyme:tree}`, `{homo:knight}` | CMU pronouncing dictionary, rhyming from the last primary-stressed vowel; lazily fetched (~340 KB gzipped), built by `scripts/build-phonetics.mjs` |
| Categories | `{kind:bird}`, `{kind:tree}` | WordNet's kind-of hierarchy, walked at query time from a shipped graph (96k senses, 89k edges) |
| Syllables / metre | `{syllables=3:…}`, `{stress 100:…}` | Result filters over CMUdict stress shapes; phrases add up word by word |
| Meaning (embedding) | `{near:king}`, `{near 8:word}` | Nearest neighbours from ConceptNet Numberbatch, precomputed by `scripts/build-neighbours.mjs`, with WordNet antonyms removed; ~5 MB table for 60k words, no model in the browser. Chosen over word2vec/GloVe by a side-by-side comparison on puzzle-style neighbour queries |
| Meaning (thesaurus) | `{like:reluctant}` | WordNet sense groups (a thesaurus, not a semantic model); lazily fetched, built by `scripts/build-thesaurus.mjs` |
| Autocomplete + inline checking | *(the query box)* | Completes construct, group and list names from the same catalogue the parser dispatches on, with each one's summary and a runnable example. `{list:…}` offers the harvested catalogue as well as the built-ins, and `{kind:…}` is answered by the worker, which holds all 124,980 WordNet names — too many to hand the page a copy of; a query the engine cannot parse is underlined as you type, checked by `compileQuery` itself in the worker so the box and the search cannot disagree. The menu opens unselected — Enter searches, ArrowDown steps in, Tab completes the top match, Escape dismisses — so it advises without trapping |
| Generated reference | *(usage.html)* | The construct table is rendered from `src/constructs.ts` by `scripts/build-docs.mjs`; `npm run check-docs` fails CI if it drifts, so an undocumented construct cannot ship |
| Match explanation | *(click a result)* | Rebuilds, per conjunct, why a result matched — the source word and letter behind an edit, the shift behind a cipher, the total behind a count. Post-hoc in `src/explain.ts`, so the search carries no cost |
| Corpus self-reference | `{compound 2:A{9}}` | Match must cut into N indexed words; the split is shown. Verified in the worker against the index |
| Palindromes / reversals | `{palindrome:…}`, `{reversible:…}` | Result filters, so no 26^(n/2) automaton |
| Harvested list catalogue | `{list:romandeities}` | A curated couple dozen categories mined from a Wikipedia dump by `scripts/build-wiki-lists.mjs` and then reviewed by hand for puzzle use — all nine Pokémon generations (plus a merged `{list:pokemon}` across all of them), cocktails, phobias, cheeses, Roman deities… Fetched on demand, browsable at `/lists.html`; an unknown name suggests the nearest real one |
| Named + inline lists | `{list:countries}`, `{list:instruments}`, `{list:red,green,blue}` | 57 shipped categories — countries, capitals, US states, elements, constellations, presidents, Greek/Norse/Egyptian gods, Bible books, Shakespeare plays, tarot, moons, instruments, car makers, sports, currencies, and the puzzle-hunt canon: rainbow, resistor colors, reindeer, Clue suspects/weapons/rooms, Monopoly properties, ancient wonders, apostles, Round Table knights, Hogwarts houses, solfège, Mohs scale, SI prefixes, wedding anniversaries, dwarf planets, NBA/NFL/MLB/NHL teams… — or your own written in the query and shared in the URL. The large ones are generated from Wikidata (CC0) by `scripts/build-lists.mjs` and committed, so no network is needed at build or run time |
| Ciphers | `{caesar:kdhv}`, `{rot13:…}`, `{caesar+5:…}`, `{atbash:…}`, `{vigenere(key):…}`, `{playfair(key):…}` | Desugars to an alternation of literals; the UI reports the matched shift. The keyed ciphers decode with the key you name — Playfair keeps a decoded X skippable (padding) and reads a decoded I as J too |
| Hunt codes | `{a1z26:2085}`, `{braille:2345 125 15}`, `{bacon:baabb…}`, `{bin5:…}`, `{semaphore:n-nw…}`, `{ascii:116 104 101}`, `{polybius:44 23 15}` | The most-used codes in Mystery Hunt history, decoded to *every* reading so the corpus picks the word: unseparated `{a1z26:…}` tries every split into 1-26, `{bacon:…}` reads both the 24- and 26-letter tables, `{polybius:…}` covers the tap-code square via its merged cells |
| Cryptograms | `{iso:xjxj}`, `{iso:uijt jt ju}` | Everything isomorphic to the ciphertext — same letter pattern, one-to-one mapping — streamed by corpus frequency, so the most plausible plaintext arrives first and the recovered key is shown beside it. `{iso:qzmzmz}` answers BANANA; `{iso:uijt jt ju}` on English Wikipedia answers THIS IS IT in ~1s. Rides hull+verify: shape plus the most-repeated letters pinned 26 ways for the search, exact isomorphism checked per match. Doubles as a word-pattern search (`{iso:abcba}`) |
| Edit distance | `{del1:beast}`, `{add1:…}`, `{subst1:…}`, `{edit<=2:…}`, `{del1(a):…}` | Levenshtein automaton over a word **or any inner pattern** — `{del1:{kind:instrument}}` is "one letter off some instrument", and `{kind:instrument}&{add1:{kind:bird}}` is "an instrument that becomes a bird when you drop a letter". A parenthesised set names the letter involved (`{del1(a):…}`, `{add1(vowel):…}`), which also shrinks the automaton. Edits are letters/digits only, never spaces |
| Occurrence / multiset | `{count(e)=2:expr}`, `{distinct:expr}`, `{maxrep=2:expr}`, `{all(aeiou):expr}`, `{letters=11:expr}`, `{words=3:expr}` | Same counter machinery; multiset forms decompose into one small automaton per letter |
| Remote word lists | `{list:https://…/birds.txt}` | One entry per line, fetched per session; the server must allow CORS |
| Construct packs | `?pack=URL`, `--pack FILE` | JSON-declared letter classes, value tables and substitutions per session (`src/packs.ts`); packs cannot shadow built-ins |
| Index manifests | `my.index.meta.json` | Per-index description and transliteration rules, so a custom index folds diacritics the way its corpus did |
| Multi-index search | `find-expr a.index,b.index` | One query over several corpora, scores normalized and merged exactly, results tagged by source (`src/merged-driver.ts`) |
| Parallel sharding | `find-expr --shards 4` | First-letter shards across worker threads, merged exactly; restart phrases stay in the shard of their first letter (`src/shards.ts`) |
| Reverse-index sidecar | `reverse-index in.index out.rindex`, `find-expr --reverse-index` | Suffix-anchored patterns (`.*tion`) walk a reversed index at prefix speed — identical results and scores, ~50× fewer steps (`src/reverse.ts`). The site picks a served `.rindex` automatically when reversal wins decisively, and a device copy of the sidecar (downloadable on the storage page) keeps suffix searches fast offline |
| Score floor | `--score-floor 1e-6` | Optional frontier budget: drops entries that can no longer beat `floor × best`; bounds memory, truncates only the deep tail |
| Offline & storage manager | *(storage.html)* | Every index's device copy, its reverse sidecar, the side datasets and the cached range pieces in one page — queued downloads with resume/discard, per-item and delete-everything removal, the browser's own quota accounting. A copy + its sidecar + the datasets is a complete offline puzzle kit; the PWA searches with no connection at all |

### Construct groups

Every `{name:…}` construct may be written with a group prefix saying which
family it belongs to. The bare name is still valid everywhere — shared query
URLs use it — but the prefixed form is the one to reach for when two names
look related and are not: `{cipher.rot13:…}` decodes a shifted literal,
`{shape.rot180:…}` is the set of letters that survive being turned upside
down. A prefix naming the wrong group is an error, not a silent
reinterpretation.

| Prefix | What the family does | Constructs |
|---|---|---|
| `word.` | look words up in a dictionary or the corpus | `word.rhyme`, `word.homo`, `word.like`, `word.near`, `word.kind`, `word.list` |
| `count.` | count letters, values or occurrences | `count.sum`, `count.scrabble`, `count`, `count.letters`, `count.words`, `count.all`, `count.distinct`, `count.maxrep` |
| `bag.` | restrict which letters are available | `bag.sub`, `bag.bank` |
| `edit.` | match something a few letters away | `edit.del`, `edit.add`, `edit.subst`, `edit` |
| `cipher.` | decode a literal that has been shifted or reflected | `cipher.caesar`, `cipher.rot`, `cipher.rot13`, `cipher.atbash` |
| `spell.` | spell the match some other way | `spell.t9`, `spell.enum`, `spell.morse`, `spell.elements` |
| `shape.` | restrict letters by how they look or where they are typed | `shape.roman`, `shape.rot180`, `shape.mirror`, `shape.sevenseg`, `shape.holes`, `shape.row1`, `shape.row2`, `shape.row3`, `shape.ascending`, `shape.descending` |
| `match.` | ask a question of each finished match | `match.compound`, `match.palindrome`, `match.reversible`, `match.syllables`, `match.stress`, `match.anagram`, `match.eq`, `match.rev`, `match.shift` |

A construct whose name is its own group is written bare: `{edit<=2:…}`, not
`{edit.edit<=2:…}`. Every family composes anywhere; a `match.` construct
written inside a pattern is checked on the span it covers. The catalogue
lives in `src/constructs.ts`.

The phrase-frequency indexes are built from Wikipedia database dumps, and the
harvested `{list:…}` categories are extracted from the English Wikipedia; both
are used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The smaller built-in categories come from Wikidata, which is CC0.

The rhyme/homophone data comes from the CMU Pronouncing Dictionary and the
meaning data from WordNet 3.1 (Copyright 2011 The Trustees of Princeton
University, used under the WordNet licence); both are reduced to lookup
artifacts at build time and fetched only when a query needs them.

`{sum …}` / `{scrabble …}` compile to conjunct NFAs, so the WASM kernel runs
them with no C-side work — locked in by a parity test.

Everything below describes the engine, which is unchanged from Nutrimatic.

---

A rewrite of [Nutrimatic](https://nutrimatic.org/) ([Nutrimatic
source](https://github.com/PuzzleTechHub/nutrimatic)) that runs with **no
server-side code**, deployed at [nutristatic.org](https://nutristatic.org/).
The user-facing "what is this and how does it differ from Nutrimatic"
documentation lives in the site's
[usage guide](https://nutristatic.org/9000/usage.html); this README covers the
implementation. The pattern engine is TypeScript running in a Web Worker
in the visitor's browser; the phrase-frequency index is a plain static file.
(A WebAssembly port of the engine — `wasm-kernel/kernel.c` driven by
`src/wasm-session.ts` — takes over automatically for fully-local indexes up
to its ~2.4 GB memory cap, including the English device copy; on deep
exhaustive walks its throughput is several times the JS engine's. The JS
engine remains the reference implementation, the fallback, and the
range-mode engine.)
Deploy the built site to any static host (GitHub Pages, S3, nginx `root`,
`python -m http.server`, …) and it works.

The index file format is **byte-compatible with Nutrimatic**: indexes built by
the original C++ tools work here, and indexes built by these TypeScript tools
work with the C++ binaries.

That compatibility is tested against Nutrimatic's own output, not just against
this repo's: `test/nutrimatic-format.test.ts` reads fixtures built by the C++
`make-index` and requires this reader to decode them to what Nutrimatic's
`dump-index` reports *and* this writer to reproduce their bytes exactly;
`test/index-format.test.ts` round-trips the writer and reader; and
`test/expr-search.test.ts` is a port of Nutrimatic's expression suite, pinning
the query semantics.

Working on this: see [CONTRIBUTING.md](CONTRIBUTING.md) for the layering
rules, the two-speed code doctrine, what counts as "green", and how to add a
construct.

## How it works

- `src/` — the engine, a faithful port of Nutrimatic's C++:
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
  `main.ts` renders the Nutrimatic-style UI (`?q=` URLs, font size ∝ log
  score, computation limit with "Try harder »").
- `cli/` — Node ports of the Nutrimatic binaries: `find-expr`, `make-index`,
  `merge-indexes`, `dump-index`, plus `wordlist-index` (build an index from
  frequency wordlists, used for the bundled demo index) and `compress-index`
  (build the `.idxz` sidecar the web deploy serves next to each index).

## Develop

```sh
npm install
npm test               # vitest: format round-trip, Nutrimatic test-expr golden
                       # cases, HTTP-range integration
npm run dev            # vite dev server
npm run build          # static site -> web/dist/
npm run build-offline  # self-contained single file -> web/dist-offline/
npm run test:browser   # drives the built site headless, served at the /9000/
                       # path it deploys under (needs `npm run build`)
npm run test:offline   # drives the self-contained double-click build over
                       # file:// (needs `npm run build`)
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

## Searching as an MCP tool

`mcp/server.ts` serves the engine over the Model Context Protocol, so an AI
client can run searches as tool calls — `search`, `explain`, `indexes` and
`syntax` (the grammar cheat sheet). It reads local index files from the
directories given as arguments (or `NUTRI_INDEX_DIRS`), loads the side
datasets on demand, and picks a `.rindex` reverse sidecar automatically for
suffix-anchored queries. Register it with, e.g.:

```sh
claude mcp add nutristatic -- npx tsx /path/to/nutristatic9000/mcp/server.ts \
  /path/to/nutristatic9000/web/public /path/to/index/files
```

There is also a **Claude skill** (`skills/nutri-url/SKILL.md`) that teaches
Claude to translate a constraint stated in words into a query and a shareable
`nutristatic.org/9000` URL. The build packages it for download —
[nutri-url-skill.md](https://nutristatic.org/9000/nutri-url-skill.md) for
`~/.claude/skills/nutri-url/SKILL.md`, and
[nutri-url-skill.zip](https://nutristatic.org/9000/nutri-url-skill.zip) in the
folder shape claude.ai's skill upload expects.

## Searching from the command line

```sh
npm run find-expr -- web/public/demo.index '<aaagmnr>'
npm run find-expr -- --max-steps 10000000 my.index '"C*aC*eC*iC*oC*uC*yC*"'
```

The CLI accepts the same queries as the site, including the predicates that
are not part of the automaton — `{compound …}`, `{palindrome:…}`,
`{reversible:…}` and friends ask the index about finished matches:

```sh
npm run find-expr -- web/public/demo.index '{compound 2:A{9}}'  # copyright  copy·right
npm run find-expr -- web/public/demo.index 'A{5}&{palindrome:A*}'
```

Beyond queries it takes `--shards N` (parallel walk across threads),
`--reverse-index FILE` (walk a reversed sidecar; see `reverse-index`),
`--score-floor F`, `--pack FILE|URL`, and comma-separated index paths for a
merged multi-corpus search. `--explain` and `--stats` describe the plan and
the cost.

## Building an index

The demo index bundled at `web/public/demo.index` (~20 MB) is built from
[Norvig's web-corpus ngram counts](https://norvig.com/ngrams/):

```sh
curl -O https://norvig.com/ngrams/count_1w.txt
curl -O https://norvig.com/ngrams/count_2w.txt
npm run wordlist-index -- web/public/demo.index count_1w.txt count_2w.txt
```

A full Wikipedia index works exactly as Nutrimatic describes (extract text,
`make-index`, `merge-indexes` with frequency cutoffs) — either with the
Nutrimatic C++ tools or these CLI ports (the C++ tools are much faster for a
full-size corpus; the outputs are interchangeable):

```sh
find text -type f | xargs cat | npm run make-index -- wikipedia
npm run merge-indexes -- 5 wikipedia.*.index wiki-merged.index
```

## What a search will do, and what it cost

`npm run find-expr -- --explain INDEX 'PATTERN'` describes the compiled plan
before searching: the conjuncts, each one's automaton size, and whether it
denotes a finite set or an unbounded one — `{list:countries}` is 197 strings,
`C*` is not. The `?debug=1` panel shows the same.

## What a search cost

`npm run find-expr -- --stats INDEX 'PATTERN'` prints steps, results, frontier
peak, lazy DFA states, bytes fetched and predicate outcomes to stderr; the same
numbers appear in the page under `?debug=1`. They are what makes an expensive
query legible — `{palindrome:A{5}}` reports 103,302 predicate checks for 377
results, which is the filter's real cost rather than a guess.

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

Hosting the site itself needs nothing beyond a static file server. Useful
cache settings, whatever the server: long lifetimes for Vite's content-hashed
`/assets/*`, `no-cache` for the HTML shell and `sw.js` (so deploys appear
immediately), and no special caching for index/sidecar files — range
responses are managed by the app's own Cache Storage layer.

## License

GPL-2.0, same as Nutrimatic, which this is derived from.
- Original Nutrimatic: Copyright (C) Dan Egnor and contributors
- Nutristatic: Copyright (C) 2026 Simon Stroh and contributors
