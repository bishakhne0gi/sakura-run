// Pull the soundtrack out of a 529 MB release zip without downloading 529 MB.
//
// Open Lo-Fi publishes its 166 tracks only as one release archive. We want
// eight of them. A zip's index lives at the end of the file and every entry
// records where its data starts, so with HTTP range requests the whole thing
// can be treated as a remote filesystem: read the last 200 KB to find the end-
// of-central-directory record, read the central directory it points at, then
// fetch exactly the byte ranges of the eight members we want and inflate them.
//
// 24.8 MB transferred instead of 529 MB, and no temporary half-gigabyte file.
//
// Licence: CC0 1.0 Universal (public domain). No attribution is required; the
// credit in public/music/index.json and the README is courtesy, not obligation.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "public", "music");
const URL_ = "https://github.com/btahir/open-lofi/releases/download/v1.0.0/openlofi.zip";

const WANT = [
  "temple-at-dawn", "moon-through-bamboo", "paper-lantern-rain",
  "lanterns-in-slow-motion", "teacup-morning-fog", "bamboo-shadow-waltz",
  "bells-before-sunrise", "misty-steam-quiet-dreams",
];

// Titles come from the project's own catalog.json rather than being derived
// from the filename. Deriving them means inventing a title-case rule, and no
// rule gets both "Moon Through Bamboo" and "Lanterns in Slow Motion" right —
// these are somebody's track names, so they are read, not guessed.
const CATALOG = "https://raw.githubusercontent.com/btahir/open-lofi/main/catalog.json";

async function range(from, to) {
  const response = await fetch(URL_, { headers: { Range: `bytes=${from}-${to}` } });
  if (!response.ok && response.status !== 206) throw new Error(`range ${from}-${to}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const catalog = await (await fetch(CATALOG)).json();
  const titles = new Map((catalog.tracks ?? []).map((t) => [path.basename(t.filename, ".mp3"), t.title]));

  const head = await fetch(URL_, { method: "HEAD" });
  const total = Number(head.headers.get("content-length"));
  if (!total) throw new Error("no content-length; cannot seek");
  if (head.headers.get("accept-ranges") !== "bytes") throw new Error("server will not serve ranges");
  console.log(`archive ${(total / 1e6).toFixed(0)} MB, ranges supported`);

  const tail = await range(total - 200000, total - 1);
  const eocd = tail.lastIndexOf(Buffer.from("PK\x05\x06", "binary"));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  console.log(`central directory: ${entries} entries at ${cdOffset}`);

  const cd = await range(cdOffset, cdOffset + cdSize - 1);
  const found = new Map();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const comp = cd.readUInt32LE(p + 20);
    const uncomp = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    const slug = path.basename(name, ".mp3");
    if (WANT.includes(slug)) found.set(slug, { name, method, comp, uncomp, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const missing = WANT.filter((w) => !found.has(w));
  if (missing.length) throw new Error(`not in archive: ${missing.join(", ")}`);

  fs.mkdirSync(OUT, { recursive: true });
  const tracks = [];
  let pulled = 0;

  for (const slug of WANT) {
    const entry = found.get(slug);
    // The central directory's extra field and the local header's are allowed to
    // differ in length, so the data offset has to be read from the local header
    // itself rather than assumed from the central one.
    const local = await range(entry.localOffset, entry.localOffset + 29);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`${slug}: bad local header`);
    const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = await range(start, start + entry.comp - 1);
    const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
    if (data.length !== entry.uncomp) throw new Error(`${slug}: expected ${entry.uncomp} bytes, got ${data.length}`);
    // MP3s are already compressed, so the zip stores them near 1:1 — a member
    // that inflates to a wildly different size means the offsets are wrong.
    fs.writeFileSync(path.join(OUT, `${slug}.mp3`), data);
    pulled += entry.comp;
    tracks.push({ file: `${slug}.mp3`, title: titles.get(slug) ?? slug });
    console.log(`  ${slug}.mp3  ${(data.length / 1e6).toFixed(2)} MB`);
  }

  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({
    source: "Open Lo-Fi — https://github.com/btahir/open-lofi",
    license: "CC0 1.0 Universal (public domain). No attribution required.",
    attribution: "Music: Open Lo-Fi (CC0 1.0)",
    tracks,
  }, null, 2));

  console.log(`\n${tracks.length} tracks, ${(pulled / 1e6).toFixed(1)} MB transferred `
    + `(${((1 - pulled / total) * 100).toFixed(1)}% of the archive skipped)`);
}

main().catch((error) => { console.error(error); process.exit(1); });
