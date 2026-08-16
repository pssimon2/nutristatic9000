// Local end-to-end browser test against `vite preview web --port 4517`.
// Uses the dist-bundled demo index (the default en-wiki.index is not in
// dist). Covers: range mode + compressed download-size label, searching on
// the JS engine, full download -> OPFS disk mode -> WASM engine, reload
// persistence, the interrupt-then-continue race, remove-device-copy, and
// parse errors. Exits non-zero on any failure.
import { chromium } from "playwright-core";
import { chromiumPath } from "./chromium-path.mjs";

const exe = await chromiumPath();
const base = process.argv[2] || "http://localhost:4517/";
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
// "remove device copy" asks for confirmation; accept it in the test.
page.on("dialog", (d) => d.accept());
// Click-to-copy writes to the clipboard.
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

const waitInfo = (substr, timeout = 120000) =>
  page.waitForFunction(
    (s) => document.getElementById("indexinfo").textContent.includes(s),
    substr,
    { timeout },
  );
const waitDone = (timeout = 120000) =>
  page.waitForFunction(
    () =>
      document.getElementById("after").textContent.length > 0 &&
      document.getElementById("status").textContent === "",
    null,
    { timeout },
  );

// Range mode: correct info line and compressed download size on the button.
await page.goto(base + "?index=./demo.index");
await page.waitForSelector("#examples li");
console.log("title:", await page.title());

// Installable app: the manifest is served and names icons that exist.
const mf = await page.evaluate(async () => {
  const r = await fetch("./manifest.webmanifest");
  return r.ok ? await r.json() : null;
});
if (!mf || !mf.icons?.length) throw new Error("manifest missing/invalid");
for (const icon of mf.icons) {
  const ok = await page.evaluate(
    async (src) => (await fetch(src)).ok,
    new URL(icon.src, base).href,
  );
  if (!ok) throw new Error(`manifest icon missing: ${icon.src}`);
}
console.log("manifest:", mf.name, "| icons:", mf.icons.map((i) => i.sizes).join(" "));

// Search box is focused on arrival (desktop pointer).
const focused = await page.evaluate(() => document.activeElement?.id);
console.log("autofocus:", focused);
if (focused !== "q") throw new Error("search box not focused on load");

await waitInfo("loading only");
console.log("range info:", await page.textContent("#indexinfo"));
const dl = await page.textContent("#dlfull");
console.log("download button:", dl);
if (!/download whole index \(\d+ MB\)/.test(dl)) throw new Error("bad dl label");

// Search in range mode (JS engine).
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();
const first = await page.$eval("#results span", (e) => e.textContent);
console.log("range search first:", first);
if (first !== "anagram") throw new Error("wrong first result");

// Variant collapsing: a fixed-length pattern must not collapse anything (no
// "show N similar" affordance), since its results are short and distinct.
if (/similar result/.test(await page.textContent("#after"))) {
  throw new Error("collapsed variants on a query that has none");
}

// Click a result to copy it.
await page.click("#results span");
const clip = await page.evaluate(() => navigator.clipboard.readText());
console.log("click-to-copy:", JSON.stringify(clip));
if (clip !== "anagram") throw new Error("click-to-copy failed");

// Phrase variants (same word seen through different index windows) collapse,
// and the reveal button restores every one of them.
await page.fill("#q", "A{14} A*");
await page.click("input[type=submit]");
await waitDone();
const collapsedCount = (await page.$$("#results span")).length;
const revealBtn = await page.$("#after button:has-text('similar result')");
if (!revealBtn) throw new Error("expected collapsed variants");
console.log("collapsed:", (await revealBtn.textContent()).trim(), `(${collapsedCount} shown)`);
await revealBtn.click();
const revealedCount = (await page.$$("#results span")).length;
console.log("after reveal:", revealedCount, "results");
if (revealedCount <= collapsedCount) throw new Error("reveal did not restore variants");

