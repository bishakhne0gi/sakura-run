// Stage 2 (v2): for every building, find the photo that actually shows its front
// wall — by projecting the wall's real 3D quad through each camera's real pose.
//
//   node pipeline/fetch-poses.mjs && node pipeline/match-facades.mjs
//
// v1 had only a position and a compass angle per photo, so it assumed a ±33°
// lens and scored on angles. Verification showed that put 45% of wall quads
// fully inside the frame — the rest pointed somewhere else entirely. This
// version reads data/mapillary-poses.json and asks the camera model directly:
// project the four corners, see where they land, measure how much of the frame
// the facade fills.
//
// Three tests decide a candidate, in increasing cost:
//   1. geometry  — camera outside the wall, not too oblique, within range
//   2. framing   — all four corners project inside the image
//   3. occlusion — nothing else in the city stands between camera and wall
//
// The occlusion test is what stops a shop being textured with a photo of the
// building in front of it, which is the failure mode that looks most obviously
// wrong and is invisible in aggregate statistics.

import fs from "node:fs";
import path from "node:path";
import { makeCamera } from "./project.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "mapillary-facades.json");

const NEAR = 3.0;
const FAR = 55;
const MAX_OBLIQUE = Math.cos((70 * Math.PI) / 180);
const MIN_WALL = 3.5;
const EDGE_MARGIN = 0.015; // how far outside the frame a corner may stray
const IMAGE_BUDGET = 1600;

const world = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "world.json"), "utf8"));
const poseFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "mapillary-poses.json"), "utf8"));
const origin = world.origin;

// ------------------------------------------------------------------- cameras
const cameras = [];
for (const pose of poseFile.poses) {
  const cam = makeCamera(pose, origin);
  if (!cam) continue;
  cam.at = pose.at;
  cam.quality = pose.quality;
  cameras.push(cam);
}
console.log(`cameras with pose: ${cameras.length}`);

const CELL = 50;
const key = (a, b) => `${a},${b}`;
const camGrid = new Map();
for (const cam of cameras) {
  const k = key(Math.floor(cam.origin[0] / CELL), Math.floor(cam.origin[2] / CELL));
  let bucket = camGrid.get(k);
  if (!bucket) camGrid.set(k, (bucket = []));
  bucket.push(cam);
}
const nearbyCameras = (x, z) => {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const out = [];
  for (let dx = -2; dx <= 2; dx += 1)
    for (let dz = -2; dz <= 2; dz += 1) {
      const bucket = camGrid.get(key(cx + dx, cz + dz));
      if (bucket) out.push(...bucket);
    }
  return out;
};

// --------------------------------------------------------------- occlusion index
// Every building edge, bucketed by cell, so a sight line only tests the edges it
// could plausibly cross.
const edgeGrid = new Map();
const addEdge = (ax, az, bx, bz, owner) => {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / CELL));
  for (let s = 0; s <= steps; s += 1) {
    const x = ax + ((bx - ax) * s) / steps;
    const z = az + ((bz - az) * s) / steps;
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let bucket = edgeGrid.get(k);
    if (!bucket) edgeGrid.set(k, (bucket = []));
    if (!bucket.some((e) => e[4] === owner && e[0] === ax && e[1] === az)) {
      bucket.push([ax, az, bx, bz, owner]);
    }
  }
};
world.buildings.forEach((b, i) => {
  const pts = b.points || [];
  for (let j = 0; j < pts.length; j += 1) {
    const a = pts[j];
    const c = pts[(j + 1) % pts.length];
    addEdge(a[0], a[1], c[0], c[1], i);
  }
});

// Standard segment-segment crossing.
function crosses(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1x = bx - ax, d1z = bz - az;
  const d2x = dx - cx, d2z = dz - cz;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return false;
  const s = ((cx - ax) * d2z - (cz - az) * d2x) / den;
  const t = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return s > 0.02 && s < 0.98 && t > 0.02 && t < 0.98;
}

