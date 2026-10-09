import * as THREE from "three";

// Tabebuia petals, built on the falling-leaves mechanism from the Skills repo:
// the petal tumbles on its own axis so it presents a face, thins to an edge,
// and opens out again — and its sideways slip is driven by that same tumble,
// ninety degrees out of phase. Drive the slip from an independent sine and the
// eye reads a wobble or an easing bug instead of a petal caught by the air.
//
// The field is a box that follows the camera, so 1,800 petals cover a 2 km city.

const VERTEX = /* glsl */ `
  attribute vec3 seed;      // x: phase, y: tumble rate, z: size
  attribute vec3 origin;    // spawn point inside the follow box
  attribute float tint;

  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec3 uExtent;
  uniform float uFall;
  uniform float uWind;
  uniform float uFrozen;

  varying float vShade;
  varying float vTint;

  void main() {
    float phase = seed.x * 6.2831853;
    float rate = seed.y;
    float size = seed.z;

    // Position inside the box, wrapped so the field never runs out.
    vec3 p = origin;
    float t = uFrozen > 0.5 ? seed.x * 40.0 : uTime;

    p.y -= t * uFall * (0.6 + size * 0.8);
    p.y = mod(p.y - uCenter.y + uExtent.y, uExtent.y * 2.0) - uExtent.y + uCenter.y;

    // The tumble angle. Everything else follows from it.
    float tumble = t * rate + phase;

    // Slip: driven by cos of the same angle the face-presentation uses sin of.
    // Ninety degrees out of phase means the petal slides fastest exactly when
    // it is edge-on and has least resistance, which is what sells it.
    p.x += cos(tumble) * (0.55 + size) + sin(t * 0.21 + phase) * uWind;
    p.z += sin(tumble * 0.73 + phase) * (0.4 + size * 0.7) + cos(t * 0.17 + phase) * uWind * 0.7;

    p.x = mod(p.x - uCenter.x + uExtent.x, uExtent.x * 2.0) - uExtent.x + uCenter.x;
    p.z = mod(p.z - uCenter.z + uExtent.z, uExtent.z * 2.0) - uExtent.z + uCenter.z;

    // Two baked faces: the quad is scaled on one axis by sin(tumble), so it
    // genuinely thins to a line at the crossing rather than fading out.
    float face = sin(tumble);
    vShade = abs(face);
    vTint = tint;

    vec3 billboardX = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
    vec3 billboardY = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);

    float spin = tumble * 0.35;
    vec2 corner = position.xy * size;
    vec2 spun = vec2(
      corner.x * cos(spin) - corner.y * sin(spin),
      corner.x * sin(spin) + corner.y * cos(spin)
    );
    spun.x *= face;   // the edge-on crossing

    vec3 world = p + billboardX * spun.x + billboardY * spun.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
  uniform float uOpacity;
  varying float vShade;
  varying float vTint;

  void main() {
    // Flat two-tone to match the cel-shaded world: the near-edge-on face reads
    // darker, the open face reads bright.
    vec3 color = mix(uPetalA, uPetalB, vTint);
    color *= 0.72 + 0.28 * vShade;
    gl_FragColor = vec4(color, uOpacity);
  }
`;

export class BlossomField {
  constructor({ count = 1800, extent = new THREE.Vector3(55, 26, 55), reducedMotion = false } = {}) {
    const geometry = new THREE.InstancedBufferGeometry();
    // A tabebuia petal is ~4 cm. At the 0.16 x 0.1 m this started on, times a
    // size multiplier of up to 2.2, petals rendered as 35 cm cards — playing
    // cards drifting past the camera, not blossom.
    const quad = new THREE.PlaneGeometry(0.085, 0.055);
    geometry.index = quad.index;
    geometry.attributes.position = quad.attributes.position;
    geometry.attributes.uv = quad.attributes.uv;

    const seed = new Float32Array(count * 3);
    const origin = new Float32Array(count * 3);
    const tint = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = 1.1 + Math.random() * 2.4;   // tumble rate
      seed[i * 3 + 2] = 0.6 + Math.random() * 1.1;   // size
      origin[i * 3] = (Math.random() * 2 - 1) * extent.x;
      origin[i * 3 + 1] = (Math.random() * 2 - 1) * extent.y;
      origin[i * 3 + 2] = (Math.random() * 2 - 1) * extent.z;
      tint[i] = Math.random();
    }

    geometry.setAttribute("seed", new THREE.InstancedBufferAttribute(seed, 3));
    geometry.setAttribute("origin", new THREE.InstancedBufferAttribute(origin, 3));
    geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tint, 1));
    geometry.instanceCount = count;

    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uExtent: { value: extent.clone() },
      uFall: { value: 1.35 },
      uWind: { value: 1.4 },
      uFrozen: { value: reducedMotion ? 1 : 0 },
      uPetalA: { value: new THREE.Color(0xf7b9cf) },
      uPetalB: { value: new THREE.Color(0xfde3ec) },
      uOpacity: { value: 0.95 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false; // the field is always around the camera
    this.mesh.name = "blossom";
    this.mesh.renderOrder = 2;
    this.quad = quad;
  }

  update(dt, cameraPosition) {
    if (this.uniforms.uFrozen.value < 0.5) this.uniforms.uTime.value += dt;
    this.uniforms.uCenter.value.copy(cameraPosition);
  }

  setDensity(scale) {
    const total = this.mesh.geometry.attributes.seed.count;
    this.mesh.geometry.instanceCount = Math.max(0, Math.round(total * scale));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
