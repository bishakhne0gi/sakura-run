# Sakura Run — HSR Layout

A first-person walking simulator of **HSR Layout, Bengaluru**, built from real OpenStreetMap geometry and rendered with physically-based materials, a sun-and-sky environment, traffic and pedestrians. Walk it, cycle it, or take an auto through tabebuia season — or lift off into the drone camera and read the whole layout from 300 m.

Inspired by *Sakura Run*'s stylised Japanese suburb. The transplant is not arbitrary: **Tabebuia rosea**, the pink trumpet tree, actually blooms across Bengaluru in March, so HSR gets a real sakura season rather than a borrowed one.

```bash
npm install
npm run dev        # http://localhost:5188
```

## What is real

Everything structural comes from OSM, not from imagination:

| | |
| --- | --- |
| Area | 2,108 m × 2,114 m centred on 12.917°N, 77.6422°E |
| Buildings | 9,763 real footprints (114 with surveyed heights or storey counts) |
| Roads | 528 segments — the full Main and Cross grid |
| Water | Agara Lake (27.4 ha) and the K200 drain |
| Green | 39 parks and grounds, incl. Agara Lake Park, HSR Club, BBMP Ground |
| Points of interest | 300 named shops and amenities |
| Trees | 7,264 placed procedurally (2,920 tabebuia) |

Walk up to a shopfront and the prompt names the actual business — *Frozen Bottle*, *Sector 2 Park*, whatever OSM records there. The coordinate readout (`C`) is true lat/lon: cross-check it against a map.

Building heights are inferred where OSM has none, using HSR's real pattern — G+2/G+3 residential, taller on the Main-road retail strips, taller again for hospitals and offices.

## Controls

| Key | |
| --- | --- |
| `W A S D` | move |
| `Shift` | run / accelerate |
| Mouse | look |
| `V` | cycle |
| `B` | auto-rickshaw |
| `P` | third person |
| `E` | interact |
| `G` | bird view (drone camera) |
| `M` | full map |
| `N` | minimap on/off |
| `T` | time of day (5 presets, incl. night) |
| `L` | style: anime / photographic |
| `O` | post-processing on/off (remembered; `?nopost` also works) |
| `K` | ambience |
| `C` | coordinates |
| `Esc` | release cursor |

In bird view `W A S D` fly the drone across the city, the scroll wheel changes altitude, `Shift` moves fast, and the horizon stays level — it is a camera over a place, not a six-degree free-fly.

The three traversal modes are different vehicles, not speed multipliers. What separates them is how they *refuse* to turn: a body on foot changes heading instantly and free-strafes; a cycle leans and carries momentum; an auto understeers, needs speed before the steering bites, and rolls into corners. Tuning only top speed makes all three feel identical.

## How it is built

```
pipeline/build-world.mjs    OSM JSON  ->  public/world.json  (plain metres, engine-agnostic)
pipeline/read-facades.mjs   Mapillary photos -> public/facades/read.json (floors, bays, paint)
src/world/build.js          world.json -> merged + instanced Three.js geometry
src/world/facades3d.js      modelled windows, sills, chajjas, string courses, shopfronts
src/world/traffic.js        vehicle + pedestrian agents on a graph of the OSM centrelines
src/world/collision.js      circle-vs-edge over a 20 m spatial hash
src/player/controller.js    the three vehicles
src/player/birdcam.js       the drone camera
src/render/textures.js      every surface, drawn to canvas at load — no image files ship
src/render/materials.js     PBR material library, tinted per building by vertex colour
src/render/environment.js   sky shader, PMREM environment, sun + day cycle
src/render/post.js          bloom, grade, SMAA
src/ui/map.js               minimap + full map, drawn from the same world.json
src/audio/ambience.js       procedural — the street's own noise, no files
src/audio/music.js          shipped soundtrack, falling back to a synthesised score
pipeline/fetch-music.mjs    pulls 8 CC0 tracks out of a 529 MB zip by byte range
```

Refresh the map data:

```bash
curl -s -X POST --data-urlencode "data@pipeline/query.overpassql" \
  https://overpass-api.de/api/interpreter -o data/hsr-raw.json
npm run world
```

