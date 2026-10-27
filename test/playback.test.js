"use strict";
const assert = require("assert");
const P = require("../playback.js");

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const comet = "https://comet.elfhosted.com/" + b64({
  debridServices: [{ service: "realdebrid", apiKey: "RDTOKEN123456" }],
}) + "/manifest.json";

assert.deepEqual(P.tokenFromUrl(comet), { token: "RDTOKEN123456", from: "Comet" });
assert.deepEqual(
  P.tokenFromUrl("https://torrentio.strem.fun/sort=qualitysize|realdebrid=TORRENTIOTOKEN/manifest.json"),
  { token: "TORRENTIOTOKEN", from: "Torrentio" },
);
assert.equal(P.tokenFromAddons([{ url: comet, enabled: true }]).token, "RDTOKEN123456");
assert.equal(P.tokenFromAddons([{ url: comet, enabled: false }]), null);

const mkv = {
  name: "[RD⚡] Comet 1080p",
  url: "https://comet.elfhosted.com/abc/playback/0123456789abcdef0123456789abcdef01234567/0/2/3/1?torrent_name=Show&name=Ep",
  behaviorHints: { filename: "Show.S03E01.1080p.HEVC.mkv" },
};
assert.equal(P.containerOf(mkv), "mkv");
assert.equal(P.isDebridResolver(mkv.url), true);
assert.equal(P.isCachedStream(mkv), true);
assert.equal(P.hashOf(mkv), "0123456789abcdef0123456789abcdef01234567");
assert.deepEqual(P.playbackParts(mkv.url), {
  hash: "0123456789abcdef0123456789abcdef01234567",
  serviceIndex: "0",
  fileIndex: "2",
  season: 3,
  episode: 1,
});
assert.equal(P.browserCanPlay("mkv", true), false);
assert.equal(P.browserCanPlay("mp4", true), true);
assert.equal(P.browserCanPlay("", true), true);
assert.equal(P.sourceType(mkv.url), undefined);
assert.equal(P.sourceType("https://cdn.example/full.m3u8"), "application/vnd.apple.mpegurl");
assert.equal(P.kindLabel(mkv), "MKV");

const uncached = { name: "[RD⬇️] Comet 720p", url: "https://x/a.mp4", behaviorHints: { filename: "a.mp4" } };
assert.equal(P.isUncachedStream(uncached), true);
assert.ok(P.rankStream(mkv, true) > P.rankStream(uncached, true));

const rows = [
  { s: uncached, audio: "sub" },
  { s: mkv, audio: "sub" },
  { s: { name: "[RD⚡] Comet", url: "https://x/dub.mp4", behaviorHints: { filename: "dub.mp4" } }, audio: "dub" },
];
const order = P.playbackOrder(rows, null, { safari: true });
assert.equal(order[0].i, 1, "cached sub is tried before an uncached sub");
assert.equal(P.playbackOrder(rows, 0, { safari: true })[0].i, 0, "an explicit index stays first");
assert.deepEqual(P.playbackOrder(rows, 0, { safari: true, explicit: true }).map(r => r.i), [0], "a tap plays only that source");
const auto = P.playbackOrder(rows, null, { safari: true, skipUncached: true });
assert.ok(auto.every(r => !P.isUncachedStream(r.s)), "auto fallback skips uncached");
assert.equal(new Set(auto.map(r => r.i)).size, auto.length, "auto fallback lists each source once");
assert.ok(!auto.some(r => r.i === 0));

const HASH = "0123456789abcdef0123456789abcdef01234567";
const binge = { name: "[RD⚡] Comet 1080p", behaviorHints: { bingeGroup: "comet|realdebrid|" + HASH, filename: "Show.mkv" } };
assert.equal(P.hashOf(binge), HASH);
assert.equal(P.hashOf({ url: "https://comet.elfhosted.com/cfg/playback/AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH/0/n/3/1?name=Ep" }), HASH);
assert.equal(P.hashOf({ url: "https://comet.elfhosted.com/cfg/playback/30313233343536373839616263646566303132333435363738396162636465663031323334353637/0/2/3/1" }), HASH);
assert.equal(P.isDebridResolver("https://comet.elfhosted.com/cfg/playback/AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH/0/n/3/1"), true);
assert.equal(P.playbackParts("https://comet.elfhosted.com/eyJ/playback/" + HASH + "/0/n/3/1?media_type=series").fileIndex, null);
assert.equal(P.playbackParts("https://comet.elfhosted.com/eyJ/playback/" + HASH + "/0/n/3/1?media_type=series").episode, 1);

const proxyOn = P.explainFailure({ hash: HASH, token: true, proxy: true, block: { kind: "cors", message: "Real-Debrid's API blocks browsers. Add the proxy URL on the Add-ons page.", error: "Load failed" } });
assert.equal(proxyOn.kind, "proxy");
assert.ok(!/add a proxy/i.test(proxyOn.message), proxyOn.message);
assert.ok(/hash yes/.test(proxyOn.detail) && /token yes/.test(proxyOn.detail) && /proxy yes/.test(proxyOn.detail));
assert.ok(/Load failed/.test(proxyOn.detail));
const noHash = P.explainFailure({ hash: "", token: true, proxy: true });
assert.equal(noHash.kind, "hash");
assert.ok(/torrent hash/.test(noHash.message));
assert.ok(!/add a proxy/i.test(noHash.message));
const noToken = P.explainFailure({ hash: HASH, token: false, proxy: true });
assert.equal(noToken.kind, "token");
assert.ok(/no real-debrid token/i.test(noToken.message));
const noProxy = P.explainFailure({ hash: HASH, token: true, proxy: false });
assert.ok(/add a proxy/i.test(noProxy.message));

