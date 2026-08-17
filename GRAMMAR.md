# The query language

Written 2026-08-17 by reading the parser and then testing it, not from memory;
rewritten the same day after the hull-and-verify rework landed. Every table
below was produced by running the queries through the same pipeline the page
and the CLI use — `planSlots` → `compileQuery` → the predicates — so "works"
means *observed to work*, and where something does not compose the reason is
stated rather than guessed.

Meant to be argued with. The point of writing it down is to see whether the
shape is the one we want.

---

## 1. Levels are execution phases, not syntax

A query is answered in three phases, because its parts are answerable at
different moments:

```
slots          A{5} ; A{6} ; A{7}          split first, on top-level ';'
  transforms   {at 1:…} {rank 200-2000:…}  change what is *shown*
  predicates   {palindrome:…} {compound 2:…} {reversible:…}
                                            asked of a *finished match*
  pattern      A{5}&C*&!.*ee.*             compiled to an automaton, *searched*
```

* The **pattern** is a regular language, compiled to a set of conjunct
  automata and intersected lazily as the index is walked.
* A **predicate** cannot be an automaton — "reads the same backwards" would
  need 26^(n/2) states — so it is a yes/no question asked of each finished
  match.
* A **transform** changes the output, not the search.
* **Slots** are separate searches that share a page.

These phases used to be a *syntactic skeleton*: a predicate had to wrap the
whole pattern, in a fixed nesting order, and the error messages were the only
thing teaching it. That is no longer true for predicates. **A predicate is now
an atom** and may be written anywhere a pattern piece may:

```
{palindrome:A{5}} {kind:bird}     a palindrome, then a bird
A{6}&{palindrome:A*}              six letters and a palindrome
({palindrome:A{4}}|door)          either branch
{palindrome:A{3}}?door            optionally preceded by one
!{palindrome:A*}                  anything that is not one
<{palindrome:A{4}}de>             an anagram piece
{palindrome:{reversible:A{3}}tab} predicates at different depths
```

The mechanism is **hull + verify**. For the search, a predicate contributes
only its argument's automaton — its *hull* — so everything the walk emits is a
candidate, not an answer. Then each finished match is parsed again, exactly,
against the pattern's tree (`src/pattern-ast.ts`, built by `parsePatternAst`
alongside compilation), and every predicate is asked of the span its node
covers (`src/span-verify.ts`). A match survives if *some* parse assigns spans
satisfying every predicate — it matches if it can match. This is affordable
because a finished match is a short string: the whole evaluation is a memoised
pass over (node × start position).

A predicate wrapping the whole query never pays for any of this: it is peeled
textually before compilation, exactly as before, and checked without a
reparse. The reparse happens only when a pattern actually carries a predicate
inside it (the `where` result filter in `src/result-filter.ts`).

Two things still wrap the whole query, and the errors say so:

* **Transforms.** `{at …}` outside `{rank …}` outside everything. A transform
  changes what is shown, and a span has nothing to show — scoping `{at}` to a
  subexpression is roadmap M3, not yet built.
* **Negation direction.** Not a wrapper, but worth knowing: the hull of
  `!{palindrome:…}` is *everything* (the complement of an over-approximation
  under-approximates), so a bare negated predicate searches wide and filters
  per match. Intersect it with something bounded.

---

## 2. The pattern language

Precedence, loosest to tightest, from `src/expr-parse.ts`:

| level | syntax | notes |
|---|---|---|
| alternation | `a\|b` | materialises both sides — union does not distribute over conjunct lists |
| intersection | `a&b` | flattens; this is what keeps conjuncts unmaterialised and the search lazy |
| negation | `!a` | binds the whole following factor, so `!.*ee.*` is "no double e" |
| concatenation | `ab` | juxtaposition |
| quantifier | `a*` `a+` `a?` `a{3}` `a{2,5}` | on one atom; bounds capped at 255 |
| atom | see below | |

So `a|b&c` is `a | (b&c)`, and `!a&b` is `(!a)&b`.

Atoms:

| atom | meaning |
|---|---|
| `a` `1` | a literal letter or digit |
| `A` `C` `V` `#` `_` `.` | any letter / consonant / vowel / digit / letter-or-digit / anything incl. space |
| `-` | an optional space |
| `[aeiou]` `[^xyz]` | a set, or its complement |
| `(…)` | a group |
| `"…"` | quoted: no implicit optional spaces between atoms |
| `<abc>` | an anagram of the parts written between the brackets |
| `<<abc>>` | a letter bank: those letters, all used, repeats allowed |
| `{name spec:…}` | a construct — automaton *or predicate*, see §3 |

### The one thing about quoting that surprises everyone

