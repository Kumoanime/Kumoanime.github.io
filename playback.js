"use strict";
// How a Real-Debrid source becomes something a browser can play.
//
// Comet (and the same pattern in Torrentio) does not hand back the video.
// The stream URL is a playback link on the add-on. Requesting it either
// returns a short MP4 that *is* the error ("Couldn't start this stream",
// Ref: INFRINGING_FILE) or 302s to the original torrent file on
// *.download.real-debrid.com. Anime releases are almost always MKV.
// iPhone Safari will not decode Matroska, and telling <video> the type is
// video/mp4 makes it wait on a file it can never parse: black screen, a
// spinner, then an error. The error clip is a real MP4, so it "plays".
//
// Safari can play the HLS URL from Real-Debrid's /streaming/transcode
// (the "apple" playlist) with the native video element, which does not
// need CORS. The API that returns that URL does not send CORS headers, so
// a static site can only call it through a proxy the user runs. The proxy
// forwards JSON only; the video bytes come straight from Real-Debrid.

(function (root) {
  const VIDEO_EXT = "mkv|mp4|m4v|webm|avi|wmv|flv|m3u8|mov|ts";
  const EXT_RE = new RegExp("\\.(" + VIDEO_EXT + ")\\b", "i");
  const BROWSER_OK = { mp4: 1, m4v: 1, m3u8: 1, mov: 1 };

  function containerOf(s) {
    const hint = s?.behaviorHints?.filename || "";
    const hinted = String(hint).match(EXT_RE);
    if (hinted) return hinted[1].toLowerCase();
    const path = String(s?.url || "").split(/[?#]/)[0];
    const fromUrl = path.match(new RegExp("\\.(" + VIDEO_EXT + ")$", "i"));
    if (fromUrl) return fromUrl[1].toLowerCase();
    const blob = [s?.title, s?.description, s?.name].filter(Boolean).join(" ");
    const fromText = String(blob).match(EXT_RE);
    return fromText ? fromText[1].toLowerCase() : "";
  }

  // Safari (including iOS) plays MP4 and HLS. It does not play MKV, AVI, or
  // WebM reliably. An empty container means "we don't know yet".
  function browserCanPlay(container, safari) {
    const c = String(container || "").toLowerCase();
    if (!c) return true;
    if (BROWSER_OK[c]) return true;
    if (c === "webm") return !safari;
    return false;
  }

  function isDebridResolver(url) {
    const u = String(url || "");
    // Legacy Comet puts a hash in the path. Public ElfHosted Comet uses one long
    // encrypted segment and no visible infohash. Both are resolver links.
    if (/\/playback\/[^/?#]{16,}/i.test(u)) return true;
    if (/\/resolve\/[^?\s]*real-?debrid\//i.test(u)) return true;
    if (/\/real-?debrid\/[^/\s]+\/[a-f0-9]{40}(?:\/|$)/i.test(u)) return true;
    return false;
  }

  function isDirectDebridFile(url) {
    return /download\.real-debrid\.com|\/\/[^/]*real-debrid\.com\/d\//i.test(String(url || ""));
  }

  function isDebridStream(s) {
    if (!s) return false;
    if (isDebridResolver(s.url) || isDirectDebridFile(s.url)) return true;
    return /\[(RD|AD|PM|TB|DL)[^\]]*\]/i.test(s.name || "");
  }

  function isCachedStream(s) {
    const name = `${s?.name || ""} ${s?.title || ""}`;
    if (/⚡|⚡️/.test(name)) return true;
    if (/\[(RD|AD|PM|TB|DL)\+\]/i.test(name)) return true;
    if (/\bRD\+\b|\bcached\b/i.test(name) && !/not cached|uncached/i.test(name)) return true;
    return false;
  }

  function isUncachedStream(s) {
    const name = `${s?.name || ""} ${s?.title || ""}`;
    if (isCachedStream(s)) return false;
    return /⬇️|↓|\[(RD|AD|PM) download\]|uncached|not cached/i.test(name);
  }

  function rankStream(s, safari) {
    if (!s || !(s.url || s.ytId)) return -1;
    let score = isCachedStream(s) ? 100 : isUncachedStream(s) ? 10 : 40;
    const c = containerOf(s);
    if (c === "m3u8" || c === "mp4" || c === "m4v") score += 30;
    else if (!c) score += 15;
    else if (browserCanPlay(c, safari)) score += 20;
    if (s.ytId) score += 5;
    return score;
  }

  // Sub before dub, and within that a cached source before an uncached MKV.
  function orderStreams(rows, opts) {
    const safari = !!opts?.safari;
    const audioRank = { sub: 0, other: 1, dub: 2 };
    return rows.map((r, i) => ({ ...r, i: r.i ?? i })).filter(r => r.s && (r.s.url || r.s.ytId || r.s.externalUrl))
      .sort((a, b) => (audioRank[a.audio] ?? 1) - (audioRank[b.audio] ?? 1) || rankStream(b.s, safari) - rankStream(a.s, safari));
  }

  // explicit: the row the user tapped, and nothing else.
  // skipUncached: automatic fallback ignores ⬇️ sources.
  // Either way the result is one pass with each index at most once.
  function playbackOrder(rows, startIndex, opts) {
    const ranked = orderStreams(rows, opts);
    if (opts?.explicit) {
      const first = ranked.find(r => r.i === startIndex);
      return first ? [first] : [];
    }
    const list = opts?.skipUncached ? ranked.filter(r => !isUncachedStream(r.s)) : ranked;
    const seen = new Set();
    const unique = [];
    for (const row of list) {
      if (seen.has(row.i)) continue;
      seen.add(row.i);
      unique.push(row);
    }
    if (startIndex == null) return unique;
    const first = unique.find(r => r.i === startIndex);
    return first ? [first, ...unique.filter(r => r.i !== startIndex)] : unique;
  }

  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32ToHex(input) {
    const s = String(input || "").replace(/=+$/, "").toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const idx = B32.indexOf(s[i]);
      if (idx < 0) return "";
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >> bits) & 255);
      }
    }
    return out.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function hexAscii(input) {
    const s = String(input || "");
    if (!/^[a-f0-9]+$/i.test(s) || s.length % 2) return "";
    let text = "";
    for (let i = 0; i < s.length; i += 2) {
      const code = parseInt(s.slice(i, i + 2), 16);
      if (code < 32 || code > 126) return "";
      text += String.fromCharCode(code);
    }
    return text;
  }

  // Comet stores the torrent id as 40 hex, 32-char base32, or 80 hex digits
  // that are the ASCII of a 40-hex id. Real-Debrid's magnet needs 40 hex.
  function normalizeInfoHash(raw) {
    let s = String(raw || "").trim();
    const btih = s.match(/btih:([a-z0-9]+)/i);
    if (btih) s = btih[1];
    if (/^[a-f0-9]{80}$/i.test(s)) {
      const decoded = hexAscii(s);
      if (/^[a-f0-9]{40}$/i.test(decoded)) s = decoded;
    }
    if (/^[a-z2-7]{32}$/i.test(s)) {
      const hex = base32ToHex(s);
      if (/^[a-f0-9]{40}$/i.test(hex)) s = hex;
    }
    return /^[a-f0-9]{40}$/i.test(s) ? s.toLowerCase() : "";
  }

  function hashOf(s) {
    const direct = normalizeInfoHash(s?.infoHash || s?.info_hash || "");
    if (direct) return direct;
    const binge = String(s?.behaviorHints?.bingeGroup || "");
    const pieces = binge.split("|");
    for (let i = pieces.length - 1; i >= 0; i--) {
      const fromGroup = normalizeInfoHash(pieces[i]);
      if (fromGroup) return fromGroup;
    }
    const u = String(s?.url || "");
    // Only the old /playback/{hash}/{service}/{file}/{season}/{episode} shape.
    // A single encrypted /playback/<blob> segment is not a torrent id.
    const legacy = u.match(/\/playback\/([a-z0-9]{32,80})\/[^/?#]+\/[^/?#]+\/[^/?#]+\/[^/?#]+/i);
    const rd = u.match(/\/real-?debrid\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i);
    const q = u.match(/[?&](?:hash|infoHash|info_hash)=([a-z0-9]{32,80})\b/i);
    const raw = (legacy || rd || q || [])[1];
    return raw ? normalizeInfoHash(raw) : "";
  }

  function playbackParts(url) {
    const m = String(url || "").match(/\/playback\/([a-z0-9]{32,80})\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
    if (!m) return null;
    const hash = normalizeInfoHash(m[1]);
    if (!hash) return null;
    const num = v => /^-?\d+$/.test(v) ? +v : null;
    return {
      hash,
      serviceIndex: m[2],
      fileIndex: m[3] === "n" ? null : m[3],
      season: num(m[4]),
      episode: num(m[5]),
    };
  }

  // What to tell the person when a debrid file cannot be handed to the player.
  // A saved proxy must never be told to "add a proxy".
  function explainFailure(info) {
    const hash = !!info?.hash;
    const token = !!info?.token;
    const proxy = !!info?.proxy;
    const block = info?.block || null;
    const asksForProxy = block && (block.kind === "cors" || /add a proxy|blocks websites/i.test(block.message || ""));
    const cometBlocked = block && (block.kind === "status" || (block.kind === "infringing" && (block.step === "comet" || block.step === "phone")));
    let kind, message;
    if (cometBlocked) {
      kind = block.kind;
      message = block.message || "Comet's link is blocked by Real-Debrid (copyright filter).";
    } else if (block?.kind === "external" || block?.kind === "wrong-ip" || block?.kind === "slate") {
      kind = block.kind;
      message = block.message || (block.kind === "external" ? EXTERNAL_ONLY : "Comet didn't return a playable stream.");
    } else if (!hash && !block?.message) {
      kind = "hash";
      message = "Couldn't find the torrent hash in this source.";
    } else if (!token && !block?.message) {
      kind = "token";
      message = "No Real-Debrid token found.";
    } else if (proxy && asksForProxy) {
      kind = "proxy";
      message = "The saved proxy didn't get an answer from Real-Debrid.";
    } else if (block?.message) {
      kind = block.kind || "unsupported";
      message = block.message;
    } else if (!proxy) {
      kind = "proxy";
      message = "iPhone Safari can't play this MKV. Add a proxy URL on the Add-ons page, or open this source in VLC or Infuse.";
    } else {
      kind = "unsupported";
      message = "Real-Debrid didn't return a playable stream.";
    }
    const step = block?.step || info?.step || "";
    const bits = ["kind " + kind];
    if (step) bits.push("step " + step);
    bits.push("hash " + (hash ? "yes" : "no"), "token " + (token ? "yes" : "no"), "proxy " + (proxy ? "yes" : "no"));
    const status = block?.status || info?.status;
    if (status) bits.push("HTTP " + status);
    const err = block?.error || info?.error;
    if (err) bits.push(String(err).replace(/\s+/g, " ").slice(0, 80));
    return { kind, message, detail: bits.join(" · ") };
  }

  // Only name a type when the URL actually says what it is. A Comet playback
  // link has no extension; calling it video/mp4 makes Safari parse an MKV
  // (or a redirect to one) as MP4 and never finish loading.
  function sourceType(url) {
    const path = String(url || "").split(/[?#]/)[0];
    if (/\.m3u8$/i.test(path)) return "application/vnd.apple.mpegurl";
    if (/\.webm$/i.test(path)) return "video/webm";
    if (/\.(mp4|m4v)$/i.test(path)) return "video/mp4";
    return undefined;
  }

  function kindLabel(s) {
    if (!s) return "";
    if (s.ytId) return "YouTube";
    const c = containerOf(s);
    if (c === "m3u8") return "HLS";
    if (c === "mkv") return "MKV";
    if (c === "webm") return "WebM";
    if (c === "mp4" || c === "m4v") return "MP4";
    if (s.url) return isDebridStream(s) ? "Debrid" : "Video";
    if (s.externalUrl) return "Opens site";
    if (s.infoHash) return "Torrent";
    return "";
  }

  // A probe is the ranged GET of the stream URL with redirects left alone.
  // `redirect` means the add-on sent us to the debrid CDN (the real file).
  // A small video body is Comet/MediaFusion's status clip, not the episode.
  function classifyProbe(probe, stream) {
  if (!probe) return "unknown";
  if (probe.kind === "redirect" || probe.type === "opaqueredirect" || (probe.status >= 300 && probe.status < 400)) return "redirect";
  const debrid = isDebridStream(stream) || isDebridResolver(stream?.url);
  const video = /video|mp4|octet-stream/i.test(probe.contentType || "");
  // `complete` means `size` is the whole object, not one byte-range chunk.
  // A 2 KB range of a real episode must not look like Comet's error clip.
  if (debrid && video && probe.complete && probe.size && probe.size < 6_000_000) return "status";
  if (probe.kind === "http") return "http";
  return "file";
  }

  function b64Json(segment) {
    try {
      let s = String(segment).replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      const text = decodeURIComponent(escape(atob(s)));
      const j = JSON.parse(text);
      return j && typeof j === "object" ? j : null;
    } catch { return null; }
  }

  function tokenFromConfig(j) {
    if (!j) return "";
    const list = j.debridServices || j.debrid_services;
    if (Array.isArray(list)) {
      const rd = list.find(e => /real-?debrid/i.test(e?.service || e?.name || ""));
      if (rd?.apiKey && String(rd.apiKey).length > 8) return String(rd.apiKey);
    }
    if (/real-?debrid/i.test(j.debridService || "") && j.debridApiKey && String(j.debridApiKey).length > 8) return String(j.debridApiKey);
    for (const k of ["rdToken", "rd_token", "realdebrid", "realDebridApiKey"]) {
      if (j[k] && String(j[k]).length > 8) return String(j[k]);
    }
    return "";
  }

  // The key is already inside the installed add-on URL. Read it from there
  // so the owner doesn't have to paste it a second time. Never display it.
  function tokenFromUrl(url) {
    const u = String(url || "");
  const tor = u.match(/real-?debrid=([^/|&\s]+)/i);
  if (tor && tor[1].length > 8 && !/^https?:/i.test(tor[1])) {
    let token = tor[1];
    try { token = decodeURIComponent(token); } catch {}
    return { token, from: "Torrentio" };
  }
    let parts = [];
    try { parts = new URL(u).pathname.split("/").filter(Boolean); }
    catch { parts = u.split("/").filter(Boolean); }
    for (const p of parts) {
      if (p.length < 16 || p === "manifest.json") continue;
      const token = tokenFromConfig(b64Json(p));
      if (token) return { token, from: "Comet" };
    }
    const inPath = u.match(/\/real-?debrid\/([^/]{9,})\//i);
    if (inPath && !/^[a-f0-9]{40}$/i.test(inPath[1])) return { token: decodeURIComponent(inPath[1]), from: "add-on" };
    return null;
  }

  function tokenFromAddons(addons) {
    for (const a of addons || []) {
      if (a.enabled === false) continue;
      const found = tokenFromUrl(a.url || a.manifestUrl || "");
      if (found) return found;
    }
    return null;
  }

  function isVideoPath(p) {
    return new RegExp("\\.(" + VIDEO_EXT + ")$", "i").test(String(p || "").split(/[?#]/)[0]) && !/sample|trailer|\bncop\b|\bnced\b/i.test(p);
  }

  function episodeScore(path, episode, season) {
    if (!episode) return 0;
    const n = String(path || "");
    const ep = String(+episode);
    let score = 0;
    if (season && new RegExp("s0*" + (+season) + "[. _-]*e0*" + (+episode) + "\\b", "i").test(n)) score += 100;
    if (new RegExp("(?:^|[^a-z0-9])e0*" + (+episode) + "\\b", "i").test(n)) score += 80;
    if (new RegExp(" - 0*" + (+episode) + "(?:[^0-9]|$)").test(n)) score += 70;
    const ee = ep.padStart(2, "0");
    if (ee !== ep && new RegExp("(?:^|[^0-9])" + ee + "(?:[^0-9]|$)").test(n)) score += 40;
    return score;
  }

  function pickTorrentFile(files, opts) {
    const videos = (files || []).filter(f => isVideoPath(f.path || f.name || ""));
    if (!videos.length) return null;
    const fileIndex = opts?.fileIndex;
    if (fileIndex != null && fileIndex !== "" && fileIndex !== "n") {
      const byId = videos.find(f => String(f.id) === String(fileIndex));
      if (byId) return byId;
    }
    const ranked = videos.map(f => ({ f, s: episodeScore(f.path || f.name || "", opts?.episode, opts?.season) }))
      .sort((a, b) => b.s - a.s || (b.f.bytes || 0) - (a.f.bytes || 0));
    if (ranked[0].s > 0) return ranked[0].f;
    return videos.length === 1 ? videos[0] : null;
  }

  function firstUrl(section) {
    if (!section || typeof section !== "object") return "";
    if (typeof section.full === "string" && /^https?:\/\//i.test(section.full)) return section.full;
    for (const v of Object.values(section)) if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    return "";
  }

  // Safari must get the HLS playlist: the native player doesn't need CORS.
  // Other browsers get a progressive MP4/WebM, because hls.js would need
  // CORS on Real-Debrid's stream host and that host doesn't send it.
  function pickTranscode(transcode, safari) {
    if (!transcode || typeof transcode !== "object") return null;
    const apple = firstUrl(transcode.apple);
    const mp4 = firstUrl(transcode.liveMP4);
    const webm = firstUrl(transcode.h264WebM);
    const url = safari ? (apple || mp4 || webm) : (mp4 || webm || apple);
    if (!url) return null;
    return { url, type: sourceType(url) };
  }

  function idFromDownload(url) {
    const m = String(url || "").match(/\/d\/([^/?#]+)\//);
    return m ? m[1] : "";
  }

  function rdDownload(url) {
    let u;
    try { u = new URL(String(url || "")); }
    catch { return null; }
    if (!/(^|\.)download\.real-debrid\.com$/i.test(u.hostname)) return null;
    const id = idFromDownload(u.href);
    if (!id) return null;
    let filename = "";
    const name = u.pathname.match(/\/d\/[^/]+\/([^/]+)/);
    if (name) { try { filename = decodeURIComponent(name[1]); } catch { filename = name[1]; } }
    return { id, download: u.href, filename };
  }

  // Public ElfHosted Comet plays its warning from slate.elfhosted.com.
  // Any hop there is the slate, including a 206 of slate.mp4. The title=
  // query is the reason. "Opened on a different connection" is the IP lock
  // (https://docs.elfhosted.com/m/wrong-ip), not Real-Debrid's copyright filter.
  function slateFromUrl(url) {
    let u;
    try { u = new URL(String(url || "")); }
    catch { return null; }
    if (!/(^|\.)slate\.elfhosted\.com$/i.test(u.hostname)) return null;
    const title = u.searchParams.get("title") || "";
    const docs = u.searchParams.get("url") || "";
    const wrong = /different connection|wrong[ -]?ip/i.test(`${title} ${docs}`);
    const infringing = /INFRINGING_FILE|couldn'?t start this stream/i.test(title);
    if (wrong && !infringing) {
      return {
        action: "wrong-ip", kind: "wrong-ip", step: "comet", blocked: false,
        reason: title || "Opened on a different connection",
        message: "Comet opened this link on a different connection. It is not blocked. Load the sources on this phone, then play in Infuse or VLC.",
      };
    }
    if (infringing) {
      return {
        action: "blocked", kind: "infringing", step: "comet", blocked: true,
        reason: title || "INFRINGING_FILE",
        message: "Comet's link is blocked by Real-Debrid (copyright filter).",
      };
    }
    return {
      action: "slate", kind: "slate", step: "comet", blocked: false,
      reason: title || "Comet error slate",
      message: title || "Comet sent an error slate instead of the episode.",
    };
  }

  // What a browser fetch of a Comet playback link can see.
  //
  // *.download.real-debrid.com does not send Access-Control-Allow-Origin
  // (checked on 20.download.real-debrid.com: Server Lity, 403/404, no ACAO).
  // fetch() that follows Comet onto that host rejects, so response.url is
  // never readable for a real file. mode:"no-cors" stays opaque and its url
  // is not the redirect target. HEAD hits the same CORS check. A readable
  // landing on slate.elfhosted.com is the slate; a 206 from it is not a file.
  const EXTERNAL_ONLY = "Comet's free public links only play in an outside player on this phone. Use Infuse or VLC.";

  function classifyPhoneFetch(result) {
    const requestUrl = String(result?.requestUrl || "");
    const finalUrl = String(result?.url || "");
    const readable = finalUrl && !result?.opaque && !result?.unreadable && result?.type !== "opaque" && result?.type !== "opaqueredirect";
    if (readable) {
      const rd = rdDownload(finalUrl);
      if (rd) return { action: "transcode", id: rd.id, download: rd.download, filename: rd.filename, step: "phone" };
      const slate = slateFromUrl(finalUrl);
      if (slate) return slate;
      const video = /video|mp4|mpegurl|octet-stream/i.test(result.contentType || "");
      const same = requestUrl && finalUrl.split("#")[0] === requestUrl.split("#")[0];
      if (same && video && result.complete && result.size > 0 && result.size < 6_000_000) {
        return { action: "blocked", kind: "status", step: "phone", message: "Comet's link is blocked by Real-Debrid (copyright filter)." };
      }
      const type = sourceType(finalUrl);
      if (type && result.status && result.status < 400) return { action: "play", url: finalUrl, type, step: "phone" };
    }
    const why = result?.opaque || result?.type === "opaque" ? "no-cors" : "cors";
    return {
      action: "external", kind: "external", step: "phone", reason: why,
      error: why === "no-cors" ? "no-cors response.url is not the redirect target" : "download host sends no CORS",
      message: EXTERNAL_ONLY,
    };
  }

  // Hidden until "Show all sources": uncached, copyright slates, other slates,
  // and wrong-IP warnings. A source that only plays in Infuse stays listed.
  function listDisposition(stream, verdict) {
    const v = String(verdict || "");
    if (v === "blocked" || v === "infringing" || v === "status") return "blocked";
    if (v === "slate") return "slate";
    if (v === "wrong-ip") return "wrong-ip";
    if (v === "fail") return "failed";
    if (isUncachedStream(stream)) return "uncached";
    return "ready";
  }

  function hideFromList(stream, verdict, showAll) {
    if (showAll) return false;
    const d = listDisposition(stream, verdict);
    return d === "blocked" || d === "slate" || d === "uncached" || d === "wrong-ip";
  }

  function rdErrorKind(status, code, message) {
    const m = String(message || "").toLowerCase();
    const c = +code || 0;
    if (status === 401 || c === 8 || c === 9 || c === 14 || /bad_token|bad token|permission|account_locked/.test(m)) return "auth";
    if (c === 35 || status === 451 || /infring/.test(m)) return "infringing";
    if (c === 34 || status === 429 || c === 5 || /too many|slow_down|slow down/.test(m)) return "rate";
    if (c === 22 || /ip_not_allowed|ip address not allowed/.test(m)) return "ip";
    if (c === 24 || c === 25 || c === 16 || /unavailable|file_unavailable/.test(m)) return "unavailable";
    return "error";
  }

  function selectedLink(info, file) {
    const links = info?.links || [];
    const selected = (info?.files || []).filter(f => f.selected === 1);
    if (file && selected.length) {
      const idx = selected.findIndex(f => f.id === file.id);
      if (idx >= 0 && links[idx]) return links[idx];
    }
    return links.length === 1 ? links[0] : "";
  }

  // Not used on the default playback path. addMagnet from a Cloudflare IP
  // returns HTTP 451 for files Comet already unrestricted. Kept for tests.
  // `request(method, path, params)` performs one Real-Debrid REST call and
  // returns the parsed JSON, or throws an Error with .status, .code, .cors.
  async function resolveRealDebrid(opts) {
    const request = opts.request;
    const hash = String(opts.hash || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) return { ok: false, kind: "unsupported", message: "This source has no torrent id to resolve." };
    const ip = opts.clientIp || "";
    const withIp = extra => ip ? { ...extra, ip } : extra;
    let added;
    try {
      added = await request("POST", "/torrents/addMagnet", withIp({ magnet: "magnet:?xt=urn:btih:" + hash }));
    } catch (e) { return failRd(Object.assign(e, { step: "addMagnet" })); }
    const id = added?.id;
    if (!id) return { ok: false, kind: "unavailable", message: "Real-Debrid didn't accept that torrent." };

    let info;
    try { info = await waitForFiles(request, id); }
    catch (e) { return failRd(Object.assign(e, { step: "info" })); }
    if (/magnet_error|error|dead|virus/.test(info.status || "")) return { ok: false, kind: "unavailable", step: "info", message: "Real-Debrid couldn't open that torrent." };

    const file = pickTorrentFile(info.files, opts);
    if (!file) return { ok: false, kind: "unavailable", message: "Couldn't find this episode inside that release." };

    const already = (info.files || []).some(f => f.id === file.id && f.selected === 1) && (info.links || []).length;
    if (!already) {
      try { await request("POST", "/torrents/selectFiles/" + id, withIp({ files: String(file.id) })); }
      catch (e) {
        if (rdErrorKind(e.status, e.code, e.message) !== "error" || +e.code !== 31) return failRd(Object.assign(e, { step: "selectFiles" }));
      }
      try { info = await waitForFiles(request, id); }
      catch (e) { return failRd(Object.assign(e, { step: "info" })); }
    }

    if (info.status && info.status !== "downloaded" && !(info.links || []).length) {
      return { ok: false, kind: "uncached", message: "That release isn't cached on Real-Debrid yet. Choose a source with a lightning bolt." };
    }
    const link = selectedLink(info, file);
    if (!link) return { ok: false, kind: "unavailable", message: "Real-Debrid didn't return a link for that file." };

    let un;
    try { un = await request("POST", "/unrestrict/link", withIp({ link })); }
    catch (e) { return failRd(Object.assign(e, { step: "unrestrict" })); }
    if (!un || un.error) return failRd(Object.assign(new Error(un?.error || "unrestrict"), { status: 400, code: un?.error_code, step: "unrestrict" }));

    const ids = [un.id, idFromDownload(un.download)].filter((v, i, a) => v && a.indexOf(v) === i);
    let transcode = null, transcodeError = null;
    for (const tid of ids) {
      try { transcode = await request("GET", "/streaming/transcode/" + encodeURIComponent(tid)); break; }
      catch (e) { e.step = "transcode"; transcodeError = e; }
    }
    const picked = pickTranscode(transcode, !!opts.safari);
    if (picked) return { ok: true, url: picked.url, type: picked.type, filename: un.filename || file.path || "" };

    const name = un.filename || file.path || "";
    const container = (name.match(EXT_RE) || [])[1]?.toLowerCase() || "";
    if (un.download && browserCanPlay(container, !!opts.safari)) return { ok: true, url: un.download, type: sourceType(un.download) || "video/mp4", filename: name };
    if (transcodeError) {
      const kind = rdErrorKind(transcodeError.status, transcodeError.code, transcodeError.message);
      if (kind === "infringing" || kind === "auth" || kind === "rate") return failRd(Object.assign(transcodeError, { step: "transcode" }));
    }
    return { ok: false, kind: "unsupported", message: "Real-Debrid only has the original " + (container || "MKV").toUpperCase() + ", which this browser can't play.", filename: name };
  }

  async function waitForFiles(request, id) {
    let info = await request("GET", "/torrents/info/" + id);
    for (let i = 0; i < 6; i++) {
      const files = info?.files || [];
      const st = info?.status || "";
      if (files.length && (st === "waiting_files_selection" || st === "downloaded" || st === "downloading" || (info.links || []).length)) return info;
      if (/magnet_error|error|dead/.test(st)) return info;
      await new Promise(r => setTimeout(r, 700));
      info = await request("GET", "/torrents/info/" + id);
    }
    return info;
  }

  function failRd(e) {
    const step = e?.step || "";
    // A 451 from Kumo's own addMagnet/unrestrict is not Comet's error slate.
    // Only step "comet" stays "infringing", which is what the player calls blocked.
    let kind = e?.proxy ? "proxy" : e?.cors ? "cors" : rdErrorKind(e?.status, e?.code, e?.message);
    if (kind === "infringing" && step !== "comet") kind = "refused";
    const where = step || "request";
    const message = {
      auth: "Real-Debrid refused the token. Reconnect it in the add-on, or paste a new token on the Add-ons page.",
      infringing: "Comet's link is blocked by Real-Debrid (copyright filter).",
      refused: "Real-Debrid refused Kumo's own " + where + " call" + (e?.status ? " (HTTP " + e.status + ")" : "") + ". Comet's link was not blocked.",
      rate: "Real-Debrid asked us to slow down. Wait a moment and try again.",
      cors: "Real-Debrid's API blocks browsers. Add the proxy URL on the Add-ons page.",
      proxy: "The saved proxy didn't get an answer from Real-Debrid.",
      ip: "Real-Debrid rejected the network this phone is on.",
      unavailable: "Real-Debrid doesn't have a playable copy of that file.",
    }[kind] || "Real-Debrid didn't return a playable stream.";
    const error = e?.cause?.message || (kind === "proxy" || kind === "cors" ? e?.message : "") || "";
    return { ok: false, kind, message, status: e?.status || 0, error, step };
  }

  // Worker /resolve result. No magnet step: a missing id means play outside,
  // unless the body is a real slate. wrong-ip is never "blocked".
  function nextFromCometResolve(body) {
    if (body?.kind === "wrong-ip") {
      const slate = slateFromUrl("https://slate.elfhosted.com/slate.m3u8?title=" + encodeURIComponent(body.reason || "Opened on a different connection"));
      return { ...slate, status: body.status || 0, step: "comet" };
    }
    if (body?.kind === "slate") {
      return { action: "slate", kind: "slate", step: "comet", status: body.status || 0, reason: body.reason || "Comet error slate", message: body.reason || "Comet sent an error slate instead of the episode." };
    }
    if (body?.blocked) {
      return { action: "blocked", kind: "infringing", step: "comet", status: body.status || 0, reason: body.reason || "INFRINGING_FILE", message: "Comet's link is blocked by Real-Debrid (copyright filter)." };
    }
    if (body?.ok && body.id) return { action: "transcode", id: String(body.id), download: body.download || "", filename: body.filename || "", step: "comet" };
    return { action: "external", kind: "external", step: body?.step || "comet", status: body?.status || 0, error: body?.error || "", message: EXTERNAL_ONLY };
  }

  function externalPlayers(url) {
    const enc = encodeURIComponent(url);
    return [
      { id: "infuse", name: "Infuse", href: "infuse://x-callback-url/play?url=" + enc },
      { id: "vlc", name: "VLC", href: "vlc-x-callback://x-callback-url/stream?url=" + enc },
      { id: "outplayer", name: "Outplayer", href: "outplayer://" + url },
    ];
  }

  const api = {
    containerOf, browserCanPlay, isDebridResolver, isDirectDebridFile, isDebridStream,
    isCachedStream, isUncachedStream, rankStream, orderStreams, playbackOrder, hashOf,
    playbackParts, sourceType, kindLabel, classifyProbe, tokenFromUrl, tokenFromAddons,
    pickTorrentFile, pickTranscode, idFromDownload, rdDownload, rdErrorKind, resolveRealDebrid, externalPlayers,
    normalizeInfoHash, explainFailure, failRd, nextFromCometResolve, slateFromUrl, classifyPhoneFetch,
    listDisposition, hideFromList, externalOnlyMessage: EXTERNAL_ONLY,
  };
  root.KumoPlayback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
