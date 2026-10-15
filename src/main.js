import { readBook, bookIdFor } from "./book.js";
import * as db from "./db.js";
import { Library, mergeLibraries, isRemoved } from "./cloud.js";
import { Player, cached } from "./player.js";
import { VOICES, voiceLabel } from "./voices.js";
import { formatTime, formatDuration } from "./format.js";
import { estimateSeconds } from "./plan.js";
import { MusicEngine, MOODS } from "./music.js";
import { chapterMood } from "./mood.js";

const $ = (id) => document.getElementById(id);
const el = new Proxy({}, { get: (_, id) => $(id) });

const CHARS_PER_SECOND = 15; // speaking rate at 1×, for estimates
const settings = { voice: "af_heart", speed: 1, music: false, musicVolume: 0.45, ...db.loadSettings() };
const save = () => db.saveSettings(settings);

let cloud = null; // Library, once connected
let library = db.loadLibrary(); // { books: { id: entry } }
const status = {}; // id -> { index, made, done (0..1), running, failed, startedAt }
let book = null; // the open book (full text)
let shownCh = -1;
let spans = [];

// ---------- connecting ----------

// Repositories default to the ones this site is published from:
// <owner>.github.io/<repo>/ -> app <owner>/<repo>, library <owner>/audiobook-data.
function defaults() {
  const owner = location.hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return owner && repo ? { appRepo: `${owner}/${repo}`, dataRepo: `${owner}/audiobook-data` } : { appRepo: "", dataRepo: "" };
}

// A link from "Add another device" carries the key in the #fragment, which
// never leaves the browser.
function takeKeyFromLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.get("key")) return;
  settings.conn = {
    ...defaults(),
    key: hash.get("key"),
    ...(hash.get("lib") ? { dataRepo: hash.get("lib") } : {}),
    ...(hash.get("app") ? { appRepo: hash.get("app") } : {}),
  };
  save();
  history.replaceState(null, "", location.pathname + location.search);
}

function showConnect(error) {
  el.connect.hidden = false;
  el.library.hidden = true;
  el.bookScreen.hidden = true;
  const d = { ...defaults(), ...settings.conn };
  el.dataRepoInput.value ||= d.dataRepo;
  el.appRepoInput.value ||= d.appRepo;
  el.appRepoName.textContent = d.appRepo ? d.appRepo.split("/")[1] : "this app's repository";
  el.connectError.textContent = error || "";
  el.connectError.hidden = !error;
}

el.connectBtn.addEventListener("click", async () => {
  const conn = {
    key: el.keyInput.value.trim(),
    dataRepo: el.dataRepoInput.value.trim(),
    appRepo: el.appRepoInput.value.trim(),
  };
  if (!conn.key) return showConnect("Paste your library key.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(conn.dataRepo) || !/^[\w.-]+\/[\w.-]+$/.test(conn.appRepo)) {
    el.connect.querySelector(".advanced").open = true;
    return showConnect("Fill in the library and app under Advanced (as owner/name).");
  }
  el.connectBtn.disabled = true;
  try {
    const lib = new Library(conn);
    await lib.check();
    cloud = lib;
    settings.conn = conn;
    save();
    await showLibrary();
  } catch (err) {
    showConnect(err.message);
  } finally {
    el.connectBtn.disabled = false;
  }
});

// ---------- library state ----------

const entry = (id) => library.books[id];

function updateEntry(id, changes, delay = 2000) {
  const e = library.books[id];
  if (!e) return;
  Object.assign(e, changes);
  db.saveLibrary(library);
  syncSoon(delay);
}

let syncTimer = null;
let syncing = null;

