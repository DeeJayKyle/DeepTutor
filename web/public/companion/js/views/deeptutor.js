// DeepTutor inside Tutor Companion: DeepTutor's agents (tutor chat, deep
// solve, deep research, question generation) and its knowledge bases, with
// answers saved straight into the tutor's teaching materials.

import { api } from "../api.js";
import { FILE_STORE } from "../db.js";
import { renderHtml } from "../markdown.js";
import { badge, busy, empty, field, modal, options, pageHead } from "../ui.js";
import { esc, slug } from "../util.js";

const CAPS = [
  ["chat", "Tutor chat", "Ask anything. Optionally searches the web, papers or your knowledge bases."],
  ["deep_solve", "Deep Solve", "Works through a problem step by step — useful for worked examples and model answers."],
  ["deep_research", "Deep Research", "Researches a topic in several steps and writes a report with sources."],
  ["deep_question", "Question generator", "DeepTutor's question engine for practice and assessment items."],
];
const TOOLS = [
  ["web_search", "Web search"],
  ["paper_search", "arXiv papers"],
  ["reason", "Deep reasoning"],
  ["brainstorm", "Brainstorm"],
];
const MORE = [
  ["/chat", "DeepTutor workspace", "Full chat with sessions, memory and personas"],
  ["/co-writer", "Co-Writer", "AI-assisted writing and editing of long documents"],
  ["/knowledge-bases", "Knowledge bases", "Manage RAG knowledge bases and indexing"],
  ["/notebooks", "Notebooks", "Collect and organise notes and answers"],
  ["/learning", "Guided learning", "Mastery paths, reading and watching with an AI tutor"],
  ["/space", "Space", "Skills, personas, question bank and tools"],
];

/** Turn streamed events into readable Markdown (mirrors the DeepTutor CLI). */
export function assemble(events) {
  const rounds = new Map();
  const order = [];
  const blocks = [];
  let result = "";
  for (const e of events) {
    if (e.type === "content" && e.content) {
      if (e.call_id && e.trace_kind === "llm_chunk") {
        if (!rounds.has(e.call_id)) {
          rounds.set(e.call_id, "");
          order.push({ kind: "round", id: e.call_id });
        }
        rounds.set(e.call_id, rounds.get(e.call_id) + e.content);
      } else if (e.trace_kind === "llm_output") {
        order.push({ kind: "block", text: e.content });
      } else {
        // Untraced text accumulates into one running block.
        const last = order[order.length - 1];
        if (last?.kind === "legacy") last.text += e.content;
        else order.push({ kind: "legacy", text: e.content });
      }
    }
    if (e.type === "result" && e.response) result = e.response;
  }
  for (const item of order) blocks.push(item.kind === "round" ? rounds.get(item.id) : item.text);
  const text = blocks.join("\n\n").trim();
  return text || result;
}

