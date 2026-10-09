// Read the baked facade photographs as architecture, not as pixels.
//
// The photographs were always a means, never the end. A photograph pasted on a
// wall is a photograph pasted on a wall: it has the camera's exposure, the
// camera's perspective, a parked scooter across the plinth and a power line
// through the parapet, and no amount of grading makes it belong in a drawn
// city. What we actually wanted from Mapillary was the *information* in those
// pictures — how many floors this building has, how its windows are spaced,
// what colour someone painted it, where the signboard sits and what colour the
// shutters are.
//
// So this reads each baked tile and writes down what it says, and the renderer
// then *builds* that description out of real geometry. The photo never ships.
//
// Everything here is deliberately crude. Fine detail read off a 250-pixel
// rectification of a photo taken from a moving car is noise; the four or five
// numbers that survive are the ones a person would give you if you asked them
// to describe the building from across the road.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, "public", "facades");
const OUT = path.join(DIR, "read.json");

const STOREY_H = 3.05;

// ------------------------------------------------------------------ helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Colourfulness as absolute chroma, 0..1, and zero for anything dark.
//
// The textbook HSV saturation, (max - min) / max, is the wrong measure here and
// it cost a full iteration to see why: it *divides by* brightness, so a nearly
// black pixel in the shadow under an awning scores higher than a scarlet
// signboard in the sun. Hunting for "the most saturated band" with that
// definition reliably found the darkest band, and the signboard colours came
// back near-black.
//
// Absolute chroma has no such bias, and the luminance gate below says the rest:
// a signboard is a bright, colourful thing. Shadows need not apply.
function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (luminance(r, g, b) < 58) return 0;
  return (max - min) / 255;
}

// Median of a set of pixels, per channel. Median rather than mean because one
// bright sky pixel that leaked past the mask moves a mean and does not move a
// median, and every one of these tiles has a few.
function medianColor(pixels) {
  if (!pixels.length) return [200, 195, 185];
  const out = [];
  for (let ch = 0; ch < 3; ch += 1) {
    const values = pixels.map((p) => p[ch]).sort((a, b) => a - b);
    out.push(values[values.length >> 1]);
  }
  return out;
}

const hex = ([r, g, b]) => (clamp(Math.round(r), 0, 255) << 16)
  | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);

function hue(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Undo the camera before reading any colour off it.
//
// Every one of these frames came off a dashcam pointed through a windscreen at
// a hazy Bengaluru afternoon. They are underexposed, they are blue-shifted by
// the haze, and they are flat. Read the median straight out of that and every
// building in the layout comes back the same muddy grey — which is exactly the
// grey the photographic facades were, and exactly why they never looked
// painted.
//
// Two corrections, both deliberately gentle. Grey-world white balance pulls the
// blue cast out by asking that the average pixel be neutral; a gain on top puts
// the bright end of the tile where a well-exposed photograph would have it. The
// clamps matter more than the maths: a genuinely dark building must stay dark,
// so this can lift a tile by at most about 80% and can never invent contrast
// that is not there.
function normaliseExposure(cells) {
  let sr = 0; let sg = 0; let sb = 0; let n = 0;
  const lums = [];
  for (const row of cells) for (const [r, g, b] of row) {
    sr += r; sg += g; sb += b; n += 1;
    lums.push(luminance(r, g, b));
  }
  if (!n) return { gain: 1, balance: [1, 1, 1] };
  const mean = (sr + sg + sb) / (3 * n);
  const balance = [
    clamp(mean / (sr / n || 1), 0.86, 1.16),
    clamp(mean / (sg / n || 1), 0.86, 1.16),
    clamp(mean / (sb / n || 1), 0.86, 1.16),
  ];
  lums.sort((a, b) => a - b);
  const p90 = lums[Math.floor(lums.length * 0.9)] || 1;
  // 208 rather than 255: the brightest tenth of a facade is render in sunlight,
  // not white paper.
  const gain = clamp(208 / p90, 0.9, 1.8);
  return { gain, balance };
}

const applyExposure = ([r, g, b], { gain, balance }) => [
  clamp(r * balance[0] * gain, 0, 255),
  clamp(g * balance[1] * gain, 0, 255),
  clamp(b * balance[2] * gain, 0, 255),
];

// The dominant hue among a set of pixels, as a 30-degree bin, then the median
// of just that bin.
//
// Taking the median of every saturated pixel on a shopfront averages a pink
// salon sign against a green awning against a yellow board and returns brown —
// which is what the first version of this did, on a tile whose sign is plainly
// magenta. Signage is one strong hue at a time; find which one, then measure
// only it.
function dominantHueColor(pixels, minSat) {
  const bins = new Array(12).fill(0).map(() => []);
  const mass = new Array(12).fill(0);
  for (const p of pixels) {
    const sat = saturation(...p);
    if (sat < minSat) continue;
    const b = Math.floor(hue(...p) / 30) % 12;
    bins[b].push(p);
    // Weight by how far past the threshold the pixel is. Counting pixels alone
    // hands every shopfront to the warm-brown bin, because haze pushes a large
    // slab of ordinary wall just over any fixed saturation line while the sign
    // itself is a small, very saturated patch. Saturation mass asks which hue
    // is *loud*, not which is common — and a signboard is the loud one.
    mass[b] += sat - minSat;
  }
  let best = null;
  for (let i = 0; i < 12; i += 1) {
    // Neighbouring bins count too, or a hue sitting on a bin boundary loses to
    // one sitting in the middle of a weaker bin.
    const score = mass[i] + (mass[(i + 11) % 12] + mass[(i + 1) % 12]) * 0.5;
    if (!best || score > best.score) best = { i, score, own: bins[i] };
  }
  if (!best || best.own.length < 4) return null;
  const strong = best.own.slice().sort((a, b) => saturation(...b) - saturation(...a))
    .slice(0, Math.max(4, Math.floor(best.own.length * 0.5)));
  return { color: medianColor(strong), share: best.score / Math.max(1, pixels.length) };
}

// The strongest repeating period in a 1-D signal, by plain autocorrelation.
// Used for both the floor rhythm (rows) and the window rhythm (columns): a
// facade is the most periodic thing in a city, which is exactly why this works
// at all on imagery this poor.
function dominantPeriod(signal, minLag, maxLag) {
  const n = signal.length;
  if (n < minLag * 2) return null;
  const mean = signal.reduce((a, b) => a + b, 0) / n;
  const centred = signal.map((v) => v - mean);
  const energy = centred.reduce((a, b) => a + b * b, 0) || 1;

  let best = null;
  for (let lag = minLag; lag <= Math.min(maxLag, n - minLag); lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) sum += centred[i] * centred[i + lag];
    const score = sum / energy;
    if (!best || score > best.score) best = { lag, score };
  }
  // Below about a fifth of self-similarity there is no rhythm in the picture,
  // only grain. Saying "no idea" here is worth more than a confident wrong
  // number, because the caller has a decent fallback and this does not.
  return best && best.score > 0.18 ? best : null;
}

