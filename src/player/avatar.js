import * as THREE from "three";
import { paintedMaterial } from "../render/materials.js";

// Painted plastic-to-cloth range: the avatars are seen from 4-6 m in third
// person, so roughness carries them. Nothing here needs a texture.
const toonMaterial = (color) => paintedMaterial(color, { roughness: 0.72, metalness: 0.06 });

// Low-poly stand-ins shown only in third person. They exist to make the mode
// switch legible — you should know what you are riding from the silhouette
// alone, at the distance the chase camera actually sits.

function box(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMaterial(color));
}

// A box with all its edges rounded, as an extruded rounded rectangle with a
// bevel. Hard edges are the single loudest tell that something was generated
// rather than drawn — there is not a sharp 90-degree corner anywhere in these
// films, on a person or on a vehicle.
function soft(w, h, d, radius, color) {
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
  return new THREE.Mesh(geometry, toonMaterial(color));
}

function capsule(radius, length, color) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 3, 12), toonMaterial(color));
}

function sphere(radius, color, scale = [1, 1, 1]) {
  const geometry = new THREE.SphereGeometry(radius, 16, 12);
  geometry.scale(scale[0], scale[1], scale[2]);
  return new THREE.Mesh(geometry, toonMaterial(color));
}

function cylinder(rt, rb, h, seg, color) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), toonMaterial(color));
}

function wheel(radius, width, color = 0x312d2a) {
  const mesh = cylinder(radius, radius, width, 10, color);
  mesh.rotation.z = Math.PI / 2;
  // Tag it explicitly: the update loop cannot identify a wheel from geometry
  // type once several parts share the same cylinder.
  mesh.userData.wheel = true;
  return mesh;
}

function rider(shirt = 0x5b83b0, skin = 0xdca57c) {
  const group = new THREE.Group();

  // Head roughly a sixth of standing height, not a seventh and a half. This one
  // proportion does more for the style than any amount of surface detail: it is
  // what separates a drawn figure from a scanned one.
  const torso = capsule(0.17, 0.3, shirt);
  torso.scale.set(1.06, 1, 0.76);
  torso.position.y = 1.16;

  const shoulders = sphere(0.17, shirt, [1.12, 0.5, 0.8]);
  shoulders.position.y = 1.35;

  const neck = cylinder(0.05, 0.056, 0.09, 10, skin);
  neck.position.y = 1.45;

  const head = sphere(0.135, skin, [1, 1.06, 0.95]);
  head.position.y = 1.6;

  const hair = sphere(0.142, 0x2e2622, [1.02, 0.98, 1.04]);
  hair.position.set(0, 1.622, -0.012);

  const nape = sphere(0.104, 0x2e2622, [1, 0.9, 0.7]);
  nape.position.set(0, 1.57, -0.088);

  const legL = capsule(0.07, 0.42, 0x4d5670);
  legL.position.set(-0.1, 0.5, 0);
  const legR = legL.clone();
  legR.position.x = 0.1;

  const armL = capsule(0.047, 0.36, shirt);
  armL.position.set(-0.25, 1.16, 0.01);
  const armR = armL.clone();
  armR.position.x = 0.25;

  const shoeL = soft(0.1, 0.07, 0.22, 0.034, 0x2b2723);
  shoeL.position.set(-0.1, 0.05, 0.03);
  const shoeR = shoeL.clone();
  shoeR.position.x = 0.1;

  // Order matters: the update loop reaches for children[3] and [4] to swing the
  // legs onto the pedals, so the legs stay at those indices.
  group.add(torso, shoulders, neck, legL, legR, head, hair, nape, armL, armR, shoeL, shoeR);
  group.traverse((o) => { o.castShadow = true; });
  return group;
}

