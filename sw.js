"use strict";
// App shell: cache-first, then refresh in the background.
// VERSION has to match the ?v= query strings in index.html. A new service
// worker installs a new cache and drops the old one, so a deploy still arrives.
// The next navigation after a background update picks up changed files even
// when the version query is unchanged. Video, Range, and cross-origin
// requests are not intercepted.
const VERSION = "27";
const CACHE = "kumo-shell-v" + VERSION;
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css?v=27",
  "./app.js?v=27",
  "./playback.js?v=4",
  "./manifest.webmanifest",
  "./icon-180.png?v=5",
  "./icon-192.png?v=5",
  "./icon-512.png?v=5",
  "./icon-512-maskable.png?v=5",
  "./splash/k-badge.png?v=5",
];
const SHELL = /\/$|\/index\.html$|\.(?:html|js|css|webmanifest|png)$/;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function matchShell(cache, req) {
  const hit = await cache.match(req);
  if (hit) return hit;
  const url = new URL(req.url);
  if (url.pathname.endsWith("/") || url.pathname.endsWith("/index.html")) {
    return (await cache.match("./")) || (await cache.match("./index.html")) || (await cache.match(new Request(url.origin + "/")));
  }
  return null;
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.get("range")) return;
  if (!SHELL.test(url.pathname)) return;
  const update = caches.open(CACHE).then(async cache => {
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res && res.ok && res.type === "basic") await cache.put(req, res.clone());
      return res;
    } catch {
      return null;
    }
  });
  event.waitUntil(update);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await matchShell(cache, req);
    if (cached) return cached;
    const fresh = await update;
    if (fresh) return fresh;
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  })());
});
