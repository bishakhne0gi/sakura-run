// The score.
//
// Two sources, in priority order. If public/music/index.json exists, that is a
// real recorded soundtrack and it plays. If it does not — a clean checkout, or
// a build that chose not to ship 25 MB of audio — the synthesised score below
// runs instead, and the game is never silent.
//
// Both feed the same master gain, so `J` toggles whichever is playing and the
// fade behaviour is identical either way.
//
// ---------------------------------------------------------------------------
//
// Fallback: ambient score, synthesised in the browser.
//
// Written rather than sourced. The obvious reference tracks for this mood are
// copyrighted works and shipping one is not something this project can do, so
// this is an original piece in that register: slow, warm, unhurried, and built
// to sit under a city rather than on top of it.
//
// It is generative, not a loop. A fixed loop announces itself the third time it
// comes round, which is exactly when a player has settled in and stopped
// noticing the city; a piece that never repeats the same bar twice stays
// underneath awareness for as long as you leave it running.
//
// The construction is deliberately simple:
//   * a slow chord progression on soft detuned pads
//   * a melody that picks notes from the current chord's pentatonic scale,
//     with rests as often as notes — the silence is what makes it calm
//   * a long feedback delay standing in for room reverb
//   * a gentle low-pass that opens and closes over minutes, so the timbre
//     drifts without ever drawing attention
//
// Everything is scheduled ahead of the audio clock rather than fired from
// setInterval, because timer jitter on a busy frame is audible as a stumble in
// the rhythm.

// A major-pentatonic world with a couple of borrowed chords. Frequencies are in
// semitones from A2, resolved to Hz at play time.
const CHORDS = [
  { root: 0, tones: [0, 4, 7, 11] },    // Amaj7
  { root: 5, tones: [0, 4, 7, 11] },    // Dmaj7
  { root: 9, tones: [0, 3, 7, 10] },    // F#m7
  { root: 2, tones: [0, 3, 7, 10] },    // Bm7
  { root: 7, tones: [0, 4, 7, 9] },     // E6
  { root: 5, tones: [0, 4, 7, 11] },    // Dmaj7
];

// Major pentatonic degrees, in semitones.
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16];

const A2 = 110;
const hz = (semitones) => A2 * 2 ** (semitones / 12);

