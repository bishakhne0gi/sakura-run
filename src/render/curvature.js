import * as THREE from "three";

// Small-planet curvature for the bird view.
//
// On the ground the world is flat, as it should be. As the drone climbs, the
// city bends away from its own centre until, from high enough, HSR reads as a
// globe hanging in the sky with nothing else on it — the two square kilometres
// curving over its own horizon in every direction.
//
// This is a true spherical wrap, not the usual parabolic fake.
//
// The first version displaced height by the square of the distance from centre —
// y -= d^2 * k — which is what most "curved world" shaders do. It bends the
// horizon convincingly but it can never close: the ground keeps spreading
// outward while only sagging downward, so however hard you push it you get a
// dished plate, never a ball.
//
// To get a complete globe the ground has to wrap *around*, which means moving
// vertices horizontally as well as vertically. Distance from the centre becomes
// arc length on a sphere of radius R:
//
//     theta = d / R                  how far around the ball this point sits
//     xz    = centre + dir * (R+h) * sin(theta)
//     y     = (R+h) * cos(theta) - R
//
// The centre of the map stays exactly where it is and becomes the north pole;
// everything else rotates down and around it. A point's own height h rides along
// the local up direction, so buildings stand off the surface radially — they
// lean outward near the horizon, exactly as they would on a real small planet.
//
// R is chosen so HSR covers the whole sphere: the far corners of the map land at
// theta = pi, the antipode. There is nothing else on this planet because there
// is no room for anything else.
//
// Nothing about collision, movement or the roads changes — the geometry is bent
// at draw time only. Walk to the map edge on foot and the ground is still flat
// under you, which is the right trade: the globe is a way of *looking* at HSR,
// not a different place to walk around.
export const curvature = {
  // Reciprocal of the sphere radius, in 1/metres. 0 is flat — and it has to be
  // the reciprocal rather than the radius itself, because "flat" is R = infinity
  // and a shader cannot be handed infinity.
  invRadius: { value: 0 },
  // Wrapping around the world origin keeps HSR itself as the planet, rather than
  // whatever the camera happens to be over.
  center: { value: new THREE.Vector2(0, 0) },
};

// three assembles the vertex shader from named chunks. <project_vertex> is the
// one that takes `transformed` — the final object-space position, after skinning
// and morphing — and puts it into clip space. Replacing that chunk means the
// bend is applied to every vertex exactly once, after instancing, which is what
// makes it work identically for merged city meshes and for the instanced trees,
// props and traffic without needing to know which is which.
const PROJECT_VERTEX = /* glsl */ `
  vec4 curvedWorld = vec4( transformed, 1.0 );

  #ifdef USE_INSTANCING
    curvedWorld = instanceMatrix * curvedWorld;
  #endif

  curvedWorld = modelMatrix * curvedWorld;

  if ( uInvRadius > 1e-7 ) {
    float R = 1.0 / uInvRadius;
    vec2 rel = curvedWorld.xz - uCurveCenter;
    float d = length( rel );
    // Arc length around the sphere. The map centre is the pole and stays put.
    float theta = d * uInvRadius;
    vec2 dir = d > 1e-4 ? rel / d : vec2( 0.0 );
    // Height rides along the local up, so buildings stand radially off the
    // surface and lean outward towards the horizon like a real small planet.
    float rr = R + curvedWorld.y;
    curvedWorld.xz = uCurveCenter + dir * ( rr * sin( theta ) );
    curvedWorld.y = rr * cos( theta ) - R;
  }

  vec4 mvPosition = viewMatrix * curvedWorld;

  gl_Position = projectionMatrix * mvPosition;
`;

const patched = new WeakSet();

export function applyCurvature(material) {
  if (!material || patched.has(material)) return material;
  patched.add(material);

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uInvRadius = curvature.invRadius;
    shader.uniforms.uCurveCenter = curvature.center;
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float uInvRadius;\nuniform vec2 uCurveCenter;\nvoid main() {")
      .replace("#include <project_vertex>", PROJECT_VERTEX);
  };
  // Materials already uploaded to the GPU need their program rebuilt.
  material.needsUpdate = true;
  return material;
}

// Patches everything currently under a root. Safe to call again after more of
// the world is added — already-patched materials are skipped.
export function applyCurvatureToScene(root) {
  let count = 0;
  root.traverse((object) => {
    const material = object.material;
    if (!material) return;
    if (Array.isArray(material)) {
      for (const m of material) if (!patched.has(m)) { applyCurvature(m); count += 1; }
    } else if (!patched.has(material)) {
      applyCurvature(material);
      count += 1;
    }
  });
  return count;
}

// Altitude in metres to curvature. Flat for the first stretch of the climb, so
// the drone still reads as a drone over a real city at rooftop height, then
// bending in as it rises to the point where the whole layout is in frame.
const FLAT_UNTIL = 60;
const FULL_AT = 620;

// The furthest corner of the map from its centre. HSR's bounds run to roughly
// +/-1,070 m on each axis, so the diagonal corner sits about 1,510 m out.
const MAP_REACH = 1510;
// Radius at which that corner lands at theta = pi — the far pole. At this radius
// the map wraps the sphere completely, which is what makes it a whole planet
// rather than a cap of city on a ball of nothing.
export const PLANET_RADIUS = MAP_REACH / Math.PI;   // ~481 m

export function curvatureForAltitude(altitude, active) {
  if (!active) return 0;
  const t = THREE.MathUtils.clamp((altitude - FLAT_UNTIL) / (FULL_AT - FLAT_UNTIL), 0, 1);
  // Eased, so the world does not visibly snap into a ball at one altitude.
  const eased = t * t * (3 - 2 * t);
  // Interpolating the reciprocal, not the radius: flat is R = infinity, and
  // 1/R moves smoothly from 0 where the parameter itself cannot.
  return (1 / PLANET_RADIUS) * eased;
}
