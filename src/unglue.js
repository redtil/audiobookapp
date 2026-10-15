// Puts spaces back into words a PDF ran together ("asiftheMilkyWay" ->
// "as if the Milky Way"). Scanned books with a text layer often store each
// word separately with no space character, and the PDF library sometimes
// misjudges the gaps between them.
//
// It splits a run of letters into the most likely sequence of English words,
// with word likelihood following Zipf's law over a list ordered by frequency
// (public/words-en.txt, from wordninja/wordsninja, MIT). Only text that isn't
// already a word is touched, and only when every piece is a real word.

let dict = null; // word -> cost (lower = more common)
let rank = null; // word -> position in the frequency list
let maxLen = 0;

async function loadDict() {
  if (dict) return;
  const res = await fetch(new URL("words-en.txt", document.baseURI));
  if (!res.ok) throw new Error("word list unavailable");
  const words = (await res.text()).split("\n").filter(Boolean);
  const logN = Math.log(words.length);
  dict = new Map();
  rank = new Map();
  words.forEach((w, i) => {
    dict.set(w, Math.log((i + 1) * logN));
    rank.set(w, i);
    maxLen = Math.max(maxLen, w.length);
  });
}

// Best split of a lowercase string into words. A stretch that isn't a word
// (a misread letter in a scan) is allowed at a high cost, so one typo doesn't
// stop the rest of the run being split. Returns [{ text, known }].
const UNKNOWN_COST = (len) => 18 + 4 * len;

// original: the same text with its capitals, for the lone-"I" rule.
function segment(s, original = s) {
  const best = [0]; // best[i] = cost of the best split of s[0..i)
  const from = [0];
  const known = [true];
  for (let i = 1; i <= s.length; i++) {
    best[i] = Infinity;
    for (let j = Math.max(0, i - maxLen); j < i; j++) {
      const piece = s.slice(j, i);
      let word = dict.get(piece);
      if (word !== undefined && !plausible(piece, original.slice(j, i))) word = undefined;
      const cost = word ?? (i - j >= 3 && i - j <= 15 ? UNKNOWN_COST(i - j) : undefined);
      if (cost !== undefined && best[j] + cost < best[i]) {
        best[i] = best[j] + cost;
        from[i] = j;
        known[i] = word !== undefined;
      }
    }
  }
  const out = [];
  for (let i = s.length; i > 0; i = from[i]) out.unshift({ text: s.slice(from[i], i), known: known[i] });
  return out;
}

const isWord = (w) => dict.has(w.toLowerCase());

// Short pieces are where bad splits hide ("de gar is", "fem to tech"), so
// only trust them when they're common words. A lone "i" must be a capital I.
function plausible(piece, original) {
  if (piece.length === 1) return piece === "a" || original === "I";
  if (piece.length === 2) return rank.get(piece) < 1500;
  if (piece.length <= 4) return rank.get(piece) < 5000;
  return true;
}

// Split one run of letters, keeping its original capitals.
function splitRun(run) {
  if (run.length < 6 || isWord(run)) return run;
  // CamelCase is a strong hint: "MilkyWay" -> "Milky" + "Way".
  const humps = run.split(/(?<=[a-z])(?=[A-Z])/);
  return humps
    .map((part) => {
      if (part.length < 5 || isWord(part)) return part;
      const pieces = segment(part.toLowerCase(), part);
      // Mostly real, everyday words, or leave it alone (OCR noise, names,
      // foreign words): at most one unknown piece, and only in a long run.
      const unknown = pieces.filter((p) => !p.known);
      let at = 0;
      const originals = pieces.map((p) => part.slice(at, (at += p.text.length)));
      // Short runs are often rare words or names ("Cosmists" isn't "Cos mists").
      // A short run that really is glued nearly always holds a little
      // everyday word ("Swiftlythe", "oflife", "hispresent").
      const everyday = (p) => p.known && (p.text === "a" || (p.text.length >= 2 && rank.get(p.text) < 300));
      const ok = pieces.length >= 2 &&
        (part.length >= 12 || (pieces.every((p) => p.known) && pieces.some(everyday))) &&
        part.length / pieces.length >= 2 &&
        (unknown.length === 0 || (unknown.length === 1 && pieces.length >= 4));
      return ok ? originals.join(" ") : part;
    })
    .join(" ");
}

const RUN = /[A-Za-z]{6,}/g;

// How many runs of letters look glued: long and not a word.
function gluedShare(text) {
  let words = 0;
  let glued = 0;
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    words++;
    if (m[0].length >= 15 && !isWord(m[0])) glued++;
  }
  return words ? glued / words : 0;
}

export { loadDict, splitRun };

// Fix a book's chapters in place ({ title, text } each). Books that don't
// show the problem are left exactly as they are.
export async function unglueChapters(chapters) {
  try {
    await loadDict();
  } catch {
    return chapters;
  }
  const all = chapters.map((c) => c.text).join("\n");
  if (gluedShare(all) < 0.002) return chapters;
  for (const c of chapters) {
    c.text = c.text.replace(RUN, (run, at, text) => {
      // "man’sbrainis…": the s belongs to the word before the apostrophe.
      if (/['’]/.test(text[at - 1]) && run[0] === "s" && !isWord(run)) {
        const rest = splitRun(run.slice(1));
        return rest !== run.slice(1) || isWord(rest) ? `s ${rest}` : run;
      }
      return splitRun(run);
    });
    // "pattern,always" and "animals.The": a space after punctuation (but not
    // in "e.g." or "3.5").
    c.text = c.text.replace(/([a-z][,;:!?])(?=[A-Za-z])/g, "$1 ").replace(/([a-z]{2}[.])(?=[A-Z][a-z])/g, "$1 ");
  }
  return chapters;
}
