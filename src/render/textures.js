import * as THREE from "three";

// Every surface in this build is textured from a canvas drawn at load time.
// No image files, no network fetch, no licence to track — and the pattern can
// be *authored*: lane markings land at the exact metre offset across a
// carriageway, a storey band lands at the exact floor height. A downloaded
// asphalt photo cannot do either.
//
// The rule that makes this look like material rather than noise: every texture
// carries three channels of information — albedo (what colour), roughness
// (how wet/polished), and a normal derived from a height field (what the
// surface does to light at grazing angles). Albedo alone reads as paper.

const cache = new Map();

// Painted surfaces carry almost no high-frequency detail: a cel frame states a
// wall with one flat colour and a line, where a photograph states it with
// grain, weathering streaks and aggregate. Running the same drawing code with
// the noise passes suppressed keeps every *shape* — window, shutter, lane
// marking, signboard — and drops only the photographic texture. That is why the
// styles share one set of drawing functions rather than two sets of art.
let FLAT = true;

export function setFlatTextures(flat) {
  if (FLAT === flat) return false;
  FLAT = flat;
  for (const texture of cache.values()) texture.dispose?.();
  cache.clear();
  return true;
}

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function canvas(size = 512) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

function toTexture(c, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = aniso;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Sobel over the luminance of a drawn canvas. Deriving the normal from the art
// itself is what keeps a window recess, a kerb chamfer and a paver joint lit
// consistently — hand-authoring a second canvas always drifts out of register.
function normalFromCanvas(source, strength = 1.4) {
  const size = source.width;
  const src = source.getContext("2d").getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const image = out.getContext("2d").createImageData(size, size);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normalise (-dx, -dy, 1) into 0..255 tangent space.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      image.data[i + 3] = 255;
    }
  }
  out.getContext("2d").putImageData(image, 0, 0);
  return out;
}