// A literal the query itself demands is not evidence of repetition: nearly
// every match of `.*administration.*` contains that word, so the bulk of them
// must survive (only true window variants like "the administration of" go).
await page.fill("#q", ".*administration.*");
await page.click("input[type=submit]");
await waitDone();
const litShown = (await page.$$("#results span")).length;
const litBtn = await page.$("#after button:has-text('similar result')");
const litHidden = litBtn ? +/\d+/.exec(await litBtn.textContent())[0] : 0;
const hiddenShare = litHidden / (litShown + litHidden);
console.log(
  `query-literal exemption: ${litShown} kept, ${litHidden} hidden ` +
    `(${(hiddenShare * 100).toFixed(0)}% collapsed)`,
);
if (hiddenShare > 0.25) {
  throw new Error("collapsed on a literal the query requires");
}

// `{at N:…}` extraction: results render as the picked letters, with the match
// they came from alongside, and copying yields the extraction not the word.
await page.fill("#q", "{at 1:<aaagmnr>}");
await page.click("input[type=submit]");
await waitDone();
const ex = await page.$eval("#results span.r", (e) => ({
  picked: e.firstChild.textContent,
  from: e.querySelector(".from")?.textContent?.trim(),
}));
console.log("extract {at 1}:", JSON.stringify(ex));
if (ex.picked !== "a" || ex.from !== "anagram") throw new Error("bad extraction");
await page.click("#results span.r");
const exClip = await page.evaluate(() => navigator.clipboard.readText());
if (exClip !== "a") throw new Error(`extract copy gave ${JSON.stringify(exClip)}`);
// A position may name a word: first letter of the last word.
await page.fill("#q", "{at -1.1:A* A{6}}");
await page.click("input[type=submit]");
await waitDone();
const byWord = await page.$eval("#results span.r", (e) => ({
  picked: e.firstChild.textContent,
  from: e.querySelector(".from")?.textContent?.trim(),
}));
console.log("extract {at -1.1}:", JSON.stringify(byWord));
if (byWord.picked !== byWord.from.split(" ").pop()[0]) {
  throw new Error("word-relative extraction picked the wrong letter");
}

await page.fill("#q", "{at -1:<aaagmnr>}");
await page.click("input[type=submit]");
await waitDone();
const last = await page.$eval("#results span.r", (e) => e.firstChild.textContent);
console.log("extract {at -1}:", last);
if (last !== "m") throw new Error("bad negative-position extraction");
// A malformed wrapper explains itself rather than failing as pattern syntax.
await page.fill("#q", "{at 0:A*}");
await page.click("input[type=submit]");
await page.waitForFunction(() => document.getElementById("status").className === "error");
console.log("extract error:", await page.textContent("#status"));
// Leave a valid query behind: the download below re-runs whatever is in the
// box, and a rejected one would never produce a "done".
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();

// `{rank N-M:…}` window: the same stream, offset. Uses a fixed-length pattern
// so variant folding can't shift the indices.
await page.fill("#q", "A{5}");
await page.click("input[type=submit]");
await waitDone();
const head = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 12).map((e) => e.textContent),
);
await page.fill("#q", "{rank 10-12:A{5}}");
await page.click("input[type=submit]");
await waitDone();
const window = await page.$$eval("#results span.r", (els) =>
  els.map((e) => e.textContent),
);
console.log("rank 10-12:", JSON.stringify(window), "vs stream 10-12:", JSON.stringify(head.slice(9, 12)));
if (window.length !== 3 || window[0] !== head[9] || window[2] !== head[11]) {
  throw new Error("rank window did not match the ranked stream");
}
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();

// Letter-value constraints run in the engine (and, being ordinary conjunct
// NFAs, in the WASM kernel too).
await page.fill("#q", "{sum=52:A*}&A{4}");
await page.click("input[type=submit]");
await waitDone();
const sums = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 5).map((e) => e.textContent),
);
console.log("sum=52 & A{4}:", JSON.stringify(sums));
const value = (w) => [...w].reduce((n, c) => n + (c.charCodeAt(0) - 96), 0);
for (const w of sums) {
  if (w.replace(/ /g, "").length !== 4 || value(w.replace(/ /g, "")) !== 52) {
    throw new Error(`bad {sum} match: ${w}`);
  }
}

