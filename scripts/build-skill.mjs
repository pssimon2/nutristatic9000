// Postbuild: package the nutri-url Claude skill for download.
//
// The skill's source of truth is skills/nutri-url/SKILL.md in this repo; the
// site offers it two ways, and this writes both into web/dist:
//
//   nutri-url-skill.md   the file itself, for `curl -o ~/.claude/skills/…`
//   nutri-url-skill.zip  a zip holding nutri-url/SKILL.md, the folder shape
//                        claude.ai's "upload skill" expects
//
// The zip is written by hand (stored entries, no compression — the skill is a
// few KB) so the build needs no `zip` binary and no archive dependency. All
// timestamps are fixed, so the same input bytes give the same zip bytes and a
// deploy diff stays honest.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.env.NUTRISTATIC_DIST || "web/dist");
const src = path.resolve("skills/nutri-url/SKILL.md");
if (!fs.existsSync(dist) || !fs.existsSync(src)) {
  console.error(`build-skill: missing ${fs.existsSync(dist) ? src : dist}`);
  process.exit(1);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; ++n) {
  let c = n;
  for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A stored-entry zip of {name → bytes}, with a constant DOS timestamp. */
function zip(entries) {
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const skill = fs.readFileSync(src);
fs.writeFileSync(path.join(dist, "nutri-url-skill.md"), skill);
fs.writeFileSync(
  path.join(dist, "nutri-url-skill.zip"),
  zip([["nutri-url/SKILL.md", skill]]),
);
console.log(
  `build-skill: packaged skills/nutri-url (${skill.length} bytes) as ` +
    "nutri-url-skill.md + nutri-url-skill.zip",
);