// Value noise, tiled. Wrapping the lattice is the whole reason this is written
// out rather than pulled from a library: a non-tiling noise shows a hard seam
// every 3 m across a 500 m road and reads instantly as a texture repeat.
function noiseCanvas(size, cells, seed, contrast = 1) {
  const random = seeded(seed);
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let y = 0; y <= cells; y++) {
    for (let x = 0; x <= cells; x++) {
      grid[y * (cells + 1) + x] = x === cells || y === cells
        ? grid[(y % cells) * (cells + 1) + (x % cells)]
        : random();
    }
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const image = ctx.createImageData(size, size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const a = grid[y0 * (cells + 1) + x0];
      const b = grid[y0 * (cells + 1) + x0 + 1];
      const cc = grid[(y0 + 1) * (cells + 1) + x0];
      const d = grid[(y0 + 1) * (cells + 1) + x0 + 1];
      let v = (a + (b - a) * tx) + ((cc + (d - cc) * tx) - (a + (b - a) * tx)) * ty;
      v = 0.5 + (v - 0.5) * contrast;
      const i = (y * size + x) * 4;
      const g = Math.max(0, Math.min(255, v * 255));
      image.data[i] = image.data[i + 1] = image.data[i + 2] = g;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return c;
}

function grain(ctx, size, amount, seed, alpha = 0.06) {
  if (FLAT) return;
  const random = seeded(seed);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * amount;
    image.data[i] += n;
    image.data[i + 1] += n;
    image.data[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.globalAlpha = 1;
}

function fillNoise(ctx, size, cells, seed, alpha, contrast = 1) {
  // A little large-scale variation survives even in the flat style — a
  // perfectly uniform wall reads as untextured plastic, not as paint.
  if (FLAT) {
    if (cells > 8) return;
    alpha *= 0.35;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(noiseCanvas(size, cells, seed, contrast), 0, 0, size, size);
  ctx.restore();
}

// ------------------------------------------------------------------ facades

// One facade texture for 2,223 buildings is why a procedural city reads as a
// stamped repeat no matter how good the material is. These are twelve
// different buildings, not twelve tints of one: different bay counts, window
// proportions, grilles, chajjas, cladding and cill lines. Buildings are grouped
// by variant and merged per group, so twelve variants cost twelve draw calls
// rather than a shader trick with an atlas.
//
// One tile = one storey x one structural bay (3.2 m). Repeat comes from real
// geometry length, so a 12.8 m frontage gets exactly four bays and floors line
// up across the whole city.
//
// Drawn near-white on purpose: the wall paint arrives as a vertex colour, so
// each variant still yields fourteen paint colours.

export const FACADE_VARIANTS = 12;

const FACADE_SPEC = [
  // bays: windows across one 3.2 m tile. chajja: the concrete sunshade ledge
  // over an opening — the most characteristic detail on an Indian facade and
  // completely absent from any generic "window grid" texture.
  { bays: 1, w: 0.58, h: 0.44, grille: true,  chajja: true,  band: "slab",   sill: true },
  { bays: 2, w: 0.3,  h: 0.4,  grille: true,  chajja: true,  band: "slab",   sill: true },
  { bays: 1, w: 0.72, h: 0.5,  grille: false, chajja: false, band: "none",   sill: true },
  { bays: 1, w: 0.62, h: 0.46, grille: false, chajja: true,  band: "slab",   sill: true, balcony: true },
  { bays: 2, w: 0.34, h: 0.34, grille: true,  chajja: false, band: "tile",   sill: true },
  { bays: 1, w: 0.5,  h: 0.38, grille: true,  chajja: true,  band: "tile",   sill: true },
  { bays: 2, w: 0.27, h: 0.34, grille: false, chajja: false, band: "slab",   sill: true },
  { bays: 1, w: 0.86, h: 0.58, grille: false, chajja: false, band: "ribbon", sill: false, glassy: true },
  { bays: 2, w: 0.38, h: 0.56, grille: false, chajja: false, band: "ribbon", sill: false, glassy: true },
  { bays: 1, w: 0.34, h: 0.34, grille: true,  chajja: false, band: "none",   sill: true, weathered: true },
  { bays: 1, w: 0.26, h: 0.26, grille: true,  chajja: false, band: "none",   sill: true, blank: true },
  { bays: 2, w: 0.28, h: 0.48, grille: false, chajja: true,  band: "slab",   sill: true, balcony: true },
];

function drawWindow(ctx, size, x, y, w, h, spec, random) {
  // Reveal: the shadowed thickness of the wall around the opening. Without it
  // a window is a sticker on a flat plane.
  ctx.fillStyle = "#6f6a63";
  ctx.fillRect(x - 6, y - 6, w + 12, h + 12);

  const glass = ctx.createLinearGradient(x, y, x + w, y + h);
  if (spec.glassy) {
    glass.addColorStop(0, "#3d5a6b");
    glass.addColorStop(0.42, "#7fa3b5");
    glass.addColorStop(0.5, "#b8d2dd");
    glass.addColorStop(0.6, "#4e6d7e");
    glass.addColorStop(1, "#2a3d49");
  } else {
    glass.addColorStop(0, "#2b3742");
    glass.addColorStop(0.45, "#4a5c68");
    glass.addColorStop(0.5, "#8fa3ad");
    glass.addColorStop(0.55, "#3f505c");
    glass.addColorStop(1, "#232c34");
  }
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = spec.glassy ? "#8d8f92" : "#e8e5df";
  ctx.lineWidth = Math.max(4, w * 0.05);
  ctx.strokeRect(x, y, w, h);
  ctx.lineWidth = Math.max(3, w * 0.035);
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.stroke();

  if (spec.grille) {
    ctx.strokeStyle = "rgba(38,42,46,0.72)";
    ctx.lineWidth = 3;
    const bars = Math.max(3, Math.round(w / 26));
    for (let i = 1; i < bars; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w / bars) * i, y);
      ctx.lineTo(x + (w / bars) * i, y + h);
      ctx.stroke();
    }
  }

  if (spec.chajja) {
    // Sunshade slab, with the shadow it throws on the wall below it.
    ctx.fillStyle = "#e6e0d3";
    ctx.fillRect(x - 16, y - 20, w + 32, 13);
    ctx.fillStyle = "rgba(70,64,56,0.3)";
    ctx.fillRect(x - 16, y - 7, w + 32, 7);
  }

  if (spec.sill) {
    ctx.fillStyle = "#dcd6c9";
    ctx.fillRect(x - 10, y + h, w + 20, 10);
    // The dirt that runs off every sill in a monsoon city.
    if (!FLAT) {
      ctx.fillStyle = "rgba(120,112,98,0.15)";
      ctx.fillRect(x - 2, y + h + 10, 8, size - (y + h) - 10);
      ctx.fillRect(x + w - 6, y + h + 10, 8, size - (y + h) - 10);
    }
  }

  if (spec.balcony) {
    ctx.strokeStyle = "rgba(58,58,62,0.85)";
    ctx.lineWidth = 4;
    const by = y + h + 12;
    ctx.beginPath();
    ctx.moveTo(x - 14, by);
    ctx.lineTo(x + w + 14, by);
    ctx.stroke();
    ctx.lineWidth = 2.5;
    for (let i = 0; i <= 10; i++) {
      const bx = x - 14 + ((w + 28) / 10) * i;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by + 30);
      ctx.stroke();
    }
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - 14, by + 30);
    ctx.lineTo(x + w + 14, by + 30);
    ctx.stroke();
  }
  void random;
}

