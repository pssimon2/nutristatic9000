import {
  ExtractError,
  type ExtractSpec,
  type RankSpec,
  applyExtract,
  parseExtract,
  parseRank,
} from "../src/extract-spec.js";

// UI thread: form handling, URL state (?q=...&comp=...&index=...), and
// rendering of streamed results — mirroring the upstream CGI's pages, but
// with the search running in a Web Worker in the visitor's browser.

const MAX_COMPUTATION = 1000000; // local step budget (same default as upstream)
// Range mode: step count is a poor proxy for cost (a cached step is free, a
// fetched step is a network round-trip), so cap on bytes fetched and elapsed
// time instead. The step count is just a safety ceiling remotely.
const RANGE_BYTE_BUDGET = 32 * 1024 * 1024; // ~32 MB fetched per run…
const RANGE_TIME_MS = 20000; //               …or ~20 s, whichever comes first
const RANGE_STEP_CEILING = 8000000;
const PER_RUN_RESULTS = 1000;

const BUNDLED_INDEXES: Array<[string, string]> = [
  ["/en-wiki.index", "English Wikipedia (1.3 GB)"],
  ["/de-wiki.index", "German Wikipedia – Deutsch (591 MB)"],
  ["/fr-wiki.index", "French Wikipedia – Français (491 MB)"],
  ["/es-wiki.index", "Spanish Wikipedia – Español (436 MB)"],
  ["/it-wiki.index", "Italian Wikipedia – Italiano (360 MB)"],
  ["/pt-wiki.index", "Portuguese Wikipedia – Português (255 MB)"],
  ["/nl-wiki.index", "Dutch Wikipedia – Nederlands (222 MB)"],
  ["/pl-wiki.index", "Polish Wikipedia – Polski (216 MB)"],
  ["/sv-wiki.index", "Swedish Wikipedia – Svenska (199 MB)"],
  ["/ca-wiki.index", "Catalan Wikipedia – Català (173 MB)"],
  ["/id-wiki.index", "Indonesian Wikipedia – Bahasa Indonesia (123 MB)"],
  ["/cs-wiki.index", "Czech Wikipedia – Čeština (113 MB)"],
  ["/hu-wiki.index", "Hungarian Wikipedia – Magyar (107 MB)"],
  ["/no-wiki.index", "Norwegian Wikipedia – Norsk (Bokmål) (102 MB)"],
  ["/ro-wiki.index", "Romanian Wikipedia – Română (101 MB)"],
  ["/tr-wiki.index", "Turkish Wikipedia – Türkçe (88 MB)"],
  ["/fi-wiki.index", "Finnish Wikipedia – Suomi (85 MB)"],
  ["/da-wiki.index", "Danish Wikipedia – Dansk (51 MB)"],
  ["/eo-wiki.index", "Esperanto Wikipedia – Esperanto (51 MB)"],
  ["/sl-wiki.index", "Slovenian Wikipedia – Slovenščina (41 MB)"],
  ["/hr-wiki.index", "Croatian Wikipedia – Hrvatski (41 MB)"],
  ["/sk-wiki.index", "Slovak Wikipedia – Slovenčina (36 MB)"],
  ["/simple-wiki.index", "Simple English Wikipedia (41 MB)"],
  ["./demo.index", "web words + bigrams (20 MB)"],
];
const DEFAULT_INDEX = BUNDLED_INDEXES[0][0];

const EXAMPLES: Array<[string, string]> = [
  ['"C*aC*eC*iC*oC*uC*yC*"', "facetiously"],
  ["867-####", "for a good time call"],
  ['"_ ___ ___ _*burger"', "lol"],
  ["<aaagmnr>", "anagram"],
];

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const qInput = $<HTMLInputElement>("q");
const home = $("home");
const resultsView = $("resultsview");
const statusEl = $("status");
const resultsEl = $("results");
const afterEl = $("after");
const indexInfo = $("indexinfo");
const indexUrlInput = $<HTMLInputElement>("indexurl");
const indexPick = $<HTMLSelectElement>("indexpick");
const customRow = $("customrow");
const dlFull = $<HTMLButtonElement>("dlfull");
const dlRemove = $<HTMLButtonElement>("dlremove");
const dlMsg = $("dlmsg");

