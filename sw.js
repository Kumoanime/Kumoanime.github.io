"use strict";
// Network-first for the app shell only, so a cold open picks up this deploy
// (index.html, the opening splash, style.css, and the manifest) instead of a
// stale copy. Cross-origin stream URLs, Range requests, and everything else
// go straight to the network and are not cached.
const SHELL = /\/$|\.(?:html|js|css|webmanifest)$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.get("range")) return;
  if (!SHELL.test(url.pathname)) return;
  // A Request can only be used once. Clone it for the offline fallback.
  event.respondWith(fetch(req, { cache: "no-store" }).catch(() => fetch(req.clone())));
});
