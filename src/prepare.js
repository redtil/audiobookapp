import * as db from "./db.js";
import { SAMPLE_RATE } from "./audio.js";

// The voice model, running in a worker so the page stays responsive.
export class Voice {
  constructor({ gpu = false, mock = false, onProgress, onNote } = {}) {
    this.worker = new Worker(new URL("./voice-worker.js", import.meta.url), { type: "module" });
    this.jobs = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === "progress") onProgress?.(m.loaded, m.total);
        else if (m.type === "note") onNote?.(m.text);
        else if (m.type === "ready") resolve(m.device);
        else if (m.type === "failed") reject(new Error(m.message));
        else if (m.type === "clip") {
          const job = this.jobs.get(m.id);
          this.jobs.delete(m.id);
          if (!job) return;
          if (m.error) job.reject(new Error(m.error));
          else job.resolve({ data: m.data, seconds: m.seconds });
        }
      };
    });
    this.ready.catch(() => {});
    this.worker.postMessage({ type: "load", gpu, mock });
  }

  speak(text, voice) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => this.jobs.set(id, { resolve, reject }));
    this.worker.postMessage({ type: "speak", id, text, voice });
    return p;
  }

  // Drop everything queued; promises still waiting reject with "cancelled".
  clear() {
    this.worker.postMessage({ type: "clear" });
    for (const job of this.jobs.values()) job.reject(new Error("cancelled"));
    this.jobs.clear();
  }

  destroy() {
    this.clear();
    this.worker.terminate();
  }
}

export function sentencesOf(book) {
  const out = [];
  book.chapters.forEach((c, ch) => {
    let i = 0;
    for (const para of c.paras) for (const text of para) out.push({ ch, i: i++, text });
  });
  return out;
}

// Speak every sentence of the book that hasn't been made yet and save it.
// Safe to stop at any point (signal) and run again later: it picks up where
// it left off. onProgress({ done, total, secondsLeft }) after each sentence.
export async function prepareBook(book, voice, { signal, onProgress }) {
  const all = sentencesOf(book);
  const have = await db.clipKeys(book.id);
  const todo = all.filter((s) => !have.has(`${s.ch}:${s.i}`));
  let done = all.length - todo.length;
  let failures = 0;

  const started = performance.now();
  const charsTodo = todo.reduce((n, s) => n + s.text.length, 0);
  let charsDone = 0;

  let next = 0;
  const inFlight = [];
  // Two sentences queued at once, so the worker never waits on the page.
  const send = () => {
    const s = todo[next++];
    inFlight.push(voice.speak(s.text, book.voice).then((r) => ({ s, r }), (err) => ({ s, err })));
  };

  onProgress?.({ done, total: all.length, secondsLeft: null });
  while ((next < todo.length || inFlight.length) && !signal.aborted) {
    while (inFlight.length < 2 && next < todo.length) send();
    const { s, r, err } = await inFlight.shift();
    if (signal.aborted) break;
    let data = r?.data;
    if (err) {
      // One odd sentence shouldn't stop the book: leave a short silence.
      console.warn("Couldn't voice:", s.text, err);
      failures++;
      data = new Uint8Array(Math.round(SAMPLE_RATE * 0.3)).fill(0xff);
    }
    await db.putClip(book.id, s.ch, s.i, data);
    done++;
    charsDone += s.text.length;
    const elapsed = (performance.now() - started) / 1000;
    const secondsLeft = charsDone > 200 ? ((charsTodo - charsDone) * elapsed) / charsDone : null;
    onProgress?.({ done, total: all.length, secondsLeft });
  }
  if (signal.aborted) voice.clear();
  return { complete: done === all.length, failures };
}

// ---------- audiobook files ----------
// One file holding the book text and all its audio, so a book prepared on
// one device can be opened on another without preparing it again.
// Layout: "KRAB1\n", uint32 header length, header JSON, then every clip
// in reading order.

const MAGIC = "KRAB1\n";

export async function exportBook(book) {
  const sizes = [];
  const parts = [];
  for (let ch = 0; ch < book.chapters.length; ch++) {
    const clips = await db.chapterClips(book.id, ch);
    sizes.push(clips.map((c) => c.length));
    parts.push(new Blob(clips));
  }
  const { id, title, voice, chapters, seconds } = book;
  const header = new TextEncoder().encode(JSON.stringify({ book: { id, title, voice, chapters, seconds }, sizes }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  return new Blob([MAGIC, len, header, ...parts], { type: "application/octet-stream" });
}

export async function isAudiobookFile(file) {
  const head = await file.slice(0, MAGIC.length).text();
  return head === MAGIC;
}

export async function importBook(file, onProgress) {
  const view = new DataView(await file.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer());
  const headerLen = view.getUint32(0, true);
  let pos = MAGIC.length + 4;
  const { book, sizes } = JSON.parse(await file.slice(pos, pos + headerLen).text());
  pos += headerLen;

  if (book.chapters.length !== sizes.length) throw new Error("This audiobook file is damaged.");
  await db.deleteClips(book.id);
  for (let ch = 0; ch < sizes.length; ch++) {
    const bytes = new Uint8Array(await file.slice(pos, pos + sizes[ch].reduce((a, b) => a + b, 0)).arrayBuffer());
    let off = 0;
    const clips = sizes[ch].map((n) => {
      const c = bytes.slice(off, off + n);
      off += n;
      return c;
    });
    if (off !== bytes.length) throw new Error("This audiobook file is incomplete.");
    await db.putClips(book.id, ch, clips);
    pos += off;
    onProgress?.((ch + 1) / sizes.length);
  }
  const rec = { ...book, addedAt: Date.now(), openedAt: Date.now(), ready: true };
  await db.putBook(rec);
  return rec;
}
