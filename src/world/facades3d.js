import * as THREE from "three";
import { paintedMaterial, STYLE } from "../render/materials.js";

// Buildings, built.
//
// Up to now a wall got its windows from a texture — and for a while, on 399 of
// them, from a photograph. Both are the same trick at different resolutions:
// something flat pretending to be something that sticks out. It survives a
// screenshot and it does not survive walking down the street, because the one
// thing a window does that a picture of a window cannot is *catch the light on
// its own edges*. A sill throws a shadow down the wall. A chajja throws a hard
// bar of shade across the glass at noon. A frame is proud of the render by
// forty millimetres and you can see that from across the road.
//
// So the openings are geometry now. The photographs are still doing their job,
// but upstream: pipeline/read-facades.mjs reads them for how many floors this
// building has, how its windows are spaced, what colour it is painted and where
// the signboard sits, and that description is what gets built. No pixels ship.
//
// ------------------------------------------------------------------ budget
//
// A window is cheap and there are a hundred and seventy thousand of them. The
// three things that make that affordable:
//
//   * every part is instanced — five draw calls, not five per building
//   * windows are authored at real size (1.25 m x 1.45 m) and never scaled to
//     fit a bay, which is both correct — real windows come in standard sizes —
//     and free of the anisotropic squash that fitting them would cause
//   * instances are bucketed into 220 m cells, so the frustum throws away
//     everything you are not looking at. At street level that is most of the
//     city; from the bird camera they are switched off entirely, because a
//     40 mm sill 900 m away is not a thing anyone can see.

const CELL = 220;

const BOARD_COLORS = [
  0xd23c34, 0x1f6fb2, 0x1c7a4a, 0xe0a51e, 0xb8352f, 0x2f4b8f,
  0xd4622a, 0x7a3f8f, 0x0f7c86, 0xc8385f, 0x276749, 0xdb8b1a,
];

// Real dimensions, in metres. These are ordinary Bengaluru residential sizes.
const W_WIDTH = 1.25;
const W_HEIGHT = 1.45;
const FRAME = 0.09;        // width of the surround
const PROUD = 0.055;       // how far the frame stands off the render
const SILL_DROP = 0.09;
const HOOD_PROJECT = 0.42; // the chajja — deep, because it is a sun shade

// ------------------------------------------------------------------ geometry

// Everything is authored in a wall-local frame: +x along the wall, +y up, +z
// out of the wall. Instances then only need a position and a yaw.
function quad(out, a, b, c, d, shade) {
  const base = out.position.length / 3;
  for (const p of [a, b, c, d]) out.position.push(p[0], p[1], p[2]);
  // Face normal from the first corner triple.
  const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
  const vx = d[0] - a[0]; const vy = d[1] - a[1]; const vz = d[2] - a[2];
  let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (let i = 0; i < 4; i += 1) {
    out.normal.push(nx, ny, nz);
    out.color.push(shade, shade, shade);
    out.uv.push(0, 0);
  }
  out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// A box reduced to the faces that can actually be seen, chosen per part.
//
// The first version of this emitted all five outward faces of every slab and
// the window came out at eighty triangles — times a hundred and thirty-four
// thousand, which is nine million triangles of window sill. At the depths these
// parts stand proud of a wall, between forty and ninety millimetres, the side
// faces are a pixel wide from the pavement and invisible from anywhere else,
// so they buy nothing and cost half the budget.
//
// What has to survive is the *lit* faces: the one pointing at you, and the
// horizontal one that catches the sun and reads as a shelf. Everything else is
// dropped. `faces` names what to keep.
function slab(out, x0, x1, y0, y1, z0, z1, shade, faces = "ft") {
  if (faces.includes("f")) quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], shade);
  if (faces.includes("t")) quad(out, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], shade * 1.05);
  if (faces.includes("u")) quad(out, [x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1], shade * 0.78);
  if (faces.includes("e")) {
    quad(out, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], shade * 0.94);
    quad(out, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], shade * 0.94);
  }
}