function syncSoon(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

async function syncNow() {
  if (!cloud) return;
  clearTimeout(syncTimer);
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const merged = await cloud.syncLibrary(library);
      library = mergeLibraries(merged, library); // keep changes made meanwhile
      db.saveLibrary(library);
      el.syncState.textContent = "";
      return true;
    } catch (err) {
      console.warn("Sync failed", err);
      el.syncState.textContent = navigator.onLine === false ? "Offline" : "Couldn't reach the library";
      el.syncState.title = err.message;
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

const chapterSizes = (b) => b.chapters.map((c) => c.paras.reduce((n, p) => n + p.reduce((m, s) => m + s.length, 0), 0));

// When the server should be done: estimated from the book's size and how
// fast GitHub's machines are, counted from when preparing started.
function estimateFor(e, index = {}) {
  const sizes = e.sizes || [];
  const todo = sizes.map((_, ch) => ch).filter((ch) => !index[ch]);
  return { at: Date.now(), seconds: Math.round(estimateSeconds(sizes, todo)) };
}

// Share of the work done, for the progress bar. Finished chapters alone
// lag behind (every machine is mid-chapter until near the end), so while
// it's running this also counts time elapsed against the estimate.
function progress(e, st) {
  if (!st) return 0;
  if (!st.running || !e?.eta) return st.done;
  const elapsed = (Date.now() - e.eta.at) / 1000;
  const byTime = Math.min(0.97, elapsed / Math.max(1, elapsed + secondsLeft(e)));
  return Math.max(st.done, byTime);
}

function secondsLeft(e) {
  if (!e?.eta) return null;
  return Math.max(0, (e.eta.at + e.eta.seconds * 1000 - Date.now()) / 1000);
}

function countdown(sec) {
  if (sec == null) return "";
  return sec < 1 ? "finishing up" : `${formatTime(sec)} left`;
}

// How far along a book's audio is, from the chapters on the server and any
// preparation running now.
async function refreshStatus(id, runs) {
  const e = entry(id);
  if (!e || e.ready) return status[id];
  const [index, active] = await Promise.all([cloud.audioIndex(id), runs ? null : cloud.activeRuns(id)]);
  const run = runs ? runs[id] : active[0];
  const sizes = e.sizes || [];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const made = Object.keys(index).length;
  const madeChars = Object.keys(index).reduce((n, ch) => n + (sizes[ch] || 0), 0);
  const running = !!run && run.status !== "completed";
  // A run takes a few seconds to show up after it's started.
  const starting = !running && e.startedAt && Date.now() - e.startedAt < 90_000 && made < e.chapters;
  status[id] = {
    index,
    made,
    done: madeChars / total,
    running: running || starting,
    failed: !running && !starting && run?.conclusion === "failure",
    startedAt: run?.run_started_at ? Date.parse(run.run_started_at) : e.startedAt,
  };
  if (status[id].running && !e.eta) {
    e.eta = { ...estimateFor(e, index), at: status[id].startedAt || Date.now() };
    db.saveLibrary(library);
  } else if (status[id].running && secondsLeft(e) === 0) {
    // Took longer than expected (another book may have been using the
    // machines): estimate again from the chapters that are left.
    const todo = sizes.map((_, ch) => ch).filter((ch) => !index[ch]);
    e.eta = { at: Date.now(), seconds: Math.round(estimateSeconds(sizes, todo, { startup: false })) + 30 };
    db.saveLibrary(library);
  }
  if (made === e.chapters && e.chapters > 0) await markReady(id, index);
  return status[id];
}

async function markReady(id, index) {
  // Total length, from each chapter's timings (small files).
  const durations = await Promise.all(Object.values(index).map(async (ids) => {
    try {
      return JSON.parse(await (await cloud.blob(ids.json)).text()).duration;
    } catch {
      return 0;
    }
  }));
  updateEntry(id, { ready: true, seconds: durations.reduce((a, b) => a + b, 0), startedAt: 0, eta: null, audioAt: Date.now() }, 500);
  const rec = await db.getBook(id);
  if (rec) await db.putBook({ ...rec, index });
  if (book?.id === id) book.index = index;
}

// ---------- library screen ----------

let libraryTimer = null;

async function showLibrary() {
  player.close();
  music.stop();
  book = null;
  clearInterval(bookTimer);
  document.title = "Kokoro Reader";
  el.connect.hidden = true;
  el.bookScreen.hidden = true;
  el.library.hidden = false;
  el.settings.hidden = true;
  renderBooks();
  await syncNow();
  renderBooks();
  await refreshAll();
  clearInterval(libraryTimer);
  libraryTimer = setInterval(() => !el.library.hidden && document.visibilityState === "visible" && refreshAll(), 30_000);
}

async function refreshAll() {
  // Every unfinished book, including ones another device started moments ago.
  const pending = Object.values(library.books).filter((e) => !isRemoved(e) && !e.ready);
  if (!pending.length) return;
  try {
    const runs = await cloud.latestRuns();
    await Promise.all(pending.map((e) => refreshStatus(e.id, runs)));
  } catch (err) {
    console.warn(err);
  }
  if (!el.library.hidden) renderBooks();
}

function renderBooks() {
  const entries = Object.values(library.books)
    .filter((e) => !isRemoved(e))
    .sort((a, b) => (b.pos?.at || b.addedAt) - (a.pos?.at || a.addedAt));
  el.books.innerHTML = entries.map((e) => {
    const tags = [];
    const st = status[e.id];
    const pct = st ? Math.floor(progress(e, st) * 100) : 0;
    if (e.ready) {
      tags.push(`<span class="tag ready">Ready · ${formatDuration(e.seconds || 0)}</span>`);
      if (e.finished) tags.push(`<span class="tag done">Finished</span>`);
      else if (e.pos && (e.pos.ch || e.pos.i)) tags.push(`<span class="tag">Paused at chapter ${e.pos.ch + 1} of ${e.chapters}</span>`);
      else tags.push(`<span class="tag">Not started</span>`);
    } else if (!st && !e.voice) tags.push(`<span class="tag">Not prepared yet</span>`);
    else if (!st) tags.push(`<span class="tag">Checking…</span>`);
    else if (!st.running && !st.made && !e.voice) tags.push(`<span class="tag">Not prepared yet</span>`);
    else if (st.running) {
      const left = secondsLeft(e);
      tags.push(`<span class="tag busy">Preparing · ${pct}%${left ? ` · ${formatDuration(left)} left` : ""}</span>`);
    }
    else if (st.failed) tags.push(`<span class="tag">Stopped at ${pct}% · open to continue</span>`);
    else tags.push(`<span class="tag">Paused · ${pct}%</span>`);
    return `<li>
      <button class="open" data-open="${esc(e.id)}"><strong>${esc(e.title)}</strong><span class="tags">${tags.join("")}</span></button>
      <button class="icon-btn remove" data-remove="${esc(e.id)}" aria-label="Remove ${esc(e.title)}">✕</button>
    </li>`;
  }).join("");
  el.noBooks.hidden = entries.length > 0;
}

async function addFile(file) {
  el.libError.hidden = true;
  el.drop.classList.add("busy");
  const label = el.drop.querySelector(".drop-title");
  try {
    label.textContent = "Reading the book…";
    const id = await bookIdFor(file);
    const known = entry(id);
    if (!known || isRemoved(known)) {
      const parsed = await readBook(file);
      const rec = { id, title: parsed.title, chapters: parsed.chapters };
      label.textContent = "Adding it to your library…";
      await cloud.uploadBook(rec);
      await db.putBook(rec);
      library.books[id] = {
        id,
        title: rec.title,
        chapters: rec.chapters.length,
        sizes: chapterSizes(rec),
        addedAt: Date.now(),
        audioAt: Date.now(),
      };
      db.saveLibrary(library);
      await syncNow();
    }
    await openBook(id);
  } catch (err) {
    console.error(err);
    showLibError(err);
  } finally {
    el.drop.classList.remove("busy");
    label.textContent = "Add a book";
  }
}

function showLibError(err) {
  el.libError.textContent = err.message || "Something went wrong.";
  el.libError.hidden = false;
}

async function removeBook(id) {
  const e = entry(id);
  if (!e || !confirm(`Remove "${e.title}" and its audio from your library?`)) return;
  try {
    await cloud.pause(id);
    await cloud.deleteBook(id);
  } catch (err) {
    return showLibError(err);
  }
  await db.deleteBook(id);
  updateEntry(id, { deletedAt: Date.now() }, 0);
  renderBooks();
}

// ---------- book screen ----------

let bookTimer = null;

async function openBook(id) {
  el.libError.hidden = true;
  const e = entry(id);
  if (!e) return;
  let rec = await db.getBook(id);
  if (!rec) {
    try {
      el.syncState.textContent = "Opening…";
      rec = await cloud.downloadBook(id);
      await db.putBook(rec);
      el.syncState.textContent = "";
    } catch (err) {
      el.syncState.textContent = "";
      return showLibError(new Error(`Couldn't open this book (${err.message}).`));
    }
  }
  book = rec;
  document.title = book.title;
  el.bookTitle.textContent = book.title;
  el.library.hidden = true;
  el.bookScreen.hidden = false;
  el.tocList.innerHTML = book.chapters.map((c, i) => `<li><button data-ch="${i}">${esc(c.title)}</button></li>`).join("");
  shownCh = -1;
  const pos = e.pos || { ch: 0, i: 0 };
  showChapter(Math.min(pos.ch, book.chapters.length - 1));
  await showBookState();
}

// Pick the panel for where this book is: choose a voice, preparing, or ready.
async function showBookState() {
  clearInterval(bookTimer);
  const e = entry(book.id);
  if (e.ready) return openPlayer();
  if (!e.voice) {
    const st = await refreshStatus(book.id).catch(() => null);
    if (!st?.running && !st?.made) return showSetup();
  }
  showWork();
  const myBook = book;
  const poll = async () => {
    try {
      await refreshStatus(myBook.id);
    } catch (err) {
      if (book === myBook) el.workInfo.textContent = err.message;
      return;
    }
    if (book !== myBook) return;
    if (entry(myBook.id).ready) return showBookState();
    showWork();
  };
  await poll();
  if (book === myBook && !entry(myBook.id).ready) {
    bookTimer = setInterval(() => document.visibilityState === "visible" && poll(), 15_000);
  }
}

async function openPlayer() {
  clearInterval(bookTimer);
  showPanel("player");
  const e = entry(book.id);
  try {
    if (!book.index) {
      book.index = await cloud.audioIndex(book.id);
      db.putBook(book);
    }
    const pos = e.pos || { ch: 0, i: 0 };
    await player.open(book, book.index, (sha) => cloud.blob(sha), Math.min(pos.ch, book.chapters.length - 1), pos.i);
    updateMetadata();
    music.clearClips();
    loadBookMusic(book);
  } catch (err) {
    playerStatus(`Couldn't load the audio (${err.message}).`);
  }
}

function showPanel(name) {
  el.musicMenu.hidden = true;
  el.setupPanel.hidden = name !== "setup";
  el.workPanel.hidden = name !== "work";
  el.playerPanel.hidden = name !== "player";
  el.moreMenu.hidden = true;
  el.text.classList.toggle("can-jump", name === "player");
}

function showChapter(ch) {
  if (ch === shownCh) return;
  shownCh = ch;
  const c = book.chapters[ch];
  el.chapterTitle.textContent = c.title;
  el.text.innerHTML = "";
  spans = [];
  marked = null;
  // Most EPUB chapters start with their heading as text; show that as the
  // heading (it's read aloud too) rather than repeating the title.
  const headingInText = c.paras[0].join("").trim() === c.title.trim();
  if (!headingInText) {
    const h = document.createElement("h2");
    h.textContent = c.title;
    el.text.append(h);
  }
  for (const [k, para] of c.paras.entries()) {
    const p = document.createElement(k === 0 && headingInText ? "h2" : "p");
    for (const s of para) {
      const span = document.createElement("span");
      span.className = "s";
      span.dataset.i = spans.length;
      span.textContent = s;
      spans.push(span);
      p.append(span);
    }
    el.text.append(p);
  }
  const nav = document.createElement("div");
  nav.className = "chapter-nav";
  if (ch > 0) nav.innerHTML += `<button class="btn" data-goto="${ch - 1}">‹ Previous chapter</button>`;
  if (ch < book.chapters.length - 1) nav.innerHTML += `<button class="btn next" data-goto="${ch + 1}">Next chapter ›</button>`;
  el.text.append(nav);
  el.text.scrollTop = 0;
  el.tocList.querySelectorAll("button").forEach((b) => b.classList.toggle("active", +b.dataset.ch === ch));
  updateMetadata();
}

let marked = null;
function markSentence(i) {
  marked?.classList.remove("now");
  marked = spans[i];
  if (!marked) return;
  marked.classList.add("now");
  const r = marked.getBoundingClientRect();
  const box = el.text.getBoundingClientRect();
  if (r.top < box.top + 40 || r.bottom > box.bottom - 40) marked.scrollIntoView({ block: "center", behavior: "smooth" });
}

function goToChapter(ch) {
  if (player.track) player.goToSentence(ch, 0);
  else showChapter(ch);
}

// ---------- choose a voice ----------

function showSetup() {
  showPanel("setup");
  const chars = chapterSizes(book).reduce((a, b) => a + b, 0);
  el.setupInfo.textContent =
    `${book.chapters.length} chapters · about ${formatDuration(chars / CHARS_PER_SECOND)} of listening. ` +
    "The whole book is prepared on the server; you can close the app while it works.";
  el.voiceSel.innerHTML = VOICES.map((v) => `<option value="${v.id}">${voiceLabel(v.id)}</option>`).join("");
  el.voiceSel.value = settings.voice;
  setupStatus("");
}

function setupStatus(text, isError = false) {
  el.setupStatus.textContent = text;
  el.setupStatus.hidden = !text;
  el.setupStatus.classList.toggle("error", isError);
}

const sample = new Audio();
el.sampleBtn.addEventListener("click", () => {
  if (!sample.paused) return sample.pause();
  sample.src = `./samples/${el.voiceSel.value}.mp3`;
  sample.play().catch(() => setupStatus("The voice sample isn't available.", true));
});
sample.addEventListener("play", () => (el.sampleBtn.textContent = "❚❚ Stop"));
sample.addEventListener("pause", () => (el.sampleBtn.textContent = "▶ Hear it"));
el.voiceSel.addEventListener("change", () => {
  settings.voice = el.voiceSel.value;
  save();
  if (!sample.paused) {
    sample.src = `./samples/${el.voiceSel.value}.mp3`;
    sample.play().catch(() => {});
  }
});

async function startPreparing(voice) {
  const id = book.id;
  try {
    await cloud.startPreparing(id, voice);
  } catch (err) {
    if (book?.id === id) {
      if (el.setupPanel.hidden) el.workInfo.textContent = err.message;
      else setupStatus(err.message, true);
    }
    return;
  }
  const eta = estimateFor(entry(id), status[id]?.index);
  updateEntry(id, { voice, startedAt: Date.now(), eta, ready: false, audioAt: Date.now() }, 0);
  status[id] = { index: {}, made: 0, done: 0, ...status[id], running: true, failed: false, startedAt: Date.now() };
  await syncNow(); // so other devices see it straight away, even if this one closes
  if (book?.id === id) showBookState();
}

el.prepareBtn.addEventListener("click", async () => {
  sample.pause();
  el.prepareBtn.disabled = true;
  setupStatus("Starting…");
  await startPreparing(el.voiceSel.value);
  el.prepareBtn.disabled = false;
});

// ---------- preparing ----------

let workTicker = null;
function showWork() {
  showPanel("work");
  clearInterval(workTicker);
  workTicker = setInterval(() => {
    if (el.workPanel.hidden || !book) return clearInterval(workTicker);
    if (status[book.id]?.running) showProgress();
  }, 1000);
  const e = entry(book.id);
  const st = status[book.id];
  const running = !st || st.running;
  el.workTitle.textContent = !st ? "Checking…" : running ? `Preparing${e.voice ? ` with ${voiceLabel(e.voice)}` : ""}` : st.failed ? "Stopped" : "Paused";
  showProgress();
  el.pauseBtn.hidden = !running;
  el.resumeBtn.hidden = running;
  el.restartBtn.hidden = running;
}

// Percentage, bar, time left and chapters, refreshed every second.
function showProgress() {
  const e = entry(book.id);
  const st = status[book.id];
  if (!st) {
    el.workPct.textContent = "";
    el.workInfo.textContent = "";
    return;
  }
  const done = progress(e, st);
  const pct = `${Math.floor(done * 100)}%`;
  const chapters = `${st.made} of ${e.chapters} chapters ready`;
  el.workBar.style.width = `${done * 100}%`;
  if (st.running) {
    const left = secondsLeft(e);
    el.workPct.textContent = left == null ? pct : countdown(left);
    el.workInfo.textContent = `${pct} · ${chapters}. It keeps going on the server, even if you close the app.`;
  } else {
    el.workPct.textContent = pct;
    el.workInfo.textContent = st.failed
      ? `${chapters}. Something went wrong on the server; tap Continue to try again.`
      : `${chapters}.`;
  }
}

el.pauseBtn.addEventListener("click", async () => {
  el.pauseBtn.disabled = true;
  const id = book.id;
  try {
    await cloud.pause(id);
    updateEntry(id, { startedAt: 0, eta: null, audioAt: Date.now() }, 0);
    if (status[id]) status[id].running = false;
    if (book?.id === id) showWork();
  } catch (err) {
    el.workInfo.textContent = err.message;
  } finally {
    el.pauseBtn.disabled = false;
  }
});

el.resumeBtn.addEventListener("click", () => startPreparing(entry(book.id).voice || settings.voice));

async function startOver() {
  if (!confirm("Delete this book's audio and choose a voice again?")) return;
  const id = book.id;
  try {
    await cloud.pause(id);
    await cloud.deleteAudio(id);
  } catch (err) {
    return alert(err.message);
  }
  player.close();
  delete status[id];
  delete book.index;
  db.putBook(book);
  updateEntry(id, { voice: null, ready: false, seconds: 0, startedAt: 0, audioAt: Date.now() }, 0);
  showBookState();
}
el.restartBtn.addEventListener("click", startOver);
el.redoBtn.addEventListener("click", startOver);

// ---------- listening ----------

const music = new MusicEngine();
music.setVolume(settings.musicVolume);

// The mood of a chapter: from the server's reading of the book when it has
// one, otherwise a quick guess from its words.
function moodOf(ch) {
  if (!book) return "reflective";
  return book.moods?.[ch] || (book.guessedMoods ??= {})[ch] || (book.guessedMoods[ch] = chapterMood(book.chapters[ch]));
}

function syncMusic() {
  const on = settings.music && player.playing;
  el.musicBtn.classList.toggle("on", settings.music);
  if (on) music.play(moodOf(shownCh));
  else music.pause();
  const mood = moodOf(shownCh);
  const how = book?.musicFiles?.[mood] ? "composed for this book" : "composed live on this device";
  el.musicNow.textContent = settings.music ? `Now: ${MOODS[mood]?.label || ""}, ${how} (chapter ${shownCh + 1}).` : "";
  el.composeBtn.hidden = !book || !!book.moods || composing.has(book?.id);
}

// The moods and music the server made for this book, if any. Loaded in the
// background when a book opens; until then the live composer plays.
const composing = new Set();
async function loadBookMusic(myBook) {
  try {
    const all = await cloud.audioAll(myBook.id);
    if (book !== myBook) return;
    if (all.moods) myBook.moods = JSON.parse(await (await cached(all.moods, (s) => cloud.blob(s))).text()).moods;
    const files = {};
    for (const [mood, sha] of Object.entries(all.music)) {
      files[mood] = await (await cached(sha, (s) => cloud.blob(s))).arrayBuffer();
    }
    if (book !== myBook) return;
    myBook.musicFiles = all.music;
    if (Object.keys(files).length) await music.setClips(files);
    if (all.moods) composing.delete(myBook.id);
    syncMusic();
  } catch (err) {
    console.warn("Couldn't load the book's music", err);
  }
}

let seeking = false;
let lastPositionUpdate = 0;

const player = new Player(el.audio, {
  onChapter: (ch) => {
    showChapter(ch);
    syncMusic();
  },
  onSentence: (ch, i) => {
    if (!book) return;
    markSentence(i);
    updateEntry(book.id, { pos: { ch, i, at: Date.now() } }, 60_000);
  },
  onState: (playing) => {
    el.playBtn.textContent = playing ? "❚❚" : "▶";
    el.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    syncMusic();
    if (!book) return;
    if (playing && entry(book.id)?.finished) updateEntry(book.id, { finished: false, finishedAt: Date.now() });
    if (!playing) syncSoon(1500); // save where you paused
  },
  onFinished: () => {
    if (book) updateEntry(book.id, { finished: true, finishedAt: Date.now(), pos: { ch: 0, i: 0, at: Date.now() } }, 500);
  },
  onLoading: (on) => playerStatus(on ? "Loading the chapter…" : ""),
  onTime: (now, total) => {
    if (!seeking) el.seekBar.value = total ? Math.round((now / total) * 1000) : 0;
    el.timeNow.textContent = formatTime(now);
    el.timeLeft.textContent = `-${formatTime(total - now)}`;
    updatePosition(now, total);
  },
});

function playerStatus(text) {
  el.playerStatus.textContent = text;
  el.playerStatus.hidden = !text;
}

function updateMetadata() {
  if (!("mediaSession" in navigator) || !book) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.chapters[shownCh]?.title || book.title,
    artist: book.title,
    album: "Kokoro Reader",
  });
}

