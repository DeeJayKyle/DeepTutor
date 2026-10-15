import { api } from "../api.js";
import { badge, busy, confirmDialog, empty, field, modal, options, pageHead } from "../ui.js";
import { esc, fmtDate } from "../util.js";

const KINDS = [
  ["articles", "Articles & publications"],
  ["images", "Images & illustrations"],
  ["videos", "YouTube videos"],
];

function youtubeId(url) {
  const m = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url || "");
  return m ? m[1] : "";
}

async function saveItem(ctx, item, defaults) {
  const look = await ctx.lookups();
  const values = await modal({
    title: "Save to your workspace",
    body: `
      <p><strong>${esc(item.title)}</strong></p>
      <div class="row">${field("Class", `<select name="classId">${options(look.classOptions, defaults.classId, { blank: "Not linked" })}</select>`)}
      ${field("Course unit", `<select name="unitId">${options(look.unitOptions, defaults.unitId, { blank: "Not linked" })}</select>`)}</div>
      ${field("Curriculum topic", `<input name="topic" maxlength="160" value="${esc(defaults.topic || "")}">`)}
      ${field("Lecture notes (optional)", `<select name="materialId">${options((await ctx.db.all("materials")).map((m) => [m.id, m.title]), "", { blank: "Not linked" })}</select>`)}
      ${field("Research notes", `<textarea name="notes" rows="3" maxlength="4000"></textarea>`)}`,
    submit: "Save",
    validate: (v) => {
      const unit = look.unitById.get(v.unitId);
      return unit && v.classId && unit.classId !== v.classId ? "That course unit belongs to a different class." : null;
    },
  });
  if (!values) return;
  const unit = look.unitById.get(values.unitId);
  await ctx.db.put("research", {
    ...item,
    id: undefined,
    classId: values.classId || unit?.classId || "",
    unitId: values.unitId,
    topic: values.topic.trim(),
    materialId: values.materialId,
    notes: values.notes.trim(),
    savedAt: new Date().toISOString(),
  });
  ctx.toast("Saved. It stays available offline (the link itself needs internet to open).", "success", 5000);
}

