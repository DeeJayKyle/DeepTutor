import { api } from "../api.js";
import { selectExcerpts } from "../sources.js";
import { busy, empty, field, options, pageHead } from "../ui.js";
import { esc } from "../util.js";
import { KIND_LABELS } from "./materials.js";

export const GEN_KINDS = [
  ["lecture_notes", "Lecture notes"],
  ["topic_summary", "Topic summary"],
  ["presentation", "PowerPoint presentation"],
  ["exam", "Examination"],
  ["quiz", "Quiz"],
  ["assignment", "Assignment / coursework"],
  ["case_study", "Case study"],
];

const QUESTION_TYPES = [
  "Multiple-choice",
  "True or false",
  "Short answer",
  "Structured",
  "Essay",
  "Case-based",
  "Practical assessment",
];
const ASSIGNMENT_TYPES = ["Individual assignment", "Group assignment", "Coursework", "Research assignment", "Practical exercise", "Discussion questions", "Project"];

export async function render(ctx, el, params) {
  const look = await ctx.lookups();
  const kind = params.kind && KIND_LABELS[params.kind] ? params.kind : "lecture_notes";
  if (!look.units.length) {
    el.innerHTML = `${pageHead("AI Teaching Assistant", "Prepare lecture notes, slides, exams, quizzes and assignments from your own materials.")}
      ${empty("Add a course unit first", "The assistant works from a course unit's curriculum, topics and linked sources.", `<a class="btn btn-primary" href="#/units">Go to Course Units</a>`)}`;
    return;
  }
  const unitId = params.unit && look.unitById.has(params.unit) ? params.unit : look.units[0].id;
  el.innerHTML = `
    ${pageHead("AI Teaching Assistant", "Your uploaded materials are used as primary sources. Everything generated is a draft for you to review.")}
    ${
      !navigator.onLine
        ? `<div class="alert alert-warn">You are offline. AI generation needs an internet connection — you can still write and export documents by hand from the material lists.</div>`
        : !ctx.ai.available
          ? `<div class="alert alert-warn">${ctx.serverReachable ? "No AI model is configured on the server. An administrator can add one in DeepTutor Settings." : "The server cannot be reached right now."}</div>`
          : ""
    }
    <form class="card gen-form" novalidate>
      <div class="row">
        ${field("What do you want to create?", `<select name="kind">${options(GEN_KINDS, kind)}</select>`)}
        ${field("Course unit", `<select name="unitId" required>${options(look.unitOptions, unitId)}</select>`)}
      </div>
      ${field("Title", `<input name="title" maxlength="200" placeholder="Generated automatically if left blank">`)}
      <div id="unit-bits"></div>
      <div class="row row-3">
        ${field("Level of detail", `<select name="detail">${options([["brief", "Brief"], ["standard", "Standard"], ["comprehensive", "Comprehensive"]], "standard")}</select>`)}
        ${field("Difficulty", `<select name="difficulty">${options([["introductory", "Introductory"], ["intermediate", "Intermediate"], ["advanced", "Advanced"], ["mixed", "Mixed"]], "mixed")}</select>`)}
        <div data-for="presentation">${field("Number of slides", `<input name="slides" type="number" min="3" max="60" value="12">`)}</div>
      </div>
      <fieldset data-for="exam quiz assignment" class="sub">
        <legend>Assessment settings</legend>
        <div data-for="exam quiz">
          <p class="label">Question types</p>
          <div class="checks">${QUESTION_TYPES.map((t, i) => `<label class="check"><input type="checkbox" data-multi name="qtypes" value="${esc(t)}" ${i < 3 ? "checked" : ""}> ${esc(t)}</label>`).join("")}</div>
        </div>
        <div data-for="assignment">
          <p class="label">Assignment type</p>
          <div class="checks">${ASSIGNMENT_TYPES.map((t, i) => `<label class="check"><input type="checkbox" data-multi name="atypes" value="${esc(t)}" ${i === 0 ? "checked" : ""}> ${esc(t)}</label>`).join("")}</div>
        </div>
        <div class="row row-3">
          ${field("Number of questions", `<input name="num" type="number" min="1" max="200" placeholder="e.g. 20">`)}
          ${field("Total marks", `<input name="marks" type="number" min="1" max="1000" placeholder="e.g. 100">`)}
          <div data-for="exam quiz">${field("Duration", `<input name="duration" maxlength="40" placeholder="e.g. 2 hours">`)}</div>
        </div>
        <label class="check" data-for="exam quiz"><input type="checkbox" name="answers" checked> Include model answers, marking guide and marks allocation</label>
      </fieldset>
      ${field("Additional instructions", `<textarea name="instructions" rows="3" maxlength="8000" placeholder="e.g. Use Kenyan clinical examples; include a comparison table of drug classes; candidates answer all questions in Section A."></textarea>`)}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" ${!navigator.onLine ? "disabled" : ""}>✦ Generate draft</button>
        <span class="muted small">Drafts open in the editor, where you review and edit before exporting.</span>
      </div>
      <div class="gen-error"></div>
    </form>`;

  const form = el.querySelector("form");
  const bits = el.querySelector("#unit-bits");

  const syncKind = () => {
    const k = form.kind.value;
    form.querySelectorAll("[data-for]").forEach((n) => (n.hidden = !n.dataset.for.split(" ").includes(k)));
  };

  const drawUnit = async () => {
    const unit = look.unitById.get(form.unitId.value);
    const all = await ctx.db.all("resources");
    const linked = all.filter((r) => r.text && (r.unitId === unit.id || (!r.unitId && r.classId === unit.classId)));
    const others = all.filter((r) => r.text && !linked.includes(r));
    const noText = all.filter((r) => !r.text && (r.unitId === unit.id || r.classId === unit.classId));
    const topics = (unit.topics || []).flatMap((t) => [t.title, ...t.subtopics.map((s) => `${t.title}: ${s}`)]);
    bits.innerHTML = `
      <fieldset class="sub">
        <legend>Curriculum topics</legend>
        ${
          topics.length
            ? `<div class="checks checks-scroll">${topics.map((t) => `<label class="check"><input type="checkbox" data-multi name="topics" value="${esc(t)}"> ${esc(t)}</label>`).join("")}</div>`
            : `<p class="muted small">This unit has no topics yet. <a href="#/units/${esc(unit.id)}">Add topics</a> or type them below.</p>`
        }
        ${field("Other topics (comma separated)", `<input name="extraTopics" maxlength="500">`)}
      </fieldset>
      ${
        (unit.objectives || []).length
          ? `<fieldset class="sub"><legend>Learning outcomes to address</legend><div class="checks checks-scroll">${unit.objectives
              .map((o) => `<label class="check"><input type="checkbox" data-multi name="objectives" value="${esc(o)}" checked> ${esc(o)}</label>`)
              .join("")}</div></fieldset>`
          : ""
      }
      <fieldset class="sub">
        <legend>Source materials (used first, cited as [Source: S#])</legend>
        ${unit.curriculum || unit.outline ? `<label class="check"><input type="checkbox" name="useCurriculum" checked> Use this unit's curriculum and course outline</label>` : ""}
        ${
          linked.length || others.length
            ? `<div class="checks checks-scroll">${[...linked, ...others]
                .map((r) => `<label class="check"><input type="checkbox" data-multi name="sources" value="${esc(r.id)}" ${linked.includes(r) ? "checked" : ""}> ${esc(r.title)} <span class="muted small">${linked.includes(r) ? "linked" : "other"} · ${(r.textChars || r.text.length).toLocaleString()} chars</span></label>`)
                .join("")}</div>`
            : `<p class="muted small">No library items with extracted text yet. <a href="#/library?upload=1&unit=${esc(unit.id)}">Upload the prescribed textbook or references</a> so the assistant can ground its drafts in them.</p>`
        }
        ${noText.length ? `<p class="muted small">${noText.length} linked file(s) have no extracted text (images, or extraction pending) and cannot be read by the assistant.</p>` : ""}
      </fieldset>`;
  };

  form.kind.addEventListener("change", syncKind);
  form.unitId.addEventListener("change", drawUnit);
  syncKind();
  await drawUnit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector(".gen-error");
    errorEl.innerHTML = "";
    const v = Object.fromEntries(new FormData(form).entries());
    const multi = (name) => [...form.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
    const unit = look.unitById.get(form.unitId.value);
    const cls = look.classById.get(unit.classId);
    const k = form.kind.value;
    const topics = [...multi("topics"), ...String(v.extraTopics || "").split(",").map((t) => t.trim()).filter(Boolean)];
    if (!topics.length && !(unit.topics || []).length && !v.instructions?.trim()) {
      errorEl.innerHTML = `<div class="alert alert-error">Choose at least one topic or describe what you need in the instructions.</div>`;
      return;
    }
    const resources = await Promise.all(multi("sources").map((id) => ctx.db.get("resources", id)));
    const excerpts = selectExcerpts(resources.filter(Boolean).map((r) => ({ title: r.title, text: r.text })), topics.length ? topics : (unit.topics || []).map((t) => t.title));
    const types = k === "assignment" ? multi("atypes") : multi("qtypes");
    const payload = {
      kind: k,
      class_name: cls?.name || "",
      level: cls?.level || "",
      unit_title: unit.title,
      unit_code: unit.code || "",
      topics: topics.length ? topics : (unit.topics || []).map((t) => t.title),
      objectives: multi("objectives"),
      curriculum: form.useCurriculum?.checked ? [unit.curriculum, unit.outline].filter(Boolean).join("\n\n").slice(0, 20000) : "",
      sources: excerpts,
      instructions: [k === "assignment" && types.length ? `Assignment type: ${types.join(", ")}.` : "", v.instructions || ""].filter(Boolean).join("\n"),
      detail: v.detail,
      difficulty: v.difficulty,
      question_types: k === "assignment" ? [] : types,
      num_questions: v.num ? Number(v.num) : null,
      total_marks: v.marks ? Number(v.marks) : null,
      duration: v.duration || "",
      slides: k === "presentation" && v.slides ? Number(v.slides) : null,
      include_answers: Boolean(form.answers?.checked),
    };
    const button = form.querySelector("button[type=submit]");
    busy(button, true, "Generating — this can take a minute…");
    try {
      const res = await api.generate(payload);
      const title = v.title?.trim() || `${KIND_LABELS[k]} — ${unit.title}${topics.length && topics.length <= 2 ? `: ${topics.join(", ")}` : ""}`;
      const material = await ctx.db.put("materials", {
        kind: k,
        title,
        classId: unit.classId,
        unitId: unit.id,
        content: res.content,
        status: "draft",
        aiGenerated: true,
        model: res.model,
        sources: resources.filter(Boolean).map((r, i) => ({ tag: `S${i + 1}`, id: r.id, title: r.title })),
        settings: { topics: payload.topics, detail: payload.detail, difficulty: payload.difficulty, questionTypes: types, totalMarks: payload.total_marks },
      });
      await ctx.db.log("ai-generate", `${KIND_LABELS[k]}: ${title}`);
      ctx.toast("Draft created. Review it before using it with students.", "success");
      ctx.navigate(`material/${material.id}`);
    } catch (err) {
      errorEl.innerHTML = `<div class="alert alert-error" role="alert">${esc(err.message)}</div>`;
    } finally {
      busy(button, false);
    }
  });
}
