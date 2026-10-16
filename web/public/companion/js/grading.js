// Configurable grading and performance analytics. Pure functions only: every
// figure shown in Reports comes from here and is computed from recorded marks.

import { round } from "./util.js";

export const ASSESSMENT_CATEGORIES = [
  ["coursework", "Coursework"],
  ["assignment", "Assignment"],
  ["quiz", "Quiz"],
  ["practical", "Practical examination"],
  ["midterm", "Midterm examination"],
  ["final", "Final examination"],
  ["other", "Other"],
];

export const DEFAULT_SCHEME = Object.freeze({
  name: "Default (A–F)",
  passMark: 50,
  missing: "zero", // "zero" | "exclude"
  decimals: 1,
  bands: [
    { grade: "A", min: 80, remark: "Excellent" },
    { grade: "B", min: 70, remark: "Very good" },
    { grade: "C", min: 60, remark: "Good" },
    { grade: "D", min: 50, remark: "Pass" },
    { grade: "F", min: 0, remark: "Fail" },
  ],
});

export function markKey(assessmentId, studentId) {
  return `${assessmentId}|${studentId}`;
}

/** Validate a raw score entry. Returns {ok, value|null, error}. */
export function validateScore(raw, maxScore) {
  if (raw === "" || raw === null || raw === undefined) return { ok: true, value: null };
  const text = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, error: "Enter a number" };
  const value = Number(text);
  if (value < 0) return { ok: false, error: "Score cannot be negative" };
  if (!(maxScore > 0)) return { ok: false, error: "Assessment has no valid maximum score" };
  if (value > maxScore) return { ok: false, error: `Score cannot exceed ${maxScore}` };
  return { ok: true, value };
}

export function validateScheme(scheme) {
  const errors = [];
  const bands = scheme?.bands ?? [];
  if (!bands.length) errors.push("Add at least one grade band.");
  const mins = new Set();
  for (const band of bands) {
    if (!String(band.grade ?? "").trim()) errors.push("Every band needs a grade label.");
    if (!(Number.isFinite(band.min) && band.min >= 0 && band.min <= 100)) {
      errors.push(`Minimum for ${band.grade || "a band"} must be between 0 and 100.`);
    }
    if (mins.has(band.min)) errors.push(`Two bands share the minimum ${band.min}.`);
    mins.add(band.min);
  }
  if (bands.length && !bands.some((b) => b.min === 0)) errors.push("One band must start at 0 so every score gets a grade.");
  if (!(Number.isFinite(scheme?.passMark) && scheme.passMark >= 0 && scheme.passMark <= 100)) {
    errors.push("Pass mark must be between 0 and 100.");
  }
  return errors;
}

export function gradeFor(percent, scheme = DEFAULT_SCHEME) {
  if (!Number.isFinite(percent)) return { grade: "—", remark: "No marks" };
  const bands = [...scheme.bands].sort((a, b) => b.min - a.min);
  const band = bands.find((b) => percent >= b.min) ?? bands[bands.length - 1];
  return { grade: band?.grade ?? "—", remark: band?.remark ?? "" };
}

export function formulaText(scheme = DEFAULT_SCHEME, assessments = []) {
  const weighted = assessments.some((a) => Number(a.weight) > 0);
  const lines = [];
  if (weighted) {
    lines.push("Final % = Σ (score ÷ maximum × weight) ÷ Σ weight × 100");
    lines.push(
      "Weights: " +
        assessments
          .filter((a) => Number(a.weight) > 0)
          .map((a) => `${a.title} ${a.weight}`)
          .join(", "),
    );
  } else {
    lines.push("Final % = Σ scores ÷ Σ maximum scores × 100 (no weights set)");
  }
  lines.push(
    scheme.missing === "exclude"
      ? "Missing marks are excluded from both the score and the weight total."
      : "Missing marks count as 0. Exempted assessments are excluded.",
  );
  lines.push(
    "Grades: " +
      [...scheme.bands]
        .sort((a, b) => b.min - a.min)
        .map((b) => `${b.grade} ≥ ${b.min}%`)
        .join(", ") +
      `. Pass mark ${scheme.passMark}%.`,
  );
  return lines;
}

