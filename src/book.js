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

async function pdfPageText(page) {
  const { items } = await page.getTextContent();
  let out = "";
  let last = null; // { y, end, charWidth } of the previous piece of text
  for (const it of items) {
    if (!("str" in it) || !it.str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const charWidth = it.width / Math.max(1, it.str.length);
    if (last && Math.abs(y - last.y) > 2) {
      const size = it.height || Math.abs(it.transform[3]) || 12;
      out += Math.abs(last.y - y) > size * 1.8 ? "\n\n" : "\n";
    } else if (last && !/\s$/.test(out) && !/^\s/.test(it.str)) {
      // Many PDFs (scanned books with a text layer especially) place each
      // word separately without a space character: the gap is the space.
      // A gap of a third of a letter or more (or jumping back) is a word break.
      const gap = x - last.end;
      if (gap > 0.3 * Math.min(charWidth, last.charWidth) || gap < -charWidth) out += " ";
    }
    out += it.str;
    last = { y, end: x + it.width, charWidth };
  }
  return out;
}

// Lines that repeat on most pages (running headers, footers, page numbers)
// shouldn't be read aloud on every page.
function dropRepeatedLines(pages) {
  const counts = new Map();
  const key = (l) => l.trim().replace(/\d+/g, "#");
  for (const p of pages) {
    const lines = p.split("\n").filter((l) => l.trim());
    for (const l of new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(key))) {
      counts.set(l, (counts.get(l) || 0) + 1);
    }
  }
  const limit = Math.max(3, pages.length * 0.4);
  return pages.map((p) => {
    const lines = p.split("\n");
    const edge = new Set();
    const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    [...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)].forEach((i) => edge.add(i));
    return lines
      .filter((l, i) => !(edge.has(i) && (counts.get(key(l)) >= limit || /^\s*\d{1,4}\s*$/.test(l))))
      .join("\n");
  });
}

async function readPdf(file) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, "");

  let pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(await pdfPageText(await pdf.getPage(n)));
  pages = dropRepeatedLines(pages);
  if (!pages.join("").trim()) {
    throw new Error("This PDF has no text layer (it's probably scanned pages), so it can't be read aloud.");
  }

  let marks = [];
  try {
    for (const entry of (await pdf.getOutline()) || []) {
      let dest = entry.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (Array.isArray(dest)) marks.push({ title: entry.title.trim(), page: await pdf.getPageIndex(dest[0]) });
    }
  } catch {
    marks = [];
  }
  marks = marks.filter((m, i, a) => i === 0 || m.page > a[i - 1].page);

  const chapters = [];
  if (marks.length >= 2) {
    if (marks[0].page > 0) marks.unshift({ title: "Opening pages", page: 0 });
    marks.forEach((m, i) => {
      const end = marks[i + 1]?.page ?? pages.length;
      chapters.push({ title: m.title, text: tidy(pages.slice(m.page, end).join("\n\n")) });
    });
  } else {
    const per = 10;
    for (let p = 0; p < pages.length; p += per) {
      const end = Math.min(p + per, pages.length);
      chapters.push({ title: `Pages ${p + 1}–${end}`, text: tidy(pages.slice(p, end).join("\n\n")) });
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
    .filter((p) => /[\p{L}\p{N}]/u.test(p))
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
