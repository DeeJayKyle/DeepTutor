import { exportXlsx, saveBlob } from "../exporters.js";
import { ASSESSMENT_CATEGORIES, classReport, DEFAULT_SCHEME, markKey, validateScore } from "../grading.js";
import { badge, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { esc, fmtDate, parseCsv, slug, toCsv } from "../util.js";
import { can, roleOf } from "../shared.js";

const CAT_LABEL = Object.fromEntries(ASSESSMENT_CATEGORIES);

export function studentName(s) {
  return [s.firstName, s.lastName].filter(Boolean).join(" ");
}

async function editStudent(ctx, classId, s = {}) {
  const look = await ctx.lookups();
  const values = await modal({
    title: s.id ? "Edit student" : "Register student",
    body: `
      <div class="row">${field("First name", `<input name="firstName" required maxlength="80" value="${esc(s.firstName)}">`)}
      ${field("Last name", `<input name="lastName" maxlength="80" value="${esc(s.lastName)}">`)}</div>
      <div class="row">${field("Registration / admission no.", `<input name="regNo" maxlength="40" value="${esc(s.regNo)}">`)}
      ${field("Class", `<select name="classId" required>${options(look.classOptions, s.classId || classId)}</select>`)}</div>
      <div class="row">${field("Email", `<input name="email" type="email" maxlength="160" value="${esc(s.email)}">`)}
      ${field("Phone", `<input name="phone" maxlength="40" value="${esc(s.phone)}">`)}</div>
      ${field("Notes", `<textarea name="notes" rows="2" maxlength="2000">${esc(s.notes)}</textarea>`)}`,
    validate: async (v) => {
      if (!v.firstName.trim()) return "Enter the student's first name.";
      if (v.regNo.trim()) {
        const clash = (await ctx.db.all("students")).find((x) => x.regNo && x.regNo.toLowerCase() === v.regNo.trim().toLowerCase() && x.id !== s.id);
        if (clash) return `Registration number ${v.regNo} is already used by ${studentName(clash)}.`;
      }
      return null;
    },
  });
  if (!values) return null;
  if (s.id && s.classId !== values.classId) {
    const marks = await ctx.db.byIndex("marks", "studentId", s.id);
    if (marks.length && !(await confirmDialog(`Moving ${studentName(s)} to another class keeps their ${marks.length} recorded mark(s) under the old class's assessments. Continue?`, { confirm: "Move", danger: false }))) return null;
  }
  const saved = await ctx.db.put("students", {
    ...s,
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    regNo: values.regNo.trim(),
    classId: values.classId,
    email: values.email.trim(),
    phone: values.phone.trim(),
    notes: values.notes.trim(),
  });
  await ctx.db.log(s.id ? "edit-student" : "register-student", studentName(saved));
  return saved;
}

async function importStudents(ctx, classId) {
  const values = await modal({
    title: "Import students from CSV",
    body: `<p class="small">Columns (header row required): <code>reg_no, first_name, last_name, email, phone</code>. Only first_name is required. Rows with an existing registration number are skipped.</p>
      ${field("CSV file", `<input type="file" name="file" accept=".csv,text/csv" required>`)}`,
    submit: "Import",
  });
  if (!values?.file?.[0]) return;
  const rows = parseCsv(await values.file[0].text());
  if (rows.length < 2) return ctx.toast("The file has no data rows.", "error");
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s.-]+/g, "_"));
  const col = (names) => header.findIndex((h) => names.includes(h));
  const idx = {
    regNo: col(["reg_no", "regno", "registration_number", "admission_no", "admission_number", "id", "student_id"]),
    firstName: col(["first_name", "firstname", "given_name", "name"]),
    lastName: col(["last_name", "lastname", "surname", "family_name"]),
    email: col(["email", "e_mail"]),
    phone: col(["phone", "mobile", "telephone"]),
  };
  if (idx.firstName < 0) return ctx.toast("No first_name column found in the header row.", "error", 7000);
  const existing = await ctx.db.all("students");
  const regs = new Set(existing.map((s) => (s.regNo || "").toLowerCase()).filter(Boolean));
  let added = 0;
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? "").trim() : "");
    const firstName = get("firstName");
    const regNo = get("regNo");
    if (!firstName || (regNo && regs.has(regNo.toLowerCase()))) {
      skipped += 1;
      continue;
    }
    await ctx.db.put("students", { classId, firstName, lastName: get("lastName"), regNo, email: get("email"), phone: get("phone") });
    if (regNo) regs.add(regNo.toLowerCase());
    added += 1;
  }
  await ctx.db.log("import-students", `${added} added, ${skipped} skipped`);
  ctx.toast(`${added} student(s) imported${skipped ? `, ${skipped} skipped (missing name or duplicate reg. no.)` : ""}.`, "success", 6000);
  ctx.refresh();
}

