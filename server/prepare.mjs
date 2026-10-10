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
// Library layout (private repository):
//   main: library.json, books/<id>.json (the text, split into sentences)
//   branches audio/<id>/<part>: <chapter>.mp3 and <chapter>.json (sentence
//   start times), one branch per machine so they never get in each other's way.
//
// This runs in a public repository, so it never logs a book's title or text.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVoice, trimSilence, encodeMp3, toInt16, SAMPLE_RATE } from "./voice.mjs";
import { planParts } from "../src/plan.js";

const { LIBRARY_KEY, DATA_REPO, BOOK, VOICE = "af_heart" } = process.env;
const API = process.env.GITHUB_API || "https://api.github.com";
const PAUSE = { sentence: 0.28, paragraph: 0.65, chapter: 1.5 };
const CHARS_PER_PART = +process.env.CHARS_PER_PART || undefined;

async function api(path, { raw = false, ...opts } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${LIBRARY_KEY}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return raw ? res : res.json();
}

async function readBook() {
  const res = await api(`/repos/${DATA_REPO}/contents/books/${BOOK}.json`, { raw: true });
  if (!res) throw new Error("This book isn't in the library.");
  return res.json();
}

// Chapters that already have audio, from every machine's branch.
async function finishedChapters() {
  const refs = (await api(`/repos/${DATA_REPO}/git/matching-refs/heads/audio/${BOOK}/`)) || [];
  const done = new Set();
  for (const ref of refs) {
    const tree = await api(`/repos/${DATA_REPO}/git/trees/${ref.object.sha}`);
    for (const f of tree?.tree || []) {
      const m = f.path.match(/^(\d+)\.json$/);
      if (m) done.add(+m[1]);
    }
  }
  return done;
}

const chapterChars = (c) => c.paras.reduce((n, p) => n + p.reduce((m, s) => m + s.length, 0), 0);

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

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

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  return { mp3: encodeMp3(chunks), timing: { starts, duration: +(pos / SAMPLE_RATE).toFixed(3), voice: VOICE }, failures };
}

async function work() {
  const chapters = process.env.CHAPTERS.split(",").filter(Boolean).map(Number);
  const branch = `audio/${BOOK}/${process.env.PART}`;
  const book = await readBook();
  const speak = await loadVoice();

  const dir = mkdtempSync(join(tmpdir(), "audio-"));
  git(dir, "init", "-q", "-b", "audio");
  git(dir, "config", "user.name", "Kokoro Reader");
  git(dir, "config", "user.email", "reader@users.noreply.github.com");
  const remote = process.env.DATA_REMOTE || `https://x-access-token:${LIBRARY_KEY}@github.com/${DATA_REPO}.git`;
  git(dir, "remote", "add", "origin", remote);

  for (const ch of chapters) {
    const started = performance.now();
    const { mp3, timing, failures } = await makeChapter(speak, book.chapters[ch], ch);
    const name = String(ch).padStart(4, "0");
    writeFileSync(join(dir, `${name}.mp3`), mp3);
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(timing));
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `Chapter ${ch}`);
    // Each chapter is saved as soon as it's done, so pausing loses little.
    for (let attempt = 1; ; attempt++) {
      try {
        git(dir, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    const took = (performance.now() - started) / 1000;
    console.log(`chapter ${ch}: ${(timing.duration / 60).toFixed(1)} min of audio in ${(took / 60).toFixed(1)} min` +
      ` (${(timing.duration / took).toFixed(1)}× real time)${failures ? `, ${failures} sentences skipped` : ""}`);
  }
}

const mode = process.argv[2];
if (mode === "plan") await plan();
else if (mode === "work") await work();
else if (mode) throw new Error(`Unknown mode ${mode}`);
