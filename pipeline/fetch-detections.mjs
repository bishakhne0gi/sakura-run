// Stage 3b: per-photo semantic detections, so baking knows what it is looking at.
//
//   node pipeline/fetch-detections.mjs
//
// Inspecting the first bake showed roughly half the tiles were a parked truck, a
// tree trunk, an auto or a utility pole rather than a wall. The building-footprint
// occlusion test in stage 2 cannot catch any of that: none of it is in
// OpenStreetMap, and all of it stands between a road camera and a facade.
//
// Mapillary ships its own segmentation per image, which names exactly the classes
// that matter: construction--structure--building is the facade, and cars,
// motorcycles, vegetation and poles are the things in front of it. Geometry
// arrives as a base64 single-layer vector tile in image pixel space at extent
// 4096, so a polygon converts to normalised uv by dividing by 4096.
//
// object--sign--store is kept too — those are the real shop boards, and they are
// worth cropping on their own terms rather than only masking around.

import fs from "node:fs";
import path from "node:path";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "data", "mly", "det");
const OUT = path.join(ROOT, "data", "mapillary-detections.json");

const CONCURRENCY = 8;
const EXTENT = 4096;

// What each class means for a facade bake.
const OCCLUDER = /^(object--vehicle--|nature--vegetation|object--support--|human--|object--street-light|void--ego-vehicle|object--trash-can|object--bench|object--bike-rack|construction--barrier--temporary)/;
const BUILDING = /^construction--structure--building/;
const SIGN = /^object--sign--(store|advertisement|information)/;
// Ground and sky are neither facade nor occluder, but a tile made mostly of them
// is looking at the wrong thing entirely.
const GROUND = /^(construction--flat--(road|sidewalk|crosswalk|driveway|parking)|nature--sky|nature--terrain|void--ground)/;

function readToken() {
  if (process.env.MAPILLARY_TOKEN) return process.env.MAPILLARY_TOKEN;
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === "MAPILLARY_TOKEN") {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("MAPILLARY_TOKEN not set");
}
const token = encodeURIComponent(readToken());

fs.mkdirSync(CACHE, { recursive: true });

const facades = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-facades.json"), "utf8"));
const wanted = facades.images.map((i) => i.image);
console.log(`photos needing detections: ${wanted.length}`);

// Decode one detection's geometry into rings of normalised uv.
function rings(base64) {
  const tile = new VectorTile(new PbfReader(Buffer.from(base64, "base64")));
  const layerName = Object.keys(tile.layers)[0];
  if (!layerName) return [];
  const layer = tile.layers[layerName];
  const out = [];
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    const extent = layer.extent || EXTENT;
    for (const ring of feature.loadGeometry()) {
      if (ring.length < 3) continue;
      // Rounded to 4 decimals: sub-pixel precision on a 4096 grid, and it keeps
      // the JSON to a sane size across 873 photos.
      out.push(ring.map((p) => [
        Math.round((p.x / extent) * 1e4) / 1e4,
        Math.round((p.y / extent) * 1e4) / 1e4,
      ]));
    }
  }
  return out;
}

async function fetchDetections(id) {
  const file = path.join(CACHE, `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`https://graph.mapillary.com/${id}/detections?access_token=${token}&fields=id,value,geometry`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || "graph error");
      const raw = body.data || [];
      // Only the classes that change a decision are kept — the rest is mostly
      // void--unlabeled and would triple the file for nothing.
      const kept = [];
      for (const d of raw) {
        const role = BUILDING.test(d.value) ? "building"
          : OCCLUDER.test(d.value) ? "occluder"
          : SIGN.test(d.value) ? "sign"
          : GROUND.test(d.value) ? "ground"
          : null;
        if (!role || !d.geometry) continue;
        for (const ring of rings(d.geometry)) kept.push({ role, value: d.value, ring });
      }
      fs.writeFileSync(file, JSON.stringify(kept));
      return kept;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

const byImage = {};
const failures = [];
const tally = { building: 0, occluder: 0, sign: 0, ground: 0 };
let index = 0;
let done = 0;
let noDetections = 0;

async function worker() {
  while (index < wanted.length) {
    const id = wanted[index++];
    try {
      const kept = await fetchDetections(id);
      if (!kept.length) noDetections += 1;
      byImage[id] = kept;
      for (const k of kept) tally[k.role] += 1;
    } catch (error) {
      failures.push({ id, error: String(error.message || error).slice(0, 80) });
    }
    done += 1;
    if (done % 100 === 0 || done === wanted.length) {
      console.log(`  ${done}/${wanted.length}  failed ${failures.length}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const payload = {
  attribution: "Detections © Mapillary contributors, CC BY-SA 4.0",
  extentNote: "polygon rings are normalised 0..1 in image space",
  counts: {
    photos: Object.keys(byImage).length,
    failed: failures.length,
    photosWithNone: noDetections,
    polygons: tally,
  },
  failures: failures.slice(0, 30),
  byImage,
};
fs.writeFileSync(OUT, JSON.stringify(payload));

console.log(`\nphotos with detections  ${Object.keys(byImage).length - noDetections}/${Object.keys(byImage).length}`);
console.log(`polygons  building ${tally.building}  occluder ${tally.occluder}  sign ${tally.sign}  ground ${tally.ground}`);
console.log(`failed    ${failures.length}`);
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
