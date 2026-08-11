// Circle-vs-polygon-edge collision over a uniform spatial hash.
//
// 2,223 footprints is far too many to test per frame, and a physics engine is
// overkill for a world with no dynamics. Hashing edges into 20 m cells means a
// step tests ~10 edges regardless of city size.

const CELL = 20;

export class Collider {
  constructor(world) {
    this.cells = new Map();
    this.polygonCells = new Map();
    this.polygons = [];
    this.edgeCount = 0;
    for (const building of world.buildings) {
      this.addPolygon(building.points);
      this.indexPolygon(building.points);
    }
    // Keep the player out of the lake: same edge test, opposite intent.
    for (const body of world.water) this.addPolygon(body.points);
  }

  // Edge pushing alone cannot rescue a point that starts deep inside a
  // footprint: every edge is further away than the player radius, so nothing
  // pushes and the player stands inside a building looking at brown. Spawn
  // placement needs a real containment test.
  indexPolygon(points) {
    const index = this.polygons.length;
    this.polygons.push(points);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const key = this.key(cx, cz);
        let bucket = this.polygonCells.get(key);
        if (!bucket) {
          bucket = [];
          this.polygonCells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  // Distance to the nearest blocking edge, capped. Used to reject spawn points
  // that are technically outside a building but wedged in a 1 m gap between two.
  clearance(x, z, cap = 12) {
    let best = cap;
    for (const [ax, az, bx, bz] of this.nearby(x, z, cap)) {
      const ex = bx - ax;
      const ez = bz - az;
      const lengthSq = ex * ex + ez * ez;
      if (lengthSq < 1e-8) continue;
      let t = ((x - ax) * ex + (z - az) * ez) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
      if (d < best) best = d;
    }
    return best;
  }

  contains(x, z) {
    const bucket = this.polygonCells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!bucket) return false;
    for (const index of bucket) {
      const polygon = this.polygons[index];
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, zi] = polygon[i];
        const [xj, zj] = polygon[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  key(cx, cz) {
    return cx * 100000 + cz;
  }

  addEdge(ax, az, bx, bz) {
    const edge = [ax, az, bx, bz];
    this.edgeCount++;
    const minX = Math.floor(Math.min(ax, bx) / CELL);
    const maxX = Math.floor(Math.max(ax, bx) / CELL);
    const minZ = Math.floor(Math.min(az, bz) / CELL);
    const maxZ = Math.floor(Math.max(az, bz) / CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const key = this.key(cx, cz);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(edge);
      }
    }
  }

  addPolygon(points) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      this.addEdge(points[j][0], points[j][1], points[i][0], points[i][1]);
    }
  }

  nearby(x, z, radius) {
    const out = [];
    const minX = Math.floor((x - radius) / CELL);
    const maxX = Math.floor((x + radius) / CELL);
    const minZ = Math.floor((z - radius) / CELL);
    const maxZ = Math.floor((z + radius) / CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  // Push a circle out of every edge it overlaps. Iterating a few times settles
  // inside corners; a single pass leaves the player wedged in a doorway recess.
  resolve(x, z, radius) {
    let px = x;
    let pz = z;
    let hit = false;
    const edges = this.nearby(x, z, radius + CELL);
    if (!edges.length) return { x: px, z: pz, hit };

    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const [ax, az, bx, bz] of edges) {
        const ex = bx - ax;
        const ez = bz - az;
        const lengthSq = ex * ex + ez * ez;
        if (lengthSq < 1e-8) continue;
        let t = ((px - ax) * ex + (pz - az) * ez) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ex * t;
        const cz = az + ez * t;
        const dx = px - cx;
        const dz = pz - cz;
        const distance = Math.hypot(dx, dz);
        if (distance >= radius || distance < 1e-6) continue;
        const push = radius - distance;
        px += (dx / distance) * push;
        pz += (dz / distance) * push;
        moved = true;
        hit = true;
      }
      if (!moved) break;
    }
    return { x: px, z: pz, hit };
  }
}
