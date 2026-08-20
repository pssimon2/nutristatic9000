// The one list of what this deployment offers, shared by the search page and
// the storage manager: the picker's indexes, and the side datasets a query
// may pull in. Both pages must agree on names and URLs, or the manager would
// count copies the search cannot find.

// The first entry is the default index; web/index.html's inline early-fetch
// script (which cannot import) mirrors its URL by hand — change both.
export const BUNDLED_INDEXES: Array<[string, string]> = [
  ["/idx/2026-08/en-wiki.index", "English Wikipedia (1.3 GB, 2026-08)"],
  ["/idx/2026-08/de-wiki.index", "German Wikipedia – Deutsch (591 MB, 2026-08)"],
  ["/idx/2026-08/fr-wiki.index", "French Wikipedia – Français (491 MB, 2026-08)"],
  ["/idx/2026-08/es-wiki.index", "Spanish Wikipedia – Español (436 MB, 2026-08)"],
  ["/idx/2026-08/it-wiki.index", "Italian Wikipedia – Italiano (360 MB, 2026-08)"],
  ["/idx/2026-08/pt-wiki.index", "Portuguese Wikipedia – Português (255 MB, 2026-08)"],
  ["/idx/2026-08/nl-wiki.index", "Dutch Wikipedia – Nederlands (222 MB, 2026-08)"],
  ["/idx/2026-08/pl-wiki.index", "Polish Wikipedia – Polski (216 MB, 2026-08)"],
  ["/idx/2026-08/sv-wiki.index", "Swedish Wikipedia – Svenska (199 MB, 2026-08)"],
  ["/idx/2026-08/ca-wiki.index", "Catalan Wikipedia – Català (173 MB, 2026-08)"],
  ["/idx/2026-08/id-wiki.index", "Indonesian Wikipedia – Bahasa Indonesia (123 MB, 2026-08)"],
  ["/idx/2026-08/cs-wiki.index", "Czech Wikipedia – Čeština (113 MB, 2026-08)"],
  ["/idx/2026-08/hu-wiki.index", "Hungarian Wikipedia – Magyar (107 MB, 2026-08)"],
  ["/idx/2026-08/no-wiki.index", "Norwegian Wikipedia – Norsk (Bokmål) (102 MB, 2026-08)"],
  ["/idx/2026-08/ro-wiki.index", "Romanian Wikipedia – Română (101 MB, 2026-08)"],
  ["/idx/2026-08/tr-wiki.index", "Turkish Wikipedia – Türkçe (88 MB, 2026-08)"],
  ["/idx/2026-08/fi-wiki.index", "Finnish Wikipedia – Suomi (85 MB, 2026-08)"],
  ["/idx/2026-08/da-wiki.index", "Danish Wikipedia – Dansk (51 MB, 2026-08)"],
  ["/idx/2026-08/eo-wiki.index", "Esperanto Wikipedia – Esperanto (51 MB, 2026-08)"],
  ["/idx/2026-08/sl-wiki.index", "Slovenian Wikipedia – Slovenščina (41 MB, 2026-08)"],
  ["/idx/2026-08/hr-wiki.index", "Croatian Wikipedia – Hrvatski (41 MB, 2026-08)"],
  ["/idx/2026-08/sk-wiki.index", "Slovak Wikipedia – Slovenčina (36 MB, 2026-08)"],
  ["/simple-wiki.index", "Simple English Wikipedia (41 MB)"],
  ["./demo.index", "web words + bigrams (20 MB)"],
];

declare const OFFLINE: boolean;

// Bump when a side dataset is rebuilt: it versions their URLs, which is what
// makes a cached copy fall out of use.
export const DATA_VERSION = "2";

/** Absolute URL of a side dataset, or null in the single-file offline build. */
export const dataUrl = (file: string): string | null =>
  OFFLINE ? null : new URL(`./${file}?v=${DATA_VERSION}`, location.href).href;

/** The side datasets, with what each one answers — the manager's checklist. */
export const DATASETS: Array<[string, string]> = [
  ["phonetics.txt", "rhymes, homophones, syllables and stress"],
  ["thesaurus.txt", "{like:…} word senses"],
  ["neighbours.bin", "{near:…} meaning neighbours"],
  ["categories.txt", "{kind:…} WordNet categories"],
  ["stress.txt", "{stress …} metrical shapes"],
  ["lists.txt", "the harvested {list:…} catalogue"],
];
