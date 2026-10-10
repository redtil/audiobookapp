import { readBook, bookIdFor } from "./book.js";
import * as db from "./db.js";
import { Voice, prepareBook, sentencesOf, exportBook, importBook, isAudiobookFile } from "./prepare.js";
import { Player, bookSeconds } from "./player.js";
import { VOICES, voiceLabel } from "./voices.js";
import { formatTime, formatDuration, buildWav } from "./audio.js";
import * as sync from "./sync.js";

const $ = (id) => document.getElementById(id);
const el = new Proxy({}, { get: (_, id) => $(id) });

// ?mock swaps the model for a test tone, for trying the app without the download.
const MOCK = new URLSearchParams(location.search).has("mock");
const CHARS_PER_SECOND = 15; // speaking rate at 1×, for estimates

const settings = { voice: "af_heart", gpu: false, speed: 1, ...db.loadSettings() };
const save = () => db.saveSettings(settings);
const me = sync.deviceInfo(settings);
save();

let library = db.loadLibrary(); // { books: { id: entry } }, see sync.js
let book = null; // the open book's full record
let shownCh = -1; // chapter shown in the text view
let spans = []; // sentence elements of the shown chapter
let voice = null; // Voice (model worker), loaded on demand
let voiceGpu = null;
let job = null; // { controller, bookId } of the preparation in progress
let wakeLock = null;

const player = new Player(el.audio, {
  onChapter: (ch) => showChapter(ch),
  onSentence: (ch, i) => {
    if (!book) return;
    markSentence(i);
    updateEntry(book.id, { pos: { ch, i, at: Date.now() } }, { quiet: true });
  },
  onState: (playing) => {
    el.playBtn.textContent = playing ? "❚❚" : "▶";
    el.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    if (!book) return;
    if (playing && entry(book.id)?.finished) updateEntry(book.id, { finished: false, finishedAt: Date.now() });
    if (!playing) syncSoon(2000); // save the position where you paused
  },
  onFinished: () => {
    if (book) updateEntry(book.id, { finished: true, finishedAt: Date.now(), pos: { ch: 0, i: 0, at: Date.now() } });
  },
  onTime: (now, total) => {
    if (!seeking) el.seekBar.value = total ? Math.round((now / total) * 1000) : 0;
    el.timeNow.textContent = formatTime(now);
    el.timeLeft.textContent = `-${formatTime(total - now)}`;
    updatePosition(now, total);
  },
});

// ---------- library state ----------

const entry = (id) => library.books[id];

function updateEntry(id, changes, { quiet = false } = {}) {
  const e = library.books[id];
  if (!e) return;
  Object.assign(e, changes);
  db.saveLibrary(library);
  syncSoon(quiet ? 30_000 : 3000);
}

// Record how far this device has got with a book's audio.
function updateDevice(id, info) {
  const e = library.books[id];
  if (!e) return;
  e.devices = { ...e.devices, [me.id]: { name: settings.deviceName, ...e.devices?.[me.id], ...info, at: Date.now() } };
  db.saveLibrary(library);
  syncSoon(5000);
}

function entryFor(rec) {
  return {
    id: rec.id,
    title: rec.title,
    chapters: rec.chapters.length,
    total: rec.total,
    chars: rec.chars,
    addedAt: rec.addedAt || Date.now(),
    devices: {},
  };
}

// Every book on this device should be in the library (older versions and
// imports from files may not have added it yet).
async function adoptLocalBooks() {
  for (const rec of await db.listBooks().catch(() => [])) {
    const e = library.books[rec.id];
    if (e && !sync.isRemoved(e)) continue;
    if (e && sync.isRemoved(e)) {
      // Removed on another device: remove it here too.
      await db.deleteBook(rec.id);
      continue;
    }
    library.books[rec.id] = entryFor(rec);
    const made = rec.ready ? rec.total : await db.countClips(rec.id);
    if (made) library.books[rec.id].devices[me.id] = { name: settings.deviceName, voice: rec.voice, done: made, ready: !!rec.ready, at: Date.now() };
  }
  db.saveLibrary(library);
}

// ---------- sync ----------

let syncTimer = null;
let syncing = null;

