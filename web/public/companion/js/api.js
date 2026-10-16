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
};
