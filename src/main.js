import * as THREE from "three";
import { buildWorld, setStreetLights, setFacadeDetail } from "./world/build.js";
import { loadPhotoFacades } from "./world/photofacades.js";
import { loadFacadeReads } from "./world/facadereads.js";
import { applyCurvatureToScene, curvature, curvatureForAltitude, PLANET_RADIUS } from "./render/curvature.js";
import { loadCrowd } from "./world/crowd.js";
import { Music } from "./audio/music.js";
import { loadVehicleModels } from "./world/vehicles.js";
import { Collider } from "./world/collision.js";
import { Traffic } from "./world/traffic.js";
import { Player, MODES } from "./player/controller.js";
import { BirdCam } from "./player/birdcam.js";
import { createAvatars } from "./player/avatar.js";
import { BlossomField } from "./render/blossom.js";
import { createSky, Daylight, TIME_PRESETS } from "./render/environment.js";
import { PALETTE, tickWater, setStyle, STYLE } from "./render/materials.js";
import { Post } from "./render/post.js";
import { Hud } from "./ui/hud.js";
import { MapView } from "./ui/map.js";
import { Ambience } from "./audio/ambience.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // DPR cap: a 3x phone renders 9x the pixels
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ACES is the whole reason a PBR scene reads as photographed rather than
// rendered: it rolls off the sun and the sky highlights instead of clipping
// them to white, and keeps saturation in the shadows.
// ACES is what makes a PBR scene read as photographed — it rolls the sun and
// sky highlights off instead of clipping them, and keeps saturation in shadow.
// It is also exactly wrong for a cel frame, where flat colour is the point and
// a filmic curve muddies every band. The style switch sets this.
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
// Exponential fog, not linear: real aerial perspective is exponential in
// distance, and linear fog puts a visible "start" line across the middle of a
// 2 km view.
scene.fog = new THREE.FogExp2(PALETTE.fog, 0.00045);

// near 0.3 / far 4000, not 0.1 / 6000. Depth precision is dominated by the near
// plane, and the outline pass reads this buffer: at 0.1 the depth values are so
// crammed that edge detection finds edges everywhere. Nothing is lost — 0.3 m is
// closer than the player can get to a wall, and the sky dome sits inside 4 km.
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.3, 4000);

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
let traffic;
let mapView;
let bird;
let post;
let cityRoot;
let pois = [];
const poiGrid = new Map();
const POI_CELL = 40;

