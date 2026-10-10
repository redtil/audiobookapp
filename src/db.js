// Everything lives on this device in IndexedDB:
//   books: { id, title, voice, chapters: [{ title, paras: [[sentence]] }], total, done, addedAt, openedAt }
//   clips: key [bookId, chapter, sentence] -> Uint8Array of mu-law audio
// The library status and settings live in localStorage.

const DB_NAME = "kokoro-reader";

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("books", { keyPath: "id" });
      req.result.createObjectStore("clips");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = "readonly") {
  return (await db()).transaction(name, mode).objectStore(name);
}

const bookRange = (id) => IDBKeyRange.bound([id, 0, 0], [id, Infinity, Infinity]);
const chapterRange = (id, ch) => IDBKeyRange.bound([id, ch, 0], [id, ch, Infinity]);

export async function putBook(book) {
  await done((await store("books", "readwrite")).put(book));
}

export async function getBook(id) {
  return done((await store("books")).get(id));
}

export async function listBooks() {
  const all = await done((await store("books")).getAll());
  return all.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
}

export async function deleteBook(id) {
  await deleteClips(id);
  await done((await store("books", "readwrite")).delete(id));
}

export async function putClip(id, ch, i, data) {
  await done((await store("clips", "readwrite")).put(data, [id, ch, i]));
}

// Save a whole chapter's clips in one go (used when importing).
export async function putClips(id, ch, clips) {
  const t = (await db()).transaction("clips", "readwrite");
  const s = t.objectStore("clips");
  clips.forEach((data, i) => s.put(data, [id, ch, i]));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Saving was cancelled (the device may be out of space)."));
  });
}

export async function countClips(id) {
  return done((await store("clips")).count(bookRange(id)));
}

// Keys of the clips already made, as a Set of "ch:i".
export async function clipKeys(id) {
  const keys = await done((await store("clips")).getAllKeys(bookRange(id)));
  return new Set(keys.map(([, ch, i]) => `${ch}:${i}`));
}

// All clips of one chapter, in reading order.
export async function chapterClips(id, ch) {
  return done((await store("clips")).getAll(chapterRange(id, ch)));
}

export async function deleteClips(id) {
  await done((await store("clips", "readwrite")).delete(bookRange(id)));
}

// The library: each book's position and status, shared with other devices
// when sync is on (see sync.js).
export function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem("kr-library")) || { books: {} };
  } catch {
    return { books: {} };
  }
}

export function saveLibrary(lib) {
  try {
    localStorage.setItem("kr-library", JSON.stringify(lib));
  } catch {}
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("kr-settings")) || {};
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem("kr-settings", JSON.stringify(s));
  } catch {}
}

// Ask the browser not to clear our storage when space runs low.
export async function persist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}
