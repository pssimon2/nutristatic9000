import {
  ExtractError,
  type ExtractSpec,
  type RankSpec,
  applyExtract,
} from "../src/extract-spec.js";
import type { EarlyProbe, InMsg, OutMsg } from "./worker/protocol.js";
import { type SlotPlan, planSlots } from "../src/slot-plan.js";
import { type Stats, formatStats } from "../src/stats.js";
import { OutputTransform } from "../src/output.js";
import { type Completion, completionsAt } from "../src/complete.js";
import type { WikiLists } from "../src/word-lists.js";

// UI thread: form handling, URL state (?q=...&comp=...&index=...), and
// rendering of streamed results — mirroring the upstream CGI's pages, but
// with the search running in a Web Worker in the visitor's browser.

const MAX_COMPUTATION = 1000000; // local step budget (same default as upstream)
// Range mode: step count is a poor proxy for cost (a cached step is free, a
// fetched step is a network round-trip), so cap on bytes fetched and elapsed
// time instead. The step count is just a safety ceiling remotely.
// Enough for the examples on the front page that a streamed search can answer
// at all. Measured against the 1.3 GB en-wiki index: `<aaagmnr>` needs ~44 MB
// to reach its first result, `867-####` needs 2. The two that need more —
// `"C*aC*eC*iC*oC*uC*yC*"` and `"_ ___ ___ _*burger"` — do not become
// answerable at 189 MB either, so no budget short of the whole index buys
// them, and the page offers that download instead. This was 32 MB when the
// cap was only consulted every 2,000 steps, i.e. when it was routinely
// overshot by 5x; enforcing it properly at 32 MB would have taken away
// answers people were getting.
const RANGE_BYTE_BUDGET = 64 * 1024 * 1024; // ~64 MB fetched per run…
const RANGE_TIME_MS = 20000; //               …or ~20 s, whichever comes first
/**
 * Give up on a first run that has stopped producing.
 *
 * Over a streamed index the top of the answer arrives from the head sidecar in
 * well under a second, and what the index adds after that varies enormously.
 * Measured on the deployed English index: `A{5}&C*` went from 77 results to
 * 1,027 over the following seventeen seconds, while `{palindrome:A{5}}` and
 * `A{7}&.*zz.*` spent the whole twenty-second budget adding nothing at all —
 * the walk was paying a round trip per region and finding none of them
 * relevant. A page that says "searching…" for twenty seconds and then shows
 * exactly what it showed at 0.8 s is worse than one that settles.
 *
 * So: stop when nothing has arrived for a while, rather than when the clock
 * runs out. The threshold is set from the productive case — `A{5}&C*`'s
 * longest gap between results before the flood was 3.9 s — with half again on
 * top, so the searches worth continuing are not cut off. "Keep searching" is
 * still there, and a reader who clicks it gets the full budget with no stall
 * cap at all.
 */
const RANGE_STALL_MS = 6000;

/**
 * The same, per slot in a multi-slot query.
 *
 * Shorter, because the arithmetic is different: a slot shows three candidates
 * in a picker, not a page of results, and the head sidecar has almost always
 * supplied those before the index is touched at all. What the walk adds after
 * that is a fourth candidate nobody has room for — and a hunt is a dozen
 * searches, so every second of stall is paid twelve times.
 *
 * Measured on the deployed index, a twelve-slot hunt took 21.4 s with the
 * six-second cap, of which two slots — a `{palindrome:…}` and an `A{7}&.*zz.*`
 * — spent thirteen seconds between them adding nothing. A slot that stopped
 * early still offers "search the unfinished slots harder", which restores the
 * full budget and no stall cap at all.
 */
const SLOT_STALL_MS = 2000;
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

// Bump when a side dataset is rebuilt: it versions their URLs, which is what
// makes a cached copy fall out of use.
const DATA_VERSION = "2";
const dataUrl = (file: string): string | null =>
  OFFLINE ? null : new URL(`./${file}?v=${DATA_VERSION}`, location.href).href;

/**
 * Where this index's head sidecar lives: beside the *page*, not beside the
 * index. The index files are shared between deployments — /en-wiki.index is
 * one file however many pages point at it — and the sidecar is per
 * deployment, so `/9000/en-wiki.head` sits with the page that knows about it.
 */
const headUrl = (): string | null => {
  if (OFFLINE) return null;
  const name = indexUrl.split("/").pop() ?? "";
  if (!name.endsWith(".index")) return null;
  return new URL(`./${name.slice(0, -".index".length)}.head`, location.href).href;
};

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

