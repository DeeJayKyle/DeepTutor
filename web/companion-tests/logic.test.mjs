// Unit tests for Tutor Companion's pure logic. Run: node --test companion-tests/
// Expected figures were calculated by hand (see comments) to check the
// grading engine independently.

import assert from "node:assert/strict";
import { test } from "node:test";

import { planRestore } from "../public/companion/js/backup.js";
import { classReport, DEFAULT_SCHEME, gradeFor, markKey, rankResults, studentResult, trendLabel, validateScheme, validateScore } from "../public/companion/js/grading.js";
import { inlineRuns, parseMarkdown, provenance, renderHtml, toSlides } from "../public/companion/js/markdown.js";
import { chunk, parseQuiz, selectExcerpts } from "../public/companion/js/sources.js";
import { parseCsv, toCsv } from "../public/companion/js/util.js";

const assessments = [
  { id: "cat", title: "CAT 1", maxScore: 30, weight: 20, date: "2026-02-01", topics: ["Pharmacokinetics"] },
  { id: "prac", title: "Practical", maxScore: 50, weight: 30, date: "2026-03-01", topics: ["Dosage calculation"] },
  { id: "fin", title: "Final", maxScore: 100, weight: 50, date: "2026-04-01", topics: ["Pharmacokinetics", "Dosage calculation"] },
];
const students = [
  { id: "a", firstName: "Amina", regNo: "P1" },
  { id: "b", firstName: "Brian", regNo: "P2" },
  { id: "c", firstName: "Chao", regNo: "P3" },
  { id: "d", firstName: "Dina", regNo: "P4" },
];
const markList = [
  // Amina: 80%, 80%, 70% -> 0.8*20 + 0.8*30 + 0.7*50 = 16 + 24 + 35 = 75.0 (B)
  { assessmentId: "cat", studentId: "a", score: 24 },
  { assessmentId: "prac", studentId: "a", score: 40 },
  { assessmentId: "fin", studentId: "a", score: 70 },
  // Brian: 50%, 40%, 45% -> 10 + 12 + 22.5 = 44.5 (F)
  { assessmentId: "cat", studentId: "b", score: 15 },
  { assessmentId: "prac", studentId: "b", score: 20 },
  { assessmentId: "fin", studentId: "b", score: 45 },
  // Chao: 100%, missing, 90% -> zero policy: 20 + 0 + 45 = 65.0 (C);
  //   exclude policy: (20 + 45) / 70 * 100 = 92.857 -> 92.9 (A)
  { assessmentId: "cat", studentId: "c", score: 30 },
  { assessmentId: "fin", studentId: "c", score: 90 },
  // Dina: 70%, exempt, 60% -> (14 + 30) / 70 * 100 = 62.857 -> 62.9 (C)
  { assessmentId: "cat", studentId: "d", score: 21 },
  { assessmentId: "prac", studentId: "d", score: null, exempt: true },
  { assessmentId: "fin", studentId: "d", score: 60 },
];
const marks = new Map(markList.map((m) => [markKey(m.assessmentId, m.studentId), m]));

test("weighted final marks match hand calculation", () => {
  const r = (id, scheme = DEFAULT_SCHEME) => studentResult(id, assessments, marks, scheme);
  assert.equal(r("a").final, 75);
  assert.equal(r("a").grade, "B");
  assert.equal(r("b").final, 44.5);
  assert.equal(r("b").grade, "F");
  assert.equal(r("b").passed, false);
  assert.equal(r("c").final, 65);
  assert.equal(r("c", { ...DEFAULT_SCHEME, missing: "exclude" }).final, 92.9);
  assert.equal(r("c", { ...DEFAULT_SCHEME, missing: "exclude" }).grade, "A");
  assert.equal(r("d").final, 62.9);
  assert.equal(r("d").grade, "C");
});

test("unweighted assessments use raw totals", () => {
  const plain = assessments.map((a) => ({ ...a, weight: 0 }));
  // Amina raw: (24 + 40 + 70) / (30 + 50 + 100) = 134 / 180 = 74.44 -> 74.4
  assert.equal(studentResult("a", plain, marks, DEFAULT_SCHEME).final, 74.4);
});

test("class summary, ranking and pass rate", () => {
  const report = classReport(students, assessments, markList, DEFAULT_SCHEME);
  const byId = Object.fromEntries(report.results.map((r) => [r.studentId, r]));
  assert.deepEqual([byId.a.rank, byId.c.rank, byId.d.rank, byId.b.rank], [1, 2, 3, 4]);
  assert.equal(report.summary.passRate, 75); // 3 of 4 at or above 50%
  assert.equal(report.summary.max, 75);
  assert.equal(report.summary.min, 44.5);
  assert.ok(Math.abs(report.summary.mean - 61.85) <= 0.06); // (75+44.5+65+62.9)/4
  assert.deepEqual(report.summary.distribution, { A: 0, B: 1, C: 2, D: 0, F: 1 });
  // CAT 1 percentages 80, 50, 100, 70 -> mean 75
  assert.equal(report.assessmentStats[0].mean, 75);
  // Practical has one missing (Chao) and one exempt (Dina): two recorded
  assert.equal(report.assessmentStats[1].count, 2);
  assert.ok(report.insights.support.some((s) => s.name === "Brian"));
  assert.ok(report.formula[0].includes("weight"));
});