function occluded(camX, camZ, targetX, targetZ, owner) {
  const steps = Math.max(1, Math.ceil(Math.hypot(targetX - camX, targetZ - camZ) / CELL));
  const seen = new Set();
  for (let s = 0; s <= steps; s += 1) {
    const x = camX + ((targetX - camX) * s) / steps;
    const z = camZ + ((targetZ - camZ) * s) / steps;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1) {
        const k = key(cx + dx, cz + dz);
        if (seen.has(k)) continue;
        seen.add(k);
        const bucket = edgeGrid.get(k);
        if (!bucket) continue;
        for (const [ex, ez, fx, fz, other] of bucket) {
          if (other === owner) continue; // its own walls do not occlude it
          if (crosses(camX, camZ, targetX, targetZ, ex, ez, fx, fz)) return true;
        }
      }
  }
  return false;
}

// ------------------------------------------------------------------ road index
const roadGrid = new Map();
for (const road of world.roads || []) {
  const pts = road.points || [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 12));
    for (let s = 0; s <= steps; s += 1) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
      let bucket = roadGrid.get(k);
      if (!bucket) roadGrid.set(k, (bucket = []));
      bucket.push([x, z]);
    }
  }
}
const roadDistance = (x, z) => {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dz = -1; dz <= 1; dz += 1) {
      const bucket = roadGrid.get(key(cx + dx, cz + dz));
      if (!bucket) continue;
      for (const [rx, rz] of bucket) {
        const d = (rx - x) ** 2 + (rz - z) ** 2;
        if (d < best) best = d;
      }
    }
  return Math.sqrt(best);
};

// ----------------------------------------------------------------- wall walking
function walls(building) {
  const pts = building.points || [];
  if (pts.length < 3) return [];
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    area += ax * bz - bx * az;
  }
  const sign = area >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < MIN_WALL) continue;
    out.push({
      a, b, len, i,
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      n: [(dz / len) * sign, (-dx / len) * sign],
    });
  }
  return out;
}

// --------------------------------------------------------------------- matching
const matches = [];
const stats = { geometry: 0, framing: 0, occlusion: 0, accepted: 0 };
let considered = 0;

world.buildings.forEach((building, index) => {
  const wallList = walls(building);
  if (!wallList.length) return;
  considered += 1;

  for (const w of wallList) w.road = roadDistance(w.mid[0] + w.n[0] * 2, w.mid[1] + w.n[1] * 2);
  wallList.sort((p, q) => p.road - q.road);

  const height = Math.max(3, Math.min(building.height ?? 9, 18));
  let best = null;

  for (const wall of wallList.slice(0, 4)) {
    for (const cam of nearbyCameras(wall.mid[0], wall.mid[1])) {
      const [camX, camY, camZ] = cam.origin;
      const vx = camX - wall.mid[0];
      const vz = camZ - wall.mid[1];
      const dist = Math.hypot(vx, vz);
      if (dist < NEAR || dist > FAR) continue;
      const facing = (vx * wall.n[0] + vz * wall.n[1]) / dist;
      if (facing < MAX_OBLIQUE) continue;
      stats.geometry += 1;

      // Project the wall as a standing quad: both ends, ground to eaves.
      const corners = [
        cam.project(wall.a[0], 0, wall.a[1]),
        cam.project(wall.b[0], 0, wall.b[1]),
        cam.project(wall.b[0], height, wall.b[1]),
        cam.project(wall.a[0], height, wall.a[1]),
      ];
      if (corners.some((c) => !c)) continue;

      const us = corners.map((c) => c.u);
      const vs = corners.map((c) => c.v);
      const minU = Math.min(...us), maxU = Math.max(...us);
      const minV = Math.min(...vs), maxV = Math.max(...vs);

      // A pano sees every direction, so "in frame" is meaningless — but a facade
      // must not straddle the seam at u=0/1, or the crop wraps.
      if (cam.pano) {
        if (maxU - minU > 0.5) continue;
      } else if (
        minU < -EDGE_MARGIN || maxU > 1 + EDGE_MARGIN ||
        minV < -EDGE_MARGIN || maxV > 1 + EDGE_MARGIN
      ) {
        continue;
      }
      stats.framing += 1;

      // How much image there is to sample. A facade 3% of frame height carries
      // no detail worth baking, however well aimed the camera is.
      const spanU = (maxU - minU) * (cam.pano ? 1 : 1);
      const spanV = maxV - minV;
      const pixelsWide = spanU * cam.W;
      const pixelsTall = spanV * cam.H;
      if (pixelsTall < 90 || pixelsWide < 90) continue;

      // Cheapest test last: is the sight line clear?
      const standoff = 0.35;
      if (occluded(camX, camZ, wall.mid[0] + wall.n[0] * standoff, wall.mid[1] + wall.n[1] * standoff, index)) continue;
      stats.occlusion += 1;

      const year = cam.at ? new Date(cam.at).getUTCFullYear() : 2014;
      const recency = Math.max(0, Math.min(1, (year - 2013) / 12));
      const resolution = Math.min(1, (pixelsTall * pixelsWide) / (420 * 420));
      const score =
        facing * 2.4 +
        resolution * 2.2 +
        recency * 1.2 +
        (cam.quality ?? 0.5) * 0.7 +
        Math.min(1, wall.len / 14) * 0.5 +
        (cam.pano ? 0.35 : 0) -
        Math.min(1, wall.road / 30) * 0.8 -
        Math.min(1, Math.abs(dist - 15) / 35) * 0.6;

      if (!best || score > best.score) {
        best = {
          building: index,
          image: cam.id,
          pano: cam.pano,
          score: Math.round(score * 1000) / 1000,
          dist: Math.round(dist * 10) / 10,
          wall: [
            Math.round(wall.a[0] * 100) / 100, Math.round(wall.a[1] * 100) / 100,
            Math.round(wall.b[0] * 100) / 100, Math.round(wall.b[1] * 100) / 100,
          ],
          wallIndex: wall.i,
          wallLen: Math.round(wall.len * 10) / 10,
          bakeHeight: Math.round(height * 10) / 10,
          normal: [Math.round(wall.n[0] * 1000) / 1000, Math.round(wall.n[1] * 1000) / 1000],
          // Pixel footprint in the source photo, so stage 4 can pick an output
          // resolution that neither wastes memory nor upscales.
          px: [Math.round(pixelsWide), Math.round(pixelsTall)],
        };
      }
    }
  }

  if (best) {
    stats.accepted += 1;
    matches.push(best);
  }
});

