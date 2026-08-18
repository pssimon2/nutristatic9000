---
name: nutri-url
description: Turn a word-puzzle constraint into a Nutristatic 9000 query and a shareable nutristatic.org/9000 URL. Use when the user wants a URL for a pattern/anagram/crossword/wordplay search, or asks "give me a nutristatic link for…".
---

# Generating Nutristatic 9000 URLs

Translate the user's constraint into the query language below, then build:

```
https://nutristatic.org/9000/?q=<encodeURIComponent(query)>
```

Optional parameters, appended with `&`:
- `index=/en-wiki.index` — which corpus (root-absolute path). Default is
  English Wikipedia; omit unless another is wanted. Others: `/de-wiki.index`,
  `/fr-wiki.index`, `/es-wiki.index`, `/it-wiki.index`, `/simple-wiki.index`,
  `./demo.index` (small, instant), and more `xx-wiki` codes (pt nl pl sv ca
  id cs hu no ro tr fi da eo sl hr sk).
- `comp=N` — raise the step budget (default 1000000) for hard queries.
- `pack=URL` — load a JSON construct pack.

Always URL-encode the query (`{` `}` `&` `|` `+` `#` `"` and spaces matter).
If the `nutristatic` MCP server is available, verify the query with its
`search` tool before handing out the URL; at minimum, mentally parse it
against the rules below.

## The query language (complete)

Matches are words/phrases over `[a-z0-9 ]`, streamed by corpus frequency.

**Pattern basics** — `a`/`1` literals; classes `A` letter, `C` consonant,
`V` vowel, `#` digit, `_` letter-or-digit, `.` anything incl. space, `-`
optional space, `[aeiou]`/`[^xyz]` sets; `(…)` groups; quantifiers `*` `+`
`?` `{3}` `{2,5}` (max 255, one per atom — `A{3}?` is invalid); `|` or,
`&` and, `!` not (binds the whole following factor). Precedence loosest→
tightest: `|`, `&`, `!`, concatenation, quantifier.

**Quoting** — unquoted atoms allow optional spaces between letters (that is
how `solar s_stem` matches "solar system"). `"…"` disables that: `"cargo"`
is exactly five letters. Quote whenever letter positions must be exact.

**Anagrams & banks** — `<aaagmnr>` anagram of exactly those parts;
`<<washington>>` letter bank (all listed letters used, repeats allowed).

**Constructs** `{name spec:pattern}` (all compose anywhere a pattern piece
can):
- Words: `{kind:bird}` (WordNet kind-of), `{list:greek}` /
  `{list:red,green,blue}` / `{list:https://…/x.txt}` (remote needs CORS),
  `{rhyme:tree}`, `{homo:knight}`, `{like:reluctant}`, `{near:king}`.
- Counts: `{sum=100:A*}`, `{scrabble>25:A{5}}`, `{count(e)=2:…}`,
  `{letters=11:…}`, `{words=2:…}`, `{all(aeiou):…}`, `{distinct:…}`,
  `{maxrep=2:…}`. Comparisons: `=` `<` `<=` `>` `>=` `lo..hi`.
- Bags: `{sub:cryptography}` (spellable from), `{bank:washington}`.
- Edits: `{del1:beast}`, `{add1:cargo}`, `{subst1:…}`, `{edit<=2:…}`;
  `(letters)` pins the letter: `{del1(d):…}`. Argument may be a pattern:
  `{del1:{kind:instrument}}`. Predicates may NOT sit inside edit arguments.
- Ciphers/encodings: `{caesar:kdhv}` (reports shift), `{rot13:…}`,
  `{atbash:…}`, `{t9:2665}`, `{enum:4,3,5}`, `{morse:...-...}`,
  `{elements:…}` (chemical symbols).
- Shapes: `{roman:…}` `{rot180:…}` `{mirror:…}` `{sevenseg:…}` `{holes=1:…}`
  `{row1:…}` `{row2:…}` `{row3:…}` `{ascending:…}` `{descending:…}`.

**Predicates** (checked per match; compose anywhere, wrap the part they
should hold of): `{palindrome:…}`, `{reversible:…}` (mirror is also a word),
`{compound 2:…}` (splits into N real words, 2–5), `{syllables=3:…}`,
`{stress 010:…}`, `{anagram X:…}` where X is a list name, a word, or any
pattern matching ≤20,000 strings. Examples:
`{palindrome:A{5}} {kind:bird}` (palindrome then a bird),
`A{6}&{anagram countries:A*}`. The same predicate twice is an error;
different predicates stack.

**Captures & relations** — `{=a:PATTERN}` names a span;
`{eq a,b:…}` / `{rev a,b:…}` / `{shift a,b:…}` (or `{shift13 a,b:…}`) relate
two named spans inside the pattern they wrap:
`{rev a,b:{=a:A{3,5}} {=b:A{3,5}}}` finds "saw was", "era are".

**Soft & graded (scores, not filters; conjunct-level only — stand alone or
join with `&`, never inside groups/quantifiers/concatenation)**:
`{~near:king}`, `{~rhyme:day}`, `{~homo:…}`, `{~like:…}`, `{~kind:…}`,
`{~list:a,b,c}` boost members above everything else; `{edit:cargo}` (no
bound) streams by damage: exact, then 1-edit, then 2, then 3.

## Worked examples

| Want | Query |
|---|---|
| 7-letter anagram of AAAGMNR | `<aaagmnr>` |
| Birds of exactly 5 letters | `{kind:bird}&A{5}` |
| 5-letter palindromes | `{palindrome:A{5}}` |
| Words ending in -tion | `A*tion` |
| A palindrome followed by a bird | `{palindrome:A{5}} {kind:bird}` |
| 9-letter word splitting into 2 words | `{compound 2:A{9}}` |
| Semordnilap pairs (two words, mirrored) | `{rev a,b:{=a:A{3,6}} {=b:A{3,6}}}` |
| Anagram of some country, 6 letters | `{anagram countries:A{6}}` |
| Country minus one letter, anagrammed to a word | `{anagram {del1:{list:countries}}:A*}` |
| Crossword: c_m___er, no double letter | `c_m___er&{maxrep=1:_*}` — or `{distinct:c_m___er}` |
| Phrase "…… system" where blank rhymes with solar | `{rhyme:solar} system` |
| Words within 2 edits of PUZZLE, best first | `{edit:puzzle}` |
| Greek letters hidden in words | `.*{list:greek}.*` |

## Pitfalls

- `;`, `{at …}` and `{rank …}` are NOT part of the language (they error).
- `{anagram cheese:…}` rearranges the word "cheese"; only real list names
  resolve as lists — no fuzzy matching.
- Unbounded queries (`{palindrome:.*}` alone) run to the step budget; add a
  length or letters. Suffix-anchored (`.*tion`) is fine — a reverse sidecar
  serves it.
- Weighted queries (`{~…}`, bounds-free `{edit:word}`) skip the fast head
  path on streamed indexes; for those, `./demo.index` or a small `xx-wiki`
  answers instantly.
- Digits after a name are its spec: `{del1:…}` = del×1, `{row1:…}`,
  `{rot13:…}`, `{shift13 a,b:…}`.

Output format: give the user the final URL (as a markdown link with the
query visible), plus a one-line reading of what the query means. If the
constraint is ambiguous, give the two most likely queries with URLs.
