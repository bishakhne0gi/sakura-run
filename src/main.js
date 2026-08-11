import * as THREE from "three";
import { buildWorld } from "./world/build.js";
import { Collider } from "./world/collision.js";
import { Player, MODES } from "./player/controller.js";
import { createAvatars } from "./player/avatar.js";
import { BlossomField } from "./render/blossom.js";
import { createSky, Daylight, TIME_PRESETS } from "./render/sky.js";
import { PALETTE } from "./render/toon.js";
import { Hud } from "./ui/hud.js";
import { Ambience } from "./audio/ambience.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // DPR cap: a 3x phone renders 9x the pixels
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // flat cel colours must not be tone-mapped

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PALETTE.fog, 260, 900);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 2200);

const hud = new Hud(document.getElementById("hud"));
const ambience = new Ambience();

// ---------------------------------------------------------------- load

const METRES_PER_DEG_LAT = 110574;
const metresPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

let world;
let player;
let blossom;
let sky;
let daylight;
let avatars;
let pois = [];
const poiGrid = new Map();
const POI_CELL = 40;

async function boot() {
  const response = await fetch("world.json");
  world = await response.json();

  const city = buildWorld(world);
  scene.add(city);

  sky = createSky();
  scene.add(sky);

  daylight = new Daylight(scene);
  daylight.apply("morning", sky);

  blossom = new BlossomField({ count: reducedMotion ? 700 : 1800, reducedMotion });
  scene.add(blossom.mesh);

  const collider = new Collider(world);

  // Spawn where the city is actually dense. Picking the longest main road put
  // the player on the northern map edge staring at empty ground — length is not
  // a proxy for interest. Score candidate points by how many named shopfronts
  // sit within 120 m instead, which lands on the Main-road retail strips.
  const candidates = [];
  for (const road of world.roads) {
    if (road.kind !== "main" && road.kind !== "arterial") continue;
    for (let i = 1; i < road.points.length; i++) {
      const [px, pz] = road.points[i];
      let score = 0;
      for (const poi of world.pois) {
        if (!poi.name) continue;
        if (Math.abs(poi.p[0] - px) < 120 && Math.abs(poi.p[1] - pz) < 120) score++;
      }
      // Nudge towards the middle of the slice so the map surrounds the player.
      score -= Math.hypot(px, pz) / 260;
      candidates.push({ road, i, score });
    }
  }
  candidates.sort((p, q) => q.score - p.score);

  // OSM building footprints and road centrelines genuinely overlap in places,
  // so the best-scoring point can sit inside a building — or in a one-metre gap
  // between two, which passes a containment test and still looks like a wall.
  // Require real standing room.
  const standable = (c) => {
    const [x, z] = c.road.points[c.i];
    return !collider.contains(x, z) && collider.clearance(x, z) > 5;
  };
  const spawn = candidates.find(standable) || candidates[0];
  const a = spawn.road.points[spawn.i - 1];
  const b = spawn.road.points[spawn.i];
  const spawnHeading = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
  const safe = collider.resolve(b[0], b[1], MODES.walk.radius);

  player = new Player(camera, collider, { x: safe.x, z: safe.z, heading: spawnHeading });

  avatars = createAvatars();
  scene.add(avatars.root);

  pois = world.pois.filter((p) => p.name);
  for (const poi of pois) {
    const key = `${Math.floor(poi.p[0] / POI_CELL)},${Math.floor(poi.p[1] / POI_CELL)}`;
    if (!poiGrid.has(key)) poiGrid.set(key, []);
    poiGrid.get(key).push(poi);
  }

  bindInput();
  hud.toast(`${world.buildings.length} buildings · ${world.trees.length} trees · OpenStreetMap`);

  // Debug handle: lets the browser console (and automated verification) drive
  // the camera to any coordinate without pointer lock. Dev only — it pulls
  // Raycaster into the bundle and exposes internals.
  if (import.meta.env?.DEV) window.__game = {
    scene, camera, renderer, player, world, daylight, sky, blossom, hud,
    teleport(x, z, heading = 0, pitch = 0) {
      player.position.set(x, 0, z);
      player.heading = heading;
      player.pitch = pitch;
      player.speed = 0;
      player.velocity.set(0, 0);
    },
    goto(label) {
      const landmark = world.landmarks.find((l) => l.label === label);
      if (landmark) this.teleport(landmark.p[0], landmark.p[1]);
      return landmark;
    },
    THREE,
    fly(x, y, z, heading = 0, pitch = -0.5) {
      debugCam = { x, y, z, heading, pitch };
    },
    land() {
      debugCam = null;
    },
    // What is the camera actually looking at? Answers "why am I staring at a
    // grey wall" without guesswork.
    probe() {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = raycaster.intersectObjects(scene.children, true).slice(0, 4);
      return hits.map((h) => ({
        object: h.object.name || h.object.type,
        distance: Number(h.distance.toFixed(2)),
        point: h.point.toArray().map((n) => Number(n.toFixed(1))),
      }));
    },
    stats() {
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        fps: Math.round(fps),
      };
    },
  };

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- input

