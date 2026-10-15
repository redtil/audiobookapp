// Mixes background music into a chapter's narration, following the mood of
// what's being read.
//
// The book's mood segments say where the mood changes (by sentence); the
// sentence start times turn that into time. Each segment loops its mood's
// composed music (alternating between versions so it doesn't repeat
// exactly), crossfading into the next mood. The music sits under the voice:
// it dips while the narrator speaks and comes back up in the pauses, and it's
// a little louder in intense passages and softer in quiet ones.

const FADE = 3; // seconds of crossfade between moods
// Music level while speaking, relative to the voice. Each level is its own
// file, so the listener can choose and it still plays on a locked phone.
export const LEVELS = {
  faint: 0.063, // about -24 dB
  soft: 0.11, // about -19 dB
  medium: 0.2, // about -14 dB
  strong: 0.36, // about -9 dB
  full: 0.56, // about -5 dB
};
// medium is saved as 0007.mix.mp3, the others as 0007.mix-soft.mp3 etc.
export const levelFile = (name, level) => (level === "medium" ? `${name}.mix.mp3` : `${name}.mix-${level}.mp3`);
const DUCK = 0.45; // how far the music dips while the narrator speaks (about -7 dB)
const ATTACK = 0.08; // seconds for the music to dip when speech starts
const RELEASE = 0.4; // and to come back up in a pause

function rms(samples) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += 4) {
    sum += samples[i] * samples[i];
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

// voice: Int16Array; starts: seconds per sentence; segments: [{ at, mood,
// intensity }]; clips: { mood: [Int16Array, ...] } at the same rate.
// Returns { level: Int16Array } for each level asked for.
export function mixChapter(voice, starts, segments, clips, rate, levels = ["medium"]) {
  const n = voice.length;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = voice[i] / 32768;

  const clipLevel = rms(Object.values(clips).flat()[0] || new Int16Array(1)) / 32768 || 0.08;
  const voiceLevel = rms(v) || 0.1;
  const base = voiceLevel / (clipLevel * DUCK); // scaled by each level below

  // The music bed, segment by segment, each fading into the next.
  const bed = new Float32Array(n);
  const fade = Math.round(FADE * rate);
  segments.forEach((seg, k) => {
    const versions = clips[seg.mood];
    if (!versions?.length) return;
    const t0 = k === 0 ? 0 : Math.round((starts[seg.at] ?? 0) * rate);
    const t1 = k + 1 < segments.length ? Math.round((starts[segments[k + 1].at] ?? n / rate) * rate) : n;
    const from = Math.max(0, t0 - (k === 0 ? 0 : fade / 2));
    const to = Math.min(n, t1 + (k + 1 < segments.length ? fade / 2 : 0));
    const gain = base * (seg.intensity || 1);
    let offset = Math.floor(Math.random() * versions[0].length);
    for (let i = from; i < to; i++) {
      const p = i - from + offset;
      const clip = versions[Math.floor(p / versions[0].length) % versions.length];
      const sample = clip[p % clip.length] / 32768;
      // Equal-power fades at both ends (a gentle 2 s start for the chapter).
      const inLen = k === 0 ? Math.round(2 * rate) : fade;
      const fin = Math.min(1, (i - from) / inLen);
      const fout = k + 1 < segments.length ? Math.min(1, (to - i) / fade) : Math.min(1, (to - i) / Math.round(1.5 * rate));
      bed[i] += sample * gain * Math.sin((fin * Math.PI) / 2) * Math.sin((fout * Math.PI) / 2);
    }
  });

  // Duck under the voice, following its loudness in 10 ms steps.
  const block = Math.round(rate / 100);
  const threshold = voiceLevel * 0.25;
  const up = 1 - Math.exp(-1 / (ATTACK * 100));
  const down = 1 - Math.exp(-1 / (RELEASE * 100));
  let level = 1;
  for (let b = 0; b * block < n; b++) {
    const s = b * block;
    const e = Math.min(n, s + block);
    let sum = 0;
    for (let i = s; i < e; i++) sum += v[i] * v[i];
    const speaking = Math.sqrt(sum / (e - s)) > threshold;
    const target = speaking ? DUCK : 1;
    const startLevel = level;
    level += (target - level) * (target < level ? up : down);
    for (let i = s; i < e; i++) bed[i] *= startLevel + ((level - startLevel) * (i - s)) / (e - s);
  }

  const out = {};
  for (const name of levels) {
    const under = LEVELS[name];
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const x = v[i] + bed[i] * under;
      pcm[i] = Math.round((Math.abs(x) > 0.9 ? Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) * 10)) : x) * 32767);
    }
    out[name] = pcm;
  }
  return out;
}

// Linear resampling, plenty for a soft music bed.
export function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    out[i] = samples[j] + ((samples[j + 1] ?? samples[j]) - samples[j]) * (x - j);
  }
  return out;
}
