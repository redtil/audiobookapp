// Turns a book from the library into audio, on GitHub's machines.
//
//   node server/prepare.mjs plan   decide which chapters still need audio and
//                                  split them into groups, one per machine
//   node server/prepare.mjs work   make the audio for one group of chapters
//   node server/prepare.mjs mix    mix the book's music into one group of
//                                  chapters (after the voice and music are made)
//   node server/prepare.mjs clean  after a failed run: remove what it left
//                                  half-made (NARRATION=failure: everything)
//
// Environment: LIBRARY_KEY (access token), DATA_REPO (owner/name of the
// private library), BOOK (book id), VOICE, and for "work" CHAPTERS ("3,7,9")
// and PART (a name for this machine's share of the work).
//
// Audio goes to branches audio/<id>/<part> (see library.mjs): <chapter>.mp3
// and <chapter>.json (sentence start times).

import { loadVoice, trimSilence, encodeMp3, toInt16, SAMPLE_RATE } from "./voice.mjs";
import { planParts } from "../src/plan.js";
import { readBook, audioFiles, audioBranches, deleteBranch, readBlob, ownBranch, output, updateLibraryEntry } from "./library.mjs";
import { mixChapter, LEVELS, levelFile, MIX_VERSION } from "./mix.mjs";

const { BOOK, VOICE = "af_heart" } = process.env;
const MUSIC = process.env.MUSIC === "yes";
const KBPS = 64; // narration and mixes: clear speech, even with music under it
const MIX_MARK = `mix-v${MIX_VERSION}.json`; // saved with each mix, to tell old mixes from new
const PAUSE = { sentence: 0.28, paragraph: 0.65, chapter: 1.5 };
const CHARS_PER_PART = +process.env.CHARS_PER_PART || undefined;

// Chapters that already have narration (or, with mixed = true, every music
// level mixed in), from every machine's branch.
function chaptersWith(files, mixed = false) {
  const done = new Set();
  for (const name of Object.keys(files)) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    const base = name.slice(0, -5);
    if (!mixed || Object.keys(LEVELS).every((l) => files[levelFile(base, l)])) done.add(+m[1]);
  }
  return done;
}

const chapterChars = (c) => c.paras.reduce((n, p) => n + p.reduce((m, s) => m + s.length, 0), 0);

async function plan() {
  const book = await readBook();
  // Mixes made the old way are dropped, so they're made again the new way.
  if (MUSIC) {
    for (const b of await audioBranches()) {
      if (b.files.some((f) => /\.mix(-\w+)?\.mp3$/.test(f)) && !b.files.includes(MIX_MARK)) {
        console.log("replacing an older music mix");
        await deleteBranch(b.ref);
      }
    }
  }
  const files = await audioFiles();
  const sizes = book.chapters.map(chapterChars);
  const all = book.chapters.map((_, ch) => ch);
  const voiced = chaptersWith(files);
  const todo = all.filter((ch) => !voiced.has(ch));
  const parts = (todo.length ? planParts(sizes, todo, CHARS_PER_PART) : [])
    .map((p, k) => ({ part: k, chapters: p.chapters.sort((a, b) => a - b).join(",") }));
  console.log(`${book.chapters.length} chapters, ${voiced.size} done, ${todo.length} to make on ${parts.length} machines`);
  output("parts", JSON.stringify(parts));
  output("count", parts.length);
  // Mixing is quick; saving three levels as MP3 is most of the work, so share it over up to 8 machines.
  const mixed = chaptersWith(files, true);
  const toMix = MUSIC ? all.filter((ch) => !mixed.has(ch)) : [];
  const mixParts = (toMix.length ? planParts(sizes, toMix, Math.ceil(sizes.reduce((a, b) => a + b, 0) / 8)) : [])
    .map((p, k) => ({ part: k, chapters: p.chapters.sort((a, b) => a - b).join(",") }));
  output("mixparts", JSON.stringify(mixParts));
}

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
  const pcm = new Int16Array(pos);
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.length;
  }
  return { mp3: encodeMp3([pcm], KBPS), pcm, timing: { starts, duration: +(pos / SAMPLE_RATE).toFixed(3), voice: VOICE }, failures };
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

