// Document export: DOCX, PPTX, XLSX and PDF, generated entirely in the
// browser (works offline). Libraries are loaded on first use from /vendor and
// cached by the service worker.

import { inlineRuns, parseMarkdown, plainText, toSlides } from "./markdown.js";
import { slug } from "./util.js";

const VENDOR = {
  docx: ["vendor/docx.iife.js", () => globalThis.docx],
  pptx: ["vendor/pptxgen.bundle.js", () => globalThis.PptxGenJS],
  xlsx: ["vendor/exceljs.min.js", () => globalThis.ExcelJS],
  pdf: ["vendor/jspdf.umd.min.js", () => globalThis.jspdf?.jsPDF],
};

const loading = new Map();

function loadLib(kind) {
  const [src, get] = VENDOR[kind];
  if (get()) return Promise.resolve(get());
  if (!loading.has(kind)) {
    loading.set(
      kind,
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => (get() ? resolve(get()) : reject(new Error(`Export library ${src} did not load.`)));
        s.onerror = () => {
          loading.delete(kind);
          reject(new Error(`Could not load the ${kind.toUpperCase()} export library. Open the app online once so it can be stored for offline use.`));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return loading.get(kind);
}

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
};

/**
 * Save a blob. Uses the system "Save as" dialog where the browser supports it
 * (desktop Chrome/Edge) so the tutor chooses the folder; otherwise downloads.
 * Resolves to {saved, method, name}; only reports saved when the write ended.
 */
/** True inside the Android app (Capacitor shell). */
export function isNativeApp() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Android app: write to Documents/Tutor Companion, then offer to open/share. */
async function saveNative(blob, filename) {
  const { Filesystem, Share } = globalThis.Capacitor.Plugins;
  const data = await blobToBase64(blob);
  let written;
  let where = "Documents › Tutor Companion folder";
  try {
    written = await Filesystem.writeFile({ path: `Tutor Companion/${filename}`, data, directory: "DOCUMENTS", recursive: true });
  } catch {
    // Some devices refuse shared storage; keep a private copy and share it.
    written = await Filesystem.writeFile({ path: filename, data, directory: "CACHE" });
    where = "share sheet (choose where to save it)";
  }
  try {
    await Share.share({ title: filename, url: written.uri, dialogTitle: "Open or send the file" });
  } catch {
    // The tutor closed the share sheet — the file is still saved.
  }
  return { saved: true, method: where, name: filename };
}

export async function saveBlob(blob, filename) {
  if (!blob || !blob.size) throw new Error("The generated file is empty — nothing was saved.");
  if (isNativeApp()) return saveNative(blob, filename);
  const ext = filename.split(".").pop();
  if (typeof window.showSaveFilePicker === "function" && window.isSecureContext) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase(), accept: { [MIME[ext] || blob.type || "application/octet-stream"]: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { saved: true, method: "chosen location", name: handle.name };
    } catch (err) {
      if (err?.name === "AbortError") return { saved: false, method: "cancelled", name: filename };
      // Fall through to a regular download if the picker is blocked.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { saved: true, method: "downloads folder", name: filename };
}

function footerText(meta) {
  const parts = [meta.subtitle, meta.reviewed ? "Reviewed by tutor" : "DRAFT — not yet reviewed", meta.aiGenerated ? "AI-assisted" : ""];
  return parts.filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- DOCX ----

export async function exportDocx(markdown, meta = {}) {
  const d = await loadLib("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, Footer, PageNumber, ExternalHyperlink, BorderStyle, ShadingType } = d;
  const runsFor = (text, extra = {}) =>
    inlineRuns(text).map((r) =>
      r.link
        ? new ExternalHyperlink({ link: r.link, children: [new TextRun({ text: r.text, style: "Hyperlink", ...extra })] })
        : new TextRun({
            text: r.text,
            bold: r.bold || extra.bold,
            italics: r.italic || extra.italics,
            font: r.code ? "Consolas" : undefined,
            color: r.source ? "1F6F43" : extra.color,
            size: extra.size,
          }),
    );
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const children = [];
  if (meta.title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(meta.title)] }));
  if (meta.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: meta.subtitle, italics: true, color: "555555" })] }));
  for (const b of parseMarkdown(markdown)) {
    if (b.type === "heading") children.push(new Paragraph({ heading: levels[b.level - 1], children: runsFor(b.text) }));
    else if (b.type === "para") children.push(new Paragraph({ children: runsFor(b.text), spacing: { after: 120 } }));
    else if (b.type === "list")
      for (const it of b.items)
        children.push(
          new Paragraph({
            children: runsFor(it.text),
            ...(b.ordered ? { numbering: { reference: "num", level: it.depth } } : { bullet: { level: it.depth } }),
          }),
        );
    else if (b.type === "quote")
      children.push(
        new Paragraph({
          children: runsFor(b.text, { italics: true, color: "6B4E16" }),
          indent: { left: 400 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: "C9A227", space: 8 } },
        }),
      );
    else if (b.type === "code") children.push(...b.text.split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 18 })] })));
    else if (b.type === "hr") children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } } }));
    else if (b.type === "table")
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (row, ri) =>
              new TableRow({
                tableHeader: ri === 0,
                children: row.map(
                  (cell) =>
                    new TableCell({
                      shading: ri === 0 ? { type: ShadingType.CLEAR, fill: "E8EEF7", color: "auto" } : undefined,
                      children: [new Paragraph({ children: runsFor(cell, ri === 0 ? { bold: true } : {}) })],
                    }),
                ),
              }),
          ),
        }),
        new Paragraph(""),
      );
  }
  const doc = new Document({
    creator: meta.author || "Tutor Companion",
    title: meta.title || "Document",
    numbering: {
      config: [
        {
          reference: "num",
          levels: [0, 1, 2, 3].map((level) => ({ level, format: "decimal", text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } })),
        },
      ],
    },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: footerText(meta) + "  ·  Page ", size: 16, color: "777777" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "777777" })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}

