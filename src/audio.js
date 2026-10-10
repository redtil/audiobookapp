// Audio is stored as 8-bit mu-law at the model's 24 kHz: half the size of
// 16-bit PCM and still clear for speech (~86 MB per hour of listening).

export const SAMPLE_RATE = 24000;

export function encodeMuLaw(samples) {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i])) * 32635;
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    s += 132;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
    const mant = (s >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | mant) & 0xff;
  }
  return out;
}

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exp = (u >> 4) & 7;
  const s = ((((u & 0x0f) << 3) + 132) << exp) - 132;
  DECODE[i] = u & 0x80 ? -s : s;
}

// Cut the near-silent start and end the model leaves around each sentence,
// so the pauses between sentences can be set evenly when playing.
export function trimSilence(samples, threshold = 0.004) {
  const pad = Math.round(SAMPLE_RATE * 0.03);
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad + 1));
}

// Join sentence clips into one WAV with pauses between them.
// clips: [{ data: Uint8Array (mu-law), pauseAfter: seconds }]
// Returns { blob, starts: seconds at which each clip begins, duration }.
export function buildWav(clips) {
  const pauseSamples = clips.map((c) => Math.round(c.pauseAfter * SAMPLE_RATE));
  let total = 0;
  for (let k = 0; k < clips.length; k++) total += clips[k].data.length + pauseSamples[k];

  const pcm = new Int16Array(total);
  const starts = [];
  let pos = 0;
  for (let k = 0; k < clips.length; k++) {
    starts.push(pos / SAMPLE_RATE);
    const d = clips[k].data;
    for (let i = 0; i < d.length; i++) pcm[pos + i] = DECODE[d[i]];
    pos += d.length + pauseSamples[k];
  }

  const header = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  header.setUint32(4, 36 + total * 2, true);
  str(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  str(36, "data");
  header.setUint32(40, total * 2, true);

  return { blob: new Blob([header, pcm], { type: "audio/wav" }), starts, duration: total / SAMPLE_RATE };
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDuration(sec) {
  if (sec < 90) return "1 min";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