// Ciphers, and the shift each result used (without it the tool solves the
// puzzle and discards the answer).
await page.fill("#q", "{caesar:kdhv}");
await page.click("input[type=submit]");
await waitDone();
const cipher = await page.$eval("#results span.r", (e) => ({
  word: e.firstChild.textContent,
  note: e.querySelector(".from")?.textContent?.trim(),
}));
console.log("caesar:", JSON.stringify(cipher));
if (!/^caesar \+\d+$/.test(cipher.note ?? "")) throw new Error("no shift reported");
{
  const shift = +/\d+/.exec(cipher.note)[0];
  const rot = (w, n) =>
    [...w].map((c) => String.fromCharCode(97 + ((c.charCodeAt(0) - 97 + n) % 26))).join("");
  if (rot("kdhv", shift) !== cipher.word) throw new Error("reported shift is wrong");
}
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();

// Phonetics: the dictionary is fetched only when a query needs it.
const beforePhon = await page.evaluate(() =>
  performance.getEntriesByType("resource").some((r) => r.name.includes("phonetics")),
);
if (beforePhon) throw new Error("dictionary fetched before it was needed");
await page.fill("#q", "{rhyme:night}&A{5}");
await page.click("input[type=submit]");
await waitDone();
const rhymed = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 6).map((e) => e.textContent),
);
console.log("rhyme:night &A{5}:", JSON.stringify(rhymed));
if (!rhymed.includes("light") || !rhymed.includes("right")) {
  throw new Error("rhymes missing");
}
// (The fetch happens in the worker, which the page's resource timing cannot
// see; the rhymes above are the proof that it loaded.)
// A word the dictionary doesn't know says so.
await page.fill("#q", "{rhyme:zzzqq}");
await page.click("input[type=submit]");
await page.waitForFunction(
  () => document.getElementById("status").className === "error",
  null,
  { timeout: 30000 },
);
console.log("unknown word:", await page.textContent("#status"));

// Meaning: the thesaurus is a second lazily-fetched dataset.
await page.fill("#q", "{like:reluctant}&A{5}&l....");
await page.click("input[type=submit]");
await waitDone();
const meant = await page.$$eval("#results span.r", (els) =>
  els.map((e) => e.textContent),
);
console.log("like:reluctant &A{5}&l....:", JSON.stringify(meant));
if (!meant.includes("loath")) throw new Error("thesaurus intersection failed");

// Embedding neighbours: the third lazily-fetched dataset, binary this time.
await page.fill("#q", "{near:king}&A{7}");
await page.click("input[type=submit]");
await waitDone();
const near = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 8).map((e) => e.textContent),
);
console.log("near:king &A{7}:", JSON.stringify(near.slice(0, 5)));
if (!near.includes("monarch")) throw new Error("semantic neighbours failed");

// Categories, and semantic ranking of {near:…} results.
await page.fill("#q", "{kind:bird}&A{7}");
await page.click("input[type=submit]");
await waitDone();
const birds = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 8).map((e) => e.firstChild.textContent),
);
console.log("kind:bird &A{7}:", JSON.stringify(birds.slice(0, 4)));
if (!birds.includes("penguin")) throw new Error("category walk failed");

await page.fill("#q", "{near:king}&A{7}");
await page.click("input[type=submit]");
await waitDone();
const ranked = await page.$$eval("#results span.r", (els) =>
  els.map((e) => e.firstChild.textContent),
);
console.log("near:king ranked:", JSON.stringify(ranked.slice(0, 4)));
// Closest first, not commonest first: MONARCH must beat KINGDOM.
if (ranked.indexOf("monarch") > ranked.indexOf("kingdom")) {
  throw new Error("results are not ranked by closeness");
}

await page.fill("#q", "{syllables=3:A{7}}");
await page.click("input[type=submit]");
await waitDone();
const sylls = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 5).map((e) => ({
    word: e.firstChild.textContent,
    note: e.querySelector(".from")?.textContent?.trim(),
  })),
);
console.log("syllables=3:", JSON.stringify(sylls.slice(0, 3).map((s) => `${s.word} ${s.note}`)));
if (!sylls.every((s) => s.note === "3 syll")) throw new Error("syllable filter failed");

