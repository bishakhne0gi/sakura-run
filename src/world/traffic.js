import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { paintGeometry, paintedMaterial, metalMaterial } from "../render/materials.js";

// Traffic and pedestrians.
//
// No amount of material work makes an empty city look real — stillness is the
// tell. This module keeps a fixed population of agents alive *near the player*
// and recycles anything that gets far away, so 2 km² of road costs the same as
// one junction: ~70 vehicles and ~110 people, six instanced draw calls.
//
// The agents drive a real graph built from the OSM centrelines, on the correct
// (left-hand) side of the road, and turn at junctions. They do not avoid each
// other or the player — this is ambient life, not a traffic simulation, and
// pretending otherwise would be the wrong claim to make about it.

const LANE = 0.28;   // lane centre as a fraction of carriageway half-width
// Clothing palettes. Muted, warm, and never fully saturated — a painted crowd
// is dozens of quiet colours with one or two bright notes in it, not a bag of
// primaries. Pure black and pure white are deliberately absent: neither exists
// in these films, and both punch holes in a high-key frame.
const TROUSERS = [0x4d5670, 0x3f3c3e, 0x6b6153, 0x717788, 0x47594b, 0x8a7a66, 0x5c5566];

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- geometry

// mergeGeometries returns null — silently — the moment one input is indexed and
// another is not, and a null geometry throws once per frame inside the renderer
// and kills the loop. ExtrudeGeometry is non-indexed while boxes, spheres,
// cylinders and capsules are indexed, so every part is flattened to non-indexed
// here and the two can be mixed freely.
const flat = (geometry) => (geometry.index ? geometry.toNonIndexed() : geometry);

function box(w, h, d, color, x = 0, y = 0, z = 0, ry = 0) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  if (ry) geometry.rotateY(ry);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

function cylinder(r, h, color, x, y, z, axis = "x") {
  const geometry = new THREE.CylinderGeometry(r, r, h, 12);
  if (axis === "x") geometry.rotateZ(Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

// A box with every edge rounded off.
//
// This is the whole difference between the old traffic and this one. A painted
// frame has no hard edges in it — a bus in those films is a soft loaf with
// windows, an autorickshaw is a rounded shell. A BoxGeometry reads as a render
// no matter what colour you paint it, because real light never produces a
// perfectly sharp 90-degree highlight along a whole edge.
//
// Built as an extruded rounded rectangle with a bevel, which rounds the profile
// corners and both extruded faces in one geometry.
function soft(w, h, d, radius, color, x = 0, y = 0, z = 0, ry = 0) {
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
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 3,
    steps: 1,
  });
  // Extrusion runs 0..depth in z with the bevel proud of each end; recentre it.
  geometry.translate(0, 0, -depth / 2);
  if (ry) geometry.rotateY(ry);
  geometry.translate(x, y, z);
  geometry.computeVertexNormals();
  return paintGeometry(flat(geometry), color);
}