export function facadeCanvas(variant = 0, seed = 7) {
  const spec = FACADE_SPEC[variant % FACADE_SPEC.length];
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const random = seeded(seed * 37 + variant * 101 + 3);

  ctx.fillStyle = spec.glassy ? "#e6e8e6" : "#f4f1ea";
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 24, seed + variant * 13, spec.weathered ? 0.3 : 0.18, 0.6);
  fillNoise(ctx, size, 5, seed + variant * 7 + 31, 0.12, 0.8);

  if (spec.band === "slab") {
    // Floor slab band: the horizontal RCC line every framed building shows at
    // each storey, and the clearest cue of "concrete frame" from 60 m.
    ctx.fillStyle = "rgba(190,183,170,0.55)";
    ctx.fillRect(0, 0, size, 14);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(0, 14, size, 5);
  } else if (spec.band === "tile") {
    // Granite or ceramic cladding band, ubiquitous on 2000s-era HSR frontages.
    ctx.fillStyle = "rgba(140,132,120,0.5)";
    ctx.fillRect(0, 0, size, 30);
    ctx.strokeStyle = "rgba(90,84,76,0.4)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo((size / 6) * i, 0);
      ctx.lineTo((size / 6) * i, 30);
      ctx.stroke();
    }
  } else if (spec.band === "ribbon") {
    // Spandrel panel between ribbon windows: the office-block signature.
    ctx.fillStyle = "rgba(96,102,108,0.62)";
    ctx.fillRect(0, 0, size, 34);
  }

  if (spec.blank) {
    // Side elevation: mostly blank wall with a single small opening. Party
    // walls in a layout this dense are exactly this, and having some in the mix
    // is what stops every elevation reading as a shopfront.
    drawWindow(ctx, size, size * 0.62, size * 0.34, size * spec.w, size * spec.h, spec, random);
    if (random() < 0.5) {
      ctx.fillStyle = "rgba(150,142,130,0.4)";
      ctx.fillRect(size * 0.1, size * 0.6, size * 0.16, size * 0.12);  // vent
    }
  } else {
    const gutter = (1 - spec.bays * spec.w) / (spec.bays + 1);
    for (let i = 0; i < spec.bays; i++) {
      const x = size * (gutter + i * (spec.w + gutter));
      const y = size * (spec.chajja ? 0.3 : 0.26);
      drawWindow(ctx, size, x, y, size * spec.w, size * spec.h, spec, random);
    }
  }

  if (spec.weathered && !FLAT) {
    // Damp streaks below the slab line. Bengaluru's monsoon writes on every
    // north-facing wall, and a clean facade is the fastest tell of a render.
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = `rgba(104,98,88,${0.03 + random() * 0.05})`;
      ctx.fillRect(random() * size, 18, 6 + random() * 22, size * (0.3 + random() * 0.6));
    }
  }

  if (!spec.glassy && random() < 0.42) {
    // Split AC outdoor unit, hung wherever there was space.
    const ax = size * (0.04 + random() * 0.06);
    ctx.fillStyle = "#d8d4cc";
    ctx.fillRect(ax, size * 0.36, size * 0.1, size * 0.14);
    ctx.strokeStyle = "rgba(80,80,80,0.5)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ax, size * 0.36, size * 0.1, size * 0.14);
  }

  grain(ctx, size, spec.weathered ? 18 : 12, seed + variant * 5);
  return c;
}

