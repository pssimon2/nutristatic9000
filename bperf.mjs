import { chromium } from "playwright-core";
import { chromiumPath } from "./scripts/chromium-path.mjs";
const base = process.env.BASE ?? "http://localhost:4318";
const b = await chromium.launch({ executablePath: await chromiumPath() });
for (const q of ["<aaagmnr>", "{distinct:A{6}}"]) {
  const p = await b.newPage();
  let bytes = 0, n = 0;
  p.on("response", (r) => { const h = r.headers()["content-length"]; if (h && /idxz|\.index/.test(r.url())) { bytes += +h; ++n; } });
  const t0 = Date.now();
  await p.goto(`${base}/?index=https%3A%2F%2Fnutristatic.org%2Fen-wiki.index&q=` + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
  let ms = null;
  try { await p.waitForFunction(() => document.querySelectorAll("#results span.r").length > 0, null, { timeout: 90000 }); ms = Date.now() - t0; } catch {}
  console.log(`  ${q.padEnd(18)} ${String(ms ?? "none").padStart(6)}ms  ${n} reqs  ${(bytes/1e6).toFixed(1)} MB`);
  await p.close();
}
await b.close();