// Mixes the book's music into chapters that have narration, following the
// mood segments read from the book (see music.mjs and mix.mjs).
async function mix() {
  const chapters = process.env.CHAPTERS.split(",").filter(Boolean).map(Number);
  const files = await audioFiles();
  if (!files["moods.json"]) return console.log("no moods yet, nothing to mix");
  const { chapters: moods } = JSON.parse(await readBlob(files["moods.json"]));
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const clips = {};
  const clipsFor = async (mood) => {
    if (!clips[mood]) {
      clips[mood] = [];
      for (const f of Object.keys(files).filter((f) => f.startsWith(`music-${mood}-`) && f.endsWith(".pcm")).sort()) {
        const b = await readBlob(files[f]);
        clips[mood].push(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
      }
    }
    return clips[mood];
  };
  const branch = ownBranch(process.env.PART);
  let failed = 0;
  for (const ch of chapters) {
    try {
      await mixOne(ch);
    } catch (err) {
      // Carry on with the other chapters; the job still reports the failure.
      failed++;
      console.error(`chapter ${ch}: ${err.message}`);
    }
  }
  if (failed) {
    console.error(`${failed} chapter(s) couldn't be mixed`);
    process.exitCode = 1;
  }

  async function mixOne(ch) {
    const name = String(ch).padStart(4, "0");
    if (!files[`${name}.mp3`] || !files[`${name}.json`] || !moods?.[ch]) {
      console.log(`chapter ${ch}: no narration yet, skipped`);
      return;
    }
    const levels = Object.keys(LEVELS).filter((l) => !files[levelFile(name, l)]);
    if (!levels.length) return;
    const started = performance.now();
    const timing = JSON.parse(await readBlob(files[`${name}.json`]));
    const decoded = decoder.decode(new Uint8Array(await readBlob(files[`${name}.mp3`])));
    decoder.reset();
    // Drop the MP3 encoder's start-up delay so the timings still line up.
    const want = Math.round(timing.duration * SAMPLE_RATE);
    const samples = decoded.channelData[0].subarray(Math.max(0, decoded.samplesDecoded - want));
    const segments = moods[ch];
    const songs = {};
    for (const m of new Set(segments.map((s) => s.mood))) songs[m] = await clipsFor(m);
    if (Object.values(songs).some((v) => !v.length)) {
      console.log(`chapter ${ch}: its music isn't composed, skipped`);
      return;
    }
    const mixed = mixChapter(toInt16(samples), timing.starts, segments, songs, SAMPLE_RATE, levels);
    const out = Object.fromEntries(levels.map((l) => [levelFile(name, l), encodeMp3([mixed[l]], KBPS)]));
    out[MIX_MARK] = JSON.stringify({ version: MIX_VERSION });
    await branch.save(out, `Chapter ${ch} with music (${levels.join(", ")})`);
    console.log(`chapter ${ch}: ${segments.length} music segment(s), ${levels.join("/")} mixed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
}

// A failed run leaves nothing half-made behind. If the narration failed, the
// book's audio is removed completely and it goes back to "not prepared"; if
// only the music failed, the music is removed and the narration kept, so the
// book still plays (and music can be added again from the player).
async function clean() {
  const narrationFailed = process.env.NARRATION === "failure";
  const music = /^(moods|music-.+|mix-.+)$/;
  const branches = await audioBranches();
  const doomed = branches.filter((b) => narrationFailed || music.test(b.ref.split("/").pop()));
  console.log(`${narrationFailed ? "narration" : "music"} failed: removing ${doomed.length} of ${branches.length} audio parts`);
  for (const b of doomed) await deleteBranch(b.ref);
  if (narrationFailed) {
    await updateLibraryEntry({ voice: null, ready: false, startedAt: 0, eta: null, failedAt: Date.now(), audioAt: Date.now() });
  }
}

const mode = process.argv[2];
if (mode === "plan") await plan();
else if (mode === "work") await work();
else if (mode === "mix") await mix();
else if (mode === "clean") await clean();
else if (mode) throw new Error(`Unknown mode ${mode}`);
