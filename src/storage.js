// Books are kept in IndexedDB so they reopen without re-uploading.
// Reading position and settings live in localStorage.

const DB_NAME = "book-reader";
const STORE = "books";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export function bookId(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export async function saveBook(file, title) {
  try {
    await tx("readwrite", (s) =>
      s.put({ id: bookId(file), name: file.name, title, file, addedAt: Date.now() }),
    );
  } catch (err) {
    console.warn("Could not save book for later", err);
  }
}

export async function listBooks() {
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return all.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  } catch {
    return [];
  }
}

export async function getBook(id) {
  return tx("readonly", (s) => s.get(id));
}

export async function deleteBook(id) {
  await tx("readwrite", (s) => s.delete(id));
  try { localStorage.removeItem(`progress:${id}`); } catch {}
}

export function loadProgress(id) {
  try {
    return JSON.parse(localStorage.getItem(`progress:${id}`)) || null;
  } catch {
    return null;
  }
}

export function saveProgress(id, progress) {
  try {
    localStorage.setItem(`progress:${id}`, JSON.stringify({ ...progress, at: Date.now() }));
  } catch {}
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("settings")) || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem("settings", JSON.stringify(settings));
  } catch {}
}
