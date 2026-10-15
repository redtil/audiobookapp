// The library service. Behind the scenes it's two GitHub repositories:
//   the app's own (public) repository, whose "Prepare" workflow makes audio
//   on GitHub's machines, and a private library repository holding:
//     main: library.json (status of every book), books/<id>.json (text)
//     audio/<id>/<part> branches: <chapter>.mp3 + <chapter>.json (timings)
// The rest of the app only sees books, chapters and statuses.

const API = "https://api.github.com";

export class Library {
  constructor({ key, appRepo, dataRepo }) {
    this.key = key;
    this.appRepo = appRepo;
    this.dataRepo = dataRepo;
  }

  async call(path, { raw = false, body, method = body ? "POST" : "GET", ok404 = false } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.key}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && ok404) return null;
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch {}
      const err = new Error(
        res.status === 401 ? "The library key isn't valid (it may have expired)."
          : res.status === 403 || res.status === 404 ? "The library key doesn't have access to the library."
          : `The library didn't respond properly (${res.status}${detail ? `: ${detail}` : ""}).`,
      );
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return raw ? res : res.json();
  }

  // Checks the key can reach both repositories.
  async check() {
    await this.call(`/repos/${this.dataRepo}`);
    await this.call(`/repos/${this.appRepo}/actions/workflows/prepare.yml`);
  }

  // ---------- library.json ----------

  async readLibrary() {
    const file = await this.call(`/repos/${this.dataRepo}/contents/library.json`, { ok404: true });
    if (!file) return { data: { books: {} }, sha: null };
    return { data: JSON.parse(fromBase64(file.content)), sha: file.sha };
  }

  // Merge our copy into the stored one and return the result. Retries when
  // another device wrote in between.
  async syncLibrary(local) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await this.readLibrary();
      const merged = mergeLibraries(data, local);
      if (JSON.stringify(merged) === JSON.stringify(data)) return merged;
      try {
        await this.putFile("library.json", JSON.stringify(merged, null, 1), sha, "Update library");
        return merged;
      } catch (err) {
        if (err.status !== 409 && err.status !== 422) throw err;
      }
    }
    throw new Error("The library is busy. Try again in a moment.");
  }

  async putFile(path, text, sha, message) {
    return this.call(`/repos/${this.dataRepo}/contents/${path}`, {
      method: "PUT",
      body: { message, content: toBase64(text), ...(sha ? { sha } : {}) },
    });
  }

  // ---------- books ----------

  async uploadBook(book) {
    const path = `books/${book.id}.json`;
    const existing = await this.call(`/repos/${this.dataRepo}/contents/${path}`, { ok404: true });
    if (existing) return;
    try {
      await this.putFile(path, JSON.stringify(book), null, "Add a book");
    } catch (err) {
      if (err.status !== 422) throw err; // another device added it first
    }
  }

  async downloadBook(id) {
    const res = await this.call(`/repos/${this.dataRepo}/contents/books/${id}.json`, { raw: true });
    return res.json();
  }

  async deleteBook(id) {
    await this.deleteAudio(id);
    const file = await this.call(`/repos/${this.dataRepo}/contents/books/${id}.json`, { ok404: true });
    if (file) {
      await this.call(`/repos/${this.dataRepo}/contents/books/${id}.json`, {
        method: "DELETE",
        body: { message: "Remove a book", sha: file.sha },
      });
    }
  }

  // ---------- audio ----------

  // Everything made for a book so far:
  //   chapters: { [chapter]: { mp3: sha, json: sha } }
  //   moods: sha of moods.json, music: { [mood]: sha of its MP3 }
  async audioAll(id) {
    const refs = (await this.call(`/repos/${this.dataRepo}/git/matching-refs/heads/audio/${id}/`)) || [];
    const chapters = {};
    const music = {};
    let moods = null;
    const trees = await Promise.all(refs.map((r) => this.call(`/repos/${this.dataRepo}/git/trees/${r.object.sha}`)));
    for (const tree of trees) {
      for (const f of tree.tree) {
        let m;
        if ((m = f.path.match(/^(\d+)\.(mp3|json)$/))) (chapters[+m[1]] ??= {})[m[2]] = f.sha;
        else if ((m = f.path.match(/^music-(\w+)\.mp3$/))) music[m[1]] = f.sha;
        else if (f.path === "moods.json") moods = f.sha;
      }
    }
    for (const ch of Object.keys(chapters)) if (!chapters[ch].mp3 || !chapters[ch].json) delete chapters[ch];
    return { chapters, moods, music };
  }

  // { [chapter]: { mp3: sha, json: sha } } for every chapter made so far.
  async audioIndex(id) {
    return (await this.audioAll(id)).chapters;
  }

  async blob(sha) {
    return (await this.call(`/repos/${this.dataRepo}/git/blobs/${sha}`, { raw: true })).blob();
  }

  async deleteAudio(id) {
    const refs = (await this.call(`/repos/${this.dataRepo}/git/matching-refs/heads/audio/${id}/`)) || [];
    for (const r of refs) {
      await this.call(`/repos/${this.dataRepo}/git/${r.ref}`, { method: "DELETE", ok404: true });
    }
  }

  // ---------- preparing ----------

  async startPreparing(id, voice) {
    await this.call(`/repos/${this.appRepo}/actions/workflows/prepare.yml/dispatches`, {
      body: { ref: "main", inputs: { book: id, voice, library: this.dataRepo, music: "yes" } },
    });
  }

  // Preparation runs for this book that haven't finished, newest first.
  async activeRuns(id) {
    const { workflow_runs: runs } = await this.call(
      `/repos/${this.appRepo}/actions/workflows/prepare.yml/runs?per_page=30`,
    );
    return runs.filter((r) => r.display_title === `Prepare ${id}` && r.status !== "completed");
  }

  // The latest run for each book: { [id]: run }.
  async latestRuns() {
    const { workflow_runs: runs } = await this.call(
      `/repos/${this.appRepo}/actions/workflows/prepare.yml/runs?per_page=50`,
    );
    const out = {};
    for (const r of runs) {
      const id = r.display_title.replace(/^Prepare /, "");
      if (!out[id]) out[id] = r;
    }
    return out;
  }

  async pause(id) {
    for (const r of await this.activeRuns(id)) {
      await this.call(`/repos/${this.appRepo}/actions/runs/${r.id}/cancel`, { method: "POST", ok404: true }).catch(() => {});
    }
  }
}