// ---------------------------------------------------------------- PPTX ----

export async function exportPptx(markdown, meta = {}) {
  const PptxGenJS = await loadLib("pptx");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = meta.author || "Tutor Companion";
  pptx.title = meta.title || "Presentation";
  const accent = "1F4E79";
  pptx.defineSlideMaster({
    title: "TC",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: "100%", h: 0.12, fill: { color: accent } } },
      { text: { text: footerText(meta), options: { x: 0.4, y: 7.05, w: 9, h: 0.3, fontSize: 9, color: "888888" } } },
    ],
    slideNumber: { x: 12.4, y: 7.05, fontSize: 9, color: "888888" },
  });
  const slides = toSlides(markdown);
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: accent };
  titleSlide.addText(meta.title || slides[0]?.title || "Presentation", { x: 0.6, y: 2.4, w: 12, h: 1.4, fontSize: 40, bold: true, color: "FFFFFF" });
  if (meta.subtitle) titleSlide.addText(meta.subtitle, { x: 0.6, y: 3.9, w: 12, h: 0.8, fontSize: 20, color: "DCE6F2" });
  for (const s of slides) {
    if (meta.title && s === slides[0] && s.title === meta.title && !s.bullets.length) continue;
    if (!s.bullets.length && !s.tables.length) {
      // A heading with no content of its own becomes a section divider.
      const divider = pptx.addSlide({ masterName: "TC" });
      divider.background = { color: "E8EEF7" };
      divider.addText(s.title, { x: 0.6, y: 2.8, w: 12, h: 1.2, fontSize: 34, bold: true, color: accent });
      if (s.notes.length) divider.addNotes(s.notes.join("\n"));
      continue;
    }
    const slide = pptx.addSlide({ masterName: "TC" });
    slide.addText(s.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: accent });
    let y = 1.35;
    if (s.bullets.length) {
      const size = s.bullets.length > 8 ? 14 : s.bullets.length > 5 ? 17 : 20;
      const h = s.tables.length ? 2.6 : 5.4;
      slide.addText(
        s.bullets.map((b) => ({ text: b.text, options: { bullet: b.bold ? false : { indent: 18 }, bold: b.bold, indentLevel: b.depth, breakLine: true } })),
        { x: 0.6, y, w: 12.1, h, fontSize: size, color: "222222", valign: "top", paraSpaceAfter: 6, fit: "shrink" },
      );
      y += h + 0.15;
    }
    for (const table of s.tables.slice(0, 1)) {
      slide.addTable(
        table.map((row, ri) => row.map((cell) => ({ text: cell, options: { bold: ri === 0, fill: { color: ri === 0 ? "E8EEF7" : "FFFFFF" } } }))),
        { x: 0.6, y, w: 12.1, fontSize: 12, border: { type: "solid", pt: 0.5, color: "B0B7C3" }, autoPage: false },
      );
    }
    if (s.notes.length) slide.addNotes(s.notes.join("\n"));
  }
  return pptx.write({ outputType: "blob" });
}

