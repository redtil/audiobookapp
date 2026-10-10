import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// A book is { title, chapters: [{ title, text }] }.

export async function parseBook(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".epub")) return parseEpub(file);
  if (name.endsWith(".pdf")) return parsePdf(file);
  throw new Error("Please choose a .pdf or .epub file.");
}

// ---------- EPUB ----------

function resolvePath(base, rel) {
  const parts = base.split("/").slice(0, -1);
  for (const seg of decodeURIComponent(rel.split("#")[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE",
  "SECTION", "ARTICLE", "TR", "BR", "PRE", "DD", "DT", "FIGCAPTION",
]);

function htmlToText(doc) {
  doc.querySelectorAll("script, style, rt, nav[epub\\:type='toc']").forEach((n) => n.remove());
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child.nodeValue);
      else if (child.nodeType === 1) {
        const tag = child.tagName.toUpperCase();
        if (BLOCK_TAGS.has(tag)) out.push("\n");
        walk(child);
        if (BLOCK_TAGS.has(tag)) out.push("\n");
      }
    }
  };
  if (doc.body) walk(doc.body);
  return cleanText(out.join(""));
}

async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const read = (p) => zip.file(p)?.async("string");
  const parser = new DOMParser();

  const container = parser.parseFromString(await read("META-INF/container.xml"), "application/xml");
  const opfPath = container.querySelector("rootfile").getAttribute("full-path");
  const opf = parser.parseFromString(await read(opfPath), "application/xml");

  const title = opf.getElementsByTagName("dc:title")[0]?.textContent?.trim() || file.name;
  const manifest = {};
  for (const item of opf.getElementsByTagName("item")) {
    manifest[item.getAttribute("id")] = {
      href: resolvePath(opfPath, item.getAttribute("href")),
      type: item.getAttribute("media-type"),
      props: item.getAttribute("properties") || "",
    };
  }

  const tocTitles = await readTocTitles(zip, opf, manifest, parser);

  const chapters = [];
  for (const ref of opf.getElementsByTagName("itemref")) {
    const item = manifest[ref.getAttribute("idref")];
    if (!item || !/html/.test(item.type) || item.props.includes("nav")) continue;
    const src = await read(item.href);
    if (!src) continue;
    const doc = parser.parseFromString(src, "application/xhtml+xml");
    const safeDoc = doc.querySelector("parsererror") ? parser.parseFromString(src, "text/html") : doc;
    const text = htmlToText(safeDoc);
    if (text.length < 2) continue;
    const heading = safeDoc.querySelector("h1, h2, h3")?.textContent?.trim();
    chapters.push({
      title: tocTitles[item.href] || heading || `Section ${chapters.length + 1}`,
      text,
    });
  }
  if (!chapters.length) throw new Error("No readable text found in this EPUB.");
  return { title, chapters };
}

async function readTocTitles(zip, opf, manifest, parser) {
  const titles = {};
  const navItem = Object.values(manifest).find((m) => m.props.includes("nav"));
  try {
    if (navItem) {
      const doc = parser.parseFromString(await zip.file(navItem.href).async("string"), "text/html");
      for (const a of doc.querySelectorAll("nav a[href]")) {
        const href = resolvePath(navItem.href, a.getAttribute("href"));
        if (!titles[href]) titles[href] = a.textContent.trim();
      }
    } else {
      const ncxId = opf.getElementsByTagName("spine")[0]?.getAttribute("toc");
      const ncx = ncxId && manifest[ncxId];
      if (ncx) {
        const doc = parser.parseFromString(await zip.file(ncx.href).async("string"), "application/xml");
        for (const np of doc.getElementsByTagName("navPoint")) {
          const label = np.getElementsByTagName("text")[0]?.textContent?.trim();
          const src = np.getElementsByTagName("content")[0]?.getAttribute("src");
          if (label && src) {
            const href = resolvePath(ncx.href, src);
            if (!titles[href]) titles[href] = label;
          }
        }
      }
    }
  } catch {
    // A broken table of contents just means we fall back to headings.
  }
  return titles;
}

// ---------- PDF ----------

async function pageText(page) {
  const content = await page.getTextContent();
  let out = "";
  let lastY = null;
  for (const item of content.items) {
    if (!("str" in item) || (!item.str && !item.hasEOL)) continue;
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      // A gap much bigger than the font size marks a new paragraph.
      const size = item.height || Math.abs(item.transform[3]) || 12;
      out += Math.abs(lastY - y) > size * 1.8 ? "\n\n" : "\n";
    }
    out += item.str;
    lastY = y;
  }
  return out;
}

async function parsePdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, "");

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push(await pageText(await pdf.getPage(i)));
  }

  // Use the PDF's own outline for chapters when it has one.
  let starts = [];
  try {
    const outline = (await pdf.getOutline()) || [];
    for (const entry of outline) {
      let dest = entry.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      starts.push({ title: entry.title.trim(), page: pageIndex });
    }
  } catch {
    starts = [];
  }
  starts = starts.filter((s, i, a) => i === 0 || s.page > a[i - 1].page);

  const chapters = [];
  if (starts.length >= 2) {
    if (starts[0].page > 0) starts.unshift({ title: "Beginning", page: 0 });
    starts.forEach((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].page : pages.length;
      chapters.push({ title: s.title, text: cleanText(joinPages(pages.slice(s.page, end))) });
    });
  } else {
    const per = 10;
    for (let i = 0; i < pages.length; i += per) {
      const end = Math.min(i + per, pages.length);
      chapters.push({ title: `Pages ${i + 1}–${end}`, text: cleanText(joinPages(pages.slice(i, end))) });
    }
  }
  const readable = chapters.filter((c) => c.text.length > 1);
  if (!readable.length) {
    throw new Error("This PDF has no selectable text (it may be scanned images), so it can't be read aloud yet.");
  }
  return { title, chapters: readable };
}

function joinPages(pages) {
  return pages.join("\n\n");
}

// ---------- shared ----------

function cleanText(raw) {
  return raw
    .replace(/­/g, "")
    .replace(/(\w)-\n(\w)/g, "$1$2") // re-join hyphenated line breaks
    .replace(/[ \t ]+/g, " ")
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

// Split text into paragraphs of sentence-sized chunks the voice can read.
export function toParagraphs(text) {
  const seg = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;
  return text.split(/\n\n/).map((para) => {
    const sentences = seg
      ? [...seg.segment(para)].map((s) => s.segment)
      : para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [para];
    const chunks = [];
    for (const s of sentences) {
      if (!s.trim()) continue;
      if (s.length <= 220) chunks.push(s);
      else chunks.push(...splitLong(s));
    }
    return chunks;
  });
}

function splitLong(s) {
  const out = [];
  let cur = "";
  for (const part of s.split(/(?<=[,;:])\s+/)) {
    if ((cur + " " + part).length > 160 && cur) {
      out.push(cur + " ");
      cur = part;
    } else cur = cur ? cur + " " + part : part;
  }
  if (cur) out.push(cur);
  // Hard-wrap anything still too long.
  return out.flatMap((c) => (c.length > 220 ? c.match(/.{1,160}(\s|$)/g) : [c]));
}
