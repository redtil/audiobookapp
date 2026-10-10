import { KokoroTTS, env } from "kokoro-js";

// Serve the ONNX runtime from this site instead of a CDN: it keeps working
// with cross-origin isolation on, which lets it use several CPU cores.
env.wasmPaths = new URL("../ort/", import.meta.url).href;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let device = null;

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function progress(p) {
  if (p.status === "progress" && p.file?.endsWith(".onnx")) {
    self.postMessage({ type: "progress", loaded: p.loaded, total: p.total });
  }
}

async function loadOn(dev) {
  const model = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: dev === "webgpu" ? "fp32" : "q8",
    device: dev,
    progress_callback: progress,
  });
  // Make sure the model actually runs here before we rely on it.
  await model.generate("Hi.", { voice: "af_heart" });
  tts = model;
  device = dev;
}

// The graphics card is faster but can freeze the whole browser on some
// devices, so it is opt-in. The WebAssembly path runs on the CPU in this
// worker and never blocks the page.
async function load(useGpu) {
  let gpuError = null;
  if (useGpu && (await hasWebGPU())) {
    try {
      await loadOn("webgpu");
    } catch (err) {
      gpuError = err;
      console.warn("WebGPU voice failed, falling back to WebAssembly", err);
      self.postMessage({ type: "status", text: "Setting up the natural voice in compatibility mode…" });
    }
  }
  if (!tts) {
    try {
      await loadOn("wasm");
    } catch (err) {
      throw gpuError ? new Error(`${gpuError.message || gpuError}; ${err.message || err}`) : err;
    }
  }
  self.postMessage({ type: "ready", device, voices: Object.keys(tts.voices) });
  pump();
}

// Pending requests, keyed by id. The page tells us which matter most
// (the sentence about to be read first), and drops ones it no longer needs.
const jobs = new Map(); // id -> { msg, priority }
let pumping = false;

async function generate(msg) {
  try {
    return await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
  } catch (err) {
    if (device !== "webgpu") throw err;
    console.warn("WebGPU generation failed, switching to WebAssembly", err);
    tts = null;
    await loadOn("wasm");
    return tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.size) {
      // Let queued messages (cancels, new priorities) arrive before choosing.
      await new Promise((r) => setTimeout(r, 0));
      let best = null;
      for (const [id, job] of jobs) {
        if (!best || job.priority < best.job.priority) best = { id, job };
      }
      if (!best) break;
      jobs.delete(best.id);
      const { msg } = best.job;
      try {
        const audio = await generate(msg);
        const samples = audio.audio;
        self.postMessage(
          { type: "audio", id: msg.id, samples, rate: audio.sampling_rate },
          [samples.buffer],
        );
      } catch (err) {
        self.postMessage({ type: "audio", id: msg.id, error: String(err?.message || err) });
      }
    }
  } finally {
    pumping = false;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    load(!!msg.gpu).catch((err) => self.postMessage({ type: "error", message: String(err?.message || err) }));
  } else if (msg.type === "cancel") {
    jobs.delete(msg.id);
  } else if (msg.type === "order") {
    msg.ids.forEach((id, i) => {
      const job = jobs.get(id);
      if (job) job.priority = i;
    });
  } else if (msg.type === "generate") {
    jobs.set(msg.id, { msg, priority: Number.MAX_SAFE_INTEGER - jobs.size });
    if (tts) pump();
  }
};
