// Procedural ambience — no audio files, so the whole game stays a code artefact.
// A slow pad, a wind bed, birds, and a two-stroke auto engine whose pitch tracks
// speed. Everything is built lazily on the first toggle because browsers refuse
// to start an AudioContext without a user gesture.

export class Ambience {
  constructor() {
    this.context = null;
    this.on = false;
    this.nodes = null;
  }

  toggle() {
    if (!this.context) this.build();
    this.on = !this.on;
    const now = this.context.currentTime;
    this.nodes.master.gain.cancelScheduledValues(now);
    this.nodes.master.gain.setTargetAtTime(this.on ? 0.32 : 0.0001, now, 0.4);
    if (this.on && this.context.state === "suspended") this.context.resume();
    return this.on;
  }

  build() {
    const Context = window.AudioContext || window.webkitAudioContext;
    this.context = new Context();
    const ctx = this.context;

    const master = ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(ctx.destination);

    // --- pad: three detuned sines around a soft A-major-ish cluster
    const pad = ctx.createGain();
    pad.gain.value = 0.16;
    pad.connect(master);
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 900;
    padFilter.connect(pad);

    for (const [freq, detune] of [[220, -4], [277.18, 3], [329.63, -6], [440, 5]]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      // Slow independent swell per voice keeps the pad from pulsing in lockstep.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.18;
      lfo.connect(lfoGain).connect(gain.gain);
      osc.connect(gain).connect(padFilter);
      osc.start();
      lfo.start();
    }

    // --- wind: filtered noise
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;

    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 480;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.07;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.03;
    windLfo.connect(windLfoGain).connect(windGain.gain);
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();
    windLfo.start();

    // --- engine: sawtooth through a lowpass, silent until you board an auto
    const engine = ctx.createOscillator();
    engine.type = "sawtooth";
    engine.frequency.value = 55;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 320;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0001;
    engine.connect(engineFilter).connect(engineGain).connect(master);
    engine.start();

    // --- birds: occasional short chirps, only in daylight-ish moods
    const birds = ctx.createGain();
    birds.gain.value = 0.09;
    birds.connect(master);
    this.birdTimer = setInterval(() => {
      if (!this.on || ctx.state !== "running") return;
      if (Math.random() > 0.35) return;
      const t = ctx.currentTime;
      const chirp = ctx.createOscillator();
      chirp.type = "triangle";
      const base = 1800 + Math.random() * 1400;
      chirp.frequency.setValueAtTime(base, t);
      chirp.frequency.exponentialRampToValueAtTime(base * 1.5, t + 0.07);
      chirp.frequency.exponentialRampToValueAtTime(base * 0.8, t + 0.16);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      chirp.connect(gain).connect(birds);
      chirp.start(t);
      chirp.stop(t + 0.25);
    }, 1700);

    this.nodes = { master, pad, engine, engineGain, engineFilter, windGain };
  }

  update(speed, mode) {
    if (!this.on || !this.nodes) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const { engine, engineGain, engineFilter, windGain } = this.nodes;

    if (mode === "auto") {
      const revs = 55 + Math.abs(speed) * 9;
      engine.frequency.setTargetAtTime(revs, now, 0.15);
      engineFilter.frequency.setTargetAtTime(280 + Math.abs(speed) * 40, now, 0.2);
      engineGain.gain.setTargetAtTime(0.11, now, 0.25);
    } else {
      engineGain.gain.setTargetAtTime(0.0001, now, 0.3);
    }

    // Wind rises with speed on foot or cycle.
    const target = 0.04 + Math.min(0.12, Math.abs(speed) * 0.012);
    windGain.gain.setTargetAtTime(mode === "auto" ? 0.04 : target, now, 0.3);
  }
}