test("ties share a rank", () => {
  const ranks = rankResults([
    { studentId: "x", final: 80 },
    { studentId: "y", final: 80 },
    { studentId: "z", final: 70 },
  ]);
  assert.deepEqual([ranks.get("x"), ranks.get("y"), ranks.get("z")], [1, 1, 3]);
});

test("score validation rejects invalid entries", () => {
  assert.deepEqual(validateScore("", 30), { ok: true, value: null });
  assert.deepEqual(validateScore("29.5", 30), { ok: true, value: 29.5 });
  assert.equal(validateScore("31", 30).ok, false);
  assert.equal(validateScore("-1", 30).ok, false);
  assert.equal(validateScore("abc", 30).ok, false);
  assert.equal(validateScore("1e2", 300).ok, false);
});

test("grading scheme validation and grade lookup", () => {
  assert.deepEqual(validateScheme(DEFAULT_SCHEME), []);
  assert.ok(validateScheme({ passMark: 40, bands: [{ grade: "P", min: 40 }] }).length > 0);
  assert.equal(gradeFor(79.9).grade, "B");
  assert.equal(gradeFor(80).grade, "A");
  assert.equal(trendLabel([40, 50, 60]), "improving");
  assert.equal(trendLabel([70, 60, 50]), "declining");
});

test("markdown parses headings, lists, tables and source tags", () => {
  const md = "# Title\n\nIntro **bold** [Source: S1]\n\n- one\n  - two\n1. first\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> AI-generated explanation";
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "para", "list", "list", "table", "quote"]);
  assert.equal(blocks[2].items[1].depth, 1);
  assert.deepEqual(blocks[4].rows, [["A", "B"], ["1", "2"]]);
  assert.ok(inlineRuns("x [Source: S2] y").some((r) => r.source));
  const html = renderHtml("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(renderHtml(md).includes('class="ai-mark"'));
  const p = provenance(md);
  assert.equal(p.sourced, 1);
  assert.deepEqual(p.sources, ["S1"]);
});

test("presentation markdown becomes slides with notes", () => {
  const slides = toSlides("## Intro\n- point A\n- point B\nNotes: say hello\n## Next\nText");
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0].bullets.map((b) => b.text), ["point A", "point B"]);
  assert.deepEqual(slides[0].notes, ["say hello"]);
});

test("quiz parsing pairs questions with marking guide answers", () => {
  const quiz = parseQuiz("# Quiz\n1. Which organ metabolises most drugs? (1 mark)\nA) Kidney\nB) Liver\nC) Heart\n2. Define half-life. (2 marks)\n\n# Marking Guide\n1. Answer: B — the liver.\n2. Time for concentration to halve.");
  assert.equal(quiz.length, 2);
  assert.equal(quiz[0].options.length, 3);
  assert.equal(quiz[0].correct, "B");
  assert.match(quiz[1].answer, /halve/);
});

test("source excerpts favour topic-relevant chunks within budget", () => {
  const text = [...Array(40)].map((_, i) => (i === 30 ? "Pharmacokinetics absorption distribution details." : `Unrelated paragraph ${i} `.repeat(20))).join("\n\n");
  assert.ok(chunk(text).length > 1);
  const [ex] = selectExcerpts([{ title: "Book", text }], ["Pharmacokinetics"], 2000);
  assert.ok(ex.text.length <= 2000 + 50);
  assert.ok(ex.text.includes("Pharmacokinetics absorption"));
});

test("restore planning detects conflicts instead of overwriting", () => {
  const local = { classes: [{ id: "1", name: "A", updatedAt: "2026-01-02" }, { id: "2", name: "B", updatedAt: "2026-01-01" }, { id: "3", name: "Local only" }] };
  const incoming = { classes: [{ id: "1", name: "A", updatedAt: "2026-01-05" }, { id: "2", name: "B changed", updatedAt: "2026-01-03" }, { id: "4", name: "New" }] };
  const plan = planRestore(local, incoming);
  assert.equal(plan.identical, 1); // timestamps alone do not make a conflict
  assert.equal(plan.added.length, 1);
  assert.equal(plan.localOnly, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].newer, "incoming");
});

test("CSV round trip with quotes", () => {
  const rows = [["reg_no", "first_name"], ["P1", 'Ann "Annie", Jr']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