An unquoted atom carries an optional-space self-loop. That is what lets
`solar s_stem` match "solar system" — but it also means the language of a bare
`cargo` is "cargo", "c argo", "c  argo" and so on forever. Quoting makes it the
five letters it looks like. This bit `{anagram cargo:…}`, which was refused as
unbounded until the argument was compiled quoted.

---

## 3. Constructs

46 of them, all spelled `{name spec:argument}`, all grouped and all documented
in the generated reference at `/usage.html#reference`. A construct's *level*
says how it runs — intersected into the search, or checked on finished
matches — and its *argument kind* says what may appear inside it. Neither
restricts where a construct may be written, with two exceptions: the two
transforms (`{at}`, `{rank}`) wrap the whole query, and a predicate may not
sit inside an edit's argument (§4).

Three argument kinds, from `src/construct-table.ts`:

| kind | the argument is | example |
|---|---|---|
| `literal` | data, not a query — nothing inside is parsed as a pattern | `{rhyme:tree}` `{sub:cryptography}` `{t9:2665}` |
| `wrap` | a pattern this intersects with | `{sum=100:A*}` `{elements:A{6}}` |
| `inner` | a pattern this is *about*, built separately | `{del1:beast}` `{edit<=2:cargo}` |

Two constructs take their argument *before* the colon, because the colon
introduces the pattern they wrap: `{compound 2:…}` and `{anagram countries:…}`.
A predicate's spec is validated by the same `parseFilterSpec` whether it wraps
the query or sits nested, so `{compound 9:…}` says "2 to 5 pieces" in both
places.

---

## 4. What composes, measured

Rows are a construct; columns are a syntactic position. `ok` means the query
planned, compiled and ran its predicates.

| | alone | `A&X` | `(X\|A)` | `aX` | `X?` | `(X)` | `"X"` | `<Xb>` | `{del1:X}` | `{anagram X:A*}` | `{palindrome:X}` | `{at 1:X}` | `X;A{3}` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `A{3}` | ok | ok | ok | ok | – | ok | ok | ok | ok | ok | ok | ok | ok |
| `{rhyme:day}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `{sum=50:A*}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | – | ok | ok | ok |
| `{kind:bird}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `{list:greek}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `{del1:beast}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `{caesar:kdhv}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `{elements:A{6}}` | ok | ok | ok | ok | ok | ok | ok | ok | ok | – | ok | ok | ok |
| `{palindrome:A{5}}` | ok | ok | ok | ok | ok | ok | ok | ok | – | – | – | ok | ok |
| `{compound 2:A{9}}` | ok | ok | ok | ok | ok | ok | ok | ok | – | – | ok | ok | ok |
| `{anagram countries:A{5}}` | ok | ok | ok | ok | ok | ok | ok | ok | – | – | ok | ok | ok |
| `{at 1:A{5}}` | ok | – | – | – | – | – | – | – | – | – | – | – | ok |
| `{rank 1-9:A{5}}` | ok | – | – | – | – | – | – | – | – | – | – | ok | ok |

Read the top eleven rows together now: **an automaton construct is an atom,
and a predicate construct is an atom too.** Both intersect, alternate,
concatenate, quantify, group, quote, and sit inside an anagram. That is the
property to protect when adding constructs.

Every remaining `–` has a stated reason:

* `A{3}?` — you cannot stack quantifiers. A construct is a single atom, so
  `{rhyme:day}?` and `{palindrome:A{5}}?` both work; `A{3}` has already used
  its quantifier.
* **`{del1:X}` refuses predicates in `X`**, with a message that says why: the
  match is the *edited* string, and the original it was edited from — the one
  the predicate would be asked of — is not part of the match. Put the
  predicate outside: `{palindrome:{del1:…}}` asks it of the match itself.
  (The edit family also still materialises its argument, so a big intersection
  can exceed what it can build — `{del1:{distinct:A{5}}}` is refused by size,
  `{del1:A{5}&C*}` is fine.)
* **`{anagram X:…}` needs `X` listable** (≤20,000 strings; §5). A predicate
  in `X` is fine when the rest of `X` is bounded — the enumeration is
  filtered through the verifier — but `{anagram {palindrome:A{5}}:…}` is
  refused because the *hull* `A{5}` is 11.8M strings.
* `{palindrome:{palindrome:…}}` is refused as *applied twice*, deliberately;
  different predicates stack at any depth
  (`{palindrome:{compound 2:A{9}}}`, `{palindrome:{reversible:A{3}}tab}`).
* **Transforms wrap the whole query**, `{at}` outside `{rank}` — every `–` in
  their two rows, reported as `{at …} must wrap the whole pattern`.

---

## 5. `{anagram …}` — the construct whose argument is a set

