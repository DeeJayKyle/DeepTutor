import { api } from "../api.js";
import { exportDocument } from "../exporters.js";
import { provenance, renderHtml } from "../markdown.js";
import { parseQuiz } from "../sources.js";
import { badge, busy, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { debounce, esc, fmtDate, fmtDateTime } from "../util.js";

export const KIND_LABELS = {
  lecture_notes: "Lecture notes",
  topic_summary: "Topic summary",
  presentation: "Presentation",
  exam: "Examination",
  quiz: "Quiz",
  marking_guide: "Marking guide",
  assignment: "Assignment / coursework",
  case_study: "Case study",
  document: "Document",
};

export const SECTIONS = {
  notes: { title: "Lecture Notes", subtitle: "Lecture notes, topic summaries and teaching presentations.", kinds: ["lecture_notes", "topic_summary", "presentation", "document"], gen: "lecture_notes" },
  exams: { title: "Examinations & Quizzes", subtitle: "Examination papers, quizzes, model answers and marking guides.", kinds: ["exam", "quiz", "marking_guide"], gen: "exam" },
  assignments: { title: "Assignments & Coursework", subtitle: "Assignments, coursework, case studies, practical exercises and rubrics.", kinds: ["assignment", "case_study"], gen: "assignment" },
};

function sectionFor(kind) {
  return Object.entries(SECTIONS).find(([, s]) => s.kinds.includes(kind))?.[0] || "notes";
}

export async function render(ctx, el, params, routeName) {
  if (routeName === "material") return renderEditor(ctx, el, params.id);
  const section = SECTIONS[routeName] || SECTIONS.notes;
  const look = await ctx.lookups();
  const all = (await ctx.db.all("materials")).filter((m) => section.kinds.includes(m.kind));
  const state = { q: "", kind: "", unitId: params.unit || "", classId: params.class || "", status: "" };
  el.innerHTML = `
    ${pageHead(section.title, section.subtitle, `
      <button class="btn" data-act="blank">＋ Write manually</button>
      <a class="btn btn-primary" href="#/assistant?kind=${section.gen}">✦ Generate with AI</a>`)}
    <div class="filters">
      <input type="search" name="q" placeholder="Search titles and content…" aria-label="Search">
      <select name="kind" aria-label="Type">${options(section.kinds.map((k) => [k, KIND_LABELS[k]]), "", { blank: "All types" })}</select>
      <select name="classId" aria-label="Class">${options(look.classOptions, state.classId, { blank: "All classes" })}</select>
      <select name="unitId" aria-label="Course unit">${options(look.unitOptions, state.unitId, { blank: "All course units" })}</select>
      <select name="status" aria-label="Status">${options([["draft", "Drafts"], ["reviewed", "Reviewed"]], "", { blank: "Any status" })}</select>
    </div>
    <div id="mat-list"></div>`;
  const list = el.querySelector("#mat-list");
  const draw = () => {
    const q = state.q.toLowerCase();
    const items = all
      .filter((m) => (!state.kind || m.kind === state.kind) && (!state.unitId || m.unitId === state.unitId) && (!state.classId || m.classId === state.classId) && (!state.status || (m.status || "draft") === state.status))
      .filter((m) => !q || `${m.title} ${m.content}`.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!all.length) {
      list.innerHTML = empty(`No ${section.title.toLowerCase()} yet`, "Generate a draft with the AI Teaching Assistant, or write one yourself.", `<a class="btn btn-primary" href="#/assistant?kind=${section.gen}">✦ Generate with AI</a>`);
      return;
    }
    list.innerHTML = items.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Type</th><th>Course unit</th><th>Status</th><th>Updated</th></tr></thead><tbody>${items
          .map((m) => {
            const unit = look.unitById.get(m.unitId);
            return `<tr><td><a href="#/material/${esc(m.id)}?from=${routeName}">${esc(m.title)}</a> ${m.aiGenerated ? badge("AI-assisted", "ai") : ""}</td><td>${esc(KIND_LABELS[m.kind] || m.kind)}</td><td class="small">${esc(look.unitLabel(unit) || "—")}</td><td>${m.status === "reviewed" ? badge("reviewed", "ok") : badge("draft — review needed", "warn")}</td><td class="small">${fmtDate(m.updatedAt)}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="muted">Nothing matches these filters.</p>`;
  };
  draw();
  el.querySelector(".filters").addEventListener("input", debounce((e) => {
    state[e.target.name] = e.target.value;
    draw();
  }, 150));
  el.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-act=blank]")) return;
    const values = await modal({
      title: "New document",
      body: `${field("Title", `<input name="title" required maxlength="200">`)}
        <div class="row">${field("Type", `<select name="kind">${options(section.kinds.map((k) => [k, KIND_LABELS[k]]), section.kinds[0])}</select>`)}
        ${field("Course unit", `<select name="unitId">${options(look.unitOptions, state.unitId, { blank: "Not linked" })}</select>`)}</div>`,
      submit: "Create",
    });
    if (!values) return;
    const unit = look.unitById.get(values.unitId);
    const m = await ctx.db.put("materials", { kind: values.kind, title: values.title.trim(), unitId: values.unitId, classId: unit?.classId || "", content: `# ${values.title.trim()}\n\n`, status: "draft", aiGenerated: false, sources: [] });
    ctx.navigate(`material/${m.id}?from=${routeName}`);
  });
}

async function renderEditor(ctx, el, id) {
  let m = await ctx.db.get("materials", id);
  if (!m) {
    el.innerHTML = empty("Document not found", "It may have been deleted.", `<a class="btn" href="#/notes">Back</a>`);
    return;
  }
  const look = await ctx.lookups();
  const unit = look.unitById.get(m.unitId);
  const cls = look.classById.get(m.classId);
  const from = SECTIONS[ctx.route.params.from] ? ctx.route.params.from : sectionFor(m.kind);
  ctx.activeNav = from;
  const isQuiz = ["quiz", "exam"].includes(m.kind) && parseQuiz(m.content).length > 0;

  el.innerHTML = `
    <nav class="crumbs"><a href="#/${from}">${esc(SECTIONS[from]?.title || "Materials")}</a> › ${esc(m.title)}</nav>
    <div class="editor-head">
      <input class="title-input" name="title" value="${esc(m.title)}" aria-label="Title" maxlength="200">
      <div class="muted small">${esc(KIND_LABELS[m.kind] || m.kind)} · ${esc(cls?.name || "No class")}${unit ? ` › ${esc(look.unitLabel(unit))}` : ""} · <span id="save-state">Saved ${fmtDateTime(m.updatedAt)}</span></div>
    </div>
    <div id="status-bar"></div>
    <div class="toolbar">
      <div class="seg" role="tablist">
        <button class="seg-btn active" data-mode="split">Edit &amp; preview</button>
        <button class="seg-btn" data-mode="edit">Edit</button>
        <button class="seg-btn" data-mode="preview">Preview</button>
      </div>
      <span class="spacer"></span>
      ${isQuiz ? `<button class="btn" data-act="practice">▶ Interactive mode</button>` : ""}
      <button class="btn" data-act="revise" ${navigator.onLine && ctx.ai.available ? "" : "disabled title='Needs internet and a configured AI model'"}>✦ Revise with AI</button>
      ${["exam", "quiz", "assignment"].includes(m.kind) ? `<button class="btn" data-act="guide" ${navigator.onLine && ctx.ai.available ? "" : "disabled"}>Marking guide</button>` : ""}
      <div class="menu"><button class="btn" data-act="export-menu" aria-haspopup="true">⤓ Export</button>
        <div class="menu-pop" hidden>
          <button data-export="docx">Word (.docx)</button>
          <button data-export="pdf">PDF (.pdf)</button>
          <button data-export="pptx">PowerPoint (.pptx)</button>
          <button data-export="md">Markdown (.md)</button>
        </div></div>
      <button class="btn btn-ghost-danger" data-act="delete">Delete</button>
    </div>
    <div class="editor split">
      <textarea class="md-input" spellcheck="true" aria-label="Content (Markdown)">${esc(m.content)}</textarea>
      <article class="prose md-preview"></article>
    </div>
    <details class="card help"><summary>Formatting help</summary>
      <p class="small"># Heading, ## Subheading, **bold**, *italic*, - bullet, 1. numbered, | table | rows |, &gt; quote. In presentations each “## Slide title” starts a new slide; a line starting “Notes:” becomes speaker notes. <span class="src-tag">[Source: S1]</span> marks statements taken from your uploaded sources.</p>
    </details>`;

  const textarea = el.querySelector(".md-input");
  const preview = el.querySelector(".md-preview");
  const statusBar = el.querySelector("#status-bar");
  const saveState = el.querySelector("#save-state");
  const titleInput = el.querySelector(".title-input");

  const drawStatus = () => {
    const p = provenance(m.content);
    const sourceList = (m.sources || []).map((s) => `<li><strong>${esc(s.tag)}</strong> — ${esc(s.title)}${p.sources.includes(s.tag) ? "" : ' <span class="muted">(not cited)</span>'}</li>`).join("");
    statusBar.innerHTML = `<div class="status-row ${m.status === "reviewed" ? "ok" : "warn"}">
      <div>
        ${m.status === "reviewed" ? `${badge("Reviewed", "ok")} by ${esc(m.reviewedBy || "tutor")} on ${fmtDate(m.reviewedAt)}` : `${badge("Draft", "warn")} Review the content and check references before using it with students.`}
        ${m.aiGenerated ? `<div class="small">${badge("AI-assisted", "ai")} ${p.sourced} of ${p.total} statements are tagged to your sources (<span class="src-tag">[Source: S#]</span>); untagged text and blocks marked “AI-generated explanation” come from the model and need checking.</div>` : ""}
        ${sourceList ? `<details class="small"><summary>Sources supplied (${(m.sources || []).length})</summary><ul>${sourceList}</ul></details>` : m.aiGenerated ? `<div class="small muted">No uploaded sources were supplied — the whole draft is AI-generated.</div>` : ""}
      </div>
      <div>${m.status === "reviewed" ? `<button class="btn btn-sm" data-act="unreview">Return to draft</button>` : `<button class="btn btn-sm btn-primary" data-act="review">Mark as reviewed</button>`}</div>
    </div>`;
  };
  const drawPreview = () => (preview.innerHTML = renderHtml(textarea.value));
  drawPreview();
  drawStatus();

  const save = async () => {
    const content = textarea.value;
    const title = titleInput.value.trim() || m.title;
    if (content === m.content && title === m.title) return;
    const changedAfterReview = m.status === "reviewed" && content !== m.content;
    m = await ctx.db.put("materials", { ...m, content, title, ...(changedAfterReview ? { status: "draft", reviewedAt: null } : {}) });
    saveState.textContent = `Saved ${fmtDateTime(m.updatedAt)}`;
    if (changedAfterReview) {
      drawStatus();
      ctx.toast("Content changed after review — marked as draft again.", "info");
    }
  };
  const autosave = debounce(save, 800);
  textarea.addEventListener("input", () => {
    saveState.textContent = "Saving…";
    drawPreview();
    autosave();
  });
  titleInput.addEventListener("change", save);

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.mode) {
      el.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      el.querySelector(".editor").className = `editor ${btn.dataset.mode}`;
      return;
    }
    const pop = el.querySelector(".menu-pop");
    if (btn.dataset.act === "export-menu") {
      pop.hidden = !pop.hidden;
      return;
    }
    if (btn.dataset.export) {
      pop.hidden = true;
      await save();
      const format = btn.dataset.export;
      const meta = {
        title: m.title,
        subtitle: [cls?.name, unit && look.unitLabel(unit)].filter(Boolean).join(" · "),
        author: ctx.user,
        reviewed: m.status === "reviewed",
        aiGenerated: m.aiGenerated,
      };
      if (m.status !== "reviewed" && !(await confirmDialog("This document has not been marked as reviewed. Export it as a DRAFT? The draft notice is printed in the footer.", { confirm: "Export draft", danger: false }))) return;
      busy(btn, true, "Exporting…");
      try {
        let result;
        if (format === "md") {
          const { saveBlob } = await import("../exporters.js");
          result = await saveBlob(new Blob([m.content], { type: "text/markdown" }), `${m.title.replace(/[^\w\- ]+/g, "").trim() || "document"}.md`);
        } else result = await exportDocument(format, m.content, meta);
        if (result.saved) {
          await ctx.db.log("export", `${format.toUpperCase()}: ${m.title}`);
          ctx.toast(`${format.toUpperCase()} file saved to your ${result.method}: ${result.name}`, "success", 6000);
        } else ctx.toast("Export cancelled — no file was saved.", "info");
      } catch (err) {
        ctx.toast(`Export failed: ${err.message}`, "error", 8000);
      } finally {
        busy(btn, false);
      }
      return;
    }
    switch (btn.dataset.act) {
      case "review": {
        const ok = await modal({
          title: "Mark as reviewed",
          body: `<p>Confirm that you have checked this material before using it with students.</p>
            <label class="check"><input type="checkbox" name="content" required> I have read and corrected the content.</label>
            <label class="check"><input type="checkbox" name="refs" required> I have checked the references and source tags.</label>`,
          submit: "Mark as reviewed",
        });
        if (!ok) return;
        await save();
        m = await ctx.db.put("materials", { ...m, status: "reviewed", reviewedAt: new Date().toISOString(), reviewedBy: ctx.user });
        await ctx.db.log("review", m.title);
        drawStatus();
        ctx.toast("Marked as reviewed.", "success");
        break;
      }
      case "unreview":
        m = await ctx.db.put("materials", { ...m, status: "draft", reviewedAt: null });
        drawStatus();
        break;
      case "delete":
        if (await confirmDialog(`Delete “${m.title}”? This cannot be undone.`, { confirm: "Delete" })) {
          await ctx.db.delete("materials", m.id);
          await ctx.db.log("delete-material", m.title);
          ctx.navigate(from);
        }
        break;
      case "revise": {
        const values = await modal({
          title: "Revise with AI",
          body: field("What should change?", `<textarea name="ask" rows="4" required placeholder="e.g. Simplify section 2 for first-year students and add two worked examples."></textarea>`),
          submit: "Revise",
        });
        if (!values) return;
        await save();
        busy(btn, true, "Revising…");
        try {
          const res = await api.generate({
            kind: "revise",
            unit_title: unit?.title || "",
            class_name: cls?.name || "",
            instructions: `TUTOR REQUEST: ${values.ask}\n\nEXISTING DRAFT:\n${m.content}`.slice(0, 60000),
          });
          await ctx.db.put("materials", { ...m, content: res.content, status: "draft", aiGenerated: true, previousContent: m.content });
          ctx.toast("Revised draft saved. The previous version is kept — use Undo revision if needed.", "success", 6000);
          ctx.refresh();
        } catch (err) {
          ctx.toast(err.message, "error", 8000);
        } finally {
          busy(btn, false);
        }
        break;
      }
      case "guide": {
        await save();
        busy(btn, true, "Writing marking guide…");
        try {
          const res = await api.generate({
            kind: "marking_guide",
            unit_title: unit?.title || "",
            class_name: cls?.name || "",
            instructions: `ASSESSMENT:\n${m.content}`.slice(0, 60000),
          });
          const guide = await ctx.db.put("materials", {
            kind: "marking_guide",
            title: `Marking guide — ${m.title}`,
            classId: m.classId,
            unitId: m.unitId,
            content: res.content,
            status: "draft",
            aiGenerated: true,
            sources: [],
            forMaterial: m.id,
          });
          ctx.navigate(`material/${guide.id}?from=exams`);
        } catch (err) {
          ctx.toast(err.message, "error", 8000);
        } finally {
          busy(btn, false);
        }
        break;
      }
      case "practice":
        practice(m);
        break;
      case "undo":
        if (m.previousContent) {
          m = await ctx.db.put("materials", { ...m, content: m.previousContent, previousContent: null });
          ctx.refresh();
        }
        break;
      default:
    }
  });
  if (m.previousContent) {
    el.querySelector(".toolbar .spacer").insertAdjacentHTML("afterend", `<button class="btn" data-act="undo">↶ Undo revision</button>`);
  }
}

function practice(m) {
  const questions = parseQuiz(m.content);
  let i = 0;
  let score = 0;
  const answered = new Map();
  const root = document.getElementById("modal-root");
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  const draw = () => {
    const q = questions[i];
    const picked = answered.get(i);
    wrap.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Interactive quiz">
      <header class="modal-head"><h2>${esc(m.title)} — question ${i + 1} of ${questions.length}</h2><button class="icon-btn" data-x aria-label="Close">✕</button></header>
      <div class="modal-body">
        <div class="prose">${renderHtml(q.options.length ? q.body.split(/\n\s*(?:[-*]\s*)?\(?[A-Ea-e][).]\s/)[0] : q.body)}</div>
        ${
          q.options.length
            ? `<div class="quiz-options">${q.options
                .map((o) => {
                  const state = picked ? (o.key === q.correct ? "correct" : o.key === picked ? "wrong" : "") : "";
                  return `<button class="quiz-opt ${state}" data-opt="${o.key}" ${picked ? "disabled" : ""}><strong>${o.key}.</strong> ${esc(o.text)}</button>`;
                })
                .join("")}</div>`
            : ""
        }
        <details ${picked ? "open" : ""}><summary>Show answer &amp; explanation</summary><div class="prose">${q.answer ? renderHtml(q.answer) : "<p class='muted'>No answer found in a “Marking Guide” section.</p>"}</div></details>
        ${q.correct ? "" : q.options.length ? "<p class='muted small'>The correct option could not be detected automatically; use the answer above.</p>" : ""}
      </div>
      <footer class="modal-foot"><span class="muted">Score: ${score}/${answered.size}</span><span class="spacer"></span>
        <button class="btn" data-prev ${i === 0 ? "disabled" : ""}>Previous</button>
        <button class="btn btn-primary" data-next>${i === questions.length - 1 ? "Finish" : "Next"}</button></footer></div>`;
  };
  wrap.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.x !== undefined || (t.dataset.next !== undefined && i === questions.length - 1)) {
      wrap.remove();
      return;
    }
    if (t.dataset.next !== undefined) i += 1;
    if (t.dataset.prev !== undefined) i -= 1;
    if (t.dataset.opt) {
      answered.set(i, t.dataset.opt);
      if (t.dataset.opt === questions[i].correct) score += 1;
    }
    draw();
  });
  draw();
  root.appendChild(wrap);
}
