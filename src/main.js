import { parseBook, toParagraphs } from "./parsers.js";
import { KokoroEngine, DeviceEngine } from "./engines.js";
import * as store from "./storage.js";

const $ = (id) => document.getElementById(id);
const els = {
  home: $("home"), reader: $("reader"), player: $("player"), page: $("page"),
  toc: $("toc"), tocList: $("tocList"), scrim: $("scrim"), title: $("bookTitle"),
  menuBtn: $("menuBtn"), homeBtn: $("homeBtn"), fileInput: $("fileInput"), drop: $("drop"),
  homeError: $("homeError"), library: $("library"), librarySection: $("librarySection"),
  playBtn: $("playBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"),
  speedSel: $("speedSel"), modeSel: $("modeSel"), voiceSel: $("voiceSel"), status: $("engineStatus"),
};

const DEFAULT_VOICE = "kokoro:af_heart";
const settings = { voice: DEFAULT_VOICE, speed: 1, gpu: false, ...store.loadSettings() };
// Earlier builds could save a device voice the user never picked; start
// everyone on the natural voice once.
if (settings.v !== 2) {
  settings.voice = DEFAULT_VOICE;
  settings.v = 2;
  store.saveSettings(settings);
}

const state = {
  id: null,
  book: null,
  ch: 0,
  i: 0,
  sentences: [], // current chapter: [{ text, el }]
  playing: false,
  playToken: 0,
};

// ---------- voices ----------

let kokoro = null;
let kokoroFailed = false;
const device = DeviceEngine.available() ? new DeviceEngine() : null;

const ACCENTS = { a: "US", b: "UK" };
function kokoroLabel(id) {
  const [prefix, name] = id.split("_");
  const accent = ACCENTS[prefix[0]];
  const gender = prefix[1] === "f" ? "female" : "male";
  return `${name[0].toUpperCase()}${name.slice(1)} (${accent}, ${gender})`;
}

function startKokoro() {
  if (kokoro || kokoroFailed) return;
  setStatus("Loading the natural voice (the first time downloads it)…");
  kokoro = new KokoroEngine({
    gpu: settings.gpu,
    onProgress: (loaded, total) => {
      if (total) setStatus(`Downloading the natural voice… ${Math.round((loaded / total) * 100)}%`);
    },
    onReady: () => {
      setStatus("");
      fillVoices();
      if (settings.voice.startsWith("kokoro:")) kokoro.setVoice(settings.voice.slice(7));
      prefetchAhead();
    },
    onStatus: (text) => setStatus(text),
    onError: (msg) => {
      console.error(msg);
      kokoroFailed = true;
      kokoro = null;
      setStatus(`The natural voice couldn't load on this device (${msg}), so the device voice is used instead.`);
      fillVoices();
    },
  });
  kokoro.setRate(settings.speed);
}

