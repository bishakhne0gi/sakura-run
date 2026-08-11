# Sakura Run — HSR Layout

A cel-shaded first-person walking simulator of **HSR Layout, Bengaluru**, built from real OpenStreetMap geometry. Walk it, cycle it, or take an auto through tabebuia season.

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
| Buildings | 2,223 real footprints (26 with surveyed heights) |
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
| `T` | time of day |
| `M` | ambience |
| `C` | coordinates |
| `Esc` | release cursor |

The three traversal modes are different vehicles, not speed multipliers. What separates them is how they *refuse* to turn: a body on foot changes heading instantly and free-strafes; a cycle leans and carries momentum; an auto understeers, needs speed before the steering bites, and rolls into corners. Tuning only top speed makes all three feel identical.

## How it is built

```
pipeline/build-world.mjs    OSM JSON  ->  public/world.json  (plain metres, engine-agnostic)
src/world/build.js          world.json -> merged + instanced Three.js geometry
src/world/collision.js      circle-vs-edge over a 20 m spatial hash
src/player/controller.js    the three vehicles
src/render/                 cel shading, gradient sky + day cycle, blossom field
src/audio/ambience.js       procedural — no audio files ship
```

Refresh the map data:

```bash
curl -s -X POST --data-urlencode "data@pipeline/query.overpassql" \
  https://overpass-api.de/api/interpreter -o data/hsr-raw.json
npm run world
```

`world.json` is deliberately plain JSON in local metres — if this ever moves to Unity, the pipeline does not.

### Performance

37 draw calls and ~830k triangles for the whole 2 km² city, 100 fps on an M-series laptop. 2,223 buildings merge into batched buffers; 7,264 trees are six `InstancedMesh` draws; DPR capped at 2; the sun's shadow camera follows the player rather than covering the map.

### The blossom field

Petals use the tumble-drives-slip mechanism: each petal tumbles on its own axis so it presents a face, thins to an edge, and opens out again, and its sideways slip is driven by *that same angle*, ninety degrees out of phase. Drive the slip from an independent sine and the eye reads a wobble or an easing bug instead of a petal caught by the air. The quad is scaled by `sin(tumble)` so it genuinely thins to a line at the crossing rather than fading out.

## Accessibility and lifecycle

- `prefers-reduced-motion: reduce` freezes the petal field on a composed still frame rather than removing it, and cuts the field density.
- `dt` is clamped to 1/30 s, so a backgrounded tab does not teleport the player on return.
- The intro veil is a real `<button>` with a visible focus ring.
- Audio only starts on an explicit `M` press, as browsers require.

## Known limits

- No interiors — buildings are solid extrusions.
- No traffic or pedestrians yet.
- Terrain is flat; HSR's real gradients are not modelled.
- Roof detail is a single terrace slab, not the water tanks and clotheslines the real skyline has.

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed under the **Open Database License (ODbL) 1.0**. Derived world data in `public/world.json` is a Produced Work of that database and carries the same attribution requirement — keep the credit visible in any build you distribute.

Code: MIT.