async function editAssessment(ctx, classId, unitId, a = {}) {
  const look = await ctx.lookups();
  const classUnits = look.units.filter((u) => u.classId === classId);
  if (!classUnits.length) {
    ctx.toast("Add a course unit to this class first.", "error");
    return null;
  }
  const unit = look.unitById.get(a.unitId || unitId) || classUnits[0];
  const topicChoices = (unit.topics || []).map((t) => t.title);
  const marked = a.id ? (await ctx.db.byIndex("marks", "assessmentId", a.id)).filter((m) => m.score !== null && m.score !== undefined) : [];
  const highest = marked.reduce((mx, m) => Math.max(mx, Number(m.score)), 0);
  const values = await modal({
    title: a.id ? "Edit assessment" : "New assessment",
    body: `
      ${field("Title", `<input name="title" required maxlength="160" value="${esc(a.title)}" placeholder="e.g. CAT 1, Practical 2, Final examination">`)}
      <div class="row">${field("Course unit", `<select name="unitId" required>${options(classUnits.map((u) => [u.id, look.unitLabel(u)]), unit.id)}</select>`)}
      ${field("Category", `<select name="category">${options(ASSESSMENT_CATEGORIES, a.category || "coursework")}</select>`)}</div>
      <div class="row row-3">${field("Maximum score", `<input name="maxScore" type="number" min="1" max="10000" step="any" required value="${esc(a.maxScore ?? 100)}">`)}
      ${field("Weight", `<input name="weight" type="number" min="0" max="1000" step="any" value="${esc(a.weight ?? "")}" placeholder="e.g. 30">`, "Relative weight in the final mark; leave blank for 0.")}
      ${field("Date", `<input name="date" type="date" value="${esc(a.date)}">`)}</div>
      ${topicChoices.length ? `<p class="label">Topics assessed (used to find weak topics)</p><div class="checks checks-scroll">${topicChoices.map((t) => `<label class="check"><input type="checkbox" data-multi name="topics" value="${esc(t)}" ${(a.topics || []).includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}</div>` : `<p class="muted small">Add topics to the course unit to analyse performance by topic.</p>`}`,
    validate: (v) => {
      const max = Number(v.maxScore);
      if (!v.title.trim()) return "Enter a title.";
      if (!(max > 0)) return "Maximum score must be greater than 0.";
      if (v.weight !== "" && !(Number(v.weight) >= 0)) return "Weight cannot be negative.";
      if (max < highest) return `Recorded marks go up to ${highest}; the maximum cannot be lower.`;
      return null;
    },
  });
  if (!values) return null;
  const saved = await ctx.db.put("assessments", {
    ...a,
    classId,
    unitId: values.unitId,
    title: values.title.trim(),
    category: values.category,
    maxScore: Number(values.maxScore),
    weight: values.weight === "" ? 0 : Number(values.weight),
    date: values.date,
    topics: values.topics || [],
  });
  await ctx.db.log(a.id ? "edit-assessment" : "create-assessment", saved.title);
  return saved;
}

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  if (!look.classes.length) {
    el.innerHTML = `${pageHead("Students & Marks")}${empty("Create a class first", "Students are organised by class.", `<a class="btn btn-primary" href="#/classes?new=1">＋ New class</a>`)}`;
    return;
  }
  const classId = look.classById.has(params.class) ? params.class : look.classes[0].id;
  const classUnits = look.units.filter((u) => u.classId === classId);
  const unitId = classUnits.some((u) => u.id === params.unit) ? params.unit : "";
  const tab = params.tab || (params.assessment ? "marks" : "roster");
  const cls = look.classById.get(classId);
  const canStudents = can(cls, "students");
  const canAssess = can(cls, "assessments");
  const canMarks = can(cls, "marks");
  const [roster, allAssessments, scheme] = await Promise.all([
    ctx.db.byIndex("students", "classId", classId),
    ctx.db.byIndex("assessments", "classId", classId),
    ctx.db.getSetting("gradingScheme", DEFAULT_SCHEME),
  ]);
  roster.sort((a, b) => (a.lastName || a.firstName).localeCompare(b.lastName || b.firstName));
  const assessments = allAssessments.filter((a) => !unitId || a.unitId === unitId).sort((a, b) => String(a.date || a.createdAt).localeCompare(String(b.date || b.createdAt)));
  const q = (extra) => {
    const p = new URLSearchParams({ class: classId, ...(unitId ? { unit: unitId } : {}), tab, ...extra });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `#/students?${p}`;
  };

  let body = "";
  if (tab === "roster") {
    body = roster.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Reg. no.</th><th>Name</th><th>Email</th><th>Phone</th><th></th></tr></thead><tbody>${roster
          .map((s, i) => `<tr data-id="${esc(s.id)}"><td>${i + 1}</td><td>${esc(s.regNo || "—")}</td><td>${esc(studentName(s))}</td><td class="small">${esc(s.email || "")}</td><td class="small">${esc(s.phone || "")}</td>
            <td class="right nowrap">${canStudents ? `<button class="btn btn-sm" data-act="edit-student">Edit</button> <button class="btn btn-sm btn-ghost-danger" data-act="delete-student" aria-label="Delete">✕</button>` : ""}</td></tr>`)
          .join("")}</tbody></table></div>`
      : empty("No students in this class", "Register students one by one or import a CSV class list.", canStudents ? `<button class="btn btn-primary" data-act="add-student">＋ Register student</button>` : "");
  } else if (tab === "marks") {
    const current = assessments.find((a) => a.id === params.assessment) || assessments[0];
    if (!assessments.length) {
      body = empty("No assessments yet", "Create an assessment (e.g. CAT 1, practical, final exam) with its maximum score and weight, then record marks.", canAssess ? `<button class="btn btn-primary" data-act="add-assessment">＋ New assessment</button>` : "");
    } else if (!roster.length) {
      body = empty("No students", "Register students before recording marks.", `<a class="btn btn-primary" href="${q({ tab: "roster" })}">Go to class list</a>`);
    } else {
      const marks = await ctx.db.byIndex("marks", "assessmentId", current.id);
      const byStudent = new Map(marks.map((m) => [m.studentId, m]));
      body = `
        <div class="assess-bar">
          <label class="field inline"><span>Assessment</span><select data-act="pick-assessment">${options(assessments.map((a) => [a.id, `${a.title} (${look.unitLabel(look.unitById.get(a.unitId))})`]), current.id)}</select></label>
          <span class="muted small">${esc(CAT_LABEL[current.category] || current.category)} · out of <strong>${current.maxScore}</strong> · weight ${current.weight || 0} · ${fmtDate(current.date)}</span>
          <span class="spacer"></span>
          ${canAssess ? `<button class="btn btn-sm" data-act="edit-assessment" data-id="${esc(current.id)}">Edit</button>
          <button class="btn btn-sm" data-act="lock" data-id="${esc(current.id)}">${current.locked ? "🔒 Unlock marks" : "🔓 Lock marks"}</button>
          <button class="btn btn-sm btn-ghost-danger" data-act="delete-assessment" data-id="${esc(current.id)}">Delete</button>` : ""}
        </div>
        ${current.locked ? `<div class="alert alert-info">Marks for this assessment are locked to prevent accidental changes. Unlock to edit.</div>` : ""}
        <form class="marks-form" data-assessment="${esc(current.id)}" data-max="${current.maxScore}">
        <div class="table-wrap"><table class="table marks"><thead><tr><th>Reg. no.</th><th>Student</th><th>Score / ${current.maxScore}</th><th>%</th><th>Absent</th><th>Exempt</th></tr></thead><tbody>
        ${roster
          .map((s) => {
            const m = byStudent.get(s.id) || {};
            const pct = m.score !== null && m.score !== undefined ? ((m.score / current.maxScore) * 100).toFixed(1) : "";
            return `<tr data-student="${esc(s.id)}"><td>${esc(s.regNo || "—")}</td><td>${esc(studentName(s))}</td>
              <td><input class="score" name="score" inputmode="decimal" value="${esc(m.score ?? "")}" ${current.locked || !canMarks ? "disabled" : ""} aria-label="Score for ${esc(studentName(s))}"><div class="cell-error" aria-live="polite"></div></td>
              <td class="pct">${pct}</td>
              <td><input type="checkbox" name="absent" ${m.absent ? "checked" : ""} ${current.locked || !canMarks ? "disabled" : ""} aria-label="Absent"></td>
              <td><input type="checkbox" name="exempt" ${m.exempt ? "checked" : ""} ${current.locked || !canMarks ? "disabled" : ""} aria-label="Exempt"></td></tr>`;
          })
          .join("")}</tbody></table></div>
        ${!canMarks ? `<div class="alert alert-info">Your role in this shared class (${esc(roleOf(cls))}) is read-only for marks.</div>` : ""}
        ${current.locked || !canMarks ? "" : `<div class="form-actions"><button type="submit" class="btn btn-primary">Save marks</button><span class="muted small" id="marks-note">Blank = not yet recorded. Exempt = excluded from the final mark.</span></div>`}
        </form>`;
    }
  } else {
    const allMarks = (await ctx.db.all("marks")).filter((m) => assessments.some((a) => a.id === m.assessmentId));
    const report = classReport(roster, assessments, allMarks, scheme);
    body = assessments.length && roster.length
      ? `<div class="table-wrap"><table class="table marksheet"><thead><tr><th>Rank</th><th>Reg. no.</th><th>Student</th>${assessments.map((a) => `<th title="${esc(CAT_LABEL[a.category])} · weight ${a.weight || 0}">${esc(a.title)}<div class="muted small">/${a.maxScore}${a.weight ? ` · w${a.weight}` : ""}</div></th>`).join("")}<th>Final %</th><th>Grade</th><th>Trend</th></tr></thead><tbody>
          ${report.results
            .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
            .map((r) => `<tr><td>${r.rank ?? "—"}</td><td>${esc(r.student.regNo || "—")}</td><td>${esc(studentName(r.student))}</td>${r.components.map((c) => `<td>${c.exempt ? "EX" : c.score ?? (c.absent ? "ABS" : "—")}</td>`).join("")}<td><strong>${r.final ?? "—"}</strong></td><td>${r.passed === false ? badge(r.grade, "bad") : badge(r.grade, r.passed ? "ok" : "")}</td><td class="small">${esc(r.trend)}</td></tr>`)
            .join("")}</tbody></table></div>
          <div class="card formula"><h3>How results are calculated</h3><ul>${report.formula.map((f) => `<li>${esc(f)}</li>`).join("")}</ul><p class="small muted">Change the grading rules in Settings.</p></div>`
      : empty("Nothing to show yet", "Add students and assessments, then record marks.");
  }

  el.innerHTML = `
    ${pageHead("Students & Marks", "Class lists, assessments, marks entry and marksheets.", `
      ${tab === "roster" ? `<button class="btn" data-act="export-students">⤓ Export list</button>${canStudents ? `<button class="btn" data-act="import-students">⇪ Import CSV</button><button class="btn btn-primary" data-act="add-student">＋ Register student</button>` : ""}` : ""}
      ${tab === "marks" && canAssess ? `<button class="btn btn-primary" data-act="add-assessment">＋ New assessment</button>` : ""}
      ${tab === "sheet" ? `<button class="btn btn-primary" data-act="export-sheet">⤓ Export marksheet (.xlsx)</button>` : ""}`)}
    <div class="filters">
      <label class="field inline"><span>Class</span><select data-nav="class">${options(look.classOptions, classId)}</select></label>
      <label class="field inline"><span>Course unit</span><select data-nav="unit">${options(classUnits.map((u) => [u.id, look.unitLabel(u)]), unitId, { blank: "All units" })}</select></label>
    </div>
    <div class="tabs" role="tablist">
      <a class="tab ${tab === "roster" ? "active" : ""}" href="${q({ tab: "roster" })}">Class list (${roster.length})</a>
      <a class="tab ${tab === "marks" ? "active" : ""}" href="${q({ tab: "marks" })}">Assessments &amp; marks entry (${assessments.length})</a>
      <a class="tab ${tab === "sheet" ? "active" : ""}" href="${q({ tab: "sheet" })}">Marksheet &amp; grades</a>
    </div>
    <div class="tab-body">${body}</div>`;

  el.querySelectorAll("[data-nav]").forEach((s) =>
    s.addEventListener("change", () => {
      const p = new URLSearchParams({ class: s.dataset.nav === "class" ? s.value : classId, tab });
      if (s.dataset.nav === "unit" && s.value) p.set("unit", s.value);
      location.hash = `#/students?${p}`;
    }),
  );
  el.querySelector("[data-act=pick-assessment]")?.addEventListener("change", (e) => (location.hash = q({ tab: "marks", assessment: e.target.value })));

  const form = el.querySelector(".marks-form");
  if (form) {
    const max = Number(form.dataset.max);
    const check = (input) => {
      const res = validateScore(input.value, max);
      const row = input.closest("tr");
      row.querySelector(".cell-error").textContent = res.ok ? "" : res.error;
      input.classList.toggle("invalid", !res.ok);
      row.querySelector(".pct").textContent = res.ok && res.value !== null ? ((res.value / max) * 100).toFixed(1) : "";
      return res;
    };
    form.addEventListener("input", (e) => {
      if (e.target.name === "score") check(e.target);
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.name === "score") {
        e.preventDefault();
        const inputs = [...form.querySelectorAll("input.score")];
        inputs[inputs.indexOf(e.target) + 1]?.focus();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const assessmentId = form.dataset.assessment;
      const rows = [...form.querySelectorAll("tr[data-student]")];
      const results = rows.map((row) => ({ row, res: check(row.querySelector("input.score")) }));
      const bad = results.filter((r) => !r.res.ok);
      if (bad.length) {
        bad[0].row.querySelector("input.score").focus();
        ctx.toast(`${bad.length} invalid score(s). Fix the highlighted entries — nothing was saved.`, "error", 6000);
        return;
      }
      const existing = new Map((await ctx.db.byIndex("marks", "assessmentId", assessmentId)).map((m) => [m.studentId, m]));
      let changed = 0;
      for (const { row, res } of results) {
        const studentId = row.dataset.student;
        const absent = row.querySelector("[name=absent]").checked;
        const exempt = row.querySelector("[name=exempt]").checked;
        const old = existing.get(studentId);
        const next = { score: res.value, absent, exempt };
        if (old && old.score === next.score && Boolean(old.absent) === absent && Boolean(old.exempt) === exempt) continue;
        if (!old && next.score === null && !absent && !exempt) continue;
        await ctx.db.put("marks", { ...(old || {}), id: markKey(assessmentId, studentId), assessmentId, studentId, ...next });
        changed += 1;
      }
      if (changed) await ctx.db.log("record-marks", `${changed} change(s) on ${assessments.find((a) => a.id === assessmentId)?.title}`);
      ctx.toast(changed ? `Saved ${changed} change(s).` : "No changes to save.", changed ? "success" : "info");
    });
  }

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.tagName === "SELECT") return;
    const id = btn.dataset.id || btn.closest("tr")?.dataset.id;
    switch (btn.dataset.act) {
      case "add-student":
        if (await editStudent(ctx, classId)) ctx.refresh();
        break;
      case "edit-student":
        if (await editStudent(ctx, classId, roster.find((s) => s.id === id))) ctx.refresh();
        break;
      case "delete-student": {
        const s = roster.find((x) => x.id === id);
        const marks = await ctx.db.byIndex("marks", "studentId", id);
        if (await confirmDialog(`Remove ${studentName(s)}${marks.length ? ` and their ${marks.length} recorded mark(s)` : ""}? This cannot be undone.`, { confirm: "Remove student", typed: marks.length ? studentName(s) : undefined })) {
          await ctx.db.deleteStudent(id);
          await ctx.db.log("delete-student", studentName(s));
          ctx.refresh();
        }
        break;
      }
      case "import-students":
        await importStudents(ctx, classId);
        break;
      case "export-students": {
        const cls = look.classById.get(classId);
        await ctx.db.log("export-students", cls.name);
        const res = await saveBlob(
          new Blob([toCsv([["reg_no", "first_name", "last_name", "email", "phone"], ...roster.map((s) => [s.regNo, s.firstName, s.lastName, s.email, s.phone])])], { type: "text/csv" }),
          `${slug(cls.name)}-students.csv`,
        );
        if (res.saved) ctx.toast(`Class list saved to your ${res.method}.`, "success");
        break;
      }
      case "add-assessment": {
        const a = await editAssessment(ctx, classId, unitId);
        if (a) location.hash = q({ tab: "marks", assessment: a.id });
        break;
      }
      case "edit-assessment":
        if (await editAssessment(ctx, classId, unitId, assessments.find((a) => a.id === id))) ctx.refresh();
        break;
      case "lock": {
        const a = assessments.find((x) => x.id === id);
        await ctx.db.put("assessments", { ...a, locked: !a.locked });
        await ctx.db.log(a.locked ? "unlock-marks" : "lock-marks", a.title);
        ctx.refresh();
        break;
      }
      case "delete-assessment": {
        const a = assessments.find((x) => x.id === id);
        const marks = await ctx.db.byIndex("marks", "assessmentId", id);
        if (await confirmDialog(`Delete “${a.title}” and its ${marks.length} recorded mark(s)?`, { confirm: "Delete assessment", typed: marks.length ? a.title : undefined })) {
          await ctx.db.deleteAssessment(id);
          await ctx.db.log("delete-assessment", a.title);
          location.hash = q({ tab: "marks" });
        }
        break;
      }
      case "export-sheet": {
        const allMarks = (await ctx.db.all("marks")).filter((m) => assessments.some((a) => a.id === m.assessmentId));
        const report = classReport(roster, assessments, allMarks, scheme);
        const cls = look.classById.get(classId);
        const unit = look.unitById.get(unitId);
        const columns = [
          { header: "Rank", key: "rank", width: 7 },
          { header: "Reg. no.", key: "reg", width: 14 },
          { header: "Student", key: "name", width: 26 },
          ...assessments.map((a) => ({ header: `${a.title} (/${a.maxScore}${a.weight ? `, w${a.weight}` : ""})`, key: a.id, width: 16 })),
          { header: "Final %", key: "final", width: 10 },
          { header: "Grade", key: "grade", width: 8 },
          { header: "Remark", key: "remark", width: 14 },
        ];
        const rows = report.results.map((r) => ({
          rank: r.rank ?? "",
          reg: r.student.regNo || "",
          name: studentName(r.student),
          ...Object.fromEntries(r.components.map((c) => [c.assessmentId, c.exempt ? "EX" : c.score ?? (c.absent ? "ABS" : "")])),
          final: r.final ?? "",
          grade: r.grade,
          remark: r.remark,
        }));
        try {
          const blob = await exportXlsx(
            [
              { name: "Marksheet", columns, rows, notes: report.formula },
              {
                name: "Assessment statistics",
                columns: [
                  { header: "Assessment", key: "t", width: 26 },
                  { header: "Recorded", key: "n", width: 10 },
                  { header: "Mean %", key: "mean", width: 10 },
                  { header: "Median %", key: "median", width: 10 },
                  { header: "Min %", key: "min", width: 8 },
                  { header: "Max %", key: "max", width: 8 },
                  { header: "Pass rate %", key: "pass", width: 12 },
                ],
                rows: report.assessmentStats.map((s) => ({ t: s.assessment.title, n: s.count, mean: s.mean ?? "", median: s.median ?? "", min: s.min ?? "", max: s.max ?? "", pass: s.passRate ?? "" })),
              },
            ],
            { author: ctx.user },
          );
          const res = await saveBlob(blob, `${slug(cls.name)}${unit ? "-" + slug(unit.code || unit.title) : ""}-marksheet.xlsx`);
          if (res.saved) {
            await ctx.db.log("export-marksheet", cls.name);
            ctx.toast(`Marksheet saved to your ${res.method}.`, "success");
          }
        } catch (err) {
          ctx.toast(`Export failed: ${err.message}`, "error", 8000);
        }
        break;
      }
      default:
    }
  });
}