// The datasets land in their own cache, so a redeploy doesn't re-fetch them.
const dataCached = await page.evaluate(async () => {
  const c = await caches.open("nutristatic9000-data");
  return (await c.keys()).map((r) => new URL(r.url).pathname.split("/").pop());
});
console.log("data cache:", JSON.stringify(dataCached.sort()));
for (const f of ["phonetics.txt", "thesaurus.txt", "neighbours.bin", "categories.txt", "stress.txt"]) {
  if (!dataCached.includes(f)) throw new Error(`${f} not cached separately`);
}
const shellKeys = await page.evaluate(async () => {
  const names = (await caches.keys()).filter((k) => k.startsWith("nutristatic9000-shell-"));
  const c = await caches.open(names[0]);
  return (await c.keys()).map((r) => new URL(r.url).pathname);
});
if (shellKeys.some((k) => /phonetics|thesaurus|neighbours|categories|stress/.test(k))) {
  throw new Error("datasets leaked into the versioned shell cache");
}

// Multi-slot: several patterns at once, with their picked letters assembled.
await page.fill("#q", "{at 1:<aaagmnr>} ; {at 2:solar s_stem} ; {at 1:A{5}&.*zz.*}");
await page.click("input[type=submit]");
await page.waitForFunction(
  () => document.getElementById("after")?.textContent?.includes("slots"),
  null,
  { timeout: 90000 },
);
const extraction = await page.$eval("p.extraction", (e) => e.textContent);
const slotRows = await page.$$eval("table.slots tr", (rs) =>
  rs.map((r) => r.cells[1].textContent.trim()),
);
console.log("multi-slot:", JSON.stringify(extraction), slotRows.length, "slots");
if (extraction !== "aop") throw new Error(`bad extraction: ${extraction}`);
if (slotRows.length !== 3) throw new Error("wrong slot count");
// The assembled letters copy as one string.
await page.click("p.extraction");
const exClip2 = await page.evaluate(() => navigator.clipboard.readText());
if (exClip2 !== "aop") throw new Error(`extraction copy gave ${exClip2}`);

// Choosing a different candidate re-reads the extraction from it.
const second = await page.$$("table.slots tr:first-child span.cand");
if (second.length < 2) throw new Error("slot offered no alternatives");
const altText = (await second[1].textContent()).trim();
await second[1].click();
const altExtraction = await page.$eval("p.extraction", (e) => e.textContent);
console.log(`chose "${altText}" -> extraction ${altExtraction}`);
if (altExtraction === extraction) throw new Error("choice did not change extraction");
if (altExtraction[0] !== altText[0]) {
  throw new Error(`extraction ${altExtraction} does not start with ${altText}`);
}

// Slots without extraction just run the patterns and show the top matches.
await page.fill("#q", "<aaagmnr> ; solar s_stem");
await page.click("input[type=submit]");
await page.waitForFunction(
  () => document.getElementById("after")?.textContent?.includes("slots"),
  null,
  { timeout: 90000 },
);
if (await page.$("p.extraction")) throw new Error("extraction shown without {at}");
const plainRows = await page.$$eval("table.slots tr", (rs) =>
  rs.map((r) => r.cells[1].textContent.trim().split(" ")[0]),
);
console.log("slots without extraction:", JSON.stringify(plainRows));
if (plainRows[0] !== "anagram") throw new Error("slot did not run");

// Palindromes are a result filter, not an automaton: a length-n palindrome
// would need 26^(n/2) states, but one string check per candidate is free.
await page.fill("#q", "{palindrome:A{5}}");
await page.click("input[type=submit]");
await waitDone();
const pals = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 6).map((e) => e.firstChild.textContent),
);
console.log("palindromes:", JSON.stringify(pals));
if (pals.length === 0) throw new Error("no palindromes found");
for (const w of pals) {
  const s = w.replace(/ /g, "");
  if (s !== [...s].reverse().join("")) throw new Error(`not a palindrome: ${w}`);
}