`world.json` is deliberately plain JSON in local metres — if this ever moves to Unity, the pipeline does not.

### Where the buildings come from

Buildings are from **Overture Maps**, not from the Overpass extract. Overture merges OpenStreetMap with **Google Open Buildings** and **Microsoft's ML building footprints**, both derived from satellite imagery. For this bbox that is 9,763 footprints against 2,223 in the OSM-only extract, and the difference is every plot nobody has ever traced by hand — which in a layout like HSR is most of the interior of every block.

| Source | Footprints |
| --- | --- |
| OpenStreetMap | 8,642 |
| Google Open Buildings (satellite) | 788 |
| Microsoft ML Buildings (satellite) | 333 |

Pull it again with DuckDB against Overture's public S3 (about five minutes; the query filters by bbox so nothing large is downloaded):

```bash
python3 -m venv /tmp/geoenv && /tmp/geoenv/bin/pip install duckdb
/tmp/geoenv/bin/python pipeline/fetch-overture.py     # -> data/overture-buildings.json
npm run world
```

**Heights are still mostly inferred, and that matters.** Overture carries a surveyed height for 5 buildings here and a storey count for 128; there is no free global source of satellite-derived building heights. The other ~9,600 are reasoned from footprint area, use and road class. Provenance is recorded per building so the claim stays checkable.

### The prop layer

The reference has almost nobody on screen and still reads as inhabited, because every metre of its pavement carries something. `src/world/props.js` is that layer, and it is specific to Bengaluru rather than generic street furniture: a compound wall with a sliding gate in front of every set-back plot, two-wheelers nosed into the kerb in rows, pole-mounted distribution transformers, BBMP bins, tulsi pots by the gate, hoardings and bus shelters on the arterials. Roughly 4,000 parked two-wheelers, 1,300 gates and 1,300 pots, all instanced, all placed off the same carriageway index the footpaths use so nothing stands in a live lane.

A compound wall is only drawn where the building is genuinely set back from the street — where a plot builds up to the pavement, which is most of the retail frontage, there is no compound and drawing one puts a wall through the shopfront.

### The roofs are the real roofs

Footprints say where a building is. They say nothing about what it looks like — and from the air, what a building looks like *is* its roof. So every footprint is sampled against **Esri World Imagery** at zoom 18 (~0.45 m/px, a 10 m roof is ~22 px across) and given the median colour of the real pixels inside it. Median, not mean: a mean is dragged around by one overhanging branch or one bright specular patch, while the median of a few hundred pixels is the roof.

9,703 of 9,763 roofs carry a real sampled colour, and the distribution is exactly Bengaluru:

| What the imagery sees | Roofs |
| --- | --- |
| tan / ochre (weathered RCC terrace) | 6,194 |
| white / pale grey (newer terrace) | 1,654 |
| terracotta / red (Mangalore tile) | 989 |
| green (a tree is standing over it) | 529 |
| dark grey | 295 |
| blue corrugated sheet | 39 |

That reading also decides roof *form*, not just colour: terracotta means Mangalore tile, and Mangalore tile is always pitched, so a roof that photographs orange gets a gable and one that photographs grey does not. Where a canopy covers the roof the sample is green — that is a tree, not a green roof, so it falls back to weathered concrete.

The colours are then pushed the way a background artist pushes a reference photo — saturation and value up, both quantised to a few steps so neighbouring roofs land on the same colour often enough to read as a palette. Hue is kept: that is the part carrying the real information.

```bash
/tmp/geoenv/bin/python pipeline/sample-roofs.py    # 225 tiles, ~30 s, cached in /tmp
```

Imagery © Esri, Maxar, Earthstar Geographics — sampled for colour only; no imagery is redistributed with this build.

### Why no two buildings match

Individuality has to be *derived* rather than read: even with 9,763 footprints there are only 114 storey counts and 169 names. Every per-building choice — storeys, facade, roof form, paint, whether it has a stair block — is drawn from a stable hash of the footprint centroid, so the city is identical on every load and no two neighbours agree.

