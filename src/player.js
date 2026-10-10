// Plays a book chapter by chapter. Each chapter is one MP3 with the start
// time of every sentence, fetched from the library and kept on the device
// (Cache Storage) so chapters already heard play offline.

const CACHE = "kokoro-reader-audio";

async function cached(sha, fetchBlob) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(`/audio/${sha}`);
    if (hit) return hit.blob();
  } catch {}
  const blob = await fetchBlob(sha);
  try {
    await cache?.put(`/audio/${sha}`, new Response(blob));
  } catch {}
  return blob;
}

export class Player {
  constructor(audio, handlers) {
    this.audio = audio;
    this.audio.preservesPitch = true;
    this.on = handlers; // onSentence, onChapter, onState, onTime, onFinished, onLoading
    this.book = null;
    this.index = null; // { [ch]: { mp3, json } } blob ids
    this.fetchBlob = null;
    this.track = null; // { ch, url, starts, duration }
    this.nextTrack = null;
    this.sentence = -1;
    this.rate = 1;
    audio.addEventListener("timeupdate", () => this.tick());
    audio.addEventListener("seeked", () => this.tick());
    audio.addEventListener("play", () => this.on.onState?.(true));
    audio.addEventListener("pause", () => this.on.onState?.(false));
    audio.addEventListener("ended", () => this.chapterEnded());
  }

  async open(book, index, fetchBlob, ch, sentence = 0) {
    this.close();
    this.book = book;
    this.index = index;
    this.fetchBlob = fetchBlob;
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

  async build(ch) {
    const ids = this.index[ch];
    if (!ids) throw new Error("This chapter's audio is missing.");
    const [mp3, json] = await Promise.all([cached(ids.mp3, this.fetchBlob), cached(ids.json, this.fetchBlob)]);
    const { starts, duration } = JSON.parse(await json.text());
    return { ch, url: URL.createObjectURL(new Blob([mp3], { type: "audio/mpeg" })), starts, duration };
  }

  async loadChapter(ch, sentence = 0, { autoplay = false } = {}) {
    const book = this.book;
    let t = this.nextTrack?.ch === ch ? this.nextTrack : null;
    if (t) this.nextTrack = null;
    else {
      this.on.onLoading?.(true);
      try {
        t = await this.build(ch);
      } finally {
        this.on.onLoading?.(false);
      }
    }
    if (book !== this.book) return URL.revokeObjectURL(t.url);
    if (this.track) URL.revokeObjectURL(this.track.url);
    this.track = t;
    this.sentence = -1;
    this.audio.src = t.url;
    this.on.onChapter?.(ch);
    await new Promise((r) => this.audio.addEventListener("loadedmetadata", r, { once: true }));
    this.audio.playbackRate = this.rate;
    this.audio.currentTime = t.starts[Math.min(sentence, t.starts.length - 1)] ?? 0;
    this.tick();
    if (autoplay) await this.play();
    else this.prefetchNext();
  }

  // Fetch the next chapter ahead of time, so moving on to it is instant
  // (a locked phone may not give the page time to fetch it later).
  async prefetchNext() {
    const ch = this.track.ch + 1;
    if (ch >= this.book.chapters.length || this.nextTrack?.ch === ch) return;
    const book = this.book;
    const t = await this.build(ch).catch(() => null);
    if (!t) return;
    if (book !== this.book || this.track?.ch !== ch - 1 || this.nextTrack) return URL.revokeObjectURL(t.url);
    this.nextTrack = t;
  }

  async play() {
    if (!this.track) return;
    try {
      await this.audio.play();
      this.prefetchNext();
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
    else this.on.onFinished?.();
  }

  tick() {
    const t = this.track;
    if (!t) return;
    const now = this.audio.currentTime;
    let lo = 0;
    let hi = t.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.starts[mid] <= now + 0.05) lo = mid;
      else hi = mid - 1;
    }
    if (lo !== this.sentence) {
      this.sentence = lo;
      this.on.onSentence?.(t.ch, lo);
    }
    this.on.onTime?.(now, t.duration);
  }
}
