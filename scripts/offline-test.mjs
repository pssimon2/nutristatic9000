// End-to-end test of the self-contained double-click build: open the single
// file over file://, pick a local index, and search. That build is generated
// from the same sources with a flag flipped, so it breaks quietly — the
// worker is inlined as a Blob, there is no server, and anything that assumes
// a fetchable URL fails only here.
//
// usage: node scripts/offline-test.mjs [path/to/nutristatic-offline.html]
import { chromium } from "playwright-core";
import { chromiumPath } from "./chromium-path.mjs";
import path from "node:path";

const exe = await chromiumPath();
const file = path.resolve(
  process.argv[2] ?? "web/dist/nutristatic-offline.html",
);
const index = path.resolve("web/public/demo.index");

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto(`file://${file}`);
await page.setInputFiles("input[type=file]", index);
await page.waitForFunction(
  () => document.getElementById("indexinfo").textContent.includes("local file"),
  null,
  { timeout: 60000 },
);
console.log("index:", await page.textContent("#indexinfo"));

const settled = () =>
  page.waitForFunction(
    () =>
      document.getElementById("after")?.textContent?.length > 0 ||
      document.getElementById("status").className === "error",
    null,
    { timeout: 60000 },
  );

async function run(query) {
  await page.fill("#q", query);
  await page.click("input[type=submit]");
  await settled();
  const error = await page.$eval("#status", (e) =>
    e.className === "error" ? e.textContent : "",
  );
  const results = await page.$$eval("#results span.r", (els) =>
    els.slice(0, 3).map((e) => e.firstChild.textContent),
  );
  return { error, results };
}

// The engine, and the constructs that compile into it, must all work offline.
for (const [query, expected] of [
  ["<aaagmnr>", "anagram"],
  ["{sum=52:A*}&A{4}", "from"],
  ["{distinct:A{6}}", "search"],
  ["{del1:beast}", "best"],
  ["{t9:2665}", "book"],
]) {
  const { error, results } = await run(query);
  console.log(`  ${query} -> ${error || JSON.stringify(results)}`);
  if (error) throw new Error(`${query} failed: ${error}`);
  if (!results.includes(expected)) {
    throw new Error(`${query}: expected ${expected}, got ${results.join(",")}`);
  }
}

// The output wrappers were removed from the language: the offline build must
// refuse them the same way the site does.
const removed = await run("{at 1:<aaagmnr>}");
console.log(`  {at 1:…} -> ${removed.error || JSON.stringify(removed.results)}`);
if (!/no such constraint "at"/.test(removed.error ?? "")) {
  throw new Error("a removed wrapper should error as an unknown construct");
}

// The side datasets cannot be fetched from a file:// page. That must be said
// plainly rather than failing as a pattern error.
for (const query of ["{rhyme:tree}", "{like:reluctant}"]) {
  const { error } = await run(query);
  console.log(`  ${query} -> ${error}`);
  if (!/could not load/.test(error)) {
    throw new Error(`${query} should explain the missing dataset`);
  }
}

// The completion menu asks the worker for two things that only exist as
// fetched datasets: the harvested `{list:…}` catalogue and the 124,980
// `{kind:…}` names. Neither can be fetched from a file:// page, and the menu
// has to shrug rather than break — the lists compiled into the bundle must
// still complete, and nothing may throw.
await page.click("#q");
for (const [typed, expected] of [
  ["{list:gre", /greek/],   // built into the bundle: must still be offered
  ["{list:pok", null],      // harvested only: nothing, and no error
  ["{kind:bir", null],      // worker-side dataset: same
]) {
  await page.fill("#q", "");
  await page.type("#q", typed, { delay: 15 });
  await page.waitForTimeout(1200);
  const items = await page.$$eval("#ac li", (es) =>
    es.map((e) => e.textContent.trim()));
  console.log(`  ${typed} -> ${items.length ? items.slice(0, 2).join(", ") : "(none)"}`);
  if (expected && !items.some((t) => expected.test(t))) {
    throw new Error(`${typed} lost its built-in completions offline`);
  }
  if (!expected && items.length > 0) {
    throw new Error(`${typed} offered ${items[0]} with no dataset to offer it from`);
  }
}

await browser.close();
console.log("OFFLINE BUILD TEST OK");
