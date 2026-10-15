// A book's background music, made on GitHub's machines.
//
//   node server/music.mjs moods     read the book and save each chapter's mood
//                                   (moods.json); outputs the moods that still
//                                   need music
//   node server/music.mjs compose   compose the music for one mood (MOOD)
//
// Music is composed by MusicGen (Meta; weights CC BY-NC 4.0, fine for
// personal listening) from a description of the mood, made to loop
// seamlessly, and saved as music-<mood>.mp3 on the book's audio branches.

import { Mp3Encoder } from "@breezystack/lamejs";
import { readBook, audioFiles, readBlob, ownBranch, output } from "./library.mjs";
import { bookMoods, EMOTION_MODEL } from "./moods.mjs";

const SECONDS = +process.env.MUSIC_SECONDS || 30;

// What to ask the composer for, per mood. "no vocals" and a steady feel keep
// it under the voice; "seamless loop" helps it loop.
export const PROMPTS = {
  calm: "peaceful ambient music, soft piano and warm string pads, slow and gentle, no drums, no vocals, background music for reading",
  reflective: "thoughtful minimal ambient piano, slow, warm and contemplative, soft pads, no drums, no vocals, background music",
  sad: "melancholic slow piano and cello, sad and tender, quiet ambient, no drums, no vocals",
  joyful: "uplifting light acoustic music, warm piano and strings, hopeful and bright, gentle tempo, no vocals",
  romantic: "tender romantic music, soft piano and violin, warm and intimate, slow, no drums, no vocals",
  mysterious: "mysterious ambient soundscape, soft synth pads and celesta, slow, dreamy and curious, no drums, no vocals",
  tense: "suspenseful cinematic underscore, low strings, slow steady pulse, tense and quiet, no melody, no vocals",
  dark: "dark ambient drone, deep low strings and distant rumble, ominous and slow, quiet, no vocals",
  epic: "epic cinematic orchestral music, strings, horns and soft drums, heroic and building, instrumental, no vocals",
};

async function moods() {
  const book = await readBook();
  const files = await audioFiles();
  let list;
  if (files["moods.json"]) {
    list = JSON.parse(await readBlob(files["moods.json"])).moods;
    console.log("moods already read");
  } else {
    let classify;
    if (process.env.MOCK_VOICE) {
      // Tests: chapters alternate between sad and calm.
      let n = 0;
      classify = async (s) => s.map(() => [{ label: n++ % 2 ? "relief" : "sadness", score: 0.9 }]);
    } else {
      const { pipeline } = await import("@huggingface/transformers");
      const classifier = await pipeline("text-classification", EMOTION_MODEL, { dtype: "q8" });
      classify = (sentences) => classifier(sentences, { top_k: null }).then((r) => (Array.isArray(r[0]) ? r : [r]));
    }
    const started = performance.now();
    list = await bookMoods(book, classify);
    console.log(`read ${book.chapters.length} chapters in ${((performance.now() - started) / 1000).toFixed(0)} s`);
    await ownBranch("moods").save({ "moods.json": JSON.stringify({ moods: list }) }, "Moods");
  }
  const counts = {};
  for (const m of list) counts[m] = (counts[m] || 0) + 1;
  console.log("moods:", JSON.stringify(counts));
  const todo = Object.keys(counts).filter((m) => !files[`music-${m}.mp3`]);
  output("compose", JSON.stringify(todo));
}

// Make the end flow into the start: crossfade the last few seconds over the
// first few, so the clip loops without a seam.
export function makeLoop(samples, rate, fadeSeconds = 3) {
  const fade = Math.min(Math.floor(rate * fadeSeconds), Math.floor(samples.length / 3));
  const out = samples.slice(fade); // starts where the fade-in left off
  const tail = out.length - fade;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    // Equal-power crossfade.
    out[tail + i] = samples[samples.length - fade + i] * Math.cos((t * Math.PI) / 2) + samples[i] * Math.sin((t * Math.PI) / 2);
  }
  return out;
}

// Same loudness for every mood (about -22 dB RMS), with a gentle limiter.
export function normalise(samples, target = 0.08) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  const gain = target / Math.max(1e-6, Math.sqrt(sum / samples.length));
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.tanh(samples[i] * gain) * 32767;
  return out;
}

function toMp3(pcm, rate) {
  const enc = new Mp3Encoder(1, rate, 64);
  const chunks = [];
  for (let i = 0; i < pcm.length; i += 1152 * 16) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152 * 16));
    if (b.length) chunks.push(Buffer.from(b));
  }
  chunks.push(Buffer.from(enc.flush()));
  return Buffer.concat(chunks);
}

async function compose() {
  const mood = process.env.MOOD;
  if (!PROMPTS[mood]) throw new Error(`Unknown mood ${mood}`);
  let samples;
  let rate;
  const started = performance.now();
  if (process.env.MOCK_VOICE) {
    rate = 32000;
    samples = Float32Array.from({ length: rate * SECONDS }, (_, i) => 0.1 * Math.sin((i / rate) * 2 * Math.PI * 196));
  } else {
    const { AutoTokenizer, MusicgenForConditionalGeneration } = await import("@huggingface/transformers");
    const id = "Xenova/musicgen-small";
    const tokenizer = await AutoTokenizer.from_pretrained(id);
    const dtype = process.env.MUSICGEN_DTYPE || "q8";
    const model = await MusicgenForConditionalGeneration.from_pretrained(id, {
      dtype: { text_encoder: dtype, decoder_model_merged: dtype, encodec_decode: "fp32" },
    });
    const audio = await model.generate({
      ...tokenizer(PROMPTS[mood]),
      max_new_tokens: Math.min(1500, Math.round(SECONDS * 50)), // 50 tokens per second of music
      do_sample: true,
      guidance_scale: 3,
    });
    rate = model.config.audio_encoder.sampling_rate;
    samples = audio.data;
  }
  const mp3 = toMp3(normalise(makeLoop(samples, rate)), rate);
  console.log(`${mood}: ${(samples.length / rate).toFixed(0)} s of music in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  await ownBranch(`music-${mood}`).save({ [`music-${mood}.mp3`]: mp3 }, `Music: ${mood}`);
}

const mode = process.argv[2];
if (mode === "moods") await moods();
else if (mode === "compose") await compose();
else if (mode) throw new Error(`Unknown mode ${mode}`);
