import { renderHtml } from "../markdown.js";
import { badge, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { esc, fmtDate, splitLines } from "../util.js";
import { KIND_LABELS } from "./materials.js";
import { can } from "../shared.js";

/** "Topic\n  - Subtopic" text → [{title, subtopics[]}] */
export function parseTopics(text) {
  const topics = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const isSub = /^\s+|^\s*[-*•]\s/.test(raw) && topics.length;
    const clean = raw.trim().replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "");
    if (isSub) topics[topics.length - 1].subtopics.push(clean);
    else topics.push({ title: clean, subtopics: [] });
  }
  return topics;
}

export function topicsToText(topics = []) {
  return topics.map((t) => [t.title, ...(t.subtopics || []).map((s) => `  - ${s}`)].join("\n")).join("\n");
}

export async function editUnit(ctx, existing = null, classId = "") {
  const look = await ctx.lookups();
  if (!look.classes.length) {
    ctx.toast("Create a class first, then add course units to it.", "error");
    return null;
  }
  const u = existing || { classId };
  const values = await modal({
    title: existing ? "Edit course unit" : "New course unit",
    wide: true,
    body: `
      <div class="row">
        ${field("Class", `<select name="classId" required>${options(look.classOptions, u.classId, { blank: "Choose a class…" })}</select>`)}
        ${field("Course code", `<input name="code" maxlength="30" value="${esc(u.code)}" placeholder="e.g. PHA101">`)}
      </div>
      <div class="row">
        ${field("Course title", `<input name="title" required maxlength="160" value="${esc(u.title)}" placeholder="e.g. Pharmacology I">`)}
        ${field("Teaching hours", `<input name="hours" type="number" min="0" max="2000" step="0.5" value="${esc(u.hours ?? "")}">`)}
      </div>
      ${field("Description", `<textarea name="description" rows="2" maxlength="3000">${esc(u.description)}</textarea>`)}
      ${field("Learning objectives / outcomes", `<textarea name="objectives" rows="4" placeholder="One per line">${esc((u.objectives || []).join("\n"))}</textarea>`, "One outcome per line.")}
      ${field("Topics and subtopics", `<textarea name="topics" rows="6" placeholder="Pharmacokinetics\n  - Absorption\n  - Distribution\nPharmacodynamics">${esc(topicsToText(u.topics))}</textarea>`, "One topic per line. Indent or start with “-” for a subtopic.")}
      ${field("Curriculum (key content)", `<textarea name="curriculum" rows="5" maxlength="20000">${esc(u.curriculum)}</textarea>`, "Paste the curriculum text, or upload the curriculum document to the library and link it to this unit.")}
      ${field("Course outline / scheme of work", `<textarea name="outline" rows="5" maxlength="20000">${esc(u.outline)}</textarea>`)}`,
    validate: (v) => (!v.classId ? "Choose a class." : !v.title.trim() ? "Enter a course title." : null),
  });
  if (!values) return null;
  const saved = await ctx.db.put("units", {
    ...u,
    classId: values.classId,
    code: values.code.trim(),
    title: values.title.trim(),
    hours: values.hours === "" ? null : Number(values.hours),
    description: values.description.trim(),
    objectives: splitLines(values.objectives),
    topics: parseTopics(values.topics),
    curriculum: values.curriculum.trim(),
    outline: values.outline.trim(),
  });
  ctx.toast(existing ? "Course unit updated." : "Course unit created.", "success");
  return saved;
}

