// How a book's chapters are shared between the server's machines. Used by
// the server to split the work, and by the app to estimate how long it takes.

// GitHub's free plan runs about 15 jobs at once (shared by all books being
// prepared); more parts than that would only wait in line.
export const MAX_PARTS = 15;
// Measured on GitHub's machines: Kokoro makes speech 2.1–2.2× faster than
// real time, and speech is about 14 characters a second.
const CHARS_PER_SECOND_PER_MACHINE = 28;
const STARTUP_SECONDS = 120; // queueing, installing, loading the voice

// Split chapters into groups of about equal size: biggest first, each into
// the lightest group so far. sizes[ch] = characters in chapter ch. Machines
// are free, so every chapter gets its own while there are enough of them;
// perPart (characters per machine) can cap that, which tests use.
export function planParts(sizes, todo, perPart) {
  const total = todo.reduce((n, ch) => n + sizes[ch], 0);
  const wanted = perPart ? Math.ceil(total / perPart) : Infinity;
  const count = Math.max(1, Math.min(MAX_PARTS, todo.length, wanted));
  const parts = Array.from({ length: count }, () => ({ chars: 0, chapters: [] }));
  for (const ch of [...todo].sort((a, b) => sizes[b] - sizes[a])) {
    const lightest = parts.reduce((a, b) => (b.chars < a.chars ? b : a));
    lightest.chapters.push(ch);
    lightest.chars += sizes[ch];
  }
  return parts;
}

// Seconds until the slowest machine is done, from pressing Prepare
// (startup: true) or for work already under way.
export function estimateSeconds(sizes, todo, { startup = true } = {}) {
  if (!todo.length) return 0;
  const slowest = Math.max(...planParts(sizes, todo).map((p) => p.chars));
  return (startup ? STARTUP_SECONDS : 0) + slowest / CHARS_PER_SECOND_PER_MACHINE;
}
