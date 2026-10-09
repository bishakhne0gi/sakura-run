import fs from "node:fs";
import { FacadeKit } from "../src/world/facades3d.js";

const world = JSON.parse(fs.readFileSync("public/world.json", "utf8"));
const reads = JSON.parse(fs.readFileSync("public/facades/read.json", "utf8")).facades;
const byBuilding = new Map();
for (const r of reads) if (!byBuilding.has(r.building)) byBuilding.set(r.building, {
  ...r, wallLen: Math.hypot(r.wall[2]-r.wall[0], r.wall[3]-r.wall[1]) });

// Minimal stand-ins for the two things the kit asks the world for.
let s = 1337 >>> 0;
const random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const roads = { nearest: () => null };

const STOREY_H = 3.05;
function profileFor(b) {
  const storeys = Math.max(1, Math.min(8, Math.round((b.height - 0.9) / STOREY_H)));
  const shop = !!b.shopfront;
  const groundFloor = shop ? 3.9 : 3.2;
  return { storeys, groundFloor, shop, height: groundFloor + (storeys - 1) * STOREY_H };
}

const kit = new FacadeKit();
const t0 = Date.now();
for (let i = 0; i < world.buildings.length; i += 1) {
  kit.add(world.buildings[i], profileFor(world.buildings[i]), byBuilding.get(i) ?? null, roads, random);
}
console.log(`planned in ${Date.now() - t0} ms`);
console.log("windows       ", kit.windows.length / 5);
console.log("hooded windows", kit.hooded.length / 5);
console.log("total windows ", kit.windowCount);
console.log("string courses", kit.bands.length / 5);
console.log("shopfronts    ", kit.shops.length / 6);
console.log("signboards    ", kit.boards.length / 7);

// Triangle budget, measured off the geometry rather than guessed at.
const { __units } = await import("../src/world/facades3d.js");
const t = __units();
const tris = (kit.windows.length / 5) * (t.plain + t.glass)
  + (kit.hooded.length / 5) * (t.hood + t.glass)
  + (kit.bands.length / 5) * t.band
  + (kit.shops.length / 6) * t.shop
  + (kit.boards.length / 7) * t.board;
console.log(`per window: plain ${t.plain} hood ${t.hood} glass ${t.glass} tris`);
console.log(`facade triangles ~${(tris / 1e6).toFixed(2)} M`);

// Cell occupancy: how much the frustum can actually throw away.
const cells = new Map();
for (let i = 0; i < kit.windowCount; i += 1) {}
const cellOf = (flat) => {
  for (let i = 0; i < flat.length; i += 5) {
    const k = `${Math.floor(flat[i] / 220)},${Math.floor(flat[i + 2] / 220)}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
};
cellOf(kit.windows); cellOf(kit.hooded);
const counts = [...cells.values()].sort((a, b) => b - a);
console.log(`cells ${cells.size}, busiest ${counts[0]}, median ${counts[counts.length >> 1]}`);