`<…>` rearranges the parts you write between the brackets, so it cannot
rearrange a *set*: there is no way to spell out "any country". `{anagram X:…}`
asks the question of each finished match instead — sort its letters, see
whether anything in `X` sorts the same — and so `X` can be anything the engine
can list:

```
{anagram countries:A{6}}          serial ← israel     analog ← angola
{anagram beast:A*}                beats ← beast       bates ← beast
{anagram {kind:bird}:A{6}}        garden ← gander     sector ← scoter
{anagram {del1:beast}:A*}         seat ← east         beta ← beat
{anagram {list:greek}&A{5}:A*}    at the ← theta      dealt ← delta
{anagram {palindrome:{list:…}}:A*}  rearranges only the palindromic entries
{anagram A*:A{5}}                 refused: not bounded enough
```

The argument resolves as: a list name if it is one, otherwise a pattern whose
language is listed out (capped at 20,000 strings, an intersection listed by its
smallest finite part and filtered by the rest — and, when the argument carries
predicates of its own, filtered through the span verifier too). A bare word
that is not a list is a word — `{anagram cheese:…}` rearranges the word, and
gets no "did you mean cheeses", because a mistyped list name and a word are the
same thing written down.

And because `{anagram …}` is a predicate, everything in §1 applies to it: it
can be intersected — `A{6}&{anagram countries:…}` reads the way it looks now —
concatenated beside a neighbour, or alternated.

---

## 6. Slots

`;` splits at the top level only, so a `;` inside braces belongs to whatever
wrote the braces. That is what lets one wrapper cover several slots:

```
{at 1:A{5}};{at 2:B{6}}       a wrapper per slot
{at 1:A{5};B{6}}              one wrapper over both, applied to each
{palindrome:A{5};A{6}}        the same, for a predicate
```

A slot's own wrapper wins over an inherited one; an inherited predicate is not
added twice to a slot that already has that kind.

---

## 7. Open questions

Things worth deciding rather than leaving:

1. **Transforms are still a chain.** `{at}` outside `{rank}` outside the
   pattern. Predicates stopped being a syntactic layer when they became
   span-checked; transforms could stop too, by becoming span *annotations* —
   `{at 1:X}` as "the shown letter comes from this span" (roadmap M3). Until
   then the chain stands, and the docs should state it rather than let the
   errors teach it.

2. **The edit family cannot hold predicates.** `{del1:{palindrome:…}}` is
   refused because the pre-edit string is not part of the match. It is not
   unrecoverable — one deletion has at most 26·(n+1) pre-images, each
   checkable by the verifier — so this is a "not yet", not a "cannot".

3. **Exists-a-parse is now load-bearing.** A match survives if *some* span
   assignment satisfies every predicate. That is the reading a person expects,
   but it interacts with negation: `!{palindrome:A*}` means "no parse of this
   span is a palindrome", which for a whole-match factor is what you want, and
   for exotic combinations deserves a written-down rule rather than folklore.

4. **Two constructs put their argument before the colon** (`{compound 2:…}`,
   `{anagram X:…}`) and 44 put it after. Consistent within itself — the colon
   always introduces the wrapped pattern — but it means the completion menu has
   to special-case them, and it did so wrongly at first, inserting `anagram:`.

5. **Five spec grammars for five constructs.** `{at}` positions are 1-based
   and can be negative, `{rank}` is a `from-to` window, `{compound}` is a piece
   count, `{syllables}` and `{sum}` take comparisons and ranges. A single spec
   grammar (`=`, `<`, `>`, `..`, `(set)`) is mostly there already but not
   *stated* anywhere, so each new construct invents its own. `parseFilterSpec`
   being shared between wrapped and nested positions is a start.

6. **Quoting is load-bearing and invisible.** The optional-space self-loop is
   the single most surprising thing in the language and appears nowhere in the
   usage guide.

7. **The completion menu doesn't know predicates nest.** It still offers them
   only at the start of the query. Nothing breaks — typing one by hand works —
   but discoverability lags the language.

---

## 8. How to re-derive this

The matrix in §4 is generated, not typed:

```
npx tsx scripts/grammar-matrix.mjs            # the table
npx tsx scripts/grammar-matrix.mjs 'query'…   # probe specific queries
```

If a change to the language does not change that table, it did not change
composability. If it does, the table is the diff worth reading — the
hull-and-verify rework turned twenty-one `–` cells into `ok` and left every
`ok` cell standing, which is exactly the shape of change §4 exists to review.
`test/grammar.test.ts` asserts the same claims in CI, and
`test/span-verify.test.ts` pins the span semantics (right span, right branch,
notes carried out, anagram arguments filtered).
