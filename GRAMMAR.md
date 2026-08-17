# The query language

Written 2026-08-17 by reading the parser and then testing it, not from memory.
Every table below was produced by running the queries through the same pipeline
the page and the CLI use — `planSlots` → `compileQuery` → the predicates — so
"works" means *observed to work*, and where something does not compose the
reason is stated rather than guessed.

Meant to be argued with. The point of writing it down is to see whether the
shape is the one we want.

---

## 1. The three levels, and why a query has a fixed skeleton

A query is not one language but three stacked ones, and they are stacked in a
fixed order because each is answered at a different moment:

```
slots          A{5} ; A{6} ; A{7}          split first, on top-level ';'
  transforms   {at 1:…} {rank 200-2000:…}  change what is *shown*
  predicates   {palindrome:…} {compound 2:…} {reversible:…}
                                            asked of a *finished match*
  pattern      A{5}&C*&!.*ee.*             compiled to an automaton, *searched*
```

Reading outward from the pattern:

* The **pattern** is a regular language. It is compiled to a set of conjunct
  automata and intersected lazily as the index is walked. Everything here
  composes freely, because it is all just automata.
* A **predicate** cannot be an automaton — "reads the same backwards" would need
  26^(n/2) states — so it is a yes/no question asked of each finished match. It
  therefore has nothing to intersect with and has to wrap the whole pattern.
* A **transform** changes the output, not the search, so it wraps everything
  including the predicates.
* **Slots** are separate searches that share a page. They are split before
  anything else.

This is why the skeleton is fixed and not a matter of taste:

```
{at 1:{rank 1-9:{palindrome:{compound 2:  A{9}&C*  }}}}
 └transform┘ └transform┘ └─predicates──┘ └pattern┘
```

`{at 1:{palindrome:A{5}}}` works. `{palindrome:{at 1:A{5}}}` does not, and says
`{at …} must wrap the whole pattern`.

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
| `{name spec:…}` | a construct — see §3 |

### The one thing about quoting that surprises everyone

An unquoted atom carries an optional-space self-loop. That is what lets
`solar s_stem` match "solar system" — but it also means the language of a bare
`cargo` is "cargo", "c argo", "c  argo" and so on forever. Quoting makes it the
five letters it looks like. This bit `{anagram cargo:…}`, which was refused as
unbounded until the argument was compiled quoted.

---

## 3. Constructs

46 of them, all spelled `{name spec:argument}`, all grouped and all documented in
the generated reference at `/usage.html#reference`. What matters here is that a
construct's *level* determines where it may appear, and its *argument kind*
determines what may appear inside it.

Three argument kinds, from `src/construct-table.ts`:

| kind | the argument is | example |
|---|---|---|
| `literal` | data, not a query — nothing inside is parsed as a pattern | `{rhyme:tree}` `{sub:cryptography}` `{t9:2665}` |
| `wrap` | a pattern this intersects with | `{sum=100:A*}` `{elements:A{6}}` |
| `inner` | a pattern this is *about*, built separately | `{del1:beast}` `{edit<=2:cargo}` |

Two constructs take their argument *before* the colon, because the colon
introduces the pattern they wrap: `{compound 2:…}` and `{anagram countries:…}`.

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
| `{palindrome:A{5}}` | ok | – | – | – | – | – | – | – | – | – | – | ok | ok |
| `{compound 2:A{9}}` | ok | – | – | – | – | – | – | – | – | – | ok | ok | ok |
| `{anagram countries:A{5}}` | ok | – | – | – | – | – | – | – | – | – | ok | ok | ok |
| `{at 1:A{5}}` | ok | – | – | – | – | – | – | – | – | – | – | – | ok |
| `{rank 1-9:A{5}}` | ok | – | – | – | – | – | – | – | – | – | – | ok | ok |

Read across the top eight rows: **an automaton construct is an atom and behaves
like one.** It intersects, alternates, concatenates, quantifies, groups, quotes,
and nests inside anything that takes a pattern. That is the property worth
protecting when adding constructs.

One exception, and it is a size limit rather than a rule. `{del1:…}` and its
family *materialise* their argument into a single automaton, where the rest of
the language keeps conjuncts apart and intersects them lazily — so a big
intersection can exceed what the edit automaton can build:

```
{del1:{distinct:A{3}}}   ok
{del1:{distinct:A{5}}}   {del…} takes a word or a pattern and up to 5 edits …
                         A big set with substitutions or insertions is too
                         large to build; try {del…}, or narrow the set.
{del1:A{5}&C*}           ok — it is the multiset constraint's 26 conjuncts
                         that cost, not intersection itself
```