function sourcesOf(events) {
  const out = [];
  for (const e of events) {
    for (const s of e.type === "sources" ? e.sources || [] : []) {
      const title = s.title || s.name || s.url || s.source || "";
      if (title) out.push({ title, url: s.url || s.link || "" });
    }
  }
  return out;
}

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  const offline = !navigator.onLine || !ctx.serverReachable;
  const transcript = [];
  let kbs = [];
  let kbError = "";
  if (!offline) {
    try {
      kbs = await api.knowledgeBases();
    } catch (err) {
      kbError = err.message;
    }
  }
  el.innerHTML = `
    ${pageHead("DeepTutor AI", "DeepTutor's agents and knowledge bases, working with your classes.", `<button class="btn" data-act="kb">＋ Knowledge base from a unit</button>`)}
    ${offline ? `<div class="alert alert-warn">DeepTutor needs an internet connection.</div>` : !ctx.ai.available ? `<div class="alert alert-warn">No AI model is configured on the server.</div>` : ""}
    <div class="dt-layout">
      <section class="card dt-main">
        <div class="dt-caps" role="radiogroup" aria-label="Mode">${CAPS.map(([k, l, d], i) => `<label class="dt-cap"><input type="radio" name="cap" value="${k}" ${(params.mode || "chat") === k || (!params.mode && i === 0) ? "checked" : ""}><span><strong>${esc(l)}</strong><small>${esc(d)}</small></span></label>`).join("")}</div>
        <div id="dt-log" class="dt-log" aria-live="polite">${empty("Ask DeepTutor", "e.g. “Explain first-pass metabolism for diploma students with two clinical examples” or “Solve: a drug has a half-life of 6 h; what fraction remains after 18 h?”")}</div>
        <form id="dt-form" class="dt-form">
          <textarea name="message" rows="3" required maxlength="40000" placeholder="Ask, or describe the problem to solve…" ${offline ? "disabled" : ""}></textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${offline ? "disabled" : ""}>Send</button><button class="btn" type="button" data-act="stop" hidden>Stop</button><span class="muted small" id="dt-status"></span></div>
        </form>
      </section>
      <aside class="dt-side">
        <section class="card">
          <h3>Ground answers in</h3>
          ${kbError ? `<p class="small muted">${esc(kbError)}</p>` : kbs.length ? `<div class="checks">${kbs.map((k) => `<label class="check"><input type="checkbox" data-multi name="kb" value="${esc(k.id || k.name)}"> ${esc(k.name)} ${k.status && k.status !== "ready" ? badge(k.status, "warn") : ""}</label>`).join("")}</div>` : `<p class="small muted">No knowledge bases yet. Create one from a course unit's library.</p>`}
          <h3>Tools (Tutor chat)</h3>
          <div class="checks">${TOOLS.map(([k, l]) => `<label class="check"><input type="checkbox" data-multi name="tool" value="${k}"> ${esc(l)}</label>`).join("")}</div>
          ${field("Save answers to course unit", `<select name="unit">${options(look.unitOptions, params.unit || "", { blank: "Not linked" })}</select>`)}
        </section>
        <section class="card">
          <h3>More DeepTutor tools</h3>
          <ul class="list">${MORE.map(([href, l, d]) => `<li><a href="${href}" target="_blank" rel="noopener">${esc(l)} ↗</a><span class="muted small">${esc(d)}</span></li>`).join("")}</ul>
        </section>
      </aside>
    </div>`;

  const log = el.querySelector("#dt-log");
  const form = el.querySelector("#dt-form");
  const status = el.querySelector("#dt-status");
  const stopBtn = el.querySelector("[data-act=stop]");
  let controller = null;
  let sessionId = null;

  const checked = (name) => [...el.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);

  const drawEntry = (entry) => {
    if (transcript.length === 1) log.innerHTML = "";
    const div = document.createElement("div");
    div.className = `dt-msg dt-${entry.role}`;
    log.appendChild(div);
    entry.el = div;
    paint(entry);
    return div;
  };
  const paint = (entry) => {
    if (entry.role === "user") {
      entry.el.innerHTML = `<div class="dt-who">You · ${esc(CAPS.find((c) => c[0] === entry.cap)?.[1] || "")}</div><p>${esc(entry.text)}</p>`;
      return;
    }
    const sources = entry.sources?.length ? `<details class="small"><summary>Sources (${entry.sources.length})</summary><ul>${entry.sources.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</li>`).join("")}</ul></details>` : "";
    entry.el.innerHTML = `<div class="dt-who">DeepTutor ${entry.done ? "" : '<span class="spinner"></span>'} <span class="muted small">${esc(entry.stage || "")}</span></div>
      <div class="prose">${entry.text ? renderHtml(entry.text) : entry.done ? "<p class='muted'>No answer was produced.</p>" : ""}</div>${sources}
      ${entry.error ? `<div class="alert alert-error">${esc(entry.error)}</div>` : ""}
      ${entry.done && entry.text ? `<div class="card-actions"><button class="btn btn-sm" data-save="${transcript.indexOf(entry)}">Save as teaching material</button><button class="btn btn-sm" data-copy="${transcript.indexOf(entry)}">Copy</button></div>` : ""}`;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = form.message.value.trim();
    if (!message) return;
    const cap = el.querySelector("input[name=cap]:checked").value;
    const user = { role: "user", text: message, cap };
    transcript.push(user);
    drawEntry(user);
    const answer = { role: "ai", text: "", events: [], done: false, cap, question: message };
    transcript.push(answer);
    drawEntry(answer);
    form.message.value = "";
    const send = form.querySelector("button[type=submit]");
    busy(send, true, "Working…");
    stopBtn.hidden = false;
    controller = new AbortController();
    status.textContent = cap === "deep_research" ? "Deep research can take several minutes." : "";
    try {
      await api.runDeepTutor(
        { message, capability: cap, knowledge_bases: checked("kb"), tools: cap === "chat" ? checked("tool") : [], session_id: sessionId },
        (ev) => {
          if (ev.type === "session") {
            sessionId = ev.session_id || sessionId;
            return;
          }
          answer.events.push(ev);
          if (ev.type === "stage_start" || ev.type === "progress") answer.stage = ev.stage || ev.content?.slice(0, 80) || answer.stage;
          if (ev.type === "error") answer.error = ev.content || "DeepTutor reported an error.";
          answer.text = assemble(answer.events);
          answer.sources = sourcesOf(answer.events);
          paint(answer);
          log.scrollTop = log.scrollHeight;
        },
        controller.signal,
      );
    } catch (err) {
      if (err.name !== "AbortError") answer.error = err.message;
    } finally {
      answer.done = true;
      answer.stage = "";
      paint(answer);
      busy(send, false);
      stopBtn.hidden = true;
      status.textContent = "";
      controller = null;
    }
  });

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.act === "stop") controller?.abort();
    if (btn.dataset.copy) {
      await navigator.clipboard?.writeText(transcript[Number(btn.dataset.copy)].text);
      ctx.toast("Copied.", "success");
    }
    if (btn.dataset.save) {
      const a = transcript[Number(btn.dataset.save)];
      const unitId = el.querySelector("select[name=unit]").value;
      const unit = look.unitById.get(unitId);
      const kind = a.cap === "deep_question" ? "quiz" : a.cap === "deep_research" ? "document" : "lecture_notes";
      const m = await ctx.db.put("materials", {
        kind,
        title: a.question.slice(0, 90),
        classId: unit?.classId || "",
        unitId,
        content: `# ${a.question.slice(0, 120)}\n\n${a.text}${a.sources?.length ? `\n\n## Sources\n${a.sources.map((s) => `- ${s.url ? `[${s.title}](${s.url})` : s.title}`).join("\n")}` : ""}`,
        status: "draft",
        aiGenerated: true,
        sources: [],
        origin: `DeepTutor ${a.cap}`,
      });
      ctx.toast("Saved as a draft. Review it in the editor.", "success");
      ctx.navigate(`material/${m.id}`);
    }
    if (btn.dataset.act === "kb") createKb(ctx, look);
  });
}