/** Compute one student's result for a set of assessments. */
export function studentResult(studentId, assessments, marks, scheme = DEFAULT_SCHEME) {
  const weighted = assessments.some((a) => Number(a.weight) > 0);
  const components = [];
  let num = 0;
  let den = 0;
  let rawTotal = 0;
  let rawMax = 0;
  let recorded = 0;
  for (const a of assessments) {
    const max = Number(a.maxScore);
    const weight = weighted ? Number(a.weight) || 0 : max;
    const mark = marks.get(markKey(a.id, studentId));
    const exempt = Boolean(mark?.exempt);
    const has = mark && mark.score !== null && mark.score !== undefined && !exempt;
    const score = has ? Number(mark.score) : null;
    const pct = has && max > 0 ? (score / max) * 100 : null;
    components.push({ assessmentId: a.id, title: a.title, score, max, pct, weight, exempt, absent: Boolean(mark?.absent) });
    if (exempt || weight <= 0 || !(max > 0)) continue;
    if (has) {
      recorded += 1;
      num += (score / max) * weight;
      den += weight;
      rawTotal += score;
      rawMax += max;
    } else if (scheme.missing !== "exclude") {
      den += weight;
      rawMax += max;
    }
  }
  const final = den > 0 && recorded > 0 ? round((num / den) * 100, scheme.decimals ?? 1) : null;
  const { grade, remark } = gradeFor(final ?? NaN, scheme);
  return {
    studentId,
    components,
    final,
    grade: final === null ? "—" : grade,
    remark: final === null ? "No marks" : remark,
    passed: final === null ? null : final >= scheme.passMark,
    recorded,
    expected: assessments.filter((a) => Number(a.maxScore) > 0).length,
    rawTotal: round(rawTotal, 2),
    rawMax,
  };
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { count: 0, mean: null, median: null, min: null, max: null, sd: null };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
  return { count: v.length, mean: round(mean), median: round(median), min: round(v[0]), max: round(v[v.length - 1]), sd: round(sd) };
}

/** Standard competition ranking (1, 2, 2, 4) on final %. */
export function rankResults(results) {
  const sorted = results.filter((r) => r.final !== null).sort((a, b) => b.final - a.final);
  const ranks = new Map();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    ranks.set(r.studentId, prev && prev.final === r.final ? ranks.get(prev.studentId) : i + 1);
  });
  return ranks;
}

/** Least-squares slope of a series (units per step). */
export function slope(series) {
  const pts = series.filter(Number.isFinite);
  const n = pts.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = pts.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  pts.forEach((y, x) => {
    num += (x - xm) * (y - ym);
    den += (x - xm) ** 2;
  });
  return den ? num / den : 0;
}

export function trendLabel(series) {
  if (series.filter(Number.isFinite).length < 3) return "not enough data";
  const s = slope(series);
  if (s >= 2) return "improving";
  if (s <= -2) return "declining";
  return "stable";
}

/**
 * Full class report for one course unit (or a whole class).
 * @param students [{id, firstName, lastName, regNo}]
 * @param assessments [{id, title, maxScore, weight, date, topics[]}]
 * @param markList [{assessmentId, studentId, score, absent, exempt}]
 */