// Ground floor is a different building from the flats above it. Six variants,
// because a street where every shutter is identical is exactly the complaint.
export const SHOP_VARIANTS = 6;

export function shopfrontCanvas(variant = 0, emissive = false) {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const seed = 3 + variant * 29;
  const random = seeded(seed);
  const style = variant % 3;             // 0 glazed, 1 shutter, 2 open counter

  // In emissive mode the same drawing runs with the same seed, so every shape
  // lands in the same place — but the wall, shutters and plinth are painted
  // black. Only the signboard and the glazing emit. Deriving the night pass
  // from the day pass this way is what keeps a lit sign *on* its board instead
  // of the whole shopfront glowing like a lantern.
  ctx.fillStyle = emissive ? "#000000" : "#e9e4d9";
  ctx.fillRect(0, 0, size, size);
  if (!emissive) fillNoise(ctx, size, 20, seed + 3, 0.16, 0.6);

  // Signage board across the top third — the loudest object on any HSR street.
  // The readable business names are separate geometry, mounted from the OSM
  // name tags; this is the board they sit on plus the generic clutter beside.
  const boards = ["#c0392b", "#1f6f8b", "#e0a423", "#2d7a4f", "#7b3f8c", "#b8451f"];
  ctx.fillStyle = boards[variant % boards.length];
  ctx.fillRect(0, size * 0.06, size, size * 0.2);
  ctx.fillStyle = emissive ? "#000000" : "rgba(0,0,0,0.25)";
  ctx.fillRect(0, size * 0.26, size, 8);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  let x = size * 0.08;
  while (x < size * 0.86) {
    const w = 10 + random() * 30;
    ctx.fillRect(x, size * 0.13, w, size * 0.07);
    x += w + 8 + random() * 10;
  }

  if (style === 0) {
    const glass = ctx.createLinearGradient(0, size * 0.32, size, size * 0.9);
    glass.addColorStop(0, "#38474f");
    glass.addColorStop(0.5, "#6d8590");
    glass.addColorStop(1, "#2a353c");
    ctx.fillStyle = emissive ? "rgba(255,232,190,0.6)" : glass;
    ctx.fillRect(size * 0.05, size * 0.34, size * 0.9, size * 0.52);
    ctx.strokeStyle = emissive ? "#000000" : "#cfcabf";
    ctx.lineWidth = 8;
    ctx.strokeRect(size * 0.05, size * 0.34, size * 0.9, size * 0.52);
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.34);
    ctx.lineTo(size * 0.5, size * 0.86);
    ctx.stroke();
  } else if (style === 1) {
    // Rolling shutter: pulled down, so nothing behind it emits.
    ctx.fillStyle = emissive ? "#000000" : "#8c9298";
    ctx.fillRect(size * 0.05, size * 0.34, size * 0.9, size * 0.52);
    ctx.strokeStyle = emissive ? "#000000" : "rgba(60,64,68,0.55)";
    ctx.lineWidth = 3;
    for (let y = size * 0.36; y < size * 0.86; y += 10) {
      ctx.beginPath();
      ctx.moveTo(size * 0.05, y);
      ctx.lineTo(size * 0.95, y);
      ctx.stroke();
    }
  } else {
    // Open counter: darkness behind a raised sill, with the interior lit at
    // night. Bakeries, juice stalls, and chat shops all read like this.
    ctx.fillStyle = emissive ? "rgba(255,224,170,0.75)" : "#241f1c";
    ctx.fillRect(size * 0.08, size * 0.36, size * 0.84, size * 0.4);
    ctx.fillStyle = emissive ? "#000000" : "#cfc7b6";
    ctx.fillRect(size * 0.06, size * 0.72, size * 0.88, size * 0.09);
    ctx.fillStyle = emissive ? "#000000" : "#b6ada0";
    ctx.fillRect(size * 0.06, size * 0.81, size * 0.88, size * 0.06);
  }

  // Plinth: the raised step every shop sits on, always grubbier than the wall.
  ctx.fillStyle = emissive ? "#000000" : "#b9b2a4";
  ctx.fillRect(0, size * 0.86, size, size * 0.14);
  ctx.fillStyle = emissive ? "#000000" : "rgba(90,84,74,0.28)";
  ctx.fillRect(0, size * 0.86, size, 6);

  if (!emissive) grain(ctx, size, 14, seed + 9);
  return c;
}

