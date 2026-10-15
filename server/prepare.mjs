// Turns a book from the library into audio, on GitHub's machines.
//
//   node server/prepare.mjs plan   decide which chapters still need audio and
//                                  split them into groups, one per machine
//   node server/prepare.mjs work   make the audio for one group of chapters
//
// Environment: LIBRARY_KEY (access token), DATA_REPO (owner/name of the
// private library), BOOK (book id), VOICE, and for "work" CHAPTERS ("3,7,9")
// and PART (a name for this machine's share of the work).
//
// Audio goes to branches audio/<id>/<part> (see library.mjs): <chapter>.mp3
// and <chapter>.json (sentence start times).

import { loadVoice, trimSilence, encodeMp3, toInt16, SAMPLE_RATE } from "./voice.mjs";
import { planParts } from "../src/plan.js";
import { readBook, audioFiles, ownBranch, output } from "./library.mjs";

const { BOOK, VOICE = "af_heart" } = process.env;
const PAUSE = { sentence: 0.28, paragraph: 0.65, chapter: 1.5 };
const CHARS_PER_PART = +process.env.CHARS_PER_PART || undefined;

// Chapters that already have audio, from every machine's branch.
async function finishedChapters() {
  const done = new Set();
  for (const name of Object.keys(await audioFiles())) {
    const m = name.match(/^(\d+)\.json$/);
    if (m) done.add(+m[1]);
  }
  return done;
}

const chapterChars = (c) => c.paras.reduce((n, p) => n + p.reduce((m, s) => m + s.length, 0), 0);

async function plan() {
  const book = await readBook();
  const done = await finishedChapters();
  const todo = book.chapters.map((_, ch) => ch).filter((ch) => !done.has(ch));
  const sizes = book.chapters.map(chapterChars);
  const parts = (todo.length ? planParts(sizes, todo, CHARS_PER_PART) : [])
    .map((p, k) => ({ part: k, chapters: p.chapters.sort((a, b) => a - b).join(",") }));
  console.log(`${book.chapters.length} chapters, ${done.size} done, ${todo.length} to make on ${parts.length} machines`);
  output("parts", JSON.stringify(parts));
  output("count", parts.length);
}

// ---------- work ----------

async function makeChapter(speak, chapter, ch) {
  const flat = chapter.paras.flat();
  const endsParagraph = chapter.paras.flatMap((para) => para.map((_, k) => k === para.length - 1));
  const starts = [];
  const chunks = [];
  let pos = 0;
  let failures = 0;
  for (let i = 0; i < flat.length; i++) {
    let samples;
    try {
      samples = trimSilence(await speak(flat[i], VOICE));
    } catch (err) {
      // One odd sentence shouldn't stop the book: leave a short silence.
      failures++;
      console.warn(`chapter ${ch} sentence ${i}: ${err.message}`);
      samples = new Float32Array(Math.round(SAMPLE_RATE * 0.3));
    }
    const pause = Math.round(SAMPLE_RATE *
      (i === flat.length - 1 ? PAUSE.chapter : endsParagraph[i] ? PAUSE.paragraph : PAUSE.sentence));
    if (i && i % 100 === 0) console.log(`chapter ${ch}: ${i} of ${flat.length} sentences`);
    starts.push(+(pos / SAMPLE_RATE).toFixed(3));
    chunks.push(toInt16(samples), new Int16Array(pause));
    pos += samples.length + pause;
  }
  return { mp3: encodeMp3(chunks), timing: { starts, duration: +(pos / SAMPLE_RATE).toFixed(3), voice: VOICE }, failures };
}

async function work() {
  const chapters = process.env.CHAPTERS.split(",").filter(Boolean).map(Number);
  const book = await readBook();
  const speak = await loadVoice();
  const branch = ownBranch(process.env.PART);
  for (const ch of chapters) {
    const started = performance.now();
    const { mp3, timing, failures } = await makeChapter(speak, book.chapters[ch], ch);
    const name = String(ch).padStart(4, "0");
    // Each chapter is saved as soon as it's done, so pausing loses little.
    await branch.save({ [`${name}.mp3`]: mp3, [`${name}.json`]: JSON.stringify(timing) }, `Chapter ${ch}`);
    const took = (performance.now() - started) / 1000;
    console.log(`chapter ${ch}: ${(timing.duration / 60).toFixed(1)} min of audio in ${(took / 60).toFixed(1)} min` +
      ` (${(timing.duration / took).toFixed(1)}× real time)${failures ? `, ${failures} sentences skipped` : ""}`);
  }
}

const mode = process.argv[2];
if (mode === "plan") await plan();
else if (mode === "work") await work();
else if (mode) throw new Error(`Unknown mode ${mode}`);