function setDlMsg(text: string): void {
  dlMsg.textContent = text;
  dlMsg.hidden = text === "";
}

const params = new URLSearchParams(location.search);
// Resolve against the page URL: the worker would otherwise resolve relative
// paths against its own script URL.
const indexUrl = new URL(params.get("index") || DEFAULT_INDEX, location.href)
  .href;
indexUrlInput.value = indexUrl;

for (const [value, label] of BUNDLED_INDEXES) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  opt.dataset.baseLabel = label; // preserved so the "on device" tag can toggle
  indexPick.append(opt);
}

// Tag the picker options that have a full copy stored on the device (searchable
// offline), from the worker's list of completed OPFS copies.
function annotateOfflineCopies(urls: Set<string>): void {
  for (const opt of Array.from(indexPick.options)) {
    if (opt.value === "custom" || !opt.dataset.baseLabel) continue;
    const abs = new URL(opt.value, location.href).href;
    opt.textContent = urls.has(abs)
      ? `${opt.dataset.baseLabel} ✓ on device`
      : opt.dataset.baseLabel;
  }
}
{
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "custom URL…";
  indexPick.append(custom);
}
const bundledMatch = BUNDLED_INDEXES.find(
  ([value]) => new URL(value, location.href).href === indexUrl,
);
indexPick.value = bundledMatch ? bundledMatch[0] : "custom";
customRow.hidden = indexPick.value !== "custom";

function navigateToIndex(url: string | null): void {
  const p = new URLSearchParams(location.search);
  const isDefault =
    !url ||
    new URL(url, location.href).href === new URL(DEFAULT_INDEX, location.href).href;
  if (isDefault) p.delete("index");
  else p.set("index", url!);
  location.search = p.toString() ? `?${p}` : "";
}

indexPick.addEventListener("change", () => {
  if (indexPick.value === "custom") {
    customRow.hidden = false;
    indexUrlInput.focus();
  } else {
    navigateToIndex(indexPick.value);
  }
});

// Populate examples, preserving a custom index in links.
const examplesEl = $("examples");
for (const [query, text] of EXAMPLES) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const p = new URLSearchParams();
  p.set("q", query);
  if (params.get("index")) p.set("index", params.get("index")!);
  a.href = `?${p}`;
  a.style.textDecoration = "none";
  a.textContent = query;
  li.append(a, ` - ${text}`);
  examplesEl.append(li);
}

// OFFLINE is a build-time constant: false in the served Vite build, true in
// the self-contained double-click build (scripts/build-offline.mjs). It gates
// the file-picker path and the inlined-worker creation so the online build is
// entirely unaffected.
declare const OFFLINE: boolean;
declare const __WORKER_CODE__: string; // injected by the offline generator

let worker: Worker;
if (OFFLINE) {
  // file:// forbids fetching a worker script; run the inlined worker code
  // from a Blob URL instead. Classic worker (the bundle is self-contained).
  worker = new Worker(
    URL.createObjectURL(new Blob([__WORKER_CODE__], { type: "text/javascript" })),
  );
} else {
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
}
// Without these, a worker that fails to boot (old browser, CSP, a stale
// asset after a redeploy) leaves the page silently stuck on "loading".
worker.onerror = (e) => {
  setStatus(`worker failed: ${e.message || "could not load search engine"}`, true);
};

// Cache the app shell so the site loads and searches run offline once an index
// has been stored on the device. Not in the offline single-file build (no
// server, and file:// forbids service workers).
if (!OFFLINE && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // No offline shell caching (unsupported or blocked); the site still works.
    });
  });
}
worker.onmessageerror = () => {
  setStatus("worker message error (please reload)", true);
};

