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
    if (/\/playback\/[a-f0-9]{40}(?:\/|$)/i.test(u)) return true;
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

  function playbackOrder(rows, startIndex, opts) {
    const ranked = orderStreams(rows, opts);
    if (startIndex == null) return ranked;
    const first = ranked.find(r => r.i === startIndex);
    return first ? [first, ...ranked.filter(r => r.i !== startIndex)] : ranked;
  }

  function hashOf(s) {
    const direct = s?.infoHash || s?.info_hash || "";
    if (/^[a-f0-9]{40}$/i.test(direct)) return direct.toLowerCase();
    const u = String(s?.url || "");
    const m = u.match(/\/playback\/([a-f0-9]{40})\//i)
      || u.match(/\/real-?debrid\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i)
      || u.match(/[?&](?:hash|infoHash)=([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : "";
  }

  function playbackParts(url) {
    const m = String(url || "").match(/\/playback\/([a-f0-9]{40})\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
    if (!m) return null;
    const num = v => /^-?\d+$/.test(v) ? +v : null;
    return {
      hash: m[1].toLowerCase(),
      serviceIndex: m[2],
      fileIndex: m[3] === "n" ? null : m[3],
      season: num(m[4]),
      episode: num(m[5]),
    };
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
    } catch (e) { return failRd(e); }
    const id = added?.id;
    if (!id) return { ok: false, kind: "unavailable", message: "Real-Debrid didn't accept that torrent." };

    let info;
    try { info = await waitForFiles(request, id); }
    catch (e) { return failRd(e); }
    if (/magnet_error|error|dead|virus/.test(info.status || "")) return { ok: false, kind: "unavailable", message: "Real-Debrid couldn't open that torrent." };

    const file = pickTorrentFile(info.files, opts);
    if (!file) return { ok: false, kind: "unavailable", message: "Couldn't find this episode inside that release." };

    const already = (info.files || []).some(f => f.id === file.id && f.selected === 1) && (info.links || []).length;
    if (!already) {
      try { await request("POST", "/torrents/selectFiles/" + id, withIp({ files: String(file.id) })); }
      catch (e) {
        if (rdErrorKind(e.status, e.code, e.message) !== "error" || +e.code !== 31) return failRd(e);
      }
      try { info = await waitForFiles(request, id); }
      catch (e) { return failRd(e); }
    }

    if (info.status && info.status !== "downloaded" && !(info.links || []).length) {
      return { ok: false, kind: "uncached", message: "That release isn't cached on Real-Debrid yet. Choose a source with a lightning bolt." };
    }
    const link = selectedLink(info, file);
    if (!link) return { ok: false, kind: "unavailable", message: "Real-Debrid didn't return a link for that file." };

    let un;
    try { un = await request("POST", "/unrestrict/link", withIp({ link })); }
    catch (e) { return failRd(e); }
    if (!un || un.error) return failRd(Object.assign(new Error(un?.error || "unrestrict"), { status: 400, code: un?.error_code }));

    const ids = [un.id, idFromDownload(un.download)].filter((v, i, a) => v && a.indexOf(v) === i);
    let transcode = null, transcodeError = null;
    for (const tid of ids) {
      try { transcode = await request("GET", "/streaming/transcode/" + encodeURIComponent(tid)); break; }
      catch (e) { transcodeError = e; }
    }
    const picked = pickTranscode(transcode, !!opts.safari);
    if (picked) return { ok: true, url: picked.url, type: picked.type, filename: un.filename || file.path || "" };

    const name = un.filename || file.path || "";
    const container = (name.match(EXT_RE) || [])[1]?.toLowerCase() || "";
    if (un.download && browserCanPlay(container, !!opts.safari)) return { ok: true, url: un.download, type: sourceType(un.download) || "video/mp4", filename: name };
    if (transcodeError) {
      const kind = rdErrorKind(transcodeError.status, transcodeError.code, transcodeError.message);
      if (kind === "infringing" || kind === "auth" || kind === "rate") return failRd(transcodeError);
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
    const kind = e?.cors ? "cors" : rdErrorKind(e?.status, e?.code, e?.message);
    const message = {
      auth: "Real-Debrid refused the token. Reconnect it in the add-on, or paste a new token on the Add-ons page.",
      infringing: "Real-Debrid blocked that file (copyright filter).",
      rate: "Real-Debrid asked us to slow down. Wait a moment and try again.",
      cors: "Real-Debrid's API blocks browsers. Add the proxy URL on the Add-ons page.",
      ip: "Real-Debrid rejected the network this phone is on.",
      unavailable: "Real-Debrid doesn't have a playable copy of that file.",
    }[kind] || "Real-Debrid didn't return a playable stream.";
    return { ok: false, kind, message };
  }

  function externalPlayers(url) {
    const enc = encodeURIComponent(url);
    return [
      { name: "VLC", href: "vlc-x-callback://x-callback-url/stream?url=" + enc },
      { name: "Infuse", href: "infuse://x-callback-url/play?url=" + enc },
      { name: "Outplayer", href: "outplayer://" + url },
    ];
  }

  const api = {
    containerOf, browserCanPlay, isDebridResolver, isDirectDebridFile, isDebridStream,
    isCachedStream, isUncachedStream, rankStream, orderStreams, playbackOrder, hashOf,
    playbackParts, sourceType, kindLabel, classifyProbe, tokenFromUrl, tokenFromAddons,
    pickTorrentFile, pickTranscode, idFromDownload, rdErrorKind, resolveRealDebrid, externalPlayers,
  };
  root.KumoPlayback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
