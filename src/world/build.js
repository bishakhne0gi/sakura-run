import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE, toonMaterial, toonVertexMaterial, facet } from "../render/toon.js";

// Deterministic RNG so a given world.json always builds the identical city.
function makeRandom(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tmpColor = new THREE.Color();

function paintGeometry(geometry, hex) {
  tmpColor.set(hex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// ------------------------------------------------------------------ buildings

// Shapes are authored on XY and stood up with rotateX(-90°). That rotation maps
// shape-y to world -z, so feeding it (x, z) mirrors the whole city across the X
// axis — buildings and lakes land at -z while the hand-built roads and trees
// stay at +z, and the collider (which reads the source data) then disagrees with
// everything you can see. Pre-negate y, and reverse the ring to restore the
// winding that the negation flips.
function shapeFromPoints(points) {
  const shape = new THREE.Shape();
  const ring = points.slice().reverse();
  shape.moveTo(ring[0][0], -ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], -ring[i][1]);
  shape.closePath();
  return shape;
}

function buildingGeometry(building) {
  const geometry = new THREE.ExtrudeGeometry(shapeFromPoints(building.points), {
    depth: building.height,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function buildBuildings(world, random) {
  const wallChunks = [];
  const roofChunks = [];

  for (const building of world.buildings) {
    let geometry;
    try {
      geometry = buildingGeometry(building, random);
    } catch {
      continue; // degenerate footprint from OSM; skip rather than crash the city
    }

    const isShop = building.shopfront;
    const accent = random() < 0.16;
    const color = isShop
      ? PALETTE.shopfront
      : accent
        ? PALETTE.accentWalls[Math.floor(random() * PALETTE.accentWalls.length)]
        : PALETTE.walls[Math.floor(random() * PALETTE.walls.length)];
    wallChunks.push(paintGeometry(geometry, color));

    // A thin slab on top reads as the flat RCC terrace every HSR roof actually
    // is — without it the extrusion cap takes the wall colour and the skyline
    // goes mushy.
    const roof = buildingGeometry({ ...building, height: 0.45 }, random);
    roof.translate(0, building.height, 0);
    roofChunks.push(paintGeometry(roof, random() < 0.3 ? PALETTE.roofTerrace : PALETTE.roof));
  }

  const group = new THREE.Group();
  group.name = "buildings";
  const material = toonVertexMaterial({ steps: 3 });

  for (const [chunks, name] of [[wallChunks, "walls"], [roofChunks, "roofs"]]) {
    if (!chunks.length) continue;
    // Merge in batches: one 2,200-building buffer is fine to draw but painful
    // to build, and batching keeps peak memory sane during load.
    const BATCH = 400;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const merged = mergeGeometries(chunks.slice(i, i + BATCH), false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}-${i / BATCH}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  for (const chunk of [...wallChunks, ...roofChunks]) chunk.dispose();
  return group;
}

// ------------------------------------------------------------------ roads

// A road is a polyline; turn it into a quad strip with mitred joints so
// corners do not tear open at the tight angles of the HSR grid.
function ribbonGeometry(points, width, lift) {
  const half = width / 2;
  const positions = [];
  const indices = [];
  const normals = [];

  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const nx = -dz;
    const nz = dx;
    left.push([points[i][0] + nx * half, points[i][1] + nz * half]);
    right.push([points[i][0] - nx * half, points[i][1] - nz * half]);
  }

  for (let i = 0; i < points.length; i++) {
    positions.push(left[i][0], lift, left[i][1]);
    positions.push(right[i][0], lift, right[i][1]);
    normals.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function buildRoads(world) {
  const group = new THREE.Group();
  group.name = "roads";
  const byKind = new Map();

  for (const road of world.roads) {
    const lift = road.kind === "path" ? 0.045 : 0.03;
    const geometry = ribbonGeometry(road.points, road.width, lift);
    paintGeometry(geometry, PALETTE.road[road.kind] || PALETTE.road.street);
    if (!byKind.has(road.kind)) byKind.set(road.kind, []);
    byKind.get(road.kind).push(geometry);

    // Kerb strip alongside anything a vehicle uses.
    if (road.kind !== "path" && road.kind !== "service") {
      const kerb = ribbonGeometry(road.points, road.width + 3.2, 0.012);
      paintGeometry(kerb, PALETTE.kerb);
      if (!byKind.has("kerb")) byKind.set("kerb", []);
      byKind.get("kerb").push(kerb);
    }
  }

  const material = toonVertexMaterial({ steps: 2, side: THREE.DoubleSide });
  for (const [kind, chunks] of byKind) {
    const merged = mergeGeometries(chunks, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `road-${kind}`;
    mesh.receiveShadow = true;
    // Kerbs sit under the carriageway; render them first.
    mesh.renderOrder = kind === "kerb" ? -1 : 0;
    group.add(mesh);
    for (const chunk of chunks) chunk.dispose();
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
  return geometry;
}

function buildSurfaces(world) {
  const group = new THREE.Group();
  group.name = "surfaces";

  const greenChunks = [];
  for (const patch of world.green) {
    try {
      const geometry = polygonGeometry(patch.points, 0.02);
      paintGeometry(geometry, patch.area > 4000 ? PALETTE.grassDark : PALETTE.grass);
      greenChunks.push(geometry);
    } catch { /* skip malformed ring */ }
  }
  if (greenChunks.length) {
    const merged = mergeGeometries(greenChunks, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, toonVertexMaterial({ steps: 2, side: THREE.DoubleSide }));
      mesh.name = "green";
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const chunk of greenChunks) chunk.dispose();
  }

  // Water sits *above* the green layer, not below it. OSM maps Agara Lake Park
  // as a leisure=park polygon covering the whole lake, so a physically-correct
  // sunken water plane is completely hidden by the park it belongs to — the
  // lake renders as a field of grass.
  const waterChunks = [];
  for (const body of world.water) {
    try {
      waterChunks.push(polygonGeometry(body.points, 0.08));
    } catch { /* skip */ }
  }
  if (waterChunks.length) {
    const merged = mergeGeometries(waterChunks, false);
    if (merged) {
      const mesh = new THREE.Mesh(
        merged,
        toonMaterial(PALETTE.water, { steps: 2, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
      );
      mesh.name = "water";
      group.add(mesh);
    }
    for (const chunk of waterChunks) chunk.dispose();
  }

  // Ground plane under everything so gaps between polygons never show sky.
  const [minX, minZ, maxX, maxZ] = world.bounds;
  const pad = 400;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(maxX - minX + pad * 2, maxZ - minZ + pad * 2),
    toonMaterial(PALETTE.ground, { steps: 2 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((minX + maxX) / 2, -0.02, (minZ + maxZ) / 2);
  ground.receiveShadow = true;
  ground.name = "ground";
  group.add(ground);

  return group;
}

// ------------------------------------------------------------------ trees

// Blob canopies: a low-detail icosahedron, deformed once per species and
// instanced 7,500 times. The reference's foliage is faceted, not smooth, so
// flatShading and a low subdivision are the point rather than a compromise.
function canopyGeometry(radius, detail, random, squash) {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.attributes.position;

  // IcosahedronGeometry is already non-indexed: a corner shared by five faces
  // exists five times in the buffer. Drawing a fresh random number per vertex
  // therefore pulls those copies apart and the blob renders as a spiky star.
  // Key the displacement off the vertex position so every copy of a corner
  // agrees, and the surface stays closed.
  const wobbleFor = new Map();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let wobble = wobbleFor.get(key);
    if (wobble === undefined) {
      wobble = 0.8 + random() * 0.4;
      wobbleFor.set(key, wobble);
    }
    position.setXYZ(i, x * wobble, y * wobble * squash, z * wobble);
  }
  position.needsUpdate = true;
  return facet(geometry);
}

// Lowest a canopy may hang. Above eye height on foot (1.62 m) and above the
// chase camera, with room for an auto to pass under.
const CANOPY_CLEARANCE = 3.4;

function buildTrees(world, random) {
  const group = new THREE.Group();
  group.name = "trees";

  const species = {
    tabebuia: { colors: PALETTE.bloom, squash: 0.82, radius: 3.1, trunkHeight: 3.4, trunkRadius: 0.22 },
    canopy: { colors: PALETTE.canopy, squash: 0.95, radius: 3.4, trunkHeight: 3.0, trunkRadius: 0.26 },
  };

  const buckets = { tabebuia: [], canopy: [] };
  for (const tree of world.trees) buckets[tree.s]?.push(tree);

  const dummy = new THREE.Object3D();

  for (const [name, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    const spec = species[name];

    // Three blob variants per species, so an avenue does not read as a
    // stamped repeat, still at three draw calls instead of thousands.
    const VARIANTS = 3;
    const perVariant = Math.ceil(list.length / VARIANTS);
    for (let v = 0; v < VARIANTS; v++) {
      const slice = list.slice(v * perVariant, (v + 1) * perVariant);
      if (!slice.length) continue;

      const canopy = canopyGeometry(spec.radius, 1, random, spec.squash);
      const material = toonMaterial(spec.colors[v % spec.colors.length], { steps: 3 });
      const mesh = new THREE.InstancedMesh(canopy, material, slice.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `canopy-${name}-${v}`;

      const trunkGeometry = new THREE.CylinderGeometry(
        spec.trunkRadius * 0.7, spec.trunkRadius, spec.trunkHeight, 5,
      );
      trunkGeometry.translate(0, spec.trunkHeight / 2, 0);
      const trunks = new THREE.InstancedMesh(
        trunkGeometry,
        toonMaterial(PALETTE.trunk, { steps: 2 }),
        slice.length,
      );
      trunks.castShadow = true;
      trunks.name = `trunk-${name}-${v}`;

      slice.forEach((tree, i) => {
        const scale = tree.h;
        const spin = random() * Math.PI * 2;

        // Clear head height with margin. The canopy vertices are wobbled by up
        // to 1.22x during generation, so sizing the lift from the nominal
        // radius leaves the tallest variants hanging in the player's face —
        // which reads as red shards across the sky rather than as a tree.
        const reach = spec.radius * spec.squash * scale * 1.25;
        const canopyY = Math.max(CANOPY_CLEARANCE + reach, spec.trunkHeight * scale + reach * 0.6);

        dummy.position.set(tree.p[0], canopyY, tree.p[1]);
        dummy.rotation.set(0, spin, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // Stretch the trunk to meet whatever height the canopy landed at.
        dummy.position.set(tree.p[0], 0, tree.p[1]);
        dummy.rotation.set(0, spin, 0);
        dummy.scale.set(scale, canopyY / spec.trunkHeight, scale);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      trunks.instanceMatrix.needsUpdate = true;
      group.add(mesh, trunks);
    }
  }
  return group;
}

// ------------------------------------------------------------------ street kit

// The props that sell "Bengaluru" rather than "generic city": compound walls
// with gates, overhead cable runs, and streetlights.
function buildStreetKit(world, random) {
  const group = new THREE.Group();
  group.name = "streetkit";
  const dummy = new THREE.Object3D();

  // Streetlights along lit arterials.
  const poles = [];
  for (const road of world.roads) {
    if (road.kind !== "arterial" && road.kind !== "main") continue;
    for (let i = 1; i < road.points.length; i++) {
      const [ax, az] = road.points[i - 1];
      const [bx, bz] = road.points[i];
      const segment = Math.hypot(bx - ax, bz - az);
      if (segment < 4) continue;
      const nx = -(bz - az) / segment;
      const nz = (bx - ax) / segment;
      for (let d = 0; d < segment; d += 34) {
        const t = d / segment;
        const side = random() < 0.5 ? 1 : -1;
        poles.push([
          ax + (bx - ax) * t + nx * side * (road.width / 2 + 0.8),
          az + (bz - az) * t + nz * side * (road.width / 2 + 0.8),
        ]);
      }
    }
  }
  if (poles.length) {
    const poleGeometry = new THREE.CylinderGeometry(0.09, 0.13, 7.5, 5);
    poleGeometry.translate(0, 3.75, 0);
    const mesh = new THREE.InstancedMesh(poleGeometry, toonMaterial(0x8d8a92, { steps: 2 }), poles.length);
    mesh.castShadow = true;
    poles.forEach(([x, z], i) => {
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, random() * 0.2, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = "streetlights";
    group.add(mesh);
  }

  return group;
}

// ------------------------------------------------------------------ entry

export function buildWorld(world) {
  const random = makeRandom(0x5a4b3c);
  const root = new THREE.Group();
  root.name = "hsr";
  root.add(buildSurfaces(world));
  root.add(buildRoads(world));
  root.add(buildBuildings(world, random));
  root.add(buildTrees(world, random));
  root.add(buildStreetKit(world, random));
  return root;
}