// ---------- merging (pure) ----------
// Entry: { id, title, chapters, total, chars, addedAt, deletedAt,
//          voice, ready, seconds, audioAt, startedAt, eta: { at, seconds },
//          pos: { ch, i, at }, finished, finishedAt }

const newer = (a, b, key) => ((a?.[key] || 0) >= (b?.[key] || 0) ? a : b);

function mergeEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = newer(a, b, "addedAt");
  const pos = newer(a.pos, b.pos, "at");
  const fin = newer(a, b, "finishedAt");
  const audio = newer(a, b, "audioAt");
  return {
    ...base,
    pos,
    finished: fin.finished,
    finishedAt: fin.finishedAt,
    voice: audio.voice,
    ready: audio.ready,
    seconds: audio.seconds,
    audioAt: audio.audioAt,
    eta: audio.eta,
    startedAt: audio.startedAt,
    deletedAt: Math.max(a.deletedAt || 0, b.deletedAt || 0) || undefined,
  };
}

export function mergeLibraries(a, b) {
  const books = { ...a.books };
  for (const [id, e] of Object.entries(b.books || {})) books[id] = mergeEntry(books[id], e);
  return { books };
}

export const isRemoved = (e) => !!e.deletedAt && e.deletedAt > (e.addedAt || 0);

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