// Corpus self-reference: every match must cut into words the index knows.
await page.fill("#q", "{compound 2:A{9}}");
await page.click("input[type=submit]");
await waitDone();
const compounds = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 8).map((e) => ({
    word: e.firstChild.textContent,
    split: e.querySelector(".from")?.textContent?.trim(),
  })),
);
console.log(
  "compound 2 (9 letters):",
  JSON.stringify(compounds.slice(0, 4).map((c) => `${c.word} = ${c.split}`)),
);
if (compounds.length === 0) throw new Error("no compounds found");
for (const c of compounds) {
  if (c.word.length !== 9 || c.word.includes(" ")) {
    throw new Error(`bad compound: ${c.word}`);
  }
  // The reported cut must be real: the pieces must rejoin to the word.
  if (!c.split || c.split.split("·").join("") !== c.word) {
    throw new Error(`split ${c.split} does not rejoin to ${c.word}`);
  }
}
// The filter must actually reject: plain A{9} has far more matches.
await page.fill("#q", "A{9}");
await page.click("input[type=submit]");
await waitDone();
const plain = (await page.$$("#results span.r")).length;
await page.fill("#q", "{compound 2:A{9}}");
await page.click("input[type=submit]");
await waitDone();
const filtered = (await page.$$("#results span.r")).length;
console.log(`compound filter: ${plain} -> ${filtered}`);
if (filtered >= plain) throw new Error("compound filter kept everything");
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();

// Full download -> disk mode -> WASM engine.
await page.click("#dlfull");
await waitInfo("device storage");
await waitDone();
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();
await waitInfo("WASM engine", 10000);
console.log("disk info:", await page.textContent("#indexinfo"));

// The picker marks a downloaded index as available offline.
await page.waitForFunction(() =>
  [...document.getElementById("indexpick").options].some(
    (o) => o.value === "./demo.index" && /on device/.test(o.textContent),
  ),
);
console.log(
  "picker offline tag:",
  await page.$eval("#indexpick", (s) =>
    [...s.options].find((o) => o.value === "./demo.index").textContent.trim(),
  ),
);

// Interrupt race: heavy query, interrupt with light one, then continue.
await page.fill("#q", "<aaeeiimnnorsttu>");
await page.click("input[type=submit]");
await page.waitForTimeout(300);
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await waitDone();
if ((await page.$eval("#results span", (e) => e.textContent)) !== "anagram") {
  throw new Error("interrupted search returned wrong results");
}
await (await page.$("#after button")).click();
await waitDone(30000);
const n = (await page.$$("#results span")).length;
console.log("after interrupt + continue:", n, "results");
if (n < 1500) throw new Error("continue after interrupt failed");

// Reload: disk copy persists, WASM engages on a fresh worker.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("solar s_stem"));
await waitDone();
console.log("reload first:", await page.$eval("#results span", (e) => e.textContent));
await waitInfo("device storage");

// Offline: with the app shell cached (service worker) and the index stored on
// the device (OPFS), a full reload works with no network at all.
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(async () =>
  (await caches.keys()).some((k) => k.startsWith("nutristatic-shell-")),
);
await page.context().setOffline(true);
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("solar s_stem"));
await waitInfo("device storage", 30000);
await waitDone(30000);
const offlineFirst = await page.$eval("#results span", (e) => e.textContent);
console.log("offline reload first:", offlineFirst);
if (offlineFirst !== "solar system") throw new Error("offline search failed");
// The side datasets were cached earlier, so meaning and rhyme work offline too.
await page.fill("#q", "{like:reluctant}&A{5}&l....");
await page.click("input[type=submit]");
await waitDone(30000);
const offlineMeaning = await page.$$eval("#results span.r", (els) =>
  els.map((e) => e.textContent),
);
console.log("offline {like:…}:", JSON.stringify(offlineMeaning));
if (!offlineMeaning.includes("loath")) throw new Error("offline thesaurus failed");
await page.context().setOffline(false);

// Remove the device copy: back to range mode, query re-runs.
await page.click("#dlfull");
await waitInfo("loading only");
await waitDone();
console.log("after remove:", await page.textContent("#indexinfo"), "|", await page.textContent("#dlfull"));

// Removing the copy clears the "on device" tag in the picker.
await page.waitForFunction(() =>
  [...document.getElementById("indexpick").options].every(
    (o) => o.value !== "./demo.index" || !/on device/.test(o.textContent),
  ),
);
console.log("picker tag cleared after remove");

