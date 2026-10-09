import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildProps } from "./props.js";
import {
  PALETTE, paintGeometry, facadeMaterial, shopfrontMaterial, roofMaterial,
  concreteMaterial, roadMaterial, zebraMaterial, grassMaterial, barkMaterial, dirtMaterial,
  foliageMaterial, waterMaterial, paintedMaterial, metalMaterial, tileRoofMaterial,
  paintedKerbMaterial, humpMaterial,
  lightPoolMaterial, setShopGlow, signMaterial,
  paintedFromSatellite, roofKindFromSatellite, wallFromRoof, paintedFromPhoto, STYLE,
  SIGNS_PER_ATLAS, SIGN_COLS, SIGN_ROWS,
} from "../render/materials.js";
import { applyPhotoUVs, photoWallMaterial } from "./photofacades.js";
import { FacadeKit } from "./facades3d.js";

// Deterministic RNG so a given world.json always builds the identical city.
function makeRandom(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Photographic facades: off.
//
// They were a real result and they are worth keeping runnable — `?photos=1`
// puts them back — but they are no longer what the city is made of. A photo on
// a wall is flat, carries the dashcam's exposure and its parked scooters, and
// stops at the corner. What the photographs are *for* now is upstream, in
// pipeline/read-facades.mjs: they told us how many floors each building has,
// how its windows are spaced and what colour it is painted, and that reading
// gets built out of geometry instead.
let usePhotos = new URLSearchParams(globalThis.location?.search ?? "").get("photos") === "1";
export function setPhotoFacades(on) { usePhotos = !!on; }
export function photoFacadesOn() { return usePhotos; }

const STOREY = 3.2;        // one facade tile: floor-to-floor height in metres
const GROUND_FLOOR = 3.9;  // shopfront band height, taller than a residential floor

// ------------------------------------------------------------------ helpers

// Shapes are authored on XY and stood up with rotateX(-90°). That rotation maps
// shape-y to world -z, so feeding it (x, z) mirrors the whole city across the X
// axis — buildings and lakes land at -z while roads and trees stay at +z, and
// the collider (which reads the source data) then disagrees with everything you
// can see. Pre-negate y, and reverse the ring to restore the winding that the
// negation flips.
function shapeFromPoints(points) {
  const shape = new THREE.Shape();
  const ring = points.slice().reverse();
  shape.moveTo(ring[0][0], -ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], -ring[i][1]);
  shape.closePath();
  return shape;
}

// ExtrudeGeometry's stock UV generator emits raw shape coordinates, so a facade
// texture stretches over an entire wall — one enormous window per building.
// This one measures each wall in metres and lays the tile out at real scale, so
// a 12.8 m frontage gets exactly four 3.2 m bays and floors line up across the
// whole city. `bias` shifts v so a storey band lands on the floor slab.
function worldUV(scale, bias = 0) {
  const v2 = (x, y) => new THREE.Vector2(x, y);
  return {
    generateTopUV(geometry, vertices, iA, iB, iC) {
      return [iA, iB, iC].map((i) => v2(vertices[i * 3] / 6, vertices[i * 3 + 1] / 6));
    },
    generateSideWallUV(geometry, vertices, iA, iB, iC, iD) {
      const p = (i) => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
      const a = p(iA); const b = p(iB); const c = p(iC); const d = p(iD);
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // Centre the bays on the wall so the pattern is symmetric about the
      // middle of each face rather than running off the far corner.
      const bays = Math.max(1, Math.round(len / scale));
      const shift = (bays * scale - len) / 2;
      const u = (q) => (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) + shift) / scale;
      const v = (q) => q[2] / scale + bias;
      return [v2(u(a), v(a)), v2(u(b), v(b)), v2(u(c), v(c)), v2(u(d), v(d))];
    },
  };
}

function extrude(points, height, uvScale, bias = 0) {
  const geometry = new THREE.ExtrudeGeometry(shapeFromPoints(points), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
    UVGenerator: worldUV(uvScale, bias),
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

// A closed vertical strip following a ring — parapets, compound walls, kerb
// faces. Cheaper and thinner than extruding a solid, which is what you get if
// you try to make a 200 mm parapet out of a second building.
function ringWall(points, y0, y1, thickness = 0) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let run = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    dx /= len; dz /= len;
    const nx = -dz;
    const nz = dx;
    const o = thickness;
    const base = positions.length / 3;
    positions.push(
      a[0] + nx * o, y0, a[1] + nz * o,
      b[0] + nx * o, y0, b[1] + nz * o,
      b[0] + nx * o, y1, b[1] + nz * o,
      a[0] + nx * o, y1, a[1] + nz * o,
    );
    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
    uvs.push(run / 2, 0, (run + len) / 2, 0, (run + len) / 2, (y1 - y0) / 2, run / 2, (y1 - y0) / 2);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    run += len;
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// A polyline turned into a quad strip. v spans the width 0..1 so a lane marking
// drawn at v = 0.5 in the texture lands on the true centre of any carriageway;
// u runs in metres/uScale so dashes stay 3 m long on a 7 m street and a 14 m
// arterial alike.
function ribbon(points, width, lift, { lateral = 0, uScale = 8 } = {}) {
  const half = width / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let run = 0;

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz;
    const nz = dx;
    const cx = points[i][0] + nx * lateral;
    const cz = points[i][1] + nz * lateral;
    if (i > 0) run += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    positions.push(cx + nx * half, lift, cz + nz * half);
    positions.push(cx - nx * half, lift, cz - nz * half);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(run / uScale, 0, run / uScale, 1);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function offsetLine(points, lateral) {
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    return [p[0] + (-dz / len) * lateral, p[1] + (dx / len) * lateral];
  });
}

// mergeGeometries refuses any batch whose members disagree on attributes or on
// whether they are indexed — and it refuses the *whole batch*, returning null.
// One indexed BoxGeometry among 320 extrusions therefore deletes 320 buildings
// with nothing but a console warning. Normalising every chunk to the same
// non-indexed position/normal/uv/color layout makes that impossible.
const MERGE_ATTRIBUTES = ["position", "normal", "uv", "color"];

function normalizeChunk(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const key of Object.keys(flat.attributes)) {
    if (!MERGE_ATTRIBUTES.includes(key)) flat.deleteAttribute(key);
  }
  const count = flat.attributes.position.count;
  if (!flat.attributes.normal) flat.computeVertexNormals();
  if (!flat.attributes.uv) flat.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  if (!flat.attributes.color) {
    const white = new Float32Array(count * 3).fill(1);
    flat.setAttribute("color", new THREE.Float32BufferAttribute(white, 3));
  }
  if (flat !== geometry) geometry.dispose();
  return flat;
}

