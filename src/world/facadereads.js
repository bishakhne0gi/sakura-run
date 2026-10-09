// The architectural reading of the street-level imagery, keyed by building.
//
// Written by pipeline/read-facades.mjs. Absent on a clean checkout, in which
// case every building falls back to what the satellite sample and its own
// footprint say — the city still builds, it just knows less about itself.
export async function loadFacadeReads() {
  let data;
  try {
    const response = await fetch("facades/read.json");
    if (!response.ok) return null;
    data = await response.json();
  } catch {
    return null;
  }
  if (!data?.facades?.length) return null;

  const map = new Map();
  for (const read of data.facades) {
    // One reading per building. Where two walls of the same building were
    // photographed, keep the one the rhythm analysis was most confident about
    // — a confident read of the side elevation beats a guess at the front.
    const score = (read.rhythm?.rows ?? 0) + (read.rhythm?.cols ?? 0) + (read.quality ?? 0) / 200;
    const existing = map.get(read.building);
    if (!existing || score > existing._score) {
      map.set(read.building, {
        ...read,
        wallLen: Math.hypot(read.wall[2] - read.wall[0], read.wall[3] - read.wall[1]),
        _score: score,
      });
    }
  }
  return map;
}