- **Twelve facade variants**, not one texture with twelve tints: different bay counts, window proportions, grilles, chajjas (the concrete sunshade over an opening), cladding bands and cill lines. Buildings are grouped by variant and merged per group, so twelve elevations cost twelve draw calls.
- **Heights snap to whole storeys.** A skyline of 13.6 m, 11.2 m and 9.9 m blocks reads as noise; a skyline of G+3, G+2 and G+1 reads as a layout. Storey count comes from the surveyed tag where it exists, otherwise from plot area, use, and the class of road the plot sits on — the same rule the city itself followed.
- **Three roof forms**: flat RCC with a parapet, a Mangalore-tile gable on small older plots, and a setback penthouse storey on blocks over G+3.
- Everything stands on a plinth. A wall that meets the pavement in a clean line always reads as a render.

### The names are the real names

The 191 named businesses in the extract are mounted as readable signboards on the wall of the building they belong to — flush to the frontage, with a projecting blade sign on every third shop, which is the one you can actually read walking along the footpath. They are packed sixteen to a texture atlas, so the whole high street costs a handful of textures, and they light up with the shopfronts at dusk.

### Two styles over one world

`L` switches between an **anime** style and a **photographic** one. The textures, the signage, the facade variants and the geometry are identical in both — what changes is how light lands on them, which is the honest way to do this: an anime frame is not a photograph with a filter over it, it is the same world with the shading quantised, the palette lifted and the silhouettes drawn.

- **Shading**: `MeshToonMaterial` against a three-step gradient map, with the darkest band held at 0.74. An even ramp puts the shadow near 0.33, which multiplied into an already-dark road crushes the lower half of the frame to black; in the reference the shadow side is a *tint* step, not an absence of light.
- **No bloom.** A cel frame does not glow, and bloom was also the source of every hard-edged black block this renderer produced — whole black frames at altitude, rectangular holes at street level. It is the most driver-sensitive pass in the chain and contributes nothing to this look. It stays on for the photographic style, where it belongs.
- **Ink**: outlines fade out past ~300 m. A 24-bit depth buffer over 0.3–4000 m resolves to whole metres by a few hundred metres out, so beyond that there is no signal left to threshold — only noise to amplify, which inked the entire drone view solid until the tolerance was made quadratic in distance.
- **Ink**: an outline pass reading the depth buffer the scene pass already wrote — one full-screen pass rather than a second render of the city. Silhouettes come from a first-order depth jump, creases (the corner where two walls of one building meet) from a Laplacian of linear depth. Reconstructing normals from depth was tried first and is pure noise at this depth range.
- **Surfaces**: the same drawing code runs with the noise, grain and weathering passes suppressed, so every *shape* survives — window, shutter, lane marking, signboard — and only the photographic texture goes.
- **Tone mapping**: ACES in the photographic style, none in the anime one. A filmic curve is exactly wrong for flat colour: it muddies every band.

### How it is rendered

Nothing here loads an image or a mesh file. Every surface is a canvas drawn at load time and turned into an albedo, a roughness map and a normal map derived from the same drawing by a Sobel pass — so a window recess, a kerb chamfer and a paver joint are lit consistently, and a lane marking can be placed at an exact metre offset across the carriageway, which no downloaded asphalt photo can do.

Materials are `MeshStandardMaterial` lit by a directional sun *and* by an environment map rendered from the sky shader through `PMREMGenerator`. The environment map is the important half: without it, every surface facing away from the sun falls back to flat ambient and the whole city looks like clay.

Facades are UV-mapped in real metres by a custom `UVGenerator`, so one texture tile is one 3.2 m storey and floors line up across all 2,223 buildings. Shopfront buildings are split at 3.9 m and the ground floor gets its own shutter-and-signboard material — the ground floor of an Indian street is a different building from the flats above it, and tiling one facade to the pavement is the single clearest tell of a procedural city.

Trees are crossed alpha-cut cards, not subdivided spheres: a canopy is mostly holes, and holes are what solid geometry cannot do.

### Performance

~90 draw calls and ~700k triangles for the whole 2 km² city, 100 fps on an M-series laptop with bloom, grade and SMAA running. 2,223 buildings merge into batched buffers; 7,264 trees are four `InstancedMesh` draws; traffic and pedestrians are nine more; DPR is capped at 2; the sun's shadow camera follows the player and snaps to shadow-map texels so edges do not crawl. If the frame rate falls below ~34 fps for a few seconds, post-processing switches itself off — decorative effects degrade before anything the player steers with. `O` toggles it by hand and the choice is remembered, because post-processing is the one part of this renderer that can fail in a driver rather than in the code.

