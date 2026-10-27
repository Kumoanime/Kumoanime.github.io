// CORS proxy for Kumo's Real-Debrid playback.
//
// Two jobs, both allowlisted:
//   GET/POST/DELETE /?url=https://api.real-debrid.com/rest/1.0/...
//     Forwards the REST call. The browser sends its own Authorization header.
//   GET /resolve?url=<comet playback url>   or   POST /resolve  { "url": "..." }
//     Follows Comet's redirects until the Real-Debrid download link, and
//     returns that file id. It does not send the Real-Debrid token to Comet,
//     and it does not proxy video bytes.
//
// Deploy with `npx wrangler deploy` from this folder. A change here does
// nothing until that deploy.

const API_HOST = "api.real-debrid.com";
const SLATE_MAX = 6_000_000;
const PEEK_MAX = 8192;
const MAX_HOPS = 5;

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

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

function deny(request, status, message) {
  return json(request, status, { error: message });
}

export function hostAllowedForResolve(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "elfhosted.com" || h.endsWith(".elfhosted.com")
    || h === "real-debrid.com" || h.endsWith(".real-debrid.com");
}

export function downloadFromUrl(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); }
  catch { return null; }
  if (!/(^|\.)download\.real-debrid\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/d\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  let filename = m[2];
  try { filename = decodeURIComponent(filename); } catch {}
  return { download: u.toString(), id: m[1], filename };
}

async function peek(res) {
  if (!res.body || !res.body.getReader) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < PEEK_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const out = new Uint8Array(Math.min(size, PEEK_MAX));
  let offset = 0;
  for (const chunk of chunks) {
    const n = Math.min(chunk.byteLength, out.byteLength - offset);
    out.set(chunk.subarray(0, n), offset);
    offset += n;
    if (offset >= out.byteLength) break;
  }
  return out;
}

function looksLikeSlate(status, headers, bytes) {
  if (status === 451) return true;
  let text = "";
  try { text = new TextDecoder().decode(bytes); } catch {}
  if (/INFRINGING_FILE|Couldn't start this stream/i.test(text)) return true;
  const type = headers.get("content-type") || "";
  const len = Number(headers.get("content-length") || 0);
  const range = /\/(\d+)\s*$/.exec(headers.get("content-range") || "");
  const total = range ? Number(range[1]) : (status === 200 ? len : 0);
  // A 2 KB range of a real episode has a large Content-Range total.
  // Comet's error clip is the whole object and is only a few megabytes.
  return /video|mp4/i.test(type) && status === 200 && !range && total > 0 && total < SLATE_MAX;
}

// Follow Comet (or ElfHosted) until a Real-Debrid download URL.
// `doFetch` is injectable for tests.
export async function resolvePlayback(startUrl, doFetch) {
  let current;
  try { current = new URL(String(startUrl || "")); }
  catch { return { ok: false, step: "comet", error: "invalid url" }; }
  if (current.protocol !== "https:" || !hostAllowedForResolve(current.hostname)) {
    return { ok: false, step: "comet", error: "Host not allowed" };
  }
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const direct = downloadFromUrl(current);
    if (direct) return { ok: true, step: "comet", ...direct };
    let res;
    try {
      res = await doFetch(current.href, {
        method: "GET",
        redirect: "manual",
        headers: new Headers({ Range: "bytes=0-2047", Accept: "*/*" }),
      });
    } catch {
      return { ok: false, step: "comet", error: "Upstream fetch failed" };
    }
    const status = res.status;
    if (status >= 300 && status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, step: "comet", status, error: "Redirect without location" };
      let next;
      try { next = new URL(loc, current); }
      catch { return { ok: false, step: "comet", status, error: "Bad redirect" }; }
      if (next.protocol !== "https:" || !hostAllowedForResolve(next.hostname)) {
        return { ok: false, step: "comet", status, error: "Redirect host not allowed" };
      }
      current = next;
      continue;
    }
    const bytes = await peek(res);
    if (looksLikeSlate(status, res.headers, bytes)) {
      return { ok: false, blocked: true, kind: "infringing", step: "comet", status, reason: "INFRINGING_FILE" };
    }
    return { ok: false, step: "comet", status, error: "Comet did not redirect to a Real-Debrid file" };
  }
  return { ok: false, step: "comet", error: "Too many redirects" };
}

async function readTarget(request) {
  const here = new URL(request.url);
  if (request.method === "GET" || request.method === "DELETE") return here.searchParams.get("url") || "";
  const type = request.headers.get("Content-Type") || "";
  if (/application\/json/i.test(type)) {
    try { const body = await request.json(); return body?.url || ""; }
    catch { return ""; }
  }
  return here.searchParams.get("url") || "";
}

async function handleResolve(request, doFetch) {
  const raw = await readTarget(request);
  const result = await resolvePlayback(raw, doFetch);
  return json(request, result.blocked ? 200 : (result.ok ? 200 : 502), result);
}

async function handleApi(request, doFetch) {
  let target;
  try { target = new URL(new URL(request.url).searchParams.get("url") || ""); }
  catch { return deny(request, 400, "Missing or invalid url"); }
  if (target.protocol !== "https:" || target.hostname !== API_HOST) return deny(request, 403, "Only api.real-debrid.com is allowed");

  const headers = new Headers();
  const auth = request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  const type = request.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  const init = { method: request.method, headers };
  if (request.method !== "GET") init.body = await request.arrayBuffer();

  let upstream;
  try { upstream = await doFetch(target, init); }
  catch { return deny(request, 502, "Upstream fetch failed"); }
  const out = new Headers(cors(request));
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) out.set("Content-Type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function handleRequest(request, doFetch = fetch) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!["GET", "POST", "DELETE"].includes(request.method)) return deny(request, 405, "Method not allowed");
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/resolve") return handleResolve(request, doFetch);
  return handleApi(request, doFetch);
}

export default { fetch: request => handleRequest(request) };
