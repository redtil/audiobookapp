// What the device keeps for itself: settings, a copy of the library status,
// and the books' text (so they open quickly and offline). The library itself
// lives on the server; audio is cached separately (see player.js).

const DB_NAME = "kokoro-reader-v2";

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "id" });
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

async function store(mode = "readonly") {
  return (await db()).transaction("books", mode).objectStore("books");
}

export async function putBook(book) {
  try {
    await done((await store("readwrite")).put(book));
  } catch {}
}

export async function getBook(id) {
  try {
    return await done((await store()).get(id));
  } catch {
    return null;
  }
}

export async function deleteBook(id) {
  try {
    await done((await store("readwrite")).delete(id));
  } catch {}
}

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const loadSettings = () => load("kr2-settings", {});
export const saveSettings = (s) => save("kr2-settings", s);
export const loadLibrary = () => load("kr2-library", { books: {} });
export const saveLibrary = (l) => save("kr2-library", l);