function updatePosition(now, total) {
  if (!("mediaSession" in navigator) || !total || Date.now() - lastPositionUpdate < 1000) return;
  lastPositionUpdate = Date.now();
  try {
    navigator.mediaSession.setPositionState({ duration: total, position: Math.min(now, total), playbackRate: player.rate });
  } catch {}
}

if ("mediaSession" in navigator) {
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    seekbackward: () => player.skip(-15),
    seekforward: () => player.skip(15),
    previoustrack: () => player.goToSentence(Math.max(0, shownCh - 1), 0),
    nexttrack: () => player.goToSentence(Math.min(book.chapters.length - 1, shownCh + 1), 0),
    seekto: (e) => player.seek(e.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, (e) => player.track && fn(e));
    } catch {}
  }
}

el.playBtn.addEventListener("click", () => {
  if (player.playing) return player.pause();
  if (settings.music) music.ensure(); // sound can only start from a tap
  player.play().catch((err) => playerStatus(err.message));
});
el.prevBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence - 1));
el.nextBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence + 1));
el.musicBtn.addEventListener("click", () => {
  el.musicMenu.hidden = !el.musicMenu.hidden;
  el.moreMenu.hidden = true;
  el.musicOn.checked = settings.music;
  el.musicVol.value = Math.round(settings.musicVolume * 100);
  syncMusic();
});
el.musicOn.addEventListener("change", () => {
  settings.music = el.musicOn.checked;
  save();
  if (settings.music) music.ensure();
  syncMusic();
});
el.composeBtn.addEventListener("click", async () => {
  const id = book.id;
  el.composeBtn.disabled = true;
  try {
    // Preparing again only does what's missing: here, the moods and music.
    await cloud.startPreparing(id, entry(id).voice || settings.voice);
    composing.add(id);
    el.composeInfo.textContent = "Composing on the server. It takes a while; the music switches over by itself next time you open the book.";
  } catch (err) {
    el.composeInfo.textContent = err.message;
  } finally {
    el.composeInfo.hidden = false;
    el.composeBtn.disabled = false;
    syncMusic();
  }
});