The `–` cells are the interesting part:

* `A{3}?` — you cannot stack quantifiers. `{rhyme:day}?` works because a
  construct is a single atom; `A{3}` has already used its quantifier.
* **Predicates and transforms only appear where the skeleton allows.** Every `–`
  in those four rows is the skeleton of §1, reported with a clear message
  (`{palindrome …} is checked on finished matches, so it has to wrap the whole
  query`).
* `{palindrome:{palindrome:…}}` is refused as *applied twice*, deliberately;
  different predicates stack (`{palindrome:{compound 2:A{9}}}` is fine).
* `{at 1:{rank 1-9:…}}` works and the reverse does not: within transforms the
  order is `at` outside `rank`.
* `{anagram X:…}` refuses `{sum=50:A*}` and `{elements:A{6}}` because it has to
  *list its argument out*, and those match unboundedly many strings. See below.

---

## 5. `{anagram …}` — the one construct whose argument is a set

`<…>` rearranges the parts you write between the brackets, so it cannot
rearrange a *set*: there is no way to spell out "any country". `{anagram X:…}`
asks the question of each finished match instead — sort its letters, see whether
anything in `X` sorts the same — and so `X` can be anything the engine can list:

```
{anagram countries:A{6}}          serial ← israel     analog ← angola
{anagram beast:A*}                beats ← beast       bates ← beast
{anagram {kind:bird}:A{6}}        garden ← gander     sector ← scoter
{anagram {del1:beast}:A*}         seat ← east         beta ← beat
{anagram {list:greek}&A{5}:A*}    at the ← theta      dealt ← delta
{anagram A*:A{5}}                 refused: not bounded enough
```

The argument resolves as: a list name if it is one, otherwise a pattern whose
language is listed out (capped at 20,000 strings, an intersection listed by its
smallest finite part and filtered by the rest). A bare word that is not a list is
a word — `{anagram cheese:…}` rearranges the word, and gets no "did you mean
cheeses", because a mistyped list name and a word are the same thing written
down.

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

Things this exercise turned up that are worth deciding rather than leaving:

1. **The skeleton is a chain, not a lattice.** `{at}` outside `{rank}` outside
   predicates outside the pattern, with no way to say otherwise. That is
   *implementable* — each layer is peeled by a regex from the outside in — but it
   is not obviously what a user expects, and the error messages are the only
   thing teaching it. Should the order be free where it is meaningless (does
   `{rank}` outside `{at}` mean anything different?), or should the docs simply
   state the chain?

2. **Predicates cannot attach to part of a pattern.** `{palindrome:A{5}} {kind:bird}`
   — "a palindrome followed by a bird" — cannot be written, because a predicate
   has no way to name a *span*. This is roadmap M1–M2 and it is the single
   biggest gap in composability: it is the difference between predicates being a
   level and being a wrapper.

3. **`{anagram …}` is a predicate, so it cannot be intersected.** You can write
   `{anagram countries:A{6}&C*}` but not `A{6}&{anagram countries:…}`, and the
   two read the same to a person. Every predicate shares this; `{anagram …}` just
   makes it obvious because its argument looks like an atom.

4. **Two constructs put their argument before the colon** (`{compound 2:…}`,
   `{anagram X:…}`) and 44 put it after. Consistent within itself — the colon
   always introduces the wrapped pattern — but it means the completion menu has
   to special-case them, and it did so wrongly at first, inserting `anagram:`.

5. **`{at}` positions are 1-based and can be negative**, `{rank}` is a
   `from-to` window, `{compound}` is a piece count, `{syllables}` takes
   comparisons and ranges, `{sum}` takes comparisons and ranges. Five spec
   grammars for five constructs. A single spec grammar (`=`, `<`, `>`, `..`,
   `(set)`) is mostly there already — `{count(e)=2:…}`, `{sum=50..60:…}`,
   `{subst1(o):…}` — but it is not *stated* anywhere, so each new construct
   invents its own.

6. **Quoting is load-bearing and invisible.** The optional-space self-loop is
   the single most surprising thing in the language and appears nowhere in the
   usage guide.

---

## 8. How to re-derive this

The matrix in §4 is generated, not typed:

```
npx tsx scripts/grammar-matrix.mjs            # the table
npx tsx scripts/grammar-matrix.mjs 'query'…   # probe specific queries
```

If a change to the language does not change that table, it did not change
composability. If it does, the table is the diff worth reading.
