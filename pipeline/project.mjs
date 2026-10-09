// Shared camera model for stages 4 and 5.
//
// Mapillary reconstructions come out of OpenSfM, so its conventions are the ones
// that apply — and getting any one of them wrong produces facade textures that
// are plausible-looking crops of the wrong part of the photo, which is worse
// than no texture at all. Written down explicitly:
//
//   world frame   ENU — x East, y North, z Up — with an origin that does not
//                 matter here, because only camera-relative vectors are used.
//   camera frame  x right, y DOWN, z forward.
//   rotation      computed_rotation is angle-axis, world -> camera.
//   translation   not exposed by the API. But the camera's own position is
//                 (computed_geometry, computed_altitude), and
//                 X_cam = R * (X_world - C) needs nothing else.
//   focal         camera_parameters[0], normalised by max(width, height) — not
//                 by width, and not in pixels.
//
// The local metres this project uses are x = East, z = -North, y = Up, so a
// world-space point converts to ENU by flipping z.

const METRES_PER_DEG_LAT = 110574;
const metresPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// Rodrigues: angle-axis to a 3x3 row-major matrix.
export function rotationMatrix([rx, ry, rz]) {
  const theta = Math.hypot(rx, ry, rz);
  if (theta < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [rx / theta, ry / theta, rz / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

const apply = (m, [x, y, z]) => [
  m[0] * x + m[1] * y + m[2] * z,
  m[3] * x + m[4] * y + m[5] * z,
  m[6] * x + m[7] * y + m[8] * z,
];

// A camera ready to project: pose resolved once, per photo.
export function makeCamera(pose, origin) {
  if (!pose.rotation || pose.lat == null || pose.lon == null) return null;
  const R = rotationMatrix(pose.rotation);

  // The camera's own position in the same local metres the world uses.
  const cx = (pose.lon - origin.lon) * metresPerDegLon(origin.lat);
  const cz = -(pose.lat - origin.lat) * METRES_PER_DEG_LAT;
  const cy = pose.alt ?? 2.0;

  const W = pose.width;
  const H = pose.height;
  const norm = Math.max(W, H);
  const focal = pose.params?.[0] ?? 0.85;
  const k1 = pose.params?.[1] ?? 0;
  const k2 = pose.params?.[2] ?? 0;

  return {
    id: pose.id,
    pano: pose.pano,
    origin: [cx, cy, cz],
    W,
    H,
    // Project a world point (local metres, y up) to pixel coordinates in the
    // *original* image. Returns null when the point is behind the camera.
    // `u`/`v` are normalised 0..1 so callers can sample any thumbnail size.
    project(px, py, pz) {
      // World -> ENU relative to the camera.
      const enu = [px - cx, -(pz - cz), py - cy];
      const [X, Y, Z] = apply(R, enu);

      if (pose.pano) {
        // Equirectangular: every direction is in frame, so there is no cull.
        const lonA = Math.atan2(X, Z);
        const latA = Math.atan2(-Y, Math.hypot(X, Z));
        return {
          u: 0.5 + lonA / (2 * Math.PI),
          v: 0.5 - latA / Math.PI,
          z: Math.hypot(X, Y, Z),
        };
      }

      if (Z <= 0.05) return null; // behind the lens
      const xn = X / Z;
      const yn = Y / Z;
      const r2 = xn * xn + yn * yn;
      const d = 1 + k1 * r2 + k2 * r2 * r2;
      return {
        u: (focal * d * xn * norm + W / 2) / W,
        v: (focal * d * yn * norm + H / 2) / H,
        z: Z,
      };
    },
  };
}

export { METRES_PER_DEG_LAT, metresPerDegLon };
