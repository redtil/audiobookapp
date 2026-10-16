import JSZip from "jszip";
import { unglueChapters } from "./unglue.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Turns a PDF or EPUB into { title, chapters: [{ title, paras: [[sentence]] }] }.
// Sentences are split once here and saved with the book, so the audio made
// for sentence N always matches the text shown for sentence N.

export async function readBook(file) {
  const name = file.name.toLowerCase();
  let raw;
  if (name.endsWith(".epub")) raw = await readEpub(file);
  else if (name.endsWith(".pdf")) {
    raw = await readPdf(file);
    await unglueChapters(raw.chapters);
  }
  else throw new Error("Please choose a PDF or EPUB file.");

  const chapters = raw.chapters
    .map((c) => ({ title: c.title, paras: splitSentences(c.text) }))
    .filter((c) => c.paras.length);
  if (!chapters.length) throw new Error("No readable text was found in this book.");
  return { title: raw.title, chapters };
}

// Named by its content, so the same book opened on two devices matches.
export async function bookIdFor(file) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...hash.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- EPUB ----------

function joinPath(base, rel) {
  const parts = base.split("/").slice(0, -1);
  for (const seg of decodeURIComponent(rel.split("#")[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const BLOCKS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "section",
  "article", "tr", "br", "pre", "dd", "dt", "figcaption", "header", "footer", "aside",
]);

function docText(doc) {
  doc.querySelectorAll("script, style, rt, sup a[href], nav").forEach((n) => n.remove());
  const out = [];
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out.push(n.nodeValue);
      else if (n.nodeType === 1) {
        const block = BLOCKS.has(n.localName?.toLowerCase());
        if (block) out.push("\n\n");
        walk(n);
        if (block) out.push("\n\n");
      }
    }
  };
  if (doc.body) walk(doc.body);
  return tidy(out.join(""), true);
}

