import { chromium } from "playwright-core";
import { chromiumPath } from "./scripts/chromium-path.mjs";
const b = await chromium.launch({ executablePath: await chromiumPath() });
const p = await b.newPage();
let net = 0;
p.on("response", (r) => { const h = r.headers()["content-length"]; if (h && r.url().includes(".idxz")) net += +h; });
await p.goto("https://nutristatic.org/9000/?debug=1&q=" + encodeURIComponent('"C*aC*eC*iC*oC*uC*yC*"'), { waitUntil: "domcontentloaded" });
try { await p.waitForFunction(() => /reaches deep|No results|Nothing can/.test(document.getElementById("after").textContent)
  || document.querySelectorAll("#results span.r").length > 0, null, { timeout: 60000 }); } catch {}
const stats = (await p.textContent("#stats")).replace(/\s+/g, " ").trim();
console.log("worker stats:", stats.slice(0, 300));
console.log("network on .idxz:", (net/1e6).toFixed(1), "MB");
await b.close();
