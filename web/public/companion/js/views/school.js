import { api } from "../api.js";
import { classReport, DEFAULT_SCHEME } from "../grading.js";
import { openSharedClass, publishClass, ROLE_LABELS, syncClass } from "../shared.js";
import { badge, busy, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { esc, fmtDateTime } from "../util.js";
import { resolveConflicts } from "./backup.js";

const CLASS_ROLES = [
  ["lead", "Lead"],
  ["teacher", "Teacher"],
  ["assistant", "Assistant"],
  ["viewer", "Viewer"],
];

/** Conflict / confirmation callback used by syncClass. */
export function syncResolver(ctx) {
  return async (plan, label) => {
    if (!plan) return (await confirmDialog(label, { title: "Sync", confirm: "Discard and download", danger: true })) ? {} : null;
    return resolveConflicts(ctx, plan, label);
  };
}

export async function runSync(ctx, classId) {
  try {
    const msg = await syncClass(ctx.db, classId, syncResolver(ctx));
    ctx.toast(msg, "success", 6000);
  } catch (err) {
    ctx.toast(`Sync failed: ${err.message}`, "error", 9000);
  }
}

export async function render(ctx, el, params) {
  if (!navigator.onLine || !ctx.serverReachable) {
    el.innerHTML = `${pageHead("School & Sharing", "Shared classes with per-class roles for your school.")}
      ${empty("Connect to use school features", "Your shared classes stay available offline under Classes. Managing the school and syncing changes need an internet connection.")}`;
    return;
  }
  if (params.id) return renderSchool(ctx, el, params.id, params.tab || "classes");
  let data;
  try {
    data = await api.schools();
  } catch (err) {
    el.innerHTML = `${pageHead("School & Sharing")}<div class="alert alert-error">${esc(err.message)}</div>`;
    return;
  }
  el.innerHTML = `
    ${pageHead("School & Sharing", "Work with colleagues on shared classes. Your own classes stay private unless you publish them.", `<button class="btn btn-primary" data-act="new">＋ Create a school</button>`)}
    <div class="card small">
      <strong>How sharing works.</strong> A school admin adds tutors by their DeepTutor account name. Any member can publish a class; the class lead (or a school admin) gives colleagues a role:
      <ul>${Object.entries(ROLE_LABELS).map(([, l]) => `<li>${esc(l)}</li>`).join("")}</ul>
      Shared classes are copied to each member's device for offline use. Use <em>Sync</em> to exchange changes — differing records are shown for review, never overwritten silently. School admins see shared classes only, never members' private workspaces.
    </div>
    ${
      data.schools.length
        ? `<div class="cards">${data.schools
            .map(
              (s) => `<article class="card"><h2><a href="#/school/${esc(s.id)}">${esc(s.name)}</a></h2>
              <p>${badge(s.role === "admin" ? "School admin" : "Tutor", s.role === "admin" ? "ok" : "")} ${badge(`${s.members} members`)} ${badge(`${s.classes} shared classes`)}</p>
              <div class="card-actions"><a class="btn btn-sm" href="#/school/${esc(s.id)}">Open</a></div></article>`,
            )
            .join("")}</div>`
        : empty("You are not in a school yet", "Create one for your institution, or ask your school admin to add your account name: " + data.user)
    }`;
  el.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-act=new]")) return;
    const v = await modal({ title: "Create a school", body: field("School / institution name", `<input name="name" required minlength="2" maxlength="160">`), submit: "Create" });
    if (!v) return;
    try {
      const s = await api.createSchool(v.name.trim());
      ctx.toast("School created. You are its admin.", "success");
      ctx.navigate(`school/${s.id}`);
    } catch (err) {
      ctx.toast(err.message, "error");
    }
  });
}

