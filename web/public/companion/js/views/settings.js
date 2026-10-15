import { DATA_STORES, FILE_STORE } from "../db.js";
import { DEFAULT_SCHEME, formulaText, validateScheme } from "../grading.js";
import { confirmDialog, field, options, pageHead } from "../ui.js";
import { esc, fmtBytes } from "../util.js";

function bandRow(b = {}) {
  return `<tr><td><input name="grade" maxlength="6" value="${esc(b.grade)}" aria-label="Grade" required></td>
    <td><input name="min" type="number" min="0" max="100" step="any" value="${esc(b.min ?? "")}" aria-label="Minimum %" required></td>
    <td><input name="remark" maxlength="40" value="${esc(b.remark)}" aria-label="Remark"></td>
    <td><button type="button" class="btn btn-sm btn-ghost-danger" data-act="del-band" aria-label="Remove band">✕</button></td></tr>`;
}

export async function render(ctx, el) {
  const profile = (await ctx.db.getSetting("profile")) || {};
  const scheme = (await ctx.db.getSetting("gradingScheme")) || DEFAULT_SCHEME;
  let storage = null;
  try {
    storage = await navigator.storage?.estimate?.();
  } catch {
    storage = null;
  }
  el.innerHTML = `
    ${pageHead("Settings")}
    <div class="grid-2">
      <form class="card" id="profile-form">
        <h2>Tutor profile</h2>
        ${field("Name shown on documents", `<input name="name" maxlength="120" value="${esc(profile.name || "")}">`)}
        ${field("Institution", `<input name="institution" maxlength="160" value="${esc(profile.institution || "")}">`)}
        ${field("Department", `<input name="department" maxlength="160" value="${esc(profile.department || "")}">`)}
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save profile</button></div>
      </form>
      <section class="card">
        <h2>Account &amp; workspace</h2>
        <dl class="kv">
          <dt>Signed in as</dt><dd>${esc(ctx.user)}${ctx.role ? ` (${esc(ctx.role)})` : ""}</dd>
          <dt>Workspace</dt><dd>Private to this account on this device</dd>
          <dt>AI model</dt><dd>${ctx.ai.available ? esc(ctx.ai.model || "configured") : "Not available"} <span class="muted small">(configured on the server; keys never reach this device)</span></dd>
          <dt>Storage</dt><dd>${storage ? `${fmtBytes(storage.usage)} used of ${fmtBytes(storage.quota)}` : "Unknown"}</dd>
        </dl>
        <div class="form-actions"><a class="btn" href="/chat">Open DeepTutor</a> <a class="btn" href="/login?next=/companion/index.html">Switch account</a></div>
      </section>
    </div>

    <form class="card" id="scheme-form">
      <h2>Grading rules</h2>
      <p class="small muted">Used for every final mark, grade, pass rate and report. Adjust them to your institution's system.</p>
      <div class="row row-3">
        ${field("Pass mark (%)", `<input name="passMark" type="number" min="0" max="100" step="any" value="${esc(scheme.passMark)}" required>`)}
        ${field("Missing marks", `<select name="missing">${options([["zero", "Count as 0"], ["exclude", "Exclude from the calculation"]], scheme.missing)}</select>`)}
        ${field("Decimal places", `<select name="decimals">${options([["0", "0"], ["1", "1"], ["2", "2"]], String(scheme.decimals ?? 1))}</select>`)}
      </div>
      <table class="table bands"><thead><tr><th>Grade</th><th>Minimum %</th><th>Remark</th><th></th></tr></thead><tbody>${[...scheme.bands].sort((a, b) => b.min - a.min).map(bandRow).join("")}</tbody></table>
      <p><button type="button" class="btn btn-sm" data-act="add-band">＋ Add grade band</button> <button type="button" class="btn btn-sm" data-act="reset">Reset to default</button></p>
      <div class="scheme-errors"></div>
      <div class="card formula"><h3>Formula</h3><ul>${formulaText(scheme).map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save grading rules</button></div>
    </form>

    <section class="card">
      <h2>Install Tutor Companion</h2>
      <ul class="small">
        <li><strong>Windows:</strong> open this page in Microsoft Edge or Chrome and choose <em>Install Tutor Companion</em> (the ⊕ icon in the address bar, or the Install button at the top of the app). It then opens from the Start menu like any desktop program and works offline.</li>
        <li><strong>Android:</strong> open this page in Chrome, tap ⋮ › <em>Install app</em> (or <em>Add to Home screen</em>). It appears in your app drawer and works offline.</li>
        <li><strong>Web:</strong> use it directly in any modern browser. Sign in once while online; afterwards your saved data opens even without internet.</li>
      </ul>
    </section>

    <section class="card danger-zone">
      <h2>Erase this device's workspace</h2>
      <p class="small">Deletes every class, student, mark, document and library file stored for <strong>${esc(ctx.user)}</strong> on this device. Cloud backups are not affected. Make a backup first.</p>
      <button class="btn btn-danger" data-act="erase">Erase local data…</button>
    </section>`;

  el.querySelector("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await ctx.db.setSetting("profile", { name: f.elements.name.value.trim(), institution: f.elements.institution.value.trim(), department: f.elements.department.value.trim() });
    ctx.toast("Profile saved.", "success");
  });

  const schemeForm = el.querySelector("#scheme-form");
  const tbody = schemeForm.querySelector(".bands tbody");
  schemeForm.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "add-band") tbody.insertAdjacentHTML("beforeend", bandRow());
    if (act === "del-band") e.target.closest("tr").remove();
    if (act === "reset" && (await confirmDialog("Reset grading rules to the default A–F scale?", { confirm: "Reset", danger: false }))) {
      await ctx.db.setSetting("gradingScheme", DEFAULT_SCHEME);
      ctx.refresh();
    }
  });
  schemeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = {
      name: "Custom",
      passMark: Number(schemeForm.passMark.value),
      missing: schemeForm.missing.value,
      decimals: Number(schemeForm.decimals.value),
      bands: [...tbody.querySelectorAll("tr")].map((tr) => ({
        grade: tr.querySelector("[name=grade]").value.trim(),
        min: tr.querySelector("[name=min]").value === "" ? NaN : Number(tr.querySelector("[name=min]").value),
        remark: tr.querySelector("[name=remark]").value.trim(),
      })),
    };
    const errors = validateScheme(next);
    schemeForm.querySelector(".scheme-errors").innerHTML = errors.length ? `<div class="alert alert-error"><ul>${errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";
    if (errors.length) return;
    await ctx.db.setSetting("gradingScheme", next);
    await ctx.db.log("grading-rules", `pass ${next.passMark}%, ${next.bands.length} bands`);
    ctx.toast("Grading rules saved. All reports now use them.", "success");
    ctx.refresh();
  });

  el.querySelector("[data-act=erase]").addEventListener("click", async () => {
    if (!(await confirmDialog("This permanently erases all Tutor Companion data on this device for this account.", { title: "Erase local workspace", confirm: "Erase everything", typed: "ERASE" }))) return;
    for (const s of [...DATA_STORES, FILE_STORE]) await ctx.db.clear(s);
    ctx.toast("Local workspace erased.", "success");
    ctx.navigate("dashboard");
  });
}