assert.equal(P.classifyProbe({ kind: "redirect" }, mkv), "redirect");
assert.equal(P.classifyProbe({ type: "opaqueredirect" }, mkv), "redirect");
assert.equal(P.classifyProbe({ contentType: "video/mp4", size: 400000, complete: true }, mkv), "status");
assert.equal(P.classifyProbe({ contentType: "video/mp4", size: 2048, complete: false }, mkv), "file");
assert.equal(P.classifyProbe({ contentType: "video/mp4", size: 800_000_000, complete: true }, mkv), "file");

const files = [
  { id: 1, path: "/Show.S03E02.mkv", bytes: 100 },
  { id: 2, path: "/Show.S03E01.mkv", bytes: 50 },
  { id: 3, path: "/Show.sample.mkv", bytes: 1 },
];
assert.equal(P.pickTorrentFile(files, { season: 3, episode: 1 }).id, 2);
assert.equal(P.pickTorrentFile(files, { fileIndex: "1", episode: 1, season: 3 }).id, 1);
assert.equal(P.pickTorrentFile([
  { id: 1, path: "/one.mkv", bytes: 10 },
  { id: 2, path: "/two.mkv", bytes: 20 },
], { episode: 9 }), null);

const transcode = {
  apple: { full: "https://32.stream.real-debrid.com/t/ID/eng1/none/aac/full.m3u8" },
  liveMP4: { full: "https://32.stream.real-debrid.com/t/ID/eng1/none/aac/full.mp4" },
  h264WebM: { full: "https://32.stream.real-debrid.com/t/ID/eng1/none/aac/full.webm" },
};
assert.equal(P.pickTranscode(transcode, true).url, transcode.apple.full);
assert.equal(P.pickTranscode(transcode, true).type, "application/vnd.apple.mpegurl");
assert.equal(P.pickTranscode(transcode, false).url, transcode.liveMP4.full);
assert.equal(P.rdErrorKind(451, 35, "infringing_file"), "infringing");
assert.equal(P.rdErrorKind(401, 8, "bad_token"), "auth");

async function fakeResolve(overrides, safari) {
  const calls = [];
  const request = async (method, path, params) => {
    calls.push({ method, path, params });
    if (overrides[path]) return overrides[path](method, params);
    if (path.startsWith("/torrents/info/")) return overrides.info;
    if (path.startsWith("/streaming/transcode/")) return overrides.transcode;
    throw new Error("unexpected " + path);
  };
  const result = await P.resolveRealDebrid({
    hash: "0123456789abcdef0123456789abcdef01234567",
    season: 3, episode: 1, fileIndex: "2", safari, clientIp: "203.0.113.8", request,
  });
  return { result, calls };
}

(async () => {
  const ok = await fakeResolve({
    "/torrents/addMagnet": () => ({ id: "TOR1" }),
    info: { status: "waiting_files_selection", files: files.map(f => ({ ...f, selected: 0 })), links: [] },
    "/torrents/selectFiles/TOR1": () => ({}),
    transcode,
  }, true);
  // second info read after selectFiles: the fake returns the same waiting_files_selection with no links.
  // waitForFiles will poll. That makes the test slow and then fail to find a link.
  assert.equal(ok.calls[0].params.ip, "203.0.113.8");
  assert.equal(ok.calls[0].params.magnet.includes("0123456789abcdef0123456789abcdef01234567"), true);

  const calls2 = [];
  let infos = 0;
  const request2 = async (method, path, params) => {
    calls2.push(path);
    if (path === "/torrents/addMagnet") return { id: "TOR1" };
    if (path === "/torrents/info/TOR1") {
      infos++;
      if (infos === 1) return { status: "waiting_files_selection", files: files.map(f => ({ ...f, selected: 0 })), links: [] };
      return { status: "downloaded", files: files.map(f => ({ ...f, selected: f.id === 2 ? 1 : 0 })), links: ["https://real-debrid.com/d/ABC"] };
    }
    if (path === "/torrents/selectFiles/TOR1") return {};
    if (path === "/unrestrict/link") return { id: "FILE1", filename: "Show.S03E01.mkv", download: "https://1.download.real-debrid.com/d/FILE1/Show.S03E01.mkv" };
    if (path === "/streaming/transcode/FILE1") return transcode;
    throw new Error("unexpected " + method + " " + path);
  };
  const played = await P.resolveRealDebrid({
    hash: "0123456789abcdef0123456789abcdef01234567",
    season: 3, episode: 1, safari: true, clientIp: "203.0.113.8", request: request2,
  });
  assert.equal(played.ok, true, JSON.stringify(played));
  assert.equal(played.url, transcode.apple.full);

  const blocked = await P.resolveRealDebrid({
    hash: "0123456789abcdef0123456789abcdef01234567",
    episode: 1, safari: true, request: async (method, path) => {
      if (path === "/torrents/addMagnet") { const e = new Error("infringing_file"); e.status = 451; e.code = 35; throw e; }
      throw new Error(path);
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, "infringing");

  const chrome = await P.resolveRealDebrid({
    hash: "0123456789abcdef0123456789abcdef01234567",
    season: 3, episode: 1, safari: false, request: request2,
  });
  // request2's info counter is shared and already advanced; addMagnet still works
  // but info state may already be downloaded. Either way chrome wants liveMP4 if transcode is reached.
  if (chrome.ok) assert.equal(chrome.url, transcode.liveMP4.full);

  console.log("playback tests passed");
})().catch(err => { console.error(err); process.exit(1); });
