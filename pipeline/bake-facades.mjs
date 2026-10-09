// Stage 4: turn photos into rectified facade textures.
//
//   node pipeline/bake-facades.mjs
//
// For each matched building this walks the *output* texture and asks, per pixel,
// "which point on the wall is this, and where does that point appear in the
// photo?" — an inverse warp. Sampling that way rather than forward-projecting
// the photo means no gaps, no seams, and full perspective correction for free:
// a wall shot from 30° off-axis comes out square, because every output pixel
// asks for its own source location.
//
// Output is a small number of atlases rather than 1,029 files, so the renderer
// binds a handful of textures instead of issuing a thousand draw calls.

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { makeCamera } from "./project.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const JPEG = path.join(ROOT, "data", "mly", "jpg");
const OUTDIR = path.join(ROOT, "public", "facades");

const TILE = 256;          // per facade, in the atlas
const GRID = 16;           // 16x16 tiles => 256 facades per atlas
const ATLAS = TILE * GRID; // 4096, universally supported
const SUPERSAMPLE = 2;     // sample 2x2 per output pixel, then average
const UPPER_BAND = 0.62;   // fraction of the wall the semantic gate judges

const facades = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-facades.json"), "utf8"));
const poseFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-poses.json"), "utf8"));
const poses = new Map(poseFile.poses.map((p) => [p.id, p]));
const origin = facades.origin;

// Semantic masks. Without these, half the tiles come out as a parked truck, a
// tree trunk or an auto — everything that stands between a road camera and a
// wall in HSR and appears in no map data.
const detFile = fs.existsSync(path.join(ROOT, "data", "mapillary-detections.json"))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-detections.json"), "utf8"))
  : { byImage: {} };

const MASK = 1024;
const ROLE = { ground: 1, building: 2, sign: 3, occluder: 4 };

// Even-odd scanline fill of one ring, in normalised image coordinates.
function fillRing(mask, ring, value) {
  const pts = ring.map(([u, v]) => [u * MASK, v * MASK]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(MASK - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y += 1) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, n = pts.length; i < n; i += 1) {
      const [xa, ya] = pts[i];
      const [xb, yb] = pts[(i + 1) % n];
      if ((ya <= cy && yb > cy) || (yb <= cy && ya > cy)) {
        xs.push(xa + ((cy - ya) / (yb - ya)) * (xb - xa));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = y * MASK;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const sx = Math.max(0, Math.ceil(xs[k] - 0.5));
      const ex = Math.min(MASK - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = sx; x <= ex; x += 1) mask[row + x] = value;
    }
  }
}

// Painted in depth order: ground first, then walls, then signs on the walls, and
// occluders last because they are physically in front of all of it.
function buildMask(list) {
  if (!list || !list.length) return null;
  const mask = new Uint8Array(MASK * MASK);
  for (const role of ["ground", "building", "sign", "occluder"]) {
    for (const d of list) if (d.role === role) fillRing(mask, d.ring, ROLE[role]);
  }
  return mask;
}

// One decode per photo, however many walls it fronts.
const byImage = new Map();
for (const m of facades.matches) {
  let bucket = byImage.get(m.image);
  if (!bucket) byImage.set(m.image, (bucket = []));
  bucket.push(m);
}

fs.mkdirSync(OUTDIR, { recursive: true });

const atlases = [];
const entries = [];
let slot = 0;
let baked = 0;
let skipped = 0;
const skipReasons = {};
const note = (why) => { skipReasons[why] = (skipReasons[why] || 0) + 1; skipped += 1; };

function newAtlas() {
  // Mid grey, so any tile that never gets written reads as neutral rather than
  // as a black hole in the middle of a wall.
  atlases.push(Buffer.alloc(ATLAS * ATLAS * 3, 128));
}

console.log(`photos to process: ${byImage.size}  facades to bake: ${facades.matches.length}`);

