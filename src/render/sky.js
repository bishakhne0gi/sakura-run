import * as THREE from "three";
import { PALETTE } from "./toon.js";

// A gradient dome, not a skybox. The reference's sky is two flat colours with a
// wide soft blend and no clouds above the horizon band, which a shader gives us
// for one draw call and no texture memory.
const VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uCenter;
  uniform float uSunHeight;
  varying vec3 vWorld;

  void main() {
    float h = normalize(vWorld - uCenter).y;
    // pow() biases the blend towards the horizon so the warm band stays low
    // and wide, the way it reads in the reference.
    float t = clamp(pow(max(h, 0.0), 0.42), 0.0, 1.0);
    vec3 color = mix(uHorizon, uTop, t);
    // Lift the whole sky slightly when the sun is low: golden hour.
    color += (1.0 - uSunHeight) * vec3(0.06, 0.02, 0.0) * (1.0 - t);
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createSky(radius = 1600) {
  const geometry = new THREE.SphereGeometry(radius, 24, 16);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(PALETTE.sky.top) },
      uHorizon: { value: new THREE.Color(PALETTE.sky.horizon) },
      uCenter: { value: new THREE.Vector3() },
      uSunHeight: { value: 0.55 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sky";
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// Time of day drives sun angle, light colour, and the sky pair together —
// changing one without the others is what makes a day cycle look wrong.
export const TIME_PRESETS = {
  morning: {
    label: "Morning",
    sun: new THREE.Vector3(-0.45, 0.55, 0.7),
    sunColor: 0xfff0dd,
    intensity: 2.5,
    ambient: 0xbcd0e8,
    ambientIntensity: 0.95,
    skyTop: 0x9dc3e0,
    skyHorizon: 0xfbdfd2,
    fog: 0xf0dcd6,
  },
  noon: {
    label: "Noon",
    sun: new THREE.Vector3(0.2, 1.0, 0.35),
    sunColor: 0xfffaf0,
    intensity: 2.9,
    ambient: 0xc8dbf0,
    ambientIntensity: 1.05,
    skyTop: 0x86b8e2,
    skyHorizon: 0xe8eef2,
    fog: 0xdfe8ee,
  },
  golden: {
    label: "Golden hour",
    sun: new THREE.Vector3(0.85, 0.28, -0.45),
    sunColor: 0xffd7a8,
    intensity: 2.7,
    ambient: 0xd8bcc8,
    ambientIntensity: 0.85,
    skyTop: 0xa9b8dd,
    skyHorizon: 0xffd2b8,
    fog: 0xf6d3c2,
  },
  dusk: {
    label: "Dusk",
    sun: new THREE.Vector3(1.0, 0.1, -0.6),
    sunColor: 0xffb98f,
    intensity: 1.5,
    ambient: 0x8f93c4,
    ambientIntensity: 0.8,
    skyTop: 0x6e7bb5,
    skyHorizon: 0xf0a693,
    fog: 0xc9a6ae,
  },
};

export class Daylight {
  constructor(scene, worldRadius = 1100) {
    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);

    // A shadow camera sized to the whole 2 km city gives useless resolution, so
    // it covers a moving box around the player instead and is re-centred each
    // frame. Without the re-centre, shadows vanish once you walk 200 m.
    const extent = 90;
    this.sun.shadow.camera.left = -extent;
    this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent;
    this.sun.shadow.camera.bottom = -extent;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.9;

    this.target = new THREE.Object3D();
    this.sun.target = this.target;

    this.ambient = new THREE.HemisphereLight(0xbcd0e8, 0xd8c8b0, 0.95);

    scene.add(this.sun, this.target, this.ambient);
    this.scene = scene;
    this.preset = "morning";
    this.sunDirection = TIME_PRESETS.morning.sun.clone().normalize();
  }

  apply(name, sky) {
    const preset = TIME_PRESETS[name];
    if (!preset) return;
    this.preset = name;
    this.sunDirection = preset.sun.clone().normalize();
    this.sun.color.set(preset.sunColor);
    this.sun.intensity = preset.intensity;
    this.ambient.color.set(preset.ambient);
    this.ambient.intensity = preset.ambientIntensity;
    if (sky) {
      sky.material.uniforms.uTop.value.set(preset.skyTop);
      sky.material.uniforms.uHorizon.value.set(preset.skyHorizon);
      sky.material.uniforms.uSunHeight.value = preset.sun.y;
    }
    if (this.scene.fog) this.scene.fog.color.set(preset.fog);
    return preset;
  }

  follow(position) {
    this.target.position.copy(position);
    this.sun.position.copy(position).addScaledVector(this.sunDirection, 180);
    this.sun.updateMatrixWorld();
    this.target.updateMatrixWorld();
  }
}
