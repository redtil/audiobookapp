// Downloads the Kokoro voice model into public/model so the site serves it
// itself instead of every visitor fetching it from Hugging Face.
// Runs before each build; files already downloaded are skipped.
// Pass --gpu to also bundle the larger full-precision model used in GPU mode.
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { VOICES } from "../src/voices.js";

const BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
const files = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
  ...(process.argv.includes("--gpu") ? ["onnx/model.onnx"] : []),
  ...VOICES.map((v) => `voices/${v.id}.bin`),
];

let failed = 0;
for (const f of files) {
  const dest = `public/model/${f}`;
  if (existsSync(dest) && statSync(dest).size > 0) continue;
  try {
    const res = await fetch(BASE + f);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`model: downloaded ${f}`);
  } catch (err) {
    failed++;
    console.warn(`model: couldn't download ${f} (${err.message})`);
  }
}
if (failed) {
  console.warn("model: some files are missing; the app will fetch them from Hugging Face instead.");
  if (process.env.CI) process.exit(1);
}
