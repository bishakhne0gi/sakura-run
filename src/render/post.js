import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { TexturePass } from "three/examples/jsm/postprocessing/TexturePass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Grade pass. Tone mapping alone leaves the image technically correct and
// emotionally flat: real camera footage has a vignette, a slight colour
// separation between shadow and highlight, and a touch of grain that hides
// banding in the sky gradient. These three cost one full-screen pass together.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.34 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.05 },
    uGrain: { value: 0.022 },
    uLift: { value: new THREE.Color(0.012, 0.008, 0.02) },   // cool shadows
    uGain: { value: new THREE.Color(1.02, 1.0, 0.985) },     // warm highlights
    uTime: { value: 0 },
    // Shade takes its colour from the sky, sunlit surfaces from the sun. Pushing
    // these apart is most of what makes a frame look lit rather than filled.
    uShadowTint: { value: new THREE.Color(0.88, 0.94, 1.08) },
    uHighlightTint: { value: new THREE.Color(1.07, 1.01, 0.92) },
    uSplit: { value: 0.55 },
    // Overall gain, applied before everything else. Lifting exposure and then
    // rolling the highlights off with a soft shoulder is what produces light
    // that looks *bright* rather than merely pale — raising the shoulder alone
    // just washes the picture out.
    uExposure: { value: 1.0 },
    uShoulder: { value: 0.78 },
    uShoulderStrength: { value: 0.55 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast, uGrain, uTime;
    uniform float uSplit, uShoulder, uShoulderStrength, uExposure;
    uniform vec3 uLift, uGain, uShadowTint, uHighlightTint;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;

      c *= uExposure;
      c = uLift + c * uGain;                                   // lift / gain

      // Split tone. Applying a cool cast to the whole frame just makes a cold
      // picture; what reads as *lit* is warm light and cool shade in the same
      // frame, so the two tints are weighted by luminance and pull apart.
      float l0 = luma(c);
      float shadowW = 1.0 - smoothstep(0.0, 0.55, l0);
      float lightW = smoothstep(0.45, 1.0, l0);
      c *= mix(vec3(1.0), uShadowTint, shadowW * uSplit);
      c *= mix(vec3(1.0), uHighlightTint, lightW * uSplit);

      // Contrast as an S-curve around a pivot rather than a straight multiply.
      // A linear contrast bump clips both ends: the sky posterises and every
      // shadow crushes to the same black. The pivot sits below middle grey
      // because the city is mostly mid-to-bright.
      float p = 0.42;
      c = max(vec3(0.0), c);
      c = pow(c / p, vec3(uContrast)) * p;

      // Soft shoulder, so highlights roll off instead of hitting a flat white
      // wall. This is the whole difference between "bright" and "sunlit".
      c = c / (1.0 + max(vec3(0.0), c - vec3(uShoulder)) * uShoulderStrength);

      c = mix(vec3(luma(c)), c, uSaturation);

      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * dot(d, d) * 2.2;
      c *= vig;

      // Grain, animated so it does not read as a dirty lens.
      float n = fract(sin(dot(vUv * (1.0 + fract(uTime)), vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * uGrain;

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
    }
  `,
};


// Contact shadow. What separates a rendered city from a photographed one is not
// resolution, it is that in a photograph every object is *joined* to the ground.
// A directional light plus a shadow map gives the long shadow a building throws
// and none of the short, dark, local darkening where a scooter meets asphalt,
// where a compound wall meets its footpath, or in the recess behind a balcony
// rail. Without it every prop reads as a sticker laid on the road.
//
// Deliberately not SSAO-with-normals. Reconstructing a normal from depth
// derivatives is noise at city scale — that lesson is already paid for in the
// outline pass below. This compares the centre depth against a spiral of
// neighbours and darkens where the neighbours are nearer than the centre, which
// is the definition of a concave corner and needs no normal at all. One texture
// fetch per tap, and no mip chain, so it cannot produce the artefacts that made
// bloom untrustworthy here.
const AOShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.3 },
    uFar: { value: 4000 },
    // Metres — the scale of gap to fill in: door reveals, kerb edges, the
    // underside of a parked scooter.
    uRadius: { value: 0.9 },
    // Half-height of the frustum at unit distance, so a world radius converts
    // to a pixel radius that shrinks correctly with distance.
    uFocal: { value: 1.0 },
    uStrength: { value: 0.72 },
    // Depth differences past this are a different object, not a corner. Counting
    // them draws a dark halo around every silhouette.
    uCutoff: { value: 2.4 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uNear, uFar, uRadius, uFocal, uStrength, uCutoff;
    varying vec2 vUv;

    float linearDepth(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float zc = linearDepth(vUv);

      // Sky, and anything far enough that the AO radius is sub-pixel anyway.
      if (zc > uFar * 0.9 || zc > 260.0) { gl_FragColor = base; return; }

      // World radius to uv radius, falling off as 1/z exactly like the object.
      float r = (uRadius * uFocal) / max(zc, 0.6);
      vec2 radius = vec2(r) * vec2(uTexel.y / uTexel.x, 1.0) * 0.5;

      // 12 taps on a golden-angle spiral, rotated per pixel so the pattern does
      // not print itself onto flat walls as a visible weave.
      float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
      float occ = 0.0;
      const int TAPS = 12;
      for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float ang = jitter + fi * 2.3999632;   // golden angle
        float rad = sqrt(fi / float(TAPS));    // even areal coverage
        float zs = linearDepth(vUv + vec2(cos(ang), sin(ang)) * radius * rad);
        float diff = zc - zs;                  // positive: neighbour is nearer
        // Ramp in past a small bias, so a flat surface seen at a grazing angle
        // does not shade itself, and out again past the cutoff.
        occ += smoothstep(0.02, 0.22, diff) * (1.0 - smoothstep(uCutoff * 0.5, uCutoff, diff));
      }
      occ /= float(TAPS);

      float fade = 1.0 - smoothstep(120.0, 260.0, zc);
      float ao = 1.0 - occ * uStrength * fade;

      // Multiply, but tinted. Occlusion removes *sky* light, and the sky is
      // blue, so a shaded crevice loses proportionally more blue than red.
      vec3 shade = vec3(ao) + vec3(0.035, 0.012, 0.0) * (1.0 - ao);
      gl_FragColor = vec4(base.rgb * shade, base.a);
    }
  `,
};


// Ink. The single largest contributor to the reference's look — an anime frame
// is line art with flat colour poured inside it, and no amount of palette work
// substitutes for the line.
//
// Edges come from the depth buffer the scene pass already wrote, so this costs
// one full-screen pass rather than a second render of the city. Two kinds of
// edge are needed and they behave differently:
//
//   silhouette — a jump in depth. Cheap, and gives the outline around every
//                building, tree and vehicle against what is behind it.
//   crease     — a jump in the *surface angle* with no jump in depth: the
//                corner where two walls of the same building meet. Without it
//                a building reads as a flat sticker of its own silhouette.
//
// The crease term needs normals, which are reconstructed from depth by taking
// derivatives of the view-space position. That is why the depth texture is a
// float: at 16-bit the reconstruction is too noisy to threshold.
const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.1 },
    uFar: { value: 6000 },
    uInk: { value: new THREE.Color(0x2f2a3d) },
    // In device pixels. At DPR 2 a thickness of 1 is half a CSS pixel — a line
    // that is technically drawn and visually absent.
    uThickness: { value: 2.0 },
    uDepthEdge: { value: 0.55 },
    uNormalEdge: { value: 1.4 },
    uStrength: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uNear, uFar, uThickness, uDepthEdge, uNormalEdge, uStrength;
    uniform vec3 uInk;
    varying vec2 vUv;

    // Linear distance from the camera, in metres.
    float linearDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(d, uNear, uFar);
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 o = uTexel * uThickness;

      float zc = linearDepth(vUv);
      if (zc > uFar * 0.9) { gl_FragColor = base; return; }   // sky: nothing to outline

      float zl = linearDepth(vUv - vec2(o.x, 0.0));
      float zr = linearDepth(vUv + vec2(o.x, 0.0));
      float zu = linearDepth(vUv + vec2(0.0, o.y));
      float zd = linearDepth(vUv - vec2(0.0, o.y));

      // Tolerances scale with distance — and they have to scale *faster* than
      // linearly. A 24-bit depth buffer over 0.3 to 4000 m resolves to whole
      // metres by a few hundred metres out, so the read itself is noisy at that
      // range; a linear tolerance is swamped by that noise and the drone view
      // inks solid. The quadratic term is the depth buffer's own error curve.
      float scale = 0.05 + zc * 0.05 + zc * zc * 0.0009;

      // And past ~300 m stop drawing lines at all. A silhouette that far away
      // is thinner than a pixel: there is nothing to draw, only noise to
      // amplify.
      float range = 1.0 - smoothstep(180.0, 320.0, zc);
      if (range <= 0.001) { gl_FragColor = base; return; }

      // Silhouette: a first-order jump in depth. This is the outline around
      // every building, tree and vehicle against whatever is behind it.
      float jump = max(max(abs(zc - zl), abs(zc - zr)), max(abs(zc - zu), abs(zc - zd)));
      float silhouette = smoothstep(uDepthEdge * scale, uDepthEdge * scale * 2.6, jump);

      // How many of the four neighbours jumped?
      //
      // Foliage is alpha-tested, so it writes depth only where there is a leaf
      // and every hole in the canopy is a depth cliff. Close up, that is a
      // cliff at nearly every pixel, and the outline fills whole trees in solid
      // ink — which is what turned the canopies into black rectangles. A real
      // edge — a wall against the sky, a kerb against the road — has one or two
      // neighbours across the discontinuity. Foliage interior has three or
      // four. Counting them separates the two for free.
      float t = uDepthEdge * scale;
      float crowd = step(t, abs(zc - zl)) + step(t, abs(zc - zr))
                  + step(t, abs(zc - zu)) + step(t, abs(zc - zd));
      silhouette *= 1.0 - smoothstep(2.0, 3.4, crowd);

      // Crease: a second-order change — the corner where two walls of the same
      // building meet, which has no depth jump at all. A Laplacian of linear
      // depth finds it and, unlike normals reconstructed from depth, survives
      // the precision of a 0.3-to-4000 m depth buffer. Reconstructed normals
      // were noise at this range, which inked the entire frame.
      float laplacian = abs(4.0 * zc - zl - zr - zu - zd);
      float crease = smoothstep(uNormalEdge * scale, uNormalEdge * scale * 3.0, laplacian);
      // Fade creases out with distance — 2,000 buildings all drawing their own
      // corners at 300 m is a smear, not a drawing.
      crease *= 1.0 - smoothstep(50.0, 150.0, zc);

      float edge = clamp(max(silhouette, crease * 0.85), 0.0, 1.0) * uStrength * range;
      gl_FragColor = vec4(mix(base.rgb, uInk, edge), base.a);
    }
  `,
};

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.enabled = true;
    this._pixel = new Uint8Array(4);
    this._frames = 0;
    this._blackChecks = 0;
    this.onFallback = null;

    // Device pixels, not CSS pixels. `renderer.getSize()` returns CSS size, so
    // on a Retina display (DPR 2) it builds a 1920x929 target while the
    // drawing buffer is 3840x1858. The full-screen passes then render with the
    // renderer's viewport — device pixels — into a target half that size, and
    // every fragment outside the target's bounds is discarded. On screen that
    // is a hard-edged black rectangle over most of the frame, worst in bird
    // view where there is most to draw. It renders perfectly on a DPR 1
    // display, which is what made it look intermittent.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // HalfFloat target: bloom needs values above 1.0 to threshold against, and
    // an 8-bit buffer clamps them away before the pass ever sees them.
    //
    // `samples` stays at 0, deliberately. A *multisampled* half-float target
    // fails to resolve correctly on some drivers — a large rectangular block of
    // the resolved texture comes back black, which reads on screen as the whole
    // middle of the frame being missing. It showed up first in bird view, where
    // the scene is heaviest, and disappears the moment either post-processing or
    // MSAA is switched off. Nothing is lost by dropping it: SMAA at the end of
    // the chain is what anti-aliases this image, which is why it is there.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
    });

    // The scene is rendered into a target this class owns, and the composer is
    // fed that target's texture — rather than letting EffectComposer's own
    // RenderPass draw into one of its ping-pong buffers.
    //
    // The reason is the outline pass, which needs the scene's depth. Attaching
    // a depth texture to a composer buffer does not work here: the composer
    // clones the target for the second half of its ping-pong, swaps them every
    // frame, and neither clone ever came back with depth written — sampling
    // either one returned a flat constant, which is an outline pass that either
    // does nothing or inks the whole frame depending on where the threshold
    // lands. Owning the scene target removes the guesswork: this code renders
    // into it, so this code knows its depth is there.
    this.sceneTarget = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.sceneTarget.depthTexture.format = THREE.DepthFormat;
    this.sceneTarget.depthTexture.type = THREE.FloatType;
    // A depth attachment on the scene target, so the outline pass can read the
    // depth the scene pass already produced instead of rendering the city a
    // second time. Float, not 16-bit: the crease term reconstructs normals from
    // depth derivatives, and at 16-bit that reconstruction is pure noise.
    target.depthTexture = new THREE.DepthTexture(size.x, size.y);
    target.depthTexture.format = THREE.DepthFormat;
    target.depthTexture.type = THREE.FloatType;
    // EffectComposer clones this target for the second half of the ping-pong,
    // and the clone gets its own depth texture — which is what makes binding a
    // single one at construction time wrong.

    this.composer = new EffectComposer(renderer, target);
    // EffectComposer keeps its own width/height in CSS pixels and multiplies by
    // its pixel ratio on every setSize. Told the ratio explicitly, and given a
    // CSS-pixel size, its bookkeeping and the target agree from the first frame
    // and stay agreeing across resizes and display changes.
    this.composer.setPixelRatio(renderer.getPixelRatio());
    const css = renderer.getSize(new THREE.Vector2());
    this.composer.setSize(css.x, css.y);
    // needsSwap stays false, like RenderPass. TexturePass writes into the
    // composer's *read* buffer; asking for a swap after it means the next pass
    // reads the other buffer — the one nothing was written to — and the colour
    // vanishes, leaving the outline drawing on an empty frame.
    this.composer.addPass(new TexturePass(this.sceneTarget.texture));

    // AO before the ink, so the line art draws on top of the shading rather
    // than getting darkened by it.
    this.ao = new ShaderPass(AOShader);
    this.ao.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.composer.addPass(this.ao);

    this.outline = new ShaderPass(OutlineShader);
    this.outline.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    // tDepth is bound per frame in render(), not here. EffectComposer starts
    // with writeBuffer = renderTarget1 and readBuffer = renderTarget2, and
    // RenderPass draws into the *read* buffer — so the scene depth lands in
    // renderTarget2, whose depth texture is a separate clone of this one.
    // Binding renderTarget1's depth here samples a texture nothing ever writes:
    // a constant, zero deltas, and an outline pass that silently does nothing.
    // The buffers also swap every frame, so there is no fixed answer.
    this.outline.uniforms.uNear.value = camera.near;
    this.outline.uniforms.uFar.value = camera.far;
    this.composer.addPass(this.outline);
    this.camera = camera;

    // Restrained: the sun disc, lit signage and specular on wet asphalt should
    // bloom. Nothing else should.
    // Device pixels, like the composer. UnrealBloomPass builds its own mip
    // chain from this resolution and composites the result back into the
    // composer's buffer; handed CSS pixels while the buffer is twice that, the
    // composite comes back black on a Retina display. Same mismatch, second
    // place it hides.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.55, 0.86);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaa);
  }

  // Takes no dimensions on purpose.
  //
  // Every black-frame bug in this renderer has been the same bug: one part of
  // the chain sized in CSS pixels while another was sized in device pixels, so
  // a full-screen pass wrote outside its target and the rest came back black.
  // Passing sizes in from the caller is what made that possible three separate
  // times — window.innerHeight is not the canvas height, and the canvas height
  // is not the drawing buffer height. So nothing is passed: every size is read
  // back from the renderer, which is the only thing that knows the truth.
  setSize() {
    const css = this.renderer.getSize(new THREE.Vector2());
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(css.x, css.y);
    this.sceneTarget.setSize(buffer.x, buffer.y);
    this.bloom.setSize(buffer.x, buffer.y);
    this.smaa.setSize(buffer.x, buffer.y);
    this.outline.uniforms.uTexel.value.set(1 / buffer.x, 1 / buffer.y);
    this.ao.uniforms.uTexel.value.set(1 / buffer.x, 1 / buffer.y);
  }

  // Called when the player toggles effects back on by hand. Without this the
  // strike count survives the toggle, so one more bad sample can switch the
  // chain off again immediately and it reads as the key not working.
  resetHealth() {
    this._blackChecks = 0;
    this._frames = 0;
  }

  // The outline is the style. Off in the realistic mode, on in the anime one.
  setStyle(style) {
    const anime = style === "anime";
    this.outline.enabled = anime;
    // Bloom is off in the painted style, for two reasons that agree.
    //
    // It is wrong for the look: a cel frame does not glow, and the reference
    // has no bloom in it at all. And it is the pass that has produced every
    // hard-edged black block in this renderer — at altitude it blacked whole
    // frames, and at street level it leaves rectangular holes. Its mip chain
    // is the most driver-sensitive thing in the chain, and it is contributing
    // nothing here worth defending.
    this.style = style;

    // The painted look is high-key, and high-key is a specific set of choices
    // rather than "brighter". A Ghibli frame has: blacks lifted well off zero so
    // nothing is ever a hole; contrast *below* one, so the whole picture sits in
    // the upper midtones; highlights rolled off early and softly so sunlit
    // surfaces bleed towards white instead of clipping to it; saturation up, but
    // with the shadow tint warm rather than cold — shade in those films is a
    // warm violet-grey, never blue steel. And almost no vignette: the corners of
    // the frame are as bright as the middle, which is most of why the image
    // feels open and airy rather than cinematic and closed-in.
    this.grade.uniforms.uExposure.value = anime ? 1.14 : 1.0;
    this.grade.uniforms.uContrast.value = anime ? 0.84 : 1.05;
    this.grade.uniforms.uSaturation.value = anime ? 1.2 : 1.06;
    this.grade.uniforms.uVignette.value = anime ? 0.03 : 0.34;
    this.grade.uniforms.uGrain.value = anime ? 0.004 : 0.022;
    this.grade.uniforms.uLift.value.setRGB(anime ? 0.075 : 0.012, anime ? 0.076 : 0.008, anime ? 0.082 : 0.02);
    this.grade.uniforms.uGain.value.setRGB(anime ? 1.03 : 1.02, anime ? 1.015 : 1.0, anime ? 0.99 : 0.985);
    this.grade.uniforms.uShadowTint.value.setRGB(
      anime ? 0.98 : 0.88, anime ? 0.97 : 0.94, anime ? 1.04 : 1.08);
    this.grade.uniforms.uHighlightTint.value.setRGB(
      anime ? 1.06 : 1.07, anime ? 1.02 : 1.01, anime ? 0.95 : 0.92);

    // Bloom stays off in the painted style. Not a taste call — it is broken.
    //
    // Re-enabled once on the theory that the earlier "it produces black frames"
    // diagnosis had been contaminated by the frame-health check reading the
    // buffer after the swap. Fixing that check did not fix bloom: at 460 m in
    // bird view it blacks out most of the frame, with hard rectangular stepped
    // edges that are its mip chain rather than anything in the scene. Toggling
    // only this pass off, changing nothing else, brings the whole city back.
    //
    // The Ghibli glow is therefore carried by the grade — lifted blacks and an
    // early, soft highlight shoulder — which produces the luminous look without
    // a mip chain to fall over.
    this.bloom.enabled = !anime;
    this.bloom.strength = anime ? 0 : 0.28;
    this.bloom.threshold = anime ? 0.72 : 0.86;
    this.bloom.radius = anime ? 0.75 : 0.55;

    // A cel frame gets its shape from the line and from flat colour, so heavy
    // gradient shading fights it — but dropping AO to zero is what makes props
    // float. Keep the contact darkening, tighten its radius, halve its weight.
    this.ao.uniforms.uStrength.value = anime ? 0.26 : 0.78;
    this.ao.uniforms.uRadius.value = anime ? 0.6 : 0.95;
    // Painted skies are broad and warm; photographic ones separate harder.
    this.grade.uniforms.uSplit.value = anime ? 0.42 : 0.62;
    this.grade.uniforms.uShoulder.value = anime ? 0.84 : 0.76;
  }

  // Night wants more bloom (every shopfront is a light source); noon wants
  // almost none or the whole city hazes over.
  setPreset(name) {
    const anime = this.style === "anime";
    this.bloom.strength = name === "night" ? 0.62 : name === "dusk" ? 0.42 : name === "golden" ? 0.34 : 0.22;
    if (anime) this.bloom.strength = 0;   // see setStyle: bloom is disabled here
    // The painted style keeps its open, high-key frame at every hour — dropping
    // a heavy vignette and desaturating at night is a live-action instinct and
    // it undoes the whole look in one call.
    this.grade.uniforms.uVignette.value = anime ? 0.03 : (name === "night" ? 0.5 : 0.34);
    this.grade.uniforms.uSaturation.value = anime ? 1.2 : (name === "night" ? 1.0 : 1.06);
  }

  // Watchdog. Post-processing is the one part of this renderer that can fail in
  // a driver rather than in the code, and its failure mode is a black frame
  // with no error and no dropped frame rate — so nothing else notices. Sample
  // five pixels twice a second; if every one of them is pure black several
  // checks running, the chain is not producing an image and we fall back to
  // rendering the scene directly. A real frame always has something non-black
  // in it, even at night, where the sky sits around (11, 19, 48).
  checkFrameHealth() {
    const gl = this.renderer.getContext();
    const { width, height } = this.renderer.domElement;
    if (!width || !height) return;
    const points = [
      [width >> 1, height >> 1],
      [width >> 2, height >> 2],
      [(width * 3) >> 2, height >> 2],
      [width >> 2, (height * 3) >> 2],
      [(width * 3) >> 2, (height * 3) >> 2],
    ];
    let black = 0;
    for (const [x, y] of points) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._pixel);
      if (this._pixel[0] < 3 && this._pixel[1] < 3 && this._pixel[2] < 3) black++;
    }
    if (black === points.length) {
      this._blackChecks++;
      if (this._blackChecks >= 3) {
        this.enabled = false;
        this._blackChecks = 0;
        console.warn("[post] the effects chain produced only black frames; falling back to direct rendering (press O to retry)");
        this.onFallback?.();
      }
    } else {
      this._blackChecks = 0;
    }
  }

  render(dt, scene, camera) {
    if (this.enabled) {
      // The inverse projection changes whenever the field of view does — and it
      // does, every time the player speeds up or switches vehicle.
      this.outline.uniforms.uNear.value = camera.near;
      this.outline.uniforms.uFar.value = camera.far;
      this.ao.uniforms.uNear.value = camera.near;
      this.ao.uniforms.uFar.value = camera.far;
      // Field of view changes every time the player speeds up or changes
      // vehicle, and the AO radius is measured in metres, so it has to track it.
      this.ao.uniforms.uFocal.value = 1 / Math.tan((camera.fov * Math.PI) / 360);

      this._frames += 1;
    }
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    // Scene first, into our own target, so colour and depth land together.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    this.grade.uniforms.uTime.value += dt;
    this.composer.render(dt);

    // Health check *after* the frame is drawn, never before it.
    //
    // readPixels reads whatever is bound right now, and at the top of a frame
    // the default framebuffer has already been presented and swapped — so on
    // macOS it reads back black no matter how good the frame was. The watchdog
    // was therefore firing on a perfectly healthy renderer, disabling the whole
    // chain and reporting "Effects failed on this GPU". Pressing O turned
    // effects on and the next check turned them straight back off, which is
    // exactly the loop that made O look broken.
    //
    // Read here and the composer's last pass has just written the drawing
    // buffer, so what comes back is this frame's actual pixels.
    if (this._frames % 30 === 0) this.checkFrameHealth();
  }
}
