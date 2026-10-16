// Tutor Companion service worker: caches the app shell and export libraries
// so the app opens and works without internet. API calls are never cached.

const VERSION = "tc-1.0.0";
const SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "css/app.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "js/app.js",
  "js/api.js",
  "js/backup.js",
  "js/db.js",
  "js/exporters.js",
  "js/grading.js",
  "js/markdown.js",
  "js/sources.js",
  "js/ui.js",
  "js/util.js",
  "js/views/assistant.js",
  "js/views/backup.js",
  "js/views/classes.js",
  "js/views/dashboard.js",
  "js/views/library.js",
  "js/views/materials.js",
  "js/views/reports.js",
  "js/views/research.js",
  "js/views/settings.js",
  "js/views/students.js",
  "js/views/units.js",
  "vendor/docx.iife.js",
  "vendor/pptxgen.bundle.js",
  "vendor/exceljs.min.js",
  "vendor/jspdf.umd.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload", credentials: "same-origin" })).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tc-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/companion/")) return;

  event.respondWith(respond(req));
});

const cachedFor = (req) =>
  caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined));

// Network first so updates arrive when online, but fall back to the cache
// when offline, when the server is slow to wake (3.5 s), or when an expired
// session would redirect the app shell to the login page — local data must
// stay reachable in every case.
async function respond(req) {
  const network = fetch(req).then((res) => {
    if (res.ok && !res.redirected && res.type === "basic") {
      const copy = res.clone();
      caches.open(VERSION).then((cache) => cache.put(req, copy));
    }
    return res;
  });
  const cached = await cachedFor(req);
  if (!cached) {
    try {
      return await network;
    } catch {
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3500));
  try {
    const res = await Promise.race([network, timeout]);
    if (!res) return cached;
    if (res.type === "opaqueredirect" || res.redirected || !res.ok) return cached;
    return res;
  } catch {
    return cached;
  }
}
