// Checks the server-side music pieces on GitHub's machines: the emotion model
// that reads a book's mood, and the MusicGen model that composes music.
import os from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { pipeline, AutoTokenizer, MusicgenForConditionalGeneration, RawAudio } from "@huggingface/transformers";

console.log(`cpus: ${os.cpus().length} × ${os.cpus()[0].model}`);
mkdirSync("music-test", { recursive: true });

let t = performance.now();
const classify = await pipeline("text-classification", "Cohee/distilbert-base-uncased-go-emotions-onnx", { dtype: "q8" });
console.log(`emotion model loaded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
const sentences = [
  "She held the letter against her chest and wept for the brother she would never see again.",
  "Footsteps echoed behind him in the dark alley, and he began to run.",
  "The children laughed and danced in the warm afternoon sun.",
  "The theory of evolution explains how species change over long periods of time.",
  "Nobody knew what lay behind the locked door at the end of the corridor.",
];
t = performance.now();
for (let k = 0; k < 20; k++) await classify(sentences, { top_k: 3 });
const results = await classify(sentences, { top_k: 3 });
console.log(`emotion: ${((performance.now() - t) / 21 / sentences.length * 1000).toFixed(1)} ms per sentence`);
results.forEach((r, i) => console.log(`  ${i}: ${r.map((x) => `${x.label} ${x.score.toFixed(2)}`).join(", ")}`));

for (const dtype of ["q8", "fp32"]) {
  t = performance.now();
  const id = "Xenova/musicgen-small";
  const tokenizer = await AutoTokenizer.from_pretrained(id);
  const model = await MusicgenForConditionalGeneration.from_pretrained(id, {
    dtype: { text_encoder: dtype, decoder_model_merged: dtype, encodec_decode: "fp32" },
  });
  console.log(`[${dtype}] musicgen loaded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const prompt = "calm ambient piano and soft strings, slow, gentle, warm, background music for reading";
  for (const tokens of [250, 750]) {
    t = performance.now();
    const inputs = tokenizer(prompt);
    const audio = await model.generate({ ...inputs, max_new_tokens: tokens, do_sample: true, guidance_scale: 3 });
    const secs = (performance.now() - t) / 1000;
    const rate = model.config.audio_encoder.sampling_rate;
    const length = audio.data.length / rate;
    console.log(`[${dtype}] ${length.toFixed(1)} s of music in ${secs.toFixed(1)} s (${(secs / length).toFixed(1)} s per second of music)`);
    writeFileSync(`music-test/${dtype}-${tokens}.wav`, Buffer.from(new RawAudio(audio.data, rate).toWav()));
  }
}
