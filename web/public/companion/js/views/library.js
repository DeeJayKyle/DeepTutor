import { api } from "../api.js";
import { isNativeApp, saveBlob } from "../exporters.js";
import { FILE_STORE } from "../db.js";
import { badge, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { debounce, esc, fmtBytes, fmtDate, uid } from "../util.js";

export const DOC_TYPES = [
  ["textbook", "Textbook"],
  ["curriculum", "Curriculum"],
  ["outline", "Course outline"],
  ["reference", "Reference document"],
  ["article", "Research article"],
  ["reading", "Reading material"],
  ["slides", "Presentation"],
  ["spreadsheet", "Spreadsheet"],
  ["image", "Image / illustration"],
  ["other", "Other"],
];
const DOC_LABEL = Object.fromEntries(DOC_TYPES);

const ACCEPT = ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.rtf,.odt,.odp,.ods,.epub,.png,.jpg,.jpeg,.gif,.webp,.svg";
const ALLOWED = new Set(ACCEPT.split(",").map((s) => s.slice(1)));
const TEXT_LOCAL = new Set(["txt", "md", "csv"]);
const IMAGE_OCR = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const SERVER_EXTRACT = new Set(["docx", "pptx", "xlsx"]);
/** Can text be extracted on this device (no internet needed)? */
const LOCAL_EXTRACT = (e) => TEXT_LOCAL.has(e) || IMAGE_OCR.has(e) || e === "pdf";
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

function ext(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

function guessType(name) {
  const e = ext(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "image";
  if (["ppt", "pptx", "odp"].includes(e)) return "slides";
  if (["xls", "xlsx", "ods", "csv"].includes(e)) return "spreadsheet";
  if (/curricul|syllab/i.test(name)) return "curriculum";
  if (/outline|scheme/i.test(name)) return "outline";
  return e === "pdf" ? "textbook" : "reference";
}

/**
 * Extract text for AI use. Text files, PDFs (with OCR for scanned pages) and
 * images (OCR) are read on this device; Office files are read by the server.
 */
export async function extractText(ctx, resource, file) {
  const e = ext(resource.fileName);
  if (!LOCAL_EXTRACT(e) && !SERVER_EXTRACT.has(e)) return resource;
  try {
    let text;
    let truncated = false;
    let ocrNote = "";
    if (TEXT_LOCAL.has(e)) text = (await file.text()).slice(0, 400_000);
    else if (e === "pdf") {
      const { readPdf } = await import("../ocr.js");
      let lastToast = 0;
      const res = await readPdf(file, {
        onProgress: (p) => {
          if (p.phase === "ocr" && Date.now() - lastToast > 8000) {
            lastToast = Date.now();
            ctx.toast(`OCR “${resource.title}”: scanned page ${p.done + 1} of ${p.total}…`, "info", 6000);
          }
        },
      });
      text = res.text.slice(0, 400_000);
      truncated = res.text.length > 400_000;
      if (res.ocrPages) ocrNote = `${res.ocrPages} scanned page(s) read with OCR`;
      if (res.skippedOcrPages) ocrNote += `${ocrNote ? "; " : ""}${res.skippedOcrPages} more scanned page(s) skipped (limit 150)`;
    } else if (IMAGE_OCR.has(e)) {
      const { ocrImage } = await import("../ocr.js");
      ctx.toast(`Reading text in “${resource.title}” with OCR…`, "info");
      text = await ocrImage(file);
      ocrNote = "read with OCR";
    } else {
      const res = await api.extract(file);
      text = res.text;
      truncated = res.truncated;
    }
    if (!text.trim()) throw new Error(IMAGE_OCR.has(e) || e === "pdf" ? "No readable text was found, even with OCR." : "The file contains no text.");
    return ctx.db.put("resources", { ...resource, text, textChars: text.length, textTruncated: truncated, textError: "", ocrNote });
  } catch (err) {
    return ctx.db.put("resources", { ...resource, textError: err.message });
  }
}

async function metadataForm(ctx, r, { upload = false, defaults = {} } = {}) {
  const look = await ctx.lookups();
  const unitChoices = look.unitOptions;
  return modal({
    title: upload ? "Upload to the Digital Library" : "Edit resource details",
    wide: true,
    body: `
      ${upload ? field("Files", `<input type="file" name="files" multiple required accept="${ACCEPT}">`, `PDF, Word, PowerPoint, Excel, text and image files up to ${fmtBytes(MAX_FILE_BYTES)} each.`) : ""}
      ${upload ? "" : field("Title", `<input name="title" required maxlength="300" value="${esc(r.title)}">`)}
      <div class="row">
        ${field("Document type", `<select name="docType">${options(DOC_TYPES, r.docType || "", { blank: upload ? "Detect automatically" : "—" })}</select>`)}
        ${field("Subject", `<input name="subject" maxlength="120" value="${esc(r.subject)}">`)}
      </div>
      <div class="row">
        ${field("Class", `<select name="classId">${options(look.classOptions, r.classId || defaults.classId, { blank: "Not linked" })}</select>`)}
        ${field("Course unit", `<select name="unitId">${options(unitChoices, r.unitId || defaults.unitId, { blank: "Not linked" })}</select>`)}
      </div>
      <div class="row">
        ${field("Author(s)", `<input name="author" maxlength="300" value="${esc(r.author)}">`)}
        ${field("Publisher / source", `<input name="publisher" maxlength="200" value="${esc(r.publisher)}">`)}
      </div>
      <div class="row row-3">
        ${field("Year", `<input name="year" maxlength="10" value="${esc(r.year)}">`)}
        ${field("Edition", `<input name="edition" maxlength="40" value="${esc(r.edition)}">`)}
        ${field("Topic", `<input name="topic" maxlength="160" value="${esc(r.topic)}">`)}
      </div>
      ${field("Tags", `<input name="tags" maxlength="300" value="${esc((r.tags || []).join(", "))}" placeholder="comma, separated">`)}
      ${field("Notes", `<textarea name="notes" rows="2" maxlength="4000">${esc(r.notes)}</textarea>`)}
      ${field("Web link (optional)", `<input name="url" type="url" maxlength="1000" value="${esc(r.url)}" placeholder="https://">`)}
      <label class="check"><input type="checkbox" name="offline" ${r.offline !== false ? "checked" : ""}> Keep the file on this device for offline use</label>`,
    submit: upload ? "Upload" : "Save",
    validate: (v) => {
      if (upload) {
        const files = [...(v.files || [])];
        if (!files.length) return "Choose at least one file.";
        for (const f of files) {
          if (!ALLOWED.has(ext(f.name))) return `“${f.name}” is not a supported file type.`;
          if (f.size > MAX_FILE_BYTES) return `“${f.name}” is larger than ${fmtBytes(MAX_FILE_BYTES)}.`;
          if (!f.size) return `“${f.name}” is empty.`;
        }
      }
      if (v.unitId && v.classId) {
        const unit = look.unitById.get(v.unitId);
        if (unit && unit.classId !== v.classId) return "That course unit belongs to a different class.";
      }
      return null;
    },
  });
}

function fields(values, look) {
  const unit = look.unitById.get(values.unitId);
  return {
    docType: values.docType,
    subject: values.subject.trim(),
    classId: values.classId || unit?.classId || "",
    unitId: values.unitId,
    author: values.author.trim(),
    publisher: values.publisher.trim(),
    year: values.year.trim(),
    edition: values.edition.trim(),
    topic: values.topic.trim(),
    tags: values.tags.split(",").map((t) => t.trim()).filter(Boolean),
    notes: values.notes.trim(),
    url: values.url.trim(),
    offline: values.offline,
  };
}

async function upload(ctx, defaults = {}) {
  const values = await metadataForm(ctx, {}, { upload: true, defaults });
  if (!values) return;
  const look = await ctx.lookups();
  const files = [...values.files];
  let ok = 0;
  const pending = [];
  for (const file of files) {
    try {
      const fileId = uid("fi_");
      await ctx.db.putRaw(FILE_STORE, [{ id: fileId, name: file.name, blob: file, createdAt: new Date().toISOString() }]);
      const meta = fields(values, look);
      let resource = await ctx.db.put("resources", {
        ...meta,
        docType: meta.docType || guessType(file.name),
        title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
        fileId,
        fileName: file.name,
        mime: file.type,
        size: file.size,
        offline: true,
      });
      ok += 1;
      if (navigator.onLine || LOCAL_EXTRACT(ext(file.name))) pending.push([resource, file]);
    } catch (err) {
      const quota = err?.name === "QuotaExceededError";
      ctx.toast(quota ? `Not enough storage on this device for “${file.name}”. Free space or remove offline copies.` : `Could not store “${file.name}”: ${err.message}`, "error", 8000);
    }
  }
  if (ok) {
    await ctx.db.log("library-upload", `${ok} file(s)`);
    ctx.toast(`${ok} file${ok === 1 ? "" : "s"} added to the library.${pending.length ? " Reading their text…" : ""}`, "success");
  }
  ctx.refresh();
  // Text extraction (and OCR) can take a while, so it runs after the upload.
  for (const [resource, file] of pending) {
    const updated = await extractText(ctx, resource, file);
    if (updated.textError) ctx.toast(`“${resource.title}”: ${updated.textError}`, "error", 8000);
    if (ctx.route.name === "library") ctx.refresh();
  }
  if (pending.length) ctx.toast("Text extraction finished.", "success");
}

async function openResource(ctx, r) {
  await ctx.db.put("resources", { ...r, openedAt: new Date().toISOString() });
  if (r.fileId) {
    const f = await ctx.db.get(FILE_STORE, r.fileId);
    if (f?.blob && isNativeApp()) {
      await saveBlob(f.blob, r.fileName);
      return;
    }
    if (f?.blob) {
      const url = URL.createObjectURL(f.blob);
      const win = window.open(url, "_blank");
      if (!win) {
        const a = document.createElement("a");
        a.href = url;
        a.download = r.fileName;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      return;
    }
    ctx.toast("This file is not stored on this device. Restore it from a backup or upload it again.", "error", 7000);
    return;
  }
  if (r.url) window.open(r.url, "_blank", "noopener");
}

async function showText(ctx, r) {
  await modal({
    title: `Extracted text — ${r.title}`,
    wide: true,
    submit: "",
    cancel: "Close",
    body: r.text
      ? `<p class="muted small">${r.textChars?.toLocaleString() || r.text.length} characters${r.textTruncated ? " (truncated)" : ""}${r.ocrNote ? ` · ${esc(r.ocrNote)}` : ""}. This text is what the AI assistant reads when you select this source.</p><pre class="extract">${esc(r.text.slice(0, 20000))}${r.text.length > 20000 ? "\n…" : ""}</pre>`
      : `<p>${esc(r.textError || "No text has been extracted yet.")}</p>`,
  });
}

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  const all = await ctx.db.all("resources");
  const state = { q: "", type: "", classId: params.class || "", unitId: params.unit || "", offlineOnly: false };

  el.innerHTML = `
    ${pageHead("Digital Library", "Textbooks, curricula, course outlines, references and reading materials.", `<button class="btn btn-primary" data-act="upload">⇪ Upload files</button>`)}
    <div class="filters">
      <input type="search" name="q" placeholder="Search title, author, tags, notes…" aria-label="Search library">
      <select name="type" aria-label="Document type">${options(DOC_TYPES, "", { blank: "All types" })}</select>
      <select name="classId" aria-label="Class">${options(look.classOptions, state.classId, { blank: "All classes" })}</select>
      <select name="unitId" aria-label="Course unit">${options(look.unitOptions, state.unitId, { blank: "All course units" })}</select>
      <label class="check"><input type="checkbox" name="offlineOnly"> Offline only</label>
    </div>
    <div id="lib-results"></div>`;

  const results = el.querySelector("#lib-results");
  const draw = () => {
    const q = state.q.toLowerCase();
    const list = all
      .filter((r) => !state.type || r.docType === state.type)
      .filter((r) => !state.classId || r.classId === state.classId)
      .filter((r) => !state.unitId || r.unitId === state.unitId)
      .filter((r) => !state.offlineOnly || r.offline)
      .filter((r) => !q || [r.title, r.author, r.subject, r.topic, r.notes, r.publisher, ...(r.tags || [])].join(" ").toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!all.length) {
      results.innerHTML = empty("Your library is empty", "Upload prescribed textbooks, the curriculum, course outlines and references. They stay on this device and the AI assistant uses them as primary sources.", `<button class="btn btn-primary" data-act="upload">⇪ Upload files</button>`);
      return;
    }
    if (!list.length) {
      results.innerHTML = `<p class="muted">No resources match these filters.</p>`;
      return;
    }
    results.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Type</th><th>Linked to</th><th>Size</th><th>Text for AI</th><th>Offline</th><th></th></tr></thead><tbody>
      ${list
        .map((r) => {
          const unit = look.unitById.get(r.unitId);
          const cls = look.classById.get(r.classId);
          return `<tr data-id="${esc(r.id)}">
            <td><button class="link" data-act="open">${esc(r.title)}</button><div class="muted small">${esc([r.author, r.year, r.edition && `${r.edition} ed.`, r.publisher].filter(Boolean).join(" · "))}</div>${(r.tags || []).map((t) => badge(t)).join(" ")}</td>
            <td>${esc(DOC_LABEL[r.docType] || r.docType || "")}</td>
            <td class="small">${esc(cls?.name || "—")}${unit ? `<br>${esc(look.unitLabel(unit))}` : ""}</td>
            <td class="small">${r.size ? fmtBytes(r.size) : r.url ? "link" : "—"}</td>
            <td>${r.text ? `<button class="link small" data-act="text">${(r.textChars || r.text.length).toLocaleString()} chars</button>${r.ocrNote ? ` ${badge("OCR", "ai")}` : ""}` : r.textError ? `<span class="badge badge-warn" title="${esc(r.textError)}">failed</span> <button class="link small" data-act="extract">retry</button>` : r.fileId ? `<button class="link small" data-act="extract">extract</button>` : "—"}</td>
            <td>${r.fileId ? (r.offline ? badge("on device", "ok") : badge("not kept")) : "—"}</td>
            <td class="right nowrap"><button class="btn btn-sm" data-act="edit">Edit</button> <button class="btn btn-sm btn-ghost-danger" data-act="delete" aria-label="Delete">✕</button></td></tr>`;
        })
        .join("")}</tbody></table></div><p class="muted small">${list.length} of ${all.length} resources · added ${fmtDate(all[all.length - 1]?.createdAt)} onwards</p>`;
  };
  draw();

  const filters = el.querySelector(".filters");
  filters.addEventListener("input", debounce((e) => {
    const t = e.target;
    state[t.name] = t.type === "checkbox" ? t.checked : t.value;
    draw();
  }, 150));

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "upload") return upload(ctx, { classId: state.classId, unitId: state.unitId });
    const id = btn.closest("tr")?.dataset.id;
    const r = all.find((x) => x.id === id);
    if (!r) return;
    if (act === "open") openResource(ctx, r);
    if (act === "text") showText(ctx, r);
    if (act === "extract") {
      const f = await ctx.db.get(FILE_STORE, r.fileId);
      if (!f) return ctx.toast("The file is not stored on this device.", "error");
      btn.textContent = "extracting…";
      const updated = await extractText(ctx, r, new File([f.blob], r.fileName));
      ctx.toast(updated.text ? "Text extracted." : `Extraction failed: ${updated.textError}`, updated.text ? "success" : "error", 7000);
      ctx.refresh();
    }
    if (act === "edit") {
      const values = await metadataForm(ctx, r);
      if (!values) return;
      const updated = await ctx.db.put("resources", { ...r, title: values.title.trim(), ...fields(values, look) });
      if (!values.offline && r.fileId && r.offline) {
        const keep = await confirmDialog("Remove the stored copy of this file from this device? The library entry and extracted text are kept.", { confirm: "Remove file" });
        if (keep) {
          await ctx.db.delete(FILE_STORE, r.fileId);
          await ctx.db.put("resources", { ...updated, fileId: "", offline: false });
        } else await ctx.db.put("resources", { ...updated, offline: true });
      }
      ctx.toast("Resource updated.", "success");
      ctx.refresh();
    }
    if (act === "delete") {
      if (await confirmDialog(`Delete “${r.title}” and its stored file from the library?`, { confirm: "Delete" })) {
        await ctx.db.deleteResource(r.id);
        await ctx.db.log("library-delete", r.title);
        ctx.toast("Resource deleted.", "success");
        ctx.refresh();
      }
    }
  });

  if (params.upload) {
    history.replaceState(null, "", "#/library");
    upload(ctx, { classId: params.class, unitId: params.unit });
  }
  if (params.open) {
    const r = all.find((x) => x.id === params.open);
    history.replaceState(null, "", "#/library");
    if (r) openResource(ctx, r);
  }
}