function fillVoices() {
  const opts = [];
  if (kokoro?.ready) {
    const ids = kokoro.voices.filter((v) => /^[ab][fm]_/.test(v));
    // Best-rated voices first.
    const top = ["af_heart", "af_bella", "bf_emma", "am_fenrir", "am_michael", "bm_george"];
    ids.sort((a, b) => ((top.indexOf(a) + 1 || 99) - (top.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    const group = ids.map((v) => `<option value="kokoro:${v}">${kokoroLabel(v)}</option>`).join("");
    opts.push(`<optgroup label="Natural voices">${group}</optgroup>`);
  } else if (kokoro && !kokoroFailed) {
    opts.push(`<option value="kokoro:af_heart">Natural voice (loading…)</option>`);
  }
  if (device) {
    const dv = device.voices();
    const group = dv.map((v) => `<option value="device:${v.name}">${v.name}</option>`).join("");
    opts.push(`<optgroup label="Device voices">${group || '<option value="device:">Default</option>'}</optgroup>`);
  }
  els.voiceSel.innerHTML = opts.join("");
  // Show the saved choice when it's available, without overwriting it:
  // the natural voices only appear once the model has loaded.
  const has = (v) => [...els.voiceSel.options].some((o) => o.value === v);
  els.voiceSel.value = has(settings.voice) ? settings.voice : els.voiceSel.options[0]?.value;
}

if (device) speechSynthesis.onvoiceschanged = fillVoices;

function engine() {
  if (settings.voice.startsWith("kokoro:")) {
    if (kokoro?.ready) return kokoro;
    if (kokoroFailed) return device;
  }
  if (settings.voice.startsWith("device:")) return device;
  return device;
}

function usingKokoroButLoading() {
  return settings.voice.startsWith("kokoro:") && kokoro && !kokoro.ready;
}

function setStatus(text) {
  els.status.textContent = text;
  els.status.hidden = !text;
}

// ---------- book loading ----------

async function openFile(file, { save = true } = {}) {
  els.homeError.hidden = true;
  els.drop.classList.add("busy");
  try {
    const book = await parseBook(file);
    state.id = store.bookId(file);
    state.book = book;
    if (save) await store.saveBook(file, book.title);
    const p = store.loadProgress(state.id);
    showReader();
    loadChapter(p?.ch ?? 0, p?.i ?? 0);
    startKokoro();
    fillVoices();
  } catch (err) {
    console.error(err);
    els.homeError.textContent = err.message || "Couldn't open that file.";
    els.homeError.hidden = false;
  } finally {
    els.drop.classList.remove("busy");
  }
}

function showReader() {
  els.home.hidden = true;
  els.reader.hidden = false;
  els.player.hidden = false;
  els.menuBtn.hidden = false;
  els.homeBtn.hidden = false;
  els.title.textContent = state.book.title;
  document.title = state.book.title;
  els.tocList.innerHTML = state.book.chapters
    .map((c, idx) => `<li><button data-ch="${idx}">${escapeHtml(c.title)}</button></li>`)
    .join("");
}

async function showHome() {
  stop();
  state.book = null;
  els.home.hidden = false;
  els.reader.hidden = true;
  els.player.hidden = true;
  els.menuBtn.hidden = true;
  els.homeBtn.hidden = true;
  els.title.textContent = "Book Reader";
  document.title = "Book Reader";
  await renderLibrary();
}

async function renderLibrary() {
  const books = await store.listBooks();
  els.librarySection.hidden = !books.length;
  els.library.innerHTML = books
    .map((b) => {
      const p = store.loadProgress(b.id);
      const where = p ? `Chapter ${p.ch + 1}` : "Not started";
      return `<li>
        <button class="book" data-id="${escapeHtml(b.id)}">
          <strong>${escapeHtml(b.title)}</strong><span class="muted">${where}</span>
        </button>
        <button class="icon-btn remove" data-remove="${escapeHtml(b.id)}" aria-label="Remove">✕</button>
      </li>`;
    })
    .join("");
}

function loadChapter(ch, i = 0) {
  const chapter = state.book.chapters[ch];
  if (!chapter) return;
  state.ch = ch;
  state.sentences = [];
  els.page.innerHTML = "";

  const h = document.createElement("h2");
  h.textContent = chapter.title;
  els.page.appendChild(h);

  for (const para of toParagraphs(chapter.text)) {
    const p = document.createElement("p");
    for (const text of para) {
      const span = document.createElement("span");
      span.className = "s";
      span.textContent = text;
      span.dataset.i = state.sentences.length;
      state.sentences.push({ text, el: span });
      p.appendChild(span);
    }
    els.page.appendChild(p);
  }

  const nav = document.createElement("div");
  nav.className = "chapter-nav";
  if (ch > 0) nav.innerHTML += `<button data-goto="${ch - 1}">← Previous chapter</button>`;
  if (ch < state.book.chapters.length - 1) nav.innerHTML += `<button data-goto="${ch + 1}">Next chapter →</button>`;
  els.page.appendChild(nav);

  els.tocList.querySelectorAll("button").forEach((b) => b.classList.toggle("active", +b.dataset.ch === ch));
  setCurrent(Math.min(i, state.sentences.length - 1), true);
  if (i === 0) els.page.scrollTop = 0;
}

function setCurrent(i, scroll) {
  state.sentences[state.i]?.el.classList.remove("current");
  state.i = Math.max(0, i);
  const cur = state.sentences[state.i];
  if (!cur) return;
  cur.el.classList.add("current");
  if (scroll) scrollIntoViewIfNeeded(cur.el);
  store.saveProgress(state.id, { ch: state.ch, i: state.i });
  updateMediaSession();
  prefetchAhead();
}

function scrollIntoViewIfNeeded(el) {
  const r = el.getBoundingClientRect();
  const pr = els.page.getBoundingClientRect();
  if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ---------- playback ----------

function keyFor(ch, i) {
  return `${state.id}|${ch}|${i}`;
}

// Keep the natural voice working a few sentences ahead of the reader,
// current sentence first. Runs while paused too, so a tap is ready fast.
function prefetchAhead() {
  if (!kokoro?.ready || engine() !== kokoro || !state.book) return;
  const items = [];
  for (let k = 0; k < 6; k++) {
    const s = state.sentences[state.i + k];
    if (!s) break;
    items.push({ text: s.text, key: keyFor(state.ch, state.i + k) });
  }
  kokoro.want(items);
}

async function playLoop() {
  const token = ++state.playToken;
  const isCurrent = () => token === state.playToken && state.playing;

  while (isCurrent()) {
    if (usingKokoroButLoading()) {
      setStatus("The natural voice is still downloading. Playback starts as soon as it's ready, or pick a device voice.");
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const eng = engine();
    if (!eng) {
      setStatus("No voice is available in this browser.");
      setPlaying(false);
      return;
    }
    const s = state.sentences[state.i];
    if (!s) {
      // End of chapter: move on to the next one.
      if (state.ch < state.book.chapters.length - 1) {
        loadChapter(state.ch + 1, 0);
        continue;
      }
      setPlaying(false);
      return;
    }
    setCurrent(state.i, true);
    if (eng === kokoro && els.status.textContent.startsWith("The natural voice is still")) setStatus("");
    try {
      await eng.speak(s.text, keyFor(state.ch, state.i), isCurrent);
    } catch (err) {
      if (!isCurrent()) return;
      console.warn(err);
      setPlaying(false);
      setStatus(
        err.name === "NotAllowedError"
          ? "The browser blocked audio. Press play again."
          : `Couldn't read this sentence aloud (${err.message}).`,
      );
      return;
    }
    if (!isCurrent()) return;
    state.i += 1;
  }
}

function setPlaying(on) {
  state.playing = on;
  els.playBtn.textContent = on ? "❚❚" : "▶";
  els.playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
}

function play() {
  if (state.playing) return;
  // Phones only allow audio that starts from a tap, so unlock it now,
  // before the first sentence has finished generating.
  kokoro?.unlock();
  setPlaying(true);
  playLoop();
}

function stop() {
  setPlaying(false);
  state.playToken++;
  kokoro?.stop();
  device?.stop();
}

function jumpTo(ch, i) {
  const wasPlaying = state.playing;
  stop();
  if (ch !== state.ch) loadChapter(ch, i);
  else setCurrent(Math.min(Math.max(0, i), state.sentences.length - 1), true);
  if (wasPlaying) play();
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.book) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.book.chapters[state.ch]?.title || state.book.title,
    artist: state.book.title,
  });
}

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", stop);
  navigator.mediaSession.setActionHandler("previoustrack", () => jumpTo(state.ch, state.i - 1));
  navigator.mediaSession.setActionHandler("nexttrack", () => jumpTo(state.ch, state.i + 1));
}

// ---------- events ----------

els.fileInput.addEventListener("change", () => {
  const f = els.fileInput.files[0];
  if (f) openFile(f);
  els.fileInput.value = "";
});

els.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("over");
});
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

