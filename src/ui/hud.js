// The reference's whole UI is one thin control strip along the bottom edge plus
// a corner mark. Keeping that restraint is most of why it reads as a place
// rather than a game menu.

const CONTROLS = [
  ["W A S D", "move"],
  ["Shift", "run"],
  ["Mouse", "look"],
  ["V", "cycle"],
  ["B", "auto"],
  ["E", "interact"],
  ["P", "third person"],
  ["T", "time"],
  ["M", "music"],
  ["C", "coordinates"],
  ["Esc", "release"],
];

export class Hud {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = `
      <div class="mark">HSR<span>run</span></div>

      <div class="compass" data-compass>
        <div class="needle" data-needle></div>
        <div class="place" data-place>HSR Layout</div>
      </div>

      <div class="readout" data-readout hidden>
        <div><b data-coords>0, 0</b><i>local metres</i></div>
        <div><b data-latlon>—</b><i>lat / lon</i></div>
        <div><b data-speed>0.0</b><i>km/h</i></div>
        <div><b data-fps>60</b><i>fps</i></div>
      </div>

      <div class="toast" data-toast></div>

      <div class="prompt" data-prompt hidden><b>E</b><span data-prompt-label></span></div>

      <div class="strip">
        ${CONTROLS.map(([key, label]) => `<span><b>${key}</b>${label}</span>`).join("")}
        <em data-mode>On foot</em>
      </div>

      <div class="veil" data-veil>
        <div class="veil-inner">
          <h1>Sakura Run <span>HSR Layout</span></h1>
          <p class="sub">Bengaluru · 12.917°N 77.642°E · tabebuia season</p>
          <p class="body">
            Two square kilometres of real HSR Layout, built from OpenStreetMap
            footprints. Agara Lake, the Main and Cross grid, 2,223 buildings.
            Walk it, cycle it, or take an auto.
          </p>
          <button data-start>Click to enter</button>
          <p class="hint">WASD move · Shift run · V cycle · B auto · Esc release cursor</p>
          <p class="credit">Map data © OpenStreetMap contributors, ODbL 1.0</p>
        </div>
      </div>
    `;

    this.el = {
      coords: root.querySelector("[data-coords]"),
      latlon: root.querySelector("[data-latlon]"),
      speed: root.querySelector("[data-speed]"),
      fps: root.querySelector("[data-fps]"),
      readout: root.querySelector("[data-readout]"),
      mode: root.querySelector("[data-mode]"),
      needle: root.querySelector("[data-needle]"),
      place: root.querySelector("[data-place]"),
      toast: root.querySelector("[data-toast]"),
      prompt: root.querySelector("[data-prompt]"),
      promptLabel: root.querySelector("[data-prompt-label]"),
      veil: root.querySelector("[data-veil]"),
      start: root.querySelector("[data-start]"),
    };

    this.toastTimer = 0;
    this.showReadout = false;
  }

  onStart(handler) {
    this.el.start.addEventListener("click", handler);
  }

  hideVeil() {
    this.el.veil.classList.add("gone");
  }

  showVeil() {
    this.el.veil.classList.remove("gone");
  }

  toggleReadout() {
    this.showReadout = !this.showReadout;
    this.el.readout.hidden = !this.showReadout;
  }

  toast(message) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.el.toast.classList.remove("on"), 2200);
  }

  setPrompt(label) {
    if (label) {
      this.el.promptLabel.textContent = label;
      this.el.prompt.hidden = false;
    } else {
      this.el.prompt.hidden = true;
    }
  }

  update({ x, z, lat, lon, speed, fps, mode, heading, nearest }) {
    if (this.showReadout) {
      this.el.coords.textContent = `${x.toFixed(0)}, ${z.toFixed(0)}`;
      this.el.latlon.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      this.el.speed.textContent = (speed * 3.6).toFixed(1);
      this.el.fps.textContent = fps.toFixed(0);
    }
    this.el.mode.textContent = mode;
    this.el.needle.style.transform = `rotate(${-heading}rad)`;
    if (nearest) this.el.place.textContent = nearest;
  }
}
