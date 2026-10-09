// Renders the ground-coverage grid to a PNG so holes can be located instead of
// guessed at from a curved bird's-eye screenshot.
import fs from "node:fs";
import sharp from "sharp";

const world = JSON.parse(fs.readFileSync("public/world.json", "utf8"));
const CELL = 10, REACH = 46;
const [minX, minZ, maxX, maxZ] = world.bounds;
const pad = REACH + CELL * 2;
const x0 = minX - pad, z0 = minZ - pad;
const gw = Math.ceil((maxX - minX + pad * 2) / CELL) + 1;
const gh = Math.ceil((maxZ - minZ + pad * 2) / CELL) + 1;
const INF = 1e9;
const dist = new Float32Array(gw * gh).fill(INF);
const stamp = (x, z) => {
  const i = Math.round((x - x0) / CELL), j = Math.round((z - z0) / CELL);
  if (i >= 0 && j >= 0 && i < gw && j < gh) dist[j * gw + i] = 0;
};
for (const road of world.roads) for (let k = 1; k < road.points.length; k++) {
  const a = road.points[k - 1], b = road.points[k];
  const n = Math.max(1, Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1]) / CELL));
  for (let s = 0; s <= n; s++) stamp(a[0]+(b[0]-a[0])*s/n, a[1]+(b[1]-a[1])*s/n);
}
const fill = (points) => {
  let jMin = Infinity, jMax = -Infinity;
  for (const [, pz] of points) { const j = (pz - z0) / CELL; if (j < jMin) jMin = j; if (j > jMax) jMax = j; }
  jMin = Math.max(0, Math.floor(jMin)); jMax = Math.min(gh - 1, Math.ceil(jMax));
  for (let j = jMin; j <= jMax; j++) {
    const zLine = z0 + j * CELL; const cr = [];
    for (let k = 0; k < points.length; k++) {
      const a = points[k], b = points[(k + 1) % points.length];
      if ((a[1] <= zLine) === (b[1] <= zLine)) continue;
      cr.push(a[0] + ((zLine - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    cr.sort((m, n) => m - n);
    for (let c = 0; c + 1 < cr.length; c += 2) {
      const i0 = Math.max(0, Math.ceil((cr[c] - x0) / CELL));
      const i1 = Math.min(gw - 1, Math.floor((cr[c + 1] - x0) / CELL));
      for (let i = i0; i <= i1; i++) dist[j * gw + i] = 0;
    }
  }
  for (let k = 0; k < points.length; k++) {
    const a = points[k], b = points[(k + 1) % points.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1]) / CELL));
    for (let t = 0; t <= n; t++) stamp(a[0]+(b[0]-a[0])*t/n, a[1]+(b[1]-a[1])*t/n);
  }
};
for (const b of world.buildings) fill(b.points);
for (const p of world.green) fill(p.points);
for (const b of world.water) fill(b.points);

const seeds = dist.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
const D2 = Math.SQRT2;
const at = (i, j) => (i < 0 || j < 0 || i >= gw || j >= gh ? INF : dist[j * gw + i]);
for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
  const k = j * gw + i;
  dist[k] = Math.min(dist[k], at(i-1,j)+1, at(i,j-1)+1, at(i-1,j-1)+D2, at(i+1,j-1)+D2);
}
for (let j = gh-1; j >= 0; j--) for (let i = gw-1; i >= 0; i--) {
  const k = j * gw + i;
  dist[k] = Math.min(dist[k], at(i+1,j)+1, at(i,j+1)+1, at(i+1,j+1)+D2, at(i-1,j+1)+D2);
}
const reach = REACH / CELL;
const open = new Uint8Array(gw * gh); const stack = [];
const consider = (i, j) => {
  if (i < 0 || j < 0 || i >= gw || j >= gh) return;
  const k = j * gw + i; if (open[k] || dist[k] <= reach) return;
  open[k] = 1; stack.push(k);
};
for (let i = 0; i < gw; i++) { consider(i, 0); consider(i, gh-1); }
for (let j = 0; j < gh; j++) { consider(0, j); consider(gw-1, j); }
while (stack.length) { const k = stack.pop(); const i = k % gw, j = (k - i) / gw;
  consider(i-1,j); consider(i+1,j); consider(i,j-1); consider(i,j+1); }

let ground = 0, enclosed = 0;
const px = Buffer.alloc(gw * gh * 3);
for (let k = 0; k < gw * gh; k++) {
  const isG = dist[k] <= reach || !open[k];
  if (isG) ground++;
  if (dist[k] > reach && !open[k]) enclosed++;
  const c = dist[k] === 0 ? [40, 90, 200]          // seeded by content
    : isG ? [150, 120, 80]                          // ground within reach / enclosed
    : [250, 250, 250];                              // void
  px[k*3] = c[0]; px[k*3+1] = c[1]; px[k*3+2] = c[2];
}
console.log({ gw, gh, seeds, ground, enclosedFilled: enclosed,
  voidPct: (100 * (1 - ground / (gw*gh))).toFixed(1) + '%' });
await sharp(px, { raw: { width: gw, height: gh, channels: 3 } })
  .resize(gw*3, gh*3, { kernel: 'nearest' }).png()
  .toFile(process.env.OUT || "groundmap.png");
console.log("wrote", process.env.OUT || "groundmap.png");