let indexReady = false;
let indexMode: "memory" | "range" = "memory";
let offlineName = ""; // picked index file name (offline mode)
let pendingQuery: string | null = null;
let downloading = false; // an explicit whole-index download is in flight
let deviceCopy = false; // the loaded index is a device (OPFS) copy
let deviceCopyBytes = 0; // on-device size of that copy (for the delete prompt)
let downloadBytes = 0; // actual transfer size of "download whole index"
let resultCount = 0;
let currentComp = MAX_COMPUTATION;

const fmtMB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
// Human size for labels: whole MB, switching to GB above ~1000 MB.
const fmtSize = (b: number) =>
  b >= 999.5 * 1048576
    ? `${(b / 1073741824).toFixed(1)} GB`
    : `${Math.round(b / 1048576)} MB`;

function setStatus(text: string, isError = false): void {
  // Text prefix on errors: color alone doesn't reach screen readers or
  // color-blind users.
  statusEl.textContent = isError ? `⚠ ${text}` : text;
  statusEl.className = isError ? "error" : "";
}

function fontSize(score: number): number {
  let size: number;
  if (score >= 1.0) size = 1.5 + Math.log(score) / 5.0;
  else if (score > 0.0) size = 1.5 + Math.log(score) / 50.0;
  else size = 0;
  return Math.max(size, 0.4);
}

// Results arrive in descending frequency, and the index stores overlapping
// sliding windows of every phrase — so one underlying phrase can occupy a long
// run of consecutive slots ("dieses abschnittes wurde", "archivierung dieses
// abschnittes wurde", "abschnittes wurde gewuenscht", …), burying genuinely
// different answers below it. Hide a result when it is a contiguous run of
// words inside one already shown (or contains one), provided the shared text
// is substantial: "der" inside "in der" is coincidence, not repetition.
const MIN_OVERLAP_CHARS = 12;

let collapseVariants = true;
let lastDoneStatus = "";
// Literal text the query itself demands. Every result contains it, so it is
// not evidence of repetition: `.*administration.*` must not collapse its own
// matches into one.
let queryLiterals: string[] = [];
// Set when the query is wrapped in `{at …:…}`: results render as the picked
// letters rather than the whole match.
let extractSpec: ExtractSpec | null = null;
// The ciphertext of a lone unknown-shift `{caesar:…}`: each result is
// annotated with the shift that produced it. Without that the tool solves the
// puzzle and throws the answer away.
let caesarText: string | null = null;
// Set when the query is wrapped in `{rank …:…}`: a window into the ranked
// stream, so mid-frequency answers are reachable without scrolling.
let rankSpec: RankSpec | null = null;
let rawRank = 0; // engine results seen this search, before any filtering
let pageResults: Array<{ score: number; text: string }> = [];
let hiddenVariants = 0;
const shownRuns = new Set<string>(); // substantial word-runs inside shown texts

/**
 * Maximal literal runs in a pattern — plain letters/digits/spaces, ignoring
 * every metacharacter and class (`A`, `C`, `V`, `_`, `#` are uppercase or
 * punctuation and so never appear here).
 */
function literalsOf(pattern: string): string[] {
  return (pattern.match(/[a-z0-9 ]+/g) || [])
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_OVERLAP_CHARS);
}

/** Contiguous word-runs of `text` that are long enough to count as a match. */
function wordRuns(text: string): string[] {
  const w = text.split(" ");
  const out: string[] = [];
  for (let i = 0; i < w.length; ++i) {
    for (let j = i + 1; j <= w.length; ++j) {
      const run = w.slice(i, j).join(" ");
      if (run.length >= MIN_OVERLAP_CHARS) out.push(run);
    }
  }
  return out;
}

/**
 * True when `text` shares a substantial run of words with a result already on
 * screen — the signature of the same underlying phrase seen through a
 * different index window. Measured in characters, so it never fires on the
 * short results that fixed-length patterns produce (verified: zero hits on
 * `A*`, `A{8}` and anagram queries; 60 -> 24 results on a long-phrase query).
 */
