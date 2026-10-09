import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { STYLE, bandRamp } from "../render/materials.js";

// Skinned pedestrians for the near field.
//
// The crowd is drawn two ways at once, because neither way is right on its own.
// Far off there are a hundred-odd people and what matters is that they exist and
// move — the twelve-part instanced rig does that in twelve draw calls. Close up
// what matters is that a person looks like a person, and no amount of instanced
// capsules achieves that; you need a real skeleton and a real mocap cycle.
//
// So a small pool of skinned Mixamo characters is handed to whichever walkers
// are nearest the camera, and those walkers' instanced parts are collapsed to
// zero scale for the frame so nothing is drawn twice. Everyone else carries on
// as instances. The pool is fixed, so the cost is bounded no matter how crowded
// the pavement gets.
//
// The hand-off has hysteresis — promote inside PROMOTE, release outside RELEASE
// — because a walker sitting exactly on one threshold would otherwise flicker
// between a skinned model and a capsule several times a second.
const PROMOTE = 30;
const RELEASE = 38;

// One downloaded character would otherwise mean one person repeated ten times
// down the same footpath, which reads worse than capsules did — identical twins
// are more obviously wrong than abstractions. Each slot gets its own materials
// and its own palette pick, so the pool reads as ten different people.
//
// The colours multiply the downloaded texture rather than replacing it, so the
// fabric folds and shading in the original stay intact and only the hue moves.
// Muted and warm, never fully saturated: the same rule as the instanced crowd.
const SHIRTS = [
  0xd4685f, 0x5b83b0, 0xece5d6, 0x5c9e83, 0xe0b168, 0x8a76a6,
  0x4a4f5c, 0xf0d8dd, 0xc9773f, 0x7fa5ae, 0xb44f5e, 0xa8bf7e,
];
const TROUSERS = [0x4d5670, 0x3f3c3e, 0x6b6153, 0x717788, 0x47594b, 0x8a7a66, 0x5c5566];
const HAIR = [0x2e2622, 0x1d1a18, 0x4a3428, 0x6b5240, 0x3a2f2a, 0x241f1d];
const SHOES = [0xece7dd, 0x2b2723, 0x8a7a66, 0x4a4f5c, 0xb44f5e];

const pick = (list, i, salt) => list[(i * 7 + salt * 13) % list.length];

export class SkinnedCrowd {
  constructor(sources, poolSize) {
    this.slots = [];
    this.byWalker = new Map();
    this.root = new THREE.Group();
    this.root.name = "skinned-crowd";
    this.names = sources.map((s) => s.name);

    // Each character is a different rig at a different native scale — Mixamo
    // exports whatever the artist built — so height is measured per model and
    // normalised to a real person. Hard-coding one number here is what turns
    // one download into a giant standing next to another.
    const prepared = sources.map(({ name, gltf }) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const height = Math.max(0.001, box.max.y - box.min.y);
      return {
        name,
        scene: gltf.scene,
        clip: gltf.animations?.[0] ?? null,
        baseScale: 1.72 / height,
      };
    });
    this.clipDuration = prepared[0].clip?.duration || 1;
    // Kept for callers that still ask; the per-slot value is what actually runs.
    this.baseScale = prepared[0].baseScale;

