// Ambient background music, composed live in the browser with the Web Audio
// API: no recordings, so nothing to download or license. Each mood has its
// own key, mode, chords, pace and instruments (warm pads, a soft piano,
// a low drone, and for some moods bells, a heartbeat pulse or drums).
// Changing mood crossfades into the new music.

const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

// root: MIDI note of the key. chords: scale degrees (0 = I). seconds: per chord.
// wave/bright: pad tone. notes: chance per second of a piano note.
export const MOODS = {
  calm:       { label: "Calm",       root: 50, mode: "lydian",   chords: [0, 3, 4, 0],    seconds: 9,  wave: "triangle", bright: 1300, notes: 0.35, drone: 0.5 },
  reflective: { label: "Reflective", root: 53, mode: "ionian",   chords: [0, 5, 3, 4],    seconds: 10, wave: "triangle", bright: 950,  notes: 0.25, drone: 0.4 },
  sad:        { label: "Melancholy", root: 57, mode: "aeolian",  chords: [0, 5, 2, 6],    seconds: 10, wave: "triangle", bright: 800,  notes: 0.3,  drone: 0.5 },
  joyful:     { label: "Uplifting",  root: 55, mode: "ionian",   chords: [0, 4, 5, 3],    seconds: 6,  wave: "sawtooth", bright: 2200, notes: 0.7,  drone: 0.3 },
  romantic:   { label: "Tender",     root: 51, mode: "ionian",   chords: [0, 5, 1, 4],    seconds: 8,  wave: "triangle", bright: 1500, notes: 0.45, drone: 0.3, sevenths: true },
  mysterious: { label: "Mysterious", root: 52, mode: "dorian",   chords: [0, 6, 3, 0],    seconds: 11, wave: "sawtooth", bright: 650,  notes: 0.15, drone: 0.6, bells: true },
  tense:      { label: "Suspense",   root: 49, mode: "phrygian", chords: [0, 1, 0, 6],    seconds: 7,  wave: "sawtooth", bright: 550,  notes: 0.1,  drone: 0.8, pulse: 1.1 },
  dark:       { label: "Dark",       root: 48, mode: "phrygian", chords: [0, 5, 1, 0],    seconds: 12, wave: "sawtooth", bright: 380,  notes: 0.05, drone: 1,   pulse: 0.6, wind: true },
  epic:       { label: "Epic",       root: 50, mode: "aeolian",  chords: [0, 5, 2, 6],    seconds: 6,  wave: "sawtooth", bright: 2400, notes: 0.2,  drone: 0.7, drums: true },
};

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function scaleNote(mood, degree, octave = 0) {
  const steps = MODES[mood.mode];
  const d = ((degree % 7) + 7) % 7;
  return mood.root + steps[d] + 12 * (octave + Math.floor(degree / 7));
}

function chordNotes(mood, degree) {
  const n = [0, 2, 4].concat(mood.sevenths ? [6] : []).map((k) => scaleNote(mood, degree + k));
  return n;
}