// ------------------------------------------------------------------ signage

// The actual business names out of OSM, rendered as readable plates. 191 of
// them, packed into 1024-square atlases of 16 so the whole high street costs
// three textures and three draw calls instead of 191 of each.
export const SIGN_COLS = 2;
export const SIGN_ROWS = 8;
export const SIGNS_PER_ATLAS = SIGN_COLS * SIGN_ROWS;

const SIGN_STYLES = [
  { bg: "#c0392b", fg: "#fff6ea", sub: "#f6d9cf" },
  { bg: "#12506e", fg: "#f4fbff", sub: "#bcdcea" },
  { bg: "#e5a91f", fg: "#2a2013", sub: "#5c4a20" },
  { bg: "#1d7a4c", fg: "#f2fff6", sub: "#c2e8d2" },
  { bg: "#f4f0e6", fg: "#26211d", sub: "#6d635a" },
  { bg: "#6d2f7a", fg: "#fdf3ff", sub: "#dcbde4" },
];

export function signAtlasCanvas(entries) {
  // 512, not 1024. Sixteen plates per atlas at 256x64 each is still crisp at
  // the distance a shop sign is read from, and twelve 1024-square atlases cost
  // 67 MB of VRAM for text that is never larger than a few hundred pixels on
  // screen.
  const size = 512;
  const cellW = size / SIGN_COLS;
  const cellH = size / SIGN_ROWS;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  entries.forEach((entry, i) => {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const x = col * cellW;
    const y = row * cellH;
    const style = SIGN_STYLES[(entry.name.charCodeAt(0) + entry.name.length) % SIGN_STYLES.length];

    ctx.fillStyle = style.bg;
    ctx.fillRect(x, y, cellW, cellH);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x, y + cellH - 4, cellW, 4);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 3, y + 3, cellW - 6, cellH - 6);

    // Fit the name to the plate. Long names wrap to two lines and shrink —
    // clipping a shop name is worse than a slightly small one, because the
    // whole point of the sign is that you can read it.
    const words = entry.name.split(/\s+/);
    const maxWidth = cellW - 20;
    let lines = [entry.name];
    let fontSize = 25;
    for (let attempt = 0; attempt < 12; attempt++) {
      ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      if (ctx.measureText(entry.name).width <= maxWidth) { lines = [entry.name]; break; }
      // two lines
      let best = null;
      for (let split = 1; split < words.length; split++) {
        const a = words.slice(0, split).join(" ");
        const b = words.slice(split).join(" ");
        const wide = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
        if (!best || wide < best.wide) best = { a, b, wide };
      }
      if (best && best.wide <= maxWidth) { lines = [best.a, best.b]; break; }
      fontSize -= 2;
    }

    ctx.fillStyle = style.fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    const cx = x + cellW / 2;
    const cy = y + cellH / 2 - (entry.kind ? 5 : 0);
    if (lines.length === 1) {
      ctx.fillText(lines[0], cx, cy);
    } else {
      ctx.fillText(lines[0], cx, cy - fontSize * 0.55);
      ctx.fillText(lines[1], cx, cy + fontSize * 0.55);
    }

    if (entry.kind) {
      ctx.fillStyle = style.sub;
      ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(entry.kind.replace(/_/g, " ").toUpperCase(), cx, y + cellH - 14);
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  });

  return c;
}