    for (let i = 0; i < poolSize; i += 1) {
      // Round-robin, so a pool of twelve covers every character before repeating.
      const source = prepared[i % prepared.length];
      const clip = source.clip;
      const model = cloneSkinned(source.scene);
      model.visible = false;

      // Re-material to match the city. The download is flagged unlit, which
      // renders the character at full brightness regardless of the hour and
      // makes it float free of the scene. A toon material with the same ramp
      // every wall uses puts it under the same light as everything else while
      // keeping the texture intact.
      model.traverse((object) => {
        if (!object.isMesh && !object.isSkinnedMesh) return;
        object.castShadow = true;
        object.receiveShadow = false;
        const old = object.material;
        const map = Array.isArray(old) ? old[0]?.map : old?.map;

        // Which part of the person is this? Mixamo names its submeshes, which is
        // what makes per-garment tinting possible at all.
        const part = (object.name || "").toLowerCase();
        let tint = 0xffffff;
        let garment = true;
        if (part.includes("top") || part.includes("shirt")) tint = pick(SHIRTS, i, 1);
        else if (part.includes("bottom") || part.includes("short") || part.includes("pant")) tint = pick(TROUSERS, i, 2);
        else if (part.includes("hair")) tint = pick(HAIR, i, 3);
        else if (part.includes("shoe") || part.includes("foot")) tint = pick(SHOES, i, 4);
        else {
          // Unrecognised submesh. Every character names its parts differently,
          // and guessing "this must be skin" would paint a business suit
          // flesh-coloured on any rig whose meshes are named something else.
          // Left untinted: the download's own colours are already correct.
          tint = 0xffffff;
          garment = false;
        }

        // The tint multiplies the downloaded texture, and this character's
        // clothing texture is a mid grey — so a pale colour lands at roughly
        // half the value it names and the whole crowd comes out muddy. Scaling
        // the garment tints back up puts them where the palette intended.
        // Values above 1 are legal in linear space; skin is left alone, since
        // it is the one surface where the texture's own colour is the point.
        const colour = new THREE.Color(tint);
        if (garment) colour.multiplyScalar(1.75);

        object.material = STYLE === "anime"
          ? new THREE.MeshToonMaterial({ map: map ?? null, gradientMap: bandRamp(), color: colour })
          : new THREE.MeshLambertMaterial({ map: map ?? null, color: colour });
        // Skinned geometry is animated on the GPU, so its object-space bounds
        // never change and three culls it against the bind pose. At the scale
        // these are drawn that is close enough to wrong to pop.
        object.frustumCulled = false;
      });

      const mixer = new THREE.AnimationMixer(model);
      let action = null;
      if (clip) {
        action = mixer.clipAction(clip);
        // Random phase, so a group of people never marches in lockstep.
        action.time = Math.random() * this.clipDuration;
        action.play();
      }

      this.root.add(model);
      // A little variation in build, so ten people are not ten copies at one
      // height. Kept small — beyond a few percent it reads as bad scaling.
      const build = 0.94 + ((i * 37) % 13) / 100;
      this.slots.push({
        model, mixer, action, walker: null, scale: 1, build,
        character: source.name, baseScale: source.baseScale,
      });
    }
  }

  // Called once per frame before any offers.
  begin() {
    for (const slot of this.slots) slot.claimed = false;
  }

  // Offer a walker to the pool. Returns true when this walker is being drawn as
  // a skinned model, which tells the caller to hide its instanced parts.
  offer(id, x, z, heading, speed, distance, scale) {
    let slot = this.byWalker.get(id);

    if (slot) {
      // Already promoted — keep it until it drifts past the release distance.
      if (distance > RELEASE) {
        this.byWalker.delete(id);
        slot.walker = null;
        slot.model.visible = false;
        return false;
      }
    } else {
      if (distance > PROMOTE) return false;
      slot = this.slots.find((s) => s.walker === null);
      if (!slot) return false;            // pool exhausted; stay an instance
      slot.walker = id;
      this.byWalker.set(id, slot);
    }

    slot.claimed = true;
    slot.model.visible = true;
    slot.model.position.set(x, 0, z);
    // No half-turn. The rig's bind pose already faces the same way the world's
    // heading convention does, and the extra PI I added on the assumption it
    // faced +Z is what made everyone moonwalk down the footpath.
    slot.model.rotation.set(0, heading, 0);
    const s = (slot.baseScale ?? this.baseScale) * (scale ?? 1) * (slot.build ?? 1);
    slot.model.scale.setScalar(s);
    // Stride rate follows walking speed, or the feet skate.
    if (slot.action) slot.action.timeScale = Math.max(0.35, speed / 1.35);
    return true;
  }

  // Advance the animation of everything still in use, and park the rest.
  end(dt) {
    for (const slot of this.slots) {
      if (slot.walker !== null && !slot.claimed) {
        // The walker vanished — recycled to a new spawn point, most likely.
        this.byWalker.delete(slot.walker);
        slot.walker = null;
        slot.model.visible = false;
      }
      if (slot.model.visible) slot.mixer.update(dt);
    }
  }
}

// Every character downloaded from Mixamo. Missing files are skipped rather than
// fatal, so the game still runs from a clean checkout with none of them.
const CHARACTERS = ["remy", "michelle", "louise", "brian", "granny"];

export async function loadCrowd(poolSize = 12) {
  const loader = new GLTFLoader();
  const sources = [];

  for (const name of CHARACTERS) {
    try {
      const gltf = await loader.loadAsync(`characters/${name}.glb`);
      if (gltf?.scene) sources.push({ name, gltf });
    } catch {
      // not downloaded — fine
    }
  }

  if (!sources.length) {
    console.warn("[crowd] no skinned characters available");
    return null;
  }
  return new SkinnedCrowd(sources, poolSize);
}