export class MusicEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.5;
    this.mood = null;
    this.layer = null; // the mood currently sounding: { gain, timer, mood }
    this.playing = false;
  }

  // Must first be called from a tap (browsers only allow sound after one).
  ensure(given) {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!given && !Ctx) return;
    const ctx = (this.ctx = given || new Ctx());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.reverb.connect(wet).connect(this.master);
    this.noise = this.noiseBuffer();
  }

  impulse(seconds) {
    const { ctx } = this;
    const len = Math.round(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    return buf;
  }

  noiseBuffer() {
    const { ctx } = this;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Render one mood to an AudioBuffer without playing it (for samples/tests).
  static async render(moodName, seconds, sampleRate = 44100) {
    const ctx = new OfflineAudioContext(2, Math.round(seconds * sampleRate), sampleRate);
    const engine = new MusicEngine();
    engine.ensure(ctx);
    engine.playing = true;
    engine.master.gain.value = engine.level();
    const layer = engine.startLayer(MOODS[moodName]);
    clearInterval(layer.timer);
    engine.schedule(layer, seconds);
    return ctx.startRendering();
  }

  // Overall loudness: kept well under the voice. v is 0..1.
  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.playing) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.3);
  }

  level() {
    return 0.5 * this.volume ** 1.5;
  }

  play(moodName) {
    this.ensure();
    if (!this.ctx) return;
    this.ctx.resume();
    this.playing = true;
    this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 1.2);
    this.setMood(moodName);
  }

  pause() {
    if (!this.ctx || !this.playing) return;
    this.playing = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
    const ctx = this.ctx;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => !this.playing && ctx.suspend(), 4000);
  }

  // Crossfade into another mood's music.
  setMood(moodName) {
    const mood = MOODS[moodName] || MOODS.reflective;
    if (!this.ctx || this.mood === moodName) return;
    this.mood = moodName;
    const old = this.layer;
    if (old) {
      clearInterval(old.timer);
      old.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 2.5);
      setTimeout(() => {
        old.sources.forEach((s) => s.stop());
        old.gain.disconnect();
      }, 15000);
    }
    this.layer = this.startLayer(mood);
  }

  stop() {
    this.pause();
    if (this.layer) {
      clearInterval(this.layer.timer);
      this.layer.sources.forEach((s) => s.stop());
    }
    this.layer = null;
    this.mood = null;
  }

  startLayer(mood) {
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, ctx.currentTime, 2.5);
    gain.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    gain.connect(send).connect(this.reverb);

    const layer = { gain, mood, step: 0, next: ctx.currentTime + 0.1, beat: ctx.currentTime + 0.5, sources: [] };
    if (mood.wind) this.wind(layer);
    // Schedule a little ahead of time, in small steps.
    layer.timer = setInterval(() => this.schedule(layer), 250);
    this.schedule(layer);
    return layer;
  }

  schedule(layer, until) {
    const { ctx } = this;
    const { mood } = layer;
    const ahead = until ?? ctx.currentTime + 1.5;
    while (layer.next < ahead) {
      const t = layer.next;
      const degree = mood.chords[layer.step % mood.chords.length];
      const len = mood.seconds;
      this.pad(layer, chordNotes(mood, degree), t, len);
      this.droneNote(layer, scaleNote(mood, degree, -2), t, len);
      if (mood.drums && layer.step % 2 === 0) this.drum(layer, t);
      if (mood.bells && layer.step % 2 === 1) this.bell(layer, scaleNote(mood, degree + 4, 2), t + len * 0.4);
      // Piano notes scattered over the chord, from its notes and the scale.
      const count = Math.round(mood.notes * len * (0.6 + Math.random() * 0.8));
      for (let k = 0; k < count; k++) {
        const pick = Math.random() < 0.6 ? chordNotes(mood, degree)[Math.floor(Math.random() * 3)] + 12
          : scaleNote(mood, Math.floor(Math.random() * 7), 1);
        this.piano(layer, pick, t + Math.random() * (len - 1));
      }
      layer.step++;
      layer.next += len;
    }
    if (mood.pulse) {
      while (layer.beat < ahead) {
        this.heartbeat(layer, layer.beat, mood);
        layer.beat += 60 / (50 * mood.pulse) + 0.4;
      }
    }
  }

  pad(layer, notes, t, len) {
    const { ctx } = this;
    const { mood } = layer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(mood.bright * 0.6, t);
    filter.frequency.linearRampToValueAtTime(mood.bright, t + len * 0.5);
    filter.frequency.linearRampToValueAtTime(mood.bright * 0.7, t + len + 3);
    filter.Q.value = 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.11, t + Math.min(3, len * 0.35));
    env.gain.setValueAtTime(0.11, t + len - 0.5);
    env.gain.linearRampToValueAtTime(0, t + len + 3);
    filter.connect(env).connect(layer.gain);
    for (const n of notes) {
      for (const detune of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = mood.wave;
        o.frequency.value = hz(n);
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = mood.wave === "sawtooth" ? 0.18 : 0.3;
        o.connect(g).connect(filter);
        o.start(t);
        o.stop(t + len + 3.2);
      }
    }
  }

  droneNote(layer, note, t, len) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = hz(note);
    const g = ctx.createGain();
    const v = 0.12 * layer.mood.drone;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 2);
    g.gain.setValueAtTime(v, t + len - 0.5);
    g.gain.linearRampToValueAtTime(0, t + len + 2);
    o.connect(g).connect(layer.gain);
    o.start(t);
    o.stop(t + len + 2.2);
  }

  // A soft, felt-piano-like note: a few sine partials with a quick attack.
  piano(layer, note, t) {
    const { ctx } = this;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.07, t + 0.01);
    out.gain.exponentialRampToValueAtTime(0.0008, t + 4.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    out.connect(lp).connect(layer.gain);
    [1, 2, 3].forEach((partial, k) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = hz(note) * partial;
      const g = ctx.createGain();
      g.gain.value = [1, 0.35, 0.12][k];
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 4.6);
    });
  }

  bell(layer, note, t) {
    const { ctx } = this;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.05, t);
    out.gain.exponentialRampToValueAtTime(0.0005, t + 6);
    out.connect(layer.gain);
    [1, 2.76, 5.4].forEach((ratio, k) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz(note) * ratio;
      const g = ctx.createGain();
      g.gain.value = [1, 0.4, 0.15][k];
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 6.1);
    });
  }

  // Two soft low thumps, like a slow heartbeat.
  heartbeat(layer, t, mood) {
    for (const [dt, v] of [[0, 0.22], [0.28, 0.14]]) {
      const { ctx } = this;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(v * mood.drone, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dt + 0.4);
      o.connect(g).connect(layer.gain);
      o.start(t + dt);
      o.stop(t + dt + 0.45);
    }
  }

  // A distant, low cinematic drum hit.
  drum(layer, t) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 1.4);
    o.connect(g).connect(layer.gain);
    o.start(t);
    o.stop(t + 1.5);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "lowpass";
    bp.frequency.value = 300;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
    n.connect(bp).connect(ng).connect(layer.gain);
    n.start(t, Math.random() * 3);
    n.stop(t + 0.6);
  }

  // Slowly moving filtered noise, like wind.
  wind(layer) {
    const { ctx } = this;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 1.2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const depth = ctx.createGain();
    depth.gain.value = 300;
    lfo.connect(depth).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.05;
    n.connect(bp).connect(g).connect(layer.gain);
    n.start();
    lfo.start();
    layer.sources.push(n, lfo);
  }
}