// Resumable download: interrupt a whole-index download partway, then resume.
// Force the plain-range path (block the sidecar) so piece offsets are
// predictable, and fail every piece at/after 8 MB on the first attempt.
let allowAll = false;
await page.route("**/demo.index.idxz*", (route) => route.abort());
await page.route("**/demo.index", (route) => {
  if (allowAll) return route.continue();
  const m = /bytes=(\d+)-/.exec(route.request().headers().range || "");
  const off = m ? +m[1] : 0;
  return off >= 8 * 1024 * 1024 ? route.abort() : route.continue();
});
await page.click("#dlfull"); // start download -> fails past 8 MB -> partial kept
await page.waitForFunction(
  () => /resume download \(\d+%\)/.test(document.getElementById("dlfull").textContent),
  null,
  { timeout: 60000 },
);
const resumeLabel = await page.textContent("#dlfull");
console.log("partial:", resumeLabel, "| discard:", await page.textContent("#dlremove"));
if ((await page.getAttribute("#dlremove", "hidden")) !== null) {
  throw new Error("discard-partial button not shown");
}
allowAll = true; // network back
await page.click("#dlfull"); // resume from the partial -> completes to disk
await waitInfo("device storage");
console.log("after resume:", await page.textContent("#indexinfo"));
await page.unroute("**/demo.index");
await page.unroute("**/demo.index.idxz*");
await page.click("#dlfull"); // clean up the device copy
await waitInfo("loading only");

// A mistyped constraint names itself and suggests the real one.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("{sumx=100:A*}"));
await page.waitForFunction(
  () => document.getElementById("status").className === "error",
  null,
  { timeout: 60000 },
);
const typo = await page.textContent("#status");
console.log("typo help:", typo);
if (!/did you mean "sum"/.test(typo)) throw new Error("no suggestion offered");

// Parse error.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("((("));
await page.waitForFunction(
  () => document.getElementById("status").className === "error",
  null,
  { timeout: 60000 },
);
console.log("parse error:", await page.textContent("#status"));

// Clicking a result explains it, per conjunct, using the source the engine
// threw away: {del1:cat} finding CAT-minus-a-letter should name the letter.
// The explanation used to have its own "why?" button beside every result;
// the click now belongs to the result itself, which also still copies.
await page.goto(
  base + "?index=./demo.index&q=" + encodeURIComponent("{sum=52:A*}&A{5}"),
);
await page.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0,
  null, { timeout: 60000 });
await page.click("#results span.r");
await page.waitForSelector("#results .why-box", { timeout: 30000 });
const why = (await page.textContent("#results .why-box")).replace(/\s+/g, " ").trim();
console.log("why:", why);
if (!/letters total 52/.test(why)) throw new Error("no per-conjunct explanation");
if (!/A\{5\}/.test(why)) throw new Error("second conjunct missing from explanation");
// Clicking again closes it.
await page.click("#results span.r");
if (await page.$("#results .why-box")) throw new Error("why-box did not toggle shut");
console.log("why toggles shut");
if (await page.$("#results button.why")) throw new Error("the why button is back");

// {compound} must ask "is this a word", not "is this in the corpus". The
// frequency floor that separates the two reaches the predicate through an
// adapter in the worker, and that adapter once dropped it silently — unit
// tests call the checker directly and so could not see it. This asserts the
// whole browser path: AVAILABLE cut into "avai"+"lable" is the symptom.
await page.goto(
  base + "?index=./demo.index&q=" + encodeURIComponent("{compound 2:A{9}}"),
);
await page.waitForFunction(() => document.querySelectorAll("#results span.r").length >= 5,
  null, { timeout: 90000 });
const cuts = await page.$$eval("#results span.r", (es) =>
  es.slice(0, 12).map((e) => e.textContent.trim()));
console.log("compound cuts:", cuts.slice(0, 4).join(" | "));
const debris = cuts.filter((c) => /avai|lable|educ·|·ation|^\w ·|·\w$/.test(c));
if (debris.length > 0) {
  throw new Error(`compound cut into corpus debris: ${debris.join(", ")}`);
}
if (!cuts.some((c) => /copy·right/.test(c))) {
  throw new Error("compound lost the real compounds too");
}
console.log("compound pieces are words, not corpus debris");

