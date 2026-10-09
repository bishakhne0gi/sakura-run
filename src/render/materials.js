import * as THREE from "three";
import {
  facadeCanvas, shopfrontCanvas, roadCanvas, grassCanvas, dirtCanvas,
  concreteCanvas, barkCanvas, leafCanvas, waterNormalCanvas, zebraCanvas, lightPoolCanvas,
  signAtlasCanvas, tileRoofCanvas, paintedKerbCanvas, humpCanvas, FACADE_VARIANTS, SHOP_VARIANTS, SIGNS_PER_ATLAS, SIGN_COLS, SIGN_ROWS,
  texture, normalTexture, greyTexture, alphaTexture, setFlatTextures,
} from "./textures.js";

export { FACADE_VARIANTS, SHOP_VARIANTS, SIGNS_PER_ATLAS, SIGN_COLS, SIGN_ROWS };

// The move from MeshToonMaterial to MeshStandardMaterial is the single change
// that separates "diagram of a city" from "photograph of one". Toon shading
// throws away the two things the eye uses to judge material: the roughness of
// the highlight, and what the surface reflects. A standard material lit by a
// real sun and an environment map gets both for free.
//
// Everything here is tinted by vertex colour, so thousands of buildings with
// different paint still merge into one draw call.

export const PALETTE = {
  // Measured off HSR Layout streets: cream and ochre dominate, with mint,
  // sky-blue and bare concrete filling in.
  walls: [
    0xf2e7d5, 0xefe0c8, 0xe8d5bb, 0xdcc9ae, 0xf0ddd0,
    0xd9e2dd, 0xcfdbe0, 0xe6e9ea, 0xd6cfc4, 0xf5eee2,
    0xe3cdbd, 0xdcb9a4, 0xc9d6c4, 0xeadfd0,
  ],
  accentWalls: [0xd98b76, 0xc9756a, 0xe0a17f, 0x8fae9b, 0x9db6c9],
  roof: 0xc9c1b6,
  roofTerrace: 0xdcd2c2,
  parapet: 0xd8d0c2,
  shopfront: 0xf7f2e8,
  road: {
    arterial: 0xffffff,
    main: 0xffffff,
    street: 0xffffff,
    service: 0xf0eeec,
    path: 0xffffff,
  },
  kerb: 0xd5cfc6,
  ground: 0xcfc8bd,
  grass: 0x8fae7c,
  grassDark: 0x7a9669,
  water: 0x17323d,
  bloom: [0xf7b3ce, 0xfbc9dd, 0xffd9e8, 0xef9dbd],
  canopy: [0x5f8f52, 0x4e7c48, 0x74a25e, 0x3f6b41],
  trunk: 0x5c4a3f,
  fog: 0xdcd0cb,
  // Sintex water tank. The real thing is black, and 9,490 of them are scattered
  // one or two to a roof across HSR — which at 0x1c1c1e read from the air as
  // black boxes punched through every rooftop, especially against a high-key
  // painted frame where nothing else is remotely that dark. Lifted to the value
  // a black plastic tank actually presents in daylight, which is a dark warm
  // grey with a sheen, not a hole.
  tank: 0x4d4a52,
  tankWhite: 0xe3e0d8,
};

const cache = new Map();
function memo(key, make) {
  if (!cache.has(key)) cache.set(key, make(STYLE));
  return cache.get(key);
}

// ---------------------------------------------------------------- style
//
// Two lighting models over the same artwork. The textures, the signage, the
// facade variants and the geometry are identical in both — what changes is how
// light lands on them. That is the honest way to do a style switch: an anime
// frame is not a photograph with a filter, it is the same world with the
// shading quantised, the palette lifted and the silhouettes drawn.
//
// MeshToonMaterial reads its diffuse ramp from a gradient map. A 1D texture of
// N hard texels gives N flat bands, and NearestFilter is the whole trick —
// LinearFilter silently restores a smooth ramp and the look dies.

export let STYLE = "anime";

