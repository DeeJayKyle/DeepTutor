// Tutor Companion — application shell: boot, workspace selection, routing,
// connectivity status and install prompt.

import { api, isOnline } from "./api.js";
import { LocalDB } from "./db.js";
import { errorBox, toast } from "./ui.js";
import { esc } from "./util.js";

import * as dashboard from "./views/dashboard.js";
import * as classes from "./views/classes.js";
import * as units from "./views/units.js";
import * as library from "./views/library.js";
import * as assistant from "./views/assistant.js";
import * as materials from "./views/materials.js";
import * as students from "./views/students.js";
import * as research from "./views/research.js";
import * as reports from "./views/reports.js";
import * as backup from "./views/backup.js";
import * as settings from "./views/settings.js";

export const APP_VERSION = "1.0.0";

export const NAV = [
  ["dashboard", "Dashboard", "▦", dashboard],
  ["classes", "Classes", "▤", classes],
  ["units", "Course Units", "❏", units],
  ["library", "Digital Library", "▥", library],
  ["assistant", "AI Teaching Assistant", "✦", assistant],
  ["notes", "Lecture Notes", "✎", materials],
  ["exams", "Examinations & Quizzes", "✓", materials],
  ["assignments", "Assignments & Coursework", "☰", materials],
  ["students", "Students & Marks", "☺", students],
  ["research", "Research Assistant", "⌕", research],
  ["reports", "Reports & Analytics", "◔", reports],
  ["backup", "Backup & Sync", "⇅", backup],
  ["settings", "Settings", "⚙", settings],
];
const ROUTES = Object.fromEntries(NAV.map(([key, , , view]) => [key, view]));
ROUTES.material = materials;

const ctx = {
  db: null,
  user: "",
  role: "",
  ai: { available: false, model: "" },
  serverReachable: false,
  route: { name: "dashboard", params: {} },
  navigate(path) {
    if (location.hash !== `#/${path}`) location.hash = `#/${path}`;
    else render();
  },
  toast,
  refresh: () => render(),
  async lookups() {
    const [cls, uns] = await Promise.all([ctx.db.all("classes"), ctx.db.all("units")]);
    cls.sort((a, b) => a.name.localeCompare(b.name));
    uns.sort((a, b) => (a.code || a.title).localeCompare(b.code || b.title));
    const classById = new Map(cls.map((c) => [c.id, c]));
    const unitById = new Map(uns.map((u) => [u.id, u]));
    const unitLabel = (u) => (u ? `${u.code ? u.code + " — " : ""}${u.title}` : "");
    return {
      classes: cls,
      units: uns,
      classById,
      unitById,
      unitLabel,
      unitOptions: uns.map((u) => [u.id, `${classById.get(u.classId)?.name || "?"} › ${unitLabel(u)}`]),
      classOptions: cls.map((c) => [c.id, c.name]),
    };
  },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "dashboard";
  const [pathPart, query = ""] = raw.split("?");
  const [name, ...rest] = pathPart.split("/");
  const params = Object.fromEntries(new URLSearchParams(query));
  if (rest.length) params.id = decodeURIComponent(rest.join("/"));
  return { name: ROUTES[name] ? name : "dashboard", params };
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  ctx.route = parseHash();
  const main = document.getElementById("main");
  ctx.activeNav = ctx.route.name;
  document.body.classList.remove("nav-open");
  main.innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`;
  try {
    const view = ROUTES[ctx.route.name];
    const container = document.createElement("div");
    container.className = "view";
    await view.render(ctx, container, ctx.route.params, ctx.route.name);
    if (token !== renderToken) return;
    // Views may point the highlight elsewhere (e.g. an editor → its section).
    document.querySelectorAll("#nav a").forEach((a) => {
      const active = a.dataset.route === ctx.activeNav;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    main.replaceChildren(container);
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (token === renderToken) main.innerHTML = errorBox(err);
  }
}

function updateConnectivity() {
  const online = isOnline();
  const el = document.getElementById("conn");
  el.className = `conn ${online ? (ctx.serverReachable ? "conn-on" : "conn-warn") : "conn-off"}`;
  el.innerHTML = online
    ? ctx.serverReachable
      ? `<span class="dot"></span> Online${ctx.ai.available ? " · AI ready" : " · AI not configured"}`
      : `<span class="dot"></span> Online · server not reachable`
    : `<span class="dot"></span> Offline — your data is saved on this device`;
  document.body.classList.toggle("is-offline", !online);
}

async function checkServer() {
  try {
    const status = await api.status();
    ctx.serverReachable = true;
    ctx.ai = { available: Boolean(status.ai_available), model: status.model || "" };
    ctx.youtubeApi = Boolean(status.youtube_api);
    return status;
  } catch (err) {
    ctx.serverReachable = false;
    if (err.status === 401) {
      document.getElementById("signin-banner").hidden = false;
    }
    return null;
  } finally {
    updateConnectivity();
  }
}

function buildNav() {
  document.getElementById("nav").innerHTML = NAV.map(
    ([key, label, icon]) => `<a href="#/${key}" data-route="${key}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${esc(label)}</span></a>`,
  ).join("");
}

function setupInstall() {
  let deferred = null;
  const btn = document.getElementById("install-btn");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") toast("Tutor Companion is being installed on this device.", "success");
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener("appinstalled", () => (btn.hidden = true));
}

async function boot() {
  buildNav();
  setupInstall();
  document.getElementById("nav-toggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  document.getElementById("nav-scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));

  // Workspace: the signed-in account when online, else the last account used
  // on this device. Each account gets its own local database.
  const status = await checkServer();
  let user = status?.user || "";
  try {
    if (user) localStorage.setItem("tc:lastUser", user);
    else user = localStorage.getItem("tc:lastUser") || "local";
  } catch {
    user = user || "local";
  }
  ctx.user = user;
  ctx.role = status?.role || "";
  document.getElementById("who").textContent = user === "local" ? "Local workspace" : user;

  ctx.db = await new LocalDB(LocalDB.nameFor(user)).open();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  window.addEventListener("online", () => {
    updateConnectivity();
    checkServer();
    toast("Back online.", "success");
  });
  window.addEventListener("offline", () => {
    updateConnectivity();
    toast("You are offline. Everything you do is still saved on this device.", "info");
  });
  window.addEventListener("hashchange", render);
  setInterval(() => isOnline() && checkServer(), 120_000);
  updateConnectivity();
  await render();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => console.warn("Offline cache unavailable", err));
}

boot().catch((err) => {
  console.error(err);
  document.getElementById("main").innerHTML = errorBox(err);
});

export { ctx };
