// Local end-to-end browser test against `vite preview web --port 4517`.
// Uses the dist-bundled demo index (the default en-wiki.index is not in
// dist). Covers: range mode + compressed download-size label, searching on
// the JS engine, full download -> OPFS disk mode -> WASM engine, reload
// persistence, the interrupt-then-continue race, remove-device-copy, and
// parse errors. Exits non-zero on any failure.
import { chromium } from "playwright-core";

const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
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

// Parse error.
await page.goto(base + "?index=./demo.index&q=" + encodeURIComponent("((("));
await page.waitForFunction(
  () => document.getElementById("status").className === "error",
  null,
  { timeout: 60000 },
);
console.log("parse error:", await page.textContent("#status"));

await browser.close();
console.log("BROWSER TEST OK");
