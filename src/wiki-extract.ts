// Pulling list members out of Wikipedia article source.
//
// This lives here, tested, rather than inside the harvest script, because the
// script's feedback loop is a twenty-minute pass over a 24 GB dump — and every
// mistake in it looks the same from outside: a plausible list with a few wrong
// members buried at the end. "List of generation I Pokémon" came back with
// LOCH NESS MONSTER, FUTURE PUBLISHING and ERROR HANDLER in it three separate
// times before this was written down and tested against real wikitext.
//
// The traps, all of which produce entries that look like members:
//   * citation templates inside a table cell — `{{cite web|publisher=[[Future
//     Publishing]]}}` sits on the same line as the row it documents;
//   * <ref> markup, same story;
//   * the See also / References sections, whose bullets are shaped exactly
//     like list entries;
//   * navigation boxes and image captions after the content.

/** Wikipedia titles and labels arrive XML-escaped. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Corpus form: folded, lower case, single-spaced, letters and digits only. */
export function normalizeEntry(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Sections that follow the list. Their bullets are indistinguishable from
 * entries, so collection stops at the first one.
 */
const END_SECTION =
  /^\s*=+\s*(see also|references|external links|notes|further reading|bibliography|sources|footnotes|citations|external media)\s*=+/i;

/**
 * Remove the markup that carries links which are *about* an entry rather than
 * being one: citations, footnotes and templates. A cited table row is the
 * common case, and its publisher link would otherwise be read as a member.
 */
export function stripApparatus(line: string): string {
  return line
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*>.*$/i, "") // an unclosed ref runs to end of line
    .replace(/\{\{[^{}]*\}\}/g, "") // innermost templates
    .replace(/\{\{[^{}]*\}\}/g, "") // and one nesting level out
    .replace(/\{\{.*$/, ""); // a template opened and not closed on this line
}

/** The link naming this line's entry, or null if the line is not an entry. */
export function entryLink(line: string): string | null {
  const t = stripApparatus(line).trim();
  const bullet = /^[*#]+\s*\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(t);
  if (bullet) return bullet[2] || bullet[1];
  // A table cell, but not the control lines {| |- |+ |} nor a header row (!).
  if (t.startsWith("|") && !/^\|[-+}]/.test(t) && !t.startsWith("|}")) {
    const cell = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(t);
    if (cell) return cell[2] || cell[1];
  }
  return null;
}

export interface ExtractOptions {
  maxChars?: number;
  maxWords?: number;
}

/**
 * The members named by a list article's source, in order and deduplicated.
 * `lines` is the article wikitext; collection stops at the first end-of-list
 * section.
 */
export function entriesFrom(
  lines: string[],
  { maxChars = 25, maxWords = 3 }: ExtractOptions = {},
): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    if (END_SECTION.test(line)) break;
    const raw = entryLink(line);
    if (raw === null) continue;
    // "Ada (programming language)" is ADA; the qualifier is Wikipedia's, not
    // part of the name.
    const e = normalizeEntry(raw.replace(/\s*\([^)]*\)\s*$/, ""));
    if (!e || e.length > maxChars) continue;
    if (e.split(" ").length > maxWords) continue;
    out.add(e);
  }
  return [...out];
}
