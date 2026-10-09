// Stage 3: pull the actual pixels, plus the camera pose needed to use them.
//
//   node pipeline/fetch-photos.mjs
//
// Reads the photo list stage 2 chose and downloads, for each one:
//   * full pose — computed_rotation (angle-axis, world->camera),
//     computed_geometry (corrected lon/lat), computed_altitude, and
//     camera_parameters (focal + radial distortion)
//   * the 2048 px thumbnail
//
// Pose is the point. Without it a "facade texture" is a guessed rectangle cut
// out of a photo, which lands crooked on nine walls out of ten. With it, stage 4
// projects the wall's actual 3D quad through the actual camera and samples what
// is really there.
//
// Everything lands in data/mly/ (gitignored — roughly half a gigabyte) and the
// script is resumable: re-running skips whatever is already on disk.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "data", "mly");
const META = path.join(CACHE, "meta");
const JPEG = path.join(CACHE, "jpg");
const OUT = path.join(ROOT, "data", "mapillary-photos.json");

const CONCURRENCY = 8;
const FIELDS = [
  "id",
  "is_pano",
  "camera_type",
  "camera_parameters",
  "computed_rotation",
  "computed_geometry",
  "geometry",
  "computed_altitude",
  "altitude",
  "computed_compass_angle",
  "compass_angle",
  "width",
  "height",
  "captured_at",
  "quality_score",
  "thumb_2048_url",
].join(",");

function readToken() {
  if (process.env.MAPILLARY_TOKEN) return process.env.MAPILLARY_TOKEN;
  const envFile = path.join(ROOT, ".env");
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === "MAPILLARY_TOKEN") {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("MAPILLARY_TOKEN not set");
}

const token = encodeURIComponent(readToken());

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Graph API rate-limits in bursts; backing off is usually enough.
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`${label}: ${lastError?.message || "failed"}`);
}

async function fetchMeta(id) {
  const file = path.join(META, `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const json = await withRetry(`meta ${id}`, async () => {
    const res = await fetch(`https://graph.mapillary.com/${id}?access_token=${token}&fields=${FIELDS}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "graph error");
    return body;
  });
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

async function fetchJpeg(id, url) {
  const file = path.join(JPEG, `${id}.jpg`);
  if (fs.existsSync(file) && fs.statSync(file).size > 4096) return fs.statSync(file).size;
  const bytes = await withRetry(`jpeg ${id}`, async () => {
    const res = await fetch(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

for (const dir of [CACHE, META, JPEG]) fs.mkdirSync(dir, { recursive: true });

const facades = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-facades.json"), "utf8"));
const wanted = facades.images.map((i) => i.image);
console.log(`photos to fetch: ${wanted.length}`);

const poses = [];
const failures = [];
let done = 0;
let bytes = 0;
let started = 0;

async function worker() {
  while (started < wanted.length) {
    const id = wanted[started++];
    try {
      const meta = await fetchMeta(id);
      if (!meta.thumb_2048_url) throw new Error("no thumb_2048_url");
      bytes += await fetchJpeg(id, meta.thumb_2048_url);

      // computed_* is the output of Mapillary's own structure-from-motion pass
      // and is markedly better aligned than the raw EXIF; fall back only when
      // it is absent.
      const geom = meta.computed_geometry || meta.geometry;
      poses.push({
        id: String(meta.id),
        pano: !!meta.is_pano,
        cameraType: meta.camera_type || null,
        // [focal, k1, k2] for perspective; equirectangular carries none.
        params: meta.camera_parameters || null,
        // Angle-axis, world (ECEF-local ENU) to camera. Stage 4 turns this into
        // a rotation matrix.
        rotation: meta.computed_rotation || null,
        lon: geom?.coordinates?.[0] ?? null,
        lat: geom?.coordinates?.[1] ?? null,
        alt: meta.computed_altitude ?? meta.altitude ?? null,
        bearing: meta.computed_compass_angle ?? meta.compass_angle ?? null,
        // Pixel size of the *original*, needed to scale camera_parameters to
        // the 2048 px thumbnail we actually sample.
        width: meta.width || null,
        height: meta.height || null,
        at: meta.captured_at || null,
        quality: meta.quality_score ?? null,
      });
    } catch (error) {
      failures.push({ id, error: String(error.message || error) });
    }
    done += 1;
    if (done % 100 === 0 || done === wanted.length) {
      console.log(`  ${done}/${wanted.length}  ok ${poses.length}  failed ${failures.length}  ${(bytes / 1e6).toFixed(0)} MB`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const missingPose = poses.filter((p) => !p.rotation).length;
const payload = {
  attribution: "Street-level imagery © Mapillary contributors, CC BY-SA 4.0",
  counts: {
    requested: wanted.length,
    fetched: poses.length,
    failed: failures.length,
    panoramas: poses.filter((p) => p.pano).length,
    perspective: poses.filter((p) => !p.pano).length,
    withRotation: poses.length - missingPose,
  },
  failures: failures.slice(0, 50),
  poses,
};
fs.writeFileSync(OUT, JSON.stringify(payload));

console.log(`\nfetched      ${poses.length}/${wanted.length}  (${failures.length} failed)`);
console.log(`panoramas    ${payload.counts.panoramas}`);
console.log(`perspective  ${payload.counts.perspective}`);
console.log(`with pose    ${payload.counts.withRotation}`);
console.log(`cache        ${(bytes / 1e6).toFixed(0)} MB new in data/mly/jpg`);
if (failures.length) console.log("first failures:", failures.slice(0, 5));
console.log(`wrote ${path.relative(ROOT, OUT)}`);