// ------------------------------------------------------- budget by photo reuse
const byImage = new Map();
for (const m of matches) {
  let bucket = byImage.get(m.image);
  if (!bucket) byImage.set(m.image, (bucket = []));
  bucket.push(m);
}
const ranked = [...byImage.entries()]
  .map(([image, list]) => ({
    image,
    pano: list[0].pano,
    count: list.length,
    best: Math.max(...list.map((m) => m.score)),
  }))
  .sort((p, q) => q.count * 2 + q.best - (p.count * 2 + p.best));

const chosen = new Set(ranked.slice(0, IMAGE_BUDGET).map((r) => r.image));
const kept = matches.filter((m) => chosen.has(m.image));

const payload = {
  attribution: poseFile.attribution,
  origin,
  tuning: { NEAR, FAR, obliqueDeg: 70, MIN_WALL, EDGE_MARGIN, IMAGE_BUDGET, minPixels: 90 },
  counts: {
    buildings: world.buildings.length,
    considered,
    matched: matches.length,
    kept: kept.length,
    distinctImages: byImage.size,
    imagesToFetch: Math.min(IMAGE_BUDGET, byImage.size),
    panoramasToFetch: ranked.slice(0, IMAGE_BUDGET).filter((r) => r.pano).length,
  },
  images: ranked.slice(0, IMAGE_BUDGET),
  matches: kept,
};
fs.writeFileSync(OUT, JSON.stringify(payload));

const pct = (n) => `${((n / world.buildings.length) * 100).toFixed(1)}%`;
console.log(`\ncandidates passing geometry   ${stats.geometry}`);
console.log(`            passing framing    ${stats.framing}`);
console.log(`            passing occlusion  ${stats.occlusion}`);
console.log(`\nbuildings matched  ${matches.length}  (${pct(matches.length)})`);
console.log(`kept within budget ${kept.length}  (${pct(kept.length)})`);
console.log(`distinct photos    ${byImage.size} -> fetching ${payload.counts.imagesToFetch} (${payload.counts.panoramasToFetch} pano)`);
const tall = kept.map((m) => m.px[1]).sort((a, b) => a - b);
if (tall.length) {
  console.log(`facade height in source px: median ${tall[tall.length >> 1]}, p10 ${tall[Math.floor(tall.length * 0.1)]}, p90 ${tall[Math.floor(tall.length * 0.9)]}`);
}
console.log(`wrote ${path.relative(ROOT, OUT)}`);