const TIME_ORDER = Object.keys(TIME_PRESETS);
let timeIndex = 0;

function bindInput() {
  hud.onStart(() => canvas.requestPointerLock());
  canvas.addEventListener("click", () => {
    if (!player.locked) canvas.requestPointerLock();
  });

  document.addEventListener("pointerlockchange", () => {
    player.locked = document.pointerLockElement === canvas;
    if (player.locked) hud.hideVeil();
    else {
      hud.showVeil();
      player.keys.clear();
    }
  });

  document.addEventListener("mousemove", (event) => {
    player.onMouseMove(event.movementX || 0, event.movementY || 0);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Tab") event.preventDefault();
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();

    player.onKeyDown(event);

    if (event.code === "KeyC") hud.toggleReadout();
    if (event.code === "KeyM") {
      const on = ambience.toggle();
      hud.toast(on ? "Ambience on" : "Ambience off");
    }
    if (event.code === "KeyT") {
      timeIndex = (timeIndex + 1) % TIME_ORDER.length;
      const preset = daylight.apply(TIME_ORDER[timeIndex], sky);
      hud.toast(preset.label);
    }
    if (event.code === "KeyV") hud.toast(player.mode === "cycle" ? "Cycle" : "On foot");
    if (event.code === "KeyB") hud.toast(player.mode === "auto" ? "Auto" : "On foot");
    if (event.code === "KeyP") hud.toast(player.thirdPerson ? "Third person" : "First person");
    if (event.code === "KeyE" && currentPoi) hud.toast(describePoi(currentPoi));
  });

  window.addEventListener("keyup", (event) => player.onKeyUp(event));

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });

  document.addEventListener("visibilitychange", () => {
    // Reset the clock on resume, or the first frame back integrates the pause.
    if (!document.hidden) clock.getDelta();
  });
}

function describePoi(poi) {
  const kind = poi.kind.replace(/_/g, " ");
  return poi.name ? `${poi.name} — ${kind}` : kind;
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let debugCam = null;
let currentPoi = null;
let fps = 60;
let fpsAccumulator = 0;
let fpsFrames = 0;

function nearestPoi(x, z) {
  let best = null;
  let bestDistance = 14;
  const cx = Math.floor(x / POI_CELL);
  const cz = Math.floor(z / POI_CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const bucket = poiGrid.get(`${cx + i},${cz + j}`);
      if (!bucket) continue;
      for (const poi of bucket) {
        const d = Math.hypot(poi.p[0] - x, poi.p[1] - z);
        if (d < bestDistance) {
          bestDistance = d;
          best = poi;
        }
      }
    }
  }
  return best;
}

function nearestLandmark(x, z) {
  let best = null;
  let bestDistance = Infinity;
  for (const landmark of world.landmarks) {
    const d = Math.hypot(landmark.p[0] - x, landmark.p[1] - z);
    if (d < bestDistance) {
      bestDistance = d;
      best = landmark;
    }
  }
  return best && bestDistance < 420 ? best.label : "HSR Layout";
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp: a tab-switch must not teleport the player

  player.update(dt);
  if (debugCam) {
    // Overrides the player camera entirely: used to inspect the built city
    // from above during verification.
    camera.position.set(debugCam.x, debugCam.y, debugCam.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(debugCam.heading);
    camera.rotateX(debugCam.pitch);
  }
  daylight.follow(player.position);
  sky.position.copy(camera.position);
  sky.material.uniforms.uCenter.value.copy(camera.position);
  blossom.update(dt, camera.position);
  ambience.update(player.speed, player.mode);

  avatars.show(player.thirdPerson ? player.mode : null);
  if (player.thirdPerson) {
    avatars.update(player.position, player.heading, player.roll, player.speed);
  }

  currentPoi = nearestPoi(player.position.x, player.position.z);
  hud.setPrompt(currentPoi ? describePoi(currentPoi) : null);

  fpsAccumulator += dt;
  fpsFrames++;
  if (fpsAccumulator > 0.5) {
    fps = fpsFrames / fpsAccumulator;
    fpsAccumulator = 0;
    fpsFrames = 0;
  }

  const lat = world.origin.lat - player.position.z / METRES_PER_DEG_LAT;
  const lon = world.origin.lon + player.position.x / metresPerDegLon(world.origin.lat);

  hud.update({
    x: player.position.x,
    z: player.position.z,
    lat,
    lon,
    speed: Math.abs(player.speed),
    fps,
    mode: MODES[player.mode].label,
    heading: player.heading,
    nearest: nearestLandmark(player.position.x, player.position.z),
  });

  renderer.render(scene, camera);
}

boot().catch((error) => {
  console.error(error);
  const hudRoot = document.getElementById("hud");
  hudRoot.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "fatal";
  panel.append("Could not load the world.", document.createElement("br"));
  const detail = document.createElement("code");
  detail.textContent = String(error?.message || error);
  panel.append(detail);
  hudRoot.append(panel);
});
