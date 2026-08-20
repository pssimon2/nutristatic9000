// Named category lists: `{list:greek}` matches any Greek letter name,
// `.*{list:nato}.*` finds one hidden inside a phrase. Hunts run on categories,
// and a category is just a large alternation — zero engine cost, since the
// result is an ordinary automaton like any other literal.
//
// Entries are stored the way the corpus stores text (lowercase, apostrophes
// dropped, every other separator a single space) so multiword entries match.

import { Nfa } from "./automata.js";
import { editDistance } from "./edit-distance.js";
import { GENERATED_LISTS } from "./word-lists-data.js";

/** Normalise like corpus.ts: apostrophes vanish, other punctuation splits. */
export function normalizeEntry(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Entries are comma-separated, matching the inline `{list:red,green,blue}`
 * syntax. Not space-separated: a space is a legal character *inside* an entry
 * (the corpus stores phrases that way), so splitting on it would turn
 * "antigua and barbuda" into three entries and make `{list:countries}` match
 * the word AND.
 */
const RAW: Record<string, string> = {
  greek:
    "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu,nu," +
    "xi,omicron,pi,rho,sigma,tau,upsilon,phi,chi,psi,omega",
  nato:
    "alfa,bravo,charlie,delta,echo,foxtrot,golf,hotel,india,juliett,kilo," +
    "lima,mike,november,oscar,papa,quebec,romeo,sierra,tango,uniform,victor," +
    "whiskey,xray,yankee,zulu",
  chesspieces: "king,queen,rook,bishop,knight,pawn",
  planets: "mercury,venus,earth,mars,jupiter,saturn,uranus,neptune",
  months:
    "january,february,march,april,may,june,july,august,september,october," +
    "november,december",
  days: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
  zodiac:
    "aries,taurus,gemini,cancer,leo,virgo,libra,scorpio,sagittarius," +
    "capricorn,aquarius,pisces",
  suits: "hearts,diamonds,clubs,spades",
  compass: "north,south,east,west,northeast,northwest,southeast,southwest",

  // Canonical sets small enough that typing them is more reliable than
  // querying for them — Wikidata's "gemstone" class turns out to be famous
  // individual stones (including one from Tolkien), and its Bible-book class
  // runs to 200 entries across several canons.
  bible:
    "genesis,exodus,leviticus,numbers,deuteronomy,joshua,judges,ruth,samuel," +
    "kings,chronicles,ezra,nehemiah,esther,job,psalms,proverbs,ecclesiastes," +
    "isaiah,jeremiah,lamentations,ezekiel,daniel,hosea,joel,amos,obadiah," +
    "jonah,micah,nahum,habakkuk,zephaniah,haggai,zechariah,malachi,matthew," +
    "mark,luke,john,acts,romans,corinthians,galatians,ephesians,philippians," +
    "colossians,thessalonians,timothy,titus,philemon,hebrews,james,peter," +
    "jude,revelation",
  muses:
    "calliope,clio,erato,euterpe,melpomene,polyhymnia,terpsichore,thalia," +
    "urania",
  sins: "pride,greed,lust,envy,gluttony,wrath,sloth",
  dwarfs: "doc,grumpy,happy,sleepy,bashful,sneezy,dopey",
  oceans: "pacific,atlantic,indian,arctic,southern",
  continents:
    "africa,antarctica,asia,europe,north america,oceania,south america",
  chinesezodiac:
    "rat,ox,tiger,rabbit,dragon,snake,horse,goat,monkey,rooster,dog,pig",
  birthstones:
    "garnet,amethyst,aquamarine,diamond,emerald,pearl,ruby,peridot,sapphire," +
    "opal,topaz,turquoise",
  gemstones:
    "diamond,ruby,sapphire,emerald,amethyst,topaz,opal,garnet,peridot," +
    "aquamarine,turquoise,jade,onyx,agate,quartz,zircon,tourmaline," +
    "moonstone,lapis,obsidian,pearl,amber,jet,coral",
  tarot:
    "fool,magician,high priestess,empress,emperor,hierophant,lovers,chariot," +
    "strength,hermit,wheel of fortune,justice,hanged man,death,temperance," +
    "devil,tower,star,moon,sun,judgement,world",
  moons:
    "moon,phobos,deimos,io,europa,ganymede,callisto,titan,enceladus,mimas," +
    "tethys,dione,rhea,iapetus,miranda,ariel,umbriel,titania,oberon,triton," +
    "charon",
  shakespeare:
    "hamlet,macbeth,othello,king lear,romeo and juliet,julius caesar," +
    "the tempest,twelfth night,much ado about nothing,as you like it," +
    "a midsummer nights dream,the merchant of venice," +
    "the taming of the shrew,richard ii,richard iii,henry iv,henry v," +
    "henry vi,henry viii,king john,titus andronicus,the comedy of errors," +
    "loves labours lost,the two gentlemen of verona," +
    "the merry wives of windsor,troilus and cressida," +
    "alls well that ends well,measure for measure,timon of athens," +
    "coriolanus,antony and cleopatra,pericles,cymbeline,the winters tale",

  // The puzzle-hunt canon: sets that turn up as extraction keys again and
  // again because they are ordered, complete, and everyone knows them.
  rainbow: "red,orange,yellow,green,blue,indigo,violet",
  colors:
    "red,orange,yellow,green,blue,purple,violet,indigo,pink,brown,black," +
    "white,gray,grey,cyan,magenta,maroon,navy,teal,olive,lime,silver,gold," +
    "beige,turquoise,lavender,crimson,scarlet,tan,salmon,coral,khaki,ivory," +
    "azure,amber,mauve,fuchsia",
  resistors: "black,brown,red,orange,yellow,green,blue,violet,gray,white",
  reindeer: "dasher,dancer,prancer,vixen,comet,cupid,donner,blitzen,rudolph",
  cluesuspects: "scarlett,mustard,white,green,peacock,plum,orchid",
  clueweapons:
    "candlestick,knife,dagger,lead pipe,revolver,rope,wrench,spanner",
  cluerooms:
    "kitchen,ballroom,conservatory,dining room,billiard room,library," +
    "lounge,hall,study",
  monopoly:
    "mediterranean avenue,baltic avenue,oriental avenue,vermont avenue," +
    "connecticut avenue,st charles place,states avenue,virginia avenue," +
    "st james place,tennessee avenue,new york avenue,kentucky avenue," +
    "indiana avenue,illinois avenue,atlantic avenue,ventnor avenue," +
    "marvin gardens,pacific avenue,north carolina avenue," +
    "pennsylvania avenue,park place,boardwalk,reading railroad," +
    "pennsylvania railroad,b and o railroad,short line,electric company," +
    "water works",
  wonders:
    "great pyramid of giza,hanging gardens of babylon,temple of artemis," +
    "statue of zeus,mausoleum at halicarnassus,colossus of rhodes," +
    "lighthouse of alexandria",
  apostles:
    "peter,andrew,james,john,philip,bartholomew,thomas,matthew,thaddaeus," +
    "simon,judas,matthias",
  knights:
    "lancelot,gawain,galahad,percival,tristan,kay,bedivere,bors,gareth," +
    "gaheris,mordred,lamorak,agravain,geraint,lionel,ector,palamedes",
  virtues:
    "chastity,temperance,charity,diligence,patience,kindness,humility," +
    "prudence,justice,fortitude,faith,hope",
  hogwarts: "gryffindor,hufflepuff,ravenclaw,slytherin",
  solfege: "do,re,mi,fa,sol,la,ti",
  mohs:
    "talc,gypsum,calcite,fluorite,apatite,orthoclase,feldspar,quartz," +
    "topaz,corundum,diamond",
  siprefixes:
    "quetta,ronna,yotta,zetta,exa,peta,tera,giga,mega,kilo,hecto,deca," +
    "deci,centi,milli,micro,nano,pico,femto,atto,zepto,yocto,ronto,quecto",
  anniversaries:
    "paper,cotton,leather,fruit,wood,candy,wool,copper,bronze,pottery,tin," +
    "aluminum,steel,silk,lace,ivory,crystal,china,silver,pearl,coral,ruby," +
    "sapphire,gold,emerald,diamond,platinum",
  dwarfplanets: "ceres,pluto,haumea,makemake,eris",
  egyptiangods:
    "ra,amun,osiris,isis,horus,anubis,set,seth,thoth,bastet,sekhmet," +
    "hathor,ptah,sobek,nephthys,geb,nut,shu,tefnut,aten,khnum,maat,montu," +
    "neith,khonsu,min,nekhbet,wadjet,taweret,bes,apis,serqet,khepri,atum," +
    "mut,anhur,apophis",
  nbateams:
    "hawks,celtics,nets,hornets,bulls,cavaliers,mavericks,nuggets,pistons," +
    "warriors,rockets,pacers,clippers,lakers,grizzlies,heat,bucks," +
    "timberwolves,pelicans,knicks,thunder,magic,seventy sixers,sixers," +
    "suns,trail blazers,kings,spurs,raptors,jazz,wizards",
  nflteams:
    "cardinals,falcons,ravens,bills,panthers,bears,bengals,browns,cowboys," +
    "broncos,lions,packers,texans,colts,jaguars,chiefs,raiders,chargers," +
    "rams,dolphins,vikings,patriots,saints,giants,jets,eagles,steelers," +
    "forty niners,niners,seahawks,buccaneers,titans,commanders",
  mlbteams:
    "diamondbacks,braves,orioles,red sox,cubs,white sox,reds,guardians," +
    "rockies,tigers,astros,royals,angels,dodgers,marlins,brewers,twins," +
    "mets,yankees,athletics,phillies,pirates,padres,giants,mariners," +
    "cardinals,rays,rangers,blue jays,nationals",
  nhlteams:
    "ducks,bruins,sabres,flames,hurricanes,blackhawks,avalanche," +
    "blue jackets,stars,red wings,oilers,panthers,golden knights,kings," +
    "wild,canadiens,predators,devils,islanders,rangers,senators,flyers," +
    "penguins,sharks,kraken,blues,lightning,maple leafs,canucks,mammoth," +
    "capitals,jets",

  // Sourced from Wikidata; regenerate with `node scripts/build-lists.mjs`.
  ...GENERATED_LISTS,
};

/** Alternative spellings that should resolve to the same list. */
const ALIASES: Record<string, string> = {
  country: "countries",
  nations: "countries",
  nation: "countries",
  states: "usstates",
  state: "usstates",
  capital: "capitals",
  element: "elements",
  constellation: "constellations",
  president: "presidents",
  presidentsurnames: "presidents",
  god: "greekgods",
  gods: "greekgods",
  greekgod: "greekgods",
  norsegod: "norsegods",
  dogs: "dogbreeds",
  dog: "dogbreeds",
  breed: "dogbreeds",
  breeds: "dogbreeds",
  moon: "moons",
  gem: "gemstones",
  gems: "gemstones",
  gemstone: "gemstones",
  birthstone: "birthstones",
  ocean: "oceans",
  continent: "continents",
  muse: "muses",
  sin: "sins",
  deadlysins: "sins",
  dwarves: "dwarfs",
  sevendwarfs: "dwarfs",
  books: "bible",
  biblebooks: "bible",
  plays: "shakespeare",
  shakespeareplays: "shakespeare",
  majorarcana: "tarot",
  zodiacchinese: "chinesezodiac",
  greekletters: "greek",
  natoalphabet: "nato",
  chess: "chesspieces",
  weekdays: "days",
  cardsuits: "suits",
  directions: "compass",
  roygbiv: "rainbow",
  rainbowcolors: "rainbow",
  color: "colors",
  colour: "colors",
  colours: "colors",
  resistor: "resistors",
  resistorcolors: "resistors",
  reindeers: "reindeer",
  santasreindeer: "reindeer",
  suspects: "cluesuspects",
  cluedosuspects: "cluesuspects",
  weapons: "clueweapons",
  cluedoweapons: "clueweapons",
  rooms: "cluerooms",
  cluedorooms: "cluerooms",
  monopolyproperties: "monopoly",
  monopolysquares: "monopoly",
  sevenwonders: "wonders",
  ancientwonders: "wonders",
  wonder: "wonders",
  apostle: "apostles",
  disciples: "apostles",
  knight: "knights",
  roundtable: "knights",
  arthurianknights: "knights",
  virtue: "virtues",
  sevenvirtues: "virtues",
  heavenlyvirtues: "virtues",
  hogwartshouses: "hogwarts",
  houses: "hogwarts",
  solfa: "solfege",
  notes: "solfege",
  mohsscale: "mohs",
  hardness: "mohs",
  prefixes: "siprefixes",
  metricprefixes: "siprefixes",
  siprefix: "siprefixes",
  anniversary: "anniversaries",
  anniversarygifts: "anniversaries",
  weddinganniversaries: "anniversaries",
  dwarfplanet: "dwarfplanets",
  egyptian: "egyptiangods",
  egyptiangod: "egyptiangods",
  nba: "nbateams",
  basketballteams: "nbateams",
  nfl: "nflteams",
  footballteams: "nflteams",
  mlb: "mlbteams",
  baseballteams: "mlbteams",
  nhl: "nhlteams",
  hockeyteams: "nhlteams",
  romangods: "romandeities",
  // "pokemon" is itself a harvested list (all generations merged), so it
  // needs no alias; the per-generation shorthand keeps one.
  pokemongen1: "generationipokemon",
  herbs: "culinaryherbsspices",
  spices: "culinaryherbsspices",
  languages: "officiallanguages",
  stars: "brighteststars",
  starwars: "starwarsplanetsmoons",
};

const CACHE = new Map<string, string[]>();

/** The entries of a named list, or null if there is no such list. */
export function wordList(name: string): string[] | null {
  const key = ALIASES[name] ?? name;
  if (CACHE.has(key)) return CACHE.get(key)!;
  const raw = RAW[key];
  if (!raw) return null;
  const entries = raw.split(",").map(normalizeEntry).filter((e) => e !== "");
  CACHE.set(key, entries);
  return entries;
}

export function listNames(): string[] {
  return Object.keys(RAW).sort();
}

/**
 * An automaton accepting any of the given entries, shaped as a prefix trie.
 *
 * The obvious construction — one chain per entry, unioned — gives the same
 * language but one start-state branch per entry, so a 1,700-word category
 * starts every subset closure with 1,700 live NFA states. Sharing prefixes
 * roughly halves the automaton on real category data (bird: 26,276 arcs to
 * 14,905) and, more importantly, collapses that fan-out: the closure after
 * reading "co" is whatever "co…" leads to, not a thousand dead branches the
 * lazy DFA has to carry.
 *
 * Duplicate entries collapse for free, and an entry that is a prefix of
 * another is simply an accepting node on the way through.
 */
export function entriesNfa(entries: string[]): Nfa | null {
  if (entries.length === 0) return null;
  const nfa = new Nfa();
  const root = nfa.addState();
  nfa.setStart(root);
  // Child lookup per node, since Nfa keeps arcs as a list.
  const children: Array<Map<number, number>> = [new Map()];
  for (const entry of entries) {
    let state = root;
    for (const ch of entry) {
      const c = ch.charCodeAt(0);
      let next = children[state].get(c);
      if (next === undefined) {
        next = nfa.addState();
        children.push(new Map());
        nfa.addArc(state, c, next);
        children[state].set(c, next);
      }
      state = next;
    }
    nfa.setFinal(state);
  }
  return nfa;
}

/** A fetched catalogue: slug -> entries, plus the subject it was named after. */
export interface WikiLists {
  entries: Map<string, string[]>;
  subjects: Map<string, string>;
}

/**
 * Parse the harvested catalogue: one list per line, as
 * `slug<TAB>subject<TAB>entry,entry,…`. Entries are already in corpus form,
 * so this is a split and nothing more.
 */
export function parseWikiLists(text: string): WikiLists {
  const entries = new Map<string, string[]>();
  const subjects = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [slug, subject, body] = line.split("\t");
    if (!slug || !body) continue;
    entries.set(slug, body.split(",").filter((e) => e !== ""));
    subjects.set(slug, subject ?? slug);
  }
  return { entries, subjects };
}

