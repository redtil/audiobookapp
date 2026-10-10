import * as db from "./db.js";
import { buildWav, SAMPLE_RATE } from "./audio.js";

const PAUSE_SENTENCE = 0.28;
const PAUSE_PARAGRAPH = 0.65;
const PAUSE_CHAPTER = 1.5;

// Each chapter plays as one continuous track built from its saved sentence
// clips. One long track keeps playing with the phone locked, which a
// sentence-by-sentence player can't do.
async function buildChapter(book, ch) {
  const clips = await db.chapterClips(book.id, ch);
  const lastOfPara = [];
  for (const para of book.chapters[ch].paras) para.forEach((_, k) => lastOfPara.push(k === para.length - 1));
  if (clips.length !== lastOfPara.length) throw new Error("Part of this chapter's audio is missing. Prepare the book again.");
  const parts = clips.map((data, i) => ({
    data,
    pauseAfter: i === clips.length - 1 ? PAUSE_CHAPTER : lastOfPara[i] ? PAUSE_PARAGRAPH : PAUSE_SENTENCE,
  }));
  const { blob, starts, duration } = buildWav(parts);
  return { ch, url: URL.createObjectURL(blob), starts, duration };
}

export async function bookSeconds(book) {
  let total = 0;
  for (let ch = 0; ch < book.chapters.length; ch++) {
    for (const c of await db.chapterClips(book.id, ch)) total += c.length / SAMPLE_RATE + PAUSE_SENTENCE;
  }
  return total;
}

export class Player {
  constructor(audio, { onSentence, onChapter, onState, onTime, onFinished }) {
    this.audio = audio;
    this.audio.preservesPitch = true;
    this.on = { onSentence, onChapter, onState, onTime, onFinished };
    this.book = null;
    this.track = null;
    this.nextTrack = null;
    this.sentence = -1;
    this.rate = 1;

    audio.addEventListener("timeupdate", () => this.tick());
    audio.addEventListener("seeked", () => this.tick());
    audio.addEventListener("play", () => onState?.(true));
    audio.addEventListener("pause", () => onState?.(false));
    audio.addEventListener("ended", () => this.chapterEnded());
  }

  async open(book, ch, sentence = 0) {
    this.close();
    this.book = book;
    await this.loadChapter(ch, sentence);
  }

  close() {
    this.audio.pause();
    for (const t of [this.track, this.nextTrack]) if (t) URL.revokeObjectURL(t.url);
    this.track = this.nextTrack = null;
    this.book = null;
    this.audio.removeAttribute("src");
  }

  get playing() {
    return !this.audio.paused;
  }

  async loadChapter(ch, sentence = 0, { autoplay = false } = {}) {
    const book = this.book;
    let t = this.nextTrack?.ch === ch ? this.nextTrack : null;
    if (t) this.nextTrack = null;
    else t = await buildChapter(book, ch);
    if (book !== this.book) return URL.revokeObjectURL(t.url);
    if (this.track) URL.revokeObjectURL(this.track.url);
    this.track = t;
    this.sentence = -1;
    this.audio.src = t.url;
    this.audio.playbackRate = this.rate;
    this.on.onChapter?.(ch);
    await new Promise((r) => this.audio.addEventListener("loadedmetadata", r, { once: true }));
    this.audio.currentTime = t.starts[Math.min(sentence, t.starts.length - 1)] ?? 0;
    this.audio.playbackRate = this.rate;
    this.tick();
    if (autoplay) await this.play();
  }

  // Build the next chapter ahead of time, so moving on to it is instant
  // (a locked phone may not give the page time to build it later).
  async prebuildNext() {
    const ch = this.track.ch + 1;
    if (ch >= this.book.chapters.length || this.nextTrack?.ch === ch) return;
    const book = this.book;
    const t = await buildChapter(book, ch).catch(() => null);
    if (!t) return;
    if (book !== this.book || this.track?.ch !== ch - 1) return URL.revokeObjectURL(t.url);
    this.nextTrack = t;
  }

  async play() {
    try {
      await this.audio.play();
      if (!this.nextTrack) this.prebuildNext();
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
  }

  pause() {
    this.audio.pause();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  seek(seconds) {
    if (!this.track) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.track.duration - 0.05));
  }

  skip(seconds) {
    this.seek(this.audio.currentTime + seconds);
  }

  async goToSentence(ch, i) {
    const wasPlaying = this.playing;
    if (ch !== this.track?.ch) return this.loadChapter(ch, i, { autoplay: wasPlaying });
    const starts = this.track.starts;
    if (i < 0) {
      if (ch > 0) return this.loadChapter(ch - 1, Infinity, { autoplay: wasPlaying });
      i = 0;
    }
    if (i >= starts.length) {
      if (ch + 1 < this.book.chapters.length) return this.loadChapter(ch + 1, 0, { autoplay: wasPlaying });
      i = starts.length - 1;
    }
    this.seek(starts[i]);
  }

  chapterEnded() {
    const ch = this.track.ch + 1;
    if (ch < this.book.chapters.length) this.loadChapter(ch, 0, { autoplay: true });
    else {
      this.on.onState?.(false);
      this.on.onFinished?.();
    }
  }

  tick() {
    const t = this.track;
    if (!t) return;
    const now = this.audio.currentTime;
    // Last sentence that started at or before now.
    let lo = 0;
    let hi = t.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.starts[mid] <= now + 0.05) lo = mid;
      else hi = mid - 1;
    }
    if (lo !== this.sentence) {
      this.sentence = lo;
      this.on.onSentence?.(t.ch, lo, now);
    }
    this.on.onTime?.(now, t.duration);
  }
}