async function boot() {
  const response = await fetch("world.json");
  world = await response.json();

  sky = createSky();
  scene.add(sky);

  // Lighting first: the environment map has to exist before the city is built,
  // because every material samples it. Building the city first gives you 2,223
  // buildings lit by nothing but the hemisphere light — the clay look.
  daylight = new Daylight(scene, renderer);
  daylight.anime = STYLE === "anime";
  daylight.apply("golden", sky);

  // Photographed facades, if the street-level pipeline has been run. Loaded
  // before the city is built, because these buildings are *made of* their
  // photographs — the texture decides their geometry's UVs, so it has to exist
  // by the time the walls are extruded. Absent on a clean checkout, in which
  // case every wall stays procedural.
  photoFacades = await loadPhotoFacades();
  const photo = photoFacades;
  if (photo) {
    console.log(`[facades] ${photo.lookup.size} photographed buildings from ${photo.index.atlases.length} atlas(es)`);
  }

  // The architectural reading of those same photographs — floors, bays, paint
  // colour, signboard colour, one record per photographed building. This is
  // what the city is actually built from; the atlases above are only loaded so
  // `?photos=1` still works for comparison.
  // The soundtrack, if one is shipped. Resolved before the entry click so the
  // first J press already knows whether it is starting a playlist or the
  // synthesised fallback.
  const trackCount = await music.load();
  console.log(trackCount ? `[music] ${trackCount} tracks` : "[music] synthesised score");

  facadeReads = await loadFacadeReads();
  if (facadeReads) console.log(`[facades] ${facadeReads.size} buildings modelled from imagery`);

  cityRoot = buildWorld(world, scene.environment, photo, facadeReads);
  scene.add(cityRoot);

  // Small-planet curvature for the bird view. Patched into every material the
  // city just created; the sky is deliberately left alone, since a curving sky
  // would peel away from the horizon it is supposed to meet.
  applyCurvatureToScene(cityRoot);

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
  // Trees are not in the collider (you can walk through a trunk), so a spawn
  // point can pass every clearance test and still put the camera inside 600 mm
  // of bark — which is what the player sees for the whole first second.
  const treeCell = 12;
  const treeGrid = new Map();
  for (const tree of world.trees) {
    const key = `${Math.floor(tree.p[0] / treeCell)},${Math.floor(tree.p[1] / treeCell)}`;
    if (!treeGrid.has(key)) treeGrid.set(key, []);
    treeGrid.get(key).push(tree);
  }
  const treeClearance = (x, z) => {
    let best = Infinity;
    const cx = Math.floor(x / treeCell);
    const cz = Math.floor(z / treeCell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const tree of treeGrid.get(`${cx + i},${cz + j}`) || []) {
          best = Math.min(best, Math.hypot(tree.p[0] - x, tree.p[1] - z));
        }
      }
    }
    return best;
  };

  const standable = (c) => {
    const [x, z] = c.road.points[c.i];
    return !collider.contains(x, z) && collider.clearance(x, z) > 5 && treeClearance(x, z) > 8;
  };
  const spawn = candidates.find(standable) || candidates[0];
  const a = spawn.road.points[spawn.i - 1];
  const b = spawn.road.points[spawn.i];
  const spawnHeading = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
  const safe = collider.resolve(b[0], b[1], MODES.walk.radius);

  player = new Player(camera, collider, { x: safe.x, z: safe.z, heading: spawnHeading });

  avatars = createAvatars();
  scene.add(avatars.root);

  // Downloaded vehicle models, if present. Loaded before the fleet is built,
  // because each model becomes its own instanced entry in it.
  const vehicleModels = await loadVehicleModels();
  if (vehicleModels.length) console.log(`[vehicles] ${vehicleModels.length} models: ${vehicleModels.map((v) => v.name).join(", ")}`);

  traffic = new Traffic(world, {
    vehicleModels,
    // The reference this is chasing has almost nobody on screen: a street reads
    // as lived-in through its *props*, and a crowd on every pavement reads as a
    // festival, not a Tuesday.
    vehicles: reducedMotion ? 24 : 52,
    people: reducedMotion ? 14 : 30,
    origin: player.position,
  });
  scene.add(traffic.root);

  // Skinned characters for the near field, if they have been downloaded. The
  // instanced crowd keeps the rest of the pavement populated.
  const crowd = await loadCrowd(12);
  if (crowd) {
    traffic.crowd = crowd;
    scene.add(crowd.root);
    applyCurvatureToScene(crowd.root);
    console.log(`[crowd] ${crowd.names.length} characters (${crowd.names.join(", ")}), pool of ${crowd.slots.length}`);
  }

  // Vehicles, people and the player's own avatar have to bend with the ground
  // they stand on, or they hang off the planet at altitude.
  applyCurvatureToScene(traffic.root);
  applyCurvatureToScene(avatars.root);

  bird = new BirdCam(camera, world);
  mapView = new MapView(document.getElementById("hud"), world);
  post = new Post(renderer, scene, camera);
  post.setPreset("golden");
  post.setSize();
  post.setStyle(STYLE);
  applyToneMapping();
  // An escape hatch for the effects chain. Post-processing is the one part of
  // this renderer that can fail on a driver rather than in the code, and when
  // it does the symptom is a black screen with no error — so it must be one
  // keypress (or one URL flag) away from being switched off, and the choice has
  // to survive a reload.
  const url = new URLSearchParams(location.search);
  if (url.has("nopost") || localStorage.getItem("sakura:post") === "off") post.enabled = false;
  post.onFallback = () => hud.toast("Effects failed on this GPU — switched off. Press O to retry.");

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
    scene, camera, renderer, player, world, daylight, sky, blossom, hud, traffic, bird, post, music,
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
    time(name) { setTime(name); return name; },
    birdview(on = true) { setBird(on); },
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
let timeIndex = TIME_ORDER.indexOf("golden");
let birdMode = false;
// Kept so the style switch can rebuild the city without losing the photographed
// walls — buildWorld needs the atlases handed back to it every time.
let photoFacades = null;
let facadeReads = null;
const music = new Music();
// Scratch vectors for the planet-framing orbit, so the frame loop allocates none.
const planetCentre = new THREE.Vector3();
const orbitDir = new THREE.Vector3();
const lookTarget = new THREE.Vector3();

