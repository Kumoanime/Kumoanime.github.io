"use strict";
// Network-first for the app shell only. Cross-origin stream URLs, Range
// requests, and everything else go straight to the network and are not cached.
const SHELL = /\/$|\.(?:html|js|css)$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.get("range")) return;
  if (!SHELL.test(url.pathname)) return;
  event.respondWith(fetch(req, { cache: "no-store" }).catch(() => fetch(req)));
});
