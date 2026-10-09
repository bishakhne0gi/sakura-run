// Map views, drawn from the same world.json the 3D city is built from — so the
// map cannot drift out of register with the place. Both views share one
// pre-rendered canvas of the whole layout; the minimap samples a rotated crop
// of it and the full map pans and zooms over it. Rendering 2,223 footprints
// once at load costs ~40 ms and nothing per frame.

const SHEET = 2048;

const COLOR = {
  paper: "#efe9df",
  green: "#cfdcc0",
  greenDark: "#bdcfad",
  water: "#a8c8d8",
  building: "#d8cec0",
  buildingEdge: "#c2b6a6",
  arterial: "#ffffff",
  main: "#ffffff",
  street: "#fbfaf7",
  service: "#f2efe9",
  path: "#e3d9cb",
  roadEdge: "#ccc3b6",
  ink: "#3a3340",
  player: "#e8749b",
};

const ROAD_ORDER = ["path", "service", "street", "main", "arterial"];

export class CityMap {
  constructor(world) {
    this.world = world;
    const [minX, minZ, maxX, maxZ] = world.bounds;
    this.min = [minX, minZ];
    this.span = Math.max(maxX - minX, maxZ - minZ);
    this.scale = SHEET / this.span;              // pixels per metre on the sheet

    this.sheet = document.createElement("canvas");
    this.sheet.width = SHEET;
    this.sheet.height = SHEET;
    this.draw();
  }

  // Sheet coordinates. World +z is south, and the sheet is drawn north-up, so
  // z maps straight down the canvas.
  px(x) { return (x - this.min[0]) * this.scale; }
  pz(z) { return (z - this.min[1]) * this.scale; }

