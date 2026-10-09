import * as THREE from "three";
import { PALETTE, setEnvironment } from "./materials.js";

// Sky, sun, and the environment map that everything else reflects.
//
// The gradient dome the first build used cannot light a PBR scene: with no
// environment map, every surface facing away from the sun goes to flat ambient
// grey and the whole city looks like clay. Rendering this dome into a PMREM
// cubemap and handing it to `scene.environment` is what puts warm bounce on
// west-facing walls at golden hour and cool skylight in the shadows.

const VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform vec3 uCenter;
  uniform float uCloud;      // coverage, 0..1
  uniform float uTime;
  uniform float uHaze;
  uniform float uAnime;
  varying vec3 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorld - uCenter);
    float h = dir.y;

    // Sky body. pow() biases the blend low so the warm band sits on the
    // horizon where the atmosphere actually is.
    float t = clamp(pow(max(h, 0.0), 0.42), 0.0, 1.0);
    vec3 color = mix(uHorizon, uZenith, t);
    color = mix(uGround, color, smoothstep(-0.06, 0.02, h)); // below the horizon

    // Sun: a small hot disc inside a wide Mie glow. Both are needed — the disc
    // alone reads as a sticker, the glow alone as fog. In the painted style the
    // disc is dimmed hard: a blown-out sun is a photographic artefact, and it
    // drags bloom over the whole frame.
    float cosSun = dot(dir, normalize(uSunDir));
    float disc = smoothstep(0.9986, 0.9993, cosSun);
    float glow = pow(max(cosSun, 0.0), 22.0) * 0.55 + pow(max(cosSun, 0.0), 4.0) * 0.16;
    color += uSunColor * (disc * (uAnime > 0.5 ? 2.0 : 12.0) + glow * (uAnime > 0.5 ? 0.5 : 1.0));

    // Clouds on a plane above the camera, so they converge at the horizon the
    // way real cloud decks do instead of sliding across like wallpaper.
    if (h > 0.008) {
      vec2 uv = dir.xz / max(h, 0.008) * 0.045 + vec2(uTime * 0.0022, uTime * 0.0009);
      float d = fbm(uv * 1.6);
      float d2 = fbm(uv * 3.7 + 4.0);
      float field = d * 0.72 + d2 * 0.28;
      float mask;
      if (uAnime > 0.5) {
        // Painted clouds: two hard steps and a bright rim, not a soft density.
        // A photographic cloud in a cel-shaded frame is the single loudest
        // wrong note — the sky is most of the picture.
        float core = smoothstep(0.60 - uCloud * 0.3, 0.63 - uCloud * 0.3, field);
        float skirt = smoothstep(0.52 - uCloud * 0.3, 0.55 - uCloud * 0.3, field);
        mask = skirt * 0.55 + core * 0.45;
      } else {
        mask = smoothstep(0.52 - uCloud * 0.34, 0.86 - uCloud * 0.2, field);
      }
      mask *= smoothstep(0.0, 0.16, h);                 // fade into the horizon
      // Light the cloud from the sun side; unlit cloud is the giveaway.
      float lit = 0.55 + 0.45 * smoothstep(-0.2, 0.6, cosSun);
      vec3 cloud = mix(uHorizon * 0.92, uSunColor * 1.05 + vec3(0.45), lit);
      if (uAnime > 0.5) cloud = mix(vec3(0.98, 0.96, 0.93), uSunColor * 0.55 + vec3(0.5), 0.35);
      color = mix(color, cloud, mask * 0.9);
    }

    // Aerial haze thickens towards the horizon and matches the scene fog, so
    // distant buildings dissolve into sky instead of ending at a hard line.
    color = mix(color, uHorizon, uHaze * (1.0 - smoothstep(0.0, 0.32, h)));

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createSky(radius = 3000) {
  const geometry = new THREE.SphereGeometry(radius, 40, 24);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x5f92cf) },
      uHorizon: { value: new THREE.Color(0xdfe6ea) },
      uGround: { value: new THREE.Color(0xb6ada2) },
      uSunColor: { value: new THREE.Color(0xfff2df) },
      uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.5) },
      uCenter: { value: new THREE.Vector3() },
      uCloud: { value: 0.45 },
      uTime: { value: 0 },
      uHaze: { value: 0.35 },
      uAnime: { value: 1 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sky";
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// Time of day drives sun angle, sun colour, sky pair, fog and exposure
// together. Changing one without the others is what makes a day cycle look
// wrong — a warm sun under a blue zenith reads as a broken render, not as
// evening.
export const TIME_PRESETS = {
  morning: {
    label: "Morning · 8:20",
    sun: new THREE.Vector3(-0.55, 0.42, 0.72),
    sunColor: 0xffe9cd, intensity: 3.4,
    zenith: 0x6fa0d8, horizon: 0xe8dfd2, ground: 0xb9b0a4,
    fog: 0xdfd9cf, fogDensity: 0.00034, cloud: 0.55, haze: 0.3,
    ambient: 0.5, exposure: 1.0, lightsOn: 0,
  },
  noon: {
    label: "Noon · 13:00",
    sun: new THREE.Vector3(0.18, 1.0, 0.3),
    sunColor: 0xfff6e8, intensity: 4.0,
    zenith: 0x4f86cb, horizon: 0xd9e3ea, ground: 0xb4aca2,
    fog: 0xd9e2e8, fogDensity: 0.00030, cloud: 0.5, haze: 0.24,
    ambient: 0.6, exposure: 0.95, lightsOn: 0,
  },
  golden: {
    label: "Golden hour · 18:05",
    sun: new THREE.Vector3(0.92, 0.17, -0.35),
    sunColor: 0xffc487, intensity: 3.6,
    zenith: 0x7d8fc4, horizon: 0xffc9a2, ground: 0xa89283,
    fog: 0xf0cbaf, fogDensity: 0.00040, cloud: 0.5, haze: 0.44,
    ambient: 0.45, exposure: 1.05, lightsOn: 0.08,
  },
  dusk: {
    label: "Dusk · 18:55",
    sun: new THREE.Vector3(1.0, 0.02, -0.5),
    sunColor: 0xff9a63, intensity: 1.5,
    zenith: 0x3d4a86, horizon: 0xe08d75, ground: 0x6d5f63,
    fog: 0xb99396, fogDensity: 0.00068, cloud: 0.55, haze: 0.5,
    ambient: 0.35, exposure: 1.15, lightsOn: 0.8,
  },
  night: {
    label: "Night · 21:30",
    sun: new THREE.Vector3(-0.4, 0.35, -0.6),   // moon, standing in for the sun
    sunColor: 0x9fb4d8, intensity: 0.35,
    zenith: 0x0b1330, horizon: 0x2b3050, ground: 0x14161f,
    fog: 0x1b2038, fogDensity: 0.00085, cloud: 0.4, haze: 0.35,
    ambient: 0.18, exposure: 1.5, lightsOn: 1,
  },
};

export class Daylight {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sun = new THREE.DirectionalLight(0xffe9cd, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);

    // A shadow camera sized to the whole 2 km city gives ~1 shadow texel per
    // metre — useless. It covers a moving box around the player instead, and is
    // re-centred every frame. Snapping that centre to texel-sized steps is what
    // stops shadow edges crawling as you walk.
    const extent = 110;
    const cam = this.sun.shadow.camera;
    cam.left = -extent; cam.right = extent;
    cam.top = extent; cam.bottom = -extent;
    cam.near = 1; cam.far = 620;
    this.extent = extent;
    // Shadow opacity, not just shadow softness.
    //
    // A toon material has three flat bands, so a shadow map lands on it as a
    // hard-edged region of the darkest band with no falloff at all — which is
    // where the black boxes scattered over the rooftops came from. They were
    // real shadows of real buildings, rendered as holes. Turning the shadow's
    // own intensity down keeps the shape and the information while letting the
    // fill light through, which is also exactly how shade behaves in the films
    // this is aiming at: present, soft, and never black.
    this.sun.shadow.intensity = this.anime ? 0.34 : 0.85;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;

    this.target = new THREE.Object3D();
    this.sun.target = this.target;

    // Sky/ground bounce on top of the environment map. This is the light that
    // fills shadow, and under a continuous tree canopy it is the *only* light:
    // set it too low and a tree-lined street at golden hour renders as a black
    // tunnel with a lit sky above it, which is exactly what it did at 0.55.
    this.ambient = new THREE.HemisphereLight(0xbcd0e8, 0xc0a487, 0.95);

    scene.add(this.sun, this.target, this.ambient);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envTarget = null;

    // The painted look wants more fill and a paler sky than a photographic one.
    // Toggled by main.js when the style changes.
    this.anime = true;
    this.preset = "golden";
    this.sunDirection = TIME_PRESETS.golden.sun.clone().normalize();
    this.lightsOn = 0;
  }

  setAnime(on, sky) {
    if (this.anime === on) return;
    this.anime = on;
    this.apply(this.preset, sky);
  }

  apply(name, sky) {
    const preset = TIME_PRESETS[name];
    if (!preset) return null;
    this.preset = name;
    this.sunDirection = preset.sun.clone().normalize();
    this.sun.color.set(preset.sunColor);
    this.sun.intensity = preset.intensity * (this.anime ? 1.06 : 1);
    this.sun.shadow.intensity = this.anime ? 0.34 : 0.85;
    // Fill light is the whole difference. A painted frame has almost no true
    // shade in it — the side of a building facing away from the sun is a lighter,
    // cooler version of the side facing it, not a dark one. Raising the
    // hemisphere light and pulling its colour further towards white is what
    // opens the shadows up without washing the sunlit surfaces out, because the
    // sun keeps its own intensity.
    this.ambient.intensity = preset.ambient * (this.anime ? 1.55 : 1);
    this.ambient.color.set(preset.zenith).lerp(new THREE.Color(0xffffff), this.anime ? 0.62 : 0.4);
    this.ambient.groundColor.set(this.anime ? 0xdccfbc : 0xc0a487);
    this.lightsOn = preset.lightsOn;

    if (sky) {
      const u = sky.material.uniforms;
      u.uZenith.value.set(preset.zenith);
      u.uHorizon.value.set(preset.horizon);
      u.uGround.value.set(preset.ground);
      u.uSunColor.value.set(preset.sunColor);
      u.uSunDir.value.copy(this.sunDirection);
      // Bigger, brighter cloud decks in the painted style — the tall white
      // cumulus is as much a signature of these films as the colour is.
      u.uCloud.value = this.anime ? Math.min(0.82, preset.cloud + 0.16) : preset.cloud;
      u.uHaze.value = this.anime ? preset.haze * 0.72 : preset.haze;
      this.refreshEnvironment(sky);
    }

    if (this.scene.fog) {
      this.scene.fog.color.set(preset.fog);
      this.scene.fog.density = preset.fogDensity;
    }
    const base = this.renderer.toneMapping === THREE.NoToneMapping ? preset.exposure * 0.78 : preset.exposure;
    this.renderer.toneMappingExposure = base * (this.anime ? 1.1 : 1);
    return preset;
  }

  // Re-render the sky dome into a PMREM cubemap. Cheap enough to do on every
  // time change (a few ms) and far too expensive to do per frame.
  refreshEnvironment(sky) {
    const clone = sky.clone();
    clone.material = sky.material.clone();
    clone.material.uniforms = sky.material.uniforms;   // share, do not copy
    clone.position.set(0, 0, 0);
    clone.material.uniforms.uCenter.value.set(0, 0, 0);
    this.envScene.clear();
    this.envScene.add(clone);
    // far MUST be passed. PMREMGenerator.fromScene defaults to near 0.1 / far
    // 100, and this sky dome has a radius of 4,000 — every face of the cubemap
    // clipped to nothing and the "environment map" was solid black. Symptom:
    // shadowed walls and the lake render near-black no matter how the material
    // is tuned, because the only indirect light in the scene is missing.
    const next = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 12000);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = next;
    this.scene.environment = next.texture;
    this.scene.environmentIntensity = this.preset === "night" ? 0.6 : 1.15;
    setEnvironment(next.texture);
    clone.material.uniforms.uCenter.value.set(0, 0, 0);
  }

  follow(position) {
    // Snap the shadow camera centre to whole texels. Without this the entire
    // shadow map resamples every frame and every edge in the scene shimmers.
    const texel = (this.extent * 2) / this.sun.shadow.mapSize.x;
    const snap = (v) => Math.round(v / texel) * texel;
    this.target.position.set(snap(position.x), 0, snap(position.z));
    this.sun.position.copy(this.target.position).addScaledVector(this.sunDirection, 260);
    this.sun.updateMatrixWorld();
    this.target.updateMatrixWorld();
  }
}