export class Music {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.started = false;
    this.chordIndex = 0;
    this.nextChordAt = 0;
    this.nextNoteAt = 0;
    this.timer = null;
    this.playlist = null;
    this.trackIndex = 0;
    this.element = null;
    this.source = null;
    this.title = null;
  }

  // Look for a shipped soundtrack. Called once, before start(): the result
  // decides which of the two engines start() spins up.
  async load(base = "music/") {
    try {
      const response = await fetch(`${base}index.json`);
      if (!response.ok) return null;
      const index = await response.json();
      if (!index?.tracks?.length) return null;
      this.playlist = index.tracks.map((t) => ({ ...t, url: `${base}${t.file}` }));
      this.attribution = index.attribution ?? null;
      // Shuffled once at load, then played in order, so two sessions do not
      // open on the same track but one session never repeats until it has been
      // through the set.
      for (let i = this.playlist.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
      }
      return this.playlist.length;
    } catch {
      return null;
    }
  }

  // Must be called from a user gesture — browsers refuse to start an
  // AudioContext otherwise, and a silently-suspended context looks exactly like
  // a bug in the music code.
  start() {
    if (this.started) {
      this.ctx?.resume?.();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    // Created inside a gesture the context starts running; created outside one
    // it starts suspended and stays that way, which is silence with no error.
    this.ctx.resume?.();
    this.started = true;
    this.enabled = true;

    const now = this.ctx.currentTime;

    // Master chain: everything meets here, so one gain fades the whole score.
    this.master = this.ctx.createGain();
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.linearRampToValueAtTime(this.level(), now + 6);

    // Slow filter drift. Two minutes per sweep, so it is never a "wobble".
    this.tone = this.ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 1400;
    this.tone.Q.value = 0.4;

    this.lfo = this.ctx.createOscillator();
    this.lfo.frequency.value = 1 / 120;
    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.value = 550;
    this.lfo.connect(this.lfoGain).connect(this.tone.frequency);
    this.lfo.start();

    // Delay as reverb. Cheaper than a convolver and, at these times, warmer.
    this.delay = this.ctx.createDelay(4);
    this.delay.delayTime.value = 0.66;
    this.feedback = this.ctx.createGain();
    this.feedback.gain.value = 0.42;
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0.34;
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.wet).connect(this.master);

    this.tone.connect(this.master);
    this.master.connect(this.ctx.destination);

    if (this.playlist) {
      // Recorded soundtrack. Streamed through an <audio> element rather than
      // decoded into an AudioBuffer: these are three-minute tracks and
      // decodeAudioData would hold every one of them in memory uncompressed,
      // which for 25 MB of MP3 is several hundred megabytes of Float32.
      this.element = new Audio();
      this.element.crossOrigin = "anonymous";
      this.element.preload = "auto";
      this.element.addEventListener("ended", () => this.advance());
      // A failed track must not end the music. Skip to the next one.
      this.element.addEventListener("error", () => this.advance());
      this.source = this.ctx.createMediaElementSource(this.element);
      // Straight to master, bypassing the pad chain's filter and delay — those
      // exist to make oscillators sound like a room, and a recorded track
      // already is one.
      this.source.connect(this.master);
      this.cue(0);
      return;
    }

    this.nextChordAt = now + 0.4;
    this.nextNoteAt = now + 1.2;
    // Scheduling window: look a couple of seconds ahead, top up four times a
    // second. Well inside what the audio thread needs and far enough ahead that
    // a long frame cannot starve it.
    this.timer = setInterval(() => this.schedule(), 250);
    this.schedule();
  }

  // One soft voice. Long attack and long release — nothing in this piece should
  // ever have an edge on it.
  voice(freq, at, duration, level, type = "sine", detune = 0) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;

    const gain = this.ctx.createGain();
    const attack = Math.min(duration * 0.4, 1.6);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(gain);
    gain.connect(this.tone);
    gain.connect(this.delay);
    osc.start(at);
    osc.stop(at + duration + 0.1);
  }

  schedule() {
    if (!this.ctx || !this.enabled) return;
    const horizon = this.ctx.currentTime + 2.5;

    while (this.nextChordAt < horizon) {
      const chord = CHORDS[this.chordIndex % CHORDS.length];
      this.chordIndex += 1;
      const at = this.nextChordAt;
      const length = 8;

      // Pad: each chord tone twice, slightly detuned against itself. The beating
      // between the pair is what stops it sounding like a synth preset.
      chord.tones.forEach((tone, i) => {
        const f = hz(chord.root + tone);
        this.voice(f, at, length, 0.05 / (i + 1.6), "sine", -6);
        this.voice(f, at + 0.05, length, 0.04 / (i + 1.6), "triangle", 7);
      });
      // Root an octave down, for weight.
      this.voice(hz(chord.root - 12), at, length + 1, 0.06, "sine");

      this.nextChordAt += length * 0.82;   // chords overlap and bleed
    }

    while (this.nextNoteAt < horizon) {
      const chord = CHORDS[Math.max(0, this.chordIndex - 1) % CHORDS.length];
      // Rest about a third of the time. The gaps are the point.
      if (Math.random() > 0.34) {
        const degree = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
        const octave = Math.random() < 0.3 ? 24 : 12;
        this.voice(hz(chord.root + degree + octave), this.nextNoteAt,
          1.6 + Math.random() * 2.2, 0.05, "sine");
      }
      this.nextNoteAt += 1.1 + Math.random() * 2.4;
    }
  }

  cue(index) {
    if (!this.playlist?.length || !this.element) return;
    this.trackIndex = ((index % this.playlist.length) + this.playlist.length) % this.playlist.length;
    const track = this.playlist[this.trackIndex];
    this.title = track.title ?? null;
    this.element.src = track.url;
    // play() rejects when the page has no user activation yet. That is not an
    // error to surface, but it must not be the end of it either: without the
    // retry below, a single blocked play() means the soundtrack never starts
    // and nothing anywhere says why.
    this.element.play?.().catch(() => this.armRetry());
  }

  // Try again on the next real interaction, once.
  armRetry() {
    if (this.retryArmed) return;
    this.retryArmed = true;
    const retry = () => {
      this.retryArmed = false;
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
      if (!this.enabled) return;
      this.ctx?.resume?.();
      this.element?.play?.().catch(() => {});
    };
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
  }

  advance() {
    if (!this.playlist?.length) return;
    this.cue(this.trackIndex + 1);
  }

  // What is playing, for the HUD.
  nowPlaying() {
    return this.playlist ? this.title : "Ambient score";
  }

  setEnabled(on) {
    if (on && !this.started) { this.start(); return this.enabled; }
    if (!this.ctx) return false;
    this.enabled = on;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(on ? this.level() : 0.0001, now + (on ? 2.5 : 1.2));
    if (on) {
      this.ctx.resume?.();
      this.element?.play?.().catch(() => {});
    } else if (this.element) {
      // Pause after the fade, not through it, or the track cuts off mid-bar.
      setTimeout(() => { if (!this.enabled) this.element?.pause?.(); }, 1300);
    }
    return this.enabled;
  }

  // Recorded tracks arrive mastered near 0 dBFS; the synthesised score is a
  // handful of quiet sine waves. One gain cannot serve both.
  level() {
    return this.playlist ? 0.5 : 0.16;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }
}