export function createAvatars() {
  const avatars = {};

  // --- on foot
  avatars.walk = rider();

  // --- cycle
  const cycle = new THREE.Group();
  const bikeBody = rider(0x6b8f5a);
  bikeBody.position.y = 0.36;
  bikeBody.children[3].rotation.x = -0.5; // legs forward on the pedals
  bikeBody.children[4].rotation.x = 0.3;
  const frame = capsule(0.045, 1.06, 0x4f86bd);
  frame.rotation.x = Math.PI / 2;
  frame.position.set(0, 0.72, 0);
  frame.rotation.x = 0.12;
  const seatPost = capsule(0.033, 0.34, 0x4f86bd);
  seatPost.position.set(0, 0.85, 0.28);
  const bars = capsule(0.028, 0.44, 0x4a453f);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, 1.02, -0.48);
  const frontWheel = wheel(0.35, 0.06);
  frontWheel.position.set(0, 0.35, -0.55);
  const rearWheel = wheel(0.35, 0.06);
  rearWheel.position.set(0, 0.35, 0.55);
  cycle.add(bikeBody, frame, seatPost, bars, frontWheel, rearWheel);
  cycle.traverse((o) => { o.castShadow = true; });
  avatars.cycle = cycle;

  // --- auto-rickshaw
  // Black-and-yellow, three wheels, canvas canopy, open sides. The proportions
  // matter more than the detail: tall, short, narrow, and nose-down.
  const auto = new THREE.Group();
  const AUTO_YELLOW = 0xf0c24a;
  const AUTO_BLACK = 0x2f2b28;

  const cabin = soft(1.28, 0.74, 1.82, 0.28, AUTO_YELLOW);
  cabin.position.set(0, 0.78, 0.1);
  const canopy = soft(1.26, 0.64, 1.48, 0.26, AUTO_BLACK);
  canopy.position.set(0, 1.42, 0.22);
  const nose = cylinder(0.42, 0.5, 0.9, 8, AUTO_YELLOW);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.72, -0.92);
  const windshield = soft(0.9, 0.5, 0.07, 0.16, 0xbcd4dd);
  windshield.position.set(0, 1.3, -0.62);
  const headlamp = cylinder(0.13, 0.13, 0.1, 8, 0xfff3d0);
  headlamp.rotation.x = Math.PI / 2;
  headlamp.position.set(0, 0.86, -1.32);
  const bench = soft(1.08, 0.16, 0.48, 0.07, 0x9a5f4a);
  bench.position.set(0, 0.98, 0.62);

  const frontW = wheel(0.31, 0.16);
  frontW.position.set(0, 0.31, -1.05);
  const rearL = wheel(0.34, 0.2);
  rearL.position.set(-0.62, 0.34, 0.62);
  const rearR = wheel(0.34, 0.2);
  rearR.position.set(0.62, 0.34, 0.62);

  const driver = rider(0xd8d2c4);
  driver.scale.setScalar(0.82);
  driver.position.set(0, 0.55, -0.32);

  auto.add(cabin, canopy, nose, windshield, headlamp, bench, frontW, rearL, rearR, driver);
  auto.traverse((o) => { o.castShadow = true; });
  avatars.auto = auto;

  const root = new THREE.Group();
  root.name = "avatar";
  for (const avatar of Object.values(avatars)) {
    avatar.visible = false;
    root.add(avatar);
  }

  return {
    root,
    avatars,
    show(mode) {
      for (const [key, avatar] of Object.entries(avatars)) avatar.visible = key === mode;
    },
    update(position, heading, roll, speed) {
      root.position.set(position.x, 0, position.z);
      // The models are built nose-towards -Z, which is also the player's
      // forward at heading 0, so the yaw is the heading itself. Adding PI spins
      // them to face the chase camera and you drive everywhere in reverse.
      root.rotation.set(0, heading, 0);
      root.rotation.z = roll * 0.6;
      // Spin the wheels of whatever is visible.
      const active = avatars.cycle.visible ? avatars.cycle : avatars.auto.visible ? avatars.auto : null;
      if (active) {
        for (const child of active.children) {
          if (child.userData.wheel) child.rotation.x -= speed * 0.06;
        }
      }
    },
  };
}