  draw() {
    const ctx = this.sheet.getContext("2d");
    ctx.fillStyle = COLOR.paper;
    ctx.fillRect(0, 0, SHEET, SHEET);

    const ring = (points) => {
      ctx.beginPath();
      ctx.moveTo(this.px(points[0][0]), this.pz(points[0][1]));
      for (let i = 1; i < points.length; i++) ctx.lineTo(this.px(points[i][0]), this.pz(points[i][1]));
      ctx.closePath();
    };

    for (const patch of this.world.green) {
      ctx.fillStyle = patch.area > 4000 ? COLOR.greenDark : COLOR.green;
      ring(patch.points);
      ctx.fill();
    }
    for (const body of this.world.water) {
      ctx.fillStyle = COLOR.water;
      ring(body.points);
      ctx.fill();
    }

    // Roads twice: a casing pass then a fill pass, in class order. That is what
    // makes junctions look joined rather than a pile of overlapping sticks.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const pass of ["casing", "fill"]) {
      for (const kind of ROAD_ORDER) {
        for (const road of this.world.roads) {
          if (road.kind !== kind) continue;
          const w = Math.max(1.1, road.width * this.scale);
          ctx.strokeStyle = pass === "casing" ? COLOR.roadEdge : COLOR[kind];
          ctx.lineWidth = pass === "casing" ? w + 1.6 : w;
          ctx.beginPath();
          ctx.moveTo(this.px(road.points[0][0]), this.pz(road.points[0][1]));
          for (let i = 1; i < road.points.length; i++) {
            ctx.lineTo(this.px(road.points[i][0]), this.pz(road.points[i][1]));
          }
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = COLOR.building;
    ctx.strokeStyle = COLOR.buildingEdge;
    ctx.lineWidth = 0.6;
    for (const building of this.world.buildings) {
      ring(building.points);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ---- minimap: a rotated crop, heading-up, drawn into a small canvas
  drawMinimap(ctx, size, player, heading, metres = 170) {
    const half = size / 2;
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = COLOR.paper;
    ctx.fillRect(0, 0, size, size);

    const zoom = size / (metres * this.scale);
    ctx.translate(half, half);
    ctx.rotate(heading);                       // heading-up
    ctx.scale(zoom, zoom);
    ctx.translate(-this.px(player.x), -this.pz(player.z));
    ctx.drawImage(this.sheet, 0, 0);
    ctx.restore();

    // Player arrow, always pointing up the screen because the map rotates.
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = COLOR.player;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- full map: whole layout with labels, pan and zoom
  drawFull(ctx, width, height, view, player, heading) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#e6ded2";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 + view.panX, height / 2 + view.panY);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(-SHEET / 2, -SHEET / 2);
    ctx.drawImage(this.sheet, 0, 0);

    // Landmarks: drawn inside the map transform so they stay pinned to place,
    // with the text counter-scaled so it stays readable at any zoom.
    for (const landmark of this.world.landmarks) {
      const x = this.px(landmark.p[0]);
      const y = this.pz(landmark.p[1]);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1 / view.zoom, 1 / view.zoom);
      ctx.fillStyle = COLOR.ink;
      ctx.beginPath();
      ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.strokeText(landmark.label, 8, 4);
      ctx.fillText(landmark.label, 8, 4);
      ctx.restore();
    }

    // Named shopfronts appear only when zoomed in far enough to read them —
    // 300 labels at full extent is a smear, not a map.
    if (view.zoom > 2.2) {
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      for (const poi of this.world.pois) {
        if (!poi.name) continue;
        const x = this.px(poi.p[0]);
        const y = this.pz(poi.p[1]);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1 / view.zoom, 1 / view.zoom);
        ctx.fillStyle = "#8a5f3f";
        ctx.fillRect(-1.5, -1.5, 3, 3);
        ctx.fillStyle = "rgba(58,51,64,0.9)";
        ctx.fillText(poi.name, 5, 3.5);
        ctx.restore();
      }
    }

    // Player marker
    const px = this.px(player.x);
    const py = this.pz(player.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(1 / view.zoom, 1 / view.zoom);
    ctx.rotate(-heading);
    ctx.fillStyle = COLOR.player;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // Scale bar: a map without one is a picture.
    const metresPerPixel = 1 / (this.scale * view.zoom);
    const targetPx = 120;
    const rough = targetPx * metresPerPixel;
    const step = [10, 20, 50, 100, 200, 500, 1000].reduce((a, b) => (Math.abs(b - rough) < Math.abs(a - rough) ? b : a));
    const barPx = step / metresPerPixel;
    ctx.fillStyle = "rgba(58,51,64,0.9)";
    ctx.fillRect(24, height - 40, barPx, 3);
    ctx.fillRect(24, height - 46, 2, 9);
    ctx.fillRect(24 + barPx - 2, height - 46, 2, 9);
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`${step} m`, 24 + barPx + 8, height - 34);
  }
}

// The on-screen map overlay: a full-screen canvas with drag-to-pan and
// wheel-to-zoom, plus the persistent minimap in the corner.
export class MapView {
  constructor(root, world) {
    this.city = new CityMap(world);
    this.open = false;
    this.view = { zoom: 1, panX: 0, panY: 0 };

    this.minimapEl = document.createElement("canvas");
    this.minimapEl.className = "minimap";
    this.minimapEl.width = 200;
    this.minimapEl.height = 200;
    root.append(this.minimapEl);
    this.minimapCtx = this.minimapEl.getContext("2d");

    this.overlay = document.createElement("div");
    this.overlay.className = "mapview";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <canvas data-map></canvas>
      <div class="maphead">
        <b>HSR Layout</b>
        <span>drag to pan · scroll to zoom · M to close</span>
      </div>
    `;
    root.append(this.overlay);
    this.canvas = this.overlay.querySelector("[data-map]");
    this.ctx = this.canvas.getContext("2d");

    this.bindPanZoom();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  bindPanZoom() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      this.view.panX += event.clientX - lastX;
      this.view.panY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      this.dirty = true;
    });
    this.canvas.addEventListener("pointerup", () => { dragging = false; });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      // Zoom about the cursor, not the centre: zooming about the centre makes
      // the thing you were looking at run off the screen.
      const rect = this.canvas.getBoundingClientRect();
      const cx = event.clientX - rect.width / 2;
      const cy = event.clientY - rect.height / 2;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = Math.max(0.35, Math.min(9, this.view.zoom * factor));
      const applied = next / this.view.zoom;
      this.view.panX = cx - (cx - this.view.panX) * applied;
      this.view.panY = cy - (cy - this.view.panY) * applied;
      this.view.zoom = next;
      this.dirty = true;
    }, { passive: false });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  // Centre the full map on the player the first time it is opened, so it is
  // never a mystery where you are standing.
  toggle(player) {
    this.open = !this.open;
    this.overlay.hidden = !this.open;
    if (this.open) {
      const c = this.city;
      this.view.zoom = 1.6;
      this.view.panX = -(c.px(player.x) - 1024) * this.view.zoom;
      this.view.panY = -(c.pz(player.z) - 1024) * this.view.zoom;
      this.dirty = true;
    }
    return this.open;
  }

  setMinimapVisible(on) {
    this.minimapEl.hidden = !on;
  }

  update(player, heading, dt) {
    if (this.open) {
      // Redraw on demand plus a slow heartbeat: 2,223 footprints every frame at
      // 4× zoom is a real cost for a static picture.
      this.since = (this.since || 0) + dt;
      if (this.dirty || this.since > 0.2) {
        this.city.drawFull(this.ctx, window.innerWidth, window.innerHeight, this.view, player, heading);
        this.dirty = false;
        this.since = 0;
      }
      return;
    }
    if (this.minimapEl.hidden) return;
    this.city.drawMinimap(this.minimapCtx, 200, player, heading, 190);
  }
}
