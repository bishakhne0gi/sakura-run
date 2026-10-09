#!/usr/bin/env node
// OSM -> world.json for Sakura Run: HSR Layout.
// Engine-agnostic output: plain JSON in local metres, +X east, +Z south, Y up.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Centre of the slice: between Agara Lake and the 27th Main strip.
const ORIGIN = { lat: 12.917, lon: 77.6422 };
const METRES_PER_DEG_LAT = 110574;
const metresPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function project({ lat, lon }) {
  return [
    (lon - ORIGIN.lon) * metresPerDegLon(ORIGIN.lat),
    -(lat - ORIGIN.lat) * METRES_PER_DEG_LAT, // +Z runs south
  ];
}

const raw = JSON.parse(readFileSync(path.join(root, "data/hsr-raw.json"), "utf8"));

// ---------------------------------------------------------------- helpers

const ring = (element) => (element.geometry || []).filter(Boolean).map(project);

function area(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return sum / 2;
}

function centroid(points) {
  const a = area(points);
  if (Math.abs(a) < 1e-7) {
    const n = points.length || 1;
    return [
      points.reduce((s, p) => s + p[0], 0) / n,
      points.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j][0] * points[i][1] - points[i][0] * points[j][1];
    cx += (points[j][0] + points[i][0]) * f;
    cz += (points[j][1] + points[i][1]) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

// Drop collinear noise so 2,225 footprints stay cheap to extrude.
function simplify(points, tolerance = 0.6) {
  if (points.length < 4) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, az] = out[out.length - 1];
    const [bx, bz] = points[i];
    const [cx, cz] = points[i + 1];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const spanSq = (cx - ax) ** 2 + (cz - az) ** 2;
    if (spanSq < 1e-6) continue;
    if ((cross * cross) / spanSq > tolerance * tolerance) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

const closed = (points) => {
  const r = points.slice();
  if (r.length > 1) {
    const [fx, fz] = r[0];
    const [lx, lz] = r[r.length - 1];
    if (Math.hypot(fx - lx, fz - lz) < 0.01) r.pop();
  }
  return r;
};

// ---------------------------------------------------------------- roads

// width in metres, and how the surface reads in the toon palette.
const ROAD_CLASS = {
  trunk: { width: 14, kind: "arterial" },
  primary: { width: 12, kind: "arterial" },
  secondary: { width: 10, kind: "main" },
  tertiary: { width: 9, kind: "main" },
  residential: { width: 7.5, kind: "street" },
  unclassified: { width: 6.5, kind: "street" },
  living_street: { width: 6, kind: "street" },
  service: { width: 4.5, kind: "service" },
  footway: { width: 2.2, kind: "path" },
  path: { width: 1.8, kind: "path" },
  pedestrian: { width: 4, kind: "path" },
  steps: { width: 1.8, kind: "path" },
  cycleway: { width: 2.4, kind: "path" },
  track: { width: 3.2, kind: "service" },
};

const roads = [];
for (const element of raw.elements) {
  const tags = element.tags || {};
  if (!tags.highway || element.type !== "way") continue;
  const spec = ROAD_CLASS[tags.highway];
  if (!spec) continue;
  const points = simplify(ring(element), 0.4);
  if (points.length < 2) continue;

  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  if (length < 6) continue;

  const lanes = Number(tags.lanes) || 0;
  roads.push({
    name: tags.name || null,
    kind: spec.kind,
    width: lanes > 0 ? Math.max(spec.width, lanes * 3.4) : spec.width,
    lit: tags.lit === "yes",
    oneway: tags.oneway === "yes",
    sidewalk: tags.sidewalk && tags.sidewalk !== "no",
    length,
    points,
  });
}

// ---------------------------------------------------------------- buildings

// HSR reality: mostly G+2 / G+3 residential, taller on the Main roads,
// tech offices and hospitals taller again. OSM only gives us 26 heights.
const FLOOR = 3.1;

function inferBuilding(tags, footprintArea, distanceToArterial) {
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (Number.isFinite(h) && h > 2) return { height: h, source: "tagged" };
  }
  if (tags["building:levels"]) {
    const levels = parseFloat(tags["building:levels"]);
    if (Number.isFinite(levels) && levels >= 1) {
      return { height: levels * FLOOR + 1.2, source: "levels" };
    }
  }
  const type = tags.building;
  if (type === "apartments" || type === "residential") return { height: 4 * FLOOR + 1.2, source: "inferred" };
  if (type === "commercial" || type === "office" || type === "retail") {
    return { height: 4 * FLOOR + 2, source: "inferred" };
  }
  if (type === "hospital") return { height: 6 * FLOOR + 2, source: "inferred" };
  if (type === "school" || type === "college") return { height: 3 * FLOOR + 1.5, source: "inferred" };
  if (type === "garage" || type === "shed" || type === "hut" || type === "roof") {
    return { height: 3, source: "inferred" };
  }
  if (type === "temple" || tags.amenity === "place_of_worship") return { height: 9, source: "inferred" };

  // Deterministic-ish variation driven by footprint and position on the grid.
  let levels = 3;
  if (footprintArea > 900) levels = 5;
  else if (footprintArea > 420) levels = 4;
  else if (footprintArea < 90) levels = 2;
  if (distanceToArterial < 26) levels += 1; // shopfront strips run taller
  return { height: levels * FLOOR + 1.2, source: "inferred" };
}

// Arterial spine lookup so frontage buildings can be identified cheaply.
const arterialPoints = [];
for (const road of roads) {
  if (road.kind !== "arterial" && road.kind !== "main") continue;
  for (const p of road.points) arterialPoints.push(p);
}
const CELL = 60;
const arterialGrid = new Map();
for (const [x, z] of arterialPoints) {
  const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  if (!arterialGrid.has(key)) arterialGrid.set(key, []);
  arterialGrid.get(key).push([x, z]);
}
function distanceToArterial([x, z]) {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const bucket = arterialGrid.get(`${cx + i},${cz + j}`);
      if (!bucket) continue;
      for (const [px, pz] of bucket) {
        const d = Math.hypot(px - x, pz - z);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// Buildings come from Overture Maps, not from the Overpass extract.
//
// Overture merges OpenStreetMap with Google Open Buildings and Microsoft's ML
// footprints — both of which are derived from satellite imagery. For this
// bbox that is 12,071 buildings against 2,225 in the OSM-only extract: the
// difference is every plot nobody has ever traced by hand, which in a layout
// like HSR is most of the interior of every block. That is the "real buildings
// from the satellite" this world needed.
//
// Heights are still mostly inferred. Overture carries a surveyed height for 5
// buildings here and a storey count for 128; there is no free global source of
// satellite-derived heights, so the rest are reasoned from footprint area, use
// and road class exactly as before. Provenance is recorded per building so the
// claim stays honest.
const overturePath = path.join(root, "data/overture-buildings.json");
let overture = [];
try {
  overture = readFileSync(overturePath, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
} catch {
  console.warn("  ! data/overture-buildings.json missing — falling back to the OSM extract alone");
}

// Overture geometry is lon/lat GeoJSON; project it into the same local metres.
function overtureRings(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((poly) => poly[0]);
  return [];
}

const buildings = [];
const provenance = { OpenStreetMap: 0, "Google Open Buildings": 0, "Microsoft ML Buildings": 0, other: 0 };

for (const record of overture) {
  const geom = typeof record.geom === "string" ? JSON.parse(record.geom) : record.geom;
  for (const coords of overtureRings(geom)) {
    const points = closed(simplify(coords.map(([lon, lat]) => project({ lat, lon }))));
    if (points.length < 3) continue;
    const footprint = Math.abs(area(points));
    if (footprint < 12) continue;
    const seat = centroid(points);
    // Keep the same slice the rest of the world covers.
    if (Math.abs(seat[0]) > 1100 || Math.abs(seat[1]) > 1100) continue;

    const toArterial = distanceToArterial(seat);
    const tags = {
      building: record.subtype || record.class || "yes",
      name: record.name || null,
    };
    let height;
    let source;
    if (record.height > 2) {
      height = record.height;
      source = "surveyed";
    } else if (record.num_floors > 0) {
      height = 3.2 + (record.num_floors - 1) * 3.05;
      source = "floors";
    } else {
      ({ height, source } = inferBuilding(tags, footprint, toArterial));
    }

    provenance[record.source] = (provenance[record.source] || 0) + 1;
    buildings.push({
      name: record.name || null,
      kind: record.subtype || record.class || "generic",
      amenity: record.class || null,
      height: Math.round(height * 10) / 10,
      heightSource: source,
      // A shopfront needs to be on a street with shops on it. Overture has no
      // shop tags of its own here, so this is proximity to an arterial plus the
      // POI layer, which is still OSM.
      shopfront: toArterial < 30 && footprint < 900,
      area: Math.round(footprint),
      centroid: [Math.round(seat[0] * 10) / 10, Math.round(seat[1] * 10) / 10],
      points: area(points) < 0 ? points.reverse() : points,
      src: record.source === "Google Open Buildings" ? "google"
        : record.source === "Microsoft ML Buildings" ? "microsoft" : "osm",
    });
  }
}

// Fall back to the Overpass extract only if Overture was unavailable.
for (const element of overture.length ? [] : raw.elements) {
  const tags = element.tags || {};
  if (!tags.building) continue;
  let points;
  if (element.type === "way") points = closed(simplify(ring(element)));
  else if (element.type === "relation") {
    const outer = (element.members || []).find((m) => m.role === "outer" && m.geometry);
    if (!outer) continue;
    points = closed(simplify(outer.geometry.filter(Boolean).map(project)));
  }
  if (!points || points.length < 3) continue;

  const footprint = Math.abs(area(points));
  if (footprint < 12) continue;
  const seat = centroid(points);
  const toArterial = distanceToArterial(seat);
  const { height, source } = inferBuilding(tags, footprint, toArterial);

  const shopfront =
    toArterial < 30 &&
    Boolean(tags.shop || tags.amenity || tags.name) &&
    tags.building !== "apartments";

  buildings.push({
    name: tags.name || null,
    kind: tags.building === "yes" ? "generic" : tags.building,
    amenity: tags.amenity || tags.shop || null,
    height: Math.round(height * 10) / 10,
    heightSource: source,
    shopfront,
    area: Math.round(footprint),
    centroid: [Math.round(seat[0] * 10) / 10, Math.round(seat[1] * 10) / 10],
    // wind outer rings consistently counter-clockwise for the extruder
    points: area(points) < 0 ? points.reverse() : points,
  });
}

// ---------------------------------------------------------------- surfaces

const water = [];
const green = [];
for (const element of raw.elements) {
  const tags = element.tags || {};
  const isWater = tags.natural === "water" || tags.water || tags.landuse === "reservoir";
  const isGreen =
    tags.leisure === "park" ||
    tags.leisure === "garden" ||
    tags.leisure === "pitch" ||
    tags.leisure === "sports_centre" ||
    tags.landuse === "grass" ||
    tags.landuse === "recreation_ground" ||
    tags.landuse === "forest" ||
    tags.natural === "wood" ||
    tags.natural === "scrub";
  if (!isWater && !isGreen) continue;

  let points;
  if (element.type === "way") points = closed(simplify(ring(element), 1.2));
  else if (element.type === "relation") {
    const outer = (element.members || []).find((m) => m.role === "outer" && m.geometry);
    if (!outer) continue;
    points = closed(simplify(outer.geometry.filter(Boolean).map(project), 1.2));
  }
  if (!points || points.length < 3) continue;
  const size = Math.abs(area(points));
  if (size < 60) continue;

  const record = {
    name: tags.name || null,
    kind: isWater ? "water" : tags.leisure || tags.landuse || tags.natural,
    area: Math.round(size),
    points: area(points) < 0 ? points.reverse() : points,
  };
  (isWater ? water : green).push(record);
}

// ---------------------------------------------------------------- trees

// Real mapped trees first, then avenue planting along every street, which is
// what actually makes HSR read as HSR. Tabebuia rosea is the bloom species.
const trees = [];
const treeAt = (x, z, species, scale) => trees.push({
  p: [Math.round(x * 10) / 10, Math.round(z * 10) / 10],
  s: species,
  h: Math.round(scale * 100) / 100,
});

let seed = 20260311; // bloom season, deterministic
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

for (const element of raw.elements) {
  const tags = element.tags || {};
  if (element.type !== "node" || tags.natural !== "tree") continue;
  const [x, z] = project(element);
  const species = rand() < 0.45 ? "tabebuia" : "canopy";
  treeAt(x, z, species, 0.85 + rand() * 0.5);
}

// OSM maps Agara Lake Park as a leisure=park polygon covering the entire lake,
// so planting inside "green" without excluding water grows a forest on the
// water surface. Reject any tree that lands in a water body.
function inWater(x, z) {
  for (const body of water) {
    const points = body.points;
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, zi] = points[i];
      const [xj, zj] = points[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}

const occupied = new Set();
const claim = (x, z) => {
  if (inWater(x, z)) return false;
  const key = `${Math.round(x / 7)},${Math.round(z / 7)}`;
  if (occupied.has(key)) return false;
  occupied.add(key);
  return true;
};
for (const tree of trees) claim(tree.p[0], tree.p[1]);

for (const road of roads) {
  if (road.kind === "path" || road.kind === "service") continue;
  const spacing = road.kind === "arterial" ? 16 : 13;
  // Main roads get the bloom avenues; side streets stay mostly green.
  const bloomChance = road.kind === "arterial" || road.kind === "main" ? 0.62 : 0.3;

  for (let i = 1; i < road.points.length; i++) {
    const [ax, az] = road.points[i - 1];
    const [bx, bz] = road.points[i];
    const segment = Math.hypot(bx - ax, bz - az);
    if (segment < 1) continue;
    const nx = -(bz - az) / segment;
    const nz = (bx - ax) / segment;
    const offset = road.width / 2 + 2.4;

    for (let d = spacing * 0.5; d < segment; d += spacing) {
      const t = d / segment;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      for (const side of [1, -1]) {
        if (rand() < 0.22) continue; // gaps keep the avenue from reading as a fence
        const jitter = (rand() - 0.5) * 1.6;
        const tx = px + nx * side * (offset + jitter);
        const tz = pz + nz * side * (offset + jitter);
        if (!claim(tx, tz)) continue;
        treeAt(tx, tz, rand() < bloomChance ? "tabebuia" : "canopy", 0.8 + rand() * 0.55);
      }
    }
  }
}

// Park planting: denser, mostly canopy, with bloom clusters.
for (const patch of green) {
  if (patch.area < 400) continue;
  const xs = patch.points.map((p) => p[0]);
  const zs = patch.points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const target = Math.min(160, Math.floor(patch.area / 150));
  for (let i = 0; i < target * 3 && i < 900; i++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (!pointInPolygon(x, z, patch.points)) continue;
    if (!claim(x, z)) continue;
    treeAt(x, z, rand() < 0.35 ? "tabebuia" : "canopy", 0.9 + rand() * 0.7);
  }
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- points of interest

const POI_ICON = {
  restaurant: "dish", cafe: "cup", fast_food: "dish", ice_cream: "cone",
  bank: "note", atm: "note", hospital: "cross", clinic: "cross",
  pharmacy: "cross", school: "book", kindergarten: "book", library: "book",
  place_of_worship: "bell", fuel: "drop", bar: "cup", bus_station: "bus",
  bench: "bench", drinking_water: "drop", waste_basket: "bin",
};

const pois = [];
for (const element of raw.elements) {
  const tags = element.tags || {};
  const key = tags.amenity || tags.shop;
  if (!key) continue;
  let x;
  let z;
  if (element.type === "node") [x, z] = project(element);
  else if (element.geometry) [x, z] = centroid(ring(element));
  else continue;
  if (!Number.isFinite(x)) continue;
  pois.push({
    name: tags.name || null,
    kind: key,
    icon: POI_ICON[key] || (tags.shop ? "bag" : "pin"),
    p: [Math.round(x * 10) / 10, Math.round(z * 10) / 10],
  });
}

// ---------------------------------------------------------------- landmarks

// Hand-picked anchors the player should be able to navigate between.
const LANDMARKS = [
  { match: (b) => b.name === "Agara Lake", label: "Agara Lake", note: "The boardwalk. Best bloom at golden hour." },
  { match: (b) => b.name === "Agara Lake Park", label: "Agara Lake Park", note: null },
  { match: (b) => b.name === "HSR Club", label: "HSR Club", note: null },
  { match: (b) => b.name === "HSR BBMP Ground", label: "BBMP Ground", note: null },
  { match: (b) => b.name === "Sector 2 Park", label: "Sector 2 Park", note: null },
];

const landmarks = [];
for (const spec of LANDMARKS) {
  const hit = [...water, ...green, ...buildings].find(spec.match);
  if (!hit) continue;
  const seat = hit.centroid || centroid(hit.points);
  landmarks.push({
    label: spec.label,
    note: spec.note,
    p: [Math.round(seat[0] * 10) / 10, Math.round(seat[1] * 10) / 10],
  });
}

// ---------------------------------------------------------------- write

const bounds = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const road of roads) {
    for (const [x, z] of road.points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  return [Math.floor(minX), Math.floor(minZ), Math.ceil(maxX), Math.ceil(maxZ)];
})();

const world = {
  version: 1,
  attribution: "Map data © OpenStreetMap contributors, ODbL 1.0",
  place: "HSR Layout, Bengaluru",
  origin: ORIGIN,
  bounds,
  roads,
  buildings,
  water,
  green,
  trees,
  pois,
  landmarks,
};

mkdirSync(path.join(root, "public"), { recursive: true });
const outFile = path.join(root, "public/world.json");
writeFileSync(outFile, JSON.stringify(world));

const bytes = readFileSync(outFile).length;
console.log("world.json written");
console.log("  roads      ", roads.length);
console.log("  buildings  ", buildings.length, `(${buildings.filter((b) => b.heightSource !== "inferred").length} with real heights)`);
console.log("  provenance ", JSON.stringify(provenance));
console.log("  water      ", water.length);
console.log("  green      ", green.length);
console.log("  trees      ", trees.length, `(${trees.filter((t) => t.s === "tabebuia").length} tabebuia)`);
console.log("  pois       ", pois.length);
console.log("  landmarks  ", landmarks.map((l) => l.label).join(", "));
console.log("  bounds     ", bounds.join(", "), `=> ${bounds[2] - bounds[0]}m x ${bounds[3] - bounds[1]}m`);
console.log("  size       ", (bytes / 1024 / 1024).toFixed(2), "MB");