**The composer runs in device pixels.** `renderer.getSize()` returns *CSS* pixels, so building the composer's render target from it produces a half-size target on any Retina display — while the full-screen passes still render with the renderer's viewport in device pixels. Every fragment outside the target's bounds is discarded, and the result on screen is a hard-edged black rectangle over most of the frame, worst in bird view where there is most to draw. It renders perfectly at DPR 1, which is what makes it look intermittent rather than broken. The target is built from `getDrawingBufferSize()` and the composer is given an explicit pixel ratio, re-read on every resize so that dragging the window to a different display cannot reintroduce the mismatch.

**There is a watchdog.** Twice a second the renderer samples five pixels of the finished frame; if all five are pure black three checks running, the effects chain is not producing an image and the renderer falls back to drawing the scene directly and says so. A black frame costs nothing to draw, so frame rate never drops and no other safeguard would notice.

The composer's HDR target is deliberately **not** multisampled. A multisampled half-float target fails to resolve on some drivers: a large rectangular block of the resolved texture comes back black, which reads as the middle of the frame going missing — most visibly in bird view, where the scene is heaviest. SMAA at the end of the chain does the anti-aliasing instead.

### Buildings from photographs, without the photographs

The street-level pipeline pulls 7,158 Mapillary camera poses, matches 1,029 of
them to building walls, and rectifies 399 of those into facade tiles. For a
while those tiles were the walls: real photographs of real HSR buildings, mapped
onto the buildings' own geometry.

They are not any more, and the reason is worth writing down. A photograph on a
wall is flat. It carries the dashcam's exposure, its haze, its parked scooters
and the power line across the parapet, it stops at the corner, and — decisively
— it cannot cast a shadow. The one thing a window does that a picture of a
window cannot is catch light on its own edges.

So `pipeline/read-facades.mjs` reads the tiles as architecture instead of as
pixels. Per building it reports: how many floors (horizontal edge autocorrelation,
believed only where it agrees with the surveyed height), how many window bays
(the same, across the columns), the paint colour, the glazing colour, and the
signboard colour and where on the wall it sits. `src/world/facades3d.js` then
builds that description out of geometry — a surround standing 55 mm proud, a
sill thrown 140 mm clear, a cantilevered chajja over the openings that need one,
a string course at every floor level, glazing and a board at the shopfront.

134,409 modelled windows, 2.9 M triangles, bucketed into 220 m cells so the
frustum discards what you are not looking at, and switched off entirely in bird
view where a 90 mm sill is a fraction of a pixel. The photographs never ship.
`?photos=1` puts the old photographic walls back for comparison.

Three things that cost an iteration each, recorded so they are not repeated:

- **Textbook saturation is the wrong measure for finding a signboard.**
  `(max - min) / max` divides by brightness, so shadow under an awning outscores
  a scarlet board in sun. The band search reliably found the darkest strip on
  every wall. Absolute chroma with a luminance gate finds the sign.
- **Do not assume where the fascia is.** Tiles are rectified to the footprint's
  *estimated* height, so the shopfront lands anywhere from a third of the way
  down to the bottom. Scanning for the most colour-concentrated band finds it;
  a fixed band finds stucco. Stop the scan above the pavement, or a stack of
  yellow rubble sacks becomes the shop's colour.
- **Read colour off an exposure-corrected copy.** These are underexposed,
  blue-shifted, hazy frames. Straight medians give a uniformly muddy grey city,
  which is exactly what the photographic walls looked like.

### The ground is the shape of the city

There used to be one 3.3 km plane of bare earth under everything, centred on the
extract and padded 600 m past it on every side. It guaranteed that no gap
between polygons ever showed sky, and it also meant the layout sat in the middle
of an enormous blank brown field — the opposite of what the bird camera is for.

