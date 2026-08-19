// The one list of what this deployment offers, shared by the search page and
// the storage manager: the picker's indexes, and the side datasets a query
// may pull in. Both pages must agree on names and URLs, or the manager would
// count copies the search cannot find.

export const BUNDLED_INDEXES: Array<[string, string]> = [
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

declare const OFFLINE: boolean;

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
