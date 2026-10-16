// Access to the private library repository from the server jobs.
//   main: library.json, books/<id>.json (the text, split into sentences)
//   branches audio/<id>/...: a book's audio, one branch per job so jobs
//   never get in each other's way
// These jobs run in a public repository, so they never log a book's title or text.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LIBRARY_KEY, DATA_REPO, BOOK } = process.env;
const API = process.env.GITHUB_API || "https://api.github.com";

// Retries network hiccups and busy-server replies, so one dropped
// connection doesn't fail a whole job.
export async function api(path, { raw = false, ...opts } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${LIBRARY_KEY}`,
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...opts.headers,
        },
      });
    } catch (err) {
      if (attempt >= 6) throw err;
      console.warn(`${opts.method || "GET"} ${path.split("?")[0]}: ${err.message}, trying again`);
      res = null;
    }
    if (res?.status === 404 || res?.status === 204) return null;
    if (res?.ok) return raw ? res : res.json();
    if (res && res.status !== 429 && res.status < 500) {
      throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
    }
    if (res && attempt >= 6) throw new Error(`${opts.method || "GET"} ${path.split("?")[0]} failed: ${res.status}`);
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * 2 ** attempt)));
  }
}

export async function readBook() {
  const res = await api(`/repos/${DATA_REPO}/contents/books/${BOOK}.json`, { raw: true });
  if (!res) throw new Error("This book isn't in the library.");
  return res.json();
}

// Every file on this book's audio branches: { name: blobSha }.
export async function audioFiles() {
  const refs = (await api(`/repos/${DATA_REPO}/git/matching-refs/heads/audio/${BOOK}/`)) || [];
  const files = {};
  for (const ref of refs) {
    const tree = await api(`/repos/${DATA_REPO}/git/trees/${ref.object.sha}`);
    for (const f of tree?.tree || []) files[f.path] = f.sha;
  }
  return files;
}

// This book's audio branches, each with the names of its files.
export async function audioBranches() {
  const refs = (await api(`/repos/${DATA_REPO}/git/matching-refs/heads/audio/${BOOK}/`)) || [];
  return Promise.all(refs.map(async (ref) => ({
    ref: ref.ref,
    files: ((await api(`/repos/${DATA_REPO}/git/trees/${ref.object.sha}`))?.tree || []).map((f) => f.path),
  })));
}

export async function deleteBranch(ref) {
  await api(`/repos/${DATA_REPO}/git/${ref}`, { method: "DELETE" });
}

export async function readBlob(sha) {
  // The download itself can drop part-way, so that's retried too.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await api(`/repos/${DATA_REPO}/git/blobs/${sha}`, { raw: true });
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 4) throw err;
      console.warn(`download: ${err.message}, trying again`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// Changes this book's entry in library.json (merged with whatever another
// device wrote in between).
export async function updateLibraryEntry(fields) {
  for (let attempt = 1; ; attempt++) {
    const file = await api(`/repos/${DATA_REPO}/contents/library.json`);
    if (!file) return;
    const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    if (!data.books?.[BOOK]) return;
    Object.assign(data.books[BOOK], fields);
    try {
      await api(`/repos/${DATA_REPO}/contents/library.json`, {
        method: "PUT",
        body: JSON.stringify({ message: "Update library", sha: file.sha,
          content: Buffer.from(JSON.stringify(data, null, 1)).toString("base64") }),
      });
      return;
    } catch (err) {
      if (attempt >= 5 || !/ (409|422) /.test(err.message)) throw err;
    }
  }
}

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A branch this job owns. save() adds files and pushes straight away, so
// work survives a pause.
export function ownBranch(name) {
  const dir = mkdtempSync(join(tmpdir(), "audio-"));
  git(dir, "init", "-q", "-b", "audio");
  git(dir, "config", "user.name", "Kokoro Reader");
  git(dir, "config", "user.email", "reader@users.noreply.github.com");
  git(dir, "remote", "add", "origin", process.env.DATA_REMOTE || `https://x-access-token:${LIBRARY_KEY}@github.com/${DATA_REPO}.git`);
  const branch = `audio/${BOOK}/${name}`;
  return {
    async save(files, message) {
      for (const [file, data] of Object.entries(files)) writeFileSync(join(dir, file), data);
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", message);
      for (let attempt = 1; ; attempt++) {
        try {
          git(dir, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
          return;
        } catch (err) {
          if (attempt >= 5) throw err;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    },
  };
}

export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}