// ------------------------------------------------------------------ the read

const GRID_W = 56;
const GRID_H = 72;

function readTile(raw, size, rect, entry) {
  const { x0, y0, w, h } = rect;
  if (w < 24 || h < 24) return null;

  // Downsample into a fixed grid by box-averaging, so every tile is analysed at
  // the same resolution regardless of how big it landed in the atlas.
  const cell = [];
  for (let gy = 0; gy < GRID_H; gy += 1) {
    const row = [];
    for (let gx = 0; gx < GRID_W; gx += 1) {
      // Relative first, absolute second. Mixing the two — taking a max of an
      // already-offset coordinate against a relative one — walks the sampler
      // clean off the tile and into the rest of the atlas.
      const rx0 = Math.floor((gx * w) / GRID_W);
      const rx1 = Math.max(rx0 + 1, Math.floor(((gx + 1) * w) / GRID_W));
      const ry0 = Math.floor((gy * h) / GRID_H);
      const ry1 = Math.max(ry0 + 1, Math.floor(((gy + 1) * h) / GRID_H));
      const sx0 = x0 + rx0; const sx1 = x0 + Math.min(w, rx1);
      const sy0 = y0 + ry0; const sy1 = y0 + Math.min(h, ry1);
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = sy0; y < sy1; y += 1) {
        let i = (y * size + sx0) * 3;
        for (let x = sx0; x < sx1; x += 1) {
          r += raw[i]; g += raw[i + 1]; b += raw[i + 2];
          i += 3; n += 1;
        }
      }
      row.push(n ? [r / n, g / n, b / n] : [0, 0, 0]);
    }
    cell.push(row);
  }

  // Row 0 is the top of the wall: the atlas was written top-row-first and the
  // texture is loaded with flipY off, so this orientation matches what the
  // renderer sees.
  const lum = cell.map((row) => row.map(([r, g, b]) => luminance(r, g, b)));

  // ---- how many floors
  //
  // Horizontal edge energy per row. Floor slabs, string courses, window heads
  // and sills all leave a horizontal line; the spacing between those lines is
  // the storey height whether or not any individual line is a slab.
  const rowEdge = [];
  for (let y = 1; y < GRID_H; y += 1) {
    let sum = 0;
    for (let x = 0; x < GRID_W; x += 1) sum += Math.abs(lum[y][x] - lum[y - 1][x]);
    rowEdge.push(sum / GRID_W);
  }
  const expected = Math.max(1, Math.round(entry.height / STOREY_H));
  const rowPeak = dominantPeriod(rowEdge, Math.max(5, Math.floor(GRID_H / 9)), Math.floor(GRID_H / 1.6));
  let storeys = expected;
  if (rowPeak) {
    const read = Math.round(GRID_H / rowPeak.lag);
    // Only believe the picture when it is in the same neighbourhood as the
    // height we already have. A read of 9 floors on a 10 m building means the
    // autocorrelation locked onto the window rhythm, not the floor rhythm.
    if (Math.abs(read - expected) <= 2) storeys = read;
  }
  storeys = clamp(storeys, 1, 9);

  // ---- how many window bays across the frontage
  const upperEnd = Math.floor(GRID_H * 0.62);   // above the shopfront band
  const colEdge = [];
  for (let x = 1; x < GRID_W; x += 1) {
    let sum = 0;
    for (let y = 0; y < upperEnd; y += 1) sum += Math.abs(lum[y][x] - lum[y][x - 1]);
    colEdge.push(sum / upperEnd);
  }
  const wallLen = Math.hypot(entry.wall[2] - entry.wall[0], entry.wall[3] - entry.wall[1]);
  const colPeak = dominantPeriod(colEdge, Math.max(4, Math.floor(GRID_W / 10)), Math.floor(GRID_W / 1.8));
  // A window bay in this layout runs about 2.4 m — one window plus its pier.
  let bays = clamp(Math.round(wallLen / 2.6), 1, 9);
  if (colPeak) {
    const read = Math.round(GRID_W / colPeak.lag);
    const spacing = wallLen / Math.max(1, read);
    if (spacing > 1.6 && spacing < 6.5) bays = clamp(read, 1, 10);
  }

  // ---- colours
  //
  // Read off an exposure-corrected copy, never off the raw frame.
  const exposure = normaliseExposure(cell);
  const fix = (p) => applyExposure(p, exposure);

  const upper = [];
  for (let y = 2; y < upperEnd; y += 1) for (let x = 0; x < GRID_W; x += 1) upper.push(fix(cell[y][x]));
  // Find the signboard rather than assuming where it is.
  //
  // The obvious thing — "signs sit at the fascia, so read rows 54% to 78%" —
  // does not survive contact with the data. These tiles are rectified to the
  // footprint's height estimate, not to what the photograph actually contains,
  // so the shopfront lands anywhere from a third of the way down to the very
  // bottom depending on how good that estimate was. Assuming a band finds
  // stucco on half the buildings in the layout.
  //
  // A signboard has one property nothing else on the wall has: it is a
  // horizontal stripe of strongly saturated colour. So slide a band down the
  // tile and take the position where saturation is most concentrated. That
  // finds the sign wherever the rectification happened to put it, and on a
  // building with no sign it finds nothing loud enough to pass the threshold
  // below and correctly reports none.
  const BAND = Math.max(4, Math.round(GRID_H * 0.09));
  const rowSat = [];
  for (let y = 0; y < GRID_H; y += 1) {
    let sum = 0;
    for (let x = 0; x < GRID_W; x += 1) {
      const p = fix(cell[y][x]);
      const sat = saturation(...p);
      sum += sat > 0.12 ? sat : 0;
    }
    rowSat.push(sum / GRID_W);
  }
  let bandTop = 0; let bandBest = -1;
  // Not the very top (sky fringe and parapet) and not the very bottom (road,
  // scooters, the dashboard of the car that took the picture).
  // Stop well above the pavement. Everything colourful at the bottom of these
  // frames belongs to the street, not the building: bags of rubble, a stack of
  // yellow sacks, a red scooter, the bonnet of the car the camera is in. On the
  // first pass this band search happily reported a pile of yellow sacks as the
  // shopfront colour of the building behind it.
  for (let y = Math.floor(GRID_H * 0.12); y + BAND < Math.floor(GRID_H * 0.72); y += 1) {
    let sum = 0;
    for (let k = 0; k < BAND; k += 1) sum += rowSat[y + k];
    if (sum > bandBest) { bandBest = sum; bandTop = y; }
  }
  const fascia = [];
  for (let y = bandTop; y < bandTop + BAND; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) fascia.push(fix(cell[y][x]));
  }
  const ground = [];
  for (let y = Math.floor(GRID_H * 0.72); y < Math.floor(GRID_H * 0.94); y += 1) {
    for (let x = 0; x < GRID_W; x += 1) ground.push(fix(cell[y][x]));
  }
  if (!upper.length || !ground.length || !fascia.length) return null;

  const byLum = upper.slice().sort((a, b) => luminance(...a) - luminance(...b));

  // The wall is the mid-to-upper mass of the histogram: darker than the sky
  // fringe and the sun-struck parapet, lighter than every opening.
  const wall = medianColor(byLum.slice(
    Math.floor(byLum.length * 0.42), Math.floor(byLum.length * 0.86)));
  // The openings are the dark tail. On these buildings that is glass in shadow
  // plus the reveal around it, which is the colour we want for the recess.
  const glass = medianColor(byLum.slice(0, Math.floor(byLum.length * 0.14)));
  // Trim — the painted band, the parapet coping, the window surround — is the
  // bright tail.
  const trim = medianColor(byLum.slice(Math.floor(byLum.length * 0.93)));

  const groundColor = medianColor(ground);

  // The signboard, and separately the shutter/awning colour: both are strong
  // single hues on the ground band, and both are worth having, so take the two
  // most populated hue bins rather than one.
  const signRead = dominantHueColor(fascia, 0.12);
  // bandBest is the saturation mass of the winning band. Below about a tenth of
  // a saturation unit per pixel there is no board there, only a warm patch.
  const signStrength = bandBest / BAND;
  const sign = signRead && signStrength > 0.03 ? signRead.color : null;
  // Painted trim on the upper wall — the band course, the balcony rail colour.
  const accentRead = dominantHueColor(upper, 0.11);
  const accent = accentRead && accentRead.share > 0.012 ? accentRead.color : null;

  // How much of the wall is opening rather than solid. Drives whether this gets
  // punched windows or a glazed ribbon.
  const wallLum = luminance(...wall);
  let dark = 0;
  for (const p of upper) if (luminance(...p) < wallLum * 0.66) dark += 1;
  const openRatio = dark / upper.length;

  return {
    building: entry.building,
    wall: entry.wall,
    wallIndex: entry.wallIndex,
    height: entry.height,
    storeys,
    bays,
    openRatio: Math.round(openRatio * 1000) / 1000,
    wallColor: hex(wall),
    trimColor: hex(trim),
    glassColor: hex(glass),
    groundColor: hex(groundColor),
    signColor: sign ? hex(sign) : null,
    accentColor: accent ? hex(accent) : null,
    // Where the sign band was found, as a fraction of wall height from the top.
    signAt: sign ? Math.round(((bandTop + BAND / 2) / GRID_H) * 1000) / 1000 : null,
    signStrength: Math.round(signStrength * 1000) / 1000,
    exposure: Math.round(exposure.gain * 100) / 100,
    quality: entry.quality,
    // Kept so a later pass can tell a confident read from a guess.
    rhythm: {
      rows: rowPeak ? Math.round(rowPeak.score * 100) / 100 : 0,
      cols: colPeak ? Math.round(colPeak.score * 100) / 100 : 0,
    },
  };
}