function finish(out) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(out.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(out.normal, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(out.color, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  geometry.setIndex(out.index);
  return geometry;
}

const empty = () => ({ position: [], normal: [], color: [], uv: [], index: [] });

// The surround, the sill and the sunshade — everything that is *not* glass.
// Shipped as one geometry so a window is one instance, not four.
function windowFrameGeometry(hood) {
  const out = empty();
  const hw = W_WIDTH / 2;
  const oz = PROUD;
  const iz = PROUD - 0.035;

  // Surround, as four faces around the opening. Standing proud of the render is
  // the whole point: this is the edge that catches the sun.
  slab(out, -hw - FRAME, -hw, 0, W_HEIGHT, 0, oz, 1.0, "f");
  slab(out, hw, hw + FRAME, 0, W_HEIGHT, 0, oz, 1.0, "f");
  slab(out, -hw - FRAME, hw + FRAME, W_HEIGHT, W_HEIGHT + FRAME, 0, oz, 1.02, "f");
  slab(out, -hw - FRAME, hw + FRAME, -FRAME, 0, 0, oz, 0.98, "f");

  // Sill: wider than the opening and thrown clear of the wall, so rain runs off
  // it and so it casts a line of shadow down the render. The top face is kept —
  // it is the one the sun lands on — and so is the underside, which is the dark
  // line that makes it read as projecting rather than painted on.
  slab(out, -hw - FRAME - 0.06, hw + FRAME + 0.06, -FRAME - SILL_DROP, -FRAME, 0, 0.14, 1.05, "ftu");

  // Mullion — one vertical bar. Two casement leaves is the standard here.
  slab(out, -0.025, 0.025, 0, W_HEIGHT, 0, iz, 0.96, "f");

  if (hood) {
    // The chajja. A cantilevered concrete sunshade over the opening, which on a
    // south-facing wall in this city is not decoration, and which does more for
    // the read of a facade at noon than anything else on it.
    slab(out, -hw - 0.22, hw + 0.22, W_HEIGHT + FRAME, W_HEIGHT + FRAME + 0.1,
      0, HOOD_PROJECT, 0.93, "ftu");
    // The lip at its edge.
    slab(out, -hw - 0.22, hw + 0.22, W_HEIGHT + FRAME - 0.08, W_HEIGHT + FRAME,
      HOOD_PROJECT - 0.06, HOOD_PROJECT, 0.88, "f");
  }
  return finish(out);
}

// The glass itself: one quad, set back behind the frame face so the surround
// reads as a surround, carrying a vertical gradient in its vertex colours.
//
// A flat dark rectangle is not a window, it is a hole, and a wall of holes is
// the thing that got called "black boxes" the last time this city had any. Real
// glass is not one value: it picks up the sky at the top of the pane and the
// dark of the room at the bottom, and that gradient is the entire reason a
// painted window reads as glazed rather than as missing. Two numbers on four
// vertices buy it, at no cost in geometry.
function windowGlassGeometry() {
  const out = empty();
  const hw = W_WIDTH / 2;
  const base = out.position.length / 3;
  const corners = [
    [-hw, 0, 0.012, 0.72], [hw, 0, 0.012, 0.72],
    [hw, W_HEIGHT, 0.012, 1.42], [-hw, W_HEIGHT, 0.012, 1.42],
  ];
  for (const [x, y, z, shade] of corners) {
    out.position.push(x, y, z);
    out.normal.push(0, 0, 1);
    out.color.push(shade, shade, shade);
    out.uv.push(0, 0);
  }
  out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return finish(out);
}

// Glass colour, from the dark tail of the photograph's histogram.
//
// That tail is genuinely near-black — it is glass in shade, photographed
// through haze at an exposure set for the road — and putting it on a window
// unaltered gives you the hole again. What survives from the reading is the
// *hue*: a shop with green-tinted glazing reads green, a residential window
// reads a neutral blue-grey. The value is set here instead, in the range real
// glass occupies when it is reflecting a sky.
function glassTone(hex) {
  _tone.setHex(hex, THREE.SRGBColorSpace);
  _tone.getHSL(_hsl);
  const h = _hsl.s > 0.08 ? _hsl.h : 0.58;      // neutral glass reflects sky
  const s = Math.min(0.42, Math.max(0.12, _hsl.s * 1.3 + 0.08));
  const l = Math.min(0.46, Math.max(0.24, _hsl.l * 0.6 + 0.2));
  _tone.setHSL(h, s, l);
  return _tone.getHex();
}
const _tone = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

// A metre-long slice of string course, scaled along x to the length of a wall.
// The horizontal line at every floor level: it is what makes a building read as
// having floors from three hundred metres up, where no window is visible.
function bandGeometry() {
  const out = empty();
  slab(out, -0.5, 0.5, 0, 0.16, 0, 0.1, 1, "ftu");
  return finish(out);
}

// A metre of shopfront: dark glazing set back into the wall, under a plain
// board. Scaled along x to the frontage.
function shopGeometry() {
  const out = empty();
  slab(out, -0.5, 0.5, 0, 1, -0.12, -0.1, 1, "f");
  return finish(out);
}

// A metre of signboard, standing proud on its brackets. The single loudest
// element on any street in this layout.
function boardGeometry() {
  const out = empty();
  slab(out, -0.5, 0.5, 0, 1, 0.06, 0.16, 1, "ftue");
  return finish(out);
}

// ------------------------------------------------------------------ planning

// Which walls of this footprint face the street, and which way is out.
//
// A building shows its face to the road and its back to the plot behind. Windows
// on all four sides is a model kit, not a city — and it is also four times the
// geometry for detail nobody can walk up to. So: take the edges long enough to
// carry an opening, keep the two that most directly face the nearest
// carriageway, and leave the rest as plain render.
export function frontageEdges(building, roads, limit = 2) {
  const points = building.points;
  const [cx, cz] = building.centroid;
  const near = roads?.nearest?.(cx, cz, 70) ?? null;
  const edges = [];

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 3.2) continue;                    // too short for a window bay
    const ux = dx / len;
    const uz = dz / len;
    // Outward normal: the one that points away from the centroid.
    let nx = -uz;
    let nz = ux;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    if ((mx + nx - cx) ** 2 + (mz + nz - cz) ** 2 < (mx - nx - cx) ** 2 + (mz - nz - cz) ** 2) {
      nx = -nx; nz = -nz;
    }
    // Long edges win, and edges whose normal points at the street win more.
    let score = len;
    if (near) {
      const tx = near.px - mx;
      const tz = near.pz - mz;
      const d = Math.hypot(tx, tz) || 1;
      const facing = (nx * tx + nz * tz) / d;   // 1 = square on to the street
      score = len * (0.45 + Math.max(0, facing) * 1.55);
    }
    edges.push({ ax: a[0], az: a[1], ux, uz, nx, nz, mx, mz, len, score });
  }

  edges.sort((p, q) => q.score - p.score);
  return edges.slice(0, limit);
}