let RAMP = null;
export function bandRamp() {
  if (RAMP) return RAMP;
  // Three bands, floor held high. A mathematically even ramp puts the darkest
  // band near 0.33, which multiplied into an already-dark road crushes the
  // lower half of the frame to black. In the reference the shadow side is a
  // *tint* step, not an absence of light — the difference between a cel frame
  // and a 3D render with the lights turned down.
  const levels = [0.74, 0.89, 1.0];
  const data = new Uint8Array(levels.map((v) => Math.round(v * 255)));
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  RAMP = texture;
  return texture;
}

// One surface factory for both styles. Toon has no roughness, metalness or
// environment map, so those are dropped rather than silently ignored.
//
// `lit: "flat"` opts a material out of toon shading and into Lambert. Small
// instanced objects — vehicles, bins, gates, poles — went solid black through
// MeshToonMaterial here whenever they were instanced, in the same way the
// foliage did, while identically-built merged meshes were fine. Lambert is one
// band of shading rather than three, which on a two-metre object is a
// difference nobody can see, and it renders. Buildings, roads and ground keep
// the toon ramp, which is where the banding actually reads.
function surface(params) {
  const { lit, ...rest0 } = params;
  params = rest0;
  if (STYLE !== "anime") return new THREE.MeshStandardMaterial(params);
  if (lit === "flat") {
    const { roughness, metalness, roughnessMap, envMap, envMapIntensity, ...keep } = params;
    return new THREE.MeshLambertMaterial(keep);
  }
  const {
    roughness, metalness, roughnessMap, envMap, envMapIntensity, normalScale,
    ...rest
  } = params;
  const toon = new THREE.MeshToonMaterial({ ...rest, gradientMap: bandRamp() });
  // Keep the normal map but ease it off: cel shading with a strong normal map
  // reads as noise, because the bands break up across every bump.
  if (normalScale && toon.normalScale) toon.normalScale.copy(normalScale).multiplyScalar(0.45);
  return toon;
}

export function setStyle(name) {
  STYLE = name === "anime" ? "anime" : "real";
  setFlatTextures(STYLE === "anime");
  // Materials are memoised per style, so the whole cache is invalid.
  for (const material of cache.values()) material.dispose?.();
  cache.clear();
  signMaterials.clear();
  _waterNormal = null;
  return STYLE;
}

// ---------------------------------------------------------------- buildings

// Upper storeys, one material per facade variant. `repeat` is left at 1 and the
// UVs carry real metres, so one tile is one 3.2 m storey regardless of how tall
// the block is. Twelve variants is twelve draw calls — the price of a city
// where neighbours do not share an elevation.
export function facadeMaterial(variant = 0) {
  const v = ((variant % FACADE_VARIANTS) + FACADE_VARIANTS) % FACADE_VARIANTS;
  return memo(`facade:${v}`, () => surface({
    map: texture(`facade:${v}`, () => facadeCanvas(v)),
    normalMap: normalTexture(`facade:${v}`, () => facadeCanvas(v), 1.1),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: greyTexture(`facade:${v}`, () => facadeCanvas(v), { invert: true, low: 0.45, high: 0.98 }),
    roughness: 0.92,
    metalness: 0.02,
    vertexColors: true,
  }));
}

export function shopfrontMaterial(variant = 0) {
  const v = ((variant % SHOP_VARIANTS) + SHOP_VARIANTS) % SHOP_VARIANTS;
  return memo(`shopfront:${v}`, () => surface({
    map: texture(`shopfront:${v}`, () => shopfrontCanvas(v)),
    // The signboard and the glazing are the two things that stay lit after
    // dark on an Indian high street. Driving emissive from a masked copy of the
    // same drawing means the light comes out of the board and the shutters stay
    // dark, with no second texture to keep in register.
    emissiveMap: texture(`shopfront:${v}:lit`, () => shopfrontCanvas(v, true)),
    emissive: 0xffffff,
    emissiveIntensity: 0,
    normalMap: normalTexture(`shopfront:${v}`, () => shopfrontCanvas(v), 1.0),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: greyTexture(`shopfront:${v}`, () => shopfrontCanvas(v), { invert: true, low: 0.3, high: 0.95 }),
    roughness: 0.8,
    metalness: 0.05,
    vertexColors: true,
  }));
}