function isVariantOfShown(text: string): boolean {
  for (const run of wordRuns(text)) {
    if (queryLiterals.some((lit) => lit.includes(run))) continue;
    if (shownRuns.has(run)) return true;
  }
  return false;
}

/** Which Caesar shift maps the query's ciphertext to `text`, if consistent. */
function shiftNote(text: string): string | null {
  if (caesarText === null) return null;
  const got = text.replace(/ /g, "");
  const src = caesarText.replace(/ /g, "");
  if (got.length !== src.length) return null;
  let shift: number | null = null;
  for (let i = 0; i < got.length; ++i) {
    const a = got.charCodeAt(i) - 97;
    const b = src.charCodeAt(i) - 97;
    if (a < 0 || a > 25 || b < 0 || b > 25) return null;
    const s = (a - b + 26) % 26;
    if (shift === null) shift = s;
    else if (shift !== s) return null;
  }
  return shift === null ? null : `caesar +${shift}`;
}

function renderResult(score: number, text: string): void {
  const span = document.createElement("span");
  span.className = "r";
  span.style.fontSize = `${fontSize(score)}em`;
  if (extractSpec) {
    const picked = applyExtract(extractSpec, text);
    if (picked === null) return; // match too short for these positions
    span.textContent = picked;
    span.dataset.copy = picked; // copy the extraction, not the source word
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = ` ${text}`;
    span.append(from);
  } else {
    span.textContent = text;
  }
  const note = shiftNote(text);
  if (note) {
    span.dataset.copy ??= text; // the note is annotation, not part of the answer
    const tag = document.createElement("span");
    tag.className = "from";
    tag.textContent = ` ${note}`;
    span.append(tag);
  }
  span.title = `score ${score.toPrecision(4)} · click to copy`;
  resultsEl.append(span, document.createElement("br"));
  ++resultCount;
  for (const run of wordRuns(text)) {
    if (!queryLiterals.some((lit) => lit.includes(run))) shownRuns.add(run);
  }
}

function addResult(score: number, text: string): void {
  ++rawRank;
  if (rankSpec && (rawRank < rankSpec.from || rawRank > rankSpec.to)) return;
  pageResults.push({ score, text });
  if (collapseVariants && isVariantOfShown(text)) {
    ++hiddenVariants;
    return;
  }
  renderResult(score, text);
}

/** Re-render the current results with every collapsed variant restored. */
function showAllVariants(): void {
  collapseVariants = false;
  resultsEl.textContent = "";
  resultCount = 0;
  hiddenVariants = 0;
  shownRuns.clear();
  for (const r of pageResults) renderResult(r.score, r.text);
  // Rebuild the same action area the search ended with (minus the now-spent
  // reveal button).
  afterEl.textContent = "";
  renderAfterSearch(lastDoneStatus);
}

function resetResultCollapsing(): void {
  rawRank = 0;
  collapseVariants = true;
  pageResults = [];
  hiddenVariants = 0;
  shownRuns.clear();
}

// Click a result to copy it (solvers copy answers constantly). Delegated from
// the container so 1000 results cost one listener, and deliberately invisible
// until used: no extra chrome, just the cursor, the title hint, and a brief
// flash on the word itself.
resultsEl.addEventListener("click", (ev) => {
  const span = (ev.target as HTMLElement | null)?.closest?.("span.r");
  if (!span || !resultsEl.contains(span)) return;
  // Don't hijack a drag-selection of the text.
  if (!(window.getSelection()?.isCollapsed ?? true)) return;
  const text = (span as HTMLElement).dataset.copy ?? span.textContent ?? "";
  if (!text) return;
  void navigator.clipboard?.writeText(text).then(
    () => {
      span.classList.add("copied");
      setTimeout(() => span.classList.remove("copied"), 500);
    },
    () => {
      // Clipboard blocked (permissions/insecure context): leave the text be.
    },
  );
});

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "linkish";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Match the index's text normalization in queries. The German index uses
 * the ae/oe/ue/ss digraph convention; all other corpora fold diacritics to
 * base letters (à→a, ñ→n, ç→c) with the œ→oe/æ→ae digraph exceptions.
 */