el.musicVol.addEventListener("input", () => {
  settings.musicVolume = el.musicVol.value / 100;
  music.setVolume(settings.musicVolume);
  save();
});

el.moreBtn.addEventListener("click", () => {
  el.musicMenu.hidden = true;
  el.moreMenu.hidden = !el.moreMenu.hidden;
  const e = entry(book.id);
  el.voiceInfo.textContent = `Voice: ${voiceLabel(e.voice)} · ${formatDuration(e.seconds || 0)} in total`;
});

el.seekBar.addEventListener("input", () => {
  seeking = true;
  el.timeNow.textContent = formatTime((el.seekBar.value / 1000) * (player.track?.duration || 0));
});
el.seekBar.addEventListener("change", () => {
  seeking = false;
  player.seek((el.seekBar.value / 1000) * (player.track?.duration || 0));
});

el.speedSel.value = String(settings.speed);
player.setRate(settings.speed);
el.speedSel.addEventListener("change", () => {
  settings.speed = +el.speedSel.value;
  player.setRate(settings.speed);
  save();
});

// ---------- other events ----------

el.fileInput.addEventListener("change", () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = "";
  if (f) addFile(f);
});
el.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drop.classList.add("over");
});
el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
el.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) addFile(f);
});

el.books.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) return removeBook(rm.dataset.remove);
  const open = e.target.closest("[data-open]");
  if (open) openBook(open.dataset.open);
});

