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

/** How much text may sit after a link before the cell is prose, not a name. */
const CELL_SLACK = 16;

/**
 * Links that are not to articles. A `[[File:Selene.jpg|100px|center]]` in a
 * table cell offered "100px" as a lunar deity, and a category link names the
 * shelf rather than anything on it.
 */
const NON_ARTICLE = /^\s*(file|image|category|template|media|help|portal)\s*:/i;

/**
 * The entry named by a table cell, or null. The link has to *begin* the cell
 * and be substantially all of it.
 *
 * Taking the first link anywhere in the row is what put LOCH NESS MONSTER and
 * ERROR HANDLER into the Pokémon list: those rows carry a description cell of
 * running prose, and Lapras's description mentions the Loch Ness Monster while
 * MissingNo.'s begins "An [[Exception handling|error handler]] whose name…".
 * A cell that names a member is the name and almost nothing else; a cell that
 * discusses one is a paragraph.
 */
function cellEntry(row: string): string | null {
  // Cells are separated by "||" on one line; the row's own "|" starts the first.
  const cells = row.replace(/^\|/, "").split("||");
  for (const cell of cells) {
    const t = cell.trim();
    const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(t);
    if (!m) continue;
    if (NON_ARTICLE.test(m[1])) continue; // an image or a category, not a member
    if (t.length - m[0].length > CELL_SLACK) continue; // prose about an entry
    return m[2] || m[1];
  }
  return null;
}

/** The link naming this line's entry, or null if the line is not an entry. */
export function entryLink(line: string): string | null {
  const t = stripApparatus(line).trim();
  const bullet = /^[*#]+\s*\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(t);
  if (bullet) return NON_ARTICLE.test(bullet[1]) ? null : bullet[2] || bullet[1];
  // A table cell, but not the control lines {| |- |+ |} nor a header row (!).
  if (t.startsWith("|") && !/^\|[-+}]/.test(t) && !t.startsWith("|}")) {
    return cellEntry(t);
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
 *
 * One entry per table row, not one per cell. `cellEntry` already takes only the
 * first link of a row written on one line — `| [[Bagel]] || [[Yeast bread]] ||
 * [[Poland]]` — but Wikipedia writes most tables with each cell on its own
 * line, and then every cell looked like its own entry. That is what filled the
 * breads list with types and countries:
 *
 *   breads: food name, anadama bread, yeast bread, anpan, sweet bun, japan,
 *           apple bread, taiwan, arboud, unleavened, jordan, arepa, …
 *
 * — the Name, Type and Place-of-origin columns interleaved. So a row
 * contributes its first linked cell and nothing more, which is where the name
 * is in every "List of …" table I looked at.
 */
export function entriesFrom(
  lines: string[],
  { maxChars = 25, maxWords = 3 }: ExtractOptions = {},
): string[] {
  const out = new Set<string>();
  // Whether the row being read has already given up its entry.
  let rowTaken = false;
  for (const line of lines) {
    if (END_SECTION.test(line)) break;
    const t = stripApparatus(line).trim();
    // A table start or a row separator begins a new row.
    if (t.startsWith("{|") || /^\|-/.test(t)) {
      rowTaken = false;
      continue;
    }
    const isCell = t.startsWith("|") && !/^\|[-+}]/.test(t);
    if (isCell && rowTaken) continue;
    const raw = entryLink(line);
    if (raw === null) continue;
    // Set before the length filters: a row whose first cell is a link this
    // rejects must not fall through to its second column.
    if (isCell) rowTaken = true;
    // "Ada (programming language)" is ADA; the qualifier is Wikipedia's, not
    // part of the name.
    const e = normalizeEntry(raw.replace(/\s*\([^)]*\)\s*$/, ""));
    if (!e || e.length > maxChars) continue;
    if (e.split(" ").length > maxWords) continue;
    out.add(e);
  }
  return [...out];
}
