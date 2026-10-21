// Cloudflare Worker: serves the DeepTutor / Tutor Companion server from a
// Cloudflare address (e.g. tutor-companion.<account>.workers.dev or your own
// domain) and passes every request through to the Render service. Some mobile
// networks fail to reach *.onrender.com; Cloudflare's network is reachable.
//
// UPSTREAM is set in wrangler.toml (the Render URL). Everything else —
// cookies, streaming answers, WebSockets, uploads — is passed through as is.
//
// Deep Tutor Pro: its web build is served from this Worker's static assets at
// /pro/, and the installed Windows/Android apps call the API from their own
// origins with a bearer token, so API responses carry CORS headers for them.

// Origins of the installed Deep Tutor Pro apps (Capacitor on Android, the
// Electron app:// scheme on Windows) and local development servers.
const APP_ORIGINS = new Set([
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
  "app://tutor-pro",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
]);
const CORS_PATHS = /^\/api\/(tutorpro|companion|knowledge-bases)(\/|$)/;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authorization", "proxy-authenticate"];

export default {
  async fetch(request, env) {
    const upstream = new URL(env.UPSTREAM);
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, upstream);

    const origin = request.headers.get("Origin");
    const appOrigin = origin && origin !== incoming.origin && APP_ORIGINS.has(origin) && CORS_PATHS.test(incoming.pathname) ? origin : null;
    if (appOrigin && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(appOrigin) });
    }

    const headers = new Headers(request.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", "https");
    // The server sees requests as same-origin, as it does on its own address.
    // App requests authenticate with a bearer token, not cookies; they reach
    // the server without an Origin, like any other API client.
    if (appOrigin) headers.delete("Origin");
    else if (headers.has("Origin")) headers.set("Origin", upstream.origin);
    const referer = headers.get("Referer");
    if (referer) headers.set("Referer", referer.replace(incoming.origin, upstream.origin));

    const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    let response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
    } catch (err) {
      return new Response(
        "The Tutor Companion server is starting up. Please try again in a minute.",
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30", ...(appOrigin ? corsHeaders(appOrigin) : {}) } },
      );
    }
    if (isWebSocket) return response;

    const out = new Response(response.body, response);
    if (appOrigin) for (const [k, v] of Object.entries(corsHeaders(appOrigin))) out.headers.set(k, v);
    // Keep redirects (e.g. to /login) on this address.
    const location = out.headers.get("Location");
    if (location) out.headers.set("Location", location.replace(upstream.origin, incoming.origin));
    // Cookies stay valid for this address: drop any Domain= pinned to the upstream host.
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) {
      out.headers.delete("Set-Cookie");
      for (const c of cookies) out.headers.append("Set-Cookie", c.replace(/;\s*Domain=[^;]*/i, ""));
    }
    return out;
  },
};
