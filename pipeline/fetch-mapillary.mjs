// Stage 1 of the street-level pass: find out which Mapillary photos exist inside
// HSR and where each camera stood.
//
// The Graph API's `/images?bbox=` search returns an empty set even over dense
// coverage, so this walks the public coverage vector tiles instead — the route
// Mapillary's own viewer uses. z14 is the first zoom that carries individual
// image points (below that you only get sequence lines).
//
//   MAPILLARY_TOKEN=... node pipeline/fetch-mapillary.mjs
//
// Writes data/mapillary-images.json: one record per camera position, already
// projected into the same local metres the world uses, so stage 2 can match
// cameras to building walls without touching geography again.

import fs from "node:fs";
import path from "node:path";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "mapillary-images.json");

// Keep these in step with pipeline/build-world.mjs — same origin, same axes.
const ORIGIN = { lat: 12.917, lon: 77.6422 };
const METRES_PER_DEG_LAT = 110574;
const metresPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const project = (lat, lon) => [
  (lon - ORIGIN.lon) * metresPerDegLon(ORIGIN.lat),
  -(lat - ORIGIN.lat) * METRES_PER_DEG_LAT,
];

// The world's own bounds, plus enough margin that a camera standing across the
// road from an edge building still gets collected.
const MARGIN = 180;
const Z = 14;

const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function readToken() {
  if (process.env.MAPILLARY_TOKEN) return process.env.MAPILLARY_TOKEN;
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      if (line.slice(0, eq).trim() !== "MAPILLARY_TOKEN") continue;
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("MAPILLARY_TOKEN not set (env or .env)");
}

async function tile(token, z, x, y) {
  const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${z}/${x}/${y}?access_token=${token}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url);
    if (res.status === 200) return Buffer.from(await res.arrayBuffer());
    if (res.status === 404) return null; // no coverage in this tile at all
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw new Error(`tile ${z}/${x}/${y} failed after retries`);
}

const world = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "world.json"), "utf8"));
const [minX, minZ, maxX, maxZ] = world.bounds;
const box = { minX: minX - MARGIN, minZ: minZ - MARGIN, maxX: maxX + MARGIN, maxZ: maxZ + MARGIN };

// Local metres back to lon/lat so we know which tiles to ask for.
const unproject = (x, z) => [
  ORIGIN.lat - z / METRES_PER_DEG_LAT,
  ORIGIN.lon + x / metresPerDegLon(ORIGIN.lat),
];
const [northLat, westLon] = unproject(box.minX, box.minZ);
const [southLat, eastLon] = unproject(box.maxX, box.maxZ);

const x0 = lon2tile(westLon, Z);
const x1 = lon2tile(eastLon, Z);
const y0 = lat2tile(northLat, Z);
const y1 = lat2tile(southLat, Z);

const token = readToken();
console.log(`tiles z${Z}: x ${x0}..${x1}, y ${y0}..${y1}`);

const images = [];
const sequences = new Map();
let empty = 0;

for (let x = x0; x <= x1; x += 1) {
  for (let y = y0; y <= y1; y += 1) {
    const buf = await tile(token, Z, x, y);
    if (!buf || !buf.length) {
      empty += 1;
      continue;
    }
    const decoded = new VectorTile(new PbfReader(buf));

    const seqLayer = decoded.layers.sequence;
    if (seqLayer) {
      for (let i = 0; i < seqLayer.length; i += 1) {
        const p = seqLayer.feature(i).properties;
        if (p.id && !sequences.has(p.id)) {
          sequences.set(p.id, { captured_at: p.captured_at, is_pano: !!p.is_pano });
        }
      }
    }

    const imgLayer = decoded.layers.image;
    if (!imgLayer) continue;
    for (let i = 0; i < imgLayer.length; i += 1) {
      const feature = imgLayer.feature(i);
      const geo = feature.toGeoJSON(x, y, Z);
      const [lon, lat] = geo.geometry.coordinates;
      const [lx, lz] = project(lat, lon);
      if (lx < box.minX || lx > box.maxX || lz < box.minZ || lz > box.maxZ) continue;
      const p = feature.properties;
      images.push({
        id: String(p.id),
        // Camera position in world metres, and where the lens was pointing.
        // compass_angle is degrees clockwise from true north; +Z runs south in
        // world space, so a bearing of 0 looks toward -Z.
        x: Math.round(lx * 100) / 100,
        z: Math.round(lz * 100) / 100,
        bearing: p.compass_angle == null ? null : Math.round(p.compass_angle * 10) / 10,
        pano: !!p.is_pano,
        at: p.captured_at || null,
        quality: p.quality_score == null ? null : Math.round(p.quality_score * 1000) / 1000,
        seq: p.sequence_id ? String(p.sequence_id) : null,
      });
    }
  }
}

// Same camera can appear in two tiles along a shared edge.
const byId = new Map();
for (const img of images) if (!byId.has(img.id)) byId.set(img.id, img);
const unique = [...byId.values()];

const years = {};
for (const img of unique) {
  const y = img.at ? new Date(img.at).getUTCFullYear() : "unknown";
  years[y] = (years[y] || 0) + 1;
}

const payload = {
  source: "Mapillary coverage tiles (mly1_public)",
  attribution: "Street-level imagery © Mapillary contributors, CC BY-SA 4.0",
  fetched_for: world.place,
  origin: ORIGIN,
  bounds: [box.minX, box.minZ, box.maxX, box.maxZ],
  zoom: Z,
  counts: {
    images: unique.length,
    panoramic: unique.filter((i) => i.pano).length,
    flat: unique.filter((i) => !i.pano).length,
    sequences: sequences.size,
    withBearing: unique.filter((i) => i.bearing != null).length,
  },
  byYear: years,
  images: unique,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));

console.log(`empty tiles: ${empty}`);
console.log(`images: ${unique.length} (${payload.counts.panoramic} pano, ${payload.counts.flat} flat)`);
console.log(`sequences: ${sequences.size}`);
console.log("by year:", Object.entries(years).sort().map(([y, n]) => `${y}:${n}`).join(" "));
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
