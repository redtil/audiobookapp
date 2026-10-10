// Shares the library between devices through a private GitHub repository
// the user owns, using a fine-grained access token limited to that repo.
//   library.json      every book's status: where you are, finished, and
//                     how far each device has got with its audio
//   books/<id>.json   the book's text, so other devices can show and
//                     prepare it without the original file
// Audio is not synced: it's far too large for a git repository.

const API = "https://api.github.com";

export function syncConfig(settings) {
  const s = settings.sync;
  return s?.repo && s?.token ? s : null;
}

function headers(cfg, accept = "application/vnd.github+json") {
  return { Authorization: `Bearer ${cfg.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
}

function url(cfg, path) {
  return `${API}/repos/${cfg.repo}/contents/${path}`;
}

async function failure(res) {
  let msg = `GitHub said ${res.status}`;
  try {
    msg += `: ${(await res.json()).message}`;
  } catch {}
  if (res.status === 401) msg = "GitHub didn't accept the token. Check it hasn't expired.";
  if (res.status === 404) msg = "Couldn't find that repository. Check the name and that the token can access it.";
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function readLibrary(cfg) {
  const res = await fetch(url(cfg, "library.json"), { headers: headers(cfg), cache: "no-store" });
  if (res.status === 404) {
    // Tell a missing repo apart from a repo without the file yet.
    const repo = await fetch(`${API}/repos/${cfg.repo}`, { headers: headers(cfg) });
    if (!repo.ok) throw await failure(repo);
    return { data: { books: {} }, sha: null };
  }
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  return { data: JSON.parse(fromBase64(body.content)), sha: body.sha };
}

async function writeFile(cfg, path, text, sha, message) {
  const res = await fetch(url(cfg, path), {
    method: "PUT",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: toBase64(text), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw await failure(res);
}

// ---------- merging ----------
// Entry: { id, title, chapters, total, chars, addedAt,
//          pos: { ch, i, at }, finished, finishedAt,
//          devices: { [deviceId]: { name, voice, done, ready, at } },
//          deletedAt }

const newer = (a, b, key) => ((a?.[key] || 0) >= (b?.[key] || 0) ? a : b);

function mergeEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = newer(a, b, "addedAt");
  const pos = newer(a.pos, b.pos, "at");
  const fin = newer(a, b, "finishedAt");
  const devices = { ...a.devices };
  for (const [id, d] of Object.entries(b.devices || {})) devices[id] = newer(devices[id], d, "at");
  const deletedAt = Math.max(a.deletedAt || 0, b.deletedAt || 0) || undefined;
  return { ...base, pos, finished: fin.finished, finishedAt: fin.finishedAt, devices, deletedAt };
}

export function mergeLibraries(a, b) {
  const books = { ...a.books };
  for (const [id, e] of Object.entries(b.books || {})) books[id] = mergeEntry(books[id], e);
  return { books };
}

// A book counts as removed when it was deleted after it was last added.
export function isRemoved(entry) {
  return !!entry.deletedAt && entry.deletedAt > (entry.addedAt || 0);
}

// ---------- public ----------

// Merge our library into the shared one and bring the result back.
export async function syncLibrary(cfg, local) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, sha } = await readLibrary(cfg);
    const merged = mergeLibraries(data, local);
    if (JSON.stringify(merged) === JSON.stringify(data)) return merged;
    try {
      await writeFile(cfg, "library.json", JSON.stringify(merged, null, 1), sha, "Update library");
      return merged;
    } catch (err) {
      // Another device wrote at the same moment: read again and re-merge.
      if (err.status !== 409 && err.status !== 422) throw err;
    }
  }
  throw new Error("The library kept changing on another device. Try again in a moment.");
}

export async function uploadBookText(cfg, book) {
  const path = `books/${book.id}.json`;
  const head = await fetch(url(cfg, path), { method: "HEAD", headers: headers(cfg), cache: "no-store" });
  if (head.ok) return;
  const { id, title, chapters, total, chars } = book;
  try {
    await writeFile(cfg, path, JSON.stringify({ id, title, chapters, total, chars }), null, `Add ${title}`);
  } catch (err) {
    if (err.status !== 422) throw err; // 422: another device added it first
  }
}

export async function downloadBookText(cfg, id) {
  const res = await fetch(url(cfg, `books/${id}.json`), {
    headers: headers(cfg, "application/vnd.github.raw+json"),
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export function deviceInfo(settings) {
  if (!settings.deviceId) {
    settings.deviceId = Math.random().toString(36).slice(2, 10);
    const ua = navigator.userAgent;
    settings.deviceName = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
      : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux PC" : "This device";
  }
  return { id: settings.deviceId, name: settings.deviceName };
}