async function renderSchool(ctx, el, sid, tab) {
  let data;
  try {
    data = await api.school(sid);
  } catch (err) {
    el.innerHTML = `<nav class="crumbs"><a href="#/school">School & Sharing</a></nav><div class="alert alert-error">${esc(err.message)}</div>`;
    return;
  }
  const isAdmin = data.my_role === "admin";
  const school = data.school;
  const localClasses = await ctx.db.all("classes");
  const localById = new Map(localClasses.map((c) => [c.id, c]));
  const publishable = localClasses.filter((c) => !c.shared);
  const tabs = [["classes", `Shared classes (${data.classes.length})`], ["members", `Members (${data.members.length})`], ...(isAdmin ? [["report", "Institution report"], ["activity", "Activity"]] : [])];

  let body = "";
  if (tab === "classes") {
    body = data.classes.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Your role</th><th>Team</th><th>Last change</th><th></th></tr></thead><tbody>${data.classes
          .map((c) => {
            const local = localById.get(c.id);
            return `<tr data-id="${esc(c.id)}"><td><strong>${esc(c.name)}</strong>${local ? `<div class="small"><a href="#/classes/${esc(c.id)}">on this device</a> · rev ${local.shared?.rev ?? "?"} of ${c.rev}</div>` : `<div class="small muted">not on this device</div>`}</td>
              <td>${badge(c.my_role, c.my_role === "lead" ? "ok" : "")}</td>
              <td class="small">${c.roles.map((r) => `${esc(r.username)} (${esc(r.role)})`).join(", ")}</td>
              <td class="small">${esc(c.updated_by)}<br>${fmtDateTime(c.updated_at)}</td>
              <td class="right nowrap">${local ? `<button class="btn btn-sm btn-primary" data-act="sync">⇅ Sync</button>` : `<button class="btn btn-sm btn-primary" data-act="open">⤓ Download</button>`}
                ${c.my_role === "lead" ? `<button class="btn btn-sm" data-act="roles">Roles…</button> <button class="btn btn-sm btn-ghost-danger" data-act="unshare" aria-label="Remove from school">✕</button>` : ""}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : empty("No shared classes yet", "Publish one of your classes so colleagues can teach and mark it with you.");
  } else if (tab === "members") {
    body = `<div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>School role</th><th>Added</th><th></th></tr></thead><tbody>${data.members
      .map(
        (m) => `<tr data-user="${esc(m.username)}"><td>${esc(m.username)}</td><td>${isAdmin ? `<select data-act="member-role">${options([["tutor", "Tutor"], ["admin", "School admin"]], m.role)}</select>` : esc(m.role)}</td><td class="small">${fmtDateTime(m.added_at)}</td>
        <td class="right">${isAdmin || m.username === ctx.user ? `<button class="btn btn-sm btn-ghost-danger" data-act="remove-member">${m.username === ctx.user ? "Leave" : "Remove"}</button>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div>
      ${isAdmin ? `<form class="card row" id="add-member"><label class="field"><span>DeepTutor account name</span><input name="username" required maxlength="120"></label><label class="field"><span>Role</span><select name="role">${options([["tutor", "Tutor"], ["admin", "School admin"]], "tutor")}</select></label><div class="form-actions"><button class="btn btn-primary" type="submit">Add member</button></div></form>
      <p class="small muted">New tutors first need a DeepTutor account; the server administrator creates accounts under DeepTutor → Admin → Users.</p>` : ""}`;
  } else if (tab === "report") {
    body = `<div id="report"><div class="loading"><span class="spinner"></span> Calculating…</div></div>`;
  } else {
    const audit = await api.schoolAudit(sid);
    body = `<table class="table small"><tbody>${audit.entries.map((a) => `<tr><td class="nowrap">${fmtDateTime(a.at)}</td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table>`;
  }

  el.innerHTML = `
    <nav class="crumbs"><a href="#/school">School & Sharing</a> › ${esc(school.name)}</nav>
    ${pageHead(school.name, isAdmin ? "You are a school admin." : "You are a tutor in this school.", `<button class="btn btn-primary" data-act="publish" ${publishable.length ? "" : "disabled title='All your classes are already shared'"}>⇪ Publish a class</button>`)}
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${k === tab ? "active" : ""}" href="#/school/${esc(sid)}?tab=${k}">${esc(l)}</a>`).join("")}</div>
    <div class="tab-body">${body}</div>`;

  if (tab === "report") drawReport(ctx, el.querySelector("#report"), sid);

  el.querySelector("#add-member")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.setMember(sid, e.target.username.value.trim(), e.target.role.value);
      ctx.toast("Member added.", "success");
      ctx.refresh();
    } catch (err) {
      ctx.toast(err.message, "error", 7000);
    }
  });
  el.querySelectorAll("[data-act=member-role]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      try {
        await api.setMember(sid, sel.closest("tr").dataset.user, sel.value);
        ctx.toast("Role updated.", "success");
      } catch (err) {
        ctx.toast(err.message, "error", 7000);
        ctx.refresh();
      }
    }),
  );

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.tagName === "SELECT") return;
    const cid = btn.closest("tr")?.dataset.id;
    const c = data.classes.find((x) => x.id === cid);
    try {
      switch (btn.dataset.act) {
        case "publish": {
          const v = await modal({
            title: "Publish a class to " + school.name,
            body: `${field("Class", `<select name="classId" required>${options(publishable.map((x) => [x.id, x.name]), publishable[0]?.id)}</select>`)}
              <p class="small">The class, its course units, materials, library catalogue (not the files), students, assessments and marks are copied to the school so members you give a role can work on them. You become the class lead.</p>`,
            submit: "Publish",
          });
          if (!v) return;
          busy(btn, true, "Publishing…");
          await publishClass(ctx.db, v.classId, school);
          ctx.toast("Class published. Assign roles to colleagues next.", "success");
          ctx.refresh();
          break;
        }
        case "open":
          busy(btn, true, "Downloading…");
          await openSharedClass(ctx.db, school, cid);
          ctx.toast(`“${c.name}” is now on this device.`, "success");
          ctx.refresh();
          break;
        case "sync":
          busy(btn, true, "Syncing…");
          await runSync(ctx, cid);
          ctx.refresh();
          break;
        case "roles": {
          const v = await modal({
            title: `Roles — ${c.name}`,
            body: `<table class="table"><tbody>${data.members
              .map((m) => {
                const current = c.roles.find((r) => r.username === m.username)?.role || "";
                return `<tr><td>${esc(m.username)}${m.role === "admin" ? ' <span class="muted small">(school admin — always lead)</span>' : ""}</td><td><select name="role:${esc(m.username)}">${options(CLASS_ROLES, current, { blank: "No access" })}</select></td></tr>`;
              })
              .join("")}</tbody></table>`,
            submit: "Save roles",
          });
          if (!v) return;
          for (const [key, value] of Object.entries(v)) {
            const username = key.slice(5);
            const before = c.roles.find((r) => r.username === username)?.role || "";
            if (value !== before) await api.setClassRole(sid, cid, username, value || null);
          }
          ctx.toast("Roles saved.", "success");
          ctx.refresh();
          break;
        }
        case "unshare":
          if (await confirmDialog(`Remove “${c.name}” from ${school.name}? Members keep their local copies but can no longer sync. Your own copy becomes a private class again.`, { confirm: "Remove from school", typed: c.name })) {
            await api.deleteSharedClass(sid, cid);
            const local = await ctx.db.get("classes", cid);
            if (local) await ctx.db.putRaw("classes", [{ ...local, shared: undefined }]);
            ctx.refresh();
          }
          break;
        case "remove-member": {
          const username = btn.closest("tr").dataset.user;
          if (await confirmDialog(username === ctx.user ? `Leave ${school.name}?` : `Remove ${username} from ${school.name}? Their class roles are removed too.`, { confirm: username === ctx.user ? "Leave" : "Remove" })) {
            await api.removeMember(sid, username);
            if (username === ctx.user) ctx.navigate("school");
            else ctx.refresh();
          }
          break;
        }
        default:
      }
    } catch (err) {
      ctx.toast(err.message, "error", 8000);
    } finally {
      busy(btn, false);
    }
  });
}

async function drawReport(ctx, host, sid) {
  try {
    const scheme = await ctx.db.getSetting("gradingScheme", DEFAULT_SCHEME);
    const { classes } = await api.schoolReport(sid);
    if (!classes.length) {
      host.innerHTML = empty("No shared classes", "Institution reports cover the classes published to this school.");
      return;
    }
    const rows = classes.map((c) => {
      const b = c.bundle;
      const r = classReport(b.students || [], b.assessments || [], b.marks || [], scheme);
      return { c, b, s: r.summary, weak: r.topics.filter((t) => t.mean < scheme.passMark + 10).map((t) => t.topic) };
    });
    const total = rows.reduce((a, r) => a + r.s.students, 0);
    host.innerHTML = `<p class="small muted">Calculated from marks recorded in shared classes, with your grading rules (pass mark ${scheme.passMark}%).</p>
      <div class="stats"><div class="stat"><span class="stat-value">${rows.length}</span><span class="stat-label">Shared classes</span></div>
      <div class="stat"><span class="stat-value">${total}</span><span class="stat-label">Students</span></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Units</th><th>Students</th><th>Assessments</th><th>Average</th><th>Pass rate</th><th>Topics needing attention</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${esc(r.c.name)}</td><td>${(r.b.units || []).length}</td><td>${r.s.students}</td><td>${(r.b.assessments || []).length}</td><td>${r.s.mean ?? "—"}%</td><td>${r.s.passRate ?? "—"}%</td><td class="small">${esc(r.weak.join(", ") || "—")}</td></tr>`)
        .join("")}</tbody></table></div>`;
  } catch (err) {
    host.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}
