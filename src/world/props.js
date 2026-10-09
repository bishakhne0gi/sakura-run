import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  paintGeometry, paintedMaterial, metalMaterial, concreteMaterial,
} from "../render/materials.js";

// The prop layer.
//
// This is the difference between a street and a model of a street. The
// reference this build is chasing has almost nobody on screen and still reads
// as inhabited, because every metre of its pavement carries something: gates,
// poles, cables, bins, parked bikes, boards. Ours had a clean kerb and nothing
// standing on it.
//
// Everything here is specific to Bengaluru rather than generic street
// furniture. A compound wall with a sliding gate in front of every plot, a
// transformer bolted to a concrete pole, two-wheelers nosed into the kerb in
// rows — those three alone place the city more firmly than any amount of
// material work.
//
// All of it is instanced and placed off the same carriageway index the
// footpaths use, so nothing lands in a live traffic lane.

const tmp = new THREE.Object3D();

// mergeGeometries returns null when indexed and non-indexed inputs are mixed,
// and ExtrudeGeometry (soft, below) is non-indexed while boxes and cylinders are
// indexed. Everything is flattened so the two can share a merge.
const flat = (geometry) => (geometry.index ? geometry.toNonIndexed() : geometry);

// A box with every edge rounded. Hard 90-degree edges are the loudest tell that
// something was generated rather than drawn — there is not a sharp corner on a
// bin, a bus shelter or a scooter panel anywhere in the films this is chasing.
function soft(w, h, d, radius, color, x = 0, y = 0, z = 0) {
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
  geometry.translate(x, y, z);
  geometry.computeVertexNormals();
  return paintGeometry(flat(geometry), color);
}

