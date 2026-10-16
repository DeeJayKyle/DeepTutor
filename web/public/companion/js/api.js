// Server calls. Everything goes to the same origin (/api/companion/*), where
// the DeepTutor backend checks the tutor's login. No API keys live here.

const BASE = "/api/companion";

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function isOnline() {
  return navigator.onLine !== false;
}

async function request(path, { method = "GET", body, form, timeout = 180_000 } = {}) {
  if (!isOnline()) throw new ApiError("You are offline. This feature needs an internet connection.", 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form || (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(
      err?.name === "AbortError" ? "The server took too long to respond. Try again." : "Could not reach the server. Check your connection.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    if (response.status === 401) throw new ApiError("Your session has expired. Sign in again to use online features.", 401);
    if (response.status === 403) throw new ApiError(data?.detail || "Your account is not allowed to use this feature.", 403);
    if (response.status === 429) throw new ApiError("The AI usage limit was reached. Wait a moment and try again.", 429);
    if (response.status === 409 && data?.detail && typeof data.detail === "object") {
      const err = new ApiError(data.detail.message || "Conflict", 409);
      err.data = data.detail;
      throw err;
    }
    const detail = typeof data?.detail === "string" ? data.detail : Array.isArray(data?.detail) ? data.detail.map((d) => d.msg).join("; ") : "";
    throw new ApiError(detail || `Server error (${response.status}).`, response.status);
  }
  return data;
}

export const api = {
  status: () => request("/status", { timeout: 10_000 }),
  generate: (payload) => request("/generate", { method: "POST", body: payload, timeout: 300_000 }),
  extract: (file) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request("/extract", { method: "POST", form, timeout: 180_000 });
  },
  research: (query, kind, limit = 10) => request("/research", { method: "POST", body: { query, kind, limit }, timeout: 40_000 }),
  listBackups: () => request("/backups"),
  createBackup: (body) => request("/backups", { method: "POST", body, timeout: 300_000 }),
  getBackup: (id) => request(`/backups/${encodeURIComponent(id)}`, { timeout: 300_000 }),
  deleteBackup: (id) => request(`/backups/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // School workspaces
  schools: () => request("/schools"),
  createSchool: (name) => request("/schools", { method: "POST", body: { name } }),
  school: (sid) => request(`/schools/${sid}`),
  setMember: (sid, username, role) => request(`/schools/${sid}/members`, { method: "POST", body: { username, role } }),
  removeMember: (sid, username) => request(`/schools/${sid}/members/${encodeURIComponent(username)}`, { method: "DELETE" }),
  publishClass: (sid, id, bundle) => request(`/schools/${sid}/classes`, { method: "POST", body: { id, bundle } }),
  sharedClass: (sid, cid) => request(`/schools/${sid}/classes/${cid}`),
  updateSharedClass: (sid, cid, baseRev, bundle) => request(`/schools/${sid}/classes/${cid}`, { method: "PUT", body: { base_rev: baseRev, bundle } }),
  deleteSharedClass: (sid, cid) => request(`/schools/${sid}/classes/${cid}`, { method: "DELETE" }),
  setClassRole: (sid, cid, username, role) => request(`/schools/${sid}/classes/${cid}/roles`, { method: "PUT", body: { username, role } }),
  schoolAudit: (sid) => request(`/schools/${sid}/audit`),
  schoolReport: (sid) => request(`/schools/${sid}/report`, { timeout: 120_000 }),

  // DeepTutor features
  deeptutorCapabilities: () => request("/deeptutor/capabilities", { timeout: 15_000 }),
  knowledgeBases: async () => {
    if (!isOnline()) throw new ApiError("You are offline.", 0);
    const res = await fetch("/api/knowledge-bases/list", { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(`Could not list knowledge bases (${res.status}).`, res.status);
    return res.json();
  },
  createKnowledgeBase: async (name, files) => {
    if (!isOnline()) throw new ApiError("You are offline.", 0);
    const form = new FormData();
    form.append("name", name);
    for (const f of files) form.append("files", f, f.name);
    const res = await fetch("/api/knowledge-bases", { method: "POST", body: form, credentials: "same-origin" });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(typeof data?.detail === "string" ? data.detail : `Could not create the knowledge base (${res.status}).`, res.status);
    return data;
  },
  /** Run a DeepTutor capability; calls onEvent for each streamed event. */
  runDeepTutor: async (payload, onEvent, signal) => {
    if (!isOnline()) throw new ApiError("You are offline. DeepTutor needs an internet connection.", 0);
    const res = await fetch(`${BASE}/deeptutor/run`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).detail;
      } catch {
        detail = "";
      }
      if (res.status === 401) throw new ApiError("Your session has expired. Sign in again.", 401);
      throw new ApiError(typeof detail === "string" && detail ? detail : `DeepTutor failed (${res.status}).`, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer.trim()));
  },
};