function resultCard(r, kind, i) {
  if (kind === "images") {
    return `<article class="card media-card"><a href="${esc(r.url)}" target="_blank" rel="noopener"><img src="${esc(r.thumbnail)}" alt="${esc(r.title)}" loading="lazy"></a>
      <h3 class="small">${esc(r.title)}</h3>
      <p class="small">${r.license ? badge(r.license, "ok") : badge("licence unknown", "warn")} ${r.author ? `by ${esc(r.author)}` : ""}</p>
      ${r.attribution_required ? `<p class="small muted">Attribution required when reused.</p>` : ""}
      <div class="card-actions"><a class="btn btn-sm" href="${esc(r.url)}" target="_blank" rel="noopener">Source page</a><button class="btn btn-sm" data-save="${i}">Save</button></div></article>`;
  }
  if (kind === "videos") {
    return `<article class="card media-card"><a href="${esc(r.url)}" target="_blank" rel="noopener"><img src="${esc(r.thumbnail)}" alt="" loading="lazy"></a>
      <h3 class="small">${esc(r.title)}</h3><p class="small muted">${esc(r.channel)} · ${esc(r.date)}</p>
      <div class="card-actions"><a class="btn btn-sm" href="${esc(r.url)}" target="_blank" rel="noopener">Watch on YouTube</a><button class="btn btn-sm" data-save="${i}">Save link</button></div></article>`;
  }
  return `<article class="card result">
    <h3><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
    <p class="small">${esc((r.authors || []).filter(Boolean).join(", ") || "Authors not listed")} · ${esc(r.date || "n.d.")} · <em>${esc(r.source)}</em></p>
    ${r.summary ? `<p class="small">${esc(r.summary)}${r.summary.length >= 600 ? "…" : ""}</p>` : ""}
    <p class="small">${badge(`Indexed by ${r.provider}`, "ok")} ${r.doi ? `DOI: <a href="${esc(r.doi)}" target="_blank" rel="noopener">${esc(r.doi.replace("https://doi.org/", ""))}</a>` : ""} ${r.open_access_url ? badge("open access") : ""} ${r.cited_by ? `<span class="muted">cited ${r.cited_by}×</span>` : ""}</p>
    <div class="card-actions"><button class="btn btn-sm" data-save="${i}">Save reference</button></div></article>`;
}

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  const unit = look.unitById.get(params.unit);
  const saved = (await ctx.db.all("research")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const defaults = { classId: unit?.classId || "", unitId: unit?.id || "" };
  el.innerHTML = `
    ${pageHead("Research Assistant", "Find articles, openly licensed illustrations and educational videos. Results come from public indexes and link to the original source.")}
    <form class="card search-form">
      <div class="row">
        ${field("Search for", `<input name="q" required minlength="2" maxlength="300" value="${esc(params.q || (unit ? unit.title : ""))}" placeholder="e.g. beta blockers pharmacokinetics">`)}
        ${field("Type", `<select name="kind">${options(KINDS, params.kind || "articles")}</select>`)}
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit" ${navigator.onLine ? "" : "disabled"}>⌕ Search</button>
        <button class="btn" type="button" data-act="manual">＋ Add a link manually</button>
        ${navigator.onLine ? "" : `<span class="muted small">Searching needs an internet connection. Your saved items below are available offline.</span>`}</div>
    </form>
    <div id="results"></div>
    <h2>Saved references, images and videos (${saved.length})</h2>
    ${
      saved.length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Type</th><th>Linked to</th><th>Notes</th><th></th></tr></thead><tbody>${saved
            .map(
              (r) => `<tr data-id="${esc(r.id)}"><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="small muted">${esc([r.source || r.channel || r.provider, r.date, r.license].filter(Boolean).join(" · "))}</div></td>
              <td>${badge(r.kind)}</td><td class="small">${esc(look.unitLabel(look.unitById.get(r.unitId)) || look.classById.get(r.classId)?.name || "—")}${r.topic ? `<br>${esc(r.topic)}` : ""}</td><td class="small">${esc(r.notes || "")}</td>
              <td class="right"><button class="btn btn-sm btn-ghost-danger" data-act="del" aria-label="Delete">✕</button></td></tr>`,
            )
            .join("")}</tbody></table></div><p class="muted small">Saved ${fmtDate(saved[saved.length - 1].savedAt)} onwards. Videos are saved as links: playing them needs internet.</p>`
        : `<p class="muted">Nothing saved yet.</p>`
    }`;

  const results = el.querySelector("#results");
  let current = [];
  let currentKind = "articles";
  const form = el.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    currentKind = form.kind.value;
    const btn = form.querySelector("button[type=submit]");
    busy(btn, true, "Searching…");
    results.innerHTML = "";
    try {
      const res = await api.research(q, currentKind, currentKind === "articles" ? 12 : 12);
      current = res.results.map((r) => ({ ...r, kind: currentKind === "articles" ? "article" : currentKind === "images" ? "image" : "video" }));
      const notes = res.notes.map((n) => `<div class="alert alert-info">${esc(n)}</div>`).join("");
      const yt = res.search_url ? `<p><a class="btn" href="${esc(res.search_url)}" target="_blank" rel="noopener">Search YouTube for “${esc(q)}” ↗</a> then use “Add a link manually” to save a video.</p>` : "";
      results.innerHTML =
        notes +
        yt +
        (current.length
          ? `<p class="muted small">${current.length} results. ${esc(res.verified_from)} Check each source before citing it.</p><div class="${currentKind === "articles" ? "results" : "media-grid"}">${current.map((r, i) => resultCard(r, currentKind, i)).join("")}</div>`
          : res.search_url
            ? ""
            : empty("No results", "Try different keywords."));
    } catch (err) {
      results.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    } finally {
      busy(btn, false);
    }
  });

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.save !== undefined) {
      await saveItem(ctx, current[Number(btn.dataset.save)], defaults);
      ctx.refresh();
    }
    if (btn.dataset.act === "manual") {
      const v = await modal({
        title: "Add a link",
        body: `${field("Title", `<input name="title" required maxlength="300">`)}${field("URL", `<input name="url" type="url" required maxlength="1000" placeholder="https://">`)}
          ${field("Type", `<select name="kind">${options([["video", "Video"], ["article", "Article / web page"], ["image", "Image"]], "video")}</select>`)}`,
        submit: "Next",
        validate: (val) => (/^https?:\/\//i.test(val.url) ? null : "Enter a full web address starting with http(s)://"),
      });
      if (!v) return;
      const id = youtubeId(v.url);
      await saveItem(ctx, { title: v.title.trim(), url: v.url.trim(), kind: v.kind, provider: id ? "YouTube" : "Manual", thumbnail: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "", manual: true }, defaults);
      ctx.refresh();
    }
    if (btn.dataset.act === "del") {
      const id = btn.closest("tr").dataset.id;
      if (await confirmDialog("Remove this saved item?", { confirm: "Remove" })) {
        await ctx.db.delete("research", id);
        ctx.refresh();
      }
    }
  });
  if (params.q) form.requestSubmit();
}
