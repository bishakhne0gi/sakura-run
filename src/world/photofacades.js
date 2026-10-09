import * as THREE from "three";
import { STYLE, bandRamp } from "../render/materials.js";

// Real photographed facades — applied to the building itself, not hung in front
// of it.
//
// The first attempt drew each photo on a thin quad floating 6 cm off the wall.
// It was quick and it was wrong: a photograph on a plane in front of a building
// reads as a banner tied to the railings, because that is exactly what it is.
// You can see its edges, it does not turn the corner, and the wall it is meant
// to be showing is still visible behind it.
//
// So the pixels go onto the building's own geometry. The wall gets its UVs
// rewritten to point into the atlas tile that was baked from that wall, which
// means the photograph *is* the surface: it corners correctly, it is occluded
// correctly, it takes the same light, and there is no plane to catch the eye.
//
// Side walls are handled by projecting every vertex onto the photographed wall's
// axis and clamping. A wall at right angles collapses to a single point on that
// axis, so it samples the tile's edge column and reads as the same building's
// render and grime continuing round the corner. That is the standard edge-extend
// trick and it is far better here than the alternative of dropping back to a
// procedural variant, which would put an obviously different building material
// two metres from the photographed one.

// Rewrites a wall geometry's UVs to sample this building's atlas tile.
export function applyPhotoUVs(geometry, entry) {
  const [x1, z1, x2, z2] = entry.wall;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const [u0, v0, u1, v1] = entry.uv;
  const h = Math.max(0.5, entry.height);

  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  if (!position || !uv) return geometry;

  for (let i = 0; i < position.count; i += 1) {
    const px = position.getX(i);
    const py = position.getY(i);
    const pz = position.getZ(i);

    // Distance along the photographed wall, 0 at one end and 1 at the other.
    // Clamped, so geometry beyond the wall's extent — the returns at each end,
    // and the whole of the back — samples the nearest edge column.
    const t = Math.min(1, Math.max(0, ((px - x1) * ux + (pz - z1) * uz) / len));
    const vy = Math.min(1, Math.max(0, py / h));

    // v0 is the tile's top row and belongs at the top of the wall. This holds
    // because the texture is loaded with flipY off, so v runs downward through
    // the image exactly as the atlas was written.
    uv.setXY(i, u0 + (u1 - u0) * t, v0 + (v1 - v0) * (1 - vy));
  }
  uv.needsUpdate = true;
  return geometry;
}

const materials = new Map();
export function photoWallMaterial(texture, atlas) {
  const key = `${atlas}:${STYLE}`;
  if (materials.has(key)) return materials.get(key);

  // In the painted style these have to be toon-shaded like everything else, and
  // the reason is not consistency for its own sake — it is that the toon ramp
  // has a floor. Every other wall in the city bottoms out at 0.74 of full light,
  // so a wall facing away from a low sun stays bright. A Lambert wall next to it
  // obeys real N·L and falls all the way off, so photographed buildings turned
  // into dark slabs beside their procedural neighbours at golden hour.
  //
  // The earlier worry — that a toon ramp posterises photographic detail — was
  // misplaced: the gradient map quantises the *lighting*, not the texture. The
  // photo's own detail comes through the map at full resolution and simply gets
  // lit in bands, which is what the rest of the city does too.
  const params = {
    map: texture,
    // Just under white, so a photographed wall does not read brighter than the
    // procedural walls standing either side of it.
    color: 0xf2f0ec,
  };
  const material = STYLE === "anime"
    ? new THREE.MeshToonMaterial({ ...params, gradientMap: bandRamp() })
    : new THREE.MeshLambertMaterial(params);
  materials.set(key, material);
  return material;
}

export function clearPhotoMaterials() {
  for (const m of materials.values()) m.dispose?.();
  materials.clear();
}

// building index -> baked facade entry
export function photoFacadeLookup(index) {
  const map = new Map();
  if (!index?.facades) return map;
  for (const entry of index.facades) {
    // One photo per building: if two walls were baked, keep the closer camera.
    const existing = map.get(entry.building);
    if (!existing || entry.dist < existing.dist) map.set(entry.building, entry);
  }
  return map;
}

// Loads the atlases named in the index. Returns null rather than throwing when
// the pipeline has not been run — the game has to work from a clean checkout,
// where public/facades does not exist.
export async function loadPhotoFacades() {
  let index;
  try {
    const response = await fetch("facades/index.json");
    if (!response.ok) return null;
    index = await response.json();
  } catch {
    return null;
  }
  if (!index?.atlases?.length) return null;

  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(index.atlases.map((name) => new Promise((resolve) => {
    loader.load(
      `facades/${name}`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        // flipY off so v runs top-to-bottom through the image, matching the row
        // order the atlas was written in. With three's default (flipY on) every
        // facade renders upside down, which is a subtle enough error on a wall of
        // windows to survive a casual look.
        texture.flipY = false;
        // Neighbouring facades are adjacent in the atlas, so wrapping or a
        // coarse mip would blend one shop into the next. The half-texel inset
        // baked into the UVs covers bilinear; clamping covers the rest.
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = 8;
        resolve(texture);
      },
      undefined,
      () => resolve(null),
    );
  })));

  if (!textures.some(Boolean)) return null;
  return { index, textures, lookup: photoFacadeLookup(index) };
}
