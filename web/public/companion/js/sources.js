// Source selection for AI generation and quiz parsing. Pure functions.

const STOP = new Set("the of and to in a an for on with by is are be as at from or that this into its their".split(" "));

export function keywords(texts) {
  const words = new Set();
  for (const t of texts) {
    for (const w of String(t || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) if (!STOP.has(w)) words.add(w);
  }
  return [...words];
}

/** Split text into ~size-char chunks on paragraph boundaries. */
export function chunk(text, size = 1500) {
  const parts = String(text || "").split(/\n\s*\n/);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length > size) {
      chunks.push(cur);
      cur = "";
    }
    if (p.length > size * 2) {
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
    } else cur += (cur ? "\n\n" : "") + p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Pick the parts of each source most relevant to the topics, within a total
 * character budget. Returns [{title, text}] keeping each chunk's order.
 */
export function selectExcerpts(sources, topics, budget = 48000) {
  const usable = sources.filter((s) => s.text && s.text.trim());
  if (!usable.length) return [];
  const per = Math.floor(budget / usable.length);
  const keys = keywords(topics);
  return usable.map((s) => {
    if (s.text.length <= per) return { title: s.title, text: s.text };
    const chunks = chunk(s.text).map((c, i) => {
      const low = c.toLowerCase();
      const score = keys.reduce((acc, k) => acc + (low.split(k).length - 1), 0);
      return { c, i, score };
    });
    const ranked = keys.length ? [...chunks].sort((a, b) => b.score - a.score || a.i - b.i) : chunks;
    const picked = [];
    let used = 0;
    for (const ch of ranked) {
      if (used + ch.c.length > per) continue;
      picked.push(ch);
      used += ch.c.length;
    }
    picked.sort((a, b) => a.i - b.i);
    return { title: s.title, text: picked.map((p) => p.c).join("\n\n[…]\n\n") };
  });
}

const Q_START = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):]\s*(?:\*\*)?\s*(.*)$/i;
const GUIDE_HEAD = /^#{1,6}\s*(marking guide|answers?|answer key|model answers?|marking scheme)\b/im;

/** Split a quiz/exam into numbered questions and matching answers. */
export function parseQuiz(markdown) {
  const text = String(markdown || "");
  const m = GUIDE_HEAD.exec(text);
  const paper = m ? text.slice(0, m.index) : text;
  const guide = m ? text.slice(m.index) : "";
  const split = (src) => {
    const out = new Map();
    let current = null;
    for (const line of src.split(/\r?\n/)) {
      const q = Q_START.exec(line);
      if (q && !/^\s{2,}/.test(line)) {
        current = Number(q[1]);
        if (!out.has(current)) out.set(current, []);
        out.get(current).push(q[2]);
      } else if (current !== null) out.get(current).push(line);
    }
    return out;
  };
  const questions = split(paper);
  const answers = split(guide);
  return [...questions.entries()].map(([n, lines]) => {
    const body = lines.join("\n").trim();
    const options = [...body.matchAll(/^\s*(?:[-*]\s*)?\(?([A-Ea-e])[).]\s+(.+)$/gm)].map((o) => ({ key: o[1].toUpperCase(), text: o[2].trim() }));
    const answer = (answers.get(n) || []).join("\n").trim();
    const keyMatch = /(?:answer|correct)[^A-Za-z]{0,12}\(?([A-E])\)?\b/i.exec(answer) || /^\s*\(?([A-E])\)?[).:\s]/.exec(answer);
    return { number: n, body, options, answer, correct: keyMatch ? keyMatch[1].toUpperCase() : null };
  });
}
