import { createSharePackage, parseSnapshot, planRestore, applyRestore } from "../backup.js";
import { saveBlob } from "../exporters.js";
import { badge, confirmDialog, empty, field, modal, pageHead } from "../ui.js";
import { esc, fmtDate, MAX_CLASSES, slug } from "../util.js";
import { editUnit } from "./units.js";
import { resolveConflicts } from "./backup.js";

export async function editClass(ctx, existing = null) {
  const count = await ctx.db.count("classes");
  if (!existing && count >= MAX_CLASSES) {
    ctx.toast(`You have reached the limit of ${MAX_CLASSES} classes in this workspace. Delete or archive a class to add another.`, "error", 7000);
    return null;
  }
  const c = existing || {};
  const values = await modal({
    title: existing ? "Edit class" : "New class",
    body: `
      ${field("Class name", `<input name="name" required maxlength="120" value="${esc(c.name)}" placeholder="e.g. Diploma in Pharmacy — Year One">`)}
      <div class="row">
        ${field("Academic level", `<input name="level" maxlength="80" value="${esc(c.level)}" placeholder="e.g. Diploma, Year 1">`)}
        ${field("Academic year / intake", `<input name="year" maxlength="40" value="${esc(c.year)}" placeholder="e.g. 2026/27">`)}
      </div>
      ${field("Description", `<textarea name="description" rows="3" maxlength="2000">${esc(c.description)}</textarea>`)}
      ${!existing ? `<p class="muted small">${count} of ${MAX_CLASSES} classes used.</p>` : ""}`,
    validate: async (v) => {
      const name = v.name.trim();
      if (!name) return "Enter a class name.";
      const clash = (await ctx.db.all("classes")).find((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== c.id);
      return clash ? "A class with this name already exists." : null;
    },
  });
  if (!values) return null;
  const saved = await ctx.db.put("classes", { ...c, name: values.name.trim(), level: values.level.trim(), year: values.year.trim(), description: values.description.trim() });
  ctx.toast(existing ? "Class updated." : "Class created.", "success");
  return saved;
}

async function deleteClass(ctx, cls) {
  const [units, students] = await Promise.all([ctx.db.byIndex("units", "classId", cls.id), ctx.db.byIndex("students", "classId", cls.id)]);
  const ok = await confirmDialog(
    `Deleting “${cls.name}” also deletes its ${units.length} course unit(s), ${students.length} student record(s), their marks and generated materials. Library files are kept. Consider a backup first.`,
    { title: "Delete class", confirm: "Delete class", typed: cls.name },
  );
  if (!ok) return false;
  await ctx.db.deleteClass(cls.id);
  await ctx.db.log("delete-class", cls.name);
  ctx.toast("Class deleted.", "success");
  return true;
}

async function exportShare(ctx, cls) {
  const values = await modal({
    title: "Share this class",
    body: `<p>Creates a share package another tutor can import into their own workspace. Only what you tick is included.</p>
      <label class="check"><input type="checkbox" name="students"> Include students, assessments and marks <span class="muted">(only share with authorised colleagues)</span></label>
      <label class="check"><input type="checkbox" name="files"> Include library files</label>`,
    submit: "Create package",
  });
  if (!values) return;
  const pkg = await createSharePackage(ctx.db, cls.id, { includeStudents: values.students, includeFiles: values.files, author: ctx.user });
  const res = await saveBlob(new Blob([JSON.stringify(pkg)], { type: "application/json" }), `${slug(cls.name)}.tcshare.json`);
  if (res.saved) ctx.toast(`Share package saved (${res.method}).`, "success");
}

export async function importShare(ctx) {
  const values = await modal({
    title: "Import a shared class",
    body: field("Share package (.tcshare.json) or backup file", `<input type="file" name="file" accept=".json,application/json" required>`),
    submit: "Review import",
  });
  if (!values?.file?.[0]) return;
  try {
    const data = await parseSnapshot(await values.file[0].text());
    const incomingClasses = data.stores.classes || [];
    const localClasses = await ctx.db.all("classes");
    const localIds = new Set(localClasses.map((c) => c.id));
    const newOnes = incomingClasses.filter((c) => !localIds.has(c.id));
    if (localClasses.length + newOnes.length > MAX_CLASSES) throw new Error(`Importing would exceed the ${MAX_CLASSES}-class limit.`);
    const local = {};
    for (const store of Object.keys(data.stores)) local[store] = store === "files" ? [] : await ctx.db.all(store);
    const plan = planRestore(local, data.stores);
    const resolutions = await resolveConflicts(ctx, plan, `Import “${data.title || values.file[0].name}”`);
    if (!resolutions) return;
    const result = await applyRestore(ctx.db, plan, resolutions);
    ctx.toast(`Imported: ${result.added} new, ${result.replaced} replaced, ${result.kept} kept.`, "success", 6000);
    ctx.refresh();
  } catch (err) {
    ctx.toast(err.message, "error", 7000);
  }
}

export async function render(ctx, el, params) {
  if (params.id) return renderDetail(ctx, el, params.id);
  const look = await ctx.lookups();
  const students = await ctx.db.all("students");
  const full = look.classes.length >= MAX_CLASSES;
  el.innerHTML = `
    ${pageHead("Classes", `${look.classes.length} of ${MAX_CLASSES} classes used`, `
      <button class="btn" data-act="import">Import shared class</button>
      <button class="btn btn-primary" data-act="new" ${full ? "disabled title='Class limit reached'" : ""}>＋ New class</button>`)}
    ${full ? `<div class="alert alert-warn">You have reached the maximum of ${MAX_CLASSES} classes. Delete a class you no longer teach to add another.</div>` : ""}
    ${
      look.classes.length
        ? `<div class="cards">${look.classes
            .map((c) => {
              const u = look.units.filter((x) => x.classId === c.id);
              const s = students.filter((x) => x.classId === c.id).length;
              return `<article class="card class-card">
                <h2><a href="#/classes/${esc(c.id)}">${esc(c.name)}</a></h2>
                <p class="muted">${esc([c.level, c.year].filter(Boolean).join(" · ") || "No level set")}</p>
                <p>${esc(c.description || "")}</p>
                <p class="meta">${badge(`${u.length} unit${u.length === 1 ? "" : "s"}`)} ${badge(`${s} student${s === 1 ? "" : "s"}`)}</p>
                <div class="card-actions">
                  <a class="btn btn-sm" href="#/classes/${esc(c.id)}">Open</a>
                  <button class="btn btn-sm" data-act="edit" data-id="${esc(c.id)}">Edit</button>
                  <button class="btn btn-sm btn-ghost-danger" data-act="delete" data-id="${esc(c.id)}">Delete</button>
                </div></article>`;
            })
            .join("")}</div>`
        : empty("No classes yet", "Create your first class, e.g. “Diploma in Pharmacy — Year One”, then add course units to it.", `<button class="btn btn-primary" data-act="new">＋ Create a class</button>`)
    }`;
  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const cls = btn.dataset.id ? look.classById.get(btn.dataset.id) : null;
    if (btn.dataset.act === "new" && (await editClass(ctx))) ctx.refresh();
    if (btn.dataset.act === "edit" && (await editClass(ctx, cls))) ctx.refresh();
    if (btn.dataset.act === "delete" && (await deleteClass(ctx, cls))) ctx.refresh();
    if (btn.dataset.act === "import") await importShare(ctx);
  });
  if (params.new) {
    history.replaceState(null, "", "#/classes");
    if (await editClass(ctx)) ctx.refresh();
  }
}

