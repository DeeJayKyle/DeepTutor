// Cloudflare Worker: serves the DeepTutor / Tutor Companion server from a
// Cloudflare address (e.g. tutor-companion.<account>.workers.dev or your own
// domain) and passes every request through to the Render service. Some mobile
// networks fail to reach *.onrender.com; Cloudflare's network is reachable.
//
// UPSTREAM is set in wrangler.toml (the Render URL). Everything else —
// cookies, streaming answers, WebSockets, uploads — is passed through as is.

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authorization", "proxy-authenticate"];

export default {
  async fetch(request, env) {
    const upstream = new URL(env.UPSTREAM);
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, upstream);

    const headers = new Headers(request.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", "https");
    // The server sees requests as same-origin, as it does on its own address.
    if (headers.has("Origin")) headers.set("Origin", upstream.origin);
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
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" } },
      );
    }
    if (isWebSocket) return response;

    const out = new Response(response.body, response);
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