function applyToneMapping() {
  renderer.toneMapping = STYLE === "anime" ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
}

function setTime(name) {
  const preset = daylight.apply(name, sky);
  if (!preset) return null;
  post.setPreset(name);
  setStreetLights(preset.lightsOn);
  blossom.setLight?.(preset.lightsOn);
  timeIndex = TIME_ORDER.indexOf(name);
  return preset;
}

function setBird(on) {
  if (on === birdMode) return;
  birdMode = on;
  // The modelled sills, frames and sunshades are a street-level detail. From
  // the planet camera they are sub-pixel and cost 2.9 million triangles to be
  // sub-pixel, so they go off with the switch rather than being drawn into
  // nothing.
  setFacadeDetail(!on);
  if (on) {
    bird.enter(player);
    camera.fov = 60;
    camera.updateProjectionMatrix();
  } else {
    bird.exit();
    curvature.invRadius.value = 0;
    daylight.sun.castShadow = true;
    camera.up.set(0, 1, 0);
  }
  hud.setMode(birdMode ? "Bird view" : MODES[player.mode].label);
}

function bindInput() {
  hud.onStart(() => {
    canvas.requestPointerLock();
    // An AudioContext created outside a user gesture starts suspended, and a
    // silently-suspended context is indistinguishable from broken audio code.
    music.start();
  });
  canvas.addEventListener("click", () => {
    if (!player.locked && !mapView.open) canvas.requestPointerLock();
  });

  document.addEventListener("pointerlockchange", () => {
    player.locked = document.pointerLockElement === canvas;
    if (player.locked) hud.hideVeil();
    else {
      if (!mapView.open) hud.showVeil();
      player.keys.clear();
    }
  });

  document.addEventListener("mousemove", (event) => {
    if (!player.locked) return;
    if (birdMode) bird.onMouseMove(event.movementX || 0, event.movementY || 0);
    else player.onMouseMove(event.movementX || 0, event.movementY || 0);
  });

  canvas.addEventListener("wheel", (event) => {
    if (birdMode) {
      event.preventDefault();
      bird.onWheel(event.deltaY);
    }
  }, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Tab") event.preventDefault();
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();

    // In bird view the movement keys drive the drone, so the player controller
    // must not also consume them — otherwise you land somewhere you never chose.
    if (birdMode) player.keys.add(event.code);
    else player.onKeyDown(event);

    if (event.code === "KeyC") hud.toggleReadout();
    if (event.code === "KeyK") {
      const on = ambience.toggle();
      hud.toast(on ? "Ambience on" : "Ambience off");
    }
    // K is the city ambience (traffic, birds); J is the score. Separate, so you
    // can keep the street sounding like a street with the music off.
    // J toggles the score, Shift+J skips to the next track. The shift test has
    // to guard *both* branches: without it, Shift+J fell through the first
    // branch as well and skipped the track it had just switched off.
    if (event.code === "KeyJ" && !event.shiftKey) {
      // Name the track. With a shuffled playlist "Music on" tells you nothing
      // about what you are now listening to.
      hud.toast(music.toggle() ? `♪ ${music.nowPlaying() ?? "Music on"}` : "Music off");
    }
    if (event.code === "KeyJ" && event.shiftKey) {
      music.advance();
      hud.toast(music.nowPlaying() ? `♪ ${music.nowPlaying()}` : "Music off");
    }
    if (event.code === "KeyT") {
      timeIndex = (timeIndex + 1) % TIME_ORDER.length;
      const preset = setTime(TIME_ORDER[timeIndex]);
      hud.toast(preset.label);
    }
    if (event.code === "KeyM") {
      const open = mapView.toggle(player.position);
      if (open) {
        document.exitPointerLock();
        hud.hideVeil();
      } else if (!player.locked) {
        canvas.requestPointerLock();
      }
    }
    if (event.code === "KeyG") {
      setBird(!birdMode);
      hud.toast(birdMode ? "Bird view — WASD fly · scroll altitude · G to land" : "Back on the street");
    }
    if (event.code === "KeyL") {
      // Style switch. Materials are memoised per style, so the city has to be
      // rebuilt — two seconds, and worth it for a real change of medium rather
      // than a colour filter over the same shading.
      const next = setStyle(STYLE === "anime" ? "real" : "anime");
      hud.toast(next === "anime" ? "Anime — rebuilding…" : "Photographic — rebuilding…");
      requestAnimationFrame(() => {
        scene.remove(cityRoot);
        cityRoot.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        cityRoot = buildWorld(world, scene.environment, photoFacades, facadeReads);
        scene.add(cityRoot);
        // Fresh materials, so the curvature patch has to be reapplied or the
        // bird view goes flat after a style switch.
        applyCurvatureToScene(cityRoot);
        post.setStyle(next);
        applyToneMapping();
        daylight.anime = next === "anime";
        daylight.apply(TIME_ORDER[timeIndex], sky);
        setStreetLights(TIME_PRESETS[TIME_ORDER[timeIndex]].lightsOn);
        hud.toast(next === "anime" ? "Anime" : "Photographic");
      });
    }
    if (event.code === "KeyO") {
      post.enabled = !post.enabled;
      if (post.enabled) post.resetHealth();
      localStorage.setItem("sakura:post", post.enabled ? "on" : "off");
      hud.toast(post.enabled ? "Effects on" : "Effects off");
    }
    if (event.code === "KeyN") {
      const on = mapView.minimapEl.hidden;
      mapView.setMinimapVisible(on);
      hud.toast(on ? "Minimap on" : "Minimap off");
    }
    if (!birdMode) {
      if (event.code === "KeyV") hud.toast(player.mode === "cycle" ? "Cycle" : "On foot");
      if (event.code === "KeyB") hud.toast(player.mode === "auto" ? "Auto" : "On foot");
      if (event.code === "KeyP") hud.toast(player.thirdPerson ? "Third person" : "First person");
      if (event.code === "KeyE" && currentPoi) hud.toast(describePoi(currentPoi));
    }
  });

  window.addEventListener("keyup", (event) => player.onKeyUp(event));

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // Pixel ratio before size: setSize multiplies by the current ratio, so the
    // other order sizes the buffer with the previous display's ratio.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    post.setSize();
  });

  document.addEventListener("visibilitychange", () => {
    // Reset the clock on resume, or the first frame back integrates the pause.
    // Also draw one frame immediately: requestAnimationFrame is paused while a
    // tab is hidden, so without this the canvas can be shown before the loop
    // has produced anything for the new state.
    if (!document.hidden) {
      clock.getDelta();
      post.render(0, scene, camera);
    }
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
let slowFrames = 0;

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

  if (birdMode) {
    bird.update(dt, player.keys);
    curvature.invRadius.value = curvatureForAltitude(bird.altitude, true);
    // The shadow pass renders through three's own depth material, which this
    // curvature never touches — so once the city bends, its shadows stay flat
    // and slide off the buildings that cast them. Nothing is lost by dropping
    // them: from planet altitude a 2 km shadow map resolves to nothing anyway.
    // Flipped only on the transition, because changing castShadow rebuilds
    // every program.
    const wantShadows = curvature.invRadius.value < 1e-7;
    if (wantShadows !== daylight.sun.castShadow) daylight.sun.castShadow = wantShadows;

    // Orbit out to frame the planet.
    //
    // The bird camera aims at a point on the ground, which is right for a drone
    // over a city and wrong the moment that city becomes a ball: the aim point
    // is the north pole, so the planet hangs off the bottom of the frame while
    // the camera stares past it at empty sky. As the wrap tightens, the camera
    // slides out to a distance that fits the whole sphere and re-aims at its
    // centre — so climbing reads as pulling back off the world rather than as
    // the world falling away from the shot.
    const invR = curvature.invRadius.value;
    if (invR > 1e-7) {
      const radius = 1 / invR;
      // How far into the wrap we are: 0 flat, 1 fully balled up.
      const wrap = Math.min(1, invR * PLANET_RADIUS);
      planetCentre.set(curvature.center.value.x, -radius, curvature.center.value.y);

      orbitDir.copy(camera.position).sub(planetCentre);
      const current = orbitDir.length() || 1;
      orbitDir.divideScalar(current);

      // Far enough that a sphere of this radius fits the vertical field of view,
      // with a little margin so it does not touch the frame edges.
      const framed = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.06;
      camera.position.copy(planetCentre).addScaledVector(orbitDir, THREE.MathUtils.lerp(current, framed, wrap));

      lookTarget.copy(bird.target).lerp(planetCentre, wrap);
      camera.lookAt(lookTarget);
    }
  } else {
    player.update(dt);
  }
  if (debugCam) {
    // Overrides the player camera entirely: used to inspect the built city
    // from above during verification.
    camera.position.set(debugCam.x, debugCam.y, debugCam.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(debugCam.heading);
    camera.rotateX(debugCam.pitch);
  }

  const focus = birdMode ? bird.target : player.position;
  daylight.follow(focus);
  sky.position.copy(camera.position);
  sky.material.uniforms.uCenter.value.copy(camera.position);
  sky.material.uniforms.uTime.value += dt;
  tickWater(dt);
  // Petals live in a box that follows the camera, which is right on the street
  // and wrong at 200 m: from the drone they hang centimetres off the lens and
  // read as sheets of paper over the city. Ground them.
  blossom.mesh.visible = !birdMode || bird.altitude < 45;
  if (blossom.mesh.visible) blossom.update(dt, camera.position);
  traffic.update(dt, focus);
  ambience.update(player.speed, player.mode);

  avatars.show(!birdMode && player.thirdPerson ? player.mode : null);
  if (!birdMode && player.thirdPerson) {
    avatars.update(player.position, player.heading, player.roll, player.speed);
  }

  currentPoi = birdMode ? null : nearestPoi(player.position.x, player.position.z);
  hud.setPrompt(currentPoi ? describePoi(currentPoi) : null);
  mapView.update(birdMode ? bird.target : player.position, birdMode ? bird.yaw : player.heading, dt);

  fpsAccumulator += dt;
  fpsFrames++;
  if (fpsAccumulator > 0.5) {
    fps = fpsFrames / fpsAccumulator;
    fpsAccumulator = 0;
    fpsFrames = 0;

    // Adaptive quality: drop post-processing before anything the player is
    // actually steering with. Decorative effects go first, controls never.
    if (fps < 34) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 4 && post.enabled) {
      post.enabled = false;
      hud.toast("Reduced effects to hold frame rate");
    }
  }

  const lat = world.origin.lat - player.position.z / METRES_PER_DEG_LAT;
  const lon = world.origin.lon + player.position.x / metresPerDegLon(world.origin.lat);

  hud.update({
    x: focus.x,
    z: focus.z,
    lat,
    lon,
    speed: birdMode ? 0 : Math.abs(player.speed),
    fps,
    mode: birdMode ? `Bird view · ${bird.altitude.toFixed(0)} m` : MODES[player.mode].label,
    heading: birdMode ? bird.yaw : player.heading,
    nearest: nearestLandmark(focus.x, focus.z),
  });

  post.render(dt, scene, camera);
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
