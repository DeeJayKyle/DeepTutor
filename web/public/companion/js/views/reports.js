import { exportDocument } from "../exporters.js";
import { classReport, DEFAULT_SCHEME } from "../grading.js";
import { renderHtml } from "../markdown.js";
import { busy, empty, options, pageHead } from "../ui.js";
import { esc, fmtDate } from "../util.js";
import { studentName } from "./students.js";

/** Build a Markdown report from computed figures only. */
export function reportMarkdown(report, { title, subtitle }) {
  const s = report.summary;
  const lines = [
    `# ${title}`,
    subtitle ? `*${subtitle} — generated ${new Date().toLocaleDateString()} from recorded marks.*` : "",
    "## Summary",
    "| Measure | Value |",
    "| --- | --- |",
    `| Students | ${s.students} (${s.graded} with marks) |`,
    `| Class average | ${s.mean ?? "—"}% |`,
    `| Median | ${s.median ?? "—"}% |`,
    `| Highest / lowest | ${s.max ?? "—"}% / ${s.min ?? "—"}% |`,
    `| Standard deviation | ${s.sd ?? "—"} |`,
    `| Pass rate | ${s.passRate ?? "—"}% (${s.passCount} passed, ${s.failCount} below pass mark) |`,
    "",
    "## Grade distribution",
    "| Grade | Students |",
    "| --- | --- |",
    ...Object.entries(s.distribution).map(([g, n]) => `| ${g} | ${n} |`),
    "",
    "## Assessments",
    "| Assessment | Recorded | Missing | Mean % | Median % | Min % | Max % | Pass rate % |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.assessmentStats.map((a) => `| ${a.assessment.title} | ${a.count} | ${a.missing} | ${a.mean ?? "—"} | ${a.median ?? "—"} | ${a.min ?? "—"} | ${a.max ?? "—"} | ${a.passRate ?? "—"} |`),
    "",
  ];
  if (report.topics.length) {
    lines.push("## Performance by topic", "| Topic | Mean % | Responses | Assessments |", "| --- | --- | --- | --- |");
    lines.push(...report.topics.map((t) => `| ${t.topic} | ${t.mean} | ${t.responses} | ${t.assessments.join(", ")} |`), "");
  }
  const ins = report.insights;
  lines.push("## Findings");
  if (ins.strong.length) lines.push(`- **Performing well:** ${ins.strong.map((x) => `${x.name} (${x.final}%)`).join(", ")}`);
  if (ins.support.length) lines.push(`- **Need additional support:** ${ins.support.map((x) => `${x.name} (${x.final}%, ${x.reason})`).join(", ")}`);
  if (ins.weakTopics.length) lines.push(`- **Topics that may need re-teaching:** ${ins.weakTopics.map((t) => `${t.topic} (${t.mean}%)`).join(", ")}`);
  if (ins.gap) lines.push(`- **Difference between assessments:** ${ins.gap.highest} averaged ${ins.gap.highMean}% and ${ins.gap.lowest} averaged ${ins.gap.lowMean}% (gap ${ins.gap.difference} points).`);
  if (ins.improving.length) lines.push(`- **Improving trend:** ${ins.improving.join(", ")}`);
  if (ins.declining.length) lines.push(`- **Declining trend:** ${ins.declining.join(", ")}`);
  if (ins.incomplete.length) lines.push(`- **Incomplete records:** ${ins.incomplete.map((x) => `${x.name} (${x.missing} missing)`).join(", ")}`);
  if (lines[lines.length - 1] === "## Findings") lines.push("- Not enough marks recorded to draw findings yet.");
  lines.push(
    "",
    "## Student results",
    "| Rank | Reg. no. | Student | Final % | Grade | Remark | Trend |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...[...report.results]
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
      .map((r) => `| ${r.rank ?? "—"} | ${r.student.regNo || "—"} | ${studentName(r.student)} | ${r.final ?? "—"} | ${r.grade} | ${r.remark} | ${r.trend} |`),
    "",
    "## Method",
    ...report.formula.map((f) => `- ${f}`),
  );
  return lines.filter((l) => l !== "").join("\n").replace(/\n(#+ )/g, "\n\n$1").replace(/\n\|/g, "\n|");
}

function bars(dist) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  return `<div class="bars">${Object.entries(dist)
    .map(([g, n]) => `<div class="bar-row"><span class="bar-label">${esc(g)}</span><span class="bar"><span style="width:${(n / total) * 100}%"></span></span><span class="bar-val">${n}</span></div>`)
    .join("")}</div>`;
}

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  if (!look.classes.length) {
    el.innerHTML = `${pageHead("Reports & Analytics")}${empty("No data yet", "Create classes, register students and record marks to see reports.")}`;
    return;
  }
  const unitFromParam = look.unitById.get(params.unit);
  const classId = unitFromParam?.classId || (look.classById.has(params.class) ? params.class : look.classes[0].id);
  const classUnits = look.units.filter((u) => u.classId === classId);
  const unitId = unitFromParam ? unitFromParam.id : "";
  const [roster, allAssessments, allMarks, scheme] = await Promise.all([
    ctx.db.byIndex("students", "classId", classId),
    ctx.db.byIndex("assessments", "classId", classId),
    ctx.db.all("marks"),
    ctx.db.getSetting("gradingScheme", DEFAULT_SCHEME),
  ]);
  const assessments = allAssessments.filter((a) => !unitId || a.unitId === unitId);
  const ids = new Set(assessments.map((a) => a.id));
  const marks = allMarks.filter((m) => ids.has(m.assessmentId));
  const cls = look.classById.get(classId);
  const unit = look.unitById.get(unitId);
  const title = `Performance report — ${unit ? look.unitLabel(unit) : cls.name}`;
  const subtitle = `${cls.name}${unit ? "" : " (all course units)"}`;

  const head = `${pageHead("Reports & Analytics", "Every figure is calculated from the marks you recorded.", `
      <button class="btn" data-export="pdf" ${marks.length ? "" : "disabled"}>⤓ PDF</button>
      <button class="btn btn-primary" data-export="docx" ${marks.length ? "" : "disabled"}>⤓ Word report</button>`)}
    <div class="filters">
      <label class="field inline"><span>Class</span><select data-nav="class">${options(look.classOptions, classId)}</select></label>
      <label class="field inline"><span>Course unit</span><select data-nav="unit">${options(classUnits.map((u) => [u.id, look.unitLabel(u)]), unitId, { blank: "All units" })}</select></label>
    </div>`;

  if (!marks.length) {
    el.innerHTML = head + empty("No marks recorded", roster.length ? "Record marks in Students & Marks to generate this report." : "Register students and record marks first.", `<a class="btn btn-primary" href="#/students?class=${esc(classId)}${unitId ? `&unit=${esc(unitId)}` : ""}&tab=marks">Record marks</a>`);
  } else {
    const report = classReport(roster, assessments, marks, scheme);
    const s = report.summary;
    const ins = report.insights;
    el.innerHTML = `${head}
      <section class="stats">
        <div class="stat"><span class="stat-value">${s.mean ?? "—"}%</span><span class="stat-label">Class average</span></div>
        <div class="stat"><span class="stat-value">${s.passRate ?? "—"}%</span><span class="stat-label">Pass rate (≥ ${scheme.passMark}%)</span></div>
        <div class="stat"><span class="stat-value">${s.max ?? "—"}%</span><span class="stat-label">Highest</span></div>
        <div class="stat"><span class="stat-value">${s.min ?? "—"}%</span><span class="stat-label">Lowest</span></div>
        <div class="stat"><span class="stat-value">${s.graded}/${s.students}</span><span class="stat-label">Students with marks</span></div>
      </section>
      <div class="grid-2">
        <section class="card"><h2>Grade distribution</h2>${bars(s.distribution)}</section>
        <section class="card"><h2>Findings</h2>
          <ul class="findings">
            ${ins.support.length ? `<li class="warn"><strong>Need additional support (${ins.support.length}):</strong> ${ins.support.map((x) => `${esc(x.name)} <span class="muted">(${x.final}%, ${esc(x.reason)})</span>`).join(", ")}</li>` : `<li class="ok">No students are below or close to the pass mark.</li>`}
            ${ins.strong.length ? `<li class="ok"><strong>Performing well:</strong> ${ins.strong.map((x) => `${esc(x.name)} (${x.final}%)`).join(", ")}</li>` : ""}
            ${ins.weakTopics.length ? `<li class="warn"><strong>Topics needing attention:</strong> ${ins.weakTopics.map((t) => `${esc(t.topic)} (${t.mean}%)`).join(", ")}</li>` : report.topics.length ? `<li class="ok">All tagged topics average above ${scheme.passMark + 10}%.</li>` : `<li class="muted">Tag assessments with topics to see weak topics.</li>`}
            ${ins.gap ? `<li><strong>Between assessments:</strong> ${esc(ins.gap.highest)} (${ins.gap.highMean}%) vs ${esc(ins.gap.lowest)} (${ins.gap.lowMean}%) — a ${ins.gap.difference}-point gap.</li>` : ""}
            ${ins.declining.length ? `<li class="warn"><strong>Declining trend:</strong> ${ins.declining.map(esc).join(", ")}</li>` : ""}
            ${ins.improving.length ? `<li class="ok"><strong>Improving trend:</strong> ${ins.improving.map(esc).join(", ")}</li>` : ""}
            ${ins.incomplete.length ? `<li><strong>Missing marks:</strong> ${ins.incomplete.length} student(s) have unrecorded assessments.</li>` : ""}
          </ul></section>
      </div>
      <section class="card"><h2>Assessments</h2><div class="prose">${renderHtml(reportMarkdown(report, { title: "", subtitle: "" }).split("## Assessments")[1].split("## ")[0])}</div></section>
      ${report.topics.length ? `<section class="card"><h2>Performance by topic</h2>${bars(Object.fromEntries(report.topics.map((t) => [t.topic, t.mean])))}<p class="muted small">Bar length = mean percentage across assessments that cover the topic.</p></section>` : ""}
      <section class="card formula"><h2>Method</h2><ul>${report.formula.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>
      <p><a class="btn" href="#/students?class=${esc(classId)}${unitId ? `&unit=${esc(unitId)}` : ""}&tab=sheet">Open full marksheet</a> <span class="muted small">Report date ${fmtDate(new Date())}</span></p>`;
    el.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-export]");
      if (!btn) return;
      busy(btn, true, "Exporting…");
      try {
        const res = await exportDocument(btn.dataset.export, reportMarkdown(report, { title, subtitle }), { title, subtitle, author: ctx.user, reviewed: true });
        if (res.saved) {
          await ctx.db.log("export-report", title);
          ctx.toast(`Report saved to your ${res.method}.`, "success");
        }
      } catch (err) {
        ctx.toast(`Export failed: ${err.message}`, "error", 8000);
      } finally {
        busy(btn, false);
      }
    });
  }
  el.querySelectorAll("[data-nav]").forEach((sel) =>
    sel.addEventListener("change", () => {
      location.hash = sel.dataset.nav === "class" ? `#/reports?class=${sel.value}` : sel.value ? `#/reports?unit=${sel.value}` : `#/reports?class=${classId}`;
    }),
  );
}