// ---------------------------------------------------------------- XLSX ----

/** sheets: [{name, columns:[{header,key,width}], rows:[{}], notes:[string]}] */
export async function exportXlsx(sheets, meta = {}) {
  const ExcelJS = await loadLib("xlsx");
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.author || "Tutor Companion";
  wb.created = new Date();
  for (const sheetDef of sheets) {
    const ws = wb.addWorksheet(sheetDef.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    ws.columns = sheetDef.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || Math.max(10, c.header.length + 2) }));
    for (const row of sheetDef.rows) ws.addRow(row);
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (sheetDef.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheetDef.columns.length } };
    if (sheetDef.notes?.length) {
      ws.addRow([]);
      for (const n of sheetDef.notes) ws.addRow([n]).font = { italic: true, color: { argb: "FF555555" } };
    }
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: MIME.xlsx });
}

// ----------------------------------------------------------------- PDF ----

export async function exportPdf(markdown, meta = {}) {
  const JsPDF = await loadLib("pdf");
  const pdf = new JsPDF({ unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 56;
  const width = W - 2 * M;
  let y = M;
  const ensure = (h) => {
    if (y + h > H - M) {
      pdf.addPage();
      y = M;
    }
  };
  const write = (text, { size = 11, style = "normal", indent = 0, color = [30, 30, 30], gap = 6, bullet = "" } = {}) => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(text, width - indent - (bullet ? 14 : 0));
    const lh = size * 1.35;
    lines.forEach((line, i) => {
      ensure(lh);
      if (bullet && i === 0) pdf.text(bullet, M + indent, y + size);
      pdf.text(line, M + indent + (bullet ? 14 : 0), y + size);
      y += lh;
    });
    y += gap;
  };
  if (meta.title) write(meta.title, { size: 20, style: "bold", color: [31, 78, 121], gap: 4 });
  if (meta.subtitle) write(meta.subtitle, { size: 10, style: "italic", color: [90, 90, 90], gap: 14 });
  const sizes = [18, 15, 13, 12, 11, 11];
  for (const b of parseMarkdown(markdown)) {
    if (b.type === "heading") {
      y += 6;
      ensure(40);
      write(plainText(b.text), { size: sizes[b.level - 1], style: "bold", color: [31, 78, 121] });
    } else if (b.type === "para") write(plainText(b.text));
    else if (b.type === "list")
      b.items.forEach((it, i) => write(plainText(it.text), { indent: 12 + it.depth * 16, bullet: b.ordered ? `${i + 1}.` : "•", gap: 3 }));
    else if (b.type === "quote") write(plainText(b.text), { style: "italic", indent: 14, color: [107, 78, 22] });
    else if (b.type === "code") write(b.text, { size: 9, indent: 8, color: [60, 60, 60] });
    else if (b.type === "hr") {
      ensure(12);
      pdf.setDrawColor(180);
      pdf.line(M, y + 4, W - M, y + 4);
      y += 12;
    } else if (b.type === "table") {
      const cols = b.rows[0].length;
      const cw = width / cols;
      pdf.setFontSize(9);
      for (const [ri, row] of b.rows.entries()) {
        pdf.setFont("helvetica", ri === 0 ? "bold" : "normal");
        const cells = row.map((c) => pdf.splitTextToSize(plainText(c), cw - 8));
        const rh = Math.max(...cells.map((c) => c.length)) * 11 + 8;
        ensure(rh);
        cells.forEach((lines, ci) => {
          if (ri === 0) {
            pdf.setFillColor(232, 238, 247);
            pdf.rect(M + ci * cw, y, cw, rh, "F");
          }
          pdf.setDrawColor(176, 183, 195);
          pdf.rect(M + ci * cw, y, cw, rh);
          pdf.setTextColor(30, 30, 30);
          pdf.text(lines, M + ci * cw + 4, y + 12);
        });
        y += rh;
      }
      y += 10;
    }
  }
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    pdf.setPage(p);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(120);
    pdf.text(`${footerText(meta)}  ·  Page ${p} of ${pages}`, W / 2, H - 28, { align: "center" });
  }
  return pdf.output("blob");
}

/** Export markdown content to the given format and save it. */
export async function exportDocument(format, markdown, meta = {}) {
  const make = { docx: exportDocx, pptx: exportPptx, pdf: exportPdf }[format];
  if (!make) throw new Error(`Unsupported format ${format}`);
  const blob = await make(markdown, meta);
  return saveBlob(blob, `${slug(meta.title)}.${format}`);
}
