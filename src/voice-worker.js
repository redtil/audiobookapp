import { KokoroTTS, env } from "kokoro-js";
import { encodeMuLaw, trimSilence, SAMPLE_RATE } from "./audio.js";

// The ONNX runtime is served from this site (scripts/copy-ort.mjs) so it
// works under cross-origin isolation and can use several CPU cores.
env.wasmPaths = new URL(/* @vite-ignore */ "../ort/", import.meta.url).href;

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

// The model files ship with this site (scripts/fetch-model.mjs). Requests
// the library makes to Hugging Face are served from here first, and only
// go out to Hugging Face for a file the site doesn't have.
const REMOTE = `https://huggingface.co/${MODEL}/resolve/main/`;
const LOCAL = new URL(/* @vite-ignore */ "../model/", import.meta.url).href;
const netFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url?.startsWith(REMOTE)) {
    try {
      const res = await netFetch(LOCAL + url.slice(REMOTE.length), init);
      if (res.ok && !res.headers.get("content-type")?.includes("text/html")) return res;
    } catch {}
  }
  return netFetch(input, init);
};
let tts = null;
let device = "wasm";
let mock = false;

async function gpuAvailable() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function loadOn(dev) {
  const model = await KokoroTTS.from_pretrained(MODEL, {
    dtype: dev === "webgpu" ? "fp32" : "q8",
    device: dev,
    progress_callback: (p) => {
      if (p.status === "progress" && p.file?.endsWith(".onnx")) {
        self.postMessage({ type: "progress", loaded: p.loaded, total: p.total });
      }
    },
  });
  await model.generate("Ready.", { voice: "af_heart" }); // fail here, not mid-book
  tts = model;
  device = dev;
}

async function load({ gpu, mock: m }) {
  mock = m;
  if (mock) return;
  if (gpu && (await gpuAvailable())) {
    try {
      await loadOn("webgpu");
      return;
    } catch (err) {
      console.warn("Graphics card voice failed, using the CPU", err);
      self.postMessage({ type: "note", text: "The graphics card didn't work here, so the CPU is used instead." });
    }
  }
  await loadOn("wasm");
}

// Stand-in voice for testing without the model download: a soft tone as
// long as the sentence would take to say.
function fakeSpeech(text) {
  const n = Math.round(SAMPLE_RATE * Math.max(0.3, text.length / 15));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220);
  return out;
}

async function speak(text, voice) {
  if (mock) {
    await new Promise((r) => setTimeout(r, 40));
    return fakeSpeech(text);
  }
  try {
    return (await tts.generate(text, { voice })).audio;
  } catch (err) {
    if (device !== "webgpu") throw err;
    console.warn("Graphics card failed mid-way, switching to the CPU", err);
    await loadOn("wasm");
    return (await tts.generate(text, { voice })).audio;
  }
}

const queue = [];
let busy = false;

async function work() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const samples = await speak(job.text, job.voice);
      const data = encodeMuLaw(trimSilence(samples));
      self.postMessage({ type: "clip", id: job.id, data, seconds: data.length / SAMPLE_RATE }, [data.buffer]);
    } catch (err) {
      self.postMessage({ type: "clip", id: job.id, error: String(err?.message || err) });
    }
  }
  busy = false;
}

let ready = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "load") {
    ready = load(m).then(
      () => self.postMessage({ type: "ready", device: mock ? "test" : device }),
      (err) => self.postMessage({ type: "failed", message: String(err?.message || err) }),
    );
  } else if (m.type === "speak") {
    queue.push(m);
    await ready;
    work();
  } else if (m.type === "clear") {
    queue.length = 0;
  }
};