// A pattern that cannot match anything must say so instead of spending the
// whole step budget discovering it and then offering to spend it again.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("A{5}&A{6}"));
await page.waitForFunction(
  () => document.getElementById("after").textContent.trim().length > 0,
  null, { timeout: 60000 });
const impossible = (await page.textContent("#after")).replace(/\s+/g, " ").trim();
console.log("impossible pattern:", impossible);
if (!/cannot both be true/.test(impossible)) {
  throw new Error(`no contradiction explanation: ${impossible}`);
}
if (!/A\{5\}/.test(impossible) || !/A\{6\}/.test(impossible)) {
  throw new Error(`the conflicting parts are not named: ${impossible}`);
}
if (/Try harder/.test(impossible)) {
  throw new Error("offered to try harder on a pattern that can never match");
}

// Typing a list name must offer the *harvested* catalogue, not just the few
// lists compiled into the bundle. The catalogue used to arrive only as a side
// effect of running a query that used one, so a fresh page suggested nothing
// for "{list:pok" with pokemon in the catalogue the whole time.
await page.goto(base + "?index=./demo.index");
await page.waitForSelector("#q", { timeout: 30000 });
await page.click("#q");
await page.fill("#q", "");
await page.type("#q", "{list:pok", { delay: 15 });
try {
  await page.waitForSelector("#ac li", { timeout: 30000 });
} catch {
  // No menu at all is the exact symptom of the catalogue never being asked
  // for: nothing built into the bundle starts with "pok".
  throw new Error('no completions for "{list:pok" — the harvested catalogue was never fetched');
}
const listNames = await page.$$eval("#ac li", (es) =>
  es.map((e) => e.textContent.trim()));
console.log("harvested list completions:", listNames.slice(0, 3).join(" | "));
if (!listNames.some((t) => /pokemon/i.test(t))) {
  throw new Error(`no harvested list suggested for "{list:pok": ${listNames.join(", ")}`);
}

// A harvested list: not in the bundle, so the worker has to fetch the
// catalogue before it can compile the query at all.
await page.goto(
  base + "?index=./demo.index&q=" + encodeURIComponent("{list:romandeities}&A{4}"),
);
await page.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0,
  null, { timeout: 60000 });
const deities = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 3).map((e) => e.dataset.match));
console.log("harvested list:", JSON.stringify(deities));
if (!deities.includes("mars")) throw new Error("catalogue list did not resolve");

// An unknown name names the closest real one rather than shrugging.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("{list:romandeity}"));
await page.waitForFunction(
  () => document.getElementById("status").className === "error", null, { timeout: 60000 });
const listErr = await page.textContent("#status");
console.log("list suggestion:", listErr.trim());
if (!/did you mean "romandeities"/.test(listErr)) throw new Error("no list suggestion");

// The catalogue page lists them.
await page.goto(base + "lists.html");
await page.waitForFunction(
  () => /\d+ of \d+ lists/.test(document.getElementById("count").textContent),
  null, { timeout: 30000 });
console.log("catalogue page:", (await page.textContent("#count")).trim());

// Autocomplete and inline checking in the query box.
await page.goto(base + "?index=./demo.index");
await page.waitForSelector("#q", { timeout: 60000 });
await page.click("#q");
await page.fill("#q", "");
await page.type("#q", "{ci", { delay: 20 });
await page.waitForSelector("#ac li", { timeout: 30000 });
const acOpts = await page.$$eval("#ac li .name", (els) => els.map((e) => e.textContent));
console.log("completions for {ci:", JSON.stringify(acOpts.slice(0, 4)));
if (!acOpts.some((o) => o.startsWith("cipher."))) {
  throw new Error("group completion missing");
}
// Enter takes the highlighted completion rather than submitting.
await page.keyboard.press("Enter");
const afterComplete = await page.inputValue("#q");
console.log("after Enter:", afterComplete);
if (!afterComplete.startsWith("{cipher.")) throw new Error("completion not inserted");

// A broken query is flagged as you type, by the engine's own parser.
await page.fill("#q", "");
await page.type("#q", "{zzz:A*}", { delay: 10 });
await page.waitForFunction(
  () => !document.getElementById("qerr").hidden, null, { timeout: 30000 });
