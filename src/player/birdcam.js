import * as THREE from "three";

// Drone camera. Not a debug fly-cam: it is a third view of the same place, with
// its own rules — the target is a point on the ground, altitude is explicit,
// and the horizon stays level. Free-flying six-degree cameras are disorienting
// over a flat city, and every pitch-roll drift makes the map harder to read.

const BOUNDS_PAD = 120;

export class BirdCam {
  constructor(camera, world) {
    this.camera = camera;
    this.target = new THREE.Vector3();
    this.smoothed = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.72;         // looking down at ~41°
    this.distance = 120;
    this.active = false;
    this.blend = 0;             // 0 = player camera, 1 = fully in bird view

    const [minX, minZ, maxX, maxZ] = world.bounds;
    this.limits = {
      minX: minX - BOUNDS_PAD, maxX: maxX + BOUNDS_PAD,
      minZ: minZ - BOUNDS_PAD, maxZ: maxZ + BOUNDS_PAD,
    };
  }

  enter(player) {
    this.active = true;
    this.target.set(player.position.x, 0, player.position.z);
    this.smoothed.copy(this.camera.position);
    this.yaw = player.heading;
    this.distance = 110;
    this.pitch = -0.72;
  }

  exit() {
    this.active = false;
  }

  onMouseMove(dx, dy) {
    if (!this.active) return;
    this.yaw -= dx * 0.0022;
    this.pitch -= dy * 0.0018;
    // Never let it flip past straight down or past the horizon: both read as a
    // bug, and looking up from 300 m shows nothing but sky.
    this.pitch = Math.max(-1.48, Math.min(-0.12, this.pitch));
  }

  onWheel(delta) {
    if (!this.active) return;
    this.distance = Math.max(18, Math.min(1400, this.distance * Math.exp(delta * 0.0012)));
  }

  update(dt, keys) {
    // Pan across the ground in the direction the camera faces, scaled by
    // altitude — at 600 m you want to cross the layout, at 30 m you want to
    // creep along a street.
    const fast = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const speed = Math.max(18, this.distance * 0.85) * (fast ? 3 : 1);
    const forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    const strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    if (forward || strafe) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      this.target.x += (-sin * forward + cos * strafe) * speed * dt;
      this.target.z += (-cos * forward - sin * strafe) * speed * dt;
    }
    if (keys.has("KeyQ")) this.distance = Math.max(18, this.distance * (1 - dt * 0.9));
    if (keys.has("KeyE")) this.distance = Math.min(1400, this.distance * (1 + dt * 0.9));

    this.target.x = Math.max(this.limits.minX, Math.min(this.limits.maxX, this.target.x));
    this.target.z = Math.max(this.limits.minZ, Math.min(this.limits.maxZ, this.target.z));

    const horizontal = Math.cos(this.pitch) * this.distance;
    const desired = new THREE.Vector3(
      this.target.x - Math.sin(this.yaw) * horizontal,
      Math.max(6, this.target.y - Math.sin(this.pitch) * this.distance),
      this.target.z - Math.cos(this.yaw) * horizontal,
    );

    // Critically-damped-ish follow. Snapping the camera to the orbit solution
    // makes every mouse movement feel brittle; a 12/s lerp keeps it heavy the
    // way a real drone is.
    this.smoothed.lerp(desired, Math.min(1, dt * 6));
    this.camera.position.copy(this.smoothed);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
  }

  // Altitude readout for the HUD.
  get altitude() {
    return this.camera.position.y;
  }
}