el.backBtn.addEventListener("click", showLibrary);
el.tocBtn.addEventListener("click", () => document.body.classList.toggle("toc-open"));
el.scrim.addEventListener("click", () => document.body.classList.remove("toc-open"));
el.tocList.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ch]");
  if (!b) return;
  document.body.classList.remove("toc-open");
  goToChapter(+b.dataset.ch);
});
el.text.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) return goToChapter(+go.dataset.goto);
  const s = e.target.closest(".s");
  if (s && player.track && !getSelection().toString()) player.goToSentence(shownCh, +s.dataset.i);
});

el.settingsBtn.addEventListener("click", () => {
  el.settings.hidden = !el.settings.hidden;
  el.settingsMsg.hidden = true;
  el.shareLinkBtn.hidden = !navigator.share;
});

function deviceLink() {
  const c = settings.conn;
  const d = defaults();
  const params = new URLSearchParams({ key: c.key });
  if (c.dataRepo !== d.dataRepo) params.set("lib", c.dataRepo);
  if (c.appRepo !== d.appRepo) params.set("app", c.appRepo);
  return `${location.origin}${location.pathname}#${params}`;
}

el.copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(deviceLink());
    el.settingsMsg.textContent = "Copied. Open it on your other device (send it to yourself privately).";
  } catch {
    el.settingsMsg.textContent = deviceLink();
  }
  el.settingsMsg.hidden = false;
});
el.shareLinkBtn.addEventListener("click", () => navigator.share({ title: "Kokoro Reader", url: deviceLink() }).catch(() => {}));

el.disconnectBtn.addEventListener("click", () => {
  if (!confirm("Sign out on this device? Your library stays safe on the server.")) return;
  delete settings.conn;
  save();
  cloud = null;
  library = { books: {} };
  db.saveLibrary(library);
  showConnect();
});

document.addEventListener("keydown", (e) => {
  if (!player.track || el.bookScreen.hidden || e.target.closest("input, select, button")) return;
  if (e.code === "Space") {
    e.preventDefault();
    player.playing ? player.pause() : player.play();
  } else if (e.code === "ArrowLeft") player.skip(-15);
  else if (e.code === "ArrowRight") player.skip(15);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") syncNow(); // leaving: save where you are
  else if (cloud) syncSoon(500);
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- start ----------

takeKeyFromLink();
if (settings.conn?.key) {
  cloud = new Library(settings.conn);
  showLibrary();
} else showConnect();
