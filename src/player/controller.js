import * as THREE from "three";

// Each mode is a different vehicle, not a speed multiplier. What separates them
// is how they *refuse* to change direction: an auto understeers, a cycle leans
// and holds momentum, a body on foot turns instantly. Tuning only top speed
// makes all three feel like the same thing at different rates.
export const MODES = {
  walk: {
    label: "On foot",
    eye: 1.62,
    radius: 0.42,
    top: 1.65,
    runTop: 4.6,
    accel: 14,
    brake: 16,
    turnRate: Infinity,   // instant heading change
    fov: 68,
    bobAmount: 0.028,
    bobRate: 8.2,
    lean: 0,
  },
  cycle: {
    label: "Cycle",
    eye: 1.34,
    radius: 0.55,
    top: 5.4,
    runTop: 8.2,          // standing on the pedals
    accel: 3.6,
    brake: 5.5,
    turnRate: 2.1,
    fov: 74,
    bobAmount: 0.012,
    bobRate: 3.1,
    lean: 0.24,
    rollFromTurn: true,
  },
  auto: {
    label: "Auto",
    eye: 1.28,
    radius: 0.95,
    top: 9.5,
    runTop: 13.5,
    accel: 4.2,
    brake: 7.5,
    turnRate: 1.35,       // three wheels, no grip, all commitment
    fov: 80,
    bobAmount: 0.02,
    bobRate: 2.4,
    lean: 0.42,
    rollFromTurn: true,
    idleShake: 0.007,     // two-stroke idle
  },
};

const MODE_ORDER = ["walk", "cycle", "auto"];

export class Player {
  constructor(camera, collider, spawn) {
    this.camera = camera;
    this.collider = collider;

    this.mode = "walk";
    this.position = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.heading = spawn.heading ?? 0;   // radians, 0 = -Z
    this.pitch = 0;
    this.speed = 0;
    this.velocity = new THREE.Vector2(0, 0);
    this.roll = 0;
    this.bobPhase = 0;
    this.thirdPerson = false;

    this.keys = new Set();
    this.lookSensitivity = 0.0022;
    this.locked = false;
    this.distanceTravelled = 0;
    this._lastCollision = 0;
  }

  get spec() {
    return MODES[this.mode];
  }

  setMode(mode) {
    if (!MODES[mode] || mode === this.mode) return;
    // Carry momentum across the swap, clamped to what the new vehicle can hold,
    // so stepping off a moving auto does not fling you down the road.
    const next = MODES[mode];
    this.speed = Math.min(this.speed, next.top);
    this.mode = mode;
  }

  cycleMode() {
    const index = MODE_ORDER.indexOf(this.mode);
    this.setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
  }

  onKeyDown(event) {
    const code = event.code;
    this.keys.add(code);
    if (code === "KeyV") this.setMode(this.mode === "cycle" ? "walk" : "cycle");
    if (code === "KeyB") this.setMode(this.mode === "auto" ? "walk" : "auto");
    if (code === "KeyP") this.thirdPerson = !this.thirdPerson;
  }

  onKeyUp(event) {
    this.keys.delete(event.code);
  }