// ---------------------------------------------------------------- signage

// Real business names off the OSM tags, packed 16 to an atlas. Returns the
// material for atlas `index`; the caller supplies UVs into the right cell.
const signMaterials = new Map();
export function signMaterial(index, entries) {
  if (!signMaterials.has(index)) {
    const map = new THREE.CanvasTexture(signAtlasCanvas(entries));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    map.needsUpdate = true;
    const material = surface({
      map,
      emissiveMap: map,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      roughness: 0.62,
      metalness: 0.05,
      // Front faces only. A double-sided sign shows its own text mirrored from
      // behind, which is what made shop names across the street read backwards.
      // Wall-mounted plates have their backs inside the building; blade signs
      // carry a genuine second face built for the purpose.
      side: THREE.FrontSide,
    });
    signMaterials.set(index, material);
  }
  return signMaterials.get(index);
}

function setSignGlow(amount) {
  for (const material of signMaterials.values()) material.emissiveIntensity = amount * 1.4;
}

export function roofMaterial() {
  return memo("roof", () => surface({
    map: texture("roofslab", () => concreteCanvas(44)),
    normalMap: normalTexture("roofslab", () => concreteCanvas(44), 0.8),
    roughness: 0.96,
    metalness: 0,
    vertexColors: true,
  }));
}

export function tileRoofMaterial() {
  return memo("tileroof", () => surface({
    map: texture("tileroof", tileRoofCanvas),
    normalMap: normalTexture("tileroof", tileRoofCanvas, 1.5),
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
    // Tinted per building from the imagery: the tile map carries the pantile
    // pattern, the vertex colour carries what colour that roof actually is.
    vertexColors: true,
  }));
}

export function concreteMaterial(color = 0xffffff, opts = {}) {
  return memo(`concrete:${color}:${JSON.stringify(opts)}`, () => surface({
    color,
    map: texture("concrete", () => concreteCanvas(51)),
    normalMap: normalTexture("concrete", () => concreteCanvas(51), 0.7),
    roughness: 0.94,
    metalness: 0,
    ...opts,
  }));
}

// ---------------------------------------------------------------- ground

export function roadMaterial(kind) {
  return memo(`road:${kind}`, () => surface({
    map: texture(`road:${kind}`, () => roadCanvas(kind, 5 + kind.length)),
    normalMap: normalTexture(`road:${kind}`, () => roadCanvas(kind, 5 + kind.length), 0.9),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: greyTexture(`road:${kind}`, () => roadCanvas(kind, 5 + kind.length), { low: 0.55, high: 1 }),
    roughness: 0.88,
    metalness: 0.0,
    vertexColors: true,
    side: THREE.DoubleSide,
  }));
}

export function paintedKerbMaterial() {
  return memo("paintedkerb", () => surface({
    map: texture("paintedkerb", paintedKerbCanvas),
    normalMap: normalTexture("paintedkerb", paintedKerbCanvas, 0.6),
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
  }));
}

export function humpMaterial() {
  return memo("hump", () => surface({
    map: texture("hump", humpCanvas),
    roughness: 0.85,
    metalness: 0,
  }));
}