async function createKb(ctx, look) {
  if (!look.units.length) return ctx.toast("Create a course unit and upload its library files first.", "error");
  const v = await modal({
    title: "Create a DeepTutor knowledge base",
    body: `<p class="small">Uploads the library files linked to a course unit into a DeepTutor knowledge base, which indexes them for retrieval (RAG). Then tick it under “Ground answers in”.</p>
      ${field("Course unit", `<select name="unitId" required>${options(look.unitOptions, look.units[0].id)}</select>`)}
      ${field("Knowledge base name", `<input name="name" maxlength="60" placeholder="Generated from the unit if blank">`)}`,
    submit: "Create",
  });
  if (!v) return;
  const unit = look.unitById.get(v.unitId);
  const resources = (await ctx.db.all("resources")).filter((r) => r.fileId && (r.unitId === unit.id || (!r.unitId && r.classId === unit.classId)));
  const files = [];
  for (const r of resources) {
    const f = await ctx.db.get(FILE_STORE, r.fileId);
    if (f?.blob) files.push(new File([f.blob], r.fileName, { type: f.blob.type }));
  }
  if (!files.length) return ctx.toast("No library files on this device are linked to that unit.", "error", 7000);
  const name = (v.name.trim() || `${unit.code || ""}-${unit.title}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || slug(unit.title);
  try {
    ctx.toast(`Uploading ${files.length} file(s)…`, "info");
    await api.createKnowledgeBase(name, files);
    await ctx.db.log("deeptutor-kb", `${name} (${files.length} files)`);
    ctx.toast(`Knowledge base “${name}” created. Indexing runs on the server and may take a few minutes.`, "success", 8000);
    ctx.refresh();
  } catch (err) {
    ctx.toast(err.message, "error", 9000);
  }
}