async function renderDetail(ctx, el, id) {
  const cls = await ctx.db.get("classes", id);
  if (!cls) {
    el.innerHTML = empty("Class not found", "It may have been deleted.", `<a class="btn" href="#/classes">Back to classes</a>`);
    return;
  }
  const [units, students, materials, resources] = await Promise.all([
    ctx.db.byIndex("units", "classId", id),
    ctx.db.byIndex("students", "classId", id),
    ctx.db.byIndex("materials", "classId", id),
    ctx.db.byIndex("resources", "classId", id),
  ]);
  units.sort((a, b) => (a.code || a.title).localeCompare(b.code || b.title));
  el.innerHTML = `
    <nav class="crumbs"><a href="#/classes">Classes</a> › ${esc(cls.name)}</nav>
    ${pageHead(cls.name, [cls.level, cls.year].filter(Boolean).join(" · "), `
      <button class="btn" data-act="share">Share…</button>
      <button class="btn" data-act="edit">Edit class</button>
      <button class="btn btn-primary" data-act="unit">＋ Add course unit</button>`)}
    ${cls.description ? `<p>${esc(cls.description)}</p>` : ""}
    <section class="stats stats-sm">
      <a class="stat" href="#/students?class=${esc(id)}"><span class="stat-value">${students.length}</span><span class="stat-label">Students</span></a>
      <a class="stat" href="#/library?class=${esc(id)}"><span class="stat-value">${resources.length}</span><span class="stat-label">Resources</span></a>
      <a class="stat" href="#/notes?class=${esc(id)}"><span class="stat-value">${materials.length}</span><span class="stat-label">Materials</span></a>
      <a class="stat" href="#/reports?class=${esc(id)}"><span class="stat-value">◔</span><span class="stat-label">Reports</span></a>
    </section>
    <h2>Course units</h2>
    ${
      units.length
        ? `<div class="cards">${units
            .map(
              (u) => `<article class="card"><h3><a href="#/units/${esc(u.id)}">${esc(u.code ? u.code + " — " : "")}${esc(u.title)}</a></h3>
              <p class="muted">${esc(u.description || "")}</p>
              <p class="meta">${badge(`${(u.topics || []).length} topics`)} ${u.hours ? badge(`${u.hours} h`) : ""} ${materials.filter((m) => m.unitId === u.id).length ? badge(`${materials.filter((m) => m.unitId === u.id).length} materials`) : ""}</p>
              <div class="card-actions"><a class="btn btn-sm" href="#/units/${esc(u.id)}">Open</a><a class="btn btn-sm" href="#/assistant?unit=${esc(u.id)}">✦ Generate</a></div></article>`,
            )
            .join("")}</div>`
        : empty("No course units", "Add course units such as “Pharmacology I”, then attach the curriculum, textbooks and references.", `<button class="btn btn-primary" data-act="unit">＋ Add course unit</button>`)
    }
    <p class="muted small">Created ${fmtDate(cls.createdAt)} · last changed ${fmtDate(cls.updatedAt)}</p>`;
  el.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "edit" && (await editClass(ctx, cls))) ctx.refresh();
    if (act === "unit") {
      const unit = await editUnit(ctx, null, id);
      if (unit) ctx.navigate(`units/${unit.id}`);
    }
    if (act === "share") await exportShare(ctx, cls);
  });
}