async function readEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const text = (p) => zip.file(p)?.async("string");
  const xml = (s, type = "application/xml") => new DOMParser().parseFromString(s, type);

  const container = xml(await text("META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("This EPUB looks damaged (no package file).");
  const opf = xml(await text(opfPath));

  const title = opf.getElementsByTagName("dc:title")[0]?.textContent.trim() || file.name.replace(/\.epub$/i, "");
  const items = {};
  for (const it of opf.getElementsByTagName("item")) {
    items[it.getAttribute("id")] = {
      href: joinPath(opfPath, it.getAttribute("href")),
      type: it.getAttribute("media-type") || "",
      props: it.getAttribute("properties") || "",
    };
  }
  const tocNames = await epubToc(zip, opf, items, xml);

  const chapters = [];
  for (const ref of opf.getElementsByTagName("itemref")) {
    const it = items[ref.getAttribute("idref")];
    if (!it || !it.type.includes("html") || it.props.includes("nav")) continue;
    const src = await text(it.href);
    if (!src) continue;
    let doc = xml(src, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) doc = xml(src, "text/html");
    const heading = doc.querySelector("h1, h2, h3")?.textContent.trim();
    const body = docText(doc);
    if (body.length < 2) continue;
    chapters.push({ title: tocNames[it.href] || heading || `Part ${chapters.length + 1}`, text: body });
  }
  return { title, chapters };
}

async function epubToc(zip, opf, items, xml) {
  const names = {};
  try {
    const nav = Object.values(items).find((m) => m.props.includes("nav"));
    if (nav) {
      const doc = xml(await zip.file(nav.href).async("string"), "text/html");
      for (const a of doc.querySelectorAll("nav a[href]")) {
        const href = joinPath(nav.href, a.getAttribute("href"));
        names[href] ??= a.textContent.trim();
      }
      return names;
    }
    const ncx = items[opf.getElementsByTagName("spine")[0]?.getAttribute("toc")];
    if (ncx) {
      const doc = xml(await zip.file(ncx.href).async("string"));
      for (const np of doc.getElementsByTagName("navPoint")) {
        const label = np.getElementsByTagName("text")[0]?.textContent.trim();
        const src = np.getElementsByTagName("content")[0]?.getAttribute("src");
        if (label && src) names[joinPath(ncx.href, src)] ??= label;
      }
    }
  } catch {
    // No usable table of contents: chapter names fall back to headings.
  }
  return names;
}

// ---------- PDF ----------

// A page's text as lines: { text, size, x, end, y, pos } where pos is how far
// down the page the line sits (0 top, 1 bottom). Small raised numbers
// (footnote markers) are left out.
async function pdfPageLines(page) {
  const { items } = await page.getTextContent();
  const [, bottom, , top] = page.view;
  const lines = [];
  let cur = null;
  let last = null; // { end, charWidth } of the previous piece on this line
  for (const it of items) {
    if (!("str" in it) || !it.str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 12;
    const charWidth = it.width / Math.max(1, it.str.length);
    const dy = cur ? Math.abs(y - cur.y) : Infinity;
    // Smaller text slightly above or below the line: a superscript.
    const raised = cur && size < 0.8 * cur.size && dy > 1 && dy < 0.7 * cur.size;
    if (raised) {
      if (/^[\s\d*†‡§¶,\-–]+$/.test(it.str)) continue; // a footnote marker
    } else if (!cur || dy > Math.max(2, 0.4 * Math.min(size, cur.size))) {
      cur = { text: "", size, sizes: {}, x, end: x, y, pos: 1 - (y - bottom) / Math.max(1, top - bottom) };
      lines.push(cur);
      last = null;
    }
    if (!it.str.trim()) {
      if (cur.text && !/\s$/.test(cur.text)) cur.text += " ";
      continue;
    }
    if (last && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
      // Many PDFs (scanned books with a text layer especially) place each
      // word separately without a space character: the gap is the space.
      // A gap of a third of a letter or more (or jumping back) is a word break.
      const gap = x - last.end;
      if (gap > 0.3 * Math.min(charWidth, last.charWidth) || gap < -charWidth) cur.text += " ";
    }
    cur.text += it.str;
    if (!raised) {
      const k = Math.round(size * 2) / 2;
      cur.sizes[k] = (cur.sizes[k] || 0) + it.str.length;
      cur.x = Math.min(cur.x, x);
    }
    cur.end = Math.max(cur.end, x + it.width);
    last = { end: x + it.width, charWidth };
  }
  for (const l of lines) {
    // The line's size is the size most of its letters have.
    // The line's size: the middle size of its letters (scans give each word
    // its own size, so it wobbles from word to word).
    const sizes = Object.entries(l.sizes).map(([k, n]) => [+k, n]).sort((a, b) => a[0] - b[0]);
    const half = sizes.reduce((n, [, c]) => n + c, 0) / 2;
    let seen = 0;
    l.size = sizes.find(([, c]) => (seen += c) >= half)?.[0] || l.size;
    l.text = cleanOcr(l.text);
  }
  return lines.filter((l) => l.text);
}

// Specks a scan's text recognition turns into symbols: « • * ■ and the like.
const JUNK = /[«»•·■□▪◆●○©®™¬\\^~|¦¤]/g;
function cleanOcr(text) {
  return text
    .split(/\s+/)
    .map((w) => (/[\p{L}\p{N}]/u.test(w.replace(JUNK, "")) ? w.replace(JUNK, "").replace(/\*+$|^\*+/g, "") : ""))
    .filter(Boolean)
    .join(" ");
}

// Lines that aren't the book: a scanning service's notice and web links.
const NOT_THE_BOOK = /^(digitized by\b|https?:\/\/|www\.)\S*/i;

const mostCommon = (values) => {
  const counts = new Map();
  for (const [v, w] of values) counts.set(v, (counts.get(v) || 0) + w);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const percentile = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0);
const median = (xs) => percentile(xs, 0.5);

// What ordinary text looks like in this book: its size, line spacing, left
// edge and right edge.
function bodyLayout(pages) {
  const all = pages.flat();
  const size = mostCommon(all.map((l) => [l.size, l.text.length])) || 12;
  const body = (l) => Math.abs(l.size - size) < 0.6;
  const gaps = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i - 1].y - lines[i].y;
      if (body(lines[i]) && body(lines[i - 1]) && gap > 0 && gap < 4 * size) gaps.push(gap);
    }
  }
  const bodyLines = all.filter(body);
  return {
    size,
    body,
    gap: median(gaps) || size * 1.2,
    left: mostCommon(bodyLines.map((l) => [Math.round(l.x), 1])) ?? 0,
    right: percentile(bodyLines.map((l) => l.end), 0.9) || 0,
  };
}

const PAGE_NUMBER = /^(page\s+)?[-–—(\[]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[-–—)\]]?$/i;