// ------------------------------------------------------------------ collector

export class FacadeKit {
  constructor() {
    this.windows = [];     // [x, y, z, yaw, lit]
    this.hooded = [];      // same, but gets a chajja
    this.bands = [];       // [x, y, z, yaw, len]
    this.shops = [];       // [x, y, z, yaw, len, height]
    this.boards = [];      // [x, y, z, yaw, len, height, colour]
    this.trimColors = [];  // parallel to windows + hooded
    this.glassColors = [];
    this.bandColors = [];
    this.shopColors = [];
  }

  get windowCount() { return (this.windows.length + this.hooded.length) / 5; }

  // Lay out one building's street elevations.
  add(building, profile, read, roads, random) {
    const edges = frontageEdges(building, roads, building.area > 400 ? 2 : 1);
    if (!edges.length) return;

    const storeys = profile.storeys;
    const ground = profile.groundFloor;
    const storeyH = (profile.height - ground) / Math.max(1, storeys - 1) || 3.05;

    // Colours. Where a photograph of this building was read, that is what it is
    // painted; everywhere else the profile's own colour stands, which already
    // comes from the satellite sample of its roof.
    const trim = read?.trimColor ?? 0xece7dd;
    const glass = glassTone(read?.glassColor ?? 0x39424d);
    // Signboard colour. Read off the photograph where one was legible; drawn
    // from the palette that photograph search kept returning where it was not.
    // These are the colours of an Indian high street — nobody paints a board
    // beige — and leaving unphotographed shops without one produced a street of
    // 300 signboards among several thousand blank fascias.
    const boardColor = read?.signColor ?? read?.accentColor
      ?? BOARD_COLORS[(profile.tint ?? 0) % BOARD_COLORS.length];

    // Bay spacing, from the photograph where it was legible and from the
    // frontage length where it was not. Either way the window itself is a
    // standard size and only the spacing changes, which is how buildings work.
    for (const edge of edges) {
      const bays = read?.bays
        ? Math.max(1, Math.min(Math.round(read.bays * (edge.len / Math.max(1, read.wallLen ?? edge.len))), 10))
        : Math.max(1, Math.min(Math.round(edge.len / 2.9), 10));
      const pitch = edge.len / bays;
      if (pitch < W_WIDTH + 0.5) continue;      // frontage too tight to open up

      const yaw = Math.atan2(edge.nx, edge.nz);
      const push = 0.02;                        // clear of the wall plane

      for (let s = profile.shop ? 1 : 0; s < storeys; s += 1) {
        const sillY = s === 0
          ? 0.95
          : ground + (s - 1) * storeyH + 0.95;
        if (sillY + W_HEIGHT + 0.5 > profile.height) continue;

        // A chajja over the top floor and over most street-facing openings, but
        // not over every single one — a wall where every window is identical
        // down to the shade is the procedural tell this whole file exists to
        // remove.
        // A chajja costs half again what a plain opening does, so it is also the
        // knob that sets the triangle bill. Weighted to the top floor, where it
        // reads hardest against the sky, and to the street elevation generally.
        const hood = random() < (s === storeys - 1 ? 0.55 : 0.28);
        const list = hood ? this.hooded : this.windows;

        for (let b = 0; b < bays; b += 1) {
          // Jitter within the bay, small. Real frontages are not laid out on a
          // ruler, and 60 mm of wander is the difference between a facade and a
          // spreadsheet.
          const t = (b + 0.5) * pitch + (random() - 0.5) * 0.12;
          const x = edge.ax + edge.ux * t + edge.nx * push;
          const z = edge.az + edge.uz * t + edge.nz * push;
          // Roughly a quarter of windows show a light after dark. All of them
          // lit is a hotel; none of them is a power cut.
          list.push(x, sillY, z, yaw, random() < 0.26 ? 1 : 0);
          const colors = hood ? this.hoodColors ??= [] : this.frameColors ??= [];
          colors.push(trim, glass);
        }
      }

      // String course at every floor level, running the full frontage.
      for (let s = 1; s < storeys; s += 1) {
        const y = ground + (s - 1) * storeyH - 0.16;
        this.bands.push(edge.mx + edge.nx * 0.03, y, edge.mz + edge.nz * 0.03, yaw, edge.len);
        this.bandColors.push(trim);
      }

      // Ground floor. A shop gets glazing and a board; a house gets neither,
      // because it has a compound wall and a gate instead — which props.js
      // already builds.
      if (profile.shop) {
        const len = edge.len - 0.6;
        this.shops.push(edge.mx, 0.42, edge.mz, yaw, len, ground - 1.15);
        this.shopColors.push(read?.groundColor ?? 0x3b3f45);
        if (boardColor !== null) {
          this.boards.push(edge.mx + edge.nx * 0.02, ground - 1.0, edge.mz + edge.nz * 0.02,
            yaw, len, 0.78, boardColor);
        }
      }
    }
  }