let processed = 0;
for (const [imageId, list] of byImage) {
  processed += 1;
  if (processed % 100 === 0) console.log(`  ${processed}/${byImage.size} photos, ${baked} facades baked`);

  const pose = poses.get(imageId);
  const file = path.join(JPEG, `${imageId}.jpg`);
  if (!pose || !fs.existsSync(file)) { list.forEach(() => note("photo not downloaded")); continue; }

  const cam = makeCamera(pose, origin);
  if (!cam) { list.forEach(() => note("no pose")); continue; }

  let src;
  let sw;
  let sh;
  try {
    const decoded = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    src = decoded.data;
    sw = decoded.info.width;
    sh = decoded.info.height;
    if (decoded.info.channels !== 3) {
      // Force 3 channels so the indexing below is uniform.
      const rgb = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      src = rgb.data; sw = rgb.info.width; sh = rgb.info.height;
    }
  } catch {
    list.forEach(() => note("decode failed"));
    continue;
  }

  const sample = (u, v, out) => {
    // Bilinear, in normalised coordinates so thumbnail size is irrelevant.
    const x = Math.min(sw - 1.001, Math.max(0, u * sw - 0.5));
    const y = Math.min(sh - 1.001, Math.max(0, v * sh - 0.5));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * sw + x0) * 3;
    const i10 = i00 + 3;
    const i01 = i00 + sw * 3;
    const i11 = i01 + 3;
    for (let c = 0; c < 3; c += 1) {
      out[c] +=
        src[i00 + c] * (1 - fx) * (1 - fy) +
        src[i10 + c] * fx * (1 - fy) +
        src[i01 + c] * (1 - fx) * fy +
        src[i11 + c] * fx * fy;
    }
  };

  const mask = buildMask(detFile.byImage[imageId]);

  for (const m of list) {
    const [ax, az, bx, bz] = m.wall;
    const h = m.bakeHeight;

    const atlasIndex = Math.floor(slot / (GRID * GRID));
    while (atlases.length <= atlasIndex) newAtlas();
    const cell = slot % (GRID * GRID);
    const tx = (cell % GRID) * TILE;
    const ty = Math.floor(cell / GRID) * TILE;
    const target = atlases[atlasIndex];

    let wrote = 0;
    let wroteUpper = 0;
    let buildingPixels = 0;
    let occluderPixels = 0;
    let groundPixels = 0;
    let classified = 0;
    const acc = [0, 0, 0];

    for (let j = 0; j < TILE; j += 1) {
      for (let i = 0; i < TILE; i += 1) {
        acc[0] = acc[1] = acc[2] = 0;
        let taken = 0;

        for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
          for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
            // The texture's left edge is wall point b, not a. Walking a->b with
            // the outward normal gives a left-handed frame, so sampling in that
            // order comes out mirrored — every shop board read backwards in the
            // first bake. Flipping the parameter here (and swapping the endpoints
            // recorded below, so the renderer agrees) fixes it at the source.
            const fu = 1 - (i + (sx + 0.5) / SUPERSAMPLE) / TILE;
            const fv = (j + (sy + 0.5) / SUPERSAMPLE) / TILE;
            // Along the wall, and up it. v=0 is the top of the texture, so it
            // maps to the eaves.
            const wx = ax + (bx - ax) * fu;
            const wz = az + (bz - az) * fu;
            const wy = h * (1 - fv);
            const p = cam.project(wx, wy, wz);
            if (!p) continue;
            if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) continue;
            sample(p.u, p.v, acc);
            taken += 1;

            if (mask && sy === 0 && sx === 0) {
              const mu = Math.min(MASK - 1, Math.max(0, Math.floor(p.u * MASK)));
              const mv = Math.min(MASK - 1, Math.max(0, Math.floor(p.v * MASK)));
              const role = mask[mv * MASK + mu];
              // Judged over the upper part of the wall only. Two thirds of these
              // photos were shot from a car, so the bottom of every frame is the
              // dashboard (void--ego-vehicle), and a wall quad running down to
              // ground level always intersects it — which is what rejected 440
              // perfectly good facades. It costs nothing to ignore: in game the
              // bottom of a wall is behind a compound wall and a row of parked
              // two-wheelers, both of which this world already draws.
              const upper = j < TILE * UPPER_BAND;
              if (role && upper) {
                classified += 1;
                if (role === ROLE.occluder) occluderPixels += 1;
                // Road, footpath, sky, bare earth. A tile made largely of these
                // is aimed past the building, and is the reason the first atlas
                // had tiles of empty tarmac.
                else if (role === ROLE.ground) groundPixels += 1;
                // A shop board is part of the facade, and the best part of it.
                else if (role === ROLE.building || role === ROLE.sign) buildingPixels += 1;
              }
            }
          }
        }

        const o = ((ty + j) * ATLAS + (tx + i)) * 3;
        if (taken) {
          target[o] = Math.round(acc[0] / taken);
          target[o + 1] = Math.round(acc[1] / taken);
          target[o + 2] = Math.round(acc[2] / taken);
          wrote += 1;
          if (j < TILE * UPPER_BAND) wroteUpper += 1;
        }
      }
    }

    // A tile that is mostly empty means the wall left the frame partway; those
    // bake to a half-photo half-grey texture, which looks worse than a clean
    // procedural facade.
    if (wrote < TILE * TILE * 0.82) { note("wall left frame"); continue; }

    // Semantic gate. Evidence is now required rather than merely respected: a
    // photo with no segmentation gets no facade. Letting those through is what
    // left tree canopy and road surface in the atlas — the gate was simply not
    // consulted for 109 of the 873 photos, and nothing else was checking.
    // Fractions are taken over the pixels actually written, not over the pixels
    // that carry a label. Most of any photo belongs to classes this pipeline
    // discards (void--unlabeled and friends), so a label-relative denominator
    // makes a well-segmented facade look unsegmented and rejected 458 good
    // tiles. Absolute coverage is the honest measure: enough building to trust,
    // little enough occluder to use.
    if (!mask) { note("no segmentation for this photo"); continue; }
    const denom = Math.max(1, wroteUpper);
    const occFrac = occluderPixels / denom;
    const gndFrac = groundPixels / denom;
    const bldFrac = buildingPixels / denom;
    // Occluder and ground are the two trustworthy signals: something in front of
    // the wall, or no wall in this direction at all. A *minimum* on building
    // coverage is not trustworthy — Mapillary labels shopfronts, awnings, signs
    // and boundary walls as their own classes, so a perfectly good HSR facade can
    // carry very little "building" and gating on it threw away 346 real walls.
    if (occFrac > 0.14) { note("blocked by vehicle/tree/pole"); continue; }
    if (gndFrac > 0.35) { note("aimed at road or sky"); continue; }
    // No minimum on building coverage. It was tried at 0.5, 0.3 and 0.08 and
    // rejected 316 tiles at every setting — the same 316, all with *zero*
    // building pixels, which are mostly houses set back behind trees where the
    // segmentation labels the vegetation and the fence and never names the house.
    // Absence of a label is not evidence of absence of a wall. What the occluder
    // and ground fractions say is positive evidence, and that is what is used.

    // Photographic sanity, for what segmentation cannot judge. These are all
    // failures of the *photo* rather than of the match: a frame shot into shade,
    // a blown-out frame, a smear from a moving vehicle, or a wall of leaves that
    // the segmentation labelled as building.
    let sum = 0;
    let sumSq = 0;
    let green = 0;
    for (let j = 0; j < TILE; j += 4) {
      for (let i = 0; i < TILE; i += 4) {
        const o = ((ty + j) * ATLAS + (tx + i)) * 3;
        const r = target[o];
        const g = target[o + 1];
        const b = target[o + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += l;
        sumSq += l * l;
        // Foliage is the one hue no built surface in HSR occupies.
        if (g > r + 12 && g > b + 12) green += 1;
      }
    }
    const n = (TILE / 4) * (TILE / 4);
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    if (mean < 42) { note("too dark to read"); continue; }
    if (mean > 226) { note("blown out"); continue; }
    // A facade has windows, sills, signs — structure. A featureless tile is
    // either motion blur or a flat patch of nothing.
    if (sd < 16) { note("no detail (blur or flat)"); continue; }
    if (green / n > 0.34) { note("mostly foliage"); continue; }

    entries.push({
      building: m.building,
      atlas: atlasIndex,
      // UV rect within the atlas, with a half-texel inset so bilinear filtering
      // cannot bleed a neighbouring facade in along the edges.
      uv: [
        (tx + 0.5) / ATLAS,
        (ty + 0.5) / ATLAS,
        (tx + TILE - 0.5) / ATLAS,
        (ty + TILE - 0.5) / ATLAS,
      ],
      // Endpoints swapped to match the flipped sample order above: u=0 in the
      // texture is this first point.
      wall: [bx, bz, ax, az],
      wallIndex: m.wallIndex,
      height: h,
      image: imageId,
      pano: m.pano,
      dist: m.dist,
      // How much of the tile the segmentation vouched for, so the renderer can
      // prefer the best-evidenced facades if it ever needs to choose.
      quality: Math.round(bldFrac * 100),
    });
    slot += 1;
    baked += 1;
  }
}

// -------------------------------------------------------------------- write out
const files = [];
for (let i = 0; i < atlases.length; i += 1) {
  const name = `facades-${i}.webp`;
  await sharp(atlases[i], { raw: { width: ATLAS, height: ATLAS, channels: 3 } })
    .webp({ quality: 82, effort: 5 })
    .toFile(path.join(OUTDIR, name));
  files.push(name);
}

const index = {
  attribution: facades.attribution,
  tile: TILE,
  atlasSize: ATLAS,
  atlases: files,
  counts: { baked, skipped, buildings: entries.length },
  facades: entries,
};
fs.writeFileSync(path.join(OUTDIR, "index.json"), JSON.stringify(index));

console.log(`\nbaked    ${baked}`);
console.log(`skipped  ${skipped}`, skipReasons);
console.log(`atlases  ${files.length}`);
for (const f of files) {
  console.log(`  ${f}  ${(fs.statSync(path.join(OUTDIR, f)).size / 1e6).toFixed(2)} MB`);
}
console.log(`wrote public/facades/index.json`);
