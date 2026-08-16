// Extracting list members from Wikipedia source.
//
// Every case here is one that actually shipped a wrong entry. The harvest runs
// for twenty minutes over a 24 GB dump, so a bug in it costs a whole cycle to
// see and looks, from outside, like a plausible list with a few odd members at
// the end — which is exactly the kind of wrongness that survives review.

import { describe, expect, it } from "vitest";
import {
  entriesFrom,
  entryLink,
  normalizeEntry,
  stripApparatus,
  unescapeXml,
} from "../src/wiki-extract.js";

describe("entryLink", () => {
  it("reads a bullet and a numbered item", () => {
    expect(entryLink("* [[Bulbasaur]]")).toBe("Bulbasaur");
    expect(entryLink("# [[Charmander]]")).toBe("Charmander");
    expect(entryLink("** [[Squirtle]]")).toBe("Squirtle");
  });

  it("prefers the display text over the link target", () => {
    expect(entryLink("* [[Ada (programming language)|Ada]]")).toBe("Ada");
  });

  it("reads the first link of a table row, which names the row", () => {
    expect(entryLink("| [[Ivysaur]] || Grass || 001")).toBe("Ivysaur");
  });

  it("ignores table control lines and header rows", () => {
    expect(entryLink('{| class="wikitable"')).toBeNull();
    expect(entryLink("|-")).toBeNull();
    expect(entryLink("|+ [[Caption]]")).toBeNull();
    expect(entryLink("|}")).toBeNull();
    expect(entryLink("! [[Name]] !! Type")).toBeNull();
  });

  it("ignores prose that merely contains a link", () => {
    expect(entryLink("These were introduced in [[Pokémon Red]].")).toBeNull();
  });
});

describe("citations are apparatus, not members", () => {
  // The bug that put FUTURE PUBLISHING and NINTENDO LIFE into the Pokémon
  // list: a cited table row carries its publisher on the same line.
  it("drops a ref that follows the entry in a table row", () => {
    const line =
      "| [[Venusaur]] || Grass <ref>{{cite web|publisher=[[Future Publishing]]}}</ref>";
    expect(entryLink(line)).toBe("Venusaur");
  });

  it("drops a self-closing and an unclosed ref", () => {
    expect(entryLink("| [[Charizard]] <ref name=x />")).toBe("Charizard");
    expect(entryLink("| [[Blastoise]] <ref>{{cite|publisher=[[Nintendo Life]]")).toBe(
      "Blastoise",
    );
  });

  it("drops a bare template that would otherwise supply the link", () => {
    expect(entryLink("| {{cite web|publisher=[[Error Handler]]}}")).toBeNull();
    expect(stripApparatus("x {{nested {{deep}} thing}} y").trim()).toBe("x  y");
  });

  it("keeps the entry when the template follows it", () => {
    expect(entryLink("* [[Caterpie]] {{efn|group=note}}")).toBe("Caterpie");
  });
});

describe("the article stops being a list", () => {
  const article = [
    '{| class="wikitable"',
    "|-",
    "! Name !! Type",
    "|-",
    "| [[Bulbasaur]] || Grass",
    "|-",
    "| [[Ivysaur]] || Grass",
    "|}",
    "== See also ==",
    "* [[Loch Ness Monster]]",
    "== References ==",
    "* [[Future Publishing]]",
    "* [[Nintendo Life]]",
  ];

  it("collects the table and nothing after See also", () => {
    expect(entriesFrom(article)).toEqual(["bulbasaur", "ivysaur"]);
  });

  it("stops at any of the trailing sections", () => {
    for (const heading of [
      "== References ==",
      "===External links===",
      "== Notes ==",
      "== Further reading ==",
      "== Bibliography ==",
    ]) {
      expect(entriesFrom(["* [[Real]]", heading, "* [[Bogus]]"]), heading).toEqual(
        ["real"],
      );
    }
  });
});

describe("entriesFrom", () => {
  it("deduplicates and keeps document order", () => {
    expect(entriesFrom(["* [[Ash]]", "* [[Misty]]", "* [[Ash]]"])).toEqual([
      "ash",
      "misty",
    ]);
  });

  it("drops entries too long or too wordy to be an answer", () => {
    const lines = [
      "* [[Pikachu]]",
      "* [[A very considerably overlong entry indeed]]",
      "* [[One two three four five]]",
    ];
    expect(entriesFrom(lines)).toEqual(["pikachu"]);
  });

  it("puts entries in corpus form", () => {
    // Folded, lower case, punctuation to spaces — or they match nothing.
    expect(entriesFrom(["* [[Boötes]]", "* [[Mont-Saint-Michel]]"])).toEqual([
      "bootes",
      "mont saint michel",
    ]);
  });
});

describe("unescapeXml", () => {
  it("decodes the entities dump titles arrive with", () => {
    expect(unescapeXml("Procter &amp; Gamble brands")).toBe(
      "Procter & Gamble brands",
    );
    expect(unescapeXml("&quot;A&quot; &lt;b&gt; &#39;c&#39;")).toBe('"A" <b> \'c\'');
  });
});

describe("normalizeEntry", () => {
  it("matches the corpus form the index stores", () => {
    expect(normalizeEntry("Côte d'Ivoire")).toBe("cote divoire");
    expect(normalizeEntry("  Anti-hero  ")).toBe("anti hero");
  });
});