// ------------------------------------------------------------------ roads

// Markings are drawn at fixed positions *across* the tile, and the ribbon is
// UV-mapped so v = 0..1 spans the carriageway. A centre line therefore lands on
// the actual centre of a 7.5 m street and a 14 m arterial alike, with no
// per-road maths. u repeats every 8 m along the road, so dashes stay 3 m long.
export function roadCanvas(kind = "street", seed = 5) {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");

  ctx.fillStyle = kind === "path" ? "#9a9188" : "#3f3d40";
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 48, seed, 0.3, 1.1);        // aggregate
  fillNoise(ctx, size, 7, seed + 13, 0.22, 0.9);   // patching / wear blotches

  if (kind === "path") {
    // Concrete paver footpath: 60×30 units, staggered, with real joints.
    ctx.strokeStyle = "rgba(70,66,60,0.55)";
    ctx.lineWidth = 3;
    const rows = 8;
    const h = size / rows;
    for (let r = 0; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * h);
      ctx.lineTo(size, r * h);
      ctx.stroke();
      const offset = (r % 2) * (size / 8);
      for (let i = 0; i < 4; i++) {
        const x = offset + (i * size) / 4;
        ctx.beginPath();
        ctx.moveTo(x, r * h);
        ctx.lineTo(x, (r + 1) * h);
        ctx.stroke();
      }
    }
    grain(ctx, size, 16, seed + 2);
    return c;
  }

  // Tyre polish: two darker, smoother bands where wheels actually run.
  ctx.fillStyle = FLAT ? "rgba(20,20,22,0.08)" : "rgba(20,20,22,0.18)";
  ctx.fillRect(0, size * 0.2, size, size * 0.12);
  ctx.fillRect(0, size * 0.68, size, size * 0.12);

  const white = "rgba(232,228,214,0.88)";
  if (kind === "arterial" || kind === "main") {
    // Centre dashes: 3 m mark, 5 m gap on an 8 m tile.
    ctx.fillStyle = white;
    ctx.fillRect(0, size * 0.485, size * 0.375, size * 0.03);
    // Edge lines, held 0.4 m off the kerb.
    ctx.fillStyle = "rgba(232,228,214,0.6)";
    ctx.fillRect(0, size * 0.05, size, size * 0.018);
    ctx.fillRect(0, size * 0.93, size, size * 0.018);
  } else if (kind === "street") {
    ctx.fillStyle = "rgba(232,228,214,0.28)";
    ctx.fillRect(0, size * 0.49, size * 0.3, size * 0.016);
  }

  grain(ctx, size, 18, seed + 4);
  return c;
}

