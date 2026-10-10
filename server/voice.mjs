// Kokoro on the server (Node, CPU) and MP3 encoding.
import { Mp3Encoder } from "@breezystack/lamejs";

export const SAMPLE_RATE = 24000;
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export async function loadVoice({ dtype = process.env.KOKORO_DTYPE || "fp32", mock = !!process.env.MOCK_VOICE } = {}) {
  if (mock) {
    // Test tone as long as the sentence would take to say.
    return async (text) => {
      const n = Math.round(SAMPLE_RATE * Math.max(0.3, text.length / 15));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220);
      return out;
    };
  }
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device: "cpu" });
  return async (text, voice) => (await tts.generate(text, { voice })).audio;
}

// Cut the near-silent start and end the model leaves around a sentence,
// so the pauses between sentences are even.
export function trimSilence(samples, threshold = 0.004) {
  const pad = Math.round(SAMPLE_RATE * 0.03);
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad + 1));
}

// Constant bitrate, so seeking to a sentence's start time is exact.
export function encodeMp3(chunks, kbps = 48) {
  const enc = new Mp3Encoder(1, SAMPLE_RATE, kbps);
  const out = [];
  const block = 1152 * 16;
  for (const pcm of chunks) {
    for (let i = 0; i < pcm.length; i += block) {
      const buf = enc.encodeBuffer(pcm.subarray(i, i + block));
      if (buf.length) out.push(Buffer.from(buf));
    }
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}

export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
