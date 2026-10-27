// Tiny CORS proxy for Real-Debrid's REST API.
//
// api.real-debrid.com does not send Access-Control-Allow-Origin, so a page on
// GitHub Pages cannot ask it for an HLS link. This worker forwards only that
// API. It does not proxy video. Deploy with `npx wrangler deploy` from this
// folder, then paste the workers.dev address into Kumo → Add-ons → Real-Debrid.
//
// The browser calls  https://<worker>/?url=https://api.real-debrid.com/rest/1.0/...
// and sends its own Authorization header. The token is not stored here.

const ALLOWED_HOST = "api.real-debrid.com";

function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function deny(request, status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!["GET", "POST", "DELETE"].includes(request.method)) return deny(request, 405, "Method not allowed");

    let target;
    try { target = new URL(new URL(request.url).searchParams.get("url") || ""); }
    catch { return deny(request, 400, "Missing or invalid url"); }
    if (target.protocol !== "https:" || target.hostname !== ALLOWED_HOST) return deny(request, 403, "Only api.real-debrid.com is allowed");

    const headers = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);
    const type = request.headers.get("Content-Type");
    if (type) headers.set("Content-Type", type);
    const init = { method: request.method, headers };
    if (request.method !== "GET") init.body = await request.arrayBuffer();

    let upstream;
    try { upstream = await fetch(target, init); }
    catch { return deny(request, 502, "Upstream fetch failed"); }
    const out = new Headers(cors(request));
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) out.set("Content-Type", contentType);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
