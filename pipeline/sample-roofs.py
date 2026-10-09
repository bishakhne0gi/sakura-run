#!/usr/bin/env python3
"""Sample the real roof colour of every building from satellite imagery.

Footprints tell you where a building is. They say nothing about what it looks
like — and from the air, what a building looks like *is* its roof. Bengaluru
roofs are a specific and very legible set: blue corrugated sheet, terracotta
tile, bare grey RCC, and white-ish weatherproofed terrace. Reading that off the
imagery per building is the difference between a plausible city and this city.

Median, not mean: a mean is dragged around by one overhanging branch or one
bright specular patch, while the median of a few hundred pixels is the roof.
"""
import json, math, os, sys, urllib.request, concurrent.futures
from PIL import Image, ImageDraw
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGIN = dict(lat=12.917, lon=77.6422)
METRES_PER_DEG_LAT = 110574
MPD_LON = 111320 * math.cos(math.radians(ORIGIN["lat"]))
ZOOM = 18                      # ~0.45 m/px here: a 10 m roof is ~22 px across
TILE = 256
URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
       "World_Imagery/MapServer/tile/{z}/{y}/{x}")
CACHE = "/tmp/sakura-tiles"

def lonlat_to_px(lon, lat, z):
    n = TILE * (1 << z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y

def local_to_lonlat(mx, mz):
    return ORIGIN["lon"] + mx / MPD_LON, ORIGIN["lat"] - mz / METRES_PER_DEG_LAT

def fetch(tx, ty):
    os.makedirs(CACHE, exist_ok=True)
    path = f"{CACHE}/{ZOOM}_{tx}_{ty}.jpg"
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    req = urllib.request.Request(URL.format(z=ZOOM, x=tx, y=ty),
                                 headers={"User-Agent": "sakura-run-hsr/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
            f.write(r.read())
    except Exception as exc:                       # a missing tile is not fatal
        print("  tile failed", tx, ty, exc, file=sys.stderr)
        open(path, "wb").close()
    return path

def main():
    world = json.load(open(f"{ROOT}/public/world.json"))
    minx, minz, maxx, maxz = world["bounds"]
    lon0, lat0 = local_to_lonlat(minx, minz)       # north-west
    lon1, lat1 = local_to_lonlat(maxx, maxz)       # south-east
    px0, py0 = lonlat_to_px(lon0, lat0, ZOOM)
    px1, py1 = lonlat_to_px(lon1, lat1, ZOOM)
    tx0, ty0 = int(px0 // TILE), int(py0 // TILE)
    tx1, ty1 = int(px1 // TILE), int(py1 // TILE)
    tiles = [(x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]
    print(f"  {len(tiles)} tiles at z{ZOOM}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda t: fetch(*t), tiles))

    # Stitch into one array so a footprint straddling a tile edge is not a
    # special case.
    W = (tx1 - tx0 + 1) * TILE
    H = (ty1 - ty0 + 1) * TILE
    canvas = Image.new("RGB", (W, H), (110, 110, 105))
    for tx, ty in tiles:
        path = f"{CACHE}/{ZOOM}_{tx}_{ty}.jpg"
        if os.path.getsize(path) == 0:
            continue
        canvas.paste(Image.open(path).convert("RGB"),
                     ((tx - tx0) * TILE, (ty - ty0) * TILE))
    pixels = np.asarray(canvas)
    ox, oy = tx0 * TILE, ty0 * TILE
    print(f"  mosaic {W}x{H}")

    sampled = 0
    for b in world["buildings"]:
        poly = []
        for mx, mz in b["points"]:
            lon, lat = local_to_lonlat(mx, mz)
            x, y = lonlat_to_px(lon, lat, ZOOM)
            poly.append((x - ox, y - oy))
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        x0, x1 = int(min(xs)), int(max(xs)) + 1
        y0, y1 = int(min(ys)), int(max(ys)) + 1
        if x1 - x0 < 1 or y1 - y0 < 1 or x0 < 0 or y0 < 0 or x1 > W or y1 > H:
            continue
        mask = Image.new("L", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(mask).polygon([(px - x0, py - y0) for px, py in poly], fill=255)
        m = np.asarray(mask) > 0
        # Erode by ignoring the outer ring of a small footprint would leave
        # nothing, so only shrink when there is room.
        if m.sum() < 6:
            cx, cy = int(sum(xs) / len(xs)), int(sum(ys) / len(ys))
            if not (0 <= cx - ox < W and 0 <= cy - oy < H):
                continue
            patch = pixels[max(0, cy - oy - 1):cy - oy + 2, max(0, cx - ox - 1):cx - ox + 2]
            if patch.size == 0:
                continue
            rgb = np.median(patch.reshape(-1, 3), axis=0)
        else:
            rgb = np.median(pixels[y0:y1, x0:x1][m], axis=0)
        b["roof"] = [int(rgb[0]), int(rgb[1]), int(rgb[2])]
        sampled += 1

    world["imagery"] = {
        "source": "Esri World Imagery",
        "zoom": ZOOM,
        "sampled": sampled,
    }
    json.dump(world, open(f"{ROOT}/public/world.json", "w"), separators=(",", ":"))
    print(f"  sampled {sampled} / {len(world['buildings'])} roofs")

if __name__ == "__main__":
    main()
