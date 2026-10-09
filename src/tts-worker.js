import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load() {
  const webgpu = await hasWebGPU();
  const device = webgpu ? "webgpu" : "wasm";
  const dtype = webgpu ? "fp32" : "q8";
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status === "progress" && p.file?.endsWith(".onnx")) {
        self.postMessage({ type: "progress", loaded: p.loaded, total: p.total });
      }
    },
  });
  self.postMessage({ type: "ready", device, voices: Object.keys(tts.voices) });
}

// Generation requests are processed one at a time, in order.
let queue = Promise.resolve();
const cancelled = new Set();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    load().catch((err) => self.postMessage({ type: "error", message: String(err?.message || err) }));
    return;
  }
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === "generate") {
    queue = queue.then(async () => {
      if (cancelled.delete(msg.id)) return;
      try {
        const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
        const samples = audio.audio;
        self.postMessage(
          { type: "audio", id: msg.id, samples, rate: audio.sampling_rate },
          [samples.buffer],
        );
      } catch (err) {
        self.postMessage({ type: "audio", id: msg.id, error: String(err?.message || err) });
      }
    });
  }
};