// Leaves out what isn't the book's text: page numbers, footnotes at the foot
// of the page (smaller than the text), and running headers and footers.
function dropPageFurniture(pages, layout) {
  pages = pages.map((lines) => {
    lines = lines.filter((l, i) =>
      !((l.pos < 0.12 || l.pos > 0.86 || i === 0 || i === lines.length - 1) && PAGE_NUMBER.test(l.text)));
    // Specks left over from a scan: a letter or two on their own, in the margin.
    lines = lines.filter((l) => !(l.text.replace(/[^\p{L}\p{N}]/gu, "").length <= 2 && !/^(I|a|A)$/.test(l.text)));
    // A scanning service's notice ("Digitized by ... https://...").
    const notice = lines.findIndex((l) => /^digitized by\b/i.test(l.text));
    const link = lines.findIndex((l, i) => i >= notice && /^https?:\/\//i.test(l.text));
    if (notice >= 0 && link >= notice && link - notice < 5) lines.splice(notice, link - notice + 1);
    lines = lines.filter((l) => !NOT_THE_BOOK.test(l.text) || l.text.split(" ").length > 3);
    // A running header with the page number in it, like "12 The Animal-Machine":
    // short, at the top, starting or ending with a number.
    const head = lines[0];
    if (head && head.pos < 0.15 && /^\d{1,4}\s+\S|\S\s+\d{1,4}$/.test(head.text) && head.text.length < 70 &&
        !ENDS_SENTENCE.test(head.text.replace(/\s*\d+$/, ""))) lines = lines.slice(1);
    // Footnotes: the smaller lines at the bottom, below the last line of text.
    let cut = lines.length;
    while (cut > 0 && lines[cut - 1].pos > 0.45 && lines[cut - 1].size < layout.size * 0.88) cut--;
    return lines.slice(0, cut);
  });
  // Lines repeating near the top or bottom of many pages (odd and even pages
  // often differ, so each are counted on their own).
  const key = (l) => l.text.replace(/\d+/g, "#").toLowerCase();
  const edges = (lines) => [...lines.slice(0, 2), ...lines.slice(-2)].filter((l) =>
    l.pos < 0.12 || l.pos > 0.88 || ((l === lines[0] || l === lines.at(-1)) && !ENDS_SENTENCE.test(l.text)));
  const counts = [new Map(), new Map(), new Map()]; // even pages, odd pages, all
  pages.forEach((lines, n) => {
    for (const k of new Set(edges(lines).map(key))) {
      for (const c of [counts[n % 2], counts[2]]) c.set(k, (c.get(k) || 0) + 1);
    }
  });
  // Each chapter often has its own running header, so also count nearby pages.
  const nearby = (k, n) => {
    let c = 0;
    for (let m = Math.max(0, n - 8); m <= Math.min(pages.length - 1, n + 8); m++) if (edgeKeys[m].has(k)) c++;
    return c;
  };
  const edgeKeys = pages.map((lines) => new Set(edges(lines).map(key)));
  const repeats = (k, n) =>
    counts[2].get(k) >= Math.max(3, pages.length * 0.4) || counts[n % 2].get(k) >= Math.max(2, (pages.length / 2) * 0.5) ||
    nearby(k, n) >= 3;
  return pages.map((lines, n) => {
    const edge = new Set(edges(lines));
    return lines.filter((l) => !(edge.has(l) && repeats(key(l), n)));
  });
}

const ENDS_SENTENCE = /[.!?…:;"”’)\]]$/;

// Whether line b starts a new paragraph after line a.
function newParagraph(a, b, layout, samePage) {
  const startsLower = /^[\p{Ll}]/u.test(b.text);
  if (/\p{L}[-‐]$/u.test(a.text) && startsLower) return false; // a word split over two lines
  const ratio = b.size / a.size;
  if (!ENDS_SENTENCE.test(a.text) && startsLower && ratio > 0.8 && ratio < 1.25) return false; // mid-sentence
  const heading = (l) => l.size > layout.size * 1.25;
  if (heading(a) !== heading(b) || (heading(a) && heading(b) && samePage && a.y - b.y > a.size * 1.8)) return true;
  if (samePage && a.y - b.y > layout.gap * 1.45) return true; // a gap between paragraphs
  const short = (l) => layout.right && l.end < layout.right - layout.size * 3;
  if (ENDS_SENTENCE.test(a.text) && short(b) && !ENDS_SENTENCE.test(b.text)) return true; // a heading
  if (b.x > layout.left + layout.size * 0.8 && b.x < layout.left + layout.size * 8) return true; // indented
  if (short(a)) return true; // the line before stopped short
  return false;
}

// Lines from..to as text, paragraphs separated by blank lines.
function linesText(flat, from, to, layout) {
  let text = "";
  for (let i = from; i < to; i++) {
    const l = flat[i];
    if (i > from) text += newParagraph(flat[i - 1], l, layout, flat[i - 1].page === l.page) ? "\n\n" : "\n";
    text += l.text;
  }
  return text;
}

async function readPdf(file) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, "");

  let pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(await pdfPageLines(await pdf.getPage(n)));
  if (!pages.flat().length) {
    throw new Error("This PDF has no text layer (it's probably scanned pages), so it can't be read aloud.");
  }
  const layout = bodyLayout(pages);
  pages = dropPageFurniture(pages, layout);
  // Every line of the book in order, and where each page's lines begin.
  const flat = pages.flatMap((lines, page) => lines.map((l) => ({ ...l, page })));
  const pageStart = [];
  pages.reduce((at, lines, n) => ((pageStart[n] = at), at + lines.length), 0);
  pageStart.push(flat.length);

  // Chapters from the PDF's bookmarks; a bookmark usually points at a spot
  // on the page, so a chapter can start halfway down one.
  let marks = [];
  try {
    for (const entry of (await pdf.getOutline()) || []) {
      let dest = entry.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const page = await pdf.getPageIndex(dest[0]);
      const top = dest[1]?.name === "XYZ" && typeof dest[3] === "number" ? dest[3] : null;
      const lines = pages[page] || [];
      const k = top == null ? 0 : lines.findIndex((l) => l.y <= top + 2);
      marks.push({ title: entry.title.trim(), at: pageStart[page] + (k < 0 ? lines.length : k) });
    }
  } catch {
    marks = [];
  }
  marks = marks.filter((m, i, a) => i === 0 || m.at > a[i - 1].at);

  const chapters = [];
  if (marks.length >= 2) {
    if (marks[0].at > 0) marks.unshift({ title: "Opening pages", at: 0 });
    marks.forEach((m, i) => {
      chapters.push({ title: m.title, text: tidy(linesText(flat, m.at, marks[i + 1]?.at ?? flat.length, layout)) });
    });
  } else {
    const per = 10;
    for (let p = 0; p < pages.length; p += per) {
      const end = Math.min(p + per, pages.length);
      chapters.push({ title: `Pages ${p + 1}–${end}`, text: tidy(linesText(flat, pageStart[p], pageStart[end], layout)) });
    }
  }
  return { title, chapters };
}