  // ---- meshes
  //
  // Bucketed into cells so the frustum can throw away what is behind you. One
  // InstancedMesh per cell per part; at street level the frustum keeps three or
  // four cells out of sixty-odd.
  build() {
    const group = new THREE.Group();
    group.name = "facade-detail";

    const frameMaterial = paintedMaterial(0xffffff, { roughness: 0.86, vertexColors: true, lit: "flat" });
    const glassMaterial = STYLE === "anime"
      ? new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.18, metalness: 0.1 });
    const litMaterial = glassMaterial.clone();
    litMaterial.emissive = new THREE.Color(0xffd9a0);
    litMaterial.emissiveIntensity = 0;
    this.litMaterial = litMaterial;

    const plain = windowFrameGeometry(false);
    const hooded = windowFrameGeometry(true);
    const glass = windowGlassGeometry();

    this.emitWindows(group, this.windows, this.frameColors ?? [], plain, glass, frameMaterial, glassMaterial, litMaterial, "win");
    this.emitWindows(group, this.hooded, this.hoodColors ?? [], hooded, glass, frameMaterial, glassMaterial, litMaterial, "win-chajja");

    this.emitStrips(group, this.bands, this.bandColors, bandGeometry(), frameMaterial, "band", null);
    this.emitStrips(group, this.shops, this.shopColors, shopGeometry(), glassMaterial, "shopfront", litMaterial);
    this.emitBoards(group, frameMaterial);

    return group;
  }

  emitWindows(group, flat, colors, frameGeometry, glassGeometry, frameMaterial, glassMaterial, litMaterial, name) {
    const count = flat.length / 5;
    if (!count) return;
    const cells = new Map();
    for (let i = 0; i < count; i += 1) {
      const x = flat[i * 5];
      const z = flat[i * 5 + 2];
      const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (const [key, list] of cells) {
      const frames = new THREE.InstancedMesh(frameGeometry, frameMaterial, list.length);
      const dark = list.filter((i) => !flat[i * 5 + 4]);
      const lit = list.filter((i) => flat[i * 5 + 4]);
      const panes = new THREE.InstancedMesh(glassGeometry, glassMaterial, dark.length);
      const glow = new THREE.InstancedMesh(glassGeometry, litMaterial, lit.length);
      // Only the chajjas cast. A hundred and thirty thousand window frames in
      // the shadow pass doubles the cost of the whole frame for a 9 cm sill
      // whose shadow is one pixel; the cantilevered sunshade throws a real bar
      // of shade across the glass below it and is worth paying for.
      frames.castShadow = name === "win-chajja";
      frames.receiveShadow = true;

      const place = (i, mesh, slot, tint) => {
        dummy.position.set(flat[i * 5], flat[i * 5 + 1], flat[i * 5 + 2]);
        dummy.rotation.set(0, flat[i * 5 + 3], 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        mesh.setColorAt(slot, color.set(tint));
      };
      list.forEach((i, slot) => place(i, frames, slot, colors[i * 2] ?? 0xffffff));
      dark.forEach((i, slot) => place(i, panes, slot, colors[i * 2 + 1] ?? 0x4a5560));
      lit.forEach((i, slot) => place(i, glow, slot, colors[i * 2 + 1] ?? 0x4a5560));

      for (const mesh of [frames, panes, glow]) {
        if (!mesh.count) continue;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.name = `${name}-${key}`;
        group.add(mesh);
      }
    }
  }

  // Strips are scaled along their own length: a string course is genuinely a
  // long thin thing, so stretching one metre of it is correct rather than a
  // compromise.
  emitStrips(group, flat, colors, geometry, material, name, _lit) {
    const stride = name === "shopfront" ? 6 : 5;
    const count = flat.length / stride;
    if (!count) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const cells = new Map();
    for (let i = 0; i < count; i += 1) {
      const key = `${Math.floor(flat[i * stride] / CELL)},${Math.floor(flat[i * stride + 2] / CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }
    for (const [key, list] of cells) {
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      mesh.castShadow = name !== "shopfront";
      mesh.receiveShadow = true;
      list.forEach((i, slot) => {
        dummy.position.set(flat[i * stride], flat[i * stride + 1], flat[i * stride + 2]);
        dummy.rotation.set(0, flat[i * stride + 3], 0);
        dummy.scale.set(flat[i * stride + 4], stride === 6 ? flat[i * stride + 5] : 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        mesh.setColorAt(slot, color.set(colors[i] ?? 0xffffff));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = `${name}-${key}`;
      group.add(mesh);
    }
  }

  emitBoards(group, material) {
    const stride = 7;
    const count = this.boards.length / stride;
    if (!count) return;
    const geometry = boardGeometry();
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const cells = new Map();
    for (let i = 0; i < count; i += 1) {
      const key = `${Math.floor(this.boards[i * stride] / CELL)},${Math.floor(this.boards[i * stride + 2] / CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }
    for (const [key, list] of cells) {
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      mesh.castShadow = true;
      list.forEach((i, slot) => {
        const b = i * stride;
        dummy.position.set(this.boards[b], this.boards[b + 1], this.boards[b + 2]);
        dummy.rotation.set(0, this.boards[b + 3], 0);
        dummy.scale.set(this.boards[b + 4], this.boards[b + 5], 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        mesh.setColorAt(slot, color.set(this.boards[b + 6]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = `board-${key}`;
      group.add(mesh);
    }
  }
}

// Triangle count of each unit, for the budget check in pipeline/_facadetest.mjs.
// Measured off the geometry rather than counted by hand, because the hand count
// was wrong by a factor of three the first time.
export function __units() {
  const tri = (g) => g.index.count / 3;
  return {
    plain: tri(windowFrameGeometry(false)),
    hood: tri(windowFrameGeometry(true)),
    glass: tri(windowGlassGeometry()),
    band: tri(bandGeometry()),
    shop: tri(shopGeometry()),
    board: tri(boardGeometry()),
  };
}