function syncSoon(ms) {
  if (!sync.syncConfig(settings)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

async function syncNow() {
  const cfg = sync.syncConfig(settings);
  if (!cfg) return;
  clearTimeout(syncTimer);
  if (syncing) return syncing;
  syncing = (async () => {
    el.syncState.textContent = "Syncing…";
    try {
      for (const rec of await db.listBooks()) {
        if (!rec.uploaded) {
          await sync.uploadBookText(cfg, rec);
          rec.uploaded = true;
          await db.putBook(rec);
        }
      }
      const merged = await sync.syncLibrary(cfg, library);
      // Keep any change made while we were talking to GitHub.
      library = sync.mergeLibraries(merged, library);
      db.saveLibrary(library);
      settings.lastSync = Date.now();
      save();
      showSyncState();
      if (!el.library.hidden) {
        await adoptLocalBooks(); // applies removals made elsewhere
        renderBooks();
      }
      return true;
    } catch (err) {
      console.warn("Sync failed", err);
      el.syncState.textContent = navigator.onLine === false ? "Offline: will sync later" : "Sync failed";
      el.syncState.title = err.message;
      return err;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

function showSyncState() {
  const on = !!sync.syncConfig(settings);
  el.syncState.title = "";
  el.syncState.textContent = !on ? "" : settings.lastSync ? `Synced ${ago(settings.lastSync)}` : "";
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

// ---------- library screen ----------

async function showLibrary() {
  stopPreparing();
  player.close();
  book = null;
  document.title = "Kokoro Reader";
  el.bookScreen.hidden = true;
  el.library.hidden = false;
  await renderBooks();
  syncNow();
}

async function renderBooks() {
  const local = new Map((await db.listBooks().catch(() => [])).map((b) => [b.id, b]));
  const entries = Object.values(library.books)
    .filter((e) => !sync.isRemoved(e))
    .sort((a, b) => (b.pos?.at || b.addedAt) - (a.pos?.at || a.addedAt));

  const rows = await Promise.all(entries.map(async (e) => {
    const rec = local.get(e.id);
    const tags = [];
    // Listening
    if (e.finished) tags.push(`<span class="tag done">Finished</span>`);
    else if (e.pos && (e.pos.ch || e.pos.i)) tags.push(`<span class="tag">Paused · chapter ${e.pos.ch + 1} of ${e.chapters}</span>`);
    else tags.push(`<span class="tag">Not started</span>`);
    // Audio on this device
    if (rec?.ready) tags.push(`<span class="tag ready">Audio ready · ${formatDuration(rec.seconds || 0)}</span>`);
    else if (rec) {
      const made = await db.countClips(rec.id);
      const pct = Math.floor((made / rec.total) * 100);
      if (job?.bookId === rec.id) tags.push(`<span class="tag">Preparing ${pct}%</span>`);
      else if (made) tags.push(`<span class="tag">Preparing paused · ${pct}%</span>`);
      else tags.push(`<span class="tag">No audio yet</span>`);
    } else tags.push(`<span class="tag away">Not on this device yet</span>`);
    // Other devices
    for (const [id, d] of Object.entries(e.devices || {})) {
      if (id === me.id) continue;
      const state = d.ready ? "audio ready" : `${Math.floor((d.done / e.total) * 100)}% prepared`;
      tags.push(`<span class="tag away">${esc(d.name || "Other device")}: ${state}</span>`);
    }
    return `<li>
      <button class="open" data-open="${esc(e.id)}"><strong>${esc(e.title)}</strong><span class="tags">${tags.join("")}</span></button>
      <button class="icon-btn remove" data-remove="${esc(e.id)}" aria-label="Remove ${esc(e.title)}">✕</button>
    </li>`;
  }));
  el.books.innerHTML = rows.join("");
  el.noBooks.hidden = entries.length > 0;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    el.storage.textContent = local.size
      ? `Using ${(usage / 1e6).toFixed(0)} MB of storage on this device (${(quota / 1e9).toFixed(1)} GB available).`
      : "";
  } catch {}
}

async function addFile(file) {
  el.libError.hidden = true;
  el.drop.classList.add("busy");
  const label = el.drop.querySelector(".drop-title");
  try {
    if (await isAudiobookFile(file)) {
      label.textContent = "Opening audiobook…";
      const rec = await importBook(file, (f) => (label.textContent = `Opening audiobook… ${Math.round(f * 100)}%`));
      const e = library.books[rec.id];
      if (!e || sync.isRemoved(e)) library.books[rec.id] = entryFor(rec);
      updateDevice(rec.id, { voice: rec.voice, done: rec.total, ready: true });
      await openBook(rec.id);
      return;
    }
    label.textContent = "Reading the book…";
    const id = await bookIdFor(file);
    let rec = await db.getBook(id);
    if (!rec) {
      const parsed = await readBook(file);
      rec = {
        id,
        title: parsed.title,
        chapters: parsed.chapters,
        total: sentencesOf(parsed).length,
        chars: parsed.chapters.reduce((n, c) => n + c.paras.flat().join("").length, 0),
        addedAt: Date.now(),
      };
      await db.putBook(rec);
    }
    const e = library.books[id];
    if (!e || sync.isRemoved(e)) {
      library.books[id] = { ...entryFor(rec), ...(e ? { pos: e.pos, devices: e.devices } : {}), addedAt: Date.now() };
      db.saveLibrary(library);
      syncSoon(1000);
    }
    db.persist();
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
  el.libError.textContent = /quota|space/i.test(err.message)
    ? "This device is out of storage space for the browser. Remove a book and try again."
    : err.message || "Couldn't open that file.";
  el.libError.hidden = false;
}

async function removeBook(id) {
  const e = entry(id);
  const where = sync.syncConfig(settings) ? " from all your devices" : "";
  if (!confirm(`Remove "${e?.title}"${where}? Its audio on this device is deleted too.`)) return;
  await db.deleteBook(id);
  if (e) updateEntry(id, { deletedAt: Date.now() });
  renderBooks();
  syncNow();
}

// ---------- book screen ----------

async function openBook(id) {
  el.libError.hidden = true;
  let rec = await db.getBook(id);
  if (!rec) {
    // Only in the synced library: fetch its text from GitHub.
    const cfg = sync.syncConfig(settings);
    if (!cfg) return;
    try {
      el.syncState.textContent = "Getting the book…";
      rec = { ...(await sync.downloadBookText(cfg, id)), addedAt: entry(id)?.addedAt || Date.now(), uploaded: true };
      await db.putBook(rec);
      db.persist();
      showSyncState();
    } catch (err) {
      showSyncState();
      return showLibError(new Error(`Couldn't get this book from GitHub (${err.message}).`));
    }
  }
  book = rec;
  book.openedAt = Date.now();
  db.putBook(book);

  document.title = book.title;
  el.bookTitle.textContent = book.title;
  el.library.hidden = true;
  el.bookScreen.hidden = false;
  el.tocList.innerHTML = book.chapters
    .map((c, i) => `<li><button data-ch="${i}">${esc(c.title)}</button></li>`)
    .join("");

  const pos = entry(id)?.pos || { ch: 0, i: 0 };
  const ch = Math.min(pos.ch, book.chapters.length - 1);
  shownCh = -1;
  if (book.ready) {
    showPanel("player");
    await player.open(book, ch, pos.i);
    updateMetadata();
  } else {
    showChapter(ch);
    const made = await db.countClips(book.id);
    if (made) showWork(made, null, false);
    else showSetup();
  }
}

function showPanel(name) {
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
  if (book.ready) player.goToSentence(ch, 0);
  else showChapter(ch);
}

// ---------- step 1: set up ----------

function showSetup() {
  showPanel("setup");
  const listen = book.chars / CHARS_PER_SECOND;
  el.setupInfo.textContent =
    `${book.chapters.length} chapters · about ${formatDuration(listen)} of listening. ` +
    `The whole book is turned into audio first, then it plays like an audiobook.`;
  const elsewhere = Object.entries(entry(book.id)?.devices || {}).find(([id, d]) => id !== me.id && d.ready);
  if (elsewhere) {
    el.setupInfo.textContent += ` It's already prepared on ${elsewhere[1].name}: there, use “Save audiobook file” and open that file here to skip this step.`;
  }
  el.voiceSel.innerHTML = VOICES.map((v) => `<option value="${v.id}">${voiceLabel(v.id)}${v.note ? ` · ${v.note}` : ""}</option>`).join("");
  el.voiceSel.value = settings.voice;
  el.engineSel.value = settings.gpu ? "gpu" : "cpu";
  setupStatus("");
}

function setupStatus(text, isError = false) {
  el.setupStatus.textContent = text;
  el.setupStatus.hidden = !text;
  el.setupStatus.classList.toggle("error", isError);
}

// Load the model once, on the engine chosen. Reports download progress to `say`.
async function getVoice(say) {
  if (voice && voiceGpu === settings.gpu) return voice;
  voice?.destroy();
  voiceGpu = settings.gpu;
  say("Loading the voice…");
  voice = new Voice({
    gpu: settings.gpu,
    mock: MOCK,
    onProgress: (loaded, total) => total && say(`Loading the voice… ${Math.round((loaded / total) * 100)}%`),
    onNote: say,
  });
  try {
    await voice.ready;
  } catch (err) {
    voice.destroy();
    voice = null;
    throw new Error(`The voice couldn't start on this device (${err.message}).`);
  }
  return voice;
}

let sampleAudio = null;
async function playSample() {
  el.sampleBtn.disabled = true;
  try {
    const v = await getVoice((t) => setupStatus(t));
    setupStatus("Making a sample…");
    const first = book.chapters[0].paras.flat().find((s) => s.length > 40) || "This is how your book will sound.";
    const { data } = await v.speak(first.slice(0, 200), el.voiceSel.value);
    if (sampleAudio) URL.revokeObjectURL(sampleAudio.src);
    sampleAudio = new Audio(URL.createObjectURL(buildWav([{ data, pauseAfter: 0 }]).blob));
    await sampleAudio.play();
    setupStatus("");
  } catch (err) {
    if (err.message !== "cancelled") setupStatus(err.message, true);
  } finally {
    el.sampleBtn.disabled = false;
  }
}

// ---------- step 2: prepare ----------

async function startPreparing() {
  if (job) return;
  if (!book.voice) {
    book.voice = settings.voice;
    await db.putBook(book);
  }
  const myBook = book;
  const controller = new AbortController();
  job = { controller, bookId: myBook.id };
  const { signal } = controller;
  showWork(0, null, true);
  el.workInfo.textContent = "Loading the voice…";
  keepAwake(true);
  let lastReport = 0;
  try {
    const v = await getVoice((t) => (el.workInfo.textContent = t));
    if (signal.aborted) return;
    const result = await prepareBook(myBook, v, {
      signal,
      onProgress: ({ done, total, secondsLeft }) => {
        if (book === myBook && !signal.aborted) showWork(done, secondsLeft, true);
        if (Date.now() - lastReport > 60_000) {
          lastReport = Date.now();
          updateDevice(myBook.id, { voice: myBook.voice, done, ready: false });
        }
      },
    });
    if (!result.complete) {
      updateDevice(myBook.id, { voice: myBook.voice, done: await db.countClips(myBook.id), ready: false });
      return;
    }
    myBook.ready = true;
    myBook.seconds = await bookSeconds(myBook);
    await db.putBook(myBook);
    updateDevice(myBook.id, { voice: myBook.voice, done: myBook.total, ready: true });
    if (book === myBook) {
      const pos = entry(myBook.id)?.pos || { ch: 0, i: 0 };
      shownCh = -1;
      showPanel("player");
      await player.open(myBook, pos.ch, pos.i);
      notify(myBook.title);
    }
  } catch (err) {
    console.error(err);
    if (book === myBook) {
      el.workTitle.textContent = "Stopped";
      el.workInfo.textContent = err.message;
      setWorkButtons(false);
    }
  } finally {
    if (job?.controller === controller) job = null;
    keepAwake(false);
  }
}

function stopPreparing() {
  if (!job) return;
  job.controller.abort();
  job = null;
  voice?.clear();
  keepAwake(false);
}

function showWork(done, secondsLeft, running) {
  showPanel("work");
  const pct = book.total ? Math.floor((done / book.total) * 100) : 0;
  el.workPct.textContent = `${pct}%`;
  el.workBar.style.width = `${(done / book.total) * 100}%`;
  el.workTitle.textContent = running ? `Preparing with ${voiceLabel(book.voice)}` : "Paused";
  const counts = `${done.toLocaleString()} of ${book.total.toLocaleString()} sentences`;
  el.workInfo.textContent = running
    ? `${counts}${secondsLeft != null ? ` · ${formatDuration(secondsLeft)} left` : " · working out the time left…"}`
    : `${counts} done with ${voiceLabel(book.voice)}.`;
  setWorkButtons(running);
}

function setWorkButtons(running) {
  el.stopBtn.hidden = !running;
  el.resumeBtn.hidden = running;
  el.restartBtn.hidden = running;
}

async function startOver() {
  if (!confirm("Delete the audio made on this device and choose a voice again?")) return;
  stopPreparing();
  player.close();
  await db.deleteClips(book.id);
  book.voice = null;
  book.ready = false;
  book.seconds = 0;
  await db.putBook(book);
  updateDevice(book.id, { voice: null, done: 0, ready: false });
  const ch = shownCh;
  shownCh = -1;
  showChapter(Math.max(0, ch));
  showSetup();
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  // The screen lock is dropped whenever the page is hidden; take it back.
  if (document.visibilityState === "visible" && job) keepAwake(true);
  if (document.visibilityState === "visible") syncSoon(500);
  else syncNow(); // leaving: save where you are
});

function notify(title) {
  document.title = `✓ ${title}`;
  setTimeout(() => book && (document.title = book.title), 8000);
  try {
    navigator.vibrate?.(200);
  } catch {}
}

// ---------- step 3: listen ----------

let seeking = false;
let lastPositionUpdate = 0;

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
      navigator.mediaSession.setActionHandler(action, (e) => book?.ready && fn(e));
    } catch {}
  }
}

async function exportCurrent() {
  el.exportBtn.disabled = true;
  const label = el.exportBtn.textContent;
  el.exportBtn.textContent = "Getting the file ready…";
  try {
    const blob = await exportBook(book);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${book.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "book"}.audiobook`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (err) {
    alert(`Couldn't save the file: ${err.message}`);
  } finally {
    el.exportBtn.disabled = false;
    el.exportBtn.textContent = label;
  }
}

// ---------- events ----------

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

el.backBtn.addEventListener("click", () => {
  if (job && !confirm("Pause preparing this book? You can continue later.")) return;
  showLibrary();
});
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
  if (s && book.ready && !getSelection().toString()) player.goToSentence(shownCh, +s.dataset.i);
});

el.voiceSel.addEventListener("change", () => {
  settings.voice = el.voiceSel.value;
  save();
});
el.engineSel.addEventListener("change", () => {
  settings.gpu = el.engineSel.value === "gpu";
  save();
});
el.sampleBtn.addEventListener("click", playSample);
el.prepareBtn.addEventListener("click", () => {
  sampleAudio?.pause();
  startPreparing();
});
el.stopBtn.addEventListener("click", async () => {
  const id = book.id;
  stopPreparing();
  const made = await db.countClips(id);
  showWork(made, null, false);
  updateDevice(id, { done: made });
});
el.resumeBtn.addEventListener("click", startPreparing);
el.restartBtn.addEventListener("click", startOver);
el.redoBtn.addEventListener("click", startOver);

el.playBtn.addEventListener("click", () => (player.playing ? player.pause() : player.play()));
el.prevBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence - 1));
el.nextBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence + 1));
el.moreBtn.addEventListener("click", () => {
  el.moreMenu.hidden = !el.moreMenu.hidden;
  el.voiceInfo.textContent = `Voice: ${voiceLabel(book.voice)} · ${formatDuration(book.seconds || 0)} in total`;
});
el.exportBtn.addEventListener("click", exportCurrent);

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

