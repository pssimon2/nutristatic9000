import { chromium } from "playwright-core";
import { chromiumPath } from "./scripts/chromium-path.mjs";
import fs from "node:fs";
const qs = JSON.parse(fs.readFileSync("/tmp/recipes.json", "utf8"));
const b = await chromium.launch({ executablePath: await chromiumPath() });
let bad = 0;
for (const q of qs) {
  const p = await b.newPage();
  let bytes = 0;
  p.on("response", (r) => { const h = r.headers()["content-length"]; if (h && /idxz|\.index/.test(r.url())) bytes += +h; });
  const t0 = Date.now();
  await p.goto("https://nutristatic.org/9000/?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
  let n = 0;
  try {
    await p.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0
      || /No results|reaches deep|Nothing can|No more/.test(document.getElementById("after").textContent), null, { timeout: 60000 });
    n = await p.$$eval("#results span.r", (e) => e.length);
  } catch {}
  const first = await p.$eval("#results span.r", (e) => e.textContent.trim()).catch(() => "");
  if (n === 0) ++bad;
  console.log(`${n === 0 ? "EMPTY " : "ok    "} ${q.slice(0, 30).padEnd(32)} ${String(Date.now()-t0).padStart(6)}ms ${(bytes/1e6).toFixed(0).padStart(4)}MB  ${first.slice(0, 22)}`);
  await p.close();
}
console.log(`\n${qs.length} recipes, ${bad} found nothing on the default index`);
await b.close();