// ------------------------------------------------------------------ driver

async function main() {
  const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
  const size = index.atlasSize;
  const out = [];

  for (let a = 0; a < index.atlases.length; a += 1) {
    const file = path.join(DIR, index.atlases[a]);
    if (!fs.existsSync(file)) continue;
    const { data } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const entries = index.facades.filter((f) => f.atlas === a);
    process.stdout.write(`atlas ${a}: ${entries.length} tiles\n`);

    for (const entry of entries) {
      const [u0, v0, u1, v1] = entry.uv;
      const rect = {
        x0: Math.round(u0 * size),
        y0: Math.round(v0 * size),
        w: Math.round((u1 - u0) * size),
        h: Math.round((v1 - v0) * size),
      };
      const read = readTile(data, size, rect, entry);
      if (read) out.push(read);
    }
  }

  // Report the spread, because a read that returns the same four numbers for
  // every building has failed silently and looks exactly like one that worked.
  const storeyHist = {};
  const bayHist = {};
  for (const r of out) {
    storeyHist[r.storeys] = (storeyHist[r.storeys] || 0) + 1;
    bayHist[r.bays] = (bayHist[r.bays] || 0) + 1;
  }
  const signs = out.filter((r) => r.signColor !== null).length;
  console.log(`read ${out.length} facades`);
  console.log("storeys", storeyHist);
  console.log("bays   ", bayHist);
  console.log(`signboards detected: ${signs}`);
  console.log("open ratio: min %s median %s max %s",
    Math.min(...out.map((r) => r.openRatio)).toFixed(3),
    out.map((r) => r.openRatio).sort((a, b) => a - b)[out.length >> 1].toFixed(3),
    Math.max(...out.map((r) => r.openRatio)).toFixed(3));

  fs.writeFileSync(OUT, JSON.stringify({
    attribution: index.attribution,
    note: "architectural reading of Mapillary imagery; no pixels ship",
    facades: out,
  }));
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