// Which points are on tarmac?
//
// HSR's main roads are mapped in OSM as several parallel ways — a carriageway
// plus its service roads — and some of them overlap. Generating a footpath, a
// kerb and a line of trees off each way independently therefore plants trees in
// the middle of the next road and lays kerbs diagonally across the tarmac.
// Every piece of street furniture is tested against this index first.
function carriagewayIndex(world) {
  const cell = 16;
  const grid = new Map();
  for (const road of world.roads) {
    if (road.kind === "path") continue;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const seg = { road, ax: a[0], az: a[1], bx: b[0], bz: b[1], half: road.width / 2 };
      // Register the segment in every cell its bounding box touches.
      const minX = Math.floor((Math.min(a[0], b[0]) - seg.half) / cell);
      const maxX = Math.floor((Math.max(a[0], b[0]) + seg.half) / cell);
      const minZ = Math.floor((Math.min(a[1], b[1]) - seg.half) / cell);
      const maxZ = Math.floor((Math.max(a[1], b[1]) + seg.half) / cell);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${z}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(seg);
        }
      }
    }
  }
  return {
    // Distance from (x, z) to the nearest carriageway edge, ignoring `except`.
    // Negative means the point is on tarmac.
    clearance(x, z, except = null, margin = 0) {
      let best = Infinity;
      const bucket = grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
      if (!bucket) return best;
      for (const seg of bucket) {
        if (seg.road === except) continue;
        const dx = seg.bx - seg.ax;
        const dz = seg.bz - seg.az;
        const lenSq = dx * dx + dz * dz || 1;
        let t = ((x - seg.ax) * dx + (z - seg.az) * dz) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const px = seg.ax + dx * t;
        const pz = seg.az + dz * t;
        best = Math.min(best, Math.hypot(x - px, z - pz) - seg.half - margin);
      }
      return best;
    },
    clear(x, z, except = null, margin = 0) {
      return this.clearance(x, z, except, margin) > 0;
    },
    // The nearest carriageway to a point, with which side of it the point is
    // on. Props need this: a compound wall runs parallel to the street it
    // fronts, a parked scooter noses into the kerb, a hoarding faces traffic.
    nearest(x, z, maxDistance = 40) {
      let best = null;
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      const reach = Math.ceil(maxDistance / cell);
      for (let i = -reach; i <= reach; i++) {
        for (let j = -reach; j <= reach; j++) {
          for (const seg of grid.get(`${cx + i},${cz + j}`) || []) {
            const dx = seg.bx - seg.ax;
            const dz = seg.bz - seg.az;
            const lenSq = dx * dx + dz * dz || 1;
            let t = ((x - seg.ax) * dx + (z - seg.az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = seg.ax + dx * t;
            const pz = seg.az + dz * t;
            const d = Math.hypot(x - px, z - pz);
            if (!best || d < best.distance) {
              const len = Math.sqrt(lenSq);
              const ux = dx / len;
              const uz = dz / len;
              // Sign of the cross product says which side of the centreline.
              const side = Math.sign((x - seg.ax) * uz - (z - seg.az) * ux) || 1;
              best = { seg, distance: d, px, pz, ux, uz, side, half: seg.half, kind: seg.road.kind };
            }
          }
        }
      }
      return best && best.distance <= maxDistance ? best : null;
    },
  };
}

// Split a polyline offset to one side into the runs that are actually clear of
// other carriageways, so a footpath stops where a slip road crosses it instead
// of being drawn straight through it.
function clearRuns(points, lateral, road, roads, margin) {
  const line = offsetLine(points, lateral);
  const runs = [];
  let current = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(span / 5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (roads.clear(p[0], p[1], road, margin)) {
        current.push(p);
      } else {
        if (current.length > 1) runs.push(current);
        current = [];
      }
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

function mergeInto(group, chunks, material, name, { cast = false, receive = true, batch = 500 } = {}) {
  const normalized = chunks.map(normalizeChunk);
  chunks = normalized;
  for (let i = 0; i < chunks.length; i += batch) {
    const merged = mergeGeometries(chunks.slice(i, i + batch), false);
    if (!merged) {
      console.warn(`[build] merge failed for ${name} batch ${i / batch}`);
      continue;
    }
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `${name}-${i / batch}`;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    group.add(mesh);
  }
  for (const chunk of chunks) chunk.dispose();
}

// ------------------------------------------------------------------ buildings

const COMMERCIAL = new Set(["retail", "commercial", "shop", "supermarket", "restaurant", "office", "hotel", "mall"]);
const CIVIC = new Set(["school", "hospital", "college", "university", "kindergarten", "place_of_worship", "government"]);

// A stable hash of the footprint centroid. Every per-building choice — how many
// storeys, which facade, which roof, what colour — is drawn from this, so the
// city is identical on every load *and* no two neighbours agree, which is the
// whole difference between a place and a stamped repeat.
function buildingHash(building) {
  const x = Math.round(building.centroid[0] * 7.3);
  const z = Math.round(building.centroid[1] * 11.9);
  let h = (x * 374761393 + z * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  // `>>> 0` on the way out is not decoration. XOR in JS yields a *signed*
  // 32-bit int, so without it this returns negatives, `h % palette.length` is
  // negative, the palette lookup is undefined, paintGeometry throws — and the
  // try/catch around the extrusion swallows it and skips the building. Symptom:
  // three quarters of the city silently missing, and no roofs at all.
  return (h ^ (h >>> 16)) >>> 0;
}

// The oriented bounding box of a footprint, aligned to its longest edge. Pitched
// roofs, setback storeys and staircase blocks all need to know which way the
// building actually faces; an axis-aligned box puts a ridge across the corner
// of every plot that is not square to the grid.
function orientedBox(points) {
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!best || len > best.len) best = { len, dx: (b[0] - a[0]) / (len || 1), dz: (b[1] - a[1]) / (len || 1) };
  }
  if (!best) return null;
  const { dx, dz } = best;
  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (const [x, z] of points) {
    const u = x * dx + z * dz;
    const v = -x * dz + z * dx;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    cx: cu * dx - cv * dz,
    cz: cu * dz + cv * dx,
    angle: Math.atan2(dx, dz),
    w: maxU - minU,
    d: maxV - minV,
  };
}

// A gabled roof over an oriented box, with eaves that overhang. Roughly a third
// of HSR's older plots still carry a pitched Mangalore-tile roof, and putting
// some back is the single cheapest way to break a skyline of identical flat
// slabs.
function gableGeometry(box, rise, overhang) {
  const w = box.w / 2 + overhang;   // across the ridge
  const d = box.d / 2 + overhang;   // along the ridge
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const push = (quad, uvScale) => {
    const base = positions.length / 3;
    // Face normal from the first triangle.
    const ax = quad[1][0] - quad[0][0]; const ay = quad[1][1] - quad[0][1]; const az = quad[1][2] - quad[0][2];
    const bx = quad[2][0] - quad[0][0]; const by = quad[2][1] - quad[0][1]; const bz = quad[2][2] - quad[0][2];
    let nx = ay * bz - az * by; let ny = az * bx - ax * bz; let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const p of quad) positions.push(p[0], p[1], p[2]);
    for (let i = 0; i < quad.length; i++) normals.push(nx, ny, nz);
    uvs.push(0, 0, uvScale[0], 0, uvScale[0], uvScale[1], 0, uvScale[1]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const slope = Math.hypot(w, rise);
  // Two slopes. The ridge runs along the longer axis (local z).
  push([[-w, 0, -d], [0, rise, -d], [0, rise, d], [-w, 0, d]], [box.d / 1.4, slope / 1.4]);
  push([[w, 0, d], [0, rise, d], [0, rise, -d], [w, 0, -d]], [box.d / 1.4, slope / 1.4]);
  // Gable ends, as two triangles written as degenerate quads.
  push([[-w, 0, -d], [-w, 0, -d], [0, rise, -d], [w, 0, -d]], [1, 1]);
  push([[w, 0, d], [w, 0, d], [0, rise, d], [-w, 0, d]], [1, 1]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.rotateY(box.angle);
  return geometry;
}

// Everything about one building, decided once. Heights are snapped to whole
// storeys because real buildings are: a skyline of 13.6 m, 11.2 m and 9.9 m
// blocks reads as noise, a skyline of G+3, G+2 and G+1 reads as a layout.
const STOREY_H = 3.05;

// Ring winding in OSM is not dependable, so ask the geometry which way is out:
// step off the first edge along its normal and keep the direction that moves
// away from the centroid. Guessing costs you a plinth cut into the floor slab.
function outwardSign(points, centroid) {
  const a = points[0];
  const b = points[1] || points[0];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const mx = (a[0] + b[0]) / 2;
  const mz = (a[1] + b[1]) / 2;
  const nx = -dz / len;
  const nz = dx / len;
  const out = Math.hypot(mx + nx - centroid[0], mz + nz - centroid[1]);
  const inn = Math.hypot(mx - nx - centroid[0], mz - nz - centroid[1]);
  return out > inn ? 1 : -1;
}

function profileFor(building, roadNear) {
  const h = buildingHash(building);
  const bit = (shift, mod) => (h >>> shift) % mod;
  const area = building.area;
  // Retail at ground level.
  //
  // OSM tags 300 of these 9,763 footprints as shops, which is not what this
  // layout looks like — on 27th Main or 17th Cross the ground floor of nearly
  // every building is a shop, a clinic, a bakery or a phone repair counter, and
  // the residential floors start above it. Tagging is simply incomplete, and
  // taking it literally builds a suburb of blank plinths along what should be
  // the busiest frontage in the model.
  //
  // So the tag is trusted where it exists and inferred where it does not, from
  // the one thing that predicts it best: what kind of road the plot fronts. A
  // plot on an arterial almost always trades; a plot on a cul-de-sac almost
  // never does.
  const shop = building.shopfront || COMMERCIAL.has(building.kind)
    || (roadNear === "arterial" && bit(25, 100) < 62)
    || (roadNear === "main" && bit(27, 100) < 38);
  const civic = CIVIC.has(building.kind) || CIVIC.has(building.amenity);

  let storeys;
  if (building.heightSource === "surveyed") {
    storeys = Math.max(1, Math.round((building.height - 0.9) / STOREY_H));
  } else if (civic) {
    storeys = 2 + bit(3, 3);
  } else if (shop) {
    // Retail frontage on a main road: shop below, two to four floors above.
    storeys = 2 + bit(5, 4);
  } else if (area < 90) {
    storeys = 1 + bit(7, 2);                 // small independent house
  } else if (area < 220) {
    storeys = 2 + bit(9, 2);
  } else if (area < 600) {
    storeys = 2 + bit(11, 3);
  } else {
    storeys = 3 + bit(13, 4);                // apartment block or office
  }
  // A plot on an arterial builds higher than the same plot on a cul-de-sac.
  if (roadNear === "arterial" && storeys < 5 && bit(17, 3) === 0) storeys += 1;
  storeys = Math.max(1, Math.min(8, storeys));

  const groundFloor = shop ? 3.9 : 3.2;
  const height = groundFloor + (storeys - 1) * STOREY_H;

  // Roof form, from the imagery where the imagery knows.
  //
  // A terracotta reading in the satellite sample is the strongest signal in
  // this whole model: Mangalore tile is always pitched and RCC never is, so a
  // roof that photographs orange gets a gable and one that photographs grey
  // does not. Where a tree stands over the roof — or there is no sample at all
  // — it falls back to the same reasoning from plot size as before.
  const seen = building.roof ? roofKindFromSatellite(building.roof) : "unknown";
  let roof = "flat";
  if (seen === "tile") {
    roof = "pitched";
  } else if (seen === "unknown" && !shop && !civic && storeys <= 2 && area < 210 && bit(19, 100) < 42) {
    roof = "pitched";
  } else if (seen !== "tile" && storeys >= 4 && area > 260 && bit(21, 100) < 34) {
    roof = "setback";
  }

  // The colour the satellite actually saw, pushed into a painted palette.
  const roofColor = building.roof
    ? paintedFromSatellite(building.roof, STYLE === "anime")
    : ((h >>> 4) % 100 < 30 ? PALETTE.roofTerrace : PALETTE.roof);

  // Which elevation this building gets, decided by what is actually known
  // about it — its use, how tall it is, how big its plot is, how long its
  // frontage is, and what road it stands on. A hash gave every building a
  // *different* elevation but no building the *right* one, which is exactly
  // what "random things" means. Fall back to the hash only to break ties
  // between buildings that genuinely have identical attributes.
  const kind = String(building.kind || "").toLowerCase();
  const long = Math.sqrt(area) > 26;
  // Plot proportion, from the footprint itself.
  let longEdge = 0;
  let shortEdge = Infinity;
  for (let i = 0; i < building.points.length; i++) {
    const a = building.points[i];
    const b = building.points[(i + 1) % building.points.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > longEdge) longEdge = len;
    if (len > 1 && len < shortEdge) shortEdge = len;
  }
  if (!isFinite(shortEdge)) shortEdge = longEdge || 1;
  let facade;
  if (kind.includes("office") || kind.includes("commercial") || kind.includes("mall")) {
    facade = storeys >= 4 ? 7 : 8;                 // ribbon glazing
  } else if (kind.includes("retail") || kind.includes("supermarket")) {
    facade = 8;
  } else if (kind.includes("apartment") || kind.includes("dormitory")) {
    facade = storeys >= 4 ? 11 : 3;                // balcony bands
  } else if (kind.includes("house") || kind.includes("detached") || kind.includes("residential")) {
    facade = area < 120 ? 9 : 0;                   // small openings, weathered
  } else if (civic) {
    facade = long ? 6 : 4;                         // institutional, wide bays
  } else if (storeys >= 5) {
    facade = 7;
  } else if (storeys >= 3 && roadNear === "arterial") {
    facade = 11;                                   // balconies face the big road
  } else {
    // Everything else — which is most of the layout, because Overture carries no
    // class for 94% of these footprints. Two size buckets put 80% of the city on
    // two elevations, which is the "all the buildings are same" complaint coming
    // back in through the side door. Split on more of what is actually known:
    // how tall, how big, and how *shaped* the plot is. A long thin plot on a
    // corner is a different building from a square one behind it, and the
    // proportion is real data even when the class is missing.
    const aspect = Math.max(1, longEdge / Math.max(shortEdge, 1));
    const bucket =
      (storeys >= 3 ? 4 : storeys === 2 ? 2 : 0) +
      (area > 150 ? 1 : 0);
    const shapely = aspect > 2.2 ? 1 : 0;
    const pool = [
      [9, 10, 0],        // single storey, small: back plot, party wall, plain
      [0, 2, 9],         // single storey, larger
      [1, 4, 9],         // G+1 small
      [0, 1, 5],         // G+1 larger
      [3, 11, 4],        // G+2 and up, small
      [11, 3, 5],        // G+2 and up, larger
      [6, 2, 0],         // long thin plots read as terraces
      [6, 5, 1],
    ][bucket + shapely * 6 >= 8 ? 6 + shapely : bucket];
    facade = pool[h % pool.length];
  }

  return {
    storeys, height, groundFloor, shop, civic, roof, roofColor, seen, facade,
    // Wall colour from this building's own roof sample, so the paint belongs to
    // the plot rather than to a random draw.
    wallColor: building.roof ? wallFromRoof(building.roof, STYLE === "anime") : null,
    shopVariant: (h >>> 6) % 6,
    tint: h,
    stairBlock: storeys >= 3 && bit(23, 100) < 62,
  };
}

// A box with every edge rounded, for the objects that read as objects rather
// than as architecture — roof boxes, lamp heads, awning sheets, balcony slabs.
// Buildings themselves keep their crisp corners; a wall should be straight. It
// is the *furniture* on and around them that betrays a generated city when it
// is all perfect right angles.
function softBox(w, h, d, radius) {
  const r = Math.max(0.001, Math.min(radius, w / 2 - 0.002, h / 2 - 0.002));
  const bevel = Math.max(0.001, Math.min(radius, d / 2 - 0.002));
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -h / 2);
  shape.lineTo(hw, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -hh);
  shape.lineTo(w / 2, hh);
  shape.quadraticCurveTo(w / 2, h / 2, hw, h / 2);
  shape.lineTo(-hw, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, hh);
  shape.lineTo(-w / 2, -hh);
  shape.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2);
  const depth = Math.max(0.002, d - bevel * 2);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 2, curveSegments: 3, steps: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function buildBuildings(world, random, roadIndex, roads, photo, reads) {
  const group = new THREE.Group();
  group.name = "buildings";

  // One geometry list per facade variant: buildings are merged with their own
  // kind, so twelve elevations cost twelve draw calls instead of one shader.
  const upperByVariant = new Map();
  const groundByVariant = new Map();
  // Buildings that have a real photograph of their front wall. Keyed by atlas
  // rather than by facade variant: they all share one texture, so the whole set
  // still merges down to one draw call per atlas.
  const photoByAtlas = new Map();
  const roofs = [];
  const parapets = [];
  const tiles = [];
  const clutter = { tank: [], tankWhite: [], stair: [], ac: [], dish: [] };
  const awnings = [];
  const balconies = [];
  const profiles = new Map();
  const kit = new FacadeKit();

  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };

  for (let buildingIndex = 0; buildingIndex < world.buildings.length; buildingIndex += 1) {
    const building = world.buildings[buildingIndex];
    const profile = profileFor(building, roadIndex.classAt(building.centroid[0], building.centroid[1]));
    profiles.set(building, profile);
    const height = profile.height;

    // What the street photograph of this building said, where there was one.
    const read = reads?.get(buildingIndex) ?? null;

    const wallColor = read?.wallColor != null
      // The photograph is of this wall, so it outranks everything else — the
      // satellite guess, the palette, the hash. Lifted into the painted range
      // on the way through; see paintedFromPhoto for why that is not cheating.
      ? paintedFromPhoto(read.wallColor, STYLE === "anime")
      : profile.shop
        ? PALETTE.shopfront
        : profile.wallColor
          ?? PALETTE.walls[profile.tint % PALETTE.walls.length];

    const photoEntry = usePhotos ? (photo?.lookup?.get(buildingIndex) ?? null) : null;

    // Modelled openings on the street elevations. This is the thing that used
    // to be a texture and then briefly a photograph.
    kit.add(building, profile, read, roads, random);

    try {
      if (photoEntry) {
        // One solid extrusion, full height, wearing the photograph. No shopfront
        // split here on purpose: the photo already contains this building's real
        // ground floor — its shutters, its plinth, its signboard — and laying a
        // generated shopfront over the bottom of it would cover the best part of
        // the picture with an invention.
        const shell = extrude(building.points, height, STOREY);
        applyPhotoUVs(shell, photoEntry);
        bucket(photoByAtlas, photoEntry.atlas).push(shell);
      } else if (profile.shop) {
        // The ground floor of an Indian street is a different building from the
        // floors above it: shutters, a signboard, a raised plinth. Tiling the
        // residential facade down to the pavement is the clearest tell of a
        // procedural city.
        const base = extrude(building.points, profile.groundFloor, profile.groundFloor);
        bucket(groundByVariant, profile.shopVariant).push(paintGeometry(base, PALETTE.shopfront));
        if (height > profile.groundFloor + 0.6) {
          const top = extrude(building.points, height - profile.groundFloor, STOREY);
          top.translate(0, profile.groundFloor, 0);
          bucket(upperByVariant, profile.facade).push(paintGeometry(top, wallColor));
        }
      } else {
        bucket(upperByVariant, profile.facade).push(paintGeometry(extrude(building.points, height, STOREY), wallColor));
      }
    } catch {
      continue; // degenerate footprint from OSM; skip rather than crash the city
    }

    // Plinth. Every building here stands on a raised base, 450 mm or so, and it
    // is the detail that puts a building *on the ground* rather than pasted
    // onto it — a wall that meets the pavement in a clean line always reads as
    // a render. Stood 60 mm proud of the wall above it.
    const sign = outwardSign(building.points, building.centroid);
    const plinth = ringWall(building.points, 0, profile.shop ? 0.32 : 0.5, sign * 0.07);
    if (plinth) parapets.push(paintGeometry(plinth, profile.shop ? 0xbdb6a8 : 0xc9c2b4));

    const box = orientedBox(building.points);

    if (profile.roof === "pitched" && box) {
      // Mangalore tile over a low eaves wall.
      const rise = Math.min(2.6, Math.max(1.1, box.w * 0.28));
      const roofGeometry = gableGeometry(box, rise, 0.42);
      roofGeometry.translate(box.cx, height + 0.12, box.cz);
      tiles.push(paintGeometry(roofGeometry, profile.roofColor));
      const eaves = extrude(building.points, 0.25, 6);
      eaves.translate(0, height, 0);
      roofs.push(paintGeometry(eaves, PALETTE.roofTerrace));
    } else {
      const slab = extrude(building.points, 0.4, 6);
      slab.translate(0, height, 0);
      roofs.push(paintGeometry(slab, profile.roofColor));

      if (building.area > 45) {
        const top = height + 0.4 + (profile.civic ? 1.15 : 0.95);
        const parapet = ringWall(building.points, height + 0.4, top);
        if (parapet) parapets.push(paintGeometry(parapet, PALETTE.parapet));
        // Coping: a course standing 90 mm proud of the parapet it caps. This is
        // the line where a building stops, and a building that stops at a clean
        // shared edge with the sky reads as a box no matter what is on its
        // walls. The overhang is what puts a band of shadow under the top of
        // every elevation in the city, for one thin ring of geometry each.
        const cap = ringWall(building.points, top - 0.16, top, sign * 0.09);
        if (cap) parapets.push(paintGeometry(cap, PALETTE.parapet));
      }

      // Setback top storey: the terrace-and-penthouse profile that every
      // apartment block over G+3 in this layout has.
      if (profile.roof === "setback" && box && box.w > 7 && box.d > 7) {
        const inset = 1.6;
        const penthouse = softBox(box.w - inset * 2, STOREY_H, box.d - inset * 2, 0.2);
        penthouse.translate(0, STOREY_H / 2, 0);
        penthouse.rotateY(box.angle);
        penthouse.translate(box.cx, height + 0.4, box.cz);
        bucket(upperByVariant, profile.facade).push(paintGeometry(penthouse, wallColor));
        const cap = softBox(box.w - inset * 2 + 0.5, 0.35, box.d - inset * 2 + 0.5, 0.12);
        cap.translate(0, STOREY_H + 0.17, 0);
        cap.rotateY(box.angle);
        cap.translate(box.cx, height + 0.4, box.cz);
        roofs.push(paintGeometry(cap, PALETTE.roof));
      }
    }

    // Roof furniture. Every terrace here carries a black Sintex tank, a stair
    // headroom box and a dish; a bare roof is the clearest tell of a procedural
    // city the moment you look down from anywhere high.
    const [cx, cz] = building.centroid;
    const spread = Math.min(6, Math.sqrt(building.area) * 0.22);
    const jitter = () => (random() - 0.5) * spread;
    const roofY = profile.roof === "pitched" ? null : height + 0.4;
    if (roofY !== null) {
      if (building.area > 55) {
        (random() < 0.72 ? clutter.tank : clutter.tankWhite)
          .push([cx + jitter(), roofY, cz + jitter(), 0.85 + random() * 0.35]);
        if (random() < 0.5) clutter.tank.push([cx + jitter(), roofY, cz + jitter(), 0.7 + random() * 0.3]);
      }
      if (profile.stairBlock && building.area > 90) {
        clutter.stair.push([cx + jitter(), roofY, cz + jitter(), random() * Math.PI]);
      }
      if (random() < 0.4) clutter.dish.push([cx + jitter(), roofY + 0.15, cz + jitter(), random() * Math.PI * 2]);
    }

    // Balconies and awnings sit on the longest footprint edge, which for a plot
    // on a grid is almost always the street frontage.
    let bestEdge = null;
    for (let i = 0; i < building.points.length; i++) {
      const a = building.points[i];
      const b = building.points[(i + 1) % building.points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!bestEdge || len > bestEdge.len) bestEdge = { a, b, len };
    }
    if (bestEdge && bestEdge.len > 5) {
      const dx = (bestEdge.b[0] - bestEdge.a[0]) / bestEdge.len;
      const dz = (bestEdge.b[1] - bestEdge.a[1]) / bestEdge.len;
      const angle = Math.atan2(dx, dz);
      const mx = (bestEdge.a[0] + bestEdge.b[0]) / 2;
      const mz = (bestEdge.a[1] + bestEdge.b[1]) / 2;
      const outX = -dz;
      const outZ = dx;

      if (profile.shop) {
        awnings.push({
          x: mx + outX * 0.75, z: mz + outZ * 0.75,
          y: profile.groundFloor - 0.55, angle,
          len: Math.min(bestEdge.len * 0.85, 14),
        });
      } else if (profile.storeys >= 3) {
        for (let f = 1; f < profile.storeys; f++) {
          if (random() > 0.5) continue;
          balconies.push({
            x: mx + outX * 0.5, z: mz + outZ * 0.5,
            y: profile.groundFloor + (f - 1) * STOREY_H, angle,
            len: Math.min(bestEdge.len * 0.5, 6),
          });
        }
      }
    }
  }

  for (const [atlas, chunks] of photoByAtlas) {
    const texture = photo?.textures?.[atlas];
    if (!texture) continue;
    mergeInto(group, chunks, photoWallMaterial(texture, atlas), `photo-walls-${atlas}`, { cast: true, batch: 200 });
  }
  for (const [variant, chunks] of upperByVariant) {
    mergeInto(group, chunks, facadeMaterial(variant), `walls-v${variant}`, { cast: true, batch: 320 });
  }
  for (const [variant, chunks] of groundByVariant) {
    mergeInto(group, chunks, shopfrontMaterial(variant), `shopfront-v${variant}`, { cast: true, batch: 320 });
  }
  mergeInto(group, roofs, roofMaterial(), "roofs", { cast: true, batch: 400 });
  mergeInto(group, parapets, concreteMaterial(PALETTE.parapet, { side: THREE.DoubleSide }), "parapets", { cast: true, batch: 400 });
  mergeInto(group, tiles, tileRoofMaterial(), "tile-roofs", { cast: true, batch: 400 });

  // ---- instanced roof furniture
  const dummy = new THREE.Object3D();
  const instance = (geometry, material, list, name, place) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    list.forEach((item, i) => {
      place(item, dummy);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };

  const tank = new THREE.CylinderGeometry(0.62, 0.55, 1.25, 14);
  tank.translate(0, 0.62, 0);
  instance(tank, paintedMaterial(PALETTE.tank, { roughness: 0.55 }), clutter.tank, "tanks",
    ([x, y, z, s], d) => { d.position.set(x, y, z); d.rotation.set(0, 0, 0); d.scale.setScalar(s); });
  instance(tank, paintedMaterial(PALETTE.tankWhite, { roughness: 0.7 }), clutter.tankWhite, "tanks-white",
    ([x, y, z, s], d) => { d.position.set(x, y, z); d.rotation.set(0, 0, 0); d.scale.setScalar(s); });

  const stair = softBox(2.6, 2.3, 2.2, 0.22);
  stair.translate(0, 1.15, 0);
  instance(stair, concreteMaterial(0xd6cec1), clutter.stair, "stairheads",
    ([x, y, z, r], d) => { d.position.set(x, y, z); d.rotation.set(0, r, 0); d.scale.setScalar(1); });

  const dish = new THREE.SphereGeometry(0.42, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2.4);
  instance(dish, paintedMaterial(0xe8e6e0, { side: THREE.DoubleSide }), clutter.dish, "dishes",
    ([x, y, z, r], d) => { d.position.set(x, y + 0.3, z); d.rotation.set(-1.05, r, 0); d.scale.setScalar(1); });

  // ---- awnings: the striped sheet over every shopfront
  if (awnings.length) {
    const sheet = softBox(1, 0.07, 1.5, 0.03);
    sheet.translate(0, 0, 0.75);
    const colors = [0x2f6f9e, 0xb03a2e, 0x1e8449, 0xd4ac0d, 0xa04000];
    const mesh = new THREE.InstancedMesh(sheet, paintedMaterial(0xffffff, { roughness: 0.85 }), awnings.length);
    mesh.castShadow = true;
    const color = new THREE.Color();
    awnings.forEach((a, i) => {
      dummy.position.set(a.x, a.y, a.z);
      dummy.rotation.set(-0.22, a.angle, 0);
      dummy.scale.set(a.len, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(colors[i % colors.length]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = "awnings";
    group.add(mesh);
  }

  // ---- balconies: slab plus a railing, the defining feature of a G+3 block
  if (balconies.length) {
    const slabGeometry = softBox(1, 0.16, 1.15, 0.06);
    slabGeometry.translate(0, 0, 0.5);
    const slabs = new THREE.InstancedMesh(slabGeometry, concreteMaterial(0xe0d9cc), balconies.length);
    const railGeometry = softBox(1, 0.9, 0.07, 0.03);
    railGeometry.translate(0, 0.45, 1.05);
    const rails = new THREE.InstancedMesh(railGeometry, metalMaterial(0x4a4a4e), balconies.length);
    slabs.castShadow = rails.castShadow = true;
    slabs.receiveShadow = true;
    balconies.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.angle, 0);
      dummy.scale.set(b.len, 1, 1);
      dummy.updateMatrix();
      slabs.setMatrixAt(i, dummy.matrix);
      rails.setMatrixAt(i, dummy.matrix);
    });
    slabs.instanceMatrix.needsUpdate = true;
    rails.instanceMatrix.needsUpdate = true;
    slabs.name = "balconies";
    rails.name = "balcony-rails";
    group.add(slabs, rails);
  }

  const detail = kit.build();
  group.add(detail);
  _facadeDetail = detail;
  _litWindows = kit.litMaterial;
  group.userData.profiles = profiles;
  group.userData.facadeDetail = detail;
  group.userData.windowCount = kit.windowCount;
  return group;
}

// ------------------------------------------------------------------ signage

// The 191 real business names in the OSM extract, mounted as readable boards on
// the wall of the building they belong to. This is what "you can see the names"
// means in practice — not a label floating in screen space, but a signboard
// facing the street, lit at night with the rest of the shopfront.
function buildSignage(world, buildings) {
  const group = new THREE.Group();
  group.name = "signage";

  const named = world.pois.filter((p) => p.name && p.name.length < 46);
  if (!named.length) return group;

  // Nearest building to each shop, over a coarse grid of centroids.
  const cell = 40;
  const grid = new Map();
  for (const building of world.buildings) {
    const key = `${Math.floor(building.centroid[0] / cell)},${Math.floor(building.centroid[1] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(building);
  }

  const plates = new Map();      // atlas index -> geometry chunks
  const entriesByAtlas = new Map();
  let placed = 0;

  for (const poi of named) {
    const cx = Math.floor(poi.p[0] / cell);
    const cz = Math.floor(poi.p[1] / cell);
    let host = null;
    let hostDistance = 30;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const building of grid.get(`${cx + i},${cz + j}`) || []) {
          const d = Math.hypot(building.centroid[0] - poi.p[0], building.centroid[1] - poi.p[1]);
          if (d < hostDistance) { hostDistance = d; host = building; }
        }
      }
    }
    if (!host) continue;

    // Mount on the host edge closest to the shop node — that is the edge facing
    // whatever street the shop is actually on.
    let best = null;
    for (let i = 0; i < host.points.length; i++) {
      const a = host.points[i];
      const b = host.points[(i + 1) % host.points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 3) continue;
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const d = Math.hypot(mx - poi.p[0], mz - poi.p[1]);
      if (!best || d < best.d) best = { a, b, len, mx, mz, d };
    }
    if (!best) continue;

    const profile = buildings.userData.profiles?.get(host);
    const mountY = profile ? Math.min(profile.groundFloor - 0.75, profile.height - 1.1) : 3.0;
    if (mountY < 1.6) continue;

    const atlas = Math.floor(placed / SIGNS_PER_ATLAS);
    const slot = placed % SIGNS_PER_ATLAS;
    if (!entriesByAtlas.has(atlas)) entriesByAtlas.set(atlas, []);
    entriesByAtlas.get(atlas).push({ name: poi.name, kind: poi.kind });

    const width = Math.min(best.len * 0.86, 5.2);
    const height = width / 3.6;
    const plate = new THREE.PlaneGeometry(width, height);

    // UVs into this sign's cell of the atlas.
    const col = slot % SIGN_COLS;
    const row = Math.floor(slot / SIGN_COLS);
    const uv = plate.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        (col + uv.getX(i)) / SIGN_COLS,
        // Atlas rows are drawn top-down; UV v runs bottom-up.
        1 - (row + (1 - uv.getY(i))) / SIGN_ROWS,
      );
    }

    const dx = (best.b[0] - best.a[0]) / best.len;
    const dz = (best.b[1] - best.a[1]) / best.len;

    // Which side of the edge is outside? Ring winding in OSM is not dependable,
    // so ask the geometry: step along the candidate normal and keep whichever
    // direction moves *away* from the centroid. Guessing from winding is how a
    // whole street's signage ends up facing into the building.
    let nx = -dz;
    let nz = dx;
    const outward = Math.hypot(best.mx + nx - host.centroid[0], best.mz + nz - host.centroid[1])
      > Math.hypot(best.mx - nx - host.centroid[0], best.mz - nz - host.centroid[1]);
    if (!outward) { nx = -nx; nz = -nz; }

    // PlaneGeometry faces +Z, so rotating by atan2(nx, nz) points its face along
    // the outward normal — flush to the wall, readable from the street.
    plate.rotateY(Math.atan2(nx, nz));
    plate.translate(best.mx + nx * 0.07, mountY, best.mz + nz * 0.07);

    if (!plates.has(atlas)) plates.set(atlas, []);
    plates.get(atlas).push(plate);

    // Every third shop also gets a projecting blade sign at right angles to the
    // wall. That is the one that is actually readable when you are walking
    // along the footpath rather than standing across the road from it.
    if (placed % 3 === 1) {
      const blade = new THREE.PlaneGeometry(width * 0.5, height * 0.95);
      const bu = blade.attributes.uv;
      for (let i = 0; i < bu.count; i++) {
        bu.setXY(i, (col + bu.getX(i)) / SIGN_COLS, 1 - (row + (1 - bu.getY(i))) / SIGN_ROWS);
      }
      const bladeYaw = Math.atan2(nx, nz) + Math.PI / 2;
      const bx = best.mx + nx * (width * 0.28) + dx * (best.len * 0.24);
      const bz = best.mz + nz * (width * 0.28) + dz * (best.len * 0.24);
      blade.rotateY(bladeYaw);
      blade.translate(bx, mountY + 0.35, bz);
      plates.get(atlas).push(blade);

      // A blade sign hangs off the wall and is read from both sides, so it needs
      // a real second face rather than a double-sided material. Seen from behind,
      // a double-sided plane shows its texture mirrored — which is why shop names
      // across the road read backwards. Rotating a duplicate by half a turn flips
      // the facing *and* the horizontal texture direction together, so the name
      // reads correctly from either approach, exactly like the real thing.
      const back = blade.clone();
      back.translate(-bx, -(mountY + 0.35), -bz);
      back.rotateY(Math.PI);
      back.translate(bx, mountY + 0.35, bz);
      plates.get(atlas).push(back);
    }
    placed++;
  }

  for (const [atlas, chunks] of plates) {
    const merged = mergeGeometries(chunks, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, signMaterial(atlas, entriesByAtlas.get(atlas)));
    mesh.name = `signs-${atlas}`;
    mesh.castShadow = false;
    group.add(mesh);
    for (const chunk of chunks) chunk.dispose();
  }
  return group;
}

// ------------------------------------------------------------------ roads

function buildRoads(world, random, roads) {
  const group = new THREE.Group();
  group.name = "roads";
  const byKind = new Map();
  const push = (kind, geometry) => {
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(geometry);
  };

  const footpaths = [];
  const kerbFaces = [];
  const paintedKerbs = [];
  const drains = [];

  for (const road of world.roads) {
    const lift = road.kind === "path" ? 0.045 : 0.03;
    push(road.kind, paintGeometry(ribbon(road.points, road.width, lift), PALETTE.road[road.kind] || 0xffffff));

    // Footpaths on anything a vehicle uses. A raised kerb with a real vertical
    // face is what puts the player *on a street* rather than on a painted
    // plane — at eye height the 150 mm step is the strongest scale cue there is.
    if (road.kind === "arterial" || road.kind === "main" || (road.kind === "street" && road.width >= 7)) {
      const walkWidth = road.kind === "arterial" ? 2.6 : 1.9;
      for (const side of [1, -1]) {
        const centre = road.width / 2 + walkWidth / 2 + 0.15;
        // Only where the pavement is not somebody else's carriageway.
        for (const run of clearRuns(road.points, side * centre, road, roads, walkWidth / 2)) {
          // 2 m per paver tile, not 4: the tile is 8 rows deep, and stretching
          // it over 4 m turns 300 mm pavers into 500 mm planks — the footpath
          // reads as timber decking down the whole street.
          footpaths.push(paintGeometry(ribbon(run, walkWidth, 0.16, { uScale: 2 }), 0xffffff));
          const face = ringWall(offsetLine(run, -side * (walkWidth / 2)), 0, 0.16);
          if (!face) continue;
          // Only the arterials get painted kerbs. Painting every kerb in the
          // layout turns a street into a barcode; on the ground it is the big
          // roads that are black-and-yellow and the side streets that stay grey.
          if (road.kind === "arterial") paintedKerbs.push(face);
          else kerbFaces.push(paintGeometry(face, PALETTE.kerb));
        }
      }
      // The K200-style open storm drain that runs beside every main road here.
      if (road.kind !== "street" && random() < 0.35) {
        const centre = road.width / 2 + 0.1;
        const side = random() < 0.5 ? 1 : -1;
        for (const run of clearRuns(road.points, side * centre, road, roads, 0.4)) {
          drains.push(ribbon(run, 0.55, 0.02, { uScale: 2 }));
        }
      }
    }
  }

  // ---- medians on the arterials, painted kerbs on the mains
  // A carriageway with nothing down the middle of it reads as a car park. HSR's
  // arterials are divided, with a planted central strip and a black-and-yellow
  // kerb — and that kerb paint is the most recognisable thing about an Indian
  // road after the autos.
  const medianKerbs = [];
  const medianTops = [];
  const humps = [];
  for (const road of world.roads) {
    if (road.kind === "arterial" && road.width >= 11) {
      // Two kerb faces and a planted top. Concatenating the centreline with its
      // own reverse to "close the ring" draws every face twice, in the same
      // place, z-fighting with itself.
      for (const side of [1, -1]) {
        const face = ringWall(offsetLine(road.points, side * 0.75), 0, 0.34);
        if (face) medianKerbs.push(face);
      }
      medianTops.push(paintGeometry(ribbon(road.points, 1.5, 0.35, { uScale: 3 }), 0xffffff));
    }
    // Speed breakers on residential streets: unmissable in a car, and one of
    // the few pieces of road furniture that changes how you drive.
    if (road.kind === "street" && road.points.length > 2 && random() < 0.4) {
      const i = 1 + Math.floor(random() * (road.points.length - 2));
      const prev = road.points[i - 1];
      const at = road.points[i];
      const angle = Math.atan2(at[0] - prev[0], at[1] - prev[1]);
      humps.push({ x: at[0], z: at[1], angle, width: road.width });
    }
  }
  for (const [kind, chunks] of byKind) {
    mergeInto(group, chunks, roadMaterial(kind === "service" ? "street" : kind), `road-${kind}`, { batch: 600 });
  }
  mergeInto(group, medianKerbs, paintedKerbMaterial(), "median-kerb", { batch: 400 });
  mergeInto(group, medianTops, grassMaterial(true), "median-planting", { batch: 400 });

  if (humps.length) {
    // A flattened half-cylinder with the diagonal warning stripes painted on.
    const hump = new THREE.CylinderGeometry(0.55, 0.55, 1, 10, 1, false, 0, Math.PI);
    hump.rotateZ(Math.PI / 2);
    hump.scale(1, 1, 0.19);
    const mesh = new THREE.InstancedMesh(hump, humpMaterial(), humps.length);
    const dummy = new THREE.Object3D();
    humps.forEach((h, i) => {
      dummy.position.set(h.x, 0.03, h.z);
      dummy.rotation.set(0, h.angle, 0);
      dummy.scale.set(h.width, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = "speed-humps";
    mesh.castShadow = true;
    group.add(mesh);
  }
  mergeInto(group, footpaths, roadMaterial("path"), "footpath", { batch: 600 });
  mergeInto(group, kerbFaces, concreteMaterial(PALETTE.kerb, { side: THREE.DoubleSide }), "kerb", { batch: 600 });
  mergeInto(group, paintedKerbs, paintedKerbMaterial(), "kerb-painted", { batch: 600 });
  mergeInto(group, drains, paintedMaterial(0x3a3a38, { roughness: 1 }), "drains", { batch: 600 });

  // ---- zebra crossings at junctions on the big roads
  const seen = new Map();
  for (const road of world.roads) {
    for (const [x, z] of road.points) {
      const key = `${Math.round(x / 6)},${Math.round(z / 6)}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const zebras = [];
  for (const road of world.roads) {
    if (road.kind !== "arterial" && road.kind !== "main") continue;
    for (let i = 1; i < road.points.length - 1; i++) {
      const [x, z] = road.points[i];
      const key = `${Math.round(x / 6)},${Math.round(z / 6)}`;
      if ((seen.get(key) || 0) < 2) continue;
      const prev = road.points[i - 1];
      const next = road.points[i + 1];
      const angle = Math.atan2(next[0] - prev[0], next[1] - prev[1]);
      // Set back from the junction mouth, the way a real crossing is.
      const back = 9;
      zebras.push({ x: x - Math.sin(angle) * back, z: z - Math.cos(angle) * back, angle, width: road.width });
      if (zebras.length > 120) break;
    }
  }
  if (zebras.length) {
    const quad = new THREE.PlaneGeometry(1, 3.2);
    quad.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(quad, zebraMaterial(), zebras.length);
    const dummy = new THREE.Object3D();
    zebras.forEach((zb, i) => {
      dummy.position.set(zb.x, 0.05, zb.z);
      dummy.rotation.set(0, zb.angle, 0);
      dummy.scale.set(zb.width, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = "zebras";
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  return group;
}

// ------------------------------------------------------------------ surfaces

function polygonGeometry(points, y) {
  const geometry = new THREE.ShapeGeometry(shapeFromPoints(points));
  // Same rotation as the buildings, so ground polygons stay registered with
  // them: shape-y is already negated, and -90° about X lands it face-up.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  geometry.computeVertexNormals();
  // ShapeGeometry hands back UVs in shape coordinates, which are metres here.
  // Scale them down so one grass tile covers 8 m rather than 1 m.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 8, uv.getY(i) / 8);
  uv.needsUpdate = true;
  return geometry;
}

// How far ground reaches past the last thing standing on it, in metres. Wide
// enough to read as a verge and to carry a road out to the edge of the extract;
// tight enough that the empty quarters go.
const GROUND_REACH = 46;
const GROUND_CELL = 10;
// How far the island's edge drops. A flat cut-out reads as paper; a rim of
// earth reads as land, which from the planet camera is the whole point.
const GROUND_SKIRT = 55;

function buildGround(world) {
  const [minX, minZ, maxX, maxZ] = world.bounds;
  const pad = GROUND_REACH + GROUND_CELL * 2;
  const x0 = minX - pad;
  const z0 = minZ - pad;
  const gw = Math.ceil((maxX - minX + pad * 2) / GROUND_CELL) + 1;
  const gh = Math.ceil((maxZ - minZ + pad * 2) / GROUND_CELL) + 1;

  // Chamfer distance in cells; INF stands for "nothing found yet".
  const INF = 1e9;
  const dist = new Float32Array(gw * gh).fill(INF);
  const stamp = (x, z) => {
    const i = Math.round((x - x0) / GROUND_CELL);
    const j = Math.round((z - z0) / GROUND_CELL);
    if (i >= 0 && j >= 0 && i < gw && j < gh) dist[j * gw + i] = 0;
  };

  // Roads are stamped along their length rather than at their vertices: a
  // straight 400 m arterial has two vertices, and seeding only those would put
  // a hole in the ground down the middle of the road.
  for (const road of world.roads) {
    for (let k = 1; k < road.points.length; k += 1) {
      const a = road.points[k - 1];
      const b = road.points[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / GROUND_CELL));
      for (let s = 0; s <= steps; s += 1) {
        stamp(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps);
      }
    }
  }
  // Areas are filled, not outlined.
  //
  // Stamping only the vertices of a polygon seeds its corners and nothing else,
  // so Agara Lake — one ring, a few hundred metres across — seeded its shoreline
  // and left its entire middle unstamped. The distance transform then reached
  // 46 m in from the bank and stopped, and the lake rendered with a ragged hole
  // punched through the world where its centre should be. Same for the parks and
  // the BBMP ground. Scanline fill costs nothing at this grid size and is the
  // difference between a shoreline and a shore.
  const fill = (points) => {
    let jMin = Infinity;
    let jMax = -Infinity;
    for (const [, pz] of points) {
      const j = (pz - z0) / GROUND_CELL;
      if (j < jMin) jMin = j;
      if (j > jMax) jMax = j;
    }
    jMin = Math.max(0, Math.floor(jMin));
    jMax = Math.min(gh - 1, Math.ceil(jMax));
    for (let j = jMin; j <= jMax; j += 1) {
      const zLine = z0 + j * GROUND_CELL;
      const crossings = [];
      for (let k = 0; k < points.length; k += 1) {
        const a = points[k];
        const b = points[(k + 1) % points.length];
        // Half-open test on z, so a vertex exactly on the scanline counts once.
        if ((a[1] <= zLine) === (b[1] <= zLine)) continue;
        crossings.push(a[0] + ((zLine - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      crossings.sort((m, n) => m - n);
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        const i0 = Math.max(0, Math.ceil((crossings[c] - x0) / GROUND_CELL));
        const i1 = Math.min(gw - 1, Math.floor((crossings[c + 1] - x0) / GROUND_CELL));
        for (let i = i0; i <= i1; i += 1) dist[j * gw + i] = 0;
      }
    }
    // The fill can miss a polygon thinner than one cell entirely, so the ring
    // itself is stamped as well.
    for (let k = 0; k < points.length; k += 1) {
      const a = points[k];
      const b = points[(k + 1) % points.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / GROUND_CELL));
      for (let t = 0; t <= steps; t += 1) {
        stamp(a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps);
      }
    }
  };

  for (const building of world.buildings) fill(building.points);
  for (const patch of world.green) fill(patch.points);
  for (const body of world.water) fill(body.points);
  for (const tree of world.trees ?? []) stamp(tree.p ? tree.p[0] : tree[0], tree.p ? tree.p[1] : tree[1]);

  // Two-pass chamfer. 1 orthogonally, sqrt(2) diagonally — close enough to
  // Euclidean at this cell size that the island edge reads as a curve.
  const D1 = 1;
  const D2 = Math.SQRT2;
  const at = (i, j) => (i < 0 || j < 0 || i >= gw || j >= gh ? INF : dist[j * gw + i]);
  for (let j = 0; j < gh; j += 1) {
    for (let i = 0; i < gw; i += 1) {
      const k = j * gw + i;
      let d = dist[k];
      d = Math.min(d, at(i - 1, j) + D1, at(i, j - 1) + D1, at(i - 1, j - 1) + D2, at(i + 1, j - 1) + D2);
      dist[k] = d;
    }
  }
  for (let j = gh - 1; j >= 0; j -= 1) {
    for (let i = gw - 1; i >= 0; i -= 1) {
      const k = j * gw + i;
      let d = dist[k];
      d = Math.min(d, at(i + 1, j) + D1, at(i, j + 1) + D1, at(i + 1, j + 1) + D2, at(i - 1, j + 1) + D2);
      dist[k] = d;
    }
  }

  const reach = GROUND_REACH / GROUND_CELL;

  // Close anything enclosed.
  //
  // A gap in the middle of the city is a hole in the world — you can see the
  // sky through the floor — and it reads as a crash, not as a design. A gap at
  // the edge is the coastline, which is the entire point. The two are told
  // apart by connectivity and nothing else: flood the *empty* cells inward from
  // the border, and any empty cell the flood never reaches is enclosed by city
  // on all sides. Those become ground regardless of how far they are from
  // anything.
  const open = new Uint8Array(gw * gh);
  const stack = [];
  const consider = (i, j) => {
    if (i < 0 || j < 0 || i >= gw || j >= gh) return;
    const k = j * gw + i;
    if (open[k] || dist[k] <= reach) return;
    open[k] = 1;
    stack.push(k);
  };
  for (let i = 0; i < gw; i += 1) { consider(i, 0); consider(i, gh - 1); }
  for (let j = 0; j < gh; j += 1) { consider(0, j); consider(gw - 1, j); }
  while (stack.length) {
    const k = stack.pop();
    const i = k % gw;
    const j = (k - i) / gw;
    consider(i - 1, j); consider(i + 1, j); consider(i, j - 1); consider(i, j + 1);
  }

  const inside = (i, j) => {
    if (i < 0 || j < 0 || i >= gw || j >= gh) return false;
    const k = j * gw + i;
    return dist[k] <= reach || !open[k];
  };

  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  // `n` is the face normal. It has to be a real unit vector on the skirt as
  // well as on the deck: passing (0, 0, 0) for the vertical panels — which the
  // first version did, meaning "no vertical component" rather than "no normal"
  // — makes N·L undefined, and the whole rim lit up pure white. From above it
  // read as a halo tracing the coastline, and through the bird camera's
  // curvature the near rim bent into view as bright white blobs sitting over
  // the city, which is a convincing impression of holes in the world.
  const pushQuad = (a, b, c, d, n) => {
    const base = position.length / 3;
    for (const p of [a, b, c, d]) {
      position.push(p[0], p[1], p[2]);
      normal.push(n[0], n[1], n[2]);
      // Metres into the dirt texture, at the same 48 m tile the old plane used.
      uv.push(p[0] / 48, p[2] / 48);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const UP = [0, 1, 0];
  const NORTH = [0, 0, -1];
  const SOUTH = [0, 0, 1];
  const WEST = [-1, 0, 0];
  const EAST = [1, 0, 0];

  const wx = (i) => x0 + i * GROUND_CELL;
  const wz = (j) => z0 + j * GROUND_CELL;
  const Y = -0.03;

  let cells = 0;
  for (let j = 0; j < gh - 1; j += 1) {
    for (let i = 0; i < gw - 1; i += 1) {
      // A cell is ground when any of its four corners is in reach, so the edge
      // errs outward and never cuts a road short.
      if (!(inside(i, j) || inside(i + 1, j) || inside(i, j + 1) || inside(i + 1, j + 1))) continue;
      cells += 1;
      const xa = wx(i); const xb = wx(i + 1);
      const za = wz(j); const zb = wz(j + 1);
      pushQuad([xa, Y, za], [xb, Y, za], [xb, Y, zb], [xa, Y, zb], UP);
    }
  }

  // The rim. Any edge of a ground cell whose neighbour is not ground gets a
  // wall dropped from it, so the island has a thickness.
  const isGround = (i, j) => (i < 0 || j < 0 || i >= gw - 1 || j >= gh - 1)
    ? false
    : (inside(i, j) || inside(i + 1, j) || inside(i, j + 1) || inside(i + 1, j + 1));
  const B = Y - GROUND_SKIRT;
  for (let j = 0; j < gh - 1; j += 1) {
    for (let i = 0; i < gw - 1; i += 1) {
      if (!isGround(i, j)) continue;
      const xa = wx(i); const xb = wx(i + 1);
      const za = wz(j); const zb = wz(j + 1);
      // Wound so each skirt panel faces away from the island.
      if (!isGround(i, j - 1)) pushQuad([xb, Y, za], [xa, Y, za], [xa, B, za], [xb, B, za], NORTH);
      if (!isGround(i, j + 1)) pushQuad([xa, Y, zb], [xb, Y, zb], [xb, B, zb], [xa, B, zb], SOUTH);
      if (!isGround(i - 1, j)) pushQuad([xa, Y, za], [xa, Y, zb], [xa, B, zb], [xa, B, za], WEST);
      if (!isGround(i + 1, j)) pushQuad([xb, Y, zb], [xb, Y, za], [xb, B, za], [xb, B, zb], EAST);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, dirtMaterial());
  mesh.receiveShadow = true;
  mesh.name = "ground";
  mesh.userData.cells = cells;
  console.log(`[ground] ${cells} cells (${(cells * GROUND_CELL ** 2 / 1e6).toFixed(2)} km²), `
    + `${(index.length / 3).toLocaleString()} triangles`);
  return mesh;
}

function buildSurfaces(world, env) {
  const group = new THREE.Group();
  group.name = "surfaces";

  const light = [];
  const dark = [];
  for (const patch of world.green) {
    try {
      const geometry = polygonGeometry(patch.points, 0.02);
      (patch.area > 4000 ? dark : light).push(paintGeometry(geometry, 0xffffff));
    } catch { /* skip malformed ring */ }
  }
  mergeInto(group, light, grassMaterial(false), "green");
  mergeInto(group, dark, grassMaterial(true), "green-dark");

  // Water sits *above* the green layer, not below it. OSM maps Agara Lake Park
  // as a leisure=park polygon covering the whole lake, so a physically-correct
  // sunken water plane is completely hidden by the park it belongs to — the
  // lake renders as a field of grass.
  const waterChunks = [];
  for (const body of world.water) {
    try { waterChunks.push(polygonGeometry(body.points, 0.09)); } catch { /* skip */ }
  }
  if (waterChunks.length) {
    const merged = mergeGeometries(waterChunks, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, waterMaterial(env));
      mesh.name = "water";
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    for (const chunk of waterChunks) chunk.dispose();
  }

  // Ground, shaped to the city rather than to the bounding box.
  //
  // This used to be one 3.3 km plane of bare earth centred on the extract, on
  // the reasoning that gaps between polygons should never show sky. It works,
  // and it is also two thirds empty: the extract is 2.1 km square, the plane was
  // padded 600 m past that on every side, and inside the extract there are
  // whole quarters — beyond the lake, north of the ring road — that carry
  // nothing at all. From the drone the layout sat in the middle of an enormous
  // blank brown field, which is the opposite of the small-planet read the bird
  // camera is for.
  //
  // So the ground is now an island the shape of the place. Everything the
  // extract actually contains — every road centreline, every footprint vertex,
  // every park and water ring — is stamped into a 10 m grid; a distance
  // transform runs out from those seeds; and ground exists only within GROUND_REACH
  // of something. That keeps a generous verge round the outermost buildings and
  // lets the ground follow a road out to the edge of the extract, while the
  // empty quarters simply stop being there.
  group.add(buildGround(world));

  return group;
}

// ------------------------------------------------------------------ trees

// Crossed alpha-cut cards, not subdivided spheres. A canopy is mostly holes,
// and holes are the one thing solid geometry cannot do: a sphere of leaves
// silhouettes as a ball and gives the whole street a toy scale. Four cards per
// cluster is 8 triangles and reads as foliage from 2 m and from 200 m.
function foliageCluster(radius) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const quad = new THREE.PlaneGeometry(radius * 2.1, radius * 1.9);
    quad.rotateY((i / 3) * Math.PI);
    quad.rotateZ((i - 1) * 0.16);
    parts.push(quad);
  }
  // One card raked towards the horizontal, offset off-axis. Seen from the drone
  // a single flat quad reads as a sticker lying on the tree; seen from the
  // street, two of them read as flat sprays. One, tilted, does neither.
  const tilt = new THREE.PlaneGeometry(radius * 1.8, radius * 1.7);
  tilt.rotateX(-Math.PI / 2.8);
  tilt.rotateY(0.9);
  tilt.translate(0, radius * 0.34, 0);
  parts.push(tilt);
  return mergeGeometries(parts, false);
}

const CANOPY_CLEARANCE = 3.2;

function buildTrees(world, random, roads) {
  const group = new THREE.Group();
  group.name = "trees";

  const species = {
    tabebuia: { radius: 3.3, trunkHeight: 3.6, trunkRadius: 0.2, tint: [0xffffff, 0xf7dbe6, 0xffeef5] },
    canopy: { radius: 3.7, trunkHeight: 3.2, trunkRadius: 0.26, tint: [0xffffff, 0xd9e8cf, 0xc6d9bb] },
  };

  // Reject anything planted on a carriageway. The avenue offsets in the
  // pipeline are measured per road, so where two mapped ways run parallel the
  // second road's verge lands squarely in the first road's tarmac — and a
  // mature tabebuia grows out of the fast lane.
  const buckets = { tabebuia: [], canopy: [] };
  let rejected = 0;
  for (const tree of world.trees) {
    if (!roads.clear(tree.p[0], tree.p[1], null, 0.6)) { rejected++; continue; }
    buckets[tree.s]?.push(tree);
  }
  if (rejected) console.info(`[build] ${rejected} trees rejected: planted on a carriageway`);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (const [name, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    const spec = species[name];

    const canopy = foliageCluster(spec.radius);
    const foliage = new THREE.InstancedMesh(canopy, foliageMaterial(name), list.length);
    foliage.castShadow = true;
    foliage.receiveShadow = true;
    foliage.name = `foliage-${name}`;

    const trunkGeometry = new THREE.CylinderGeometry(spec.trunkRadius * 0.62, spec.trunkRadius, 1, 6, 1);
    trunkGeometry.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeometry, barkMaterial(), list.length);
    trunks.castShadow = true;
    trunks.name = `trunk-${name}`;

    list.forEach((tree, i) => {
      const scale = tree.h;
      const spin = random() * Math.PI * 2;
      // Clear head height with margin: the canopy cards reach a full radius
      // below their origin, so sizing the lift from the trunk alone leaves the
      // tallest trees hanging in the player's face.
      const reach = spec.radius * scale * 0.95;
      const canopyY = Math.max(CANOPY_CLEARANCE + reach * 0.55, spec.trunkHeight * scale);

      dummy.position.set(tree.p[0], canopyY, tree.p[1]);
      dummy.rotation.set(0, spin, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);
      foliage.setColorAt(i, color.set(spec.tint[i % spec.tint.length]));

      dummy.position.set(tree.p[0], 0, tree.p[1]);
      dummy.rotation.set(0, spin, 0);
      dummy.scale.set(scale, canopyY + 0.4, scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
    });

    foliage.instanceMatrix.needsUpdate = true;
    if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    group.add(foliage, trunks);
  }
  return group;
}

// ------------------------------------------------------------------ street kit

// The props that sell "Bengaluru" rather than "generic city": streetlights on
// swan-neck arms, utility poles with sagging cable runs, and the compound wall
// around anything with a plot.
function buildStreetKit(world, random, roads) {
  const group = new THREE.Group();
  group.name = "streetkit";
  const dummy = new THREE.Object3D();

  const lampPosts = [];
  const utility = [];

  for (const road of world.roads) {
    const big = road.kind === "arterial" || road.kind === "main";
    if (!big && road.kind !== "street") continue;
    for (let i = 1; i < road.points.length; i++) {
      const [ax, az] = road.points[i - 1];
      const [bx, bz] = road.points[i];
      const segment = Math.hypot(bx - ax, bz - az);
      if (segment < 6) continue;
      const nx = -(bz - az) / segment;
      const nz = (bx - ax) / segment;
      const heading = Math.atan2(bx - ax, bz - az);
      const spacing = big ? 32 : 46;
      for (let d = 4; d < segment; d += spacing) {
        const t = d / segment;
        const side = ((i + Math.floor(d)) % 2 === 0) ? 1 : -1;
        const off = road.width / 2 + (big ? 1.6 : 1.1);
        const x = ax + (bx - ax) * t + nx * side * off;
        const z = az + (bz - az) * t + nz * side * off;
        if (!roads.clear(x, z, road, 0.3)) continue;   // no lamp posts in the fast lane
        lampPosts.push({ x, z, angle: heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2), tall: big });
        if (big && random() < 0.45) utility.push({ x: x + nx * side * 0.9, z: z + nz * side * 0.9 });
      }
    }
  }

  // ---- streetlights: pole, swan-neck arm, lamp housing. The housing gets its
  // own emissive material so the whole city can be switched on at dusk with one
  // uniform rather than hundreds of lights the GPU cannot afford.
  if (lampPosts.length) {
    const pole = new THREE.CylinderGeometry(0.075, 0.12, 1, 6);
    pole.translate(0, 0.5, 0);
    const poles = new THREE.InstancedMesh(pole, metalMaterial(0x6f6d73), lampPosts.length);
    poles.castShadow = true;
    poles.name = "lamp-poles";

    const arm = new THREE.CylinderGeometry(0.06, 0.06, 1.5, 5);
    arm.rotateZ(Math.PI / 2);
    arm.translate(0.75, 0, 0);
    const arms = new THREE.InstancedMesh(arm, metalMaterial(0x6f6d73), lampPosts.length);
    arms.castShadow = true;
    arms.name = "lamp-arms";

    const head = softBox(0.62, 0.16, 0.3, 0.07);
    const heads = new THREE.InstancedMesh(head, lampMaterial(), lampPosts.length);
    heads.name = "lamp-heads";

    // The pool of light on the road under each lamp. Hundreds of real point
    // lights is not affordable; an additive quad on the tarmac is, and it is
    // what the eye actually reads as "the street lights are on".
    const pool = new THREE.PlaneGeometry(1, 1);
    pool.rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(pool, lightPoolMaterial(), lampPosts.length);
    pools.name = "lamp-pools";
    pools.renderOrder = 2;

    lampPosts.forEach((lamp, i) => {
      const height = lamp.tall ? 8.4 : 6.6;
      dummy.position.set(lamp.x, 0, lamp.z);
      dummy.rotation.set(0, lamp.angle, 0);
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);

      dummy.position.set(lamp.x, height - 0.3, lamp.z);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      arms.setMatrixAt(i, dummy.matrix);

      const headX = lamp.x + Math.cos(lamp.angle) * 1.45;
      const headZ = lamp.z - Math.sin(lamp.angle) * 1.45;
      dummy.position.set(headX, height - 0.42, headZ);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);

      dummy.position.set(headX, 0.08, headZ);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(height * 1.5, 1, height * 1.5);
      dummy.updateMatrix();
      pools.setMatrixAt(i, dummy.matrix);
    });
    poles.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
    group.add(poles, arms, heads, pools);
  }

  // ---- utility poles and the cable spaghetti between them. Overhead cable is
  // the most recognisable thing about an Indian street after the autos.
  if (utility.length) {
    const pole = new THREE.CylinderGeometry(0.11, 0.16, 9, 6);
    pole.translate(0, 4.5, 0);
    const poles = new THREE.InstancedMesh(pole, concreteMaterial(0xa9a49b), utility.length);
    poles.castShadow = true;
    poles.name = "utility-poles";
    utility.forEach((p, i) => {
      dummy.position.set(p.x, 0, p.z);
      dummy.rotation.set(0, random() * 0.4, 0);
      dummy.scale.setScalar(0.9 + random() * 0.25);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
    });
    poles.instanceMatrix.needsUpdate = true;
    group.add(poles);

    // Cables: sagging catenaries between poles that are close enough to be on
    // the same run. Drawn as lines — a tube per cable would cost more than the
    // buildings.
    const points = [];
    for (let i = 0; i < utility.length - 1; i++) {
      const a = utility[i];
      const b = utility[i + 1];
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 60 || span < 8) continue;
      for (let strand = 0; strand < 3; strand++) {
        const y0 = 8.1 - strand * 0.45;
        const sag = 0.8 + strand * 0.25;
        for (let s = 0; s < 8; s++) {
          const t0 = s / 8;
          const t1 = (s + 1) / 8;
          const yAt = (t) => y0 - Math.sin(t * Math.PI) * sag;
          points.push(
            a.x + (b.x - a.x) * t0, yAt(t0), a.z + (b.z - a.z) * t0,
            a.x + (b.x - a.x) * t1, yAt(t1), a.z + (b.z - a.z) * t1,
          );
        }
      }
    }
    if (points.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      const cables = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x2a2a2c }));
      cables.name = "cables";
      group.add(cables);
    }
  }

  return group;
}

// Lamp housings share one material so dusk can switch the whole city on by
// changing a single emissiveIntensity.
let _lamp = null;
function lampMaterial() {
  if (!_lamp) {
    _lamp = new THREE.MeshStandardMaterial({
      color: 0x3a3a3c, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.5,
    });
  }
  return _lamp;
}

export function setStreetLights(amount) {
  if (_lamp) _lamp.emissiveIntensity = amount * 3.5;
  lightPoolMaterial().opacity = amount * 0.45;
  setShopGlow(amount);
  // A quarter of the modelled windows carry a light. Coming on at dusk is what
  // turns a dark massing model back into somewhere people live.
  if (_litWindows) _litWindows.emissiveIntensity = amount * 1.25;
}

// The modelled window detail, switched as a whole.
//
// From the bird camera the city is six hundred metres away and a 90 mm window
// frame covers a fraction of a pixel, so every one of those 2.9 million
// triangles is being rasterised into nothing. Off, up there.
let _facadeDetail = null;
let _litWindows = null;
export function setFacadeDetail(visible) {
  if (_facadeDetail) _facadeDetail.visible = visible;
}

// ------------------------------------------------------------------ entry

export function buildWorld(world, env, photo, reads) {
  const random = makeRandom(0x5a4b3c);
  const root = new THREE.Group();
  root.name = "hsr";
  // Which class of road a plot sits on decides how tall it builds and whether
  // it has a shopfront — the same rule the city itself followed.
  const roadIndex = buildRoadIndex(world);
  const roads = carriagewayIndex(world);
  root.add(buildSurfaces(world, env));
  root.add(buildRoads(world, random, roads));
  const buildings = buildBuildings(world, random, roadIndex, roads, photo, reads);
  root.add(buildings);
  root.add(buildSignage(world, buildings));
  root.add(buildTrees(world, random, roads));
  root.add(buildStreetKit(world, random, roads));
  root.add(buildProps(world, random, roads, buildings));
  return root;
}

// Coarse lookup of the most important road class near a point.
function buildRoadIndex(world) {
  const cell = 60;
  const grid = new Map();
  const rank = { arterial: 4, main: 3, street: 2, service: 1, path: 0 };
  for (const road of world.roads) {
    for (const [x, z] of road.points) {
      const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      const current = grid.get(key);
      if (!current || rank[road.kind] > rank[current]) grid.set(key, road.kind);
    }
  }
  return {
    classAt(x, z) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let best = null;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const kind = grid.get(`${cx + i},${cz + j}`);
          if (kind && (!best || rank[kind] > rank[best])) best = kind;
        }
      }
      return best;
    },
  };
}