// Black-and-yellow kerb paint, and the diagonal stripes on a speed breaker.
// Both are drawn as real diagonal bands rather than tinted blocks, because the
// diagonal is the recognisable part.
export function paintedKerbCanvas() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#e8c23a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#1e1e20";
  for (let i = -1; i < 5; i++) ctx.fillRect((i * size) / 4, 0, size / 8, size);
  fillNoise(ctx, size, 20, 12, 0.2, 0.9);
  // Chipped and grubby: fresh paint on a kerb lasts about a month here.
  const random = seeded(31);
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(150,142,128,${0.1 + random() * 0.3})`;
    ctx.fillRect(random() * size, random() * size, 2 + random() * 9, 2 + random() * 7);
  }
  return c;
}

export function humpCanvas() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#3b3a3c";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#e8e2d0";
  for (let i = -2; i < 8; i++) {
    ctx.save();
    ctx.translate((i * size) / 6, 0);
    ctx.rotate(0.5);
    ctx.fillRect(0, -size, size / 14, size * 3);
    ctx.restore();
  }
  fillNoise(ctx, size, 18, 9, 0.25, 1);
  return c;
}

export function zebraCanvas() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(236,232,220,0.82)";
  for (let i = 0; i < 6; i++) ctx.fillRect((i * size) / 6, 0, size / 12, size);
  return c;
}

// ------------------------------------------------------------------ ground

export function grassCanvas(seed = 21, tone = "#7f9d70") {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 32, seed, 0.35, 1.2);
  fillNoise(ctx, size, 6, seed + 7, 0.22, 1.0);
  // Blade flecks: without high-frequency directional detail, grass reads as
  // green felt the moment the camera is at eye height.
  const random = seeded(seed + 3);
  ctx.lineWidth = 1;
  for (let i = 0; i < (FLAT ? 700 : 2600); i++) {
    const x = random() * size;
    const y = random() * size;
    const len = 2 + random() * 5;
    ctx.strokeStyle = random() < 0.5 ? "rgba(60,88,48,0.35)" : "rgba(160,190,130,0.3)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (random() - 0.5) * 2, y - len);
    ctx.stroke();
  }
  return c;
}

export function dirtCanvas(seed = 33) {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#b8a894";
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 26, seed, 0.22, 0.9);
  fillNoise(ctx, size, 5, seed + 4, 0.12, 0.8);
  const random = seeded(seed + 8);
  for (let i = 0; i < (FLAT ? 200 : 900); i++) {
    ctx.fillStyle = `rgba(${90 + random() * 60},${80 + random() * 50},${70 + random() * 40},0.5)`;
    const r = random() * 2.4;
    ctx.beginPath();
    ctx.arc(random() * size, random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

// Base stays near-white on purpose. Every material that uses this map also
// carries a vertex colour or a material colour, and colour multiplies map: a
// mid-grey base times a mid-grey tint lands at quarter brightness, which is
// exactly how 2,223 pale concrete roofs came out looking like dark brown tar.
// Keep the map tonal, let the tint carry the hue.
export function concreteCanvas(seed = 44, base = "#eeebe4") {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 30, seed, 0.22, 0.9);
  fillNoise(ctx, size, 4, seed + 6, 0.18, 1.0);
  // Weathering: monsoon streaks and a few damp patches. A clean roof slab is
  // the fastest way to make a Bengaluru rooftop look computer-generated.
  const random = seeded(seed + 2);
  for (let i = 0; i < (FLAT ? 0 : 34); i++) {
    ctx.fillStyle = `rgba(96,92,84,${0.04 + random() * 0.07})`;
    const x = random() * size;
    ctx.fillRect(x, random() * size * 0.5, 4 + random() * 20, size * (0.3 + random() * 0.6));
  }
  grain(ctx, size, 14, seed + 11);
  return c;
}

// Mangalore tile: the terracotta pantile roof on every older Bengaluru house.
export function tileRoofCanvas(seed = 88) {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  // Tonal, not terracotta: the colour arrives as a vertex tint from the
  // satellite sample, and a coloured map would multiply against it.
  ctx.fillStyle = "#ddd5cc";
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 22, seed, 0.22, 0.9);
  const random = seeded(seed + 4);
  const cols = 12;
  const rows = 16;
  const cw = size / cols;
  const ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cw;
      const y = r * ch;
      // Each pantile: a lighter crown and a dark shadow along its lower edge.
      ctx.fillStyle = `rgba(255,255,255,${0.25 + random() * 0.3})`;
      ctx.fillRect(x + 2, y + 1, cw - 4, ch - 3);
      ctx.fillStyle = "rgba(60,52,46,0.38)";
      ctx.fillRect(x, y + ch - 4, cw, 4);
      ctx.fillStyle = "rgba(60,52,46,0.26)";
      ctx.fillRect(x, y, 3, ch);
    }
  }
  // Moss and damp in the laps, which is what makes a tile roof read as old.
  for (let i = 0; i < (FLAT ? 0 : 60); i++) {
    ctx.fillStyle = `rgba(${70 + random() * 40},${90 + random() * 40},${60 + random() * 30},${0.05 + random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(random() * size, random() * size, 4 + random() * 16, 0, Math.PI * 2);
    ctx.fill();
  }
  grain(ctx, size, 16, seed + 2);
  return c;
}