function transliterate(query: string): string {
  // Decide from the file name, not a substring of the whole URL (a custom
  // URL merely containing "de-wiki" in its path must not get German rules).
  // Offline uses the picked file's name; online the index URL's basename.
  const basename = OFFLINE
    ? offlineName
    : new URL(indexUrl).pathname.split("/").pop() ?? "";
  if (/^de[-_.]/.test(basename)) {
    return query
      .replace(/[äÄ]/g, "ae")
      .replace(/[öÖ]/g, "oe")
      .replace(/[üÜ]/g, "ue")
      .replace(/[ßẞ]/g, "ss");
  }
  return query
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/[ßẞ]/g, "ss")
    .replace(/[łŁ]/g, "l") // these four don't decompose under NFD
    .replace(/[ıİ]/g, "i")
    .replace(/[đĐ]/g, "d")
    .replace(/[øØ]/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// The step/byte/time budget for one run, by mode. Range mode caps on bytes
// and time (steps only ceiling); local caps on steps (comp).
function runBudget(): { maxSteps: number; byteBudget: number; timeMs: number } {
  if (indexMode === "range") {
    return { maxSteps: RANGE_STEP_CEILING, byteBudget: RANGE_BYTE_BUDGET, timeMs: RANGE_TIME_MS };
  }
  return { maxSteps: currentComp, byteBudget: 0, timeMs: 0 };
}

function startSearch(query: string): void {
  resultsEl.textContent = "";
  afterEl.textContent = "";
  resultCount = 0;
  resetResultCollapsing();
  // `{at …:…}` is an output wrapper: strip it here so the engine only ever
  // sees the pattern itself.
  let pattern = transliterate(query);
  extractSpec = null;
  rankSpec = null;
  try {
    const extract = parseExtract(pattern);
    if (extract) {
      extractSpec = extract.spec;
      pattern = extract.inner;
    }
    const rank = parseRank(pattern);
    if (rank) {
      rankSpec = rank.spec;
      pattern = rank.inner;
    }
  } catch (e) {
    setStatus(e instanceof ExtractError ? e.message : String(e), true);
    return;
  }
  // Only a lone unknown-shift caesar can be annotated unambiguously.
  const caesars = pattern.match(/\{\s*caesar\s*:([a-z ]+)\}/gi) ?? [];
  caesarText =
    caesars.length === 1
      ? /\{\s*caesar\s*:([a-z ]+)\}/i.exec(caesars[0])![1].trim()
      : null;
  queryLiterals = literalsOf(pattern);
  // Local step budget from the live URL's comp (not the load-time snapshot) so
  // back/forward through raised-budget entries picks up the right value.
  currentComp =
    parseInt(new URLSearchParams(location.search).get("comp") || "", 10) ||
    MAX_COMPUTATION;
  setStatus("searching…");
  worker.postMessage({
    type: "search",
    query: pattern,
    // A rank window has to be reached before it can be shown; ask the engine
    // for enough results to cover it (bounded, so a huge "to" can't run away).
    maxResults: rankSpec
      ? Math.min(Math.max(rankSpec.to, rankSpec.from + PER_RUN_RESULTS), 20000)
      : PER_RUN_RESULTS,
    ...runBudget(),
  });
}

function tryHarder(): void {
  afterEl.textContent = "";
  if (indexMode === "range") {
    // Range mode isn't step-budgeted; "keep searching" just runs another
    // bytes/time window over the network from where it left off.
    setStatus("searching…");
    worker.postMessage({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
    return;
  }
  currentComp *= 2;
  // Reflect the raised budget in the URL like nutrimatic.org's ?comp=N, so
  // the "tried harder" state is shareable and reloadable. pushState (not
  // replace) so Back returns to the lower budget. Skipped offline: a file://
  // URL isn't shareable and some browsers reject pushState on it.
  if (!OFFLINE) {
    const p = new URLSearchParams(location.search);
    p.set("comp", String(currentComp));
    history.pushState(null, "", `?${p}`);
  }
  setStatus("searching harder…");
  worker.postMessage({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
}

function moreResults(): void {
  afterEl.textContent = "";
  setStatus("fetching more results…");
  worker.postMessage({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
}

worker.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "loading":
      if (msg.mode === "download") {
        indexInfo.textContent = msg.cached
          ? `${fmtMB(msg.bytes)} (from browser cache)`
          : `downloading… ${fmtMB(msg.loaded ?? 0)} / ${fmtMB(msg.bytes)}`;
      } else {
        indexInfo.textContent = `probing (${fmtMB(msg.bytes)}, range mode)…`;
      }
      break;
    case "ready":
      indexReady = true;
      downloading = false;
      deviceCopy = msg.mode === "disk";
      indexMode = msg.mode === "range" ? "range" : "memory";
      // Flag device copies so the next page load skips the early sidecar
      // table fetch (see the inline <head> script).
      try {
        if (msg.mode === "disk") {
          localStorage.setItem(`nutristatic-disk:${indexUrl}`, "1");
        } else {
          localStorage.removeItem(`nutristatic-disk:${indexUrl}`);
        }
      } catch {
        // no localStorage (private mode): purely an optimization
      }
      dlRemove.hidden = true; // only shown alongside a resumable partial
      if (msg.mode === "local") {
        // Offline: index read from the picked local file, no server.
        indexInfo.textContent = `${offlineName} · ${fmtSize(msg.bytes)} (local file)`;
        dlFull.hidden = true;
      } else if (msg.mode === "disk") {
        deviceCopyBytes = msg.bytes;
        setDlMsg(""); // a copy is present: clear any prior failure notice
        indexInfo.textContent = `${fmtSize(msg.bytes)} on device storage`;
        dlFull.textContent = "remove device copy »";
        dlFull.disabled = false;
        dlFull.hidden = false;
      } else if (msg.mode === "memory") {
        indexInfo.textContent = `${fmtSize(msg.bytes)} in memory${msg.cached ? " (from cache)" : ""}`;
        dlFull.hidden = true;
      } else {
        indexInfo.textContent = `${fmtSize(msg.bytes)}, loading only what's needed`;
        // Show what the download actually transfers (compressed sidecar),
        // not the uncompressed index size.
        downloadBytes = msg.downloadBytes ?? msg.bytes;
        if (msg.partial) {
          // A prior whole-index download was interrupted: offer to resume it
          // (or discard the partial) instead of starting over.
          const pct = Math.min(99, Math.floor((msg.partial.loaded / msg.partial.total) * 100));
          dlFull.textContent = `resume download (${pct}%) »`;
          dlRemove.textContent = "discard partial »";
          dlRemove.hidden = false;
        } else {
          dlFull.textContent = `download whole index (${fmtSize(downloadBytes)}) »`;
        }
        dlFull.disabled = false;
        dlFull.hidden = false;
      }
      if (pendingQuery !== null) {
        const q = pendingQuery;
        pendingQuery = null;
        startSearch(q);
      }
      // Refresh which indexes are marked available offline (a copy may have
      // just been added or removed).
      if (!OFFLINE) worker.postMessage({ type: "list-copies" });
      break;
    case "copies":
      annotateOfflineCopies(new Set(msg.urls));
      break;
    case "result":
      addResult(msg.score, msg.text);
      break;
    case "progress":
      setStatus(`searching… (${(msg.steps / 1e6).toFixed(1)}M steps)`);
      if (msg.fetched !== undefined) {
        indexInfo.textContent = `${fmtMB(msg.fetched)} fetched so far`;
      }
      break;
    case "parse-error":
      setStatus(`can't parse "${msg.rest}"`, true);
      break;
    case "download-error": {
      // The index that was loaded before the download is still usable; a
      // "ready" re-post follows and restores the rest of the UI state.
      downloading = false;
      const cancelled = /cancel/i.test(msg.message);
      setStatus(cancelled ? "download cancelled" : `download failed: ${msg.message}`, !cancelled);
      // Also surface it right by the button — on a phone the status line is
      // scrolled far above, so otherwise the button just seems to flash back.
      setDlMsg(cancelled ? "" : `⚠ download failed: ${msg.message}`);
      // A real failure must stay readable: don't let the auto-restarted
      // search overwrite it in the same tick (the user can just resubmit).
      if (!cancelled) pendingQuery = null;
      break;
    }
    case "error":
      setStatus(`error: ${msg.message}`, true);
      if (!indexReady) {
        // Index load failed (flaky connection?): offer a clean retry.
        indexInfo.textContent = "load failed";
        afterEl.textContent = "";
        afterEl.append(
          actionButton("Retry loading index »", () => {
            afterEl.textContent = "";
            setStatus("loading index…");
            const q = qInput.value.trim();
            if (q) pendingQuery = q;
            worker.postMessage({ type: "open", url: indexUrl });
          }),
        );
      }
      break;
    case "done":
      setStatus("");
      if (msg.engine === "wasm" && !indexInfo.textContent!.includes("WASM")) {
        indexInfo.textContent += " · WASM engine";
      }
      lastDoneStatus = msg.status;
      renderAfterSearch(msg.status);
      break;
  }
};

/** The action area under the results, rebuilt when collapsed variants are shown. */
function renderAfterSearch(status: string): void {
  {
      if (status === "exhausted") {
        afterEl.textContent =
          resultCount > 0 ? "No more results found." : "No results found, sorry.";
      } else if (status === "limit") {
        if (indexMode === "range") {
          // Range mode stopped on its bytes/time budget: this query reaches
          // deep into the index, which is slow to stream piece by piece. The
          // real fix is a local copy — lead with that; keep-searching is the
          // secondary option (each click fetches another window).
          afterEl.textContent =
            "This search reaches deep into the index — slow to stream over the network. ";
          if (!dlFull.hidden) {
            afterEl.append(
              actionButton(
                `Download it once (${fmtSize(downloadBytes)}) for instant results »`,
                startFullDownload,
              ),
              document.createElement("br"),
            );
          }
          afterEl.append(
            actionButton("or keep searching over the network »", tryHarder),
          );
        } else {
          afterEl.textContent = "Computation limit reached.";
          afterEl.append(
            actionButton(
              currentComp > MAX_COMPUTATION ? "Try even harder »" : "Try harder »",
              tryHarder,
            ),
          );
        }
      } else {
        // Result budget filled; offer the next page.
        afterEl.append(actionButton("More results »", moreResults));
      }
  }
  // Offer to restore anything hidden as a near-duplicate of a shown result.
  if (collapseVariants && hiddenVariants > 0) {
    afterEl.append(
      document.createElement("br"),
      actionButton(
        `show ${hiddenVariants} similar result${hiddenVariants === 1 ? "" : "s"} »`,
        showAllVariants,
      ),
    );
  }
}

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const query = qInput.value.trim();
  // Offline (file://): don't touch history — the URL isn't shareable and
  // pushState can be rejected; just run the query.
  if (!OFFLINE) {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (params.get("index")) p.set("index", params.get("index")!);
    history.pushState(null, "", query ? `?${p}` : location.pathname);
  }
  applyQuery(query);
});

$("setindex").addEventListener("click", () => {
  navigateToIndex(indexUrlInput.value.trim() || null);
});

function startFullDownload(): void {
  if (downloading) return;
  // Cancels any running search; the current query re-runs once downloaded.
  downloading = true;
  dlFull.textContent = "cancel download »";
  dlRemove.hidden = true;
  setDlMsg("");
  const q = qInput.value.trim();
  if (q && !resultsView.hidden) pendingQuery = q;
  setStatus("");
  afterEl.textContent = "";
  indexReady = false;
  worker.postMessage({ type: "download-full" });
}

// Discard a resumable partial download and return to plain range mode.
dlRemove.addEventListener("click", () => {
  const q = qInput.value.trim();
  if (q && !resultsView.hidden) pendingQuery = q;
  indexReady = false;
  dlRemove.hidden = true;
  dlFull.disabled = true;
  setStatus("");
  setDlMsg("");
  afterEl.textContent = "";
  worker.postMessage({ type: "remove-copy" });
});

dlFull.addEventListener("click", () => {
  if (downloading) {
    worker.postMessage({ type: "cancel-download" });
  } else if (deviceCopy) {
    // Deleting a finished copy discards a large, slow-to-refetch download:
    // confirm first.
    if (
      !confirm(
        `Remove the device copy of this index (${fmtSize(deviceCopyBytes)})? ` +
          `You'll go back to searching over the network, and re-downloading ` +
          `it takes a while.`,
      )
    ) {
      return;
    }
    // Free the device copy and fall back to network mode. Any running query
    // is cancelled by the reopen; re-run it once the index is back.
    const q = qInput.value.trim();
    if (q && !resultsView.hidden) pendingQuery = q;
    indexReady = false;
    dlFull.disabled = true;
    setStatus("");
    afterEl.textContent = ""; // old Try-harder buttons target a dead session
    worker.postMessage({ type: "remove-copy" });
  } else {
    startFullDownload();
  }
});

function applyQuery(query: string): void {
  if (query) {
    qInput.value = query;
    document.title = `${query} - Nutristatic 9000`;
    home.hidden = true;
    resultsView.hidden = false;
    if (indexReady) startSearch(query);
    else {
      pendingQuery = query;
      setStatus("loading index…");
    }
  } else {
    document.title = "Nutristatic 9000";
    home.hidden = false;
    resultsView.hidden = true;
    worker.postMessage({ type: "stop" });
  }
}

window.addEventListener("popstate", () => {
  const p = new URLSearchParams(location.search);
  applyQuery((p.get("q") || "").trim());
});

async function postOpen(): Promise<void> {
  // Hand the worker whatever the inline <head> script already fetched
  // (probe + sidecar table): saves several round trips on cold loads.
  const early = (window as any).__earlyIndex;
  (window as any).__earlyIndex = null; // consume once
  if (early && early.url === indexUrl) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000));
    const settled = await Promise.race([
      Promise.all([early.probe, early.table]),
      timeout,
    ]);
    if (settled) {
      const [probe, table] = settled as [unknown, ArrayBuffer | null];
      worker.postMessage(
        { type: "open", url: indexUrl, early: { probe, table } },
        table ? [table] : [],
      );
      return;
    }
  }
  worker.postMessage({ type: "open", url: indexUrl });
}

