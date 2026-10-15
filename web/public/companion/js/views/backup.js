import { api } from "../api.js";
import { applyRestore, createSnapshot, parseSnapshot, planRestore, serializeSnapshot } from "../backup.js";
import { DATA_STORES, FILE_STORE } from "../db.js";
import { saveBlob } from "../exporters.js";
import { badge, busy, confirmDialog, empty, field, modal, pageHead } from "../ui.js";
import { esc, fmtBytes, fmtDateTime } from "../util.js";

const GROUPS = [
  ["structure", "Classes and course units", ["classes", "units"]],
  ["materials", "Lecture notes, exams, quizzes and assignments", ["materials"]],
  ["students", "Students, assessments and marks", ["students", "assessments", "marks"]],
  ["library", "Library catalogue and extracted text", ["resources"]],
  ["files", "Library files (can be large)", [FILE_STORE]],
  ["research", "Saved research and videos", ["research"]],
  ["settings", "Settings and activity log", ["settings", "audit"]],
];

function describe(record) {
  return record.title || record.name || [record.firstName, record.lastName].filter(Boolean).join(" ") || record.regNo || record.id;
}

const STORE_LABEL = { classes: "Class", units: "Course unit", materials: "Material", students: "Student", assessments: "Assessment", marks: "Mark", resources: "Library item", research: "Saved link", settings: "Setting", files: "File" };