  onMouseMove(dx, dy) {
    if (!this.locked) return;
    this.heading -= dx * this.lookSensitivity;
    this.pitch -= dy * this.lookSensitivity;
    const limit = Math.PI / 2 - 0.05;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  update(dt) {
    const spec = this.spec;
    const forward = (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0)
      - (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0);
    const strafe = (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0)
      - (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const boosting = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const top = boosting ? spec.runTop : spec.top;

    if (this.mode === "walk") {
      this.updateOnFoot(dt, forward, strafe, top, spec);
    } else {
      this.updateVehicle(dt, forward, strafe, top, spec);
    }

    // Head bob / engine idle, scaled by how fast we are actually moving.
    const motion = Math.min(1, Math.abs(this.speed) / Math.max(1, spec.top));
    this.bobPhase += dt * spec.bobRate * (0.35 + motion);
    const bob = Math.sin(this.bobPhase) * spec.bobAmount * motion;
    const idle = spec.idleShake ? Math.sin(this.bobPhase * 6.3) * spec.idleShake : 0;

    this.camera.position.set(
      this.position.x,
      spec.eye + bob + idle,
      this.position.z,
    );

    if (this.thirdPerson) {
      // Pull the camera back along the view ray, and keep it out of walls.
      const back = this.mode === "auto" ? 6.5 : this.mode === "cycle" ? 4.6 : 3.6;
      const lift = this.mode === "walk" ? 0.9 : 1.3;
      const dirX = Math.sin(this.heading);
      const dirZ = Math.cos(this.heading);
      const target = this.collider.resolve(
        this.position.x + dirX * back,
        this.position.z + dirZ * back,
        0.5,
      );
      this.camera.position.set(target.x, spec.eye + lift + bob, target.z);
    }

    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.heading);
    this.camera.rotateX(this.pitch);
    this.camera.rotateZ(this.roll);

    const targetFov = spec.fov + (boosting ? 5 : 0) * motion;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }
  }

  updateOnFoot(dt, forward, strafe, top, spec) {
    // Free-strafing body: desired velocity is direct, so it stops on a coin.
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    let wishX = -sin * forward + cos * strafe;
    let wishZ = -cos * forward - sin * strafe;
    const wishLength = Math.hypot(wishX, wishZ);
    if (wishLength > 1e-4) {
      wishX = (wishX / wishLength) * top;
      wishZ = (wishZ / wishLength) * top;
    } else {
      wishX = 0;
      wishZ = 0;
    }

    const rate = wishLength > 1e-4 ? spec.accel : spec.brake;
    this.velocity.x += (wishX - this.velocity.x) * Math.min(1, rate * dt);
    this.velocity.y += (wishZ - this.velocity.y) * Math.min(1, rate * dt);
    this.speed = this.velocity.length();
    this.roll += (0 - this.roll) * Math.min(1, dt * 8);

    this.step(dt, this.velocity.x, this.velocity.y, spec);
  }

  updateVehicle(dt, forward, strafe, top, spec) {
    // Steered body: strafe becomes steering, and steering only bites when the
    // vehicle is already rolling. This is what makes an auto feel like an auto.
    const throttle = forward;
    if (throttle > 0) {
      this.speed += spec.accel * dt * throttle;
    } else if (throttle < 0) {
      this.speed -= spec.brake * dt * (this.speed > 0 ? 1 : 0.45);
    } else {
      // Coast: rolling resistance, stronger on foot-powered transport.
      const drag = this.mode === "cycle" ? 1.1 : 1.9;
      this.speed -= Math.sign(this.speed) * drag * dt;
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    }
    this.speed = Math.max(-2.2, Math.min(top, this.speed));

    const grip = Math.min(1, Math.abs(this.speed) / 2.4);
    const steer = -strafe * spec.turnRate * grip * Math.sign(this.speed || 1);
    this.heading += steer * dt;

    const targetRoll = spec.rollFromTurn ? steer * spec.lean * grip : 0;
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 5);

    const vx = -Math.sin(this.heading) * this.speed;
    const vz = -Math.cos(this.heading) * this.speed;
    this.velocity.set(vx, vz);
    this.step(dt, vx, vz, spec);
  }

  step(dt, vx, vz, spec) {
    const nextX = this.position.x + vx * dt;
    const nextZ = this.position.z + vz * dt;
    const resolved = this.collider.resolve(nextX, nextZ, spec.radius);

    const movedX = resolved.x - this.position.x;
    const movedZ = resolved.z - this.position.z;
    this.distanceTravelled += Math.hypot(movedX, movedZ);
    this.position.x = resolved.x;
    this.position.z = resolved.z;

    if (resolved.hit) {
      // Scrub speed on impact instead of grinding along at full throttle.
      if (this.mode === "walk") {
        this.velocity.multiplyScalar(0.35);
      } else {
        this.speed *= 0.42;
      }
      this._lastCollision = performance.now();
    }
  }
}