els.library.addEventListener("click", async (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    await store.deleteBook(remove.dataset.remove);
    renderLibrary();
    return;
  }
  const btn = e.target.closest("[data-id]");
  if (btn) {
    const rec = await store.getBook(btn.dataset.id);
    if (rec) openFile(rec.file, { save: false });
  }
});

els.playBtn.addEventListener("click", () => (state.playing ? stop() : play()));
els.prevBtn.addEventListener("click", () => jumpTo(state.ch, state.i - 1));
els.nextBtn.addEventListener("click", () => jumpTo(state.ch, state.i + 1));

els.page.addEventListener("click", (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) return jumpTo(+goto.dataset.goto, 0);
  const s = e.target.closest(".s");
  if (s && !window.getSelection().toString()) jumpTo(state.ch, +s.dataset.i);
});

function closeToc() {
  document.body.classList.remove("toc-open");
}
els.menuBtn.addEventListener("click", () => document.body.classList.toggle("toc-open"));
els.scrim.addEventListener("click", closeToc);
els.tocList.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ch]");
  if (!b) return;
  closeToc();
  jumpTo(+b.dataset.ch, 0);
});

els.homeBtn.addEventListener("click", showHome);

els.speedSel.value = String(settings.speed);
els.speedSel.addEventListener("change", () => {
  settings.speed = +els.speedSel.value;
  store.saveSettings(settings);
  kokoro?.setRate(settings.speed);
  device?.setRate(settings.speed);
  // Device voices only pick up a new rate on the next sentence; restart this one.
  if (state.playing && engine() === device) jumpTo(state.ch, state.i);
});
device?.setRate(settings.speed);

els.modeSel.value = settings.gpu ? "gpu" : "cpu";
els.modeSel.addEventListener("change", () => {
  settings.gpu = els.modeSel.value === "gpu";
  store.saveSettings(settings);
  const wasPlaying = state.playing;
  stop();
  kokoro?.destroy();
  kokoro = null;
  kokoroFailed = false;
  startKokoro();
  fillVoices();
  if (wasPlaying) play();
});

els.voiceSel.addEventListener("change", () => {
  settings.voice = els.voiceSel.value;
  store.saveSettings(settings);
  const [kind, name] = [settings.voice.split(":")[0], settings.voice.slice(settings.voice.indexOf(":") + 1)];
  if (kind === "kokoro") {
    kokoro?.setVoice(name);
    prefetchAhead();
  }
  else device?.setVoice(name);
  if (state.playing) jumpTo(state.ch, state.i);
});
if (settings.voice.startsWith("device:")) device?.setVoice(settings.voice.slice(7));

document.addEventListener("keydown", (e) => {
  if (!state.book || e.target.closest("select, input")) return;
  if (e.code === "Space") {
    e.preventDefault();
    state.playing ? stop() : play();
  } else if (e.code === "ArrowRight") jumpTo(state.ch, state.i + 1);
  else if (e.code === "ArrowLeft") jumpTo(state.ch, state.i - 1);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

setStatus("");
renderLibrary();
// Start downloading the voice right away so it's ready by the time a book is open.
startKokoro();
fillVoices();