/** Ask the tutor how to resolve each conflict. Resolves to a map or null. */
export async function resolveConflicts(ctx, plan, title) {
  const summary = `<ul class="small">
    <li><strong>${plan.added.length}</strong> record(s) will be added</li>
    <li><strong>${plan.identical}</strong> already identical</li>
    <li><strong>${plan.localOnly}</strong> exist only on this device and will be kept</li>
    <li><strong>${plan.conflicts.length}</strong> differ between this device and the backup</li></ul>`;
  if (!plan.conflicts.length) {
    const ok = await modal({ title, body: `${summary}<p>No conflicts were found. Nothing on this device will be overwritten.</p>`, submit: "Restore" });
    return ok ? {} : null;
  }
  const rows = plan.conflicts
    .map((c, i) => {
      const key = `${c.store}|${c.id}`;
      return `<tr><td>${esc(STORE_LABEL[c.store] || c.store)}</td><td>${esc(describe(c.local))}${c.store === "marks" ? ` <span class="muted small">${esc(c.local.score)} → ${esc(c.incoming.score)}</span>` : ""}</td>
        <td class="small">${fmtDateTime(c.local.updatedAt)}${c.newer === "local" ? " " + badge("newer", "ok") : ""}</td>
        <td class="small">${fmtDateTime(c.incoming.updatedAt)}${c.newer === "incoming" ? " " + badge("newer", "ok") : ""}</td>
        <td class="nowrap"><label><input type="radio" name="r${i}" value="local" data-key="${esc(key)}" checked> Keep mine</label>
          <label><input type="radio" name="r${i}" value="incoming" data-key="${esc(key)}"> Use backup</label>
          ${["marks", "settings"].includes(c.store) ? "" : `<label><input type="radio" name="r${i}" value="both" data-key="${esc(key)}"> Keep both</label>`}</td></tr>`;
    })
    .join("");
  const resolutions = {};
  const result = await modal({
    title,
    wide: true,
    body: `${summary}<p>Choose what to do with each conflicting record. Nothing is overwritten unless you choose “Use backup”.</p>
      <p><button type="button" class="btn btn-sm" data-bulk="newer">Choose the newer copy for all</button> <button type="button" class="btn btn-sm" data-bulk="local">Keep mine for all</button></p>
      <div class="table-wrap conflicts"><table class="table"><thead><tr><th>Type</th><th>Record</th><th>This device</th><th>Backup</th><th>Resolution</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    submit: "Apply restore",
    onMount: (form) => {
      form.addEventListener("click", (e) => {
        const bulk = e.target.closest("[data-bulk]")?.dataset.bulk;
        if (!bulk) return;
        plan.conflicts.forEach((c, i) => {
          const want = bulk === "local" ? "local" : c.newer === "incoming" ? "incoming" : "local";
          const input = form.querySelector(`input[name=r${i}][value=${want}]`);
          if (input) input.checked = true;
        });
      });
    },
    validate: (_v, form) => {
      form.querySelectorAll("input[type=radio]:checked").forEach((r) => (resolutions[r.dataset.key] = r.value));
      return null;
    },
  });
  return result ? resolutions : null;
}

async function localStores(db, stores) {
  const out = {};
  for (const s of stores) out[s] = await db.all(s);
  return out;
}

async function restoreSnapshot(ctx, data, label) {
  const stores = Object.keys(data.stores).filter((s) => DATA_STORES.includes(s) || s === FILE_STORE);
  const local = await localStores(ctx.db, stores);
  const plan = planRestore(local, data.stores);
  const resolutions = await resolveConflicts(ctx, plan, `Restore “${label}”`);
  if (!resolutions) return null;
  const result = await applyRestore(ctx.db, plan, resolutions);
  await ctx.db.setSetting("lastRestore", { at: new Date().toISOString(), label, result });
  await modal({
    title: "Restore complete",
    submit: "",
    cancel: "Close",
    body: `<ul><li>${result.added} record(s) added</li><li>${result.replaced} replaced with the backup copy</li><li>${result.duplicated} kept as both copies</li><li>${result.kept} conflicting record(s) kept as they were on this device</li><li>${result.identical} already identical</li></ul>`,
  });
  return result;
}

function selectionBody(last = []) {
  return GROUPS.map(([key, label]) => `<label class="check"><input type="checkbox" name="${key}" ${last.length ? (last.includes(key) ? "checked" : "") : key !== "files" ? "checked" : ""}> ${esc(label)}</label>`).join("");
}

function storesFor(values) {
  return GROUPS.filter(([key]) => values[key]).flatMap(([, , stores]) => stores);
}

export async function render(ctx, el) {
  const lastBackup = await ctx.db.getSetting("lastBackup");
  const lastRestore = await ctx.db.getSetting("lastRestore");
  const lastSelection = (await ctx.db.getSetting("backupSelection")) || [];
  const online = navigator.onLine && ctx.serverReachable;
  let backups = [];
  let listError = "";
  if (online) {
    try {
      backups = (await api.listBackups()).backups;
    } catch (err) {
      listError = err.message;
    }
  }
  const audit = (await ctx.db.all("audit")).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);

  el.innerHTML = `
    ${pageHead("Backup & Sync", "Your data lives on this device. Cloud backups and synchronisation happen only when you choose.")}
    <div class="grid-2">
      <section class="card">
        <h2>Cloud backup</h2>
        <p class="small">Stored privately in your own account on the Tutor Companion server, with an integrity check (SHA-256). The last 20 versions are kept.</p>
        <dl class="kv"><dt>Last backup</dt><dd>${lastBackup ? `${fmtDateTime(lastBackup.at)} · ${esc(lastBackup.label)} · ${fmtBytes(lastBackup.size)}` : "Never"}</dd>
        <dt>Last restore</dt><dd>${lastRestore ? `${fmtDateTime(lastRestore.at)} · ${esc(lastRestore.label)}` : "Never"}</dd></dl>
        <div class="form-actions">
          <button class="btn btn-primary" data-act="backup" ${online ? "" : "disabled"}>⇪ Back up now…</button>
          <button class="btn" data-act="sync" ${online ? "" : "disabled"}>⇅ Synchronise…</button>
        </div>
        ${online ? "" : `<p class="muted small">${navigator.onLine ? "Sign in to DeepTutor to use cloud backup." : "Cloud backup needs an internet connection. Use a backup file instead."}</p>`}
      </section>
      <section class="card">
        <h2>Backup file (works offline)</h2>
        <p class="small">Save a complete copy to this device, a USB drive or any folder — and restore it on another device.</p>
        <div class="form-actions">
          <button class="btn" data-act="file-backup">⤓ Save backup file…</button>
          <button class="btn" data-act="file-restore">⇪ Restore from file…</button>
        </div>
      </section>
    </div>
    <section class="card">
      <h2>Available cloud backups</h2>
      ${
        listError
          ? `<div class="alert alert-error">${esc(listError)}</div>`
          : !online
            ? `<p class="muted">Connect to the internet and sign in to see your cloud backups.</p>`
            : backups.length
              ? `<div class="table-wrap"><table class="table"><thead><tr><th>Created</th><th>Label</th><th>Device</th><th>Contents</th><th>Size</th><th></th></tr></thead><tbody>${backups
                  .map(
                    (b) => `<tr data-id="${esc(b.id)}"><td>${fmtDateTime(b.created_at)}</td><td>${esc(b.label)}</td><td class="small">${esc(b.device)}</td>
                    <td class="small">${Object.entries(b.counts).map(([k, n]) => `${n} ${esc(k)}`).join(", ")}</td><td>${fmtBytes(b.size)}</td>
                    <td class="right nowrap"><button class="btn btn-sm btn-primary" data-act="restore">Restore…</button> <button class="btn btn-sm btn-ghost-danger" data-act="delete" aria-label="Delete">✕</button></td></tr>`,
                  )
                  .join("")}</tbody></table></div>`
              : empty("No cloud backups yet", "Create your first backup so you can restore your work on a new device.")
      }
    </section>
    <section class="card">
      <h2>Recent activity on this device</h2>
      ${audit.length ? `<table class="table small"><tbody>${audit.map((a) => `<tr><td class="nowrap">${fmtDateTime(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No activity recorded yet.</p>`}
    </section>`;

  const device = `${navigator.userAgentData?.platform || navigator.platform || "device"} · ${/Android/i.test(navigator.userAgent) ? "Android" : /Windows/i.test(navigator.userAgent) ? "Windows" : "browser"}`;

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === "backup" || act === "file-backup") {
        const values = await modal({
          title: act === "backup" ? "Back up to the cloud" : "Save a backup file",
          body: `<p class="label">Select the data to include</p>${selectionBody(lastSelection)}${act === "backup" ? field("Label", `<input name="label" maxlength="120" value="Backup ${new Date().toLocaleDateString()}">`) : ""}`,
          submit: act === "backup" ? "Upload backup" : "Save file",
          validate: (v) => (storesFor(v).length ? null : "Select at least one kind of data."),
        });
        if (!values) return;
        await ctx.db.setSetting("backupSelection", GROUPS.filter(([k]) => values[k]).map(([k]) => k));
        busy(btn, true, "Preparing…");
        const stores = storesFor(values);
        const snapshot = await createSnapshot(ctx.db, { stores: stores.filter((s) => s !== FILE_STORE), includeFiles: stores.includes(FILE_STORE), user: ctx.user });
        const { payload, sha256 } = await serializeSnapshot(snapshot);
        if (act === "backup") {
          const res = await api.createBackup({ label: values.label, device, sha256, payload });
          await ctx.db.setSetting("lastBackup", { at: res.created_at, label: res.label, size: res.size, id: res.id });
          await ctx.db.log("cloud-backup", `${res.label} (${fmtBytes(res.size)})`);
          ctx.toast(`Backup uploaded and verified (${fmtBytes(res.size)}).`, "success", 6000);
        } else {
          const res = await saveBlob(new Blob([JSON.stringify({ sha256, payload })], { type: "application/json" }), `tutor-companion-backup-${new Date().toISOString().slice(0, 10)}.json`);
          if (!res.saved) return;
          await ctx.db.log("file-backup", res.name);
          ctx.toast(`Backup file saved to your ${res.method}.`, "success");
        }
        ctx.refresh();
      }
      if (act === "file-restore") {
        const values = await modal({ title: "Restore from a backup file", body: field("Backup file", `<input type="file" name="file" accept=".json,application/json" required>`), submit: "Check file" });
        if (!values?.file?.[0]) return;
        const text = await values.file[0].text();
        let wrapper;
        try {
          wrapper = JSON.parse(text);
        } catch {
          throw new Error("This file is not a valid backup.");
        }
        const data = wrapper.payload ? await parseSnapshot(wrapper.payload, wrapper.sha256) : await parseSnapshot(text);
        if (await restoreSnapshot(ctx, data, values.file[0].name)) ctx.refresh();
      }
      if (act === "restore") {
        const id = btn.closest("tr").dataset.id;
        busy(btn, true, "Downloading…");
        const record = await api.getBackup(id);
        const data = await parseSnapshot(record.payload, record.sha256);
        busy(btn, false);
        if (await restoreSnapshot(ctx, data, record.label)) {
          await ctx.db.log("cloud-restore", record.label);
          ctx.refresh();
        }
      }
      if (act === "delete") {
        const id = btn.closest("tr").dataset.id;
        if (await confirmDialog("Delete this cloud backup permanently?", { confirm: "Delete backup" })) {
          await api.deleteBackup(id);
          ctx.toast("Backup deleted.", "success");
          ctx.refresh();
        }
      }
      if (act === "sync") {
        const ok = await confirmDialog(
          "Synchronising will (1) fetch your latest cloud backup, (2) let you review any records that differ from this device, then (3) upload the merged result as a new backup. Nothing is overwritten without your choice.",
          { title: "Synchronise", confirm: "Start", danger: false },
        );
        if (!ok) return;
        busy(btn, true, "Synchronising…");
        const list = (await api.listBackups()).backups;
        if (list.length) {
          const record = await api.getBackup(list[0].id);
          const data = await parseSnapshot(record.payload, record.sha256);
          const result = await restoreSnapshot(ctx, data, `${record.label} (latest cloud copy)`);
          if (!result) return;
        }
        const stores = GROUPS.filter(([k]) => (lastSelection.length ? lastSelection : GROUPS.map(([g]) => g).filter((g) => g !== "files")).includes(k)).flatMap(([, , s]) => s);
        const snapshot = await createSnapshot(ctx.db, { stores: stores.filter((s) => s !== FILE_STORE), includeFiles: stores.includes(FILE_STORE), user: ctx.user });
        const { payload, sha256 } = await serializeSnapshot(snapshot);
        const res = await api.createBackup({ label: `Sync ${new Date().toLocaleString()}`, device, sha256, payload });
        await ctx.db.setSetting("lastBackup", { at: res.created_at, label: res.label, size: res.size, id: res.id });
        await ctx.db.log("sync", res.label);
        ctx.toast("Synchronised: this device and the cloud now hold the same data.", "success", 6000);
        ctx.refresh();
      }
    } catch (err) {
      ctx.toast(err.message, "error", 8000);
    } finally {
      busy(btn, false);
    }
  });
}