/** Normalise a written list name to a lookup key. */
export function listKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A key with its alias resolved, for looking up harvested lists — the alias
 * table also points at catalogue slugs (`romangods` → `romandeities`), which
 * `wordList` alone cannot serve because they are not bundled.
 */
export function resolveListKey(key: string): string {
  return ALIASES[key] ?? key;
}

/**
 * Does this query name a list the bundle does not carry? Then the catalogue
 * has to be fetched before compiling, which is synchronous.
 */
export function needsWikiLists(query: string): boolean {
  // Any group prefix, not just the right one: see mentionsConstruct. `{anagram
  // <name>:…}` names a list the same way and needs it fetched the same way —
  // its argument is before the colon rather than after, since the colon
  // introduces the pattern it wraps.
  const re =
    /\{\s*(?:[a-z]+\.)?(?:list\s*:\s*([^}]*)|anagram\s+([a-z0-9 ]+?)\s*:)/gi;
  let m;
  while ((m = re.exec(query)) !== null) {
    const arg = m[1] ?? m[2] ?? "";
    if (arg.includes(",")) continue; // an inline list needs nothing
    if (wordList(listKey(arg)) === null) return true;
  }
  return false;
}


/** The closest catalogue slug to `name`, for "did you mean". */
export function suggestList(
  name: string,
  lists: WikiLists | null,
): string | null {
  const key = listKey(name);
  let best: string | null = null;
  let bestScore = 0;
  const names = [
    ...Object.keys(RAW),
    ...(lists ? [...lists.entries.keys()] : []),
  ];
  for (const candidate of names) {
    if (candidate === key) return candidate;
    // Two ways to be close, because guesses miss in two ways: a shortening
    // ("dishes" for "frenchdishes") and a near-spelling ("romandeity" for
    // "romandeities"). Containment catches the first, edit distance the second.
    const long = candidate.length >= key.length ? candidate : key;
    const short = candidate.length >= key.length ? key : candidate;
    let score = 0;
    if (short.length >= 4 && long.includes(short)) {
      // Containment is strong evidence on its own — "dishes" really does mean
      // "frenchdishes" — so it starts at half and the ratio only sharpens it.
      score = 0.5 + 0.5 * (short.length / long.length);
    }
    if (Math.abs(candidate.length - key.length) <= 4) {
      const near = 1 - editDistance(key, candidate) / Math.max(1, long.length);
      if (near > score) score = near;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** The remote-list URLs a query names, in order of appearance. */
export function remoteListUrls(query: string): string[] {
  const out: string[] = [];
  const re = /\{\s*~?\s*(?:word\.)?list\s*:\s*(https?:\/\/[^}\s]+)\s*\}/gi;
  for (const m of query.matchAll(re)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Cap on entries read from one remote list, matching the anagram set cap. */
export const REMOTE_LIST_CAP = 20000;

/**
 * A fetched remote list: one entry per line, normalized like every other
 * list, blank lines and `#` comments dropped, capped.
 */
export function parseRemoteList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const entry = normalizeEntry(t);
    if (entry === "") continue;
    out.push(entry);
    if (out.length >= REMOTE_LIST_CAP) break;
  }
  return out;
}

/**
 * An automaton accepting any entry of a named list, or — when the argument
 * carries commas — of a list written inline: `{list:red,green,blue}`. Hunts
 * run on categories nobody could ship in advance, and an inline list needs no
 * settings screen and travels in the URL like the rest of the query.
 */
export function listNfa(
  nameOrEntries: string,
  lists: WikiLists | null = null,
): Nfa | null {
  if (nameOrEntries.includes(",")) {
    return entriesNfa(
      nameOrEntries.split(",").map(normalizeEntry).filter((e) => e !== ""),
    );
  }
  // Aliases resolve before the harvested-catalogue fallback too, so a name
  // like `romangods` finds the wiki list filed under `romandeities`.
  const key = listKey(nameOrEntries);
  const entries =
    wordList(key) ?? lists?.entries.get(resolveListKey(key)) ?? null;
  return entries ? entriesNfa(entries) : null;
}
