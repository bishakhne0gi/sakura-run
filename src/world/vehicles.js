import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STYLE, bandRamp } from "../render/materials.js";

// Real vehicle models, downloaded rather than modelled here.
//
// The procedural cars were rounded boxes, and rounding a box gets you a rounded
// box. A wheel arch, a wing mirror, a windscreen that meets the roof at the
// right angle — none of that comes out of primitives at any reasonable effort,
// and all of it is what makes a car read as a car at ten metres.
//
// Source: Kenney's Car Kit, CC0 (public domain). Nine vehicles, one shared
// texture atlas, ~3k vertices each — cheap enough to instance a whole street of
// them, and stylised rather than photoreal, which is what this world wants.
//
// Each model is merged down to one geometry so it can drive an InstancedMesh:
// the whole point of the traffic system is that a hundred vehicles cost a
// handful of draw calls, and a GLTF scene graph per vehicle would throw that
// away. Merging is safe here because every mesh in these files shares a single
// material.
//
// Lengths are real-world metres. The models arrive at roughly half scale, and a
// sedan that is 2.5 m long looks like a toy parked next to a 3 m compound wall.
const CATALOGUE = [
  { file: "sedan", length: 4.4, share: 0.24, speed: 1.0 },
  { file: "taxi", length: 4.4, share: 0.16, speed: 1.0 },
  { file: "suv", length: 4.8, share: 0.16, speed: 1.0 },
  { file: "hatchback-sports", length: 4.1, share: 0.14, speed: 1.05 },
  { file: "van", length: 5.2, share: 0.12, speed: 0.95 },
  { file: "delivery", length: 5.6, share: 0.08, speed: 0.9 },
  { file: "truck", length: 6.6, share: 0.05, speed: 0.82 },
  { file: "garbage-truck", length: 7.0, share: 0.03, speed: 0.75 },
  { file: "police", length: 4.6, share: 0.02, speed: 1.05 },
];

// No yaw correction needed.
//
// This world's vehicles are authored nose towards +Z — the procedural auto puts
// its windscreen and headlamp at positive z — and the traffic system rotates by
// atan2(dx, dz), which points local +Z along the direction of travel.
//
// Kenney's cars use the same convention. Settled by reading the model's own node
// names rather than by eye: wheel-front-left and wheel-front-right sit at
// z = +0.66, wheel-back-* at z = -0.66. So the nose is already at +Z and a half
// turn would put the whole fleet into reverse.
const MODEL_YAW = 0;

function flattenToOneGeometry(scene) {
  const parts = [];
  let material = null;

  scene.updateWorldMatrix(true, true);
  scene.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    // Bake the node transform in, or every wheel ends up at the origin.
    geometry.applyMatrix4(object.matrixWorld);
    // Only the attributes every part shares survive a merge; TANGENT is present
    // on some meshes and absent on others, and one mismatch makes
    // mergeGeometries return null for the entire vehicle.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") geometry.deleteAttribute(name);
    }
    parts.push(geometry);
    if (!material) material = Array.isArray(object.material) ? object.material[0] : object.material;
  });

  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  return { geometry: merged, material };
}

export async function loadVehicleModels() {
  const loader = new GLTFLoader();
  const out = [];

  for (const entry of CATALOGUE) {
    try {
      const gltf = await loader.loadAsync(`models/vehicles/${entry.file}.glb`);
      const flat = flattenToOneGeometry(gltf.scene);
      if (!flat) continue;

      const { geometry } = flat;
      geometry.rotateY(MODEL_YAW);
      geometry.computeBoundingBox();
      const size = new THREE.Vector3();
      geometry.boundingBox.getSize(size);

      // Scale from the model's own length, measured, so a different pack does
      // not silently produce toys or lorries.
      const scale = entry.length / Math.max(0.001, size.z);
      geometry.scale(scale, scale, scale);
      // Sit it on the road rather than half through it.
      geometry.computeBoundingBox();
      geometry.translate(0, -geometry.boundingBox.min.y, 0);
      geometry.computeVertexNormals();

      const map = flat.material?.map ?? null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const material = STYLE === "anime"
        ? new THREE.MeshToonMaterial({ map, gradientMap: bandRamp() })
        : new THREE.MeshLambertMaterial({ map });

      out.push({ name: entry.file, geometry, material, share: entry.share, speed: entry.speed });
    } catch (error) {
      console.warn(`[vehicles] ${entry.file} unavailable:`, error?.message || error);
    }
  }
  return out;
}
