// Stage 3a: camera pose for *every* photo in the area — metadata only, no pixels.
//
//   node pipeline/fetch-poses.mjs
//
// Stage 2 had to guess which photo sees which wall, because all it had from the
// coverage tiles was a position and a compass angle, so it assumed a ±33° lens
// and hoped. Verification put that at 45% of wall quads landing fully in frame.
//
// Real pose is cheap — it is one small JSON per photo and no image bytes — so it
// is worth fetching for all of them and then matching by actual projection
// instead of by assumption. Pixels get downloaded afterwards, only for the
// photos that win.
//
// Shares data/mly/meta with stage 3, so anything already fetched is free.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const META = path.join(ROOT, "data", "mly", "meta");
const OUT = path.join(ROOT, "data", "mapillary-poses.json");

const CONCURRENCY = 10;
const FIELDS = [
  "id", "is_pano", "camera_type", "camera_parameters", "computed_rotation",
  "computed_geometry", "geometry", "computed_altitude", "altitude",
  "computed_compass_angle", "compass_angle", "width", "height",
  "captured_at", "quality_score", "thumb_2048_url",
].join(",");

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

fs.mkdirSync(META, { recursive: true });

const images = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-images.json"), "utf8")).images;
console.log(`poses to resolve: ${images.length}`);

const poses = [];
const failures = [];
let index = 0;
let done = 0;
let cached = 0;

async function one(id) {
  const file = path.join(META, `${id}.json`);
  if (fs.existsSync(file)) {
    cached += 1;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`https://graph.mapillary.com/${id}?access_token=${token}&fields=${FIELDS}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || "graph error");
      fs.writeFileSync(file, JSON.stringify(body));
      return body;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function worker() {
  while (index < images.length) {
    const img = images[index++];
    try {
      const meta = await one(img.id);
      const geom = meta.computed_geometry || meta.geometry;
      poses.push({
        id: String(meta.id),
        pano: !!meta.is_pano,
        cameraType: meta.camera_type || null,
        params: meta.camera_parameters || null,
        rotation: meta.computed_rotation || null,
        lon: geom?.coordinates?.[0] ?? null,
        lat: geom?.coordinates?.[1] ?? null,
        alt: meta.computed_altitude ?? meta.altitude ?? null,
        bearing: meta.computed_compass_angle ?? meta.compass_angle ?? null,
        width: meta.width || null,
        height: meta.height || null,
        at: meta.captured_at || null,
        quality: meta.quality_score ?? null,
        thumb: meta.thumb_2048_url || null,
      });
    } catch (error) {
      failures.push({ id: img.id, error: String(error.message || error).slice(0, 90) });
    }
    done += 1;
    if (done % 500 === 0 || done === images.length) {
      console.log(`  ${done}/${images.length}  ok ${poses.length}  failed ${failures.length}  (${cached} from cache)`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// thumb_2048_url is a signed, expiring URL, so it is deliberately not persisted
// here — stage 3 re-reads it from the cached metadata when it downloads.
const payload = {
  attribution: "Street-level imagery © Mapillary contributors, CC BY-SA 4.0",
  counts: {
    requested: images.length,
    resolved: poses.length,
    failed: failures.length,
    panoramas: poses.filter((p) => p.pano).length,
    withRotation: poses.filter((p) => p.rotation).length,
  },
  failures: failures.slice(0, 40),
  poses: poses.map(({ thumb, ...rest }) => rest),
};
fs.writeFileSync(OUT, JSON.stringify(payload));

console.log(`\nresolved     ${poses.length}/${images.length}  (${failures.length} failed)`);
console.log(`with pose    ${payload.counts.withRotation}`);
console.log(`panoramas    ${payload.counts.panoramas}`);
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