The ground is now an island the shape of the place. Every road centreline, every
footprint, every park and water ring is stamped into a 10 m grid — areas
scanline-*filled*, not outlined, because seeding only the vertices of Agara Lake
seeds its shoreline and punches a ragged hole through the middle of the world. A
chamfer distance transform runs out from those seeds and ground exists within
46 m of something, which keeps a verge round the outermost buildings and carries
a road out to the edge of the extract. Anything enclosed by city on all sides is
filled back in regardless of distance: a gap at the edge is the coastline, a gap
in the middle is a hole in the floor, and connectivity is the only thing that
tells them apart. The rim drops 55 m so the island has a thickness rather than
reading as a paper cut-out.

4.8 km² of ground instead of 11 km², and from the planet camera HSR is a world
with nothing else on it.

One bug worth recording, because the symptom was nothing like the cause: the
skirt panels were given `(0, 0, 0)` as their normal, meaning "no vertical
component" rather than "no normal". N·L is undefined for a zero normal, the
whole rim lit pure white, and through the bird camera's curvature the near rim
bent up into frame as bright white blobs sitting over the city — a convincing
impression of holes punched through the world, 600 m from the actual fault.

### The score

`public/music/` carries eight tracks from [Open Lo-Fi](https://github.com/btahir/open-lofi),
released under **CC0 1.0 Universal** — public domain, no attribution required,
commercial use fine. The credit here is courtesy, not obligation. `J` toggles,
`Shift+J` skips, and the HUD names the track.

They are distributed only inside a 529 MB release archive, and we want 25 MB of
it. `pipeline/fetch-music.mjs` reads the zip over HTTP range requests — the last
200 KB for the end-of-central-directory record, then the central directory it
points at, then the exact byte ranges of the eight members — and inflates them
locally. 95% of the archive is never transferred.

If `public/music/index.json` is absent, `src/audio/music.js` falls back to a
generative score synthesised in the browser — a slow maj7/m7 progression on
detuned pads with a pentatonic melody that rests as often as it plays. It is not
a loop: a fixed loop announces itself the third time round, which is exactly
when a player has settled in and stopped noticing the city. A clean checkout is
never silent.

### The blossom field

Petals use the tumble-drives-slip mechanism: each petal tumbles on its own axis so it presents a face, thins to an edge, and opens out again, and its sideways slip is driven by *that same angle*, ninety degrees out of phase. Drive the slip from an independent sine and the eye reads a wobble or an easing bug instead of a petal caught by the air. The quad is scaled by `sin(tumble)` so it genuinely thins to a line at the crossing rather than fading out.

## Accessibility and lifecycle

- `prefers-reduced-motion: reduce` freezes the petal field on a composed still frame rather than removing it, and cuts the field density.
- `dt` is clamped to 1/30 s, so a backgrounded tab does not teleport the player on return.
- The intro veil is a real `<button>` with a visible focus ring.
- Audio only starts on an explicit `M` press, as browsers require.

## Known limits

- **No interiors, no doors, no compound walls.** Plot boundaries are not in the extract, so the gap between a carriageway and a building line renders as unpaved forecourt rather than as gates and hedges.
- **Traffic is ambient, not simulated.** Agents drive a real graph on the correct (left-hand) side and turn at junctions, but they do not avoid each other, obey signals, or see the player. It is life in the frame, not a traffic model.
- **Auto physics are arcade.** The three modes differ in how they refuse to turn; there is no suspension, weight transfer or tyre model.
- No interiors — buildings are solid extrusions.
- Terrain is flat; HSR's real gradients are not modelled.
- **The facade read is approximate.** Floor and bay counts are believed only where they agree with the height already known; signboard detection is roughly right and not reliable — street clutter is as colourful as signage. Buildings with no photograph fall back to their footprint and satellite roof sample.
- Pedestrians within 30 m are skinned Mixamo characters with a real walk cycle; beyond that they are instanced parts whose limbs swing from the hip and shoulder. There is no idle animation, so someone standing still walks on the spot.

## Attribution

Music: [Open Lo-Fi](https://github.com/btahir/open-lofi), CC0 1.0 Universal (public domain). No attribution required; credited anyway.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed under the **Open Database License (ODbL) 1.0**. Derived world data in `public/world.json` is a Produced Work of that database and carries the same attribution requirement — keep the credit visible in any build you distribute.

Code: MIT.