/**
 * Offline bootstrap: no network probe. Replace the index picker with a file
 * chooser + drop target; opening a file hands it to the worker. Everything
 * downstream (form, results, try-harder) is the shared online code.
 */
function setupOffline(): void {
  // Reuse the index line: hide the URL picker, keep #indexinfo and #dlfull
  // (the shared handlers reference them), insert a file chooser.
  indexPick.hidden = true;
  customRow.hidden = true;
  const label = document.createElement("label");
  label.style.marginRight = "0.5em";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".index";
  label.append("file: ", input);
  indexPick.after(label);
  indexInfo.textContent = "choose a .index file (or drop one anywhere)";

  const openFile = (file: File): void => {
    offlineName = file.name;
    indexReady = false;
    indexInfo.textContent = `opening ${file.name}…`;
    worker.postMessage({ type: "open-file", file, name: file.name });
  };
  input.addEventListener("change", () => {
    if (input.files && input.files[0]) openFile(input.files[0]);
  });
  // Drag-and-drop anywhere on the page.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });
}

if (OFFLINE) {
  setupOffline();
  applyQuery((params.get("q") || "").trim());
} else {
  void postOpen();
  applyQuery((params.get("q") || "").trim());
}

// Put the cursor in the search box on arrival — but only with a real keyboard.
// On touch devices focusing pops the on-screen keyboard over the page, which
// is worse than one tap.
if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
  qInput.focus();
}