export async function render(ctx, el, params) {
  if (params.id) return renderDetail(ctx, el, params.id, params.tab || "overview");
  const look = await ctx.lookups();
  el.innerHTML = `
    ${pageHead("Course Units", `${look.units.length} course units across ${look.classes.length} classes`, `<button class="btn btn-primary" data-act="new">＋ New course unit</button>`)}
    ${
      look.units.length
        ? look.classes
            .map((c) => {
              const list = look.units.filter((u) => u.classId === c.id);
              if (!list.length) return "";
              return `<section class="group"><h2><a href="#/classes/${esc(c.id)}">${esc(c.name)}</a></h2>
                <table class="table"><thead><tr><th>Code</th><th>Title</th><th>Topics</th><th>Hours</th><th></th></tr></thead><tbody>
                ${list
                  .map(
                    (u) => `<tr><td>${esc(u.code || "—")}</td><td><a href="#/units/${esc(u.id)}">${esc(u.title)}</a></td><td>${(u.topics || []).length}</td><td>${u.hours ?? "—"}</td>
                    <td class="right"><a class="btn btn-sm" href="#/assistant?unit=${esc(u.id)}">✦ Generate</a></td></tr>`,
                  )
                  .join("")}</tbody></table></section>`;
            })
            .join("")
        : empty("No course units yet", look.classes.length ? "Add a course unit to one of your classes." : "Create a class first, then add course units.", look.classes.length ? `<button class="btn btn-primary" data-act="new">＋ New course unit</button>` : `<a class="btn btn-primary" href="#/classes?new=1">＋ New class</a>`)
    }`;
  el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-act=new]")) {
      const unit = await editUnit(ctx);
      if (unit) ctx.navigate(`units/${unit.id}`);
    }
  });
}