export function barkCanvas(seed = 55) {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#5c4a3f";
  ctx.fillRect(0, 0, size, size);
  fillNoise(ctx, size, 18, seed, 0.3, 1.1);
  const random = seeded(seed + 1);
  for (let i = 0; i < 200; i++) {
    ctx.strokeStyle = random() < 0.5 ? "rgba(40,32,26,0.5)" : "rgba(130,112,96,0.35)";
    ctx.lineWidth = 1 + random() * 2;
    const x = random() * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y < size; y += 16) ctx.lineTo(x + (random() - 0.5) * 6, y);
    ctx.stroke();
  }
  return c;
}

// Alpha-cut foliage card. Ten thousand of these, two crossed quads per tree,
// beat any amount of sphere subdivision for the same triangle count — a canopy
// silhouette is mostly holes, and holes are what solid geometry cannot do.
export function leafCanvas(colors, seed = 66, density = 230) {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  const random = seeded(seed);
  const cx = size / 2;
  const cy = size / 2;
  for (let i = 0; i < density; i++) {
    // Cluster towards the centre so the card has a soft, roughly round mass
    // with a broken edge, rather than a rectangle of confetti.
    const angle = random() * Math.PI * 2;
    const radius = Math.pow(random(), 0.62) * size * 0.47;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius * 0.86;
    const r = 6 + random() * 15 * (1 - radius / (size * 0.5)) + 3;
    ctx.fillStyle = colors[Math.floor(random() * colors.length)];
    ctx.globalAlpha = 0.72 + random() * 0.28;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + random() * 0.5), random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return c;
}

// The pool of light a sodium lamp throws on the road. A radial falloff with a
// soft shoulder, not a hard disc — the edge of a real light pool is the part
// people actually recognise.
export function lightPoolCanvas() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,222,168,0.85)");
  gradient.addColorStop(0.35, "rgba(255,208,145,0.42)");
  gradient.addColorStop(0.7, "rgba(255,196,130,0.12)");
  gradient.addColorStop(1, "rgba(255,190,125,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function waterNormalCanvas(seed = 77) {
  // Two octaves of tiling noise, turned into a normal map. Scrolled in opposite
  // directions at runtime, this is what makes a flat plane read as a lake.
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  ctx.drawImage(noiseCanvas(size, 8, seed, 1), 0, 0);
  ctx.globalAlpha = 0.5;
  ctx.drawImage(noiseCanvas(size, 20, seed + 5, 1), 0, 0);
  ctx.globalAlpha = 1;
  return normalFromCanvas(c, 2.4);
}

// ------------------------------------------------------------------ registry

// Textures are shared aggressively: one facade map serves every wall, one
// asphalt map every street. That is what keeps the whole 2 km² city inside a
// few dozen draw calls and a handful of megabytes of VRAM.
export function texture(name, factory, options) {
  if (!cache.has(name)) cache.set(name, toTexture(factory(), options));
  return cache.get(name);
}

export function normalTexture(name, factory, strength = 1.4, options = {}) {
  const key = `${name}:normal`;
  if (!cache.has(key)) {
    cache.set(key, toTexture(normalFromCanvas(factory(), strength), { ...options, srgb: false }));
  }
  return cache.get(key);
}

// A greyscale map used as roughness/AO: the *same* drawing, so the shine lands
// exactly on the glass and the matte lands exactly on the plaster.
export function greyTexture(name, factory, { invert = false, low = 0.35, high = 1 } = {}) {
  const key = `${name}:grey:${invert}:${low}:${high}`;
  if (cache.has(key)) return cache.get(key);
  const source = factory();
  const size = source.width;
  const out = canvas(size);
  const ctx = out.getContext("2d");
  const data = source.getContext("2d").getImageData(0, 0, size, size);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < data.data.length; i += 4) {
    let v = (data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114) / 255;
    if (invert) v = 1 - v;
    v = low + v * (high - low);
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v * 255;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const result = toTexture(out, { srgb: false });
  cache.set(key, result);
  return result;
}

export function alphaTexture(name, factory) {
  const key = `${name}:alpha`;
  if (!cache.has(key)) {
    const t = toTexture(factory(), { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    cache.set(key, t);
  }
  return cache.get(key);
}