// The extension examples are static links; carry a custom index across them
// so clicking one doesn't silently switch corpus.
if (params.get("index")) {
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    '#home a[href^="?q="]',
  );
  for (const a of Array.from(anchors)) {
    const url = new URL(a.getAttribute("href")!, location.href);
    url.searchParams.set("index", params.get("index")!);
    a.setAttribute("href", `?${url.searchParams}`);
  }
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
/**
 * Every message to the worker goes through here, so the compiler checks the
 * wire shape against the one definition in worker/protocol.ts. The page used
 * to post bare literals that nothing validated.
 */
function postToWorker(msg: InMsg, transfer: Transferable[] = []): void {
  worker.postMessage(msg, transfer);
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
/** For `status: "empty"`: the written parts that cannot both hold. */
let lastConflict: string[] | null = null;
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
/**
 * The rank window and {at}, shared with the CLI; rebuilt per search. Starts as
 * a no-wrapper transform rather than null, so a result arriving before one is
 * built is shown rather than silently dropped.
 */
let output = new OutputTransform(null, null);
let pageResults: Array<{ score: number; text: string; note?: string }> = [];
let hiddenVariants = 0;
const shownRuns = new Set<string>(); // substantial word-runs inside shown texts
const shownLetters = new Set<string>(); // shown texts with the spaces taken out

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
  // Same letters, different word breaks. Word breaks are optional everywhere
  // in the language, so one answer arrives once per place a space could fall:
  // `nutr*` offers "nut", "n ut" and "nu t", and `solar s_stem` offers "solar
  // system", "so lar system" and "sola r system". The letters are the answer;
  // where the spaces land is a variant of it, and the best-scoring spelling
  // sorts first, so that is the one kept.
  if (text.includes(" ") && shownLetters.has(text.replaceAll(" ", ""))) {
    return true;
  }
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

function renderResult(score: number, text: string, note?: string): void {
  const span = document.createElement("span");
  span.className = "r";
  span.style.fontSize = `${fontSize(score)}em`;
  const picked = extractSpec ? applyExtract(extractSpec, text) : null;
  if (extractSpec) {
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
  const tagText = note ?? shiftNote(text);
  if (tagText) {
    span.dataset.copy ??= text; // the note is annotation, not part of the answer
    const tag = document.createElement("span");
    tag.className = "from";
    tag.textContent = ` ${tagText}`;
    span.append(tag);
  }
  span.title = `score ${score.toPrecision(4)} · click to copy and explain`;
  span.dataset.match = text;
  resultsEl.append(span, document.createElement("br"));
  ++resultCount;
  shownLetters.add(text.replaceAll(" ", ""));
  for (const run of wordRuns(text)) {
    if (!queryLiterals.some((lit) => lit.includes(run))) shownRuns.add(run);
  }
}

function addResult(score: number, text: string, note?: string): void {
  // The rank window and {at} are applied by the shared transform, so the
  // browser and the CLI cannot disagree about which result is rank N.
  const shown = output.apply(text);
  if (!shown) return;
  pageResults.push({ score, text, note });
  if (collapseVariants && isVariantOfShown(text)) {
    ++hiddenVariants;
    return;
  }
  renderResult(score, text, note);
}

/** Re-render the current results with every collapsed variant restored. */
function showAllVariants(): void {
  collapseVariants = false;
  resultsEl.textContent = "";
  resultCount = 0;
  hiddenVariants = 0;
  shownRuns.clear();
  shownLetters.clear();
  for (const r of pageResults) renderResult(r.score, r.text, r.note);
  // Rebuild the same action area the search ended with (minus the now-spent
  // reveal button).
  afterEl.textContent = "";
  renderAfterSearch(lastDoneStatus);
}

function resetResultCollapsing(): void {
  collapseVariants = true;
  pageResults = [];
  hiddenVariants = 0;
  shownRuns.clear();
  // Must be cleared with the rest: letters carried into the next search hide
  // that search's genuine answers, and the symptom is a later query in the
  // same session quietly collapsing results a fresh page shows.
  shownLetters.clear();
}

// Click a result to copy it (solvers copy answers constantly). Delegated from
// the container so 1000 results cost one listener, and deliberately invisible
// until used: no extra chrome, just the cursor, the title hint, and a brief
// flash on the word itself.
resultsEl.addEventListener("click", (ev) => {
  const cand = (ev.target as HTMLElement | null)?.closest?.("span.cand");
  if (cand && slots) {
    const slot = slots[+(cand as HTMLElement).dataset.slot!];
    if (slot) {
      slot.chosen = +(cand as HTMLElement).dataset.cand!;
      renderSlots();
    }
    return;
  }
  const span = (ev.target as HTMLElement | null)?.closest?.(
    "span.r, p.extraction",
  );
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
  // The same click also opens the explanation. These used to be two targets —
  // the result copied, a "why?" button beside it explained — which meant a
  // control sitting next to all 1,000 results for the rarer of the two
  // actions. One target loses nothing: copying is silent either way, and a
  // second click closes the box again.
  const match = (span as HTMLElement).dataset.match;
  if (match === undefined) return;
  const open = resultsEl.querySelector(
    `.why-box[data-match="${CSS.escape(match)}"]`,
  );
  if (open) {
    open.remove();
    return;
  }
  postToWorker({ type: "explain", text: match });
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
 *
 * This one stays in the page rather than moving to src/ with the rest of the
 * query handling, because it is not query-language knowledge: it is a property
 * of the index being searched, and it has to run *before* parsing. Which rule
 * applies is currently guessed from the index's file name, which is why it
 * cannot follow a custom index URL.
 *
 * TODO(F1: manifest): read the transliteration rules from the index's manifest
 * sidecar instead of pattern-matching its name.
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

/**
 * A first run's budget: the same, plus the stall cap. "Continue" deliberately
 * uses `runBudget` without it — see RANGE_STALL_MS.
 */
function firstRunBudget(): ReturnType<typeof runBudget> & { stallMs: number } {
  return { ...runBudget(), stallMs: indexMode === "range" ? RANGE_STALL_MS : 0 };
}

// Multi-slot: several patterns in one query, separated by ";". A hunt rarely
// has one slot — it has twelve answers and an extraction that reads a letter
// from each — and that is work solvers currently do by hand *between*
// queries. Each slot is an ordinary query (its own {at …} and all), run in
// turn, with the picked letters assembled into the answer string.
interface Slot {
  query: string;
  /** What the planner made of it: the pattern to search and its wrappers. */
  plan: SlotPlan;
  extract: ExtractSpec | null;
  results: Array<{ score: number; text: string }>;
  /** Which candidate feeds the extraction; the top one until told otherwise. */
  chosen: number;
  done: boolean;
  /** How the slot's search ended, which decides what an empty slot means. */
  status: string | null;
}
let slots: Slot[] | null = null;
let slotIndex = 0;
/**
 * Bytes fetched so far by this multi-slot query, across every slot.
 *
 * The range-mode budget is per *run*, and each slot is its own run, so a
 * three-slot query fetched 169 MB against a 64 MB cap and a twelve-slot one —
 * the size the usage guide describes as typical for a hunt — could fetch more
 * than downloading the whole index. What the reader asked for is one query;
 * it should cost about what one query costs.
 */
let slotBytesSpent = 0;
/** The source's lifetime byte count when this multi-slot query began. */
let slotBytesAtStart = 0;
/** Last lifetime byte count the worker reported, for the subtraction above. */
let lastFetchedBytes = 0;
/** True while re-running slots the reader asked to push further. */
let slotRetry = false;
const slotsEl = document.createElement("div");

function slotLetters(slot: Slot): string | null {
  const pick = slot.results[slot.chosen];
  if (!slot.extract || !pick) return null;
  return applyExtract(slot.extract, pick.text);
}

function renderSlots(): void {
  const done = slots!.every((s) => s.done);
  slotsEl.textContent = "";

  // The payoff line: the letters each slot contributes, in order.
  const picked = slots!.map((s) => slotLetters(s) ?? (s.done ? "?" : "·"));
  if (slots!.some((s) => s.extract)) {
    const line = document.createElement("p");
    line.className = "extraction";
    line.textContent = picked.join("");
    line.title = "click to copy";
    line.dataset.copy = picked.join("");
    slotsEl.append(line);
  }

  const table = document.createElement("table");
  table.className = "slots";
  slots!.forEach((slot, i) => {
    const row = document.createElement("tr");
    const q = document.createElement("td");
    q.className = "slotq";
    q.textContent = slot.query;
    const answer = document.createElement("td");
    if (!slot.done && i === slotIndex) {
      answer.textContent = "searching…";
      answer.className = "from";
    } else if (slot.results.length === 0) {
      // "no match" is a claim about the corpus, and only one of these endings
      // supports it. A slot that ran out of budget searched part of the index
      // and stopped; saying nothing is there would send the reader off to
      // rewrite a slot that may have been right all along. Slots share one
      // budget now, so the later ones reach this far more often.
      answer.textContent = !slot.done
        ? ""
        : slot.status === "exhausted"
          ? "no match"
          : slot.status === "empty"
            ? "cannot match anything"
            : slot.status === "complex"
              ? "too complex to search"
              : "nothing found in the budget";
      answer.className = "from";
    } else {
      const letters = slotLetters(slot);
      const chosen = slot.results[slot.chosen] ?? slot.results[0];
      const lead = document.createElement("span");
      lead.className = "r";
      lead.textContent = letters ?? chosen.text;
      lead.dataset.copy = letters ?? chosen.text;
      answer.append(lead);
      // The top answer is not always the right one, so every candidate can be
      // chosen; the extraction above follows the choice.
      for (let c = 0; c < slot.results.length; ++c) {
        const cand = document.createElement("span");
        cand.className = c === slot.chosen ? "cand chosen" : "cand";
        cand.textContent = ` ${slot.results[c].text}`;
        cand.dataset.slot = String(i);
        cand.dataset.cand = String(c);
        if (slot.results.length > 1) cand.title = "use this answer";
        answer.append(cand);
      }
    }
    row.append(q, answer);
    table.append(row);
  });
  slotsEl.append(table);
  if (!resultsEl.contains(slotsEl)) resultsEl.append(slotsEl);
  if (done) setStatus("");
}

/** Run the next unfinished slot, or finish. */
function runNextSlot(): void {
  if (!slots) return;
  // Skip what is already answered: a retry moves through the same list and
  // must not search a slot that finished.
  while (slotIndex < slots.length && slots[slotIndex].done) ++slotIndex;
  if (slotIndex >= slots.length) {
    renderSlots();
    afterEl.textContent = `${slots.length} slots. `;
    // Slots share one budget, so a later one can run out with answers still
    // to find. Single-slot searches have always offered to try harder; this
    // is the same offer, for the slots that need it.
    const short = slots.filter(needsMoreBudget);
    if (short.length > 0) {
      // Lead with the download where there is one, as the single-slot path
      // does: pushing several slots further costs a budget each, and a hunt
      // asks the same slots more than once, so the one-off transfer is very
      // often the cheaper of the two — and it makes every later slot instant
      // rather than buying one more page of this one.
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
        actionButton(
          `or search ${short.length} unfinished slot${short.length === 1 ? "" : "s"} further »`,
          retryUnfinishedSlots,
        ),
      );
    }
    return;
  }
  const slot = slots[slotIndex];
  renderSlots();
  postToWorker({
    type: "search",
    query: slot.plan.shape.pattern,
    // Resolved here: the page knows its own base, the worker script does not.
    // The version is part of the URL because the side datasets are cached
    // permanently — without it, a rebuilt dataset would never reach anyone who
    // had already fetched the old one.
    phoneticsUrl: dataUrl("phonetics.txt"),
    thesaurusUrl: dataUrl("thesaurus.txt"),
    neighboursUrl: dataUrl("neighbours.bin"),
    categoriesUrl: dataUrl("categories.txt"),
    stressUrl: dataUrl("stress.txt"),
    listsUrl: dataUrl("lists.txt"),
    headUrl: headUrl(),
    // The picker shows three candidates, and asking for exactly three left it
    // short: respellings of one answer ("solar system", "so lar system")
    // arrive in a run right behind it and are dropped, so three fetched could
    // become one offered. Fetch enough to survive that; the extra results are
    // cheap, since they come from a walk that has already found the first.
    maxResults: 12,
    ...slotBudget(),
  });
}

/**
 * What this slot may spend: whatever the query has left.
 *
 * Never zero, or a later slot could not run at all — a floor of an eighth
 * means twelve slots still finish, the last few on a thin allowance, which is
 * the right way round: the early slots are the ones whose answers the reader
 * is most likely to be choosing between.
 */
function slotBudget(): ReturnType<typeof firstRunBudget> {
  const budget = firstRunBudget();
  if (budget.byteBudget === 0) return budget; // local index: no byte cost
  if (slotRetry) return budget; // asked for: a full budget for each slot
  const left = RANGE_BYTE_BUDGET - slotBytesSpent;
  return {
    ...budget,
    byteBudget: Math.max(Math.floor(RANGE_BYTE_BUDGET / 8), left),
    stallMs: SLOT_STALL_MS,
  };
}

/**
 * Worth spending more on: it stopped on the budget, and there is still room
 * in the picker. A slot that already offers three candidates has nowhere to
 * put a fourth, so re-running it would buy the reader nothing.
 */
function needsMoreBudget(slot: Slot): boolean {
  return slot.status === "limit" && slot.results.length < 3;
}

/** Re-run the slots that ran out of budget, with a budget each. */
function retryUnfinishedSlots(): void {
  if (!slots) return;
  // A fresh allowance because the reader asked for it, which is the same
  // contract "Try harder" has always had on a single-slot search.
  slotBytesSpent = 0;
  slotBytesAtStart = lastFetchedBytes;
  // A budget each this time, not a shared one. Sharing exists so that asking
  // for a dozen slots does not silently cost a dozen queries; this is the
  // reader asking, having been told which slots came up short, and repeating
  // the same shared allowance would just reproduce the same stopping point.
  slotRetry = true;
  // Locally there is no byte budget to widen — the limit is steps — so the
  // same reasoning applies to those: re-running with the budget that already
  // ran out stops in the same place. `tryHarder` doubles it for a single-slot
  // search; this is that, for slots.
  if (indexMode !== "range") currentComp *= 2;
  for (const slot of slots) {
    if (!needsMoreBudget(slot)) continue;
    slot.done = false;
    slot.status = null;
    slot.results = [];
    slot.chosen = 0;
  }
  slotIndex = 0;
  afterEl.textContent = "";
  runNextSlot();
}

function startMultiSlot(planned: SlotPlan[]): void {
  resultsEl.textContent = "";
  afterEl.textContent = "";
  resultCount = 0;
  slots = planned.map((p) => ({
    query: p.query,
    plan: p,
    extract: p.extract,
    results: [],
    chosen: 0,
    done: false,
    status: null,
  }));
  slotIndex = 0;
  slotBytesSpent = 0;
  slotRetry = false;
  slotBytesAtStart = lastFetchedBytes;
  currentComp =
    parseInt(new URLSearchParams(location.search).get("comp") || "", 10) ||
    MAX_COMPUTATION;
  setStatus("searching…");
  runNextSlot();
}

function startSearch(query: string): void {
  // One place decides what the slots are, and the CLI reads it too — see
  // src/slot-plan.ts. Transliterated first, so a slot written with umlauts
  // splits and peels the same as one written without.
  let planned: SlotPlan[];
  try {
    planned = planSlots(transliterate(query), MIN_OVERLAP_CHARS);
  } catch (e) {
    setStatus(e instanceof ExtractError ? e.message : String(e), true);
    return;
  }
  if (planned.length > 1) {
    startMultiSlot(planned);
    return;
  }
  slots = null;
  resultsEl.textContent = "";
  afterEl.textContent = "";
  resultCount = 0;
  resetResultCollapsing();
  // `{at …:…}` is an output wrapper, already stripped by the planner; the
  // predicate wrappers are not, because the worker peels those on its side —
  // it is the side that can ask the index whether a piece is a word.
  const { shape } = planned[0];
  const pattern = shape.pattern;
  extractSpec = shape.extract;
  rankSpec = shape.rank;
  caesarText = shape.caesar;
  queryLiterals = shape.literals;
  // Built here rather than in resetResultCollapsing, which runs before the
  // wrappers are known and would hand it the previous search's specs.
  output = new OutputTransform(extractSpec, rankSpec);
  // Local step budget from the live URL's comp (not the load-time snapshot) so
  // back/forward through raised-budget entries picks up the right value.
  currentComp =
    parseInt(new URLSearchParams(location.search).get("comp") || "", 10) ||
    MAX_COMPUTATION;
  setStatus("searching…");
  postToWorker({
    type: "search",
    query: pattern,
    // Resolved here: the page knows its own base, the worker script does not.
    // The version is part of the URL because the side datasets are cached
    // permanently — without it, a rebuilt dataset would never reach anyone who
    // had already fetched the old one.
    phoneticsUrl: dataUrl("phonetics.txt"),
    thesaurusUrl: dataUrl("thesaurus.txt"),
    neighboursUrl: dataUrl("neighbours.bin"),
    categoriesUrl: dataUrl("categories.txt"),
    stressUrl: dataUrl("stress.txt"),
    listsUrl: dataUrl("lists.txt"),
    headUrl: headUrl(),
    // A rank window has to be reached before it can be shown; ask the engine
    // for enough results to cover it (bounded, so a huge "to" can't run away).
    maxResults: rankSpec
      ? Math.min(Math.max(rankSpec.to, rankSpec.from + PER_RUN_RESULTS), 20000)
      : PER_RUN_RESULTS,
    ...firstRunBudget(),
  });
}

function tryHarder(): void {
  afterEl.textContent = "";
  if (indexMode === "range") {
    // Range mode isn't step-budgeted; "keep searching" just runs another
    // bytes/time window over the network from where it left off.
    setStatus("searching…");
    postToWorker({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
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
  postToWorker({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
}

function moreResults(): void {
  afterEl.textContent = "";
  setStatus("fetching more results…");
  postToWorker({ type: "continue", maxResults: PER_RUN_RESULTS, ...runBudget() });
}

worker.onmessage = (ev: MessageEvent<OutMsg>) => {
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
      if (!OFFLINE) postToWorker({ type: "list-copies" });
      break;
    case "copies":
      annotateOfflineCopies(new Set(msg.urls));
      break;
    case "checked":
      // A stale answer for text that has since changed must not flash.
      if (msg.seq === checkSeq) {
        showCheck(msg.error);
      }
      break;
    case "kind-completions": {
      if (msg.seq !== acKindSeq) break; // a newer keystroke has superseded this
      const names = msg.items;
      acItems = names.map((n) => ({
        insert: n,
        label: n,
        detail: "WordNet category",
      }));
      acIndex = acItems.length > 0 ? 0 : -1;
      renderCompletions();
      break;
    }
    case "lists-ready":
      acLists = msg.lists;
      updateCompletions();
      break;
    case "planned": {
      if (!DEBUG) break;
      const box = document.createElement("div");
      box.className = "plan";
      for (const line of msg.lines) {
        const div = document.createElement("div");
        div.textContent = line;
        box.append(div);
      }
      statsEl.append(box);
      break;
    }
    case "explanation": {
      const why = resultsEl.querySelector(
        `span.r[data-match="${CSS.escape(msg.text)}"]`,
      );
      if (!why) break;
      const box = document.createElement("div");
      box.className = "why-box";
      box.dataset.match = msg.text;
      const reasons = msg.reasons;
      if (reasons.length === 0) {
        box.textContent = "nothing to explain — the pattern matches directly";
      }
      for (const r of reasons) {
        const line = document.createElement("div");
        const mark = document.createElement("b");
        mark.textContent = r.ok ? "\u2713 " : "\u2717 ";
        const code = document.createElement("tt");
        code.textContent = r.part;
        line.append(mark, code);
        if (r.detail) {
          const d = document.createElement("span");
          d.className = "from";
          d.textContent = ` — ${r.detail}`;
          line.append(d);
        }
        box.append(line);
      }
      // After the <br> that follows the result, so the box sits on its own
      // line under the match it explains.
      (why.nextElementSibling ?? why).after(box);
      break;
    }
    case "result":
      if (slots) {
        const slot = slots[slotIndex];
        if (slot && slot.results.length < 3) {
          // "solar system" and "so lar system" are one answer written twice,
          // and there is room for three candidates: a respelling costs a real
          // alternative. `{at 3:…}` counts letters with the spaces taken out,
          // so the two extract the same letter and one of them is waste.
          //
          // Not when the extraction counts *words*, though — `{at 1.1:…}`
          // takes the first letter of the first word, which is "s" of "solar"
          // one way and "s" of "so" the other. There the split is the answer,
          // so both belong in the list.
          const byWord =
            slot.extract?.positions.some((p) => typeof p !== "number") ?? false;
          const letters = msg.text.replaceAll(" ", "");
          const respelling =
            !byWord &&
            slot.results.some((r) => r.text.replaceAll(" ", "") === letters);
          if (!respelling) {
            slot.results.push({ score: msg.score, text: msg.text });
          }
        }
        break;
      }
      addResult(msg.score, msg.text, msg.note);
      break;
    case "progress":
      setStatus(`searching… (${(msg.steps / 1e6).toFixed(1)}M steps)`);
      if (msg.fetched !== undefined) {
        indexInfo.textContent = `${fmtMB(msg.fetched)} fetched so far`;
      }
      // Follow the search rather than waiting for it: over a streamed index a
      // run can take seconds, and the counters are most interesting while it
      // is happening.
      if (DEBUG) showStats(msg.stats, msg.engine);
      break;
    case "parse-error":
      // A recognised-but-wrong construct explains itself; anything else falls
      // back to pointing at the text that failed.
      setStatus(msg.detail ?? `can't parse "${msg.rest}"`, true);
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
            postToWorker({ type: "open", url: indexUrl });
          }),
        );
      }
      break;
    case "done":
      setStatus("");
      if (DEBUG) {
        showStats(msg.stats, msg.engine);
        // The plan describes the query rather than the run, so it is asked for
        // once the run settles rather than raced against it.
        postToWorker({ type: "plan", query: qInput.value.trim() });
      }
      if (typeof msg.fetched === "number") lastFetchedBytes = msg.fetched;
      if (msg.engine === "wasm" && !indexInfo.textContent!.includes("WASM")) {
        indexInfo.textContent += " · WASM engine";
      }
      if (slots) {
        const slot = slots[slotIndex];
        if (slot) {
          slot.done = true;
          slot.status = msg.status;
        }
        // `fetched` is the source's lifetime total, so the difference is what
        // this slot cost.
        if (typeof msg.fetched === "number") {
          slotBytesSpent = Math.max(slotBytesSpent, msg.fetched - slotBytesAtStart);
        }
        ++slotIndex;
        runNextSlot();
        break;
      }
      lastDoneStatus = msg.status;
      lastConflict = msg.conflict;
      renderAfterSearch(msg.status);
      break;
    default:
      // Every outbound message must be handled here. A new one added to
      // `OutMsg` and posted by the worker but forgotten on this side stops
      // compiling at this line rather than being silently dropped at runtime,
      // which is what used to happen — the switch had no default at all.
      msg satisfies never;
  }
};

/** The action area under the results, rebuilt when collapsed variants are shown. */
function renderAfterSearch(status: string): void {
  {
      if (status === "empty") {
        // Not "no results": nothing *could* have been found, and no amount of
        // searching would change that. Naming the two parts that disagree is
        // the whole value — "no results found" would send someone looking for
        // a rarer word instead of at the contradiction they wrote.
        if (lastConflict && lastConflict.length === 2) {
          afterEl.textContent = "Nothing can match this: ";
          const a = document.createElement("tt");
          a.textContent = lastConflict[0];
          const b = document.createElement("tt");
          b.textContent = lastConflict[1];
          afterEl.append(a, " and ", b, " cannot both be true.");
        } else if (lastConflict && lastConflict.length === 1) {
          afterEl.textContent = "Nothing can match this: ";
          const only = document.createElement("tt");
          only.textContent = lastConflict[0];
          afterEl.append(only, " matches nothing on its own.");
        } else {
          afterEl.textContent =
            "Nothing can match this pattern — its parts rule each other out.";
        }
      } else if (status === "exhausted") {
        afterEl.textContent =
          resultCount > 0 ? "No more results found." : "No results found, sorry.";
      } else if (status === "complex") {
        // The lazy automaton ran out of states. What was found is correct, so
        // it stays on screen — but there is no "try harder" here, because
        // trying harder rebuilds to the same wall. Say what would help
        // instead: this limit is reached by patterns that track a lot of
        // independent facts at once, and pinning any of them down shrinks it.
        afterEl.textContent =
          resultCount > 0
            ? "This pattern is too complex to search any further — the results above are complete and correct as far as it got. Adding a length, a letter, or a narrower range would let it go deeper."
            : "This pattern is too complex to search. Adding a length, a letter, or a narrower range would bring it in reach.";
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


// ---- as-you-type help: completions from the catalogue, errors from the
// engine's own parser (asked over in the worker, so the underline can never
// disagree with what a search would do).

const acEl = $("ac") as HTMLUListElement;
const qErrEl = $("qerr");
let acItems: Completion[] = [];
let acToken = { start: 0, prefix: "" };
let acIndex = -1;
let checkSeq = 0;
/** The catalogue, once a query has caused the worker to fetch it. */
let acLists: WikiLists | null = null;

function closeCompletions(): void {
  acEl.hidden = true;
  acEl.textContent = "";
  acItems = [];
  acIndex = -1;
  qInput.setAttribute("aria-expanded", "false");
}

function renderCompletions(): void {
  acEl.textContent = "";
  acItems.forEach((item, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === acIndex));
    li.dataset.i = String(i);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.label;
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = item.detail;
    li.append(name, desc);
    if (item.example) {
      const eg = document.createElement("span");
      eg.className = "eg";
      eg.textContent = item.example;
      li.append(eg);
    }
    acEl.append(li);
  });
  acEl.hidden = acItems.length === 0;
  qInput.setAttribute("aria-expanded", String(acItems.length > 0));
}

function applyCompletion(i: number): void {
  const item = acItems[i];
  if (!item) return;
  const value = qInput.value;
  const before = value.slice(0, acToken.start);
  const after = value.slice(acToken.start + acToken.prefix.length);
  qInput.value = before + item.insert + after;
  const caret = before.length + item.insert.length;
  qInput.setSelectionRange(caret, caret);
  closeCompletions();
  updateHelp();
}

/** Whether the harvested catalogue has been asked for; ask at most once. */
let acListsRequested = false;
/** Bumped per `{kind:…}` request, so only the newest reply is shown. */
let acKindSeq = 0;

function updateCompletions(): void {
  const cursor = qInput.selectionStart ?? qInput.value.length;
  const { token, items } = completionsAt(qInput.value, cursor, acLists);
  // Someone is typing a list name and the catalogue is not here yet. It used
  // to arrive only as a side effect of *running* a query that used a list, so
  // the menu offered the few lists compiled into the bundle and none of the
  // thousand harvested ones — `{list:pok` suggested nothing, with pokemon in
  // the catalogue all along. Fetch it now; when it lands, `lists-ready`
  // re-renders this menu.
  if (token.kind === "listname" && !acLists && !acListsRequested) {
    acListsRequested = true;
    postToWorker({ type: "want-lists", listsUrl: dataUrl("lists.txt") });
  }
  // A category name is completed by the worker, which holds the 124,980-name
  // dataset. The menu fills in when the reply arrives; `seq` is what stops a
  // slow reply from overwriting a newer one.
  if (token.kind === "kindname") {
    postToWorker({
      type: "complete-kind",
      prefix: token.prefix,
      seq: ++acKindSeq,
      categoriesUrl: dataUrl("categories.txt"),
    });
  }
  acToken = { start: token.start, prefix: token.prefix };
  acItems = items;
  acIndex = items.length > 0 ? 0 : -1;
  renderCompletions();
}

function updateHelp(): void {
  updateCompletions();
  // Ask the engine, not a second opinion: the worker compiles the query with
  // the same compileQuery a search uses.
  postToWorker({ type: "check", query: qInput.value, seq: ++checkSeq });
}

qInput.addEventListener("input", updateHelp);
qInput.addEventListener("click", updateCompletions);
qInput.addEventListener("blur", () => setTimeout(closeCompletions, 120));

qInput.addEventListener("keydown", (ev) => {
  if (acEl.hidden) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    acIndex =
      (acIndex + (ev.key === "ArrowDown" ? 1 : acItems.length - 1)) %
      acItems.length;
    renderCompletions();
    acEl.children[acIndex]?.scrollIntoView({ block: "nearest" });
  } else if (ev.key === "Enter" || ev.key === "Tab") {
    // Enter completes only while the menu is open with a choice made; the
    // second Enter submits, which is what someone who ignored the menu expects.
    if (acIndex >= 0) {
      ev.preventDefault();
      applyCompletion(acIndex);
    }
  } else if (ev.key === "Escape") {
    closeCompletions();
  }
});

acEl.addEventListener("mousedown", (ev) => {
  const li = (ev.target as HTMLElement | null)?.closest?.("li");
  if (!li) return;
  ev.preventDefault(); // keep focus in the box
  applyCompletion(Number((li as HTMLElement).dataset.i));
});

/** Show or clear the syntax complaint for the text as it stands. */
function showCheck(error: { detail: string; at: number } | null): void {
  qInput.classList.toggle("bad", error !== null);
  if (!error) {
    qErrEl.hidden = true;
    qErrEl.textContent = "";
    return;
  }
  qErrEl.textContent = "";
  const msg = document.createElement("span");
  msg.textContent = error.detail;
  qErrEl.append(msg);
  // Point at the offending character, which is more use than naming it.
  if (error.at > 0 && error.at <= qInput.value.length) {
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = ` (at character ${error.at + 1})`;
    qErrEl.append(where);
  }
  qErrEl.hidden = false;
}

/**
 * `?debug=1` shows what the search cost. Off by default and cheap when off:
 * the numbers are collected by the engine either way, so this only decides
 * whether anything is rendered.
 */
const DEBUG = params.get("debug") === "1";
const statsEl = document.createElement("div");
statsEl.id = "stats";
statsEl.hidden = true;
afterEl.after(statsEl);

function showStats(stats: Stats | null, engine?: string): void {
  statsEl.textContent = "";
  if (!stats) {
    // Two things answer without the JS engine's counters, and saying "WASM"
    // for both was simply wrong: a page served from the head of the index
    // never ran a search at all.
    statsEl.textContent =
      engine === "head"
        ? "answered from the head of the index — no search, no index traffic"
        : "WASM engine — detailed counters are JS-engine only";
    statsEl.hidden = false;
    return;
  }
  for (const line of formatStats(stats)) {
    const div = document.createElement("div");
    div.textContent = line;
    statsEl.append(div);
  }
  statsEl.hidden = false;
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
  postToWorker({ type: "download-full" });
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
  postToWorker({ type: "remove-copy" });
});

dlFull.addEventListener("click", () => {
  if (downloading) {
    postToWorker({ type: "cancel-download" });
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
    postToWorker({ type: "remove-copy" });
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
    postToWorker({ type: "stop" });
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
      postToWorker(
        {
          type: "open",
          url: indexUrl,
          early: { probe: probe as EarlyProbe | null, table },
        },
        table ? [table] : [],
      );
      return;
    }
  }
  postToWorker({ type: "open", url: indexUrl });
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
    postToWorker({ type: "open-file", file, name: file.name });
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