async function renderDetail(ctx, el, id, tab) {
  const unit = await ctx.db.get("units", id);
  if (!unit) {
    el.innerHTML = empty("Course unit not found", "It may have been deleted.", `<a class="btn" href="#/units">Back</a>`);
    return;
  }
  const cls = await ctx.db.get("classes", unit.classId);
  const [resources, materials, assessments, research] = await Promise.all([
    ctx.db.byIndex("resources", "unitId", id),
    ctx.db.byIndex("materials", "unitId", id),
    ctx.db.byIndex("assessments", "unitId", id),
    ctx.db.byIndex("research", "unitId", id),
  ]);
  const tabs = [
    ["overview", "Overview & curriculum"],
    ["resources", `Textbooks & references (${resources.length})`],
    ["materials", `Teaching materials (${materials.length})`],
    ["assessments", `Assessments (${assessments.length})`],
    ["media", `Saved links & videos (${research.length})`],
  ];
  let body = "";
  if (tab === "overview") {
    body = `<div class="grid-2">
      <section class="card"><h2>Learning objectives</h2>${(unit.objectives || []).length ? `<ol>${unit.objectives.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` : `<p class="muted">None recorded.</p>`}</section>
      <section class="card"><h2>Topics</h2>${(unit.topics || []).length ? `<ol>${unit.topics.map((t) => `<li>${esc(t.title)}${t.subtopics.length ? `<ul>${t.subtopics.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>` : `<p class="muted">None recorded.</p>`}</section>
      <section class="card"><h2>Curriculum</h2>${unit.curriculum ? `<div class="prose">${renderHtml(unit.curriculum)}</div>` : `<p class="muted">No curriculum text. Upload the curriculum to the library and link it here.</p>`}</section>
      <section class="card"><h2>Course outline</h2>${unit.outline ? `<div class="prose">${renderHtml(unit.outline)}</div>` : `<p class="muted">No outline recorded.</p>`}</section>
    </div>`;
  } else if (tab === "resources") {
    body = resources.length
      ? `<table class="table"><thead><tr><th>Title</th><th>Type</th><th>Author</th><th>Offline</th></tr></thead><tbody>${resources
          .map((r) => `<tr><td><a href="#/library?open=${esc(r.id)}">${esc(r.title)}</a></td><td>${esc(r.docType || "")}</td><td>${esc(r.author || "")}</td><td>${r.offline ? badge("yes", "ok") : "—"}</td></tr>`)
          .join("")}</tbody></table>`
      : empty("No textbooks or references", "Upload materials to the Digital Library and link them to this unit.", `<a class="btn btn-primary" href="#/library?upload=1&unit=${esc(id)}">⇪ Upload</a>`);
  } else if (tab === "materials") {
    body = materials.length
      ? `<table class="table"><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead><tbody>${materials
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((m) => `<tr><td><a href="#/material/${esc(m.id)}">${esc(m.title)}</a></td><td>${esc(KIND_LABELS[m.kind] || m.kind)}</td><td>${m.status === "reviewed" ? badge("reviewed", "ok") : badge("draft", "warn")}</td><td>${fmtDate(m.updatedAt)}</td></tr>`)
          .join("")}</tbody></table>`
      : empty("No materials yet", "Generate lecture notes, slides, quizzes and exams from this unit's curriculum and sources.", `<a class="btn btn-primary" href="#/assistant?unit=${esc(id)}">✦ Open AI Teaching Assistant</a>`);
  } else if (tab === "assessments") {
    body = assessments.length
      ? `<table class="table"><thead><tr><th>Assessment</th><th>Category</th><th>Max</th><th>Weight</th><th>Date</th></tr></thead><tbody>${assessments
          .map((a) => `<tr><td><a href="#/students?class=${esc(unit.classId)}&unit=${esc(id)}&assessment=${esc(a.id)}">${esc(a.title)}</a></td><td>${esc(a.category)}</td><td>${a.maxScore}</td><td>${a.weight || 0}</td><td>${fmtDate(a.date)}</td></tr>`)
          .join("")}</tbody></table><p><a class="btn" href="#/reports?unit=${esc(id)}">◔ View report</a></p>`
      : empty("No assessments", "Create assessments and record marks in Students & Marks.", `<a class="btn btn-primary" href="#/students?class=${esc(unit.classId)}&unit=${esc(id)}">Open Students &amp; Marks</a>`);
  } else {
    body = research.length
      ? `<ul class="list">${research.map((r) => `<li>${badge(r.kind)} <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="muted">${esc(r.topic || "")}</span></li>`).join("")}</ul>`
      : empty("Nothing saved", "Use the Research Assistant to find articles, images and videos and save them to this unit.", `<a class="btn btn-primary" href="#/research?unit=${esc(id)}">⌕ Research</a>`);
  }
  el.innerHTML = `
    <nav class="crumbs"><a href="#/classes">Classes</a> › <a href="#/classes/${esc(unit.classId)}">${esc(cls?.name || "Class")}</a> › ${esc(unit.title)}</nav>
    ${pageHead(`${unit.code ? unit.code + " — " : ""}${unit.title}`, [unit.description, unit.hours ? `${unit.hours} teaching hours` : ""].filter(Boolean).join(" · "), `
      ${can(cls, "units") ? `<button class="btn btn-ghost-danger" data-act="delete">Delete</button>
      <button class="btn" data-act="edit">Edit unit</button>` : ""}
      <a class="btn btn-primary" href="#/assistant?unit=${esc(id)}">✦ Generate materials</a>`)}
    <div class="tabs" role="tablist">${tabs.map(([k, label]) => `<a role="tab" class="tab ${k === tab ? "active" : ""}" href="#/units/${esc(id)}?tab=${k}">${esc(label)}</a>`).join("")}</div>
    <div class="tab-body">${body}</div>`;
  el.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "edit" && (await editUnit(ctx, unit))) ctx.refresh();
    if (act === "delete") {
      const ok = await confirmDialog(`Delete “${unit.title}”? Its generated materials, assessments and marks are deleted too. Library files stay in the library.`, { confirm: "Delete unit", typed: unit.title });
      if (ok) {
        await ctx.db.deleteUnit(id);
        await ctx.db.log("delete-unit", unit.title);
        ctx.toast("Course unit deleted.", "success");
        ctx.navigate(`classes/${unit.classId}`);
      }
    }
  });
}