export function zebraMaterial() {
  return memo("zebra", () => surface({
    map: alphaTexture("zebra", zebraCanvas),
    transparent: true,
    depthWrite: false,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
}

export function grassMaterial(dark = false) {
  return memo(`grass:${dark}`, () => surface({
    map: texture(dark ? "grassDark" : "grass", () => grassCanvas(dark ? 22 : 21, dark ? "#75906a" : "#8aa878")),
    normalMap: normalTexture("grass", () => grassCanvas(21, "#8aa878"), 0.6),
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    side: THREE.DoubleSide,
  }));
}

// The plane under everything. It shows in two places: beyond the extract, and
// in the gaps between a carriageway and the building line — which in HSR are
// unpaved forecourts and parking, not lawn. Tinted dusty rather than green:
// scrub green reads as a dark hole beside every plot at low sun.
export function dirtMaterial() {
  return memo("dirt", () => surface({
    color: 0xa89d8c,
    map: texture("dirt", dirtCanvas),
    normalMap: normalTexture("dirt", dirtCanvas, 0.8),
    roughness: 1,
    metalness: 0,
  }));
}

// ---------------------------------------------------------------- trees

export function barkMaterial() {
  return memo("bark", () => {
    // The trunk cylinder is a unit tall and scaled to 8 m at instance time, so
    // its v runs 0..1 over the whole trunk: one bark tile stretched into
    // vertical smears. Repeat in both axes to put the grain back at real scale.
    const map = texture("bark", barkCanvas);
    const normal = normalTexture("bark", barkCanvas, 1.6);
    map.repeat.set(3, 9);
    normal.repeat.set(3, 9);
    return surface({
      map,
      normalMap: normal,
      roughness: 1,
      metalness: 0,
    });
  });
}

// alphaTest, not transparent: an alpha-tested card still writes depth, so ten
// thousand of them sort correctly against each other with no per-frame sorting
// and no blend-order artefacts. Transparency here would cost more than the
// trees themselves.
export function foliageMaterial(kind) {
  return memo(`foliage:${kind}`, () => {
    const colors = kind === "tabebuia"
      ? ["#f9b9d2", "#fcd0e0", "#f49cbd", "#ffe3ee", "#e88bb0"]
      : ["#5d8c50", "#4a7743", "#6fa05c", "#3d6a3e", "#82b167"];

    // Foliage is unlit in the painted style, deliberately, and it is the one
    // material that opts out of the shared surface() factory.
    //
    // Two reasons. The honest one first: alpha-tested instanced cards through
    // MeshToonMaterial rendered solid black here — same map, same instance
    // colours and same setup as the green canopies that rendered correctly, so
    // this is a fault in that path rather than in the data, and chasing it
    // further was not worth the frame. The better reason: the reference's
    // canopies *are* flat. A cel background paints a tree as one or two values
    // of colour with the light baked in, not as a lit surface — so an unlit
    // material with the shading already in the texture is not a workaround
    // here, it is the correct choice. Instance colour still varies each tree.
    if (STYLE === "anime") {
      return new THREE.MeshBasicMaterial({
        map: alphaTexture(`leaf:${kind}`, () => leafCanvas(colors, kind === "tabebuia" ? 66 : 67)),
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        toneMapped: true,
      });
    }

    return surface({
      map: alphaTexture(`leaf:${kind}`, () => leafCanvas(colors, kind === "tabebuia" ? 66 : 67)),
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
      // No vertexColors here: the cards carry no colour attribute, and a
      // standard material with vertexColors on and the attribute missing
      // multiplies by (0,0,0) — every canopy in the city renders black. The
      // per-tree tint comes from InstancedMesh.setColorAt instead.
    });
  });
}

// ---------------------------------------------------------------- water

// A real water shader rather than a tinted plane: two normal maps scrolling
// against each other, a Fresnel term that reflects the sky at grazing angles,
// and a sun specular. Agara Lake is a landmark — it has to behave like water.
export function waterMaterial(env) {
  return memo("water", () => {
    const normals = waterNormal();
    const material = new THREE.MeshStandardMaterial({
      color: PALETTE.water,
      // Dielectric, not metal. Water is a dielectric with F0 ≈ 0.02: its
      // reflection is Fresnel-weighted, near-total at grazing angles and weak
      // looking straight down. metalness tints the reflection by the base
      // colour and kills that entirely — a metal lake is always the colour of
      // the lake, never the colour of the sky.
      // Grazing-angle reflection off water really is near-total, but at
      // exposure 1.05 with bloom on top it clips the lake to a white sheet.
      // Blurring the reflection slightly keeps the Fresnel behaviour and puts
      // the highlight back inside the range the tone mapper can hold.
      roughness: 0.16,
      metalness: 0,
      normalMap: normals,
      normalScale: new THREE.Vector2(0.28, 0.28),
      envMap: env || null,
      envMapIntensity: 1.0,
      transparent: true,
      opacity: 0.94,
    });
    material.userData.scroll = normals;
    return material;
  });
}

let _waterNormal = null;
function waterNormal() {
  if (!_waterNormal) {
    _waterNormal = normalTexture("water", waterNormalCanvas, 1);
    // The lake polygon carries UVs in metres/8, so this is one ripple tile per
    // ~5 m. At the 60× it started on, each ripple was 13 cm across — sub-pixel
    // beyond a few metres, which reads as a dead mirror rather than water.
    _waterNormal.repeat.set(1.6, 1.6);
  }
  return _waterNormal;
}

export function tickWater(dt) {
  const normals = _waterNormal;
  if (!normals) return;
  normals.offset.x += dt * 0.006;
  normals.offset.y += dt * 0.0035;
}

// ---------------------------------------------------------------- misc kit

export function paintedMaterial(color, { roughness = 0.7, metalness = 0.1, ...rest } = {}) {
  return memo(`painted:${color}:${roughness}:${metalness}:${JSON.stringify(rest)}`, () =>
    surface({ color, roughness, metalness, lit: "flat", ...rest }));
}

export function metalMaterial(color = 0x8d8a92) {
  return memo(`metal:${color}`, () => surface({
    color, roughness: 0.42, metalness: 0.85, lit: "flat",
  }));
}

export function glassMaterial() {
  return memo("glass", () => new THREE.MeshStandardMaterial({
    color: 0x2b3742, roughness: 0.08, metalness: 0.4,
    transparent: true, opacity: 0.72,
  }));
}

// Emissive signage / lit windows after dark. Intensity is driven from the
// daylight preset so shops do not glow at noon.
export function emissiveMaterial(color, intensity = 1) {
  return memo(`emissive:${color}`, () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, emissive: color, emissiveIntensity: intensity, roughness: 0.6,
  }));
}

// Shopfront glow and lamp pools come up together at dusk.
export function setShopGlow(amount) {
  for (let v = 0; v < SHOP_VARIANTS; v++) {
    const material = cache.get(`shopfront:${v}`);
    if (material) material.emissiveIntensity = amount * 1.6;
  }
  setSignGlow(amount);
}

export function lightPoolMaterial() {
  return memo("lightpool", () => new THREE.MeshBasicMaterial({
    map: alphaTexture("lightpool", lightPoolCanvas),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  }));
}

export function setEnvironment(env) {
  for (const material of cache.values()) {
    if (material.isMeshStandardMaterial && material.envMap !== undefined) {
      material.envMap = env;
      material.needsUpdate = true;
    }
  }
}

// Satellite colour -> painted colour.
//
// The roof colours in world.json are medians of real Esri imagery pixels, which
// is what makes the city read as *this* city from the air. Used raw they are
// also muddy, low-contrast and full of half-tones — a photograph's colour, not
// a painting's. So they are pushed the way a background artist pushes a
// reference photo: saturation up, value up, and both quantised to a small
// number of steps so neighbouring roofs land on the *same* colour often enough
// to read as a palette rather than as noise. Hue is kept — that is the part
// carrying the real information.
const _satColor = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

export function paintedFromSatellite(rgb, anime = true) {
  _satColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  _satColor.getHSL(_hsl);
  let { h, s, l } = _hsl;

  // Green means a tree is standing over the roof, not that the roof is green.
  // Swing it to the neighbourhood's ordinary weathered concrete instead.
  if (h > 0.19 && h < 0.46 && s > 0.12) {
    h = 0.09;
    s *= 0.35;
    l = Math.max(l, 0.5);
  }

  if (!anime) {
    _satColor.setHSL(h, Math.min(1, s * 1.15), THREE.MathUtils.clamp(l * 1.05, 0.08, 0.95));
    return _satColor.getHex();
  }

  const step = (v, n) => Math.round(v * n) / n;
  s = step(Math.min(0.62, s * 2.1 + 0.05), 5);
  l = step(THREE.MathUtils.clamp(l * 1.18 + 0.1, 0.34, 0.9), 7);
  _satColor.setHSL(step(h, 24), s, l);
  return _satColor.getHex();
}

// Wall colour, derived from that building's own roof reading.
//
// Satellite imagery is nadir: it sees roofs and never walls, so a wall colour
// cannot be photographed from it. What it can do is stop the wall being
// arbitrary. A plot whose roof photographs warm terracotta is a plot with warm
// paint on it; one whose terrace photographs cool grey is a newer block in the
// pale greys and whites that go with it. Same hue family, lifted to a wall
// value. It is reasoning from real data about *this* building rather than a
// hash — which is the difference between a city of specific buildings and a
// city of random ones. It is not a photograph of the wall, and is not claimed
// to be.
export function wallFromRoof(rgb, anime = true) {
  _satColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  _satColor.getHSL(_hsl);
  let { h, s } = _hsl;
  if (h > 0.19 && h < 0.46 && s > 0.12) { h = 0.1; s = 0.18; }   // canopy, not a green wall
  const step = (v, n) => Math.round(v * n) / n;
  // Walls are painted: brighter and less saturated than the weathered surface
  // above them, and quantised hard so a street reads as a palette.
  const sat = step(THREE.MathUtils.clamp(s * (anime ? 0.85 : 0.6) + 0.05, 0.05, 0.34), 5);
  // Lightness has to come from the building too. Fixing it at one value made
  // every wall in the layout the same brightness — more uniform than the hash
  // it replaced. A darker surface above means an older, deeper-painted block; a
  // bright terrace means a newer white one.
  const light = step(THREE.MathUtils.clamp(0.56 + _hsl.l * 0.42, 0.5, 0.92), 7);
  _satColor.setHSL(step(h, 16), sat, light);
  return _satColor.getHex();
}

// Wall colour lifted from a street-level photograph of that same wall.
//
// This is a different problem from wallFromRoof, and deserves its own function
// rather than a shared one. There the input is a guess — a roof standing in for
// a wall nobody photographed — so almost everything gets replaced and only the
// hue family survives. Here the input is the wall itself, already exposure- and
// white-balance-corrected upstream, so the job is not to invent a colour but to
// keep the one that is there while making it belong in a painted city: nudge
// the saturation up, hold the value off the very bottom of the range, and quantise
// both so a street of forty buildings reads as a palette rather than as forty
// slightly different greys.
export function paintedFromPhoto(hex, anime = true) {
  _satColor.setHex(hex, THREE.SRGBColorSpace);
  _satColor.getHSL(_hsl);
  let { h, s, l } = _hsl;
  if (!anime) {
    _satColor.setHSL(h, Math.min(1, s * 1.1), THREE.MathUtils.clamp(l * 1.04, 0.06, 0.96));
    return _satColor.getHex();
  }
  const step = (v, n) => Math.round(v * n) / n;
  // Haze eats saturation, so most of these come back nearly neutral. Lifting
  // by a factor rather than adding a constant keeps a genuinely white building
  // white and gives a genuinely blue one its blue back.
  s = step(THREE.MathUtils.clamp(s * 1.75 + 0.03, 0.03, 0.5), 6);
  l = step(THREE.MathUtils.clamp(l * 0.86 + 0.2, 0.42, 0.93), 8);
  _satColor.setHSL(step(h, 24), s, l);
  return _satColor.getHex();
}

// What kind of roof does the imagery say this is? A terracotta reading is the
// strongest signal available — Mangalore tile is always pitched, and RCC always
// is not — so this decides roof *form*, not just colour.
export function roofKindFromSatellite(rgb) {
  _satColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  _satColor.getHSL(_hsl);
  const { h, s, l } = _hsl;
  if (h > 0.19 && h < 0.46 && s > 0.12) return "unknown";        // canopy over it
  if (s > 0.16 && (h < 0.055 || h > 0.94)) return "tile";        // terracotta
  if (s > 0.1 && h > 0.5 && h < 0.72) return "sheet";            // blue corrugated
  if (s < 0.13 && l < 0.42) return "asphalt";
  return "concrete";
}

// Paint a merged geometry with a per-building tint. Vertex colours are the
// mechanism that lets 2,223 individually-coloured buildings share one material.
const tmpColor = new THREE.Color();
export function paintGeometry(geometry, hex) {
  tmpColor.set(hex);
  // Vertex colours multiply the map in linear space; convert so the swatch we
  // picked is the colour that actually appears.
  tmpColor.convertSRGBToLinear();
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