const qerr = (await page.textContent("#qerr")).trim();
console.log("inline error:", qerr);
if (!/no such constraint/.test(qerr)) throw new Error("no inline syntax error");
if (!(await page.$("#q.bad"))) throw new Error("input not marked invalid");

// …and cleared once it is valid again.
await page.fill("#q", "");
await page.type("#q", "A{5}", { delay: 10 });
await page.waitForFunction(
  () => document.getElementById("qerr").hidden, null, { timeout: 30000 });
console.log("inline error cleared on a valid query");

// Stacked result filters mean AND, in the browser as in the CLI.
await page.goto(
  base + "?index=./demo.index&q=" +
    encodeURIComponent("{palindrome:{syllables=1:A{3}}}"),
);
await page.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0,
  null, { timeout: 90000 });
const stacked = await page.$$eval("#results span.r", (els) =>
  els.slice(0, 3).map((e) => e.textContent));
console.log("stacked filters:", JSON.stringify(stacked));
if (!stacked.some((t) => /syll/.test(t))) {
  throw new Error("stacked filter lost its annotation");
}

// ?debug=1 shows what the search cost.
await page.goto(
  base + "?index=./demo.index&debug=1&q=" + encodeURIComponent("A{5}"),
);
await page.waitForFunction(
  () => { const e = document.getElementById("stats"); return e && !e.hidden; },
  null, { timeout: 60000 });
const statsText = (await page.textContent("#stats")).replace(/\s+/g, " ").trim();
console.log("debug panel:", statsText.slice(0, 90));
if (!/steps: [\d,]+/.test(statsText)) throw new Error("no step count in debug panel");
if (!/results: [\d,]+/.test(statsText)) throw new Error("no result count");
// The plan follows the stats in the same panel.
await page.waitForFunction(
  () => /conjunct/.test(document.getElementById("stats").textContent),
  null, { timeout: 30000 });
const planText = (await page.textContent("#stats .plan")).replace(/\s+/g, " ").trim();
console.log("debug plan:", planText.slice(0, 80));
if (!/conjunct/.test(planText)) throw new Error("no plan in debug panel");

// …and stays out of the way without it.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("A{5}"));
await page.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0,
  null, { timeout: 60000 });
if (await page.$("#stats:not([hidden])")) throw new Error("debug panel shown without ?debug=1");
console.log("debug panel hidden by default");

// Dark mode: the menu and the explanation must be legible, not merely
// present. Fixed greys passed every existing assertion while being invisible.
const dark = await browser.newContext({ colorScheme: "dark" });
const dpage = await dark.newPage();
await dpage.goto(base + "?index=./demo.index&q=" + encodeURIComponent("A{5}"));
await dpage.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0,
  null, { timeout: 60000 });

/** Relative luminance of a computed "rgb(r, g, b)" colour. */
const lum = (css) => {
  const [r, g, b] = css.match(/\d+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const pageBg = await dpage.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log("dark page background:", pageBg);

await dpage.click("#results span.r");
await dpage.waitForSelector("#results .why-box", { timeout: 30000 });
const whyColor = await dpage.$eval("#results .why-box", (e) => getComputedStyle(e).color);
console.log("dark why-box text:", whyColor);
if (lum(whyColor) < 0.5) throw new Error(`why-box text is dark on dark: ${whyColor}`);

// From a fresh page, not from the results view: opening the explanation above
// inserts a box into #results and moves everything below it, and doing the
// menu check on top of that made this flaky — it passed about one run in
// three. The menu's colours are what is under test, and they do not depend on
// what happened before.
await dpage.goto(base + "?index=./demo.index");
await dpage.waitForSelector("#q", { timeout: 30000 });
await dpage.click("#q");
await dpage.fill("#q", "");
await dpage.type("#q", "{ci", { delay: 20 });
await dpage.waitForSelector("#ac li", { timeout: 30000 });
const menu = await dpage.$eval("#ac", (e) => {
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, fg: s.color };
});
console.log("dark menu:", JSON.stringify(menu));
if (Math.abs(lum(menu.bg) - lum(menu.fg)) < 0.3) {
  throw new Error(`menu has no contrast in dark mode: ${JSON.stringify(menu)}`);
}
await dark.close();
console.log("dark mode OK");

await browser.close();
console.log("BROWSER TEST OK");
