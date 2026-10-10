// Two voices behind one interface:
//  - KokoroEngine: the natural-sounding open-source model, run in a worker.
//  - DeviceEngine: the browser's built-in voices, used as a fallback.
// Each exposes speak(text, key) -> Promise that resolves when the chunk
// finishes playing, plus prefetch(text, key), stop(), setRate(rate).

function toWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export class KokoroEngine {
  constructor({ gpu = false, onProgress, onReady, onError, onStatus }) {
    this.worker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.cache = new Map(); // key -> Promise<blobUrl>
    this.keyIds = new Map(); // key -> worker request id
    this.voice = "af_heart";
    this.rate = 1;
    this.ready = false;
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.nextId = 1;
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.loaded, m.total);
      else if (m.type === "ready") {
        this.ready = true;
        this.device = m.device;
        this.voices = m.voices;
        onReady?.(m);
      } else if (m.type === "error") onError?.(m.message);
      else if (m.type === "audio") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(URL.createObjectURL(toWav(m.samples, m.rate)));
      }
    };
    this.worker.postMessage({ type: "load", gpu });
  }

  destroy() {
    this.stop();
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("cancelled"));
    this.pending.clear();
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.audio.src = URL.createObjectURL(toWav(new Float32Array(2400), 24000));
    this.audio.play().catch(() => {
      this.unlocked = false;
    });
  }

  setVoice(voice) {
    if (voice === this.voice) return;
    this.voice = voice;
    this.clearCache();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  clearCache() {
    this.trim(new Set());
  }

  // Drop cached audio that isn't in the set of keys we still need.
  trim(keepKeys) {
    for (const [k, p] of this.cache) {
      if (!keepKeys.has(k)) {
        p.then((url) => URL.revokeObjectURL(url), () => {});
        this.cache.delete(k);
        const id = this.keyIds.get(k);
        this.keyIds.delete(k);
        if (this.pending.has(id)) {
          // Not generated yet: tell the worker to skip it.
          this.worker.postMessage({ type: "cancel", id });
          this.pending.get(id).reject(new Error("cancelled"));
          this.pending.delete(id);
        }
      }
    }
  }

  fetch(text, key) {
    const fullKey = `${this.voice}|${key}`;
    if (!this.cache.has(fullKey)) {
      const id = this.nextId++;
      const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
      this.worker.postMessage({ type: "generate", id, text, voice: this.voice, speed: 1 });
      promise.catch(() => {});
      this.cache.set(fullKey, promise);
      this.keyIds.set(fullKey, id);
    }
    return this.cache.get(fullKey);
  }

  prefetch(text, key) {
    this.fetch(text, key).catch(() => {});
  }

  async speak(text, key, isCurrent) {
    const url = await this.fetch(text, key);
    if (!isCurrent()) return;
    this.audio.src = url;
    this.audio.playbackRate = this.rate;
    await new Promise((resolve, reject) => {
      this.audio.onended = resolve;
      this.audio.onerror = () => reject(new Error("Audio playback failed"));
      this._abort = resolve;
      this.audio.play().catch(reject);
    });
  }

  stop() {
    this.audio.pause();
    this._abort?.();
  }

  keyFull(key) {
    return `${this.voice}|${key}`;
  }
}

export class DeviceEngine {
  constructor() {
    this.rate = 1;
    this.voiceName = null;
  }

  static available() {
    return "speechSynthesis" in window;
  }

  voices() {
    return speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en"));
  }

  setRate(rate) {
    this.rate = rate;
  }

  setVoice(name) {
    this.voiceName = name;
  }

  prefetch() {}

  trim() {}

  speak(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.rate;
      const v = speechSynthesis.getVoices().find((x) => x.name === this.voiceName);
      if (v) u.voice = v;
      u.onend = resolve;
      u.onerror = resolve;
      this._abort = resolve;
      speechSynthesis.speak(u);
    });
  }

  stop() {
    speechSynthesis.cancel();
    this._abort?.();
  }

  keyFull(key) {
    return key;
  }
}