// A capsule standing on Y, hanging *below* its origin so the origin is a joint.
// Limbs in these films are soft tapered tubes, never rectangles.
function limb(radius, length, color, taper = 1) {
  const geometry = new THREE.CapsuleGeometry(radius, length, 3, 10);
  if (taper !== 1) {
    const pos = geometry.attributes.position;
    const total = length / 2 + radius;
    for (let i = 0; i < pos.count; i += 1) {
      // Narrow towards the far end: wrists are thinner than elbows.
      const t = (total - pos.getY(i)) / (total * 2);
      const k = 1 + (taper - 1) * Math.min(1, Math.max(0, t));
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
    geometry.computeVertexNormals();
  }
  geometry.translate(0, -(length / 2 + radius), 0);
  return paintGeometry(flat(geometry), color);
}

function ball(radius, color, x = 0, y = 0, z = 0, scale = [1, 1, 1]) {
  const geometry = new THREE.SphereGeometry(radius, 14, 10);
  geometry.scale(scale[0], scale[1], scale[2]);
  geometry.translate(x, y, z);
  return paintGeometry(flat(geometry), color);
}

// The autorickshaw. Three wheels, a canvas canopy, and the yellow-over-green
// Karnataka livery. Rounded hard: the real thing is a bulbous little shell and
// the boxy version read as a crate on wheels.
function autoGeometry() {
  const black = 0x2a2724;
  const yellow = 0xf0c24a;
  const green = 0x2f6b45;
  const parts = [
    soft(1.32, 0.66, 1.88, 0.26, green, 0, 0.62, 0),
    soft(1.28, 0.52, 1.46, 0.22, yellow, 0, 1.12, -0.05),
    soft(1.2, 0.66, 1.3, 0.26, black, 0, 1.62, -0.1),
    soft(1.24, 0.08, 1.92, 0.05, yellow, 0, 1.93, -0.05),
    // Nose cowl — the rounded snout is most of the silhouette.
    ball(0.42, yellow, 0, 1.02, 0.86, [1.35, 0.78, 0.8]),
    soft(0.86, 0.5, 0.08, 0.16, 0x3f5560, 0, 1.22, 0.9),
    cylinder(0.28, 0.16, black, 0, 0.28, 0.78),
    cylinder(0.3, 0.18, black, -0.62, 0.3, -0.72),
    cylinder(0.3, 0.18, black, 0.62, 0.3, -0.72),
    ball(0.09, 0xfff0c0, 0, 1.0, 0.98, [1, 1, 0.6]),
  ];
  return mergeGeometries(parts, false);
}

// Hatchback. Left white so an instance colour can paint it.
function carBodyGeometry() {
  const parts = [
    soft(1.72, 0.68, 3.94, 0.3, 0xffffff, 0, 0.62, 0),
    soft(1.56, 0.56, 2.06, 0.3, 0xffffff, 0, 1.16, -0.15),
    ball(0.5, 0xffffff, 0, 0.78, 1.62, [1.6, 0.72, 1.1]),   // rounded bonnet
    ball(0.5, 0xffffff, 0, 0.8, -1.6, [1.6, 0.75, 1.0]),    // rounded boot
  ];
  return mergeGeometries(parts, false);
}

function carTrimGeometry() {
  const black = 0x232122;
  const glass = 0x41565f;
  const parts = [
    cylinder(0.32, 0.2, black, -0.82, 0.32, 1.3),
    cylinder(0.32, 0.2, black, 0.82, 0.32, 1.3),
    cylinder(0.32, 0.2, black, -0.82, 0.32, -1.3),
    cylinder(0.32, 0.2, black, 0.82, 0.32, -1.3),
    soft(1.44, 0.46, 0.08, 0.14, glass, 0, 1.14, 0.9),
    soft(1.44, 0.42, 0.08, 0.14, glass, 0, 1.14, -1.18),
    soft(0.08, 0.4, 1.8, 0.1, glass, -0.77, 1.16, -0.15),
    soft(0.08, 0.4, 1.8, 0.1, glass, 0.77, 1.16, -0.15),
    ball(0.1, 0xfff2cf, -0.58, 0.74, 1.94, [1, 0.7, 0.6]),
    ball(0.1, 0xfff2cf, 0.58, 0.74, 1.94, [1, 0.7, 0.6]),
    ball(0.1, 0xc85a48, -0.6, 0.82, -1.94, [1, 0.6, 0.5]),
    ball(0.1, 0xc85a48, 0.6, 0.82, -1.94, [1, 0.6, 0.5]),
  ];
  return mergeGeometries(parts, false);
}

function scooterGeometry() {
  const skin = 0xd9a077;
  const parts = [
    soft(0.34, 0.44, 1.16, 0.16, 0xffffff, 0, 0.62, -0.05),
    soft(0.3, 0.14, 0.5, 0.07, 0x38332e, 0, 0.86, -0.4),
    ball(0.22, 0xffffff, 0, 0.78, 0.44, [0.8, 1.0, 0.9]),     // front apron
    cylinder(0.05, 0.5, 0x4a453f, 0, 1.02, 0.48, "y"),
    cylinder(0.03, 0.6, 0x4a453f, 0, 1.2, 0.5),
    cylinder(0.26, 0.1, 0x232122, 0, 0.26, 0.62),
    cylinder(0.26, 0.1, 0x232122, 0, 0.26, -0.62),
    // Rider — soft shapes, big helmet, same language as the pedestrians.
    limb(0.17, 0.24, 0x4a6484).translate(0, 1.52, -0.25),
    ball(0.15, 0xe8e2d6, 0, 1.66, -0.22, [1, 1.02, 1]),
    ball(0.05, skin, 0, 1.6, -0.08, [1, 1, 0.6]),
  ];
  return mergeGeometries(parts, false);
}

function busGeometry() {
  const glass = 0x41565f;
  const parts = [
    soft(2.48, 2.16, 9.3, 0.55, 0xffffff, 0, 1.36, 0),
    soft(2.5, 0.5, 8.9, 0.2, 0x3f76ad, 0, 2.16, 0),          // BMTC blue band
    // Domed roof: a flat lid is what made it read as a shipping container.
    ball(1.3, 0xffffff, 0, 2.24, 0, [0.95, 0.22, 3.55]),
    soft(2.2, 0.94, 0.1, 0.28, glass, 0, 1.94, 4.62),
    soft(0.08, 0.82, 7.2, 0.22, glass, -1.24, 1.98, -0.4),
    soft(0.08, 0.82, 7.2, 0.22, glass, 1.24, 1.98, -0.4),
    cylinder(0.48, 0.28, 0x232122, -1.1, 0.48, 3.1),
    cylinder(0.48, 0.28, 0x232122, 1.1, 0.48, 3.1),
    cylinder(0.48, 0.28, 0x232122, -1.1, 0.48, -3.1),
    cylinder(0.48, 0.28, 0x232122, 1.1, 0.48, -3.1),
    ball(0.14, 0xfff2cf, -0.9, 0.86, 4.66, [1, 0.8, 0.5]),
    ball(0.14, 0xfff2cf, 0.9, 0.86, 4.66, [1, 0.8, 0.5]),
  ];
  return mergeGeometries(parts, false);
}

// A person, in the proportions these films actually use.
//
// Two things carry the style, and neither is polygon count. The first is the
// head: around a sixth of total height rather than a seventh and a half, which
// is what makes a figure read as drawn rather than scanned. The second is that
// there are no flat planes anywhere — every mass is a capsule or a sphere, so
// the silhouette stays soft at any distance and the toon bands fall in curves
// instead of hard stripes.
//
// Every part is its own InstancedMesh: torso, head, two upper arms, two
// forearms, two thighs, two shins, two shoes. Twelve draw calls for the whole
// crowd, and each part gets its own matrix per person per frame, which is what
// buys the articulation.
//
// Segments hang *below* their origin so the origin is the joint: rotating the
// instance about X swings it from the shoulder, the elbow, the hip or the knee.
function personParts() {
  const skin = 0xdca57c;

  // Soft barrel, shoulders a little wider than the waist. Instance-tinted, so
  // it stays white here.
  const torsoBody = new THREE.CapsuleGeometry(0.16, 0.3, 3, 12);
  torsoBody.scale(1.06, 1, 0.74);
  torsoBody.translate(0, -0.24, 0);
  const torso = mergeGeometries([
    paintGeometry(flat(torsoBody), 0xffffff),
    ball(0.155, 0xffffff, 0, -0.03, 0, [1.16, 0.5, 0.8]),   // shoulder mass
    paintGeometry(flat(new THREE.CylinderGeometry(0.045, 0.052, 0.09, 10).translate(0, 0.1, 0)), skin),
  ], false);

  // The head. Deliberately large, slightly egg-shaped, with a soft hair cap
  // that overhangs at the back the way a drawn silhouette does.
  const head = mergeGeometries([
    ball(0.132, skin, 0, 0, 0, [1, 1.06, 0.95]),
    ball(0.138, 0x2e2622, 0, 0.022, -0.012, [1.02, 0.98, 1.04]),
    ball(0.1, 0x2e2622, 0, -0.03, -0.086, [1.0, 0.9, 0.7]),   // nape
  ], false);

  const upperArm = limb(0.046, 0.19, 0xffffff, 0.88);
  const foreArm = mergeGeometries([
    limb(0.04, 0.17, skin, 0.85),
    ball(0.048, skin, 0, -0.26, 0, [1, 0.9, 0.85]),           // hand
  ], false);
  const thigh = limb(0.066, 0.23, 0xffffff, 0.86);
  const shin = limb(0.052, 0.24, 0xffffff, 0.9);
  const shoe = mergeGeometries([
    soft(0.1, 0.07, 0.22, 0.034, 0x2b2723, 0, -0.035, 0.03),
  ], false);

  return { torso, head, upperArm, foreArm, thigh, shin, shoe };
}

const PART_KEYS = ["torso", "head", "armLU", "armRU", "armLF", "armRF", "legLU", "legRU", "legLS", "legRS", "shoeL", "shoeR"];
// Reused so the per-frame hide costs no allocation.
const hidden = new THREE.Matrix4();

const LIMB = { thigh: 0.35, shin: 0.34, upperArm: 0.27, hip: 0.86, shoulder: 1.38 };

// ---------------------------------------------------------------- graph

function buildGraph(world) {
  const nodes = new Map();       // key → { x, z, edges: [] }
  const edges = [];
  const key = (x, z) => `${Math.round(x / 4)},${Math.round(z / 4)}`;

  const node = (x, z) => {
    const k = key(x, z);
    if (!nodes.has(k)) nodes.set(k, { x, z, edges: [] });
    return nodes.get(k);
  };

  for (const road of world.roads) {
    if (road.kind === "path") continue;
    const speedLimit = road.kind === "arterial" ? 13 : road.kind === "main" ? 10 : 7;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 3) continue;
      const from = node(a[0], a[1]);
      const to = node(b[0], b[1]);
      const edge = {
        id: edges.length, from, to, length, speedLimit,
        width: road.width, kind: road.kind,
        dx: (b[0] - a[0]) / length, dz: (b[1] - a[1]) / length,
      };
      edges.push(edge);
      from.edges.push(edge);
      to.edges.push(edge);
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------- module

export class Traffic {
  constructor(world, options = {}) {
    const { vehicles = 64, people = 110, seed = 99, origin = null } = options;
    this.random = seeded(seed);
    this.graph = buildGraph(world);
    this.root = new THREE.Group();
    this.root.name = "traffic";
    if (!this.graph.edges.length) return;

    const bodyMaterial = paintedMaterial(0xffffff, { roughness: 0.42, metalness: 0.25, vertexColors: true });
    const flatMaterial = paintedMaterial(0xffffff, { roughness: 0.65, metalness: 0.1, vertexColors: true });

    // Mix chosen from what actually moves on an HSR street at 6 pm: mostly
    // two-wheelers, then cars, then autos, with the odd bus.
    // Downloaded vehicle models, when they are available, replace the procedural
    // car with the real thing. The fleet is data-driven, so each model simply
    // becomes its own entry sharing out the car's slice of the population — and
    // they arrive already textured, so no instance tinting.
    const models = options.vehicleModels ?? [];
    const carEntries = models.length
      ? models.map((m) => ({
          name: m.name, share: 0.34 * m.share, geometry: m.geometry,
          material: m.material, speed: m.speed, colored: false,
        }))
      : [{ name: "car", share: 0.34, geometry: carBodyGeometry(), trim: carTrimGeometry(), material: bodyMaterial, speed: 1.0, colored: true }];

    this.fleet = [
      { name: "scooter", share: 0.42, geometry: scooterGeometry(), material: bodyMaterial, speed: 1.0, colored: true },
      ...carEntries,
      { name: "auto", share: 0.2, geometry: autoGeometry(), material: flatMaterial, speed: 0.88, colored: false },
      { name: "bus", share: 0.04, geometry: busGeometry(), material: flatMaterial, speed: 0.7, colored: false, big: true },
    ];

    const carColors = [0xd8d8d8, 0x2c2c30, 0xb0342a, 0x2f4f7a, 0xa8a49a, 0xf0f0ea, 0x5a6b52, 0x8a1f2c];
    const color = new THREE.Color();
    this.agents = [];
    let assigned = 0;

    for (const type of this.fleet) {
      const count = type === this.fleet[this.fleet.length - 1]
        ? vehicles - assigned
        : Math.round(vehicles * type.share);
      assigned += count;
      if (count <= 0) continue;

      type.mesh = new THREE.InstancedMesh(type.geometry, type.material, count);
      type.mesh.castShadow = true;
      type.mesh.receiveShadow = true;
      type.mesh.name = `traffic-${type.name}`;
      type.mesh.frustumCulled = false;
      this.root.add(type.mesh);

      if (type.trim) {
        type.trimMesh = new THREE.InstancedMesh(type.trim, flatMaterial, count);
        type.trimMesh.castShadow = true;
        type.trimMesh.frustumCulled = false;
        type.trimMesh.name = `traffic-${type.name}-trim`;
        this.root.add(type.trimMesh);
      }

      for (let i = 0; i < count; i++) {
        // Seed around the player, not across the whole 2 km² graph. Spread over
        // the full city, 64 vehicles put roughly one car per two streets and the
        // road outside the spawn point stays empty for the first minute.
        const agent = origin
          ? this.spawn(type, i, origin.x, origin.z)
          : this.spawn(type, i, 0, 0, true);
        this.agents.push(agent);
        if (type.colored) {
          type.mesh.setColorAt(i, color.set(carColors[Math.floor(this.random() * carColors.length)]));
        }
      }
      if (type.mesh.instanceColor) type.mesh.instanceColor.needsUpdate = true;
    }

    // ---- pedestrians
    const parts = personParts();
    const skin = paintedMaterial(0xffffff, { roughness: 0.85, metalness: 0, vertexColors: true });
    this.people = {
      torso: new THREE.InstancedMesh(parts.torso, skin, people),
      head: new THREE.InstancedMesh(parts.head, skin, people),
      armLU: new THREE.InstancedMesh(parts.upperArm, skin, people),
      armRU: new THREE.InstancedMesh(parts.upperArm, skin, people),
      armLF: new THREE.InstancedMesh(parts.foreArm, skin, people),
      armRF: new THREE.InstancedMesh(parts.foreArm, skin, people),
      legLU: new THREE.InstancedMesh(parts.thigh, skin, people),
      legRU: new THREE.InstancedMesh(parts.thigh, skin, people),
      legLS: new THREE.InstancedMesh(parts.shin, skin, people),
      legRS: new THREE.InstancedMesh(parts.shin, skin, people),
      shoeL: new THREE.InstancedMesh(parts.shoe, skin, people),
      shoeR: new THREE.InstancedMesh(parts.shoe, skin, people),
    };
    const shirts = [
      0xd4685f, 0x5b83b0, 0xece5d6, 0x5c9e83, 0xe0b168, 0x8a76a6,
      0x4a4f5c, 0xf0d8dd, 0xc9773f, 0x7fa5ae, 0xb44f5e, 0xa8bf7e,
    ];
    for (const mesh of Object.values(this.people)) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
    this.crowd = null;   // optional skinned near-field crowd
    this.walkers = [];
    for (let i = 0; i < people; i++) {
      this.walkers.push(origin ? this.spawnWalker(origin.x, origin.z) : this.spawnWalker(0, 0, true));
      // The shirt tints the torso and upper arms, the trousers the legs, so a
      // crowd is not one uniform.
      const shirt = shirts[Math.floor(this.random() * shirts.length)];
      const legwear = TROUSERS[Math.floor(this.random() * TROUSERS.length)];
      for (const key of ["torso", "armLU", "armRU"]) this.people[key].setColorAt(i, color.set(shirt));
      for (const key of ["head", "armLF", "shoeL", "shoeR", "armRF"]) this.people[key].setColorAt(i, color.set(0xffffff));
      for (const key of ["legLU", "legRU", "legLS", "legRS"]) this.people[key].setColorAt(i, color.set(legwear));
    }
    for (const mesh of Object.values(this.people)) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.dummy = new THREE.Object3D();
  }

  randomEdge() {
    return this.graph.edges[Math.floor(this.random() * this.graph.edges.length)];
  }

  // Pick a road inside a ring around the player: close enough to be visible,
  // far enough that nothing pops into existence in front of the camera.
  edgeNear(x, z, min = 60, max = 260) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const edge = this.randomEdge();
      const d = Math.hypot(edge.from.x - x, edge.from.z - z);
      if (d > min && d < max) return edge;
    }
    return this.randomEdge();
  }

  spawn(type, index, x, z, initial = false) {
    const edge = initial ? this.randomEdge() : this.edgeNear(x, z);
    return {
      type, index, edge,
      forward: this.random() < 0.5,
      t: this.random() * edge.length,
      speed: edge.speedLimit * type.speed * (0.72 + this.random() * 0.45),
      lane: 1,
      bob: this.random() * 6.28,
    };
  }

  spawnWalker(x, z, initial = false) {
    const edge = initial ? this.randomEdge() : this.edgeNear(x, z, 20, 140);
    return {
      edge,
      forward: this.random() < 0.5,
      t: this.random() * edge.length,
      side: this.random() < 0.5 ? 1 : -1,
      speed: 1.1 + this.random() * 0.5,
      phase: this.random() * 6.28,
      height: 0.92 + this.random() * 0.18,
    };
  }

  // At a junction, continue onto a connected edge. Preferring roads of the same
  // class keeps traffic on the main grid instead of draining into every
  // cul-de-sac in the layout.
  advance(agent) {
    const node = agent.forward ? agent.edge.to : agent.edge.from;
    const options = node.edges.filter((e) => e !== agent.edge);
    if (!options.length) {
      agent.forward = !agent.forward;
      agent.t = agent.forward ? 0 : agent.edge.length;
      return;
    }
    const same = options.filter((e) => e.kind === agent.edge.kind);
    const pool = same.length && this.random() < 0.75 ? same : options;
    const next = pool[Math.floor(this.random() * pool.length)];
    agent.edge = next;
    agent.forward = Math.hypot(next.from.x - node.x, next.from.z - node.z) < 6;
    agent.t = agent.forward ? 0 : next.length;
    agent.speed = next.speedLimit * agent.type.speed * (0.72 + this.random() * 0.45);
  }

  update(dt, playerPosition) {
    if (!this.agents) return;
    const dummy = this.dummy;
    const px = playerPosition.x;
    const pz = playerPosition.z;

    for (const agent of this.agents) {
      agent.t += agent.speed * dt * (agent.forward ? 1 : -1);
      if (agent.t > agent.edge.length || agent.t < 0) this.advance(agent);

      const edge = agent.edge;
      const t = Math.max(0, Math.min(edge.length, agent.t));
      const dir = agent.forward ? 1 : -1;
      // Left-hand traffic: offset to the left of the direction of travel.
      const offset = edge.width * LANE * dir;
      const x = edge.from.x + edge.dx * t + -edge.dz * offset;
      const z = edge.from.z + edge.dz * t + edge.dx * offset;

      if (Math.hypot(x - px, z - pz) > 420) {
        const fresh = this.spawn(agent.type, agent.index, px, pz);
        Object.assign(agent, fresh);
        continue;
      }

      const heading = Math.atan2(edge.dx * dir, edge.dz * dir);
      agent.bob += dt * 9;
      dummy.position.set(x, Math.sin(agent.bob) * 0.012, z);
      dummy.rotation.set(0, heading, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      agent.type.mesh.setMatrixAt(agent.index, dummy.matrix);
      if (agent.type.trimMesh) agent.type.trimMesh.setMatrixAt(agent.index, dummy.matrix);
    }

    for (const type of this.fleet) {
      if (!type.mesh) continue;
      type.mesh.instanceMatrix.needsUpdate = true;
      if (type.trimMesh) type.trimMesh.instanceMatrix.needsUpdate = true;
    }

    // ---- pedestrians walk the footpath line, one step per 0.55 s
    this.crowd?.begin();
    this.walkers.forEach((walker, i) => {
      walker.t += walker.speed * dt * (walker.forward ? 1 : -1);
      if (walker.t > walker.edge.length || walker.t < 0) {
        const node = walker.forward ? walker.edge.to : walker.edge.from;
        const options = node.edges.filter((e) => e !== walker.edge);
        if (options.length && this.random() < 0.85) {
          walker.edge = options[Math.floor(this.random() * options.length)];
          walker.forward = Math.hypot(walker.edge.from.x - node.x, walker.edge.from.z - node.z) < 6;
          walker.t = walker.forward ? 0 : walker.edge.length;
        } else {
          walker.forward = !walker.forward;
          walker.t = Math.max(0, Math.min(walker.edge.length, walker.t));
        }
      }

      const edge = walker.edge;
      const t = Math.max(0, Math.min(edge.length, walker.t));
      const offset = (edge.width / 2 + 1.0) * walker.side;
      const x = edge.from.x + edge.dx * t + -edge.dz * offset;
      const z = edge.from.z + edge.dz * t + edge.dx * offset;

      if (Math.hypot(x - px, z - pz) > 220) {
        Object.assign(walker, this.spawnWalker(px, pz));
        return;
      }

      const dir = walker.forward ? 1 : -1;
      const heading = Math.atan2(edge.dx * dir, edge.dz * dir);
      walker.phase += dt * walker.speed * 3.1;
      const s = walker.height;

      // Near the camera, hand this walker to a real skinned character. The
      // instanced parts are collapsed to nothing for the frame rather than
      // skipped, because an InstancedMesh draws every slot it has — leaving the
      // matrix alone would leave a capsule figure standing inside the model.
      if (this.crowd?.offer(i, x, z, heading, walker.speed, Math.hypot(x - px, z - pz), s)) {
        hidden.makeScale(0, 0, 0);
        for (const key of PART_KEYS) this.people[key].setMatrixAt(i, hidden);
        return;
      }

      // The walk cycle. Thigh and upper arm swing on a sine; the knee and elbow
      // bend only on the *return* half of the stroke, which is what stops a
      // walk looking like a pair of scissors. The body rises and falls twice
      // per stride — once per footfall — and that bob is most of what reads as
      // weight.
      const swingL = Math.sin(walker.phase);
      const swingR = Math.sin(walker.phase + Math.PI);
      const bob = Math.abs(Math.sin(walker.phase)) * 0.035;
      const hipY = (LIMB.hip + bob) * s;
      const shoulderY = (LIMB.shoulder + bob) * s;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);

      const put = (mesh, lateral, forward, jointY, angle, spin = heading) => {
        dummy.position.set(x + cos * lateral * s - sin * forward, jointY, z - sin * lateral * s - cos * forward);
        dummy.rotation.set(0, spin, 0);
        dummy.rotateX(angle);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      };
      // Where a segment ends, given where it starts and how it is angled.
      // Chaining this keeps the shin on the knee and the shoe on the ankle
      // instead of letting them drift through the pavement.
      const endOf = (jointY, angle, length) => ({
        y: jointY - Math.cos(angle) * length * s,
        forward: Math.sin(angle) * length * s,
      });

      put(this.people.torso, 0, 0, hipY, swingL * 0.04);
      put(this.people.head, 0, 0, shoulderY + 0.22 * s, 0, heading + swingL * 0.1);

      for (const side of [-1, 1]) {
        const left = side < 0;
        const legSwing = (left ? swingL : swingR) * 0.62;
        const knee = Math.max(0, -(left ? Math.cos(walker.phase) : Math.cos(walker.phase + Math.PI))) * 1.15;
        const armSwing = (left ? swingR : swingL) * 0.48;     // arms oppose legs
        const elbow = Math.max(0, left ? -swingR : -swingL) * 0.5;
        const legX = side * 0.1;
        const armX = side * 0.235;

        put(left ? this.people.legLU : this.people.legRU, legX, 0, hipY, legSwing);
        const kneeAt = endOf(hipY, legSwing, LIMB.thigh);
        const shinAngle = legSwing - knee;
        put(left ? this.people.legLS : this.people.legRS, legX, kneeAt.forward, kneeAt.y, shinAngle);

        const ankleAt = endOf(kneeAt.y, shinAngle, LIMB.shin);
        put(left ? this.people.shoeL : this.people.shoeR, legX,
            kneeAt.forward + ankleAt.forward, Math.max(0.02 * s, ankleAt.y), shinAngle * 0.35);

        put(left ? this.people.armLU : this.people.armRU, armX, 0, shoulderY, armSwing);
        const elbowAt = endOf(shoulderY, armSwing, LIMB.upperArm);
        put(left ? this.people.armLF : this.people.armRF, armX, elbowAt.forward, elbowAt.y, armSwing + elbow);
      }
    });

    this.crowd?.end(dt);
    for (const mesh of Object.values(this.people)) mesh.instanceMatrix.needsUpdate = true;
  }
}