document.addEventListener("keydown", (e) => {
  if (!book?.ready || el.bookScreen.hidden || e.target.closest("input, select, button")) return;
  if (e.code === "Space") {
    e.preventDefault();
    player.playing ? player.pause() : player.play();
  } else if (e.code === "ArrowLeft") player.skip(-15);
  else if (e.code === "ArrowRight") player.skip(15);
});

window.addEventListener("beforeunload", (e) => {
  if (job) e.preventDefault();
});

// Sync settings
function fillSyncForm() {
  el.syncRepo.value = settings.sync?.repo || "";
  el.syncToken.value = settings.sync?.token || "";
  el.deviceName.value = settings.deviceName || "";
  el.syncOff.hidden = !sync.syncConfig(settings);
}

function syncMsg(text, ok) {
  el.syncMsg.textContent = text;
  el.syncMsg.hidden = !text;
  el.syncMsg.className = `small ${ok ? "ok" : "error"}`;
}

el.syncSave.addEventListener("click", async () => {
  const repo = el.syncRepo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
  const token = el.syncToken.value.trim();
  settings.deviceName = el.deviceName.value.trim() || settings.deviceName;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return syncMsg("Enter the repository as owner/name, and the token.");
  settings.sync = { repo, token };
  save();
  for (const e of Object.values(library.books)) if (e.devices?.[me.id]) e.devices[me.id].name = settings.deviceName;
  el.syncSave.disabled = true;
  syncMsg("Connecting…", true);
  const result = await syncNow();
  el.syncSave.disabled = false;
  if (result === true) syncMsg("Connected. This device now shares its library.", true);
  else syncMsg(result?.message || "Couldn't sync.");
  fillSyncForm();
});

el.syncOff.addEventListener("click", () => {
  delete settings.sync;
  settings.lastSync = 0;
  save();
  fillSyncForm();
  showSyncState();
  syncMsg("Sync is off. Your library stays on this device.", true);
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

fillSyncForm();
showSyncState();
await adoptLocalBooks();
renderBooks();
syncNow();
