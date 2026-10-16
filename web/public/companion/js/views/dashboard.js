import { classReport, DEFAULT_SCHEME } from "../grading.js";
import { badge, empty, pageHead } from "../ui.js";
import { esc, fmtBytes, fmtDate, fmtDateTime, MAX_CLASSES } from "../util.js";

export async function render(ctx, el) {
  const { db } = ctx;
  const look = await ctx.lookups();
  const [resources, materials, students, assessments, marks, lastBackup, scheme] = await Promise.all([
    db.all("resources"),
    db.all("materials"),
    db.all("students"),
    db.all("assessments"),
    db.all("marks"),
    db.getSetting("lastBackup"),
    db.getSetting("gradingScheme", DEFAULT_SCHEME),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = assessments.filter((a) => a.date && a.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const recentResources = [...resources].sort((a, b) => String(b.openedAt || b.updatedAt).localeCompare(String(a.openedAt || a.updatedAt))).slice(0, 5);
  const recentNotes = materials.filter((m) => m.kind === "lecture_notes" || m.kind === "topic_summary").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

  // Recent performance: one line per course unit that has marks.
  const perf = [];
  for (const unit of look.units) {
    const unitAssessments = assessments.filter((a) => a.unitId === unit.id);
    if (!unitAssessments.length) continue;
    const ids = new Set(unitAssessments.map((a) => a.id));
    const unitMarks = marks.filter((m) => ids.has(m.assessmentId));
    if (!unitMarks.length) continue;
    const roster = students.filter((s) => s.classId === unit.classId);
    const report = classReport(roster, unitAssessments, unitMarks, scheme);
    const latest = unitMarks.reduce((acc, m) => (m.updatedAt > acc ? m.updatedAt : acc), "");
    perf.push({ unit, report, latest });
  }
  perf.sort((a, b) => b.latest.localeCompare(a.latest));

  let storage = null;
  try {
    storage = await navigator.storage?.estimate?.();
  } catch {
    storage = null;
  }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  const stat = (label, value, href, note = "") =>
    `<a class="stat" href="#/${href}"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span>${note ? `<span class="stat-note">${esc(note)}</span>` : ""}</a>`;

  el.innerHTML = `
    ${pageHead(`Welcome${ctx.user && ctx.user !== "local" ? ", " + ctx.user : ""}`, "Your teaching workspace at a glance.")}
    <section class="stats">
      ${stat("Classes", `${look.classes.length}/${MAX_CLASSES}`, "classes")}
      ${stat("Course units", look.units.length, "units")}
      ${stat("Library items", resources.length, "library", `${resources.filter((r) => r.offline).length} offline`)}
      ${stat("Teaching materials", materials.length, "notes", `${materials.filter((m) => m.status !== "reviewed").length} awaiting review`)}
      ${stat("Students", students.length, "students")}
      ${stat("Assessments", assessments.length, "students")}
    </section>

    <section class="card quick">
      <h2>Quick actions</h2>
      <div class="quick-grid">
        <a class="quick-btn" href="#/classes?new=1">＋ New class</a>
        <a class="quick-btn" href="#/library?upload=1">⇪ Upload material</a>
        <a class="quick-btn" href="#/assistant?kind=lecture_notes">✦ Generate lecture notes</a>
        <a class="quick-btn" href="#/assistant?kind=exam">✓ Create an exam</a>
        <a class="quick-btn" href="#/assistant?kind=quiz">? Create a quiz</a>
        <a class="quick-btn" href="#/assistant?kind=presentation">▭ Build slides</a>
        <a class="quick-btn" href="#/students">✎ Record marks</a>
        <a class="quick-btn" href="#/backup">⇅ Back up now</a>
      </div>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>Upcoming assessments</h2>
        ${
          upcoming.length
            ? `<ul class="list">${upcoming
                .map((a) => `<li><a href="#/students?class=${esc(a.classId)}&assessment=${esc(a.id)}">${esc(a.title)}</a><span class="muted"> · ${esc(look.unitLabel(look.unitById.get(a.unitId)) || look.classById.get(a.classId)?.name || "")}</span><span class="right">${fmtDate(a.date)}</span></li>`)
                .join("")}</ul>`
            : `<p class="muted">No dated assessments ahead. Add dates to assessments in Students &amp; Marks.</p>`
        }
      </section>
      <section class="card">
        <h2>Recent student performance</h2>
        ${
          perf.length
            ? `<ul class="list">${perf
                .slice(0, 5)
                .map(
                  ({ unit, report }) =>
                    `<li><a href="#/reports?unit=${esc(unit.id)}">${esc(look.unitLabel(unit))}</a><span class="right">avg ${report.summary.mean ?? "—"}% · pass ${report.summary.passRate ?? "—"}%</span></li>`,
                )
                .join("")}</ul>`
            : `<p class="muted">Reports appear here once marks are recorded.</p>`
        }
      </section>
      <section class="card">
        <h2>Recently used resources</h2>
        ${
          recentResources.length
            ? `<ul class="list">${recentResources.map((r) => `<li><a href="#/library?open=${esc(r.id)}">${esc(r.title)}</a> ${r.offline ? badge("offline", "ok") : ""}<span class="right muted">${fmtDate(r.openedAt || r.updatedAt)}</span></li>`).join("")}</ul>`
            : empty("No resources yet", "Upload textbooks, curricula and references to the Digital Library.", `<a class="btn btn-primary" href="#/library?upload=1">Upload</a>`)
        }
      </section>
      <section class="card">
        <h2>Recently generated lecture notes</h2>
        ${
          recentNotes.length
            ? `<ul class="list">${recentNotes.map((m) => `<li><a href="#/material/${esc(m.id)}?from=notes">${esc(m.title)}</a> ${m.status === "reviewed" ? badge("reviewed", "ok") : badge("draft", "warn")}<span class="right muted">${fmtDate(m.updatedAt)}</span></li>`).join("")}</ul>`
            : `<p class="muted">Generate notes with the AI Teaching Assistant.</p>`
        }
      </section>
      <section class="card">
        <h2>Device &amp; storage</h2>
        <dl class="kv">
          <dt>Connection</dt><dd>${navigator.onLine ? (ctx.serverReachable ? "Online" : "Online, server unreachable") : "Offline"}</dd>
          <dt>AI service</dt><dd>${ctx.ai.available ? `Ready${ctx.ai.model ? ` (${esc(ctx.ai.model)})` : ""}` : ctx.serverReachable ? "Not configured on server" : "Unavailable offline"}</dd>
          <dt>Storage used</dt><dd>${storage ? `${fmtBytes(storage.usage)} of ${fmtBytes(storage.quota)} available to this app` : "Not reported by this browser"}</dd>
          <dt>Storage protection</dt><dd>${persisted ? "Persistent (the browser will not clear it automatically)" : "Best effort — keep regular backups"}</dd>
        </dl>
      </section>
      <section class="card">
        <h2>Backup &amp; sync</h2>
        <dl class="kv">
          <dt>Last cloud backup</dt><dd>${lastBackup ? `${fmtDateTime(lastBackup.at)} (${esc(lastBackup.label || "")})` : "Never — your data exists only on this device"}</dd>
          <dt>Last restore</dt><dd>${fmtDateTime((await db.getSetting("lastRestore"))?.at)}</dd>
        </dl>
        <a class="btn" href="#/backup">Open Backup &amp; Sync</a>
      </section>
    </div>`;
}