export function classReport(students, assessments, markList, scheme = DEFAULT_SCHEME) {
  const marks = new Map(markList.map((m) => [markKey(m.assessmentId, m.studentId), m]));
  const ordered = [...assessments].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const results = students.map((s) => {
    const r = studentResult(s.id, ordered, marks, scheme);
    const series = r.components.map((c) => c.pct).filter((p) => p !== null);
    return { ...r, student: s, trend: trendLabel(series), series };
  });
  const ranks = rankResults(results);
  results.forEach((r) => (r.rank = ranks.get(r.studentId) ?? null));

  const finals = results.map((r) => r.final).filter((f) => f !== null);
  const graded = results.filter((r) => r.final !== null);
  const passCount = graded.filter((r) => r.passed).length;

  const distribution = {};
  for (const band of scheme.bands) distribution[band.grade] = 0;
  for (const r of graded) distribution[r.grade] = (distribution[r.grade] || 0) + 1;

  const assessmentStats = ordered.map((a) => {
    const pcts = students
      .map((s) => marks.get(markKey(a.id, s.id)))
      .filter((m) => m && m.score !== null && m.score !== undefined && !m.exempt)
      .map((m) => (Number(m.score) / Number(a.maxScore)) * 100);
    const st = stats(pcts);
    return {
      assessment: a,
      ...st,
      missing: students.length - st.count,
      passRate: st.count ? round((pcts.filter((p) => p >= scheme.passMark).length / st.count) * 100) : null,
    };
  });

  const topicMap = new Map();
  for (const s of assessmentStats) {
    for (const topic of s.assessment.topics || []) {
      if (!topic || s.mean === null) continue;
      const t = topicMap.get(topic) || { topic, total: 0, n: 0, assessments: [] };
      t.total += s.mean * s.count;
      t.n += s.count;
      t.assessments.push(s.assessment.title);
      topicMap.set(topic, t);
    }
  }
  const topics = [...topicMap.values()]
    .map((t) => ({ topic: t.topic, mean: round(t.total / t.n), responses: t.n, assessments: t.assessments }))
    .sort((a, b) => a.mean - b.mean);

  const insights = buildInsights(results, assessmentStats, topics, scheme);
  return {
    results,
    summary: {
      students: students.length,
      graded: graded.length,
      ...stats(finals),
      passRate: graded.length ? round((passCount / graded.length) * 100) : null,
      passCount,
      failCount: graded.length - passCount,
      distribution,
    },
    assessmentStats,
    topics,
    insights,
    formula: formulaText(scheme, ordered),
  };
}

function name(student) {
  return [student.firstName, student.lastName].filter(Boolean).join(" ") || student.regNo || "Student";
}

export function buildInsights(results, assessmentStats, topics, scheme) {
  const graded = results.filter((r) => r.final !== null).sort((a, b) => b.final - a.final);
  const topBand = [...scheme.bands].sort((a, b) => b.min - a.min)[0];
  const strong = graded.filter((r) => r.final >= (topBand?.min ?? 80)).slice(0, 10);
  const support = graded
    .filter((r) => !r.passed || r.final < scheme.passMark + 5 || r.trend === "declining")
    .sort((a, b) => a.final - b.final)
    .map((r) => ({
      name: name(r.student),
      final: r.final,
      reason: !r.passed ? "below pass mark" : r.trend === "declining" ? "declining trend" : "close to pass mark",
    }));
  const incomplete = results.filter((r) => r.recorded < r.expected).map((r) => ({ name: name(r.student), missing: r.expected - r.recorded }));
  const weakTopics = topics.filter((t) => t.mean < scheme.passMark + 10);
  const withMeans = assessmentStats.filter((s) => s.mean !== null);
  let gap = null;
  if (withMeans.length >= 2) {
    const hi = withMeans.reduce((a, b) => (b.mean > a.mean ? b : a));
    const lo = withMeans.reduce((a, b) => (b.mean < a.mean ? b : a));
    gap = { highest: hi.assessment.title, highMean: hi.mean, lowest: lo.assessment.title, lowMean: lo.mean, difference: round(hi.mean - lo.mean) };
  }
  return {
    strong: strong.map((r) => ({ name: name(r.student), final: r.final, grade: r.grade })),
    support,
    incomplete,
    weakTopics,
    gap,
    improving: graded.filter((r) => r.trend === "improving").map((r) => name(r.student)),
    declining: graded.filter((r) => r.trend === "declining").map((r) => name(r.student)),
  };
}
