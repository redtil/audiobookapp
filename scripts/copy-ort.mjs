// Copies the ONNX runtime files the voice worker loads into public/ort,
// so the site serves them itself (see src/tts-worker.js).
import { copyFileSync, mkdirSync } from "node:fs";

const src = "node_modules/onnxruntime-web/dist";
mkdirSync("public/ort", { recursive: true });
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  copyFileSync(`${src}/${f}`, `public/ort/${f}`);
}