function ball(radius, color, x = 0, y = 0, z = 0, scale = [1, 1, 1]) {
  const geometry = new THREE.SphereGeometry(radius, 12, 9);
  geometry.scale(scale[0], scale[1], scale[2]);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

function cylinder(r, h, color, x, y, z, axis = "y", seg = 8) {
  const geometry = new THREE.CylinderGeometry(r, r, h, Math.max(seg, 10));
  if (axis === "x") geometry.rotateZ(Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

function instance(group, geometry, material, placements, name, cast = true) {
  if (!placements.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  placements.forEach((p, i) => {
    tmp.position.set(p.x, p.y || 0, p.z);
    tmp.rotation.set(p.rx || 0, p.angle || 0, 0);
    tmp.scale.setScalar(p.scale || 1);
    tmp.updateMatrix();
    mesh.setMatrixAt(i, tmp.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return mesh;
}

// ------------------------------------------------------------------ geometry

// Scooter, nosed into the kerb. Deliberately the same silhouette as the moving
// ones in traffic.js: a parked bike that does not match the riding bikes reads
// as a different city's vehicle.
function scooterGeometry() {
  return mergeGeometries([
    soft(0.34, 0.44, 1.16, 0.16, 0xffffff, 0, 0.62, -0.05),
    soft(0.3, 0.14, 0.5, 0.07, 0x38332e, 0, 0.86, -0.4),
    ball(0.22, 0xffffff, 0, 0.78, 0.44, [0.8, 1.0, 0.9]),
    cylinder(0.05, 0.5, 0x4a453f, 0, 1.02, 0.48, "y", 10),
    cylinder(0.03, 0.6, 0x4a453f, 0, 1.2, 0.5, "x", 10),
    cylinder(0.26, 0.1, 0x232122, 0, 0.26, 0.62, "x", 12),
    cylinder(0.26, 0.1, 0x232122, 0, 0.26, -0.62, "x", 12),
    // On its side stand, so a row of them leans the same way.
    cylinder(0.025, 0.3, 0x38332e, -0.2, 0.15, -0.2, "y", 8),
  ], false);
}

// The BBMP wheelie bin, and the pile that accumulates beside it.
function binGeometry() {
  return mergeGeometries([
    soft(0.62, 0.78, 0.56, 0.1, 0x3f7a4a, 0, 0.42, 0),
    soft(0.66, 0.09, 0.6, 0.05, 0x2f6438, 0, 0.85, 0),
    cylinder(0.09, 0.06, 0x1b1b1d, -0.26, 0.09, 0.18, "x", 6),
    cylinder(0.09, 0.06, 0x1b1b1d, 0.26, 0.09, 0.18, "x", 6),
  ], false);
}

// Pole-mounted distribution transformer: the drum, its cradle, and the box
// below it. Bolted to one pole in six.
function transformerGeometry() {
  return mergeGeometries([
    cylinder(0.32, 0.62, 0x7b7f78, 0, 5.6, 0, "y", 10),
    soft(0.86, 0.1, 0.5, 0.05, 0x5f625d, 0, 5.24, 0),
    soft(0.46, 0.62, 0.34, 0.1, 0x8a8d86, 0, 4.5, 0),
    cylinder(0.06, 0.22, 0xd8d3c4, -0.14, 6.0, 0),
    cylinder(0.06, 0.22, 0xd8d3c4, 0.14, 6.0, 0),
  ], false);
}

// The gate: two posts and a sliding leaf. Every plot in the layout has one, and
// it is the single most repeated object on a residential street here.
function gateGeometry(width) {
  const parts = [
    soft(0.22, 1.9, 0.22, 0.07, 0xd8d2c6, -width / 2, 0.95, 0),
    soft(0.22, 1.9, 0.22, 0.07, 0xd8d2c6, width / 2, 0.95, 0),
    box(width - 0.3, 0.09, 0.06, 0x4a5a52, 0, 1.62, 0),
    box(width - 0.3, 0.09, 0.06, 0x4a5a52, 0, 0.28, 0),
  ];
  const bars = Math.max(4, Math.round(width / 0.24));
  for (let i = 0; i < bars; i++) {
    const x = -width / 2 + 0.18 + (i * (width - 0.36)) / (bars - 1);
    parts.push(box(0.05, 1.42, 0.05, 0x4a5a52, x, 0.83, 0));
  }
  return mergeGeometries(parts, false);
}

// Roadside hoarding. Blank panels, deliberately: inventing brand artwork for a
// real street would be putting words in a real place's mouth.
function hoardingGeometry() {
  return mergeGeometries([
    cylinder(0.13, 4.4, 0x7d7a73, -2.6, 2.2, 0, "y", 10),
    cylinder(0.13, 4.4, 0x7d7a73, 2.6, 2.2, 0, "y", 10),
    soft(6.4, 3.0, 0.18, 0.14, 0xeee8db, 0, 4.6, 0),
    soft(6.6, 0.2, 0.3, 0.08, 0x95928a, 0, 6.2, 0),
  ], false);
}

function shelterGeometry() {
  return mergeGeometries([
    cylinder(0.07, 2.5, 0x95928a, -1.9, 1.25, -0.7, "y", 10),
    cylinder(0.07, 2.5, 0x95928a, 1.9, 1.25, -0.7, "y", 10),
    soft(4.2, 0.14, 1.9, 0.08, 0x4f7d9c, 0, 2.56, 0),
    // Curved canopy: a flat lid is what made this read as a carport.
    ball(1.2, 0x4f7d9c, 0, 2.5, 0, [1.75, 0.2, 0.85]),
    soft(4.0, 1.1, 0.09, 0.1, 0xc4bfb4, 0, 0.75, -0.85),
    soft(3.2, 0.12, 0.42, 0.05, 0x7d6f5e, 0, 0.5, 0),
    cylinder(0.05, 0.5, 0x7d6f5e, -1.5, 0.25, 0, "y", 8),
    cylinder(0.05, 0.5, 0x7d6f5e, 1.5, 0.25, 0, "y", 8),
  ], false);
}

// Potted plants on a compound wall, and the odd tulsi pot by a gate.
function potGeometry() {
  return mergeGeometries([
    cylinder(0.17, 0.3, 0xb26138, 0, 0.15, 0, "y", 12),
    cylinder(0.2, 0.06, 0x99502e, 0, 0.31, 0, "y", 12),
    ball(0.17, 0x5c8a4a, 0, 0.4, 0, [1, 0.7, 1]),   // the plant in it
  ], false);
}

// ------------------------------------------------------------------ builder

export function buildProps(world, random, roads, buildings) {
  const group = new THREE.Group();
  group.name = "props";

  const walls = [];
  const gates = [];
  const scooters = [];
  const bins = [];
  const pots = [];
  const transformers = [];
  const hoardings = [];
  const shelters = [];

  // ---- compound walls and gates
  //
  // A wall only makes sense where the building is actually set back from the
  // street. Where the plot builds right up to the pavement — which is most of
  // the retail frontage — there is no compound, and drawing one puts a wall
  // through the shopfront.
  const profiles = buildings.userData.profiles;
  for (const building of world.buildings) {
    const profile = profiles?.get(building);
    if (profile?.shop) continue;                    // shopfronts meet the street
    if (building.area < 45 || building.area > 2400) continue;

    const near = roads.nearest(building.centroid[0], building.centroid[1], 34);
    if (!near) continue;
    const setback = near.distance - near.half;
    if (setback < 4.5 || setback > 26) continue;    // no room, or not a street plot

    // The plot line: just beyond the footpath, parallel to the road.
    const walkWidth = near.kind === "arterial" ? 2.6 : near.kind === "main" ? 1.9 : 1.4;
    const offset = near.half + walkWidth + 0.6;
    const cx = near.px + -near.uz * offset * near.side;
    const cz = near.pz + near.ux * offset * near.side;

    // Frontage width: how much of the road line this building actually faces.
    let minT = Infinity;
    let maxT = -Infinity;
    for (const [px, pz] of building.points) {
      const t = (px - near.px) * near.ux + (pz - near.pz) * near.uz;
      minT = Math.min(minT, t);
      maxT = Math.max(maxT, t);
    }
    const width = Math.min(Math.max(maxT - minT, 4), 22);
    if (!isFinite(width)) continue;
    const mid = (minT + maxT) / 2;
    const angle = Math.atan2(near.ux, near.uz);
    const baseX = near.px + near.ux * mid + -near.uz * offset * near.side;
    const baseZ = near.pz + near.uz * mid + near.ux * offset * near.side;
    void cx; void cz;

    // Gate in the middle, wall either side of it.
    const gateWidth = Math.min(3.4, width * 0.42);
    const armed = (width - gateWidth) / 2;
    if (armed > 0.8) {
      for (const dir of [-1, 1]) {
        const centre = dir * (gateWidth / 2 + armed / 2);
        walls.push({
          x: baseX + near.ux * centre,
          z: baseZ + near.uz * centre,
          angle,
          length: armed,
          height: 1.35 + (building.area > 400 ? 0.35 : 0),
        });
      }
    }
    gates.push({ x: baseX, z: baseZ, angle, width: gateWidth });

    // A pot or two by the gate, and sometimes on the wall.
    if (random() < 0.5) {
      pots.push({
        x: baseX + near.ux * (gateWidth / 2 + 0.45),
        z: baseZ + near.uz * (gateWidth / 2 + 0.45),
        angle, scale: 0.9 + random() * 0.4,
      });
    }
  }

  // Compound walls are extruded per plot and merged: one wall is four
  // triangles, and there are thousands of them.
  if (walls.length) {
    const chunks = walls.map((w) => {
      const geometry = new THREE.BoxGeometry(w.length, w.height, 0.2);
      geometry.translate(0, w.height / 2, 0);
      geometry.rotateY(w.angle);
      geometry.translate(w.x, 0, w.z);
      // A darker coping course along the top, which every compound wall has.
      const cap = new THREE.BoxGeometry(w.length, 0.11, 0.32);
      cap.translate(0, w.height + 0.045, 0);
      cap.rotateY(w.angle);
      cap.translate(w.x, 0, w.z);
      return [paintGeometry(geometry, 0xded7c9), paintGeometry(cap, 0xb9b2a2)];
    }).flat();
    const BATCH = 800;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const merged = mergeGeometries(chunks.slice(i, i + BATCH), false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, concreteMaterial(0xffffff, { vertexColors: true }));
      mesh.name = `compound-wall-${i / BATCH}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const chunk of chunks) chunk.dispose();
  }

  // Gates vary in width, so they are merged rather than instanced.
  if (gates.length) {
    const chunks = gates.map((g) => {
      const geometry = gateGeometry(g.width);
      geometry.rotateY(g.angle);
      geometry.translate(g.x, 0, g.z);
      return geometry;
    });
    const BATCH = 600;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const merged = mergeGeometries(chunks.slice(i, i + BATCH), false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, paintedMaterial(0xffffff, { roughness: 0.55, metalness: 0.35, vertexColors: true }));
      mesh.name = `gate-${i / BATCH}`;
      mesh.castShadow = true;
      group.add(mesh);
    }
    for (const chunk of chunks) chunk.dispose();
  }

  // ---- everything that sits on a pavement
  for (const road of world.roads) {
    if (road.kind === "path") continue;
    const big = road.kind === "arterial" || road.kind === "main";

    for (let i = 1; i < road.points.length; i++) {
      const [ax, az] = road.points[i - 1];
      const [bx, bz] = road.points[i];
      const span = Math.hypot(bx - ax, bz - az);
      if (span < 6) continue;
      const ux = (bx - ax) / span;
      const uz = (bz - az) / span;
      const nx = -uz;
      const nz = ux;
      const heading = Math.atan2(ux, uz);

      for (let d = 3; d < span; d += 6 + random() * 9) {
        const t = d / span;
        const side = random() < 0.5 ? 1 : -1;
        const off = road.width / 2 + (big ? 1.4 : 1.0);
        const x = ax + (bx - ax) * t + nx * side * off;
        const z = az + (bz - az) * t + nz * side * off;
        if (!roads.clear(x, z, road, 0.5)) continue;

        const roll = random();
        if (roll < 0.42) {
          // A row of two-wheelers, nosed in at the kerb.
          const count = 1 + Math.floor(random() * 4);
          for (let k = 0; k < count; k++) {
            const along = (k - (count - 1) / 2) * 0.78;
            scooters.push({
              x: x + ux * along,
              z: z + uz * along,
              // Perpendicular to the road, front wheel to the kerb.
              angle: heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + (random() - 0.5) * 0.12,
              scale: 0.96 + random() * 0.1,
            });
          }
        } else if (roll < 0.52) {
          bins.push({ x, z, angle: heading + (random() - 0.5) * 0.5 });
        } else if (roll < 0.56 && big) {
          hoardings.push({ x: x + nx * side * 2.2, z: z + nz * side * 2.2, angle: heading + (side > 0 ? 0 : Math.PI) });
        } else if (roll < 0.585 && big) {
          shelters.push({ x: x + nx * side * 1.4, z: z + nz * side * 1.4, angle: heading + (side > 0 ? 0 : Math.PI) });
        }
      }
    }
  }

  // ---- transformers, hung on the utility poles the street kit already placed
  for (const road of world.roads) {
    if (road.kind !== "arterial" && road.kind !== "main") continue;
    for (let i = 1; i < road.points.length; i++) {
      const [ax, az] = road.points[i - 1];
      const [bx, bz] = road.points[i];
      const span = Math.hypot(bx - ax, bz - az);
      if (span < 20) continue;
      const nx = -(bz - az) / span;
      const nz = (bx - ax) / span;
      for (let d = 10; d < span; d += 64 + random() * 40) {
        const t = d / span;
        const side = random() < 0.5 ? 1 : -1;
        const off = road.width / 2 + 1.6;
        const x = ax + (bx - ax) * t + nx * side * off;
        const z = az + (bz - az) * t + nz * side * off;
        if (!roads.clear(x, z, road, 0.4)) continue;
        transformers.push({ x, z, angle: random() * Math.PI });
      }
    }
  }

  const plastic = paintedMaterial(0xffffff, { roughness: 0.62, metalness: 0.08, vertexColors: true });
  const painted = paintedMaterial(0xffffff, { roughness: 0.7, metalness: 0.2, vertexColors: true });

  // Two-wheelers get an instance colour on top of their vertex colours so a row
  // is not all one shade.
  const bikes = instance(group, scooterGeometry(), plastic, scooters, "parked-scooters");
  if (bikes) {
    const colors = [0xd8d8d8, 0x2c2c30, 0xa8342a, 0x2f4f7a, 0x8d8f92, 0xb0343f, 0x35544a];
    const color = new THREE.Color();
    scooters.forEach((_, i) => bikes.setColorAt(i, color.set(colors[i % colors.length])));
    if (bikes.instanceColor) bikes.instanceColor.needsUpdate = true;
  }

  instance(group, binGeometry(), plastic, bins, "bins");
  instance(group, potGeometry(), plastic, pots, "pots");
  instance(group, transformerGeometry(), metalMaterial(0xffffff), transformers, "transformers");
  instance(group, hoardingGeometry(), painted, hoardings, "hoardings");
  instance(group, shelterGeometry(), painted, shelters, "bus-shelters");

  console.info(
    `[props] ${walls.length} wall runs, ${gates.length} gates, ${scooters.length} parked two-wheelers, ` +
    `${bins.length} bins, ${transformers.length} transformers, ${hoardings.length} hoardings, ${shelters.length} shelters`,
  );
  return group;
}
