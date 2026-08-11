import * as THREE from "three";

// Cel shading: a MeshToonMaterial reads its diffuse ramp from a gradient map.
// A 1D texture with N hard texels gives N flat bands. NearestFilter is the whole
// trick — LinearFilter here silently restores a smooth ramp and the look dies.
// Explicit band levels, not a curve. A mathematical ramp puts the darkest band
// near 0.45, which multiplied into an already-dark road colour crushes the
// whole lower half of the frame to near-black. The reference's shadow side stays
// clearly readable — it is a *tint* step, not an absence of light — so the floor
// is set high and the spread kept narrow.
const LEVELS = {
  2: [0.7, 1.0],
  3: [0.64, 0.84, 1.0],
};

export function bandRamp(steps = 3) {
  const levels = LEVELS[steps] || LEVELS[3];
  const data = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) {
    data[i] = Math.round(255 * levels[i]);
  }
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const RAMP_3 = bandRamp(3);
const RAMP_2 = bandRamp(2);

export const PALETTE = {
  // Bengaluru residential reality: cream, ochre, terracotta, mint, sky blue,
  // and a lot of bare concrete. Not the reference's Japanese white/grey.
  walls: [
    0xf2e7d5, 0xefe0c8, 0xe8d5bb, 0xdcc9ae, 0xf0ddd0,
    0xd9e2dd, 0xcfdbe0, 0xe6e9ea, 0xd6cfc4, 0xf5eee2,
    0xe3cdbd, 0xdcb9a4, 0xc9d6c4, 0xeadfd0,
  ],
  accentWalls: [0xd98b76, 0xc9756a, 0xe0a17f, 0x8fae9b, 0x9db6c9],
  roof: 0x9c8f86,
  roofTerrace: 0xc4b7a6,
  shopfront: 0xf7f2e8,
  road: {
    arterial: 0x6c6577,
    main: 0x726b7d,
    street: 0x7a7383,
    service: 0x827b8a,
    path: 0xa89f9a,
  },
  kerb: 0xb9b2b8,
  ground: 0xcfc8bd,
  grass: 0x9ab585,
  grassDark: 0x7f9d70,
  water: 0x8fb6c9,
  waterDeep: 0x6d99b2,
  bloom: [0xf4a9c4, 0xf7c0d4, 0xfbdce6, 0xea94b3],
  canopy: [0x74ab6b, 0x5d9459, 0x8cbd77, 0x4d7f4e],
  trunk: 0x5f4a44,
  sky: { top: 0x9dc3e0, horizon: 0xfbdfd2 },
  fog: 0xf3d9d2,
};

const cache = new Map();

export function toonMaterial(color, options = {}) {
  const { steps = 3, side = THREE.FrontSide, transparent = false, opacity = 1 } = options;
  const key = `${color}|${steps}|${side}|${transparent}|${opacity}`;
  if (cache.has(key)) return cache.get(key);
  const material = new THREE.MeshToonMaterial({
    color,
    gradientMap: steps === 2 ? RAMP_2 : RAMP_3,
    side,
    transparent,
    opacity,
  });
  cache.set(key, material);
  return material;
}

// Vertex-coloured variant, so thousands of merged buildings share one draw call
// while keeping per-building colour.
export function toonVertexMaterial(options = {}) {
  const { steps = 3, side = THREE.FrontSide } = options;
  return new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: steps === 2 ? RAMP_2 : RAMP_3,
    side,
  });
}

export function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

// MeshToonMaterial ignores `flatShading` entirely — it is not a property of the
// material, and Three logs a warning per instance. Faceting therefore has to be
// baked into the geometry: split shared vertices, then recompute normals so each
// triangle gets its own. Without this the blob foliage renders smooth and the
// whole low-poly read collapses.
export function facet(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.computeVertexNormals();
  if (flat !== geometry) geometry.dispose();
  return flat;
}
