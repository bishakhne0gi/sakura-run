import * as THREE from "three";
import { toonMaterial, facet } from "../render/toon.js";

// Low-poly stand-ins shown only in third person. They exist to make the mode
// switch legible — you should know what you are riding from the silhouette
// alone, at the distance the chase camera actually sits.

function box(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMaterial(color, { steps: 3 }));
}

function cylinder(rt, rb, h, seg, color) {
  // Facet in geometry: MeshToonMaterial has no flatShading property.
  const geometry = facet(new THREE.CylinderGeometry(rt, rb, h, seg));
  return new THREE.Mesh(geometry, toonMaterial(color, { steps: 3 }));
}

function wheel(radius, width, color = 0x2e2a30) {
  const mesh = cylinder(radius, radius, width, 10, color);
  mesh.rotation.z = Math.PI / 2;
  // Tag it: facet() returns a plain BufferGeometry, so geometry.type can no
  // longer identify a wheel at update time.
  mesh.userData.wheel = true;
  return mesh;
}

function rider(shirt = 0x4f7fb5, skin = 0xc98d63) {
  const group = new THREE.Group();
  const torso = box(0.42, 0.6, 0.26, shirt);
  torso.position.y = 1.12;
  const head = cylinder(0.14, 0.15, 0.26, 8, skin);
  head.position.y = 1.56;
  const hair = cylinder(0.155, 0.15, 0.1, 8, 0x2b2320);
  hair.position.y = 1.67;
  const legL = box(0.16, 0.62, 0.18, 0x39435c);
  legL.position.set(-0.11, 0.5, 0);
  const legR = legL.clone();
  legR.position.x = 0.11;
  const armL = box(0.12, 0.5, 0.14, shirt);
  armL.position.set(-0.28, 1.14, 0.02);
  const armR = armL.clone();
  armR.position.x = 0.28;
  group.add(torso, head, hair, legL, legR, armL, armR);
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
  const frame = box(0.09, 0.09, 1.15, 0x2f6fb0);
  frame.position.set(0, 0.72, 0);
  frame.rotation.x = 0.12;
  const seatPost = box(0.07, 0.4, 0.07, 0x2f6fb0);
  seatPost.position.set(0, 0.85, 0.28);
  const bars = box(0.5, 0.06, 0.06, 0x3a3a42);
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
  const AUTO_YELLOW = 0xf5c542;
  const AUTO_BLACK = 0x24222a;

  const cabin = box(1.28, 0.72, 1.85, AUTO_YELLOW);
  cabin.position.set(0, 0.78, 0.1);
  const canopy = box(1.3, 0.62, 1.5, AUTO_BLACK);
  canopy.position.set(0, 1.42, 0.22);
  const nose = cylinder(0.42, 0.5, 0.9, 8, AUTO_YELLOW);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.72, -0.92);
  const windshield = box(0.92, 0.5, 0.06, 0xbcd4dd);
  windshield.position.set(0, 1.3, -0.62);
  const headlamp = cylinder(0.13, 0.13, 0.1, 8, 0xfff3d0);
  headlamp.rotation.x = Math.PI / 2;
  headlamp.position.set(0, 0.86, -1.32);
  const bench = box(1.1, 0.16, 0.5, 0x8a4a3c);
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
