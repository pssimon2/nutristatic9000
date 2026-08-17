// The index manifest sidecar (F1): `<index>.meta.json`, the one per-index
// configuration channel.
//
// An index is a bare file, and everything the page needs to know about it —
// which transliteration its text was normalized with, what to call it — used
// to be guessed from its file name. A custom index URL defeats the guess: a
// German index served as `puzzle.index` got the diacritic fold instead of the
// ae/oe/ue digraphs, and nothing said so. The manifest states it instead;
// indexes without one keep the filename heuristic and today's defaults.
//
// Shape, all fields optional:
//
//   {
//     "description": "German Wikipedia, 2026 dump",
//     "language": "de",
//     "transliterate": [["ä","ae"], ["ö","oe"], ["ü","ue"], ["ß","ss"]]
//   }
//
// `transliterate` maps characters the corpus normalized away to what they
// became; `language` selects a built-in rule set ("de" is the digraph
// convention) when explicit pairs are not given. Data-pack URLs (F2,
// per-language phonetics and categories) are reserved fields, not yet read.

export interface IndexManifest {
  description?: string;
  language?: string;
  /** Character → replacement, applied before the generic diacritic fold. */
  transliterate?: Array<[string, string]>;
  /** Construct-pack URLs (F4) to load alongside this index. */
  constructPacks?: string[];
}

/** Parse a fetched manifest, tolerating junk: null when unusable. */
export function parseManifest(json: unknown): IndexManifest | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = json as Record<string, unknown>;
  const out: IndexManifest = {};
  if (typeof raw.description === "string") out.description = raw.description;
  if (typeof raw.language === "string") out.language = raw.language.toLowerCase();
  if (Array.isArray(raw.transliterate)) {
    const pairs: Array<[string, string]> = [];
    for (const p of raw.transliterate) {
      if (
        Array.isArray(p) &&
        p.length === 2 &&
        typeof p[0] === "string" &&
        typeof p[1] === "string" &&
        p[0].length > 0
      ) {
        pairs.push([p[0], p[1]]);
      }
    }
    if (pairs.length > 0) out.transliterate = pairs;
  }
  if (Array.isArray(raw.constructPacks)) {
    const urls = raw.constructPacks.filter(
      (u): u is string => typeof u === "string" && /^https?:\/\//.test(u),
    );
    if (urls.length > 0) out.constructPacks = urls;
  }
  return out;
}

/** The ae/oe/ue/ss digraph convention German corpora use. */
function germanFold(query: string): string {
  return query
    .replace(/[äÄ]/g, "ae")
    .replace(/[öÖ]/g, "oe")
    .replace(/[üÜ]/g, "ue")
    .replace(/[ßẞ]/g, "ss");
}

/** The generic fold: digraph exceptions, then strip combining marks. */
function genericFold(query: string): string {
  return query
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/[ßẞ]/g, "ss")
    .replace(/[łŁ]/g, "l") // these four don't decompose under NFD
    .replace(/[đĐ]/g, "d")
    .replace(/[øØ]/g, "o")
    .replace(/[ıİ]/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Match the index's text normalization in a query.
 *
 * The manifest wins when it says anything: explicit pairs run first, then the
 * generic fold catches what they did not name. Without a manifest, the file
 * name picks the rule set, exactly as before — `de-*` means the German
 * digraphs, everything else the generic fold.
 */
export function transliterateQuery(
  query: string,
  manifest: IndexManifest | null,
  basename: string,
): string {
  if (manifest?.transliterate) {
    let out = query;
    for (const [from, to] of manifest.transliterate) {
      out = out.split(from).join(to);
    }
    return genericFold(out);
  }
  const language =
    manifest?.language ?? (/^de[-_.]/.test(basename) ? "de" : null);
  if (language === "de") return germanFold(query);
  return genericFold(query);
}