// ---------- text ----------

function tidy(raw, html = false) {
  let t = raw.replace(/­/g, "").replace(/\r/g, "");
  if (!html) t = t.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2"); // re-join words hyphenated across lines
  return t
    .replace(/[ \t ]+/g, " ")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p) && (html || !PAGE_NUMBER.test(p)))
    .join("\n\n");
}

const MAX = 240;

export function splitSentences(text) {
  const seg = globalThis.Intl?.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
  return text
    .split("\n\n")
    .map((para) => {
      const parts = seg
        ? [...seg.segment(para)].map((s) => s.segment)
        : para.match(/[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g) || [para];
      const out = [];
      for (const s of mergeAbbreviations(parts)) {
        if (!s.trim()) continue;
        out.push(...(s.length > MAX ? splitLong(s) : [s]));
      }
      return out;
    })
    .filter((p) => p.length);
}

// The segmenter breaks after "Mr." and "Dr."; glue those back on.
function mergeAbbreviations(parts) {
  const out = [];
  for (const p of parts) {
    if (out.length && /\b(Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|etc|e\.g|i\.e)\.\s*$/i.test(out[out.length - 1])) {
      out[out.length - 1] += p;
    } else out.push(p);
  }
  return out;
}

function splitLong(s) {
  const out = [];
  let cur = "";
  for (const piece of s.split(/(?<=[,;:—])\s+/)) {
    if (cur && (cur + " " + piece).length > 180) {
      out.push(cur + " ");
      cur = piece;
    } else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length > MAX ? c.match(/.{1,180}(\s|$)|.{1,180}/g) : [c]));
}
