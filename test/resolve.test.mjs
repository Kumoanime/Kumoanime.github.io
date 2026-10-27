import assert from "assert";
import { handleRequest, resolvePlayback } from "../rd-proxy/worker.js";

const comet = "https://comet.elfhosted.com/cfg/playback/0123456789abcdef0123456789abcdef01234567/0/1/3/1?name=Ep";
const download = "https://48.download.real-debrid.com/d/FILEID/Show.S03E01.mkv";

const result = await resolvePlayback(comet, async url => {
  assert.equal(url, comet);
  return new Response(null, { status: 302, headers: { Location: download } });
});
assert.equal(result.ok, true);
assert.equal(result.id, "FILEID");
assert.equal(result.filename, "Show.S03E01.mkv");
assert.equal(result.step, "comet");

const slate = await resolvePlayback(comet, async () => new Response(new Uint8Array(80), {
  status: 200,
  headers: { "Content-Type": "video/mp4", "Content-Length": "80" },
}));
assert.equal(slate.blocked, true);
assert.equal(slate.step, "comet");
assert.equal(slate.reason, "INFRINGING_FILE");

const ranged = await resolvePlayback(comet, async () => new Response(new Uint8Array(16), {
  status: 206,
  headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-15/800000000" },
}));
assert.equal(ranged.blocked, undefined);
assert.equal(ranged.ok, false);

const evil = await resolvePlayback(comet, async () => new Response(null, {
  status: 302,
  headers: { Location: "https://evil.example/steal" },
}));
assert.equal(evil.ok, false);
assert.ok(!evil.blocked);
assert.match(evil.error, /not allowed/i);

let fetched = false;
const foreign = await resolvePlayback("https://evil.example/playback/x", async () => { fetched = true; return new Response(null); });
assert.equal(foreign.ok, false);
assert.equal(fetched, false);

const denied = await handleRequest(new Request("https://worker.test/?url=" + encodeURIComponent("https://evil.example/d/X/a.mkv")));
assert.equal(denied.status, 403);

let seenAuth = "unset";
const resolved = await handleRequest(new Request("https://worker.test/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer SECRET" },
  body: JSON.stringify({ url: comet }),
}), async (url, init) => {
  seenAuth = init.headers.get("Authorization");
  assert.equal(String(url), comet);
  return new Response(null, { status: 302, headers: { Location: download } });
});
assert.equal(resolved.status, 200);
assert.equal(seenAuth, null);
assert.equal((await resolved.json()).id, "FILEID");

let apiAuth = "";
const api = await handleRequest(new Request("https://worker.test/?url=" + encodeURIComponent("https://api.real-debrid.com/rest/1.0/time"), {
  headers: { Authorization: "Bearer SECRET" },
}), async (url, init) => {
  apiAuth = init.headers.get("Authorization");
  assert.equal(String(url), "https://api.real-debrid.com/rest/1.0/time");
  return new Response(JSON.stringify({ t: 1 }), { headers: { "Content-Type": "application/json" } });
});
assert.equal(api.status, 200);
assert.equal(apiAuth, "Bearer SECRET");
assert.equal((await api.json()).t, 1);

console.log("resolve tests passed");
