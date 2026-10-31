"use strict";
// Kumo: anime browser + player. Show info comes from AniList; streams come from
// Stremio-protocol add-ons the user installs (plus two built-in legal ones).

const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stripHtml = s => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
const idle = fn => { const ric = window.requestIdleCallback; if (ric) ric(() => fn(), { timeout: 1800 }); else setTimeout(fn, 400); };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("kumo." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kumo." + k, JSON.stringify(v)); } catch {} },
};
const forgetKey = k => { try { localStorage.removeItem("kumo." + k); } catch {} };
let addons = store.get("addons", []);
let repos = store.get("repos", []);
let watchlist = store.get("watchlist", {});
let removed = store.get("removed", {});
let progress = store.get("progress", {});
let builtinOff = store.get("builtinOff", {});
let rdSettings = store.get("rd", {});
const saveAddons = () => store.set("addons", addons);
const saveRd = patch => { rdSettings = { ...rdSettings, ...patch }; store.set("rd", rdSettings); };

let tt;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; t.style.display = ""; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; t.style.display = "none"; }, 2600); }

// ---------- response cache (memory + IndexedDB, stale-while-revalidate) ----------
const TTL = { list: 15 * 60 * 1000, search: 5 * 60 * 1000, media: 6 * 60 * 60 * 1000, catalog: 30 * 60 * 1000, meta: 12 * 60 * 60 * 1000, stream: 5 * 60 * 1000, subs: 12 * 60 * 60 * 1000, notes: 10 * 60 * 1000 };
const mem = new Map();
const inflight = new Map();
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    if (!("indexedDB" in window)) { resolve(null); return; }
    const req = indexedDB.open("kumo-cache", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}
function idbGet(key) {
  return openDb().then(db => new Promise(resolve => {
    if (!db) { resolve(null); return; }
    try {
      const r = db.transaction("kv", "readonly").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
}
function idbPut(key, rec) {
  openDb().then(db => { if (!db) return; try { db.transaction("kv", "readwrite").objectStore("kv").put(rec, key); } catch {} }).catch(() => {});
}
function cacheLevel(rec, ttl, factor) {
  if (!rec || rec.data === undefined || rec.at == null) return 0;
  const age = Date.now() - rec.at;
  if (age < ttl) return 2;
  if (age < ttl * factor) return 1;
  return 0;
}
function cached(key, ttl, fetcher, opts = {}) {
  const factor = opts.staleFactor || 8;
  const hit = mem.get(key);
  const hitLevel = cacheLevel(hit, ttl, factor);
  if (hitLevel === 2) return Promise.resolve(hit.data);
  if (hitLevel === 1) { start(false); return Promise.resolve(hit.data); }
  return idbGet(key).then(stored => {
    const storedLevel = cacheLevel(stored, ttl, factor);
    if (!storedLevel) return start(true);
    mem.set(key, stored);
    if (storedLevel === 1) start(false);
    return stored.data;
  });
  function start(wait) {
    let p = inflight.get(key);
    if (!p) {
      p = Promise.resolve().then(fetcher).then(data => {
        const rec = { data, at: Date.now() };
        mem.set(key, rec);
        idbPut(key, rec);
        if (!wait && opts.onUpdate) opts.onUpdate(data);
        return data;
      }).catch(err => {
        if (!wait && mem.get(key)) return mem.get(key).data;
        throw err;
      }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
      inflight.set(key, p);
    }
    return wait ? p : undefined;
  }
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function fetchTimeout(url, ms, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...(init || {}), signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ---------- AniList ----------
const MEDIA_FIELDS = `id idMal title{romaji english} coverImage{medium large color} bannerImage format status episodes
  season seasonYear averageScore genres nextAiringEpisode{episode airingAt} trailer{id site}`;
async function anilistRaw(query, variables) {
  const r = await fetchTimeout("https://graphql.anilist.co", 12000, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error("AniList " + r.status);
  const json = await r.json();
  if (!json.data) throw new Error("AniList");
  return json.data;
}
function anilist(query, variables = {}, opts = {}) {
  const key = opts.key || ("al:" + hashStr(query + "\0" + JSON.stringify(variables)));
  return cached(key, opts.ttl || TTL.list, () => anilistRaw(query, variables), opts);
}
const LIST_QUERY = `query($sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus,$search:String){
  Page(perPage:30){media(type:ANIME,isAdult:false,sort:$sort,season:$season,seasonYear:$year,status:$status,search:$search){${MEDIA_FIELDS}}}}`;
function anilistList(key, vars, onUpdate) {
  return anilist(LIST_QUERY, vars, { key: "list:" + key, ttl: TTL.list, staleFactor: 24, onUpdate: onUpdate ? d => onUpdate(d.Page.media) : undefined }).then(d => d.Page.media);
}
const titleOf = m => m.title.english || m.title.romaji;
function currentSeason() {
  const d = new Date(), mo = d.getMonth();
  return { season: ["WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER"][mo], year: mo === 11 ? d.getFullYear() + 1 : d.getFullYear() };
}
const idsFlight = new Map();
async function showIds(media) {
  const cache = store.get("ids", {});
  if (cache[media.id]) return cache[media.id];
  if (idsFlight.has(media.id)) return idsFlight.get(media.id);
  const p = (async () => {
    let ids = { anilist: media.id, mal: media.idMal };
    try {
      const r = await fetchTimeout(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${media.id}`, 6000);
      if (r.ok) { const j = await r.json(); ids = { ...ids, kitsu: j.kitsu, imdb: j.imdb, imdbSeason: j["thetvdb-season"] || j["themoviedb-season"], tmdb: j.themoviedb, mal: j.myanimelist || media.idMal }; }
    } catch {}
    if (!ids.kitsu && media.idMal) {
      const found = await Promise.all(["https://kitsu.app", "https://kitsu.io"].map(async host => {
        try {
          const r = await fetchTimeout(`${host}/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${media.idMal}&include=item`, 6000, { headers: { Accept: "application/vnd.api+json" } });
          return r.ok && (await r.json()).data?.[0]?.relationships?.item?.data?.id;
        } catch { return null; }
      }));
      ids.kitsu = found.find(Boolean) || ids.kitsu;
    }
    if (ids.kitsu || ids.imdb) { cache[media.id] = ids; store.set("ids", cache); }
    return ids;
  })().finally(() => idsFlight.delete(media.id));
  idsFlight.set(media.id, p);
  return p;
}
function rememberMedia(m) {
  if (!m?.id) return;
  const id = String(m.id);
  const prev = store.get("mediaIdx", []);
  const idx = [id, ...prev.filter(x => x !== id)].slice(0, 30);
  store.set("mediaIdx", idx);
  store.set("media." + id, { at: Date.now(), data: m });
  for (const old of prev) if (!idx.includes(old)) forgetKey("media." + old);
  const hero = m.bannerImage || m.coverImage?.large || "";
  if (hero) { try { localStorage.setItem("kumo.hero." + id, hero); } catch {} }
}
function recallMedia(id) {
  const rec = store.get("media." + id, null);
  return rec?.data ? rec : null;
}
function getMedia(id) {
  const key = "media:" + id;
  if (!mem.has(key)) { const rec = recallMedia(id); if (rec) mem.set(key, rec); }
  return cached(key, TTL.media, () => anilistRaw(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS} description(asHtml:false) studios(isMain:true){nodes{name}}}}`, { id: +id }).then(d => {
    if (!d.Media) throw new Error("AniList");
    rememberMedia(d.Media);
    return d.Media;
  }), { staleFactor: 28 });
}

// ---------- add-ons ----------
const BUILTINS = [];
function allAddons() {
  return [
    ...BUILTINS.map(b => ({ ...b, builtin: true, enabled: !builtinOff[b.key] })),
    ...addons.map(a => ({ ...a, key: a.url })),
  ];
}
function addonKey(u) {
  try {
    const x = new URL(normaliseUrl(u));
    let path = x.pathname.replace(/\/+$/, "");
    if (!/\/manifest\.json$/i.test(path)) path += "/manifest.json";
    x.searchParams.sort();
    return `${x.origin}${path.replace(/\/manifest\.json$/i, "/manifest.json")}${x.search}`;
  } catch { return u; }
}
function addonUrl(manifestUrl, path) {
  const u = new URL(manifestUrl);
  u.pathname = u.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "") + "/" + path;
  return u.toString();
}
function normaliseUrl(u) {
  u = u.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}
function resourceSpec(m, name) {
  for (const r of m.resources || []) {
    if (r === name) return { types: m.types || [], idPrefixes: m.idPrefixes };
    if (typeof r === "object" && r.name === name) return { types: r.types || m.types || [], idPrefixes: r.idPrefixes || m.idPrefixes };
  }
  return null;
}
function handles(a, name, id) {
  const spec = resourceSpec(a.manifest, name);
  if (!spec) return false;
  return !spec.idPrefixes || spec.idPrefixes.some(p => id.startsWith(p));
}
async function fetchCatalog(a, type, id, skip) {
  const extra = skip > 0 ? `/skip=${skip}` : "";
  const url = addonUrl(a.url, `catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extra}.json`);
  return cached("addon:catalog:" + url, TTL.catalog, async () => {
    const r = await fetchTimeout(url, 12000);
    if (!r.ok) throw new Error(`${a.manifest.name}: HTTP ${r.status} for catalog`);
    const j = await r.json();
    return j.metas ?? [];
  }, { staleFactor: 12 });
}
function call(a, resource, type, id, ctx) {
  if (a.builtin) return Promise.resolve(a[resource]?.(type, id, ctx));
  const url = addonUrl(a.url, `${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  const ttl = resource === "stream" ? TTL.stream : resource === "catalog" ? TTL.catalog : resource === "meta" ? TTL.meta : TTL.subs;
  return cached("addon:" + resource + ":" + url, ttl, async () => {
    const r = await fetchTimeout(url, resource === "stream" ? 8000 : 12000);
    if (!r.ok) throw Object.assign(new Error(`${a.manifest.name}: HTTP ${r.status} for ${resource}`), { status: r.status });
    const j = await r.json();
    switch (resource) {
      case "catalog": return j.metas ?? [];
      case "meta": return j.meta ?? null;
      case "subtitles": return j.subtitles ?? [];
      case "stream": return j.streams ?? [];
      default: throw new Error(`Unsupported resource: ${resource}`);
    }
  }, { staleFactor: resource === "stream" ? 6 : 12 });
}
async function installAddon(url, quiet) {
  url = normaliseUrl(url);
  const manifestUrl = /manifest\.json/i.test(url) ? url : addonUrl(url, "manifest.json");
  if (addons.some(a => addonKey(a.url) === addonKey(manifestUrl))) { if (!quiet) toast("That add-on is already installed"); return false; }
  const r = await fetchTimeout(manifestUrl, 12000);
  if (!r.ok) throw new Error(`The link answered with error ${r.status}`);
  const manifest = await r.json();
  if (!manifest.id || !manifest.resources) throw new Error("That link isn't an add-on manifest");
  addons.push({ url: manifestUrl, manifest, enabled: true });
  saveAddons();
  if (!quiet) toast(`Installed ${manifest.name}`);
  return true;
}
async function addRepo(url) {
  url = normaliseUrl(url);
  const r = await fetchTimeout(url, 12000);
  if (!r.ok) throw new Error(`The link answered with error ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.addons || j.plugins || [];
  const entries = list.map(e => typeof e === "string" ? { url: e } : { url: e.transportUrl || e.manifestUrl || e.url, name: e.manifest?.name || e.name, description: e.manifest?.description || e.description }).filter(e => e.url);
  if (!entries.length) throw new Error("No add-ons found at that link");
  repos = repos.filter(x => x.url !== url).concat({ url, name: j.name || new URL(url).hostname, entries });
  store.set("repos", repos);
  toast(`Added ${entries.length} add-on${entries.length > 1 ? "s" : ""} to browse`);
}

// ---------- progress ----------
function saveProgress(key, data) {
  // Watching an episode again brings a removed show back to Continue watching.
  const { hidden, ...prev } = progress[key] || {};
  progress[key] = { ...prev, ...data, updated: Date.now() };
  store.set("progress", progress);
  scheduleSync();
  dismissIfWatched(key);
}
// Hides a show without deleting its rows, so episode marks and "Play next" stay.
// Bumping `updated` makes the hide win the merge on other devices.
function hideFromContinue(route, title) {
  const now = Date.now();
  for (const [k, p] of Object.entries(progress)) if (p.route === route) progress[k] = { ...p, hidden: true, updated: now };
  store.set("progress", progress);
  scheduleSync();
  eachView(root => root.querySelectorAll("[data-hide-show]").forEach(b => { if (b.dataset.hideShow === route) b.closest(".card-wrap")?.remove(); }));
  const rail = viewRoot("#/")?.querySelector("#sec-continue .rail");
  const left = rail?.scrollLeft || 0;
  refreshContinue();
  const next = viewRoot("#/")?.querySelector("#sec-continue .rail");
  if (next) next.scrollLeft = left;
  const more = viewRoot("#/more/continue");
  if (more && !continueRows().length) viewMore(["continue"], more);
  toast(`Removed ${title || "show"} from Continue watching`);
}
function continueHref(p) {
  const route = p.route || "";
  const m = /^#\/a\/(\d+)$/.exec(route);
  if (!m || !p.key || !String(p.key).startsWith(route + ":")) return route;
  const ep = String(p.key).slice(route.length + 1);
  return /^\d+$/.test(ep) ? `#/watch/${m[1]}/${ep}` : route;
}
function continueRows() {
  const rows = [];
  for (const [k, p] of Object.entries(progress)) {
    if (!p.route || p.hidden || (p.d && p.t / p.d > 0.92)) continue;
    rows.push({ ...p, key: k });
  }
  return rows.sort((a, b) => b.updated - a.updated);
}
function continueItems() {
  const byShow = {};
  for (const p of continueRows()) {
    if (!byShow[p.route] || byShow[p.route].updated < p.updated) byShow[p.route] = p;
  }
  return Object.values(byShow).sort((a, b) => b.updated - a.updated).slice(0, 15);
}
function watchingItems() {
  return Object.values(watchlist).sort((a, b) => (b.added || 0) - (a.added || 0));
}

// ---------- artwork ----------
const lazyIo = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    if (img.dataset.src) img.src = img.dataset.src;
    img.removeAttribute("data-src");
    lazyIo.unobserve(img);
  }
}, { root: null, rootMargin: "280px 360px" });
function observeLazy(scope) { scope.querySelectorAll("img[data-src]").forEach(img => lazyIo.observe(img)); }
function preloadHero(url) {
  if (!url) return;
  let link = document.getElementById("hero-preload");
  if (!link) { link = document.createElement("link"); link.id = "hero-preload"; link.rel = "preload"; link.as = "image"; document.head.appendChild(link); }
  try { if (link.href && new URL(link.href).href === new URL(url, location.href).href) return; } catch {}
  link.href = url;
}
function card(href, title, poster, sub, extra = "", opt = {}) {
  let img;
  if (!poster) img = `<div class="ph">${esc(title)}</div>`;
  else {
    const dims = `alt="" width="230" height="320" decoding="async"`;
    const set = opt.srcset ? ` srcset="${esc(opt.srcset)}" sizes="${opt.sizes || "(max-width: 420px) 46vw, 150px"}"` : "";
    if (opt.defer) img = `<img ${dims} data-src="${esc(poster)}"${opt.srcset ? ` data-srcset="${esc(opt.srcset)}"` : ""} fetchpriority="low">`;
    else img = `<img ${dims} src="${esc(poster)}"${set} ${opt.eager ? `fetchpriority="high"` : `loading="lazy" fetchpriority="low"`}>`;
  }
  const watchRoute = opt.watchRoute || href;
  const on = !!watchlist[watchRoute];
  const airId = opt.airId || ((/^#\/a\/(\d+)$/.exec(watchRoute) || [])[1] || "");
  const air = opt.air != null ? opt.air : (airId ? airForId(airId) : "");
  const name = title || "this show";
  const label = on ? `Remove ${name} from Watching` : `Add ${name} to Watching`;
  const remove = opt.removable ? `<button type="button" class="card-remove" data-hide-show="${esc(watchRoute)}" data-title="${esc(name)}" aria-label="${esc(`Remove ${name} from Continue watching`)}"><span aria-hidden="true">×</span></button>` : "";
  return `<div class="card-wrap">${remove}<button type="button" class="quick-add${on ? " on" : ""}" data-quick="${esc(watchRoute)}" data-title="${esc(name)}" data-poster="${esc(poster || "")}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc(label)}"><span aria-hidden="true">${on ? "✓" : "+"}</span></button><a class="card" href="${esc(href)}"><div class="cover"${airId ? ` data-air-for="${esc(airId)}"` : ""}>${img}${air ? `<span class="air-pill">${esc(air)}</span>` : ""}${extra}</div><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</a></div>`;
}
const ratingBadge = r => r ? `<span class="rating" aria-label="Rated ${r} out of 10">★ ${r}</span>` : "";
const aniRating = m => m.averageScore ? (m.averageScore / 10).toFixed(1) : "";
function aniSrcset(m) {
  const sm = m.coverImage?.medium, lg = m.coverImage?.large;
  return sm && lg ? `${sm} 100w, ${lg} 230w` : "";
}
const aniCard = (m, i = 0) => card(`#/a/${m.id}`, titleOf(m), m.coverImage?.large || m.coverImage?.medium, [m.seasonYear, m.format?.replace("_", " ")].filter(Boolean).join(" · "), ratingBadge(aniRating(m)), {
  eager: i === 0, defer: i >= 4, srcset: aniSrcset(m), airId: m.id,
  air: m.nextAiringEpisode ? KumoNotify.airLabel(m.nextAiringEpisode.episode, m.nextAiringEpisode.airingAt, Date.now()) : "",
});
function snapCard(it, i = 0) {
  const set = it.posterSm && it.poster ? `${it.posterSm} 100w, ${it.poster} 230w` : "";
  const airId = it.id || ((/^#\/a\/(\d+)$/.exec(it.href || "") || [])[1] || "");
  return card(it.href || `#/a/${it.id}`, it.title, it.poster, it.sub, ratingBadge(it.rating), { eager: i === 0, defer: i >= 4, srcset: set, airId });
}
function compactMedia(m) {
  return { id: m.id, title: titleOf(m), poster: m.coverImage?.large || "", posterSm: m.coverImage?.medium || "", sub: [m.seasonYear, m.format?.replace("_", " ")].filter(Boolean).join(" · "), rating: aniRating(m) };
}
const skelRail = () => `<div class="rail">${Array.from({ length: 6 }, () => `<div class="card"><div class="cover skel"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:70%"></div></div>`).join("")}</div>`;
function section(title, body, note = "", moreHref = "") {
  const bits = [];
  if (note) bits.push(`<small>${esc(note)}</small>`);
  if (moreHref) bits.push(`<a class="more-link" href="${esc(moreHref)}" aria-label="More ${esc(title)}">More</a>`);
  const side = bits.length ? `<div class="head-side">${bits.join("")}</div>` : "";
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${side}</div>${body}</section>`;
}
function moreTile(href, title) {
  return `<a class="more-tile" href="${esc(href)}" aria-label="More ${esc(title)}"><span>More</span></a>`;
}
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDec(s) {
  try {
    let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return decodeURIComponent(escape(atob(t)));
  } catch { return ""; }
}
function catMoreHref(addon, catalog) {
  return `#/more/cat/${b64url(addon.url)}/${b64url(catalog.type)}/${b64url(catalog.id)}`;
}
function mount() { return app.querySelector(":scope > .view") || app; }
let hlsPromise = null, playerPromise = null, supabasePromise = null;
function loadScript(src, asModule) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    if (asModule) s.type = "module";
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}
function ensurePlayerAssets() {
  if (!playerPromise) {
    if (!document.querySelector("link[data-vidstack]")) {
      for (const href of ["https://cdn.jsdelivr.net/npm/vidstack@1.15.6/player/styles/default/theme.css", "https://cdn.jsdelivr.net/npm/vidstack@1.15.6/player/styles/default/layouts/video.css"]) {
        const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.dataset.vidstack = "1"; document.head.appendChild(l);
      }
    }
    playerPromise = loadScript("https://cdn.jsdelivr.net/npm/vidstack@1.15.6/cdn/with-layouts/vidstack.js", true).then(() => customElements.whenDefined("media-player"));
  }
  return playerPromise;
}
function ensureHls() {
  if (document.createElement("video").canPlayType("application/vnd.apple.mpegurl")) return Promise.resolve();
  if (!hlsPromise) hlsPromise = loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js", false);
  return hlsPromise;
}
function ensureSupabase() {
  if (sb) return Promise.resolve(sb);
  if (!supabasePromise) supabasePromise = loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js", false).then(() => { initSupabase(); return sb; }).catch(err => { supabasePromise = null; throw err; });
  return supabasePromise;
}

// ---------- views ----------
const page = {};
let searchTimer = 0, searchGen = 0;
function continueHtml() {
  const cont = continueItems();
  if (!cont.length) return "";
  const href = "#/more/continue";
  return `<div id="sec-continue">${section("Continue watching", `<div class="rail">${cont.map((p, i) => {
    const airId = (/^#\/a\/(\d+)$/.exec(p.route || "") || [])[1] || "";
    const extra = p.d ? `<div class="bar-prog" style="width:${Math.min(100, p.t / p.d * 100)}%"></div>` : "";
    return card(continueHref(p), p.title, p.poster, p.label, extra, { watchRoute: p.route, airId, removable: true, eager: i === 0, defer: i >= 4 });
  }).join("")}${moreTile(href, "Continue watching")}</div>`, "", href)}</div>`;
}
function viewRoot(key) {
  if (activeKey === key && app.firstElementChild) return app.firstElementChild;
  return viewNodes.get(key)?.el || null;
}
function refreshContinue() {
  const root = viewRoot("#/");
  if (!root) return;
  const html = continueHtml();
  const sec = root.querySelector("#sec-continue");
  if (!html) { sec?.remove(); return; }
  if (!sec) root.insertAdjacentHTML("afterbegin", html);
  else sec.outerHTML = html;
  observeLazy(root);
}
function refreshList() {
  const root = viewRoot("#/list");
  if (root) viewList(root);
}
function saveHomeSnap(patch) {
  const prev = store.get("homeSnap", {}) || {};
  const rails = { ...(prev.rails || {}), ...(patch.rails || {}) };
  const cats = patch.cats || prev.cats || [];
  const lcp = continueItems()[0]?.poster || rails.trending?.[0]?.poster || prev.lcp || "";
  store.set("homeSnap", { at: Date.now(), lcp, rails, cats });
}
function enabledCatalogs() {
  return allAddons().filter(a => a.enabled && resourceSpec(a.manifest, "catalog"))
    .flatMap(a => (a.manifest.catalogs || []).filter(c => !(c.extra || []).some(e => e.isRequired) && !(c.extraRequired || []).length).slice(0, 3).map(c => ({ a, c, key: a.key + ":" + c.type + ":" + c.id })));
}
function railMoreHref(k) { return "#/more/" + k; }
function fillRail(root, k, title, note, list) {
  const el = root.querySelector("#rail-" + k);
  if (!el || !list) return;
  rememberMediaAir(list);
  const sig = list.map(m => m.id).join(",");
  saveHomeSnap({ rails: { [k]: list.map(compactMedia) } });
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const href = railMoreHref(k);
  el.innerHTML = section(title, `<div class="rail">${list.map((m, i) => aniCard(m, i)).join("")}${moreTile(href, title)}</div>`, note, href);
  observeLazy(el);
  if (k === "trending" && list[0]?.coverImage?.large && !continueItems().length) preloadHero(list[0].coverImage.large);
}
function homeShell(root, snap) {
  const s = currentSeason();
  const seasonTitle = `${s.season[0] + s.season.slice(1).toLowerCase()} ${s.year}`;
  const specs = [["trending", "Trending now", ""], ["season", seasonTitle, ""], ["top", "All-time favourites", ""]];
  const rails = specs.map(([k, t]) => {
    const items = snap?.rails?.[k];
    const sig = items?.length ? items.map(it => it.id).join(",") : "";
    const href = railMoreHref(k);
    const body = items?.length ? `<div class="rail">${items.map((it, i) => snapCard(it, i)).join("")}${moreTile(href, t)}</div>` : skelRail();
    return `<div id="rail-${k}" data-sig="${sig}">${section(t, body, "", href)}</div>`;
  }).join("");
  const catalogs = enabledCatalogs();
  const cats = catalogs.map((x, i) => {
    const snapCat = snap?.cats?.find(c => c.key === x.key);
    const href = catMoreHref(x.a, x.c);
    const name = x.c.name || x.c.id;
    const body = snapCat?.items?.length ? `<div class="rail">${snapCat.items.map((it, n) => snapCard(it, n)).join("")}${moreTile(href, name)}</div>` : skelRail();
    return `<div id="cat-${i}" data-key="${esc(x.key)}" data-sig="${snapCat?.items?.map(it => it.href).join(",") || ""}">${section(name, body, x.a.manifest.name, href)}</div>`;
  }).join("");
  const empty = addons.length ? "" : `<div id="home-empty">${section("Get more from Kumo", `<div class="empty"><h3>Add your first add-on</h3>Add-ons supply the episodes Kumo can play. <a href="#/addons">Open Add-ons</a> to install one by link or browse a repository.</div>`)}</div>`;
  root.innerHTML = continueHtml() + rails + cats + empty;
  observeLazy(root);
  if (snap?.lcp) preloadHero(snap.lcp);
}
async function viewHome(root, gen) {
  const snap = store.get("homeSnap", null);
  homeShell(root, snap);
  const s = currentSeason();
  const rails = [
    ["trending", "Trending now", "", { sort: ["TRENDING_DESC"], status: "RELEASING" }],
    ["season", `${s.season[0] + s.season.slice(1).toLowerCase()} ${s.year}`, "", { sort: ["POPULARITY_DESC"], season: s.season, year: s.year }],
    ["top", "All-time favourites", "", { sort: ["SCORE_DESC"], status: "FINISHED" }],
  ];
  await Promise.all(rails.map(async ([k, t, note, vars]) => {
    try {
      const list = await anilistList(k, vars, fresh => { if (root.dataset.gen === String(gen)) fillRail(root, k, t, note, fresh); });
      if (root.dataset.gen !== String(gen)) return;
      fillRail(root, k, t, note, list);
    } catch {
      const el = root.querySelector("#rail-" + k);
      if (el && root.dataset.gen === String(gen) && !el.dataset.sig) el.innerHTML = section(t, `<p class="note">Couldn't reach AniList for show info. Check your connection and reload.</p>`, "", railMoreHref(k));
    }
  }));
  const catalogs = enabledCatalogs();
  const catSnap = [];
  await Promise.all(catalogs.map(async (x, i) => {
    const el = root.querySelector("#cat-" + i);
    if (!el) return;
    try {
      const metas = (await call(x.a, "catalog", x.c.type, x.c.id)) || [];
      if (root.dataset.gen !== String(gen)) return;
      const items = metas.slice(0, 30).map(m => ({ href: metaRoute(x.a, m.type, m.id), title: m.name, poster: m.poster || "", sub: m.releaseInfo || "", rating: m.imdbRating || "" }));
      const sig = items.map(it => it.href).join(",");
      const href = catMoreHref(x.a, x.c);
      const name = x.c.name || x.c.id;
      if (items.length) catSnap.push({ key: x.key, title: name, note: x.a.manifest.name, items: items.slice(0, 20) });
      if (!items.length) { el.innerHTML = ""; return; }
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      el.innerHTML = section(name, `<div class="rail">${items.map((it, n) => snapCard(it, n)).join("")}${moreTile(href, name)}</div>`, x.a.manifest.name, href);
      observeLazy(el);
    } catch {
      if (root.dataset.gen === String(gen)) el.innerHTML = section(x.c.name || x.c.id, `<p class="note">${esc(x.a.manifest.name)} didn't respond.</p>`, x.a.manifest.name, catMoreHref(x.a, x.c));
    }
  }));
  if (catSnap.length) saveHomeSnap({ cats: catSnap });
}

const BROWSE_QUERY = `query($page:Int,$sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus){
  Page(page:$page,perPage:50){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,sort:$sort,season:$season,seasonYear:$year,status:$status){${MEDIA_FIELDS}}}}`;
function moreShell(title) {
  return `<div class="more-bar"><a class="more-back" href="#/" data-back="1" aria-label="Back to Home">←</a><h1>${esc(title)}</h1></div>`;
}
function moreSpec(kind) {
  const s = currentSeason();
  const seasonTitle = `${s.season[0] + s.season.slice(1).toLowerCase()} ${s.year}`;
  return {
    trending: { title: "Trending now", vars: { sort: ["TRENDING_DESC"], status: "RELEASING" } },
    season: { title: seasonTitle, vars: { sort: ["POPULARITY_DESC"], season: s.season, year: s.year } },
    top: { title: "All-time favourites", vars: { sort: ["SCORE_DESC"], status: "FINISHED" } },
  }[kind] || null;
}
function metaCard(m, addon, catalogType, i) {
  return snapCard({
    href: metaRoute(addon, m.type || catalogType, m.id),
    title: m.name || "Untitled",
    poster: m.poster || "",
    sub: m.releaseInfo || "",
    rating: m.imdbRating || "",
  }, i < 4 ? i : 99);
}
function bindMoreScroll(foot, load) {
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) load();
  }, { rootMargin: "640px" });
  io.observe(foot);
}
async function viewMore(rest, root, gen) {
  const kind = rest[0] || "";
  if (kind === "continue") {
    const rows = continueRows();
    root.innerHTML = moreShell("Continue watching") + (rows.length
      ? `<div class="grid">${rows.map((p, i) => {
          const airId = (/^#\/a\/(\d+)$/.exec(p.route || "") || [])[1] || "";
          const extra = p.d ? `<div class="bar-prog" style="width:${Math.min(100, p.t / p.d * 100)}%"></div>` : "";
          return card(continueHref(p), p.title, p.poster, p.label, extra, { watchRoute: p.route, airId, removable: true, eager: i < 2, defer: i >= 8 });
        }).join("")}</div>`
      : `<div class="empty"><h3>Nothing in progress</h3>Start an episode and it will show up here.</div>`);
    observeLazy(root);
    return;
  }
  if (kind === "cat") return viewMoreCatalog(rest, root, gen);
  const spec = moreSpec(kind);
  if (!spec) {
    root.innerHTML = moreShell("More") + `<div class="empty"><h3>That list isn't here</h3><a class="more-link" href="#/" data-back="1">Back to Home</a></div>`;
    return;
  }
  root.innerHTML = `${moreShell(spec.title)}<div id="moreGrid" class="grid"></div><div class="more" id="moreFoot"><p class="muted">Loading…</p></div>`;
  const grid = root.querySelector("#moreGrid");
  const foot = root.querySelector("#moreFoot");
  let pageNum = 1, items = [], more = true, loading = false, hold = false, pages = 0;
  const paint = () => {
    grid.innerHTML = items.length
      ? items.map((m, i) => aniCard(m, i < 4 ? i : 99)).join("")
      : (more ? "" : `<div class="empty" style="grid-column:1/-1"><h3>Nothing here yet</h3>This list didn't return any shows.</div>`);
    observeLazy(grid);
    foot.hidden = !more;
    foot.innerHTML = more ? `<button class="btn ghost" type="button" id="loadMore">Load more</button>` : "";
    page.onMore = more ? () => load() : null;
  };
  const load = async () => {
    if (loading || !more || hold || root.dataset.gen !== String(gen)) return;
    loading = true;
    let chain = false;
    try {
      const d = await anilist(BROWSE_QUERY, { ...spec.vars, page: pageNum }, { key: "more:" + kind + ":" + pageNum, ttl: TTL.list, staleFactor: 12 });
      if (root.dataset.gen !== String(gen)) return;
      const batch = d?.Page?.media || [];
      rememberMediaAir(batch);
      const seen = new Set(items.map(m => m.id));
      const fresh = batch.filter(m => m && !seen.has(m.id));
      items = items.concat(fresh);
      pages++;
      pageNum++;
      more = !!(d?.Page?.pageInfo?.hasNextPage) && fresh.length > 0 && pages < 40;
      paint();
      chain = more && foot.getBoundingClientRect().top < window.innerHeight + 480;
    } catch {
      if (root.dataset.gen !== String(gen)) return;
      hold = true;
      foot.hidden = false;
      foot.innerHTML = `<button class="btn ghost" type="button" id="loadMore">${items.length ? "Couldn't load more. Try again" : "Couldn't load this list. Try again"}</button>`;
      page.onMore = () => { hold = false; load(); };
    } finally { loading = false; }
    if (chain) load();
  };
  page.onMore = () => load();
  bindMoreScroll(foot, load);
  load();
}
async function viewMoreCatalog(rest, root, gen) {
  const url = b64urlDec(rest[1] || "");
  const type = b64urlDec(rest[2] || "");
  const id = b64urlDec(rest[3] || "");
  const addon = allAddons().find(a => a.url === url || addonKey(a.url) === addonKey(url));
  const catalog = addon?.manifest?.catalogs?.find(c => c.type === type && String(c.id) === id);
  const title = catalog?.name || id || "Catalogue";
  if (!addon || !type || !id) {
    root.innerHTML = moreShell(title) + `<div class="empty"><h3>That add-on isn't installed</h3><a href="#/addons">Open Add-ons</a></div>`;
    return;
  }
  root.innerHTML = `${moreShell(title)}<p class="note">${esc(addon.manifest.name)}</p><div id="moreGrid" class="grid"></div><div class="more" id="moreFoot"><p class="muted">Loading…</p></div>`;
  const grid = root.querySelector("#moreGrid");
  const foot = root.querySelector("#moreFoot");
  let skip = 0, items = [], more = true, loading = false, hold = false, pages = 0;
  const seen = new Set();
  const paint = () => {
    grid.innerHTML = items.length
      ? items.map((m, i) => metaCard(m, addon, type, i)).join("")
      : (more ? "" : `<div class="empty" style="grid-column:1/-1"><h3>Nothing in this catalogue</h3>${esc(addon.manifest.name)} didn't return any shows.</div>`);
    observeLazy(grid);
    foot.hidden = !more;
    foot.innerHTML = more ? `<button class="btn ghost" type="button" id="loadMore">Load more</button>` : "";
    page.onMore = more ? () => load() : null;
  };
  const load = async () => {
    if (loading || !more || hold || root.dataset.gen !== String(gen)) return;
    loading = true;
    let chain = false;
    try {
      const batch = (await fetchCatalog(addon, type, id, skip)) || [];
      if (root.dataset.gen !== String(gen)) return;
      const fresh = batch.filter(m => m && m.id && !seen.has((m.type || type) + ":" + m.id));
      fresh.forEach(m => seen.add((m.type || type) + ":" + m.id));
      items = items.concat(fresh);
      pages++;
      skip += batch.length || 0;
      more = fresh.length > 0 && batch.length >= 20 && pages < 30;
      paint();
      chain = more && foot.getBoundingClientRect().top < window.innerHeight + 480;
    } catch {
      if (root.dataset.gen !== String(gen)) return;
      hold = true;
      foot.hidden = false;
      foot.innerHTML = `<button class="btn ghost" type="button" id="loadMore">${items.length ? "Couldn't load more. Try again" : "Couldn't load this list. Try again"}</button>`;
      page.onMore = () => { hold = false; load(); };
    } finally { loading = false; }
    if (chain) load();
  };
  page.onMore = () => load();
  bindMoreScroll(foot, load);
  load();
}

const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"];
const FILTERS = {
  genre: ["Genre", GENRES.map(g => [g, g])],
  season: ["Season", [["WINTER", "Winter"], ["SPRING", "Spring"], ["SUMMER", "Summer"], ["FALL", "Fall"]]],
  year: ["Year", Array.from({ length: new Date().getFullYear() + 2 - 1970 }, (_, i) => { const y = new Date().getFullYear() + 1 - i; return [String(y), String(y)]; })],
  format: ["Type", [["TV", "TV"], ["MOVIE", "Movie"], ["OVA", "OVA"], ["ONA", "ONA"], ["SPECIAL", "Special"], ["TV_SHORT", "TV short"]]],
  status: ["Status", [["RELEASING", "Airing"], ["FINISHED", "Finished"], ["NOT_YET_RELEASED", "Not yet aired"], ["HIATUS", "On hiatus"]]],
  country: ["Country", [["JP", "Japan"], ["CN", "China"], ["KR", "South Korea"], ["TW", "Taiwan"]]],
  rating: ["Rating", [["90", "★ 9+"], ["80", "★ 8+"], ["70", "★ 7+"], ["60", "★ 6+"], ["50", "★ 5+"]]],
  source: ["Source", [["MANGA", "Manga"], ["LIGHT_NOVEL", "Light novel"], ["WEB_NOVEL", "Web novel"], ["NOVEL", "Novel"], ["ORIGINAL", "Original"], ["VIDEO_GAME", "Video game"], ["VISUAL_NOVEL", "Visual novel"]]],
  episodes: ["Episodes", [["1-12", "1–12"], ["13-26", "13–26"], ["27-60", "27–60"], ["61-", "61+"]]],
  sort: ["Sort: popular", [["TRENDING_DESC", "Sort: trending"], ["SCORE_DESC", "Sort: top rated"], ["START_DATE_DESC", "Sort: newest"], ["TITLE_ROMAJI", "Sort: A–Z"]]],
  exclude: ["Show everything", [["watching", "Hide my Watching"]]],
};
let filters = { q: "" }, searchPage = 1, searchItems = [], searchMore = false;
let focusSearchOnOpen = false;
const SEARCH_QUERY = `query($page:Int,$search:String,$genre:[String],$season:MediaSeason,$year:Int,$format:[MediaFormat],$status:MediaStatus,$country:CountryCode,$score:Int,$source:MediaSource,$epsMin:Int,$epsMax:Int,$notIn:[Int],$sort:[MediaSort]){
  Page(page:$page,perPage:30){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,search:$search,genre_in:$genre,season:$season,seasonYear:$year,format_in:$format,status:$status,countryOfOrigin:$country,averageScore_greater:$score,source:$source,episodes_greater:$epsMin,episodes_lesser:$epsMax,id_not_in:$notIn,sort:$sort){${MEDIA_FIELDS}}}}`;
function filterVars() {
  const v = { page: searchPage };
  if (filters.q) v.search = filters.q;
  if (filters.genre) v.genre = [filters.genre];
  if (filters.season) v.season = filters.season;
  if (filters.year) v.year = +filters.year;
  if (filters.format) v.format = [filters.format];
  if (filters.status) v.status = filters.status;
  if (filters.country) v.country = filters.country;
  if (filters.rating) v.score = +filters.rating - 1;
  if (filters.source) v.source = filters.source;
  if (filters.episodes) { const [a, b] = filters.episodes.split("-"); v.epsMin = +a - 1; if (b) v.epsMax = +b + 1; }
  if (filters.exclude === "watching") { const ids = Object.keys(watchlist).map(r => +(r.match(/^#\/a\/(\d+)$/) || [])[1]).filter(Boolean); if (ids.length) v.notIn = ids; }
  v.sort = [filters.sort || (filters.q ? "SEARCH_MATCH" : "POPULARITY_DESC")];
  return v;
}
function updateClearBtn() {
  const slot = page.searchRoot?.querySelector(".filter-actions");
  if (!slot) return;
  const active = Object.keys(FILTERS).filter(k => filters[k]).length;
  const btn = slot.querySelector("#clearFilters");
  if (!active) { btn?.remove(); return; }
  const label = `Clear ${active} filter${active > 1 ? "s" : ""}`;
  if (btn) { btn.textContent = label; return; }
  slot.insertAdjacentHTML("beforeend", `<button class="btn ghost" type="button" id="clearFilters">${label}</button>`);
  slot.querySelector("#clearFilters").onclick = () => { filters = { q: filters.q }; page.searchRoot?.querySelectorAll("[data-f]").forEach(sel => { sel.value = ""; sel.classList.remove("set"); }); updateClearBtn(); runSearch(); };
}
async function runSearch(append) {
  const root = page.searchRoot;
  const box = root?.querySelector("#results");
  if (!box) return;
  if (!append) { searchPage = 1; searchItems = []; }
  const gen = ++searchGen;
  const vars = filterVars();
  const key = "search:" + JSON.stringify(vars);
  if (!append) {
    const known = mem.get(key);
    if (!known) setTimeout(() => { if (gen === searchGen && !box.querySelector(".card") && !box.querySelector(".empty")) box.innerHTML = `<div class="grid">${Array.from({ length: 8 }, () => `<div class="card"><div class="cover skel"></div><div class="skel skel-line"></div></div>`).join("")}</div>`; }, 140);
  }
  try {
    const d = await anilist(SEARCH_QUERY, vars, { key, ttl: TTL.search, staleFactor: 12 });
    if (gen !== searchGen) return;
    searchItems = searchItems.concat(d.Page.media);
    rememberMediaAir(d.Page.media);
    searchMore = d.Page.pageInfo.hasNextPage;
    box.innerHTML = searchItems.length
      ? `<div class="grid">${searchItems.map((m, i) => aniCard(m, append ? 99 : i)).join("")}</div>${searchMore ? `<div class="more"><button class="btn ghost" type="button" id="loadMore">Load more</button></div>` : ""}`
      : `<div class="empty"><h3>Nothing matches</h3>Try fewer filters, or the show's Japanese or English title.</div>`;
    observeLazy(box);
    page.onMore = () => { searchPage++; runSearch(true); };
  } catch { if (gen === searchGen) box.innerHTML = `<div class="empty"><h3>Search isn't working</h3>Couldn't reach AniList. Check your connection and try again.</div>`; }
}
function viewSearch(root, focus) {
  page.searchRoot = root;
  const active = Object.keys(FILTERS).filter(k => filters[k]).length;
  root.innerHTML = `
    <h1 class="page-title">Search</h1>
    <form id="filterForm" class="filter-form">
      <input id="q" type="search" class="filter-search" placeholder="Search anime" autocomplete="off" aria-label="Search anime" enterkeyhint="search" value="${esc(filters.q)}">
      <div class="filter-grid">${Object.entries(FILTERS).map(([k, [label, opts]]) => `
        <select id="f-${k}" data-f="${k}" aria-label="${esc(label)}" class="${filters[k] ? "set" : ""}">
          <option value="">${esc(label)}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${filters[k] === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>`).join("")}</div>
      <div class="filter-actions"><button class="btn" type="submit">Filter</button>${active ? `<button class="btn ghost" type="button" id="clearFilters">Clear ${active} filter${active > 1 ? "s" : ""}</button>` : ""}</div>
    </form>
    <div id="results"></div>`;
  const form = root.querySelector("#filterForm");
  const readFilters = () => { filters.q = root.querySelector("#q").value.trim(); form.querySelectorAll("[data-f]").forEach(sel => filters[sel.dataset.f] = sel.value); updateClearBtn(); };
  form.onsubmit = e => { e.preventDefault(); clearTimeout(searchTimer); readFilters(); root.querySelector("#q").blur(); runSearch(); };
  form.querySelectorAll("[data-f]").forEach(sel => sel.onchange = () => sel.classList.toggle("set", !!sel.value));
  root.querySelector("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (!page.searchRoot?.querySelector("#q")) return; const next = page.searchRoot.querySelector("#q").value.trim(); if (next === filters.q) return; filters.q = next; runSearch(); }, 300); });
  const clear = root.querySelector("#clearFilters");
  if (clear) clear.onclick = () => { filters = { q: filters.q }; form.querySelectorAll("[data-f]").forEach(sel => { sel.value = ""; sel.classList.remove("set"); }); updateClearBtn(); runSearch(); };
  // A coarse-pointer device pops the keyboard whenever this field is focused.
  // Only the Search tab itself should do that; coming back from a show should not.
  if (focus && (focusSearchOnOpen || !matchMedia("(pointer: coarse)").matches)) root.querySelector("#q").focus();
  focusSearchOnOpen = false;
  runSearch();
}

function mediaSig(m) { return [m.id, m.episodes || "", m.nextAiringEpisode?.episode || "", m.bannerImage || "", (m.description || "").length, m.averageScore || ""].join(":"); }
function episodeCount(m) {
  if (m.format === "MOVIE") return m.status === "NOT_YET_RELEASED" ? 0 : 1;
  // Next episode 1 means nothing has aired. A missing count used to become
  // 12 buttons (`0 || 12`), including on shows that have not started.
  if (m.nextAiringEpisode?.episode) return Math.max(0, m.nextAiringEpisode.episode - 1);
  if (m.status === "NOT_YET_RELEASED") return 0;
  if (m.episodes) return m.episodes;
  return 12;
}
function nextEpisode(route, count) {
  let last = 0;
  for (const [k, p] of Object.entries(progress)) if (k.startsWith(route + ":")) { const n = +k.split(":").pop(); if (p.d && p.t / p.d > 0.92) last = Math.max(last, n); else if (p.t > 0) last = Math.max(last, n - 1); }
  return Math.min(last + 1, count);
}
function animeSkeleton() {
  return `<div class="hero" aria-hidden="true"><div class="banner skel"></div><div class="hero-body"><div class="cover skel"></div><div style="flex:1"><div class="skel skel-line" style="height:28px;width:70%"></div><div class="skel skel-line" style="width:40%"></div></div></div></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:92%"></div><div class="skel skel-line" style="width:80%"></div><div class="actions"><div class="skel" style="width:180px;height:44px;border-radius:12px"></div></div>`;
}
function paintAnime(root, m) {
  const sig = mediaSig(m);
  if (root.dataset.sig === sig && root.querySelector("#playNext")) { refreshProgressMarks(root); return; }
  root.dataset.sig = sig;
  const id = m.id, route = `#/a/${id}`, title = titleOf(m);
  const isMovie = m.format === "MOVIE", count = episodeCount(m), inList = !!watchlist[route];
  const studio = m.studios?.nodes?.[0]?.name;
  const next = m.nextAiringEpisode ? `Ep ${m.nextAiringEpisode.episode} airs ${new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : "";
  if (m.bannerImage) preloadHero(m.bannerImage);
  else if (m.coverImage?.large) preloadHero(m.coverImage.large);
  rememberMedia(m);
  rememberMediaAir([m]);
  const air = m.nextAiringEpisode ? KumoNotify.airLabel(m.nextAiringEpisode.episode, m.nextAiringEpisode.airingAt, Date.now()) : "";
  const coverImg = m.coverImage?.large || m.coverImage?.medium || "";
  root.innerHTML = `
    <div class="hero">${m.bannerImage ? `<div class="banner"><img src="${esc(m.bannerImage)}" alt="" fetchpriority="high" decoding="async" width="1900" height="400"></div>` : `<div class="banner"></div>`}
      <div class="hero-body"><div class="cover" data-air-for="${esc(m.id)}">${coverImg ? `<img src="${esc(coverImg)}" alt="" decoding="async" fetchpriority="high" width="230" height="320">` : ""}${air ? `<span class="air-pill">${esc(air)}</span>` : ""}</div>
        <div><h1>${esc(title)}</h1>${m.averageScore ? `<div class="score"><b>★ ${aniRating(m)}</b><span>/10 on AniList</span></div>` : ""}<div class="facts">${[studio, m.seasonYear, m.format?.replace("_", " "), m.episodes ? m.episodes + " eps" : ""].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    <p class="desc">${esc(stripHtml(m.description)).replace(/\n/g, "<br>")}</p>
    <div class="actions">
      ${count > 0 ? `<button class="btn" type="button" id="playNext">▶ ${isMovie ? "Play" : "Play episode " + nextEpisode(route, count)}</button>` : `<button class="btn" type="button" disabled>Not aired yet</button>`}
      ${m.trailer?.site === "youtube" ? `<button class="btn ghost" type="button" id="playTrailer">🎬 Trailer</button>` : ""}
      <button class="btn ghost" type="button" id="toggleList" data-watch="${esc(route)}">${inList ? "✓ Watching" : "+ Watching"}</button>
    </div>
    ${isMovie ? "" : section("Episodes", count ? `<div class="eps" data-route="${esc(route)}">${Array.from({ length: count }, (_, i) => i + 1).map(n => {
      const p = progress[`${route}:${n}`]; const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      return `<a class="ep${pct > 92 ? " seen" : ""}" data-ep="${n}" href="#/watch/${id}/${n}">${n}${pct ? `<span class="p" style="width:${pct}%"></span>` : ""}</a>`;
    }).join("")}</div>` : `<p class="note">No episodes have aired yet.</p>`, next)}`;
  page.toggleList = () => {
    toggleWatch(route, title, m.coverImage?.large);
    const b = root.querySelector("#toggleList");
    if (b) b.textContent = watchlist[route] ? "✓ Watching" : "+ Watching";
  };
  page.playNext = () => { autoStartOnce = true; goHash(`#/watch/${id}/${isMovie ? 1 : nextEpisode(route, count)}`); };
  page.playTrailer = m.trailer?.site === "youtube" ? () => play({ ytId: m.trailer.id }, { label: `${title} · Trailer`, key: `${route}:trailer` }) : null;
}
async function viewAnime(id, root, gen) {
  const local = recallMedia(id);
  if (local?.data) paintAnime(root, local.data);
  else root.innerHTML = animeSkeleton();
  try {
    const m = await getMedia(id);
    if (root.dataset.gen !== String(gen)) return;
    paintAnime(root, m);
  } catch {
    if (!local && root.dataset.gen === String(gen)) root.innerHTML = `<div class="empty"><h3>Couldn't load this show</h3>AniList didn't respond. Go back and try again.</div>`;
  }
}

async function fetchAniStreams(ctx, ep, isMovie, onUpdate) {
  const x = await showIds(ctx.media);
  const cands = [];
  if (x.kitsu) cands.push({ id: isMovie ? `kitsu:${x.kitsu}` : `kitsu:${x.kitsu}:${ep}`, anime: true });
  if (x.imdb) cands.push({ id: isMovie ? x.imdb : `${x.imdb}:${x.imdbSeason || 1}:${ep}` });
  if (x.mal) cands.push({ id: isMovie ? `mal:${x.mal}` : `mal:${x.mal}:${ep}`, anime: true });
  if (x.tmdb) cands.push({ id: isMovie ? `tmdb:${x.tmdb}` : `tmdb:${x.tmdb}:${x.imdbSeason || 1}:${ep}` });
  cands.push({ id: `anilist:${ctx.media.id}:${ep}`, anime: true });
  const ids = cands.map(c => c.id);
  const jobs = [], report = [];
  for (const a of allAddons().filter(a => a.enabled)) {
    const spec = resourceSpec(a.manifest, "stream");
    if (!spec) { report.push({ a, why: "doesn't provide episodes (it may only add catalogues or subtitles)" }); continue; }
    const usable = cands.filter(c => handles(a, "stream", c.id)).slice(0, 3);
    if (!usable.length) { report.push({ a, why: `only accepts ${(spec.idPrefixes || []).join(", ") || "unknown"} ids, which Kumo couldn't find for this show` }); continue; }
    jobs.push((async () => {
      const tried = [];
      for (const c of usable) {
        const type = isMovie ? "movie" : c.anime && spec.types.includes("anime") ? "anime" : "series";
        const fmt = c.id.split(":")[0].replace(/^tt\d+$/, "imdb");
        if (spec.types.length && !spec.types.includes(type)) { tried.push(`${fmt}: skipped, add-on doesn't take ${type}`); continue; }
        try {
          const st = await call(a, "stream", type, c.id, ctx);
          if (st.length) {
            if (!st.some(z => z.url || z.ytId || z.externalUrl)) report.push({ a, why: "only has torrent sources, which browsers can't play" });
            return { a, streams: st };
          }
          tried.push(`${fmt}: no results`);
        } catch (e) {
          console.warn(`[Kumo] ${a.manifest.name} failed for ${c.id}:`, e);
          const why = e?.name === "AbortError" ? "took too long, so Kumo moved on" : "didn't respond. It may be offline, or it blocks apps on other websites";
          if (!e.status) { report.push({ a, why }); return { a, failed: true }; }
          tried.push(`${fmt}: error ${e.status}`);
        }
      }
      report.push({ a, why: `had nothing for this episode (tried ${tried.join(", ")})` });
      return { a, streams: [] };
    })());
  }
  const label = isMovie ? "Movie" : `Episode ${ep}`;
  const info = {
    ...ctx, key: `${ctx.route}:${ep}`, label: `${ctx.title} · ${label}`, short: label, ep, subIds: ids, subType: isMovie ? "movie" : "series",
    next: !isMovie && ep < ctx.count ? { short: `Episode ${ep + 1}`, page: `#/watch/${ctx.media.id}/${ep + 1}`, watch: `#/watch/${ctx.media.id}/${ep + 1}`, get: () => fetchAniStreams(ctx, ep + 1, false) } : null,
  };
  const slots = new Array(jobs.length);
  let done = 0;
  const emit = () => onUpdate?.({ results: slots.filter(Boolean), info, report: report.slice(), pending: jobs.length - done });
  await Promise.all(jobs.map((job, i) => job.then(r => { slots[i] = r; done++; emit(); }, () => { done++; emit(); })));
  return { results: slots.filter(Boolean), info, report };
}

function metaRoute(a, type, id) { return `#/m/${encodeURIComponent(a.key)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`; }
function renderStreams(box, results, info) {
  const rows = [];
  for (const r of results) for (const s of r.streams || []) rows.push({ a: r.a, s });
  page.streamRows = rows;
  page.info = info;
  const failed = results.filter(r => r.failed).map(r => r.a.manifest.name);
  const kind = s => KumoPlayback.kindLabel(s) || "Unknown";
  box.innerHTML = `<div class="streams"><h3>${esc(info.short)}</h3>
    ${rows.length ? rows.map((x, i) => `<button class="stream" type="button" data-i="${i}"><div><b>${esc(x.s.name || x.a.manifest.name)}</b><span>${esc(x.s.title || x.s.description || "")}</span></div><span class="kind">${kind(x.s)}</span></button>`).join("")
      : `<p class="note">None of your add-ons have a source for this yet. ${addons.length ? "" : "Install an add-on under Add-ons to get episode sources."}</p>`}
    ${failed.length ? `<p class="note">No answer from: ${failed.map(esc).join(", ")}.</p>` : ""}</div>`;
}
async function viewMeta(key, type, id, root) {
  const a = allAddons().find(x => x.key === key);
  if (!a) { root.innerHTML = `<div class="empty"><h3>Add-on not installed</h3>This page came from an add-on that's been removed.</div>`; return; }
  root.innerHTML = animeSkeleton();
  let m;
  try { m = handles(a, "meta", id) ? await call(a, "meta", type, id) : null; } catch {}
  if (root !== mount() && !root.isConnected) return;
  if (!m) { root.innerHTML = `<div class="empty"><h3>Couldn't load this title</h3>${esc(a.manifest.name)} didn't send its details.</div>`; return; }
  const route = metaRoute(a, type, id);
  const videos = (m.videos || []).slice().sort((x, y) => (x.season || 0) - (y.season || 0) || (x.episode || 0) - (y.episode || 0));
  const inList = !!watchlist[route];
  if (m.background) preloadHero(m.background);
  root.innerHTML = `
    <div class="hero">${m.background ? `<div class="banner"><img src="${esc(m.background)}" alt="" fetchpriority="high" decoding="async" width="1900" height="400"></div>` : `<div class="banner"></div>`}
      <div class="hero-body"><div class="cover">${m.poster ? `<img src="${esc(m.poster)}" alt="" decoding="async" fetchpriority="high" width="230" height="320">` : ""}</div>
        <div><h1>${esc(m.name)}</h1>${m.imdbRating ? `<div class="score"><b>★ ${esc(m.imdbRating)}</b><span>/10</span></div>` : ""}<div class="facts">${[m.releaseInfo, (m.genres || []).slice(0, 3).join(", "), a.manifest.name].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ""}
    <div class="actions">${videos.length ? "" : `<button class="btn" type="button" id="playMain">▶ Play</button>`}<button class="btn ghost" type="button" id="toggleList" data-watch="${esc(route)}">${inList ? "✓ Watching" : "+ Watching"}</button></div>
    ${videos.length ? section("Episodes", `<div class="vlist">${videos.map(v => `<button class="vrow" type="button" data-vid="${esc(v.id)}">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" width="120" height="68" loading="lazy" decoding="async">` : ""}<div><b>${esc(v.title || v.name || "Episode " + v.episode)}</b><span>${[v.season != null ? "S" + v.season : "", v.episode != null ? "E" + v.episode : ""].join(" ")}</span></div></button>`).join("")}</div>`) : ""}
    <div id="streams"></div>`;
  const ctx = { route, title: m.name, poster: m.poster };
  page.toggleList = () => { toggleWatch(route, m.name, m.poster); const b = root.querySelector("#toggleList"); if (b) b.textContent = watchlist[route] ? "✓ Watching" : "+ Watching"; };
  const vLabel = v => v.title || v.name || `Episode ${v.episode}`;
  const fetchStreams = async i => {
    const vid = i < 0 ? id : videos[i].id, label = i < 0 ? m.name : vLabel(videos[i]);
    const targets = allAddons().filter(x => x.enabled && handles(x, "stream", vid));
    const results = new Array(targets.length);
    let pending = targets.length;
    const paint = () => {
      const box = root.querySelector("#streams");
      if (!box) return;
      renderStreams(box, results.filter(Boolean), info);
    };
    const info = {
      ...ctx, key: `${route}:${vid}`, label: `${m.name}${label === m.name ? "" : " · " + label}`, short: label, subIds: [vid], subType: type,
      next: i >= 0 && i + 1 < videos.length ? { short: vLabel(videos[i + 1]), page: route, get: () => fetchStreams(i + 1) } : null,
    };
    await Promise.all(targets.map((x, n) => call(x, "stream", type, vid, ctx).then(s => ({ a: x, streams: s || [] }), () => ({ a: x, failed: true })).then(r => { results[n] = r; pending--; paint(); })));
    return { results: results.filter(Boolean), info, pending };
  };
  const load = async i => {
    const box = root.querySelector("#streams");
    if (!box) return;
    box.innerHTML = `<div class="streams"><h3>${esc(i < 0 ? m.name : vLabel(videos[i]))}</h3><p class="muted">Asking your add-ons…</p></div>`;
    box.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    await fetchStreams(i);
  };
  page.playMain = () => load(-1);
  page.loadVid = vid => load(videos.findIndex(x => x.id === vid));
}

function toggleWatch(route, title, poster) {
  if (watchlist[route]) { delete watchlist[route]; removed[route] = Date.now(); store.set("removed", removed); toast("Removed from Watching"); }
  else { watchlist[route] = { route, title, poster, added: Date.now() }; toast("Added to Watching"); }
  store.set("watchlist", watchlist);
  paintQuick(route);
  refreshContinue();
  refreshList();
  loadNotes();
  scheduleSync();
}
function viewList(root) {
  const items = watchingItems();
  root.innerHTML =
    section("Watching", items.length ? `<div class="grid">${items.map(w => card(w.route, w.title, w.poster, "", "", { defer: false })).join("")}</div>` : `<div class="empty"><h3>You're not watching anything yet</h3>Tap <b>+ Watching</b> on any show to keep it here and get told when new episodes come out.</div>`) +
    `<p class="note">Your shows are saved on this device.</p>`;
  observeLazy(root);
}
function viewAddons(root) {
  const all = allAddons();
  const installed = new Set(addons.map(a => addonKey(a.url)));
  root.innerHTML = `
    <section class="section"><div class="section-head"><h2>Install an add-on</h2></div>
      <p class="note">Paste the link to a Stremio-compatible add-on (it usually ends in <code>manifest.json</code>).</p>
      <form class="field" id="addonForm"><input id="addonUrl" placeholder="https://example.com/manifest.json" inputmode="url" autocomplete="off"><button class="btn">Install</button></form>
      <div class="section-head"><h2>Add a repository</h2></div>
      <p class="note">A repository is a link to a list of add-ons. Add one to browse what's in it.</p>
      <form class="field" id="repoForm"><input id="repoUrl" placeholder="https://example.com/repo.json" inputmode="url" autocomplete="off"><button class="btn">Add</button></form>
    </section>
    ${rdSection()}
    ${section("Installed", all.map((a, i) => `
      <div class="addon">${a.manifest.logo ? `<img src="${esc(a.manifest.logo)}" alt="" width="44" height="44" decoding="async">` : `<div class="logo-ph">${esc((a.manifest.name || "?")[0])}</div>`}
        <div class="info"><b>${esc(a.manifest.name)}</b><p>${esc(a.manifest.description || "")}</p>
          <div class="tags">${a.builtin ? `<span class="tag">Built in</span>` : ""}${(a.manifest.resources || []).map(r => `<span class="tag">${esc(typeof r === "string" ? r : r.name)}</span>`).join("")}<span class="tag">v${esc(a.manifest.version)}</span></div></div>
        <div class="ctrl"><input type="checkbox" class="switch" id="sw-${i}" data-key="${esc(a.key)}" aria-label="Turn ${esc(a.manifest.name)} on or off" ${a.enabled ? "checked" : ""}>
          ${a.builtin ? "" : `<button class="btn ghost small" type="button" data-remove="${esc(a.key)}">Remove</button>`}</div>
      </div>`).join(""), `${all.filter(a => a.enabled).length} on`)}
    ${repos.map(r => section(r.name, r.entries.map(e => {
      const has = installed.has(addonKey(e.url));
      return `<div class="addon"><div class="logo-ph">${esc((e.name || "?")[0])}</div><div class="info"><b>${esc(e.name || e.url)}</b><p>${esc(e.description || e.url)}</p></div>
        <div class="ctrl">${has ? `<span class="tag on">Installed</span>` : `<button class="btn small" type="button" data-install="${esc(e.url)}">Install</button>`}</div></div>`;
    }).join("") + `<button class="btn ghost small" type="button" data-unrepo="${esc(r.url)}">Remove repository</button>`, "Repository")).join("")}`;

  $("#rdForm").onsubmit = e => {
    e.preventDefault();
    const token = $("#rdToken").value.trim(), proxy = $("#rdProxy").value.trim();
    const patch = { proxy };
    if (token) patch.token = token;
    saveRd(patch);
    rdPlayCache.clear();
    rdCorsBlocked = false;
    toast("Real-Debrid settings saved");
    viewAddons(mount());
  };
  if ($("#rdClear")) $("#rdClear").onclick = () => { saveRd({ token: "" }); rdPlayCache.clear(); rdCorsBlocked = false; toast("Forgot the pasted token"); viewAddons(mount()); };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); viewAddons(mount()); } catch (e) { toast(e.message.includes("fetch") ? "Couldn't reach that link. Check it's https and online." : e.message); btn.disabled = false; } };
  $("#addonForm").onsubmit = e => { e.preventDefault(); const v = $("#addonUrl").value; if (v.trim()) busy(e.submitter || e.target.querySelector("button"), () => installAddon(v)); };
  $("#repoForm").onsubmit = e => { e.preventDefault(); const v = $("#repoUrl").value; if (v.trim()) busy(e.submitter || e.target.querySelector("button"), () => addRepo(v)); };
  root.querySelectorAll("[data-install]").forEach(b => b.onclick = () => busy(b, () => installAddon(b.dataset.install)));
  root.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => { addons = addons.filter(a => a.url !== b.dataset.remove); saveAddons(); toast("Add-on removed"); viewAddons(mount()); });
  root.querySelectorAll("[data-unrepo]").forEach(b => b.onclick = () => { repos = repos.filter(r => r.url !== b.dataset.unrepo); store.set("repos", repos); viewAddons(mount()); });
  root.querySelectorAll(".switch").forEach(sw => sw.onchange = () => {
    const k = sw.dataset.key;
    if (k.startsWith("builtin:")) { builtinOff[k] = !sw.checked; store.set("builtinOff", builtinOff); }
    else { const a = addons.find(x => x.url === k); if (a) { a.enabled = sw.checked; saveAddons(); } }
  });
}

// ---------- watch page ----------
let autoStartOnce = false;
const audioOf = s => { const t = `${s.name || ""} ${s.title || ""} ${s.description || ""}`; return /\bdub(bed)?\b|\beng(lish)? ?dub|\bdual\b/i.test(t) ? "dub" : /\bsub(bed|s)?\b|\bsoft ?sub|\bhard ?sub/i.test(t) ? "sub" : "other"; };
function streamKey(row) {
  const s = row?.s || {};
  return (row?.a?.key || "") + "|" + (s.url || s.ytId || s.externalUrl || s.infoHash || s.name || "");
}
function paintSources(root, rows, report, pending) {
  const box = root.querySelector("#wtSources");
  if (!box) return;
  page.rows = rows;
  const groups = [["sub", "SUB", "CC"], ["dub", "DUB", "🎙"], ["other", rows.some(r => r.audio !== "other") ? "Other" : "Sources", "▶"]];
  const kind = st => { try { return KumoPlayback.kindLabel(st); } catch { return ""; } };
  const tagOf = disp => disp === "blocked" ? "Blocked by Real-Debrid" : disp === "uncached" ? "Not cached" : disp === "wrong-ip" ? "Different connection" : disp === "slate" ? "Unavailable" : disp === "failed" ? "Didn't play" : "";
  const showAll = !!prefs.showAllSources;
  const hide = (s, url) => { try { return KumoPlayback.hideFromList(s, verdictOf(url), showAll); } catch { return false; } };
  if (!rows.length) {
    box.innerHTML = pending
      ? `<p class="muted">Asking your add-ons…</p>`
      : `<div class="empty"><h3>No sources for this episode</h3>${addons.filter(a => a.enabled).length ? "None of your add-ons have it yet. Try again later or add another add-on." : `You haven't installed any add-ons. <a href="#/addons">Open Add-ons</a> to add one.`}</div>`;
  } else {
    const visible = rows.map((r, i) => ({ ...r, i })).filter(r => !hide(r.s, r.s.url));
    box.innerHTML = visible.length ? groups.map(([g, label, icon]) => {
      const list = visible.filter(r => r.audio === g);
      return list.length ? `<div class="wt-group"><div class="wt-group-h"><span class="wt-badge">${icon}</span>${label}</div><div class="wt-grid">${list.map(r => {
        let disp = "ready";
        try { disp = KumoPlayback.listDisposition(r.s, verdictOf(r.s.url)); } catch {}
        const tag = tagOf(disp);
        return `<button class="wt-src${disp !== "ready" ? " bad" : ""}" type="button" data-i="${r.i}" data-disp="${disp}" data-key="${esc(r.key || streamKey(r))}" ${playable(r.s) || r.s.externalUrl ? "" : "disabled"}><span class="dot">▶</span><span class="nm">${esc((r.s.name || r.a.manifest.name).split("\n")[0])}</span><small>${esc(r.a.manifest.name)}${kind(r.s) ? " · " + kind(r.s) : ""}${tag ? " · " + esc(tag) : ""}</small></button>`;
      }).join("")}</div></div>` : "";
    }).join("") : (pending ? `<p class="muted">Asking your add-ons…</p>` : `<p class="muted">Nothing here can play immediately. Turn on Show all sources for uncached and blocked links.</p>`);
  }
  if (report?.length && !pending) box.insertAdjacentHTML("beforeend", `<details class="wt-report"${rows.some(r => playable(r.s) && !hide(r.s, r.s.url)) ? "" : " open"}><summary>Add-on status (${report.length})</summary><ul>${report.map(r => `<li><b>${esc(r.a.manifest.name)}</b> ${esc(r.why)}.</li>`).join("")}</ul></details>`);
  if (page.playingKey) box.querySelectorAll(".wt-src").forEach(b => b.classList.toggle("on", b.dataset.key === page.playingKey));
}
function paintWatch(root, m, ep) {
  const sig = mediaSig(m) + ":" + ep;
  if (root.dataset.sig === sig && root.querySelector("#wtSources")) return false;
  if (root.querySelector("media-player, .pv-holder")) return false;
  root.dataset.sig = sig;
  const id = m.id, route = `#/a/${id}`, title = titleOf(m), isMovie = m.format === "MOVIE", count = episodeCount(m);
  const poster = m.bannerImage || m.coverImage?.large || "";
  if (poster) preloadHero(poster);
  rememberMedia(m);
  const toggle = (k, label) => `<button class="wt-toggle" type="button" data-pref="${k}" aria-pressed="${!!prefs[k]}"><span class="box" aria-hidden="true"></span>${label}</button>`;
  const air = m.nextAiringEpisode ? `Episode ${m.nextAiringEpisode.episode} arrives ${new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}.` : "";
  root.innerHTML = `
    <div class="watch-stage" id="watchStage">
      <div class="wt-poster">${poster ? `<img src="${esc(poster)}" alt="" fetchpriority="high" decoding="async" width="1900" height="400">` : ""}</div>
      <button class="wt-play" id="wtStart" type="button" aria-label="Play">${ICON.play}</button>
      <div class="wt-status" id="wtStatus">Finding sources…</div>
    </div>
    <div class="wt-bar">
      <div class="wt-toggles">${toggle("autoPlay", "Auto Play")}${isMovie ? "" : toggle("autoNext", "Auto Next")}${toggle("autoSkip", "Auto Skip intro")}${toggle("showAllSources", "Show all sources")}</div>
      <label class="wt-player">Play outside in
        <select id="extPlayer" aria-label="External player">
          <option value="infuse">Infuse</option>
          <option value="vlc">VLC</option>
          <option value="outplayer">Outplayer</option>
        </select>
      </label>
      ${isMovie ? "" : `<div class="wt-nav"><button class="wt-navbtn" type="button" id="wtPrev" data-href="#/watch/${id}/${ep - 1}" ${ep <= 1 ? "disabled" : ""}>⏮ Prev</button><button class="wt-navbtn" type="button" id="wtNext" data-href="#/watch/${id}/${ep + 1}" ${ep >= count ? "disabled" : ""}>Next ⏭</button></div>`}
    </div>
    <div class="wt-info">You're watching <b>${isMovie ? esc(title) : "Episode " + ep}</b>${isMovie ? "" : ` of <a href="${route}">${esc(title)}</a>`}. If a source doesn't work, try another one below.</div>
    <div id="wtSources" class="wt-sources"><p class="muted">Asking your add-ons…</p></div>
    ${air ? `<div class="wt-air">🔔 ${esc(air)}</div>` : ""}
    ${isMovie ? "" : section("Episodes", `<div class="eps" data-route="${esc(route)}">${Array.from({ length: count }, (_, i) => i + 1).map(n => {
      const p = progress[`${route}:${n}`]; const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      return `<a class="ep${pct > 92 ? " seen" : ""}" data-ep="${n}" href="#/watch/${id}/${n}" ${n === ep ? 'aria-current="true"' : ""}>${n}${pct ? `<span class="p" style="width:${pct}%"></span>` : ""}</a>`;
    }).join("")}</div>`)}`;
  const extPlayer = root.querySelector("#extPlayer");
  if (extPlayer) {
    extPlayer.value = ["infuse", "vlc", "outplayer"].includes(prefs.externalPlayer) ? prefs.externalPlayer : "infuse";
    extPlayer.onchange = () => { prefs.externalPlayer = extPlayer.value; store.set("playerPrefs", prefs); };
  }
  return true;
}
async function viewWatch(id, ep, root, gen) {
  ep = +ep || 1;
  ensurePlayerAssets();
  const here = "#/watch/" + id + "/" + ep;
  const local = recallMedia(id);
  if (local?.data) paintWatch(root, local.data, ep);
  else root.innerHTML = `<div class="watch-stage skel" id="watchStage"></div><div class="wt-bar"><div class="skel skel-line" style="height:44px"></div></div><div id="wtSources" class="wt-sources"><p class="muted">Asking your add-ons…</p></div>`;
  let m = local?.data;
  try {
    const fresh = await getMedia(id);
    if (root.dataset.gen !== String(gen) || location.hash !== here) return;
    m = fresh;
    paintWatch(root, m, ep);
  } catch {
    if (!m) { if (root.dataset.gen === String(gen)) root.innerHTML = `<div class="empty"><h3>Couldn't load this episode</h3>AniList didn't respond. Go back and try again.</div>`; return; }
  }
  if (!root.querySelector("#wtSources")) paintWatch(root, m, ep);
  const route = `#/a/${id}`, title = titleOf(m), isMovie = m.format === "MOVIE", count = episodeCount(m);
  const ctx = { media: m, route, title, poster: m.coverImage?.large, count };
  const autostart = autoStartOnce || prefs.autoPlay; autoStartOnce = false;
  const startedAt = Date.now();
  let started = false, inspected = false, lastReport = [];
  const rows = [];
  const seen = new Set();
  const bindRefresh = pending => {
    refreshSources = () => {
      if (location.hash !== here || root.dataset.gen !== String(gen)) return;
      paintSources(root, rows, lastReport, pending);
    };
  };
  const maybeInspect = () => {
    if (inspected || location.hash !== here) return;
    inspected = true;
    inspectSources(rows, here);
  };
  bindRefresh(1);
  page.playAuto = () => { if (!rows.some(r => playable(r.s))) return; playFromList(rows.slice(), null, page.info, root.querySelector("#watchStage")); };
  const maybeStart = settled => {
    const has = rows.some(r => playable(r.s));
    const status = root.querySelector("#wtStatus");
    const start = root.querySelector("#wtStart");
    if (!has && settled) { if (status) status.textContent = rows.length ? "Pick a source below." : "No sources found."; if (start) start.hidden = true; return; }
    if (started || !autostart || !has) return;
    if (!settled && Date.now() - startedAt < 2500) return;
    started = true;
    if (status) status.textContent = "";
    page.playAuto();
  };
  const waitLeft = 2500 - (Date.now() - startedAt);
  if (waitLeft > 0) setTimeout(() => { if (root.dataset.gen === String(gen) && location.hash === here) maybeStart(false); }, waitLeft);
  const { info } = await fetchAniStreams(ctx, ep, isMovie, ({ results, info: inf, report, pending }) => {
    if (root.dataset.gen !== String(gen) || location.hash !== here) return;
    for (const r of results) for (const st of r.streams || []) {
      const row = { a: r.a, s: st, audio: audioOf(st) };
      const key = streamKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      row.key = key;
      rows.push(row);
    }
    page.info = inf;
    lastReport = report;
    bindRefresh(pending);
    paintSources(root, rows, report, pending);
    if (pending === 0) maybeInspect();
    maybeStart(pending === 0);
  });
  if (root.dataset.gen !== String(gen) || location.hash !== here) return;
  page.info = info;
  bindRefresh(0);
  paintSources(root, rows, lastReport, 0);
  maybeInspect();
  maybeStart(true);
}
async function inspectSources(rows, here) {
  const queue = rows.filter(r => r.s?.url && KumoPlayback.isDebridResolver(r.s.url) && !verdictOf(r.s.url) && !KumoPlayback.isUncachedStream(r.s));
  let cursor = 0;
  const step = async () => {
    while (cursor < queue.length) {
      const row = queue[cursor++];
      if (location.hash !== here) return;
      try {
        const klass = KumoPlayback.classifyProbe(await probeStream(row.s.url), row.s);
        if (location.hash !== here) return;
        if (klass === "status") { rememberVerdict(row.s.url, "blocked"); continue; }
        if (klass !== "redirect") continue;
        const phone = KumoPlayback.classifyPhoneFetch(await resolveOnPhone(row.s.url));
        if (location.hash !== here) return;
        if (phone.action === "blocked") rememberVerdict(row.s.url, "blocked");
        else if (phone.action === "slate") rememberVerdict(row.s.url, "slate");
        else if (phone.action === "wrong-ip") rememberVerdict(row.s.url, "wrong-ip");
      } catch {}
    }
  };
  await Promise.all([step(), step(), step()]);
}

function refreshProgressMarks(root) {
  if (!root) return;
  root.querySelectorAll(".eps").forEach(box => {
    const show = box.dataset.route;
    if (!show) return;
    box.querySelectorAll(".ep").forEach(el => {
      const p = progress[show + ":" + el.dataset.ep];
      const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      el.classList.toggle("seen", pct > 92);
      let bar = el.querySelector(":scope > .p");
      if (pct) { if (!bar) { bar = document.createElement("span"); bar.className = "p"; el.appendChild(bar); } bar.style.width = pct + "%"; }
      else if (bar) bar.remove();
    });
  });
}

// ---------- routing ----------
const viewNodes = new Map();
let activeKey = "", navPop = false, viewGen = 0, booted = false, forceRoute = false, navSerial = 0, vtActive = false, homeScroll = 0;
let leaveY = 0, freezeY = false;
window.addEventListener("scroll", () => { if (!freezeY) leaveY = window.scrollY; }, { passive: true });
document.addEventListener("click", e => {
  const t = e.target;
  if (t instanceof Element && t.closest("a[href^='#/']")) {
    leaveY = window.scrollY;
    freezeY = true;
    if (t.closest("a[data-back]")) navPop = true;
  }
}, true);
function goHash(hash) { leaveY = window.scrollY; freezeY = true; location.hash = hash; }
function routeKey() { const h = location.hash; return !h || h === "#" ? "#/" : h; }
function swapView(fn) {
  const mine = ++navSerial;
  const run = () => { if (mine === navSerial) fn(); };
  if (!booted || reduceMotion || vtActive || typeof document.startViewTransition !== "function") {
    booted = true;
    vtActive = false;
    run();
    return;
  }
  vtActive = true;
  try {
    const t = document.startViewTransition(run);
    t.finished.finally(() => { if (mine === navSerial) vtActive = false; }).catch(() => {});
  } catch { vtActive = false; run(); }
}
function updateDock(key) {
  const p = key.replace(/^#\/?/, "").split("/")[0];
  const tab = { "": "home", search: "search", list: "list", addons: "addons", more: "home" }[p] || "";
  document.querySelectorAll(".dock a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === tab ? "page" : "false"));
}
function snapshotPage(el) {
  if (!el) return;
  el._page = {
    rows: page.rows, streamRows: page.streamRows, info: page.info, playAuto: page.playAuto,
    loadVid: page.loadVid, toggleList: page.toggleList, playNext: page.playNext,
    playTrailer: page.playTrailer, playMain: page.playMain, onMore: page.onMore,
    playingKey: page.playingKey, searchRoot: page.searchRoot,
  };
}
function restorePage(el) {
  if (el?._page) Object.assign(page, el._page);
}
function resetPage() {
  page.rows = null; page.streamRows = null; page.info = null; page.playAuto = null; page.loadVid = null;
  page.toggleList = null; page.playNext = null; page.playTrailer = null; page.playMain = null; page.onMore = null;
  page.playingKey = ""; page.searchRoot = null;
}
function renderRoute(key, root, gen) {
  resetPage();
  const h = key.replace(/^#\/?/, "");
  const [p, ...rest] = h.split("/");
  // Don't return these promises: a view transition waits on the update callback.
  if (!p) viewHome(root, gen);
  else if (p === "more") viewMore(rest, root, gen);
  else if (p === "watch") viewWatch(rest[0], rest[1], root, gen);
  else if (p === "search") { if (rest[0]) filters.q = decodeURIComponent(rest.join("/")); viewSearch(root, !rest[0] && !filters.q); }
  else if (p === "a") viewAnime(rest[0], root, gen);
  else if (p === "m") viewMeta(decodeURIComponent(rest[0]), decodeURIComponent(rest[1] || ""), decodeURIComponent(rest.slice(2).join("/")), root, gen);
  else if (p === "list") viewList(root);
  else if (p === "addons") viewAddons(root);
  else viewHome(root, gen);
}
function hidePlaying() {
  if ($("#player").hidden && !current) return;
  teardown();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const player = $("#player");
  player.hidden = true;
  player.style.display = "none";
  document.body.style.overflow = "";
  current = null;
}
function route() {
  if (swReload && $("#player").hidden && !current) { swReload = false; location.reload(); return; }
  const key = routeKey();
  const departingY = leaveY;
  freezeY = false;
  const parts = key.replace(/^#\/?/, "").split("/");
  if (parts[0] === "a" && parts[2]) { location.replace(`#/watch/${parts[1]}/${parts[2]}`); return; }
  const pop = navPop; navPop = false;
  updateDock(key);
  if (forceRoute) { viewNodes.delete(key); viewNodes.delete("#/"); viewNodes.delete("#/list"); if (activeKey === key) activeKey = ""; forceRoute = false; }
  if (key === activeKey && app.firstElementChild?.classList?.contains("view")) {
    cancelPlayback();
    refreshProgressMarks(app.firstElementChild);
    if (key === "#/") refreshContinue();
    if (key === "#/list") refreshList();
    return;
  }
  cancelPlayback();
  hidePlaying();
  const reuse = key.startsWith("#/watch") ? null : viewNodes.get(key);
  swapView(() => {
    let root;
    if (activeKey && activeKey !== key) {
      const el = app.firstElementChild;
      if (el?.classList?.contains("view") && !activeKey.startsWith("#/watch")) {
        snapshotPage(el);
        viewNodes.delete(activeKey);
        if (activeKey === "#/") homeScroll = departingY;
        viewNodes.set(activeKey, { el, y: departingY, at: Date.now() });
        while (viewNodes.size > 8) {
          let drop = null;
          for (const k of viewNodes.keys()) if (k !== "#/") { drop = k; break; }
          if (!drop) break;
          viewNodes.delete(drop);
        }
      }
      if (el) el.remove();
    }
    if (reuse?.el) { root = reuse.el; app.replaceChildren(root); }
    else { root = document.createElement("div"); root.className = "view"; app.replaceChildren(root); }
    activeKey = key;
    if (reuse?.el) {
      restorePage(reuse.el);
      const y = pop ? (reuse.y || (key === "#/" ? homeScroll : 0)) : 0;
      const snap = () => window.scrollTo(0, y);
      snap();
      requestAnimationFrame(() => requestAnimationFrame(snap));
      refreshProgressMarks(root);
      if (key === "#/") refreshContinue();
      if (key === "#/list") refreshList();
      return;
    }
    window.scrollTo(0, key === "#/" && pop ? homeScroll : 0);
    const gen = ++viewGen;
    root.dataset.gen = String(gen);
    renderRoute(key, root, gen);
  });
}
window.addEventListener("popstate", () => { navPop = true; });
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const searchTab = document.querySelector('.dock-item[data-tab="search"]');
if (searchTab) searchTab.addEventListener("click", () => {
  if (routeKey() !== "#/search") focusSearchOnOpen = true;
});
app.addEventListener("click", e => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const quick = t.closest(".quick-add");
  if (quick && app.contains(quick)) {
    e.preventDefault();
    e.stopPropagation();
    const routeKey = quick.dataset.quick;
    if (routeKey) toggleWatch(routeKey, quick.dataset.title || "", quick.dataset.poster || "");
    return;
  }
  const hide = t.closest(".card-remove");
  if (hide && app.contains(hide)) {
    e.preventDefault();
    e.stopPropagation();
    hideFromContinue(hide.dataset.hideShow, hide.dataset.title);
    return;
  }
  const pref = t.closest("[data-pref]");
  if (pref && app.contains(pref)) {
    prefs[pref.dataset.pref] = !prefs[pref.dataset.pref];
    store.set("playerPrefs", prefs);
    pref.setAttribute("aria-pressed", String(!!prefs[pref.dataset.pref]));
    if (pref.dataset.pref === "showAllSources") refreshSources();
    return;
  }
  const src = t.closest(".wt-src");
  if (src && page.rows && !src.hasAttribute("disabled")) {
    const i = +src.dataset.i;
    const row = page.rows[i];
    const verdict = row?.s?.url ? verdictOf(row.s.url) : "";
    if (row?.s?.url && verdict === "external" && !KumoPlayback.isUncachedStream(row.s)) {
      highlightSource(i);
      handoffExternal(app.querySelector("#watchStage"), page.info, row.s.url);
      return;
    }
    playFromList(page.rows, i, page.info, app.querySelector("#watchStage"), { explicit: true });
    return;
  }
  const stream = t.closest(".stream");
  if (stream && page.streamRows) { playFromList(page.streamRows, +stream.dataset.i, page.info, null, { explicit: true }); return; }
  const vid = t.closest("[data-vid]");
  if (vid && page.loadVid) { page.loadVid(vid.dataset.vid); return; }
  if (t.closest("#wtStart")) { page.playAuto?.(); return; }
  const prev = t.closest("#wtPrev");
  if (prev && !prev.disabled && prev.dataset.href) { autoStartOnce = true; goHash(prev.dataset.href); return; }
  const next = t.closest("#wtNext");
  if (next && !next.disabled && next.dataset.href) { autoStartOnce = true; goHash(next.dataset.href); return; }
  if (t.closest("#toggleList")) { page.toggleList?.(); return; }
  if (t.closest("#playNext")) { page.playNext?.(); return; }
  if (t.closest("#playTrailer")) { page.playTrailer?.(); return; }
  if (t.closest("#playMain")) { page.playMain?.(); return; }
  const more = t.closest("#loadMore");
  if (more && page.onMore) { more.disabled = true; page.onMore(); }
});
// ---------- player ----------
// Vidstack does the playing and controls; Kumo adds Skip intro, Next episode + auto-play,
// subtitles from add-ons, resume and remembered speed / subtitle language.
const LANGS = { en: "English", eng: "English", ja: "Japanese", jpn: "Japanese", es: "Spanish", spa: "Spanish", pt: "Portuguese", por: "Portuguese", pob: "Portuguese (BR)", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German", it: "Italian", ita: "Italian", ar: "Arabic", ara: "Arabic", ru: "Russian", rus: "Russian", id: "Indonesian", ind: "Indonesian", tr: "Turkish", tur: "Turkish" };
const ICON = {
  play: `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
};
let prefs = { speed: 1, subLang: "", autoNext: true, autoPlay: true, autoSkip: false, showAllSources: false, externalPlayer: "infuse", ...store.get("playerPrefs", {}) };
let saveTimer = null, current = null, countTimer = null;
const playable = s => s && (s.url || s.ytId);

function openShell(label) {
  $("#playerTitle").textContent = label;
  $("#player").hidden = false; $("#player").style.display = "";
  document.body.style.overflow = "hidden";
}
function teardown() {
  current?.record?.();
  clearInterval(saveTimer); clearInterval(countTimer);
  // Stop playback before the element is removed, or the browser rejects
  // play() with an uncaught AbortError when you leave the page.
  document.querySelectorAll("media-player, video").forEach(el => {
    try { el.pause?.(); } catch {}
  });
  const host = current?.mount;
  if (host?.isConnected) { host.querySelector(".pv-holder")?.remove(); host.classList.remove("idle", "playing"); }
  $("#playerStage").innerHTML = "";
  $("#player").classList.remove("idle");
}

async function gatherSubs(s, info) {
  const list = (s.subtitles || []).map(x => ({ url: x.url, lang: x.lang, from: "stream" }));
  const jobs = allAddons().filter(a => a.enabled && resourceSpec(a.manifest, "subtitles")).map(a => {
    const sid = (info.subIds || []).find(i => handles(a, "subtitles", i));
    return sid ? call(a, "subtitles", info.subType || "series", sid).then(r => (r || []).map(x => ({ url: x.url, lang: x.lang, from: a.manifest.name })), () => []) : [];
  });
  for (const r of await Promise.all(jobs)) list.push(...r);
  const seen = new Set();
  return list.filter(x => x.url && !seen.has(x.url) && seen.add(x.url));
}

// ---------- Real-Debrid ----------
// Safari plays HLS natively and does not play MKV. hls.js is only for browsers
// without native HLS: forcing it on iPhone makes playback depend on CORS
// headers Real-Debrid does not send.
const nativeHls = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
let playGen = 0, rdCorsBlocked = false, clientIpCache = "";
const rdPlayCache = new Map();
let refreshSources = () => {};
const cancelPlayback = () => { playGen++; };
function verdicts() { return store.get("sourceVerdicts", {}); }
function verdictOf(url) { return url ? (verdicts()[url]?.kind || "") : ""; }
function rememberVerdict(url, kind) {
  if (!url || !kind) return;
  const all = verdicts();
  all[url] = { kind, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 300) {
    keys.sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - 300)) delete all[k];
  }
  store.set("sourceVerdicts", all);
  refreshSources();
}
function chosenExternal(url) {
  const list = KumoPlayback.externalPlayers(url);
  const id = prefs.externalPlayer || "infuse";
  return list.find(p => p.id === id) || list.find(p => p.id === "infuse") || list[0];
}
function handoffExternal(mount, info, url) {
  const p = chosenExternal(url);
  const html = `<div class="err handoff"><b>Opening in ${esc(p.name)}</b><p>${esc(KumoPlayback.externalOnlyMessage)}</p><div class="ext"><button class="btn primary" type="button" data-ext="${esc(p.href)}">Open ${esc(p.name)}</button><button class="btn ghost" type="button" id="copyStream" data-url="${esc(url)}">Copy link</button></div></div>`;
  showStageMessage(mount, info, html);
  if ($("#wtStatus")) $("#wtStatus").textContent = "Opening in " + p.name + "…";
  location.href = p.href;
}
function isSafariPlayer() {
  const ua = navigator.userAgent || "";
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return iOS || /^((?!chrome|android|crios|fxios|edg\/).)*safari/i.test(ua);
}
function rdToken() {
  const manual = (rdSettings.token || "").trim();
  if (manual) return { token: manual, from: "saved" };
  return KumoPlayback.tokenFromAddons(addons);
}
function rdProxy() { return (rdSettings.proxy || "").trim(); }
function rdSection() {
  const found = KumoPlayback.tokenFromAddons(addons);
  const saved = (rdSettings.token || "").trim();
  const who = found && !saved ? `Using the Real-Debrid key already in your ${esc(found.from)} add-on.` : saved ? "Using the token pasted below." : "No Real-Debrid token found yet. Paste one, or install Comet from a link that still has your key in it.";
  return `<section class="section"><div class="section-head"><h2>Real-Debrid on iPhone</h2></div>
    <p class="note">Safari can't play the MKV files Real-Debrid hands out, so those sources stay black, spin, or show the add-on's error clip. Kumo asks Real-Debrid for an HLS stream instead. Their API blocks websites, so this needs a proxy address you run. The episode still streams straight from Real-Debrid, not through the proxy.</p>
    <p class="note">${who}</p>
    <form class="field" id="rdForm">
      <input id="rdToken" type="password" autocomplete="off" placeholder="${saved ? "Token saved — paste a new one to replace" : "Real-Debrid API token"}">
      <input id="rdProxy" type="url" inputmode="url" placeholder="https://your-name.workers.dev" value="${esc(rdSettings.proxy || "")}">
      <button class="btn">Save</button>
    </form>
    ${saved ? `<button class="btn ghost small" id="rdClear" type="button">Forget pasted token</button>` : ""}
    <p class="note">Deploy <code>rd-proxy/worker.js</code> with <code>npx wrangler deploy</code> and paste the address above. Redeploy it when that file changes. The token stays in this browser. Public ElfHosted Comet locks each link to this phone, so Safari cannot read the file id (Real-Debrid's download hosts send no CORS headers). Those sources open in Infuse, VLC, or Outplayer. In-app HLS needs a private or self-hosted Comet, or AIOStreams, whose links are not IP-bound — or an add-on such as Torrentio — plus this proxy. Kumo does not call addMagnet for these files.</p>
  </section>`;
}
function proxyBase() {
  let proxy = rdProxy();
  if (!proxy) return "";
  if (!/^https?:\/\//i.test(proxy)) proxy = "https://" + proxy;
  return proxy.replace(/\/+$/, "").replace(/[?#].*$/, "");
}
function rdEndpoint(target) {
  const base = proxyBase();
  return base ? base + "?url=" + encodeURIComponent(target) : target;
}
async function resolveViaComet(playbackUrl) {
  const base = proxyBase();
  if (!base) return null;
  try {
    const r = await fetch(base + "/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: playbackUrl }),
      credentials: "omit",
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!body || typeof body !== "object") return { ok: false, step: "comet", status: r.status, error: "Proxy resolve HTTP " + r.status };
    if (!body.status && !r.ok) body.status = r.status;
    return body;
  } catch (e) {
    return { ok: false, step: "comet", error: e?.message || "fetch failed" };
  }
}
async function rdCall(token, step, method, path, params) {
  try { return await rdRequest(token, method, path, params); }
  catch (e) { e.step = step; throw e; }
}
async function rdRequest(token, method, path, params) {
  const target = "https://api.real-debrid.com/rest/1.0" + path;
  const proxy = rdProxy();
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  let body;
  if (params && method !== "GET") { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(params).toString(); }
  const url = rdEndpoint(target);
  try {
    const r = await fetch(url, { method, headers, body, credentials: "omit" });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) { const e = new Error(json?.error || "Real-Debrid HTTP " + r.status); e.status = r.status; e.code = json?.error_code; throw e; }
    return json;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error(e?.message || "fetch failed");
    if (proxy) err.proxy = true; else err.cors = true;
    err.cause = e;
    throw err;
  }
}
async function clientIp() {
  if (clientIpCache) return clientIpCache;
  for (const u of ["https://api64.ipify.org?format=json", "https://api.ipify.org?format=json"]) {
    try { const j = await (await fetch(u, { credentials: "omit" })).json(); if (j.ip) return clientIpCache = j.ip; } catch {}
  }
  return "";
}
// Follow Comet in this browser. The stream list was fetched from this IP, so
// public ElfHosted will not return the wrong-IP slate to this call. The final
// Real-Debrid download host sends no ACAO, so a real file rejects the fetch
// and response.url stays hidden. no-cors cannot reveal it either.
async function resolveOnPhone(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const once = async (method, mode, headers) => {
    const r = await fetch(url, { method, redirect: "follow", mode, headers, credentials: "omit", signal: ctrl.signal });
    let size = 0, complete = false, contentType = "";
    if (r.type !== "opaque" && r.type !== "opaqueredirect") {
      contentType = r.headers.get("content-type") || "";
      const total = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      size = total ? +total[1] : (r.status === 200 ? +(r.headers.get("content-length") || 0) : 0);
      complete = size > 0 && (!!total || r.status === 200);
    }
    try { await r.body?.cancel(); } catch {}
    return { requestUrl: url, url: r.url || "", status: r.status, type: r.type, contentType, size, complete, opaque: r.type === "opaque" || r.type === "opaqueredirect" };
  };
  try {
    try { return await once("GET", "cors", { Range: "bytes=0-0" }); }
    catch (corsError) {
      try { return await once("HEAD", "cors"); }
      catch {
        try {
          const opaque = await once("GET", "no-cors");
          return { ...opaque, opaque: true, unreadable: true, error: corsError?.message || "" };
        } catch (e) {
          return { requestUrl: url, unreadable: true, opaque: true, error: corsError?.message || e?.message || "fetch failed" };
        }
      }
    }
  } finally { clearTimeout(timer); }
}
async function probeStream(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-2047" }, redirect: "manual", credentials: "omit", signal: ctrl.signal });
    if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) return { kind: "redirect", status: r.status };
    const contentType = r.headers.get("content-type") || "";
    const total = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
    const size = total ? +total[1] : (r.status === 200 ? +(r.headers.get("content-length") || 0) : 0);
    if (!r.ok && r.status !== 206) return { kind: "http", status: r.status, contentType, size, complete: false };
    return { kind: "file", contentType, size, complete: size > 0 && (!!total || r.status === 200), status: r.status };
  } catch { return null; }
  finally { clearTimeout(t); }
}
function stepOf(path) {
  if (path.startsWith("/torrents/addMagnet")) return "addMagnet";
  if (path.startsWith("/torrents/selectFiles")) return "selectFiles";
  if (path.startsWith("/torrents/info")) return "info";
  if (path.startsWith("/unrestrict/")) return "unrestrict";
  if (path.startsWith("/streaming/transcode")) return "transcode";
  return "rd";
}
async function playResolvedId(token, plan, safari) {
  const ids = [plan.id];
  let last = null;
  const transcode = async id => {
    const body = await rdCall(token, "transcode", "GET", "/streaming/transcode/" + encodeURIComponent(id));
    return KumoPlayback.pickTranscode(body, safari);
  };
  try {
    const picked = await transcode(plan.id);
    if (picked) return { ok: true, url: picked.url, type: picked.type };
  } catch (e) { last = KumoPlayback.failRd(e); }
  if (plan.download) {
    try {
      const un = await rdCall(token, "unrestrict", "POST", "/unrestrict/link", { link: plan.download });
      const again = [un?.id, KumoPlayback.idFromDownload(un?.download)].filter((v, i, a) => v && a.indexOf(v) === i && !ids.includes(v));
      for (const id of again) {
        try {
          const picked = await transcode(id);
          if (picked) return { ok: true, url: picked.url, type: picked.type };
        } catch (e) { last = KumoPlayback.failRd(e); }
      }
    } catch (e) { last = KumoPlayback.failRd(e); }
  }
  return { ok: false, block: last || { kind: "unsupported", step: "transcode", message: "Real-Debrid didn't return a playable stream for Comet's file." } };
}
function streamContext(s, info) {
  const parts = KumoPlayback.playbackParts(s.url) || {};
  return { hash: KumoPlayback.hashOf(s) || parts.hash, fileIndex: parts.fileIndex, season: parts.season, episode: parts.episode || info?.ep || null };
}
function mkvHelp(hasToken) {
  return hasToken
    ? "iPhone Safari can't play the original file (it's an MKV), so the picture stays black. Kumo can request an HLS stream from Real-Debrid, but their API blocks websites. Add a proxy URL on the Add-ons page. Or open this source in VLC or Infuse."
    : "iPhone Safari can't play this MKV, so the picture stays black. On the Add-ons page, paste a Real-Debrid token and a proxy URL and Kumo will request an HLS stream instead. Or open this source in VLC or Infuse.";
}
async function prepareStream(s, info) {
  const P = KumoPlayback, safari = isSafariPlayer(), container = P.containerOf(s);
  if (s.ytId) return { youtube: true };
  if (s.externalUrl && !s.url) return { external: s.externalUrl };
  const debrid = P.isDebridStream(s) || P.isDirectDebridFile(s.url);
  if (!debrid) {
    if (container && !P.browserCanPlay(container, safari)) return { skip: true, kind: "unsupported", message: mkvHelp(false), externalUrl: s.url };
    return { url: s.url, type: P.sourceType(s.url) };
  }
  const ctx = streamContext(s, info);
  const auth = rdToken();
  const proxy = rdProxy();
  const directOk = container ? P.browserCanPlay(container, safari) : !safari;
  const giveUp = (block) => {
    const explained = P.explainFailure({ hash: ctx.hash, token: !!auth, proxy: !!proxy, block });
    return { skip: true, kind: explained.kind, message: explained.message, detail: explained.detail, externalUrl: s.url };
  };
  const outside = (block) => {
    const explained = P.explainFailure({ hash: ctx.hash, token: !!auth, proxy: !!proxy, block: block || { kind: "external", step: "phone", message: P.externalOnlyMessage } });
    return { skip: true, openExternal: !P.isUncachedStream(s), kind: explained.kind, message: explained.message, detail: explained.detail, externalUrl: s.url };
  };
  // The phone can see Comet's error clip when the response stays on a host
  // that sends CORS. A hop to Real-Debrid's download host does not.
  if (P.isDebridResolver(s.url)) {
    const klass = P.classifyProbe(await probeStream(s.url), s);
    if (klass === "status") return giveUp({ kind: "status", step: "comet", message: "Comet's link is blocked by Real-Debrid (copyright filter)." });
  }
  const cacheKey = [ctx.hash || s.url, ctx.fileIndex, ctx.season, ctx.episode, safari ? 1 : 0].join(":");
  const remember = (url, type) => { const prepared = { url, type, debrid: true }; rdPlayCache.set(cacheKey, prepared); return prepared; };
  const playPlan = async plan => {
    if (!auth || !proxy) return null;
    const played = await playResolvedId(auth.token, plan, safari);
    if (played.ok) return remember(played.url, played.type);
    return giveUp(played.block);
  };
  const direct = P.rdDownload(s.url);
  if (direct) {
    const played = await playPlan(direct);
    if (played?.url) return played;
    if (played && ["infringing", "status", "auth", "rate"].includes(played.kind)) return played;
    if (directOk) {
      const type = P.sourceType(s.url) || (container === "mp4" || container === "m4v" ? "video/mp4" : container === "webm" ? "video/webm" : container === "m3u8" ? "application/vnd.apple.mpegurl" : undefined);
      return { url: s.url, type, debrid: true };
    }
    return outside();
  }
  if (P.isDebridResolver(s.url)) {
    const phone = P.classifyPhoneFetch(await resolveOnPhone(s.url));
    if (phone.action === "blocked") return giveUp(phone);
    if (phone.action === "slate" || phone.action === "wrong-ip") return giveUp(phone);
    if (phone.action === "transcode") {
      const played = await playPlan(phone);
      if (played?.url) return played;
      if (played && ["infringing", "status", "auth", "rate"].includes(played.kind)) return played;
    }
    if (phone.action === "play") return { url: phone.url, type: phone.type, debrid: true, checkStatus: true };
    // Private / self-hosted Comet is not IP-bound, so the worker can still
    // read the download id. Public ElfHosted returns a wrong-IP slate here.
    if (proxy) {
      const plan = P.nextFromCometResolve(await resolveViaComet(s.url));
      if (plan.action === "blocked" || plan.action === "slate" || plan.action === "wrong-ip") {
        if (plan.action === "wrong-ip") return outside();
        return giveUp(plan);
      }
      if (plan.action === "transcode") {
        const played = await playPlan(plan);
        if (played?.url) return played;
        if (played && ["infringing", "status", "auth", "rate"].includes(played.kind)) return played;
      }
    }
    return outside();
  }
  if (!directOk) return outside();
  const type = P.sourceType(s.url) || (container === "mp4" || container === "m4v" ? "video/mp4" : container === "webm" ? "video/webm" : container === "m3u8" ? "application/vnd.apple.mpegurl" : undefined);
  return { url: s.url, type, debrid: true, checkStatus: false };
}

function failureHtml(attempts, lastExternal) {
  const kinds = attempts.map(a => a.kind).filter(Boolean);
  const blocked = kinds.length && kinds.every(k => k === "status" || k === "infringing");
  let title = "This source won't play", body = attempts.find(a => a.message)?.message || "None of the sources started.";
  if (blocked) {
    title = "Real-Debrid blocked these files";
    body = "The add-on sent its own error clip instead of the episode, usually because Real-Debrid's copyright filter refused the file. Try another add-on.";
  } else if (kinds.includes("wrong-ip")) {
    title = "Opened on a different connection";
    body = "Comet tied this link to another connection. It is not blocked. Load the episode on this phone, then open it in Infuse or VLC.";
  } else if (kinds.includes("slate")) title = "That link isn't a video";
  else if (kinds.includes("external")) {
    title = "Open in another app";
    body = KumoPlayback.externalOnlyMessage;
  } else if (kinds.includes("refused")) title = "Real-Debrid refused the request";
  else if (kinds.includes("proxy")) title = "Real-Debrid proxy failed";
  else if (kinds.includes("hash")) title = "Couldn't read this source";
  else if (kinds.includes("auth") || kinds.includes("token")) title = "Real-Debrid token was refused";
  else if (kinds.includes("uncached") && !kinds.some(k => k === "cors" || k === "unsupported")) title = "Not cached on Real-Debrid";
  else if (kinds.some(k => k === "cors" || k === "unsupported")) title = "Safari can't play this file";
  const detail = [...attempts].reverse().map(a => a.detail).find(Boolean);
  const diag = detail ? `<p class="diag">${esc(detail)}</p>` : "";
  let ext = "";
  if (lastExternal && !blocked) {
    const players = KumoPlayback.externalPlayers(lastExternal);
    const chosen = prefs.externalPlayer || "infuse";
    const ordered = [...players.filter(p => p.id === chosen), ...players.filter(p => p.id !== chosen)];
    ext = `<div class="ext">${ordered.map(p => `<button class="btn ${p.id === chosen ? "primary" : "ghost"}" type="button" data-ext="${esc(p.href)}">${esc(p.name)}</button>`).join("")}<button class="btn ghost" type="button" id="copyStream" data-url="${esc(lastExternal)}">Copy link</button></div>`;
  }
  return `<div class="err"><b>${esc(title)}</b><p>${esc(body)}</p>${diag}${ext}</div>`;
}
function showStageMessage(mount, info, html) {
  teardown();
  let holder;
  if (mount) {
    mount.classList.add("playing");
    mount.querySelector(".pv-holder")?.remove();
    mount.insertAdjacentHTML("beforeend", `<div class="pv-holder">${html}</div>`);
    holder = mount.querySelector(".pv-holder");
  } else {
    openShell(info?.label || "");
    $("#playerStage").innerHTML = html;
    holder = $("#playerStage");
  }
  holder.querySelectorAll("[data-ext]").forEach(b => b.onclick = () => { location.href = b.dataset.ext; });
  const copy = holder.querySelector("#copyStream");
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(copy.dataset.url); toast("Link copied. Paste it into VLC if the app didn't open."); }
    catch { toast("Couldn't copy the link."); }
  };
}
function highlightSource(index) {
  const rows = page.rows || [];
  const key = rows[index] ? (rows[index].key || streamKey(rows[index])) : "";
  page.playingKey = key;
  app.querySelectorAll(".wt-src").forEach(b => b.classList.toggle("on", (key && b.dataset.key === key) || (!key && +b.dataset.i === index)));
}
// explicit: play that row only and leave it highlighted.
// otherwise: one forward pass, each source at most once, and a later tap cancels it.
async function playFromList(rows, startIndex, info, mount, opts) {
  const gen = ++playGen;
  const explicit = !!opts?.explicit;
  const order = KumoPlayback.playbackOrder(rows, explicit ? startIndex : null, { safari: isSafariPlayer(), explicit, skipUncached: !explicit });
  const attempts = [];
  const seen = new Set();
  let lastExternal = "";
  let externalCandidate = "";
  if (explicit && mount) highlightSource(startIndex);
  const noteVerdict = (url, kind) => { if (url && kind) rememberVerdict(url, kind); };
  for (let n = 0; n < order.length; n++) {
    if (gen !== playGen) return;
    const row = order[n];
    if (seen.has(row.i)) continue;
    seen.add(row.i);
    if (!explicit && mount) highlightSource(row.i);
    if ($("#wtStatus")) $("#wtStatus").textContent = attempts.length ? "That source didn't play. Trying another…" : (KumoPlayback.isDebridStream(row.s) ? "Opening a browser-friendly stream…" : "");
    const prepared = await prepareStream(row.s, info);
    if (gen !== playGen) return;
    if (prepared.external) { window.open(prepared.external, "_blank", "noopener"); return; }
    if (prepared.externalUrl) lastExternal = prepared.externalUrl;
    if (prepared.skip) {
      const hard = prepared.kind === "status" || prepared.kind === "infringing" || prepared.kind === "blocked";
      if (hard) noteVerdict(row.s.url, "blocked");
      else if (prepared.kind === "slate") noteVerdict(row.s.url, "slate");
      else if (prepared.kind === "wrong-ip") noteVerdict(row.s.url, "wrong-ip");
      else if (prepared.openExternal && row.s.url) {
        noteVerdict(row.s.url, "external");
        if (explicit) { handoffExternal(mount, info, row.s.url); return; }
        if (!externalCandidate) externalCandidate = row.s.url;
      }
      attempts.push(prepared);
      if (explicit) break;
      continue;
    }
    const result = await play(row.s, info, row.a?.key, mount, prepared);
    if (gen !== playGen) return;
    if (result.status === "ok") {
      if (row.s.url) noteVerdict(row.s.url, "play");
      if (mount) highlightSource(row.i);
      if ($("#wtStatus")) $("#wtStatus").textContent = "";
      return;
    }
    teardown();
    const cachedFail = result.reason !== "status" && KumoPlayback.isCachedStream(row.s) && row.s.url;
    if (result.reason === "status") noteVerdict(row.s.url, "blocked");
    else if (cachedFail) noteVerdict(row.s.url, "external");
    else noteVerdict(row.s.url, "fail");
    attempts.push({ kind: result.reason, message: result.reason === "status" ? "Real-Debrid blocked that file, so the add-on sent an error clip instead of the episode." : "That source didn't start.", detail: result.detail, externalUrl: row.s.url });
    if (row.s.url) lastExternal = row.s.url;
    if (cachedFail) {
      if (explicit) { handoffExternal(mount, info, row.s.url); return; }
      if (!externalCandidate) externalCandidate = row.s.url;
    }
    if (explicit) break;
    if ($("#wtStatus")) $("#wtStatus").textContent = "That source didn't play. Trying another…";
  }
  if (gen !== playGen) return;
  const onlyBlocked = attempts.length && attempts.every(a => a.kind === "status" || a.kind === "infringing" || a.kind === "blocked" || a.kind === "slate");
  if (externalCandidate && !onlyBlocked) { handoffExternal(mount, info, externalCandidate); return; }
  if ($("#wtStatus")) $("#wtStatus").textContent = "";
  showStageMessage(mount, info, failureHtml(attempts, lastExternal));
}

// mount: an element on the page to play inside (the watch page); otherwise the full-screen overlay.
// Resolves {status:"ok"} once a real duration is known, or {status:"fail"} on error,
// stall, or a debrid error clip. The caller tries the next source.
function play(s, info, addonKey, mount, prepared) {
  if (s.externalUrl && !s.url && !s.ytId && !prepared?.url) { window.open(s.externalUrl, "_blank", "noopener"); return Promise.resolve({ status: "ok" }); }
  const srcUrl = String(prepared?.url || s.url || "");
  const needsHls = !nativeHls && (prepared?.type === "application/vnd.apple.mpegurl" || /\.m3u8(\?|$)/i.test(srcUrl));
  return Promise.all([ensurePlayerAssets(), needsHls ? ensureHls() : Promise.resolve()]).then(() => new Promise(resolve => {
    let settled = false, stallTimer = null, outcome = "";
    const finish = (status, reason) => { if (settled) return; settled = true; outcome = status; clearTimeout(stallTimer); resolve({ status, reason }); };
    teardown();
    if (!mount) openShell(info.label);
    current = { info, addonKey, mount };
    let stage = $("#playerStage");
    if (mount) { mount.classList.add("playing"); mount.querySelector(".pv-holder")?.remove(); mount.insertAdjacentHTML("beforeend", `<div class="pv-holder"></div>`); stage = mount.querySelector(".pv-holder"); }
    const youtube = s.ytId && !prepared?.url;
    const src = youtube ? `youtube/${s.ytId}` : (prepared?.url || s.url);
    if (!src) {
      stage.innerHTML = `<div class="err">${s.infoHash ? "This source is a torrent, which web browsers can't play. Pick a different source." : "This source has no playable link."}</div>`;
      finish("fail", "none");
      return;
    }
    const type = youtube ? undefined : (prepared?.type || KumoPlayback.sourceType(src));
    stage.innerHTML = `
    <media-player class="kumo-player" id="vs" title="${esc(info.label)}" playsinline autoplay keep-alive>
      <media-provider></media-provider>
      <media-video-layout></media-video-layout>
      <div class="pv-pills">
        <button class="pv-pill" id="pvIntro" hidden>Skip intro »</button>
        <button class="pv-pill solid" id="pvNext" hidden>${info.next ? esc(info.next.short) + " ▶" : ""}</button>
      </div>
      <div class="pv-count" id="pvCount" hidden></div>
    </media-player>`;
    const vs = $("#vs");
    vs.addEventListener("provider-change", e => { if (e.detail?.type === "hls" && window.Hls && !nativeHls) e.detail.library = window.Hls; });
    vs.src = type ? { src, type } : src;
    const consider = () => {
      const d = vs.duration;
      if (!d || !isFinite(d)) return;
      if (prepared?.checkStatus && d < 40) { finish("fail", "status"); return; }
      stage.querySelector(".err")?.remove();
      finish("ok");
    };
    stallTimer = setTimeout(() => finish("fail", "stall"), prepared?.debrid ? 28000 : 15000);
    vs.addEventListener("loaded-metadata", consider);
    vs.addEventListener("duration-change", consider);
    vs.addEventListener("can-play", consider);
    vs.addEventListener("error", () => finish("fail", "error"));
    if (youtube) { finish("ok"); return; }

  // resume, speed and progress
  vs.addEventListener("can-play", () => {
    vs.playbackRate = prefs.speed;
    const prev = progress[info.key];
    if (prev?.t && prev.d && prev.t / prev.d < 0.92) vs.currentTime = prev.t;
  }, { once: true });
  vs.addEventListener("rate-change", () => { if (vs.playbackRate && vs.playbackRate !== prefs.speed) { prefs.speed = vs.playbackRate; store.set("playerPrefs", prefs); } });
  const record = () => { if (vs.duration) saveProgress(info.key, { t: vs.currentTime, d: vs.duration, route: info.route, title: info.title, poster: info.poster, label: info.short }); };
  saveTimer = setInterval(record, 5000);
  vs.addEventListener("pause", record);
  current.record = record;

  // Skip intro (85 s, a typical anime opening) and Next episode
  let introUsed = false;
  const skip = d => { vs.currentTime = Math.min(Math.max(0, vs.currentTime + d), (vs.duration || 1e9) - 0.5); };
  vs.addEventListener("time-update", () => {
    const d = vs.duration || 0, t = vs.currentTime;
    const inIntro = !introUsed && d > 600 && t > 3 && t < 180;
    if (inIntro && prefs.autoSkip) { introUsed = true; skip(85); }
    $("#pvIntro").hidden = !inIntro || prefs.autoSkip;
    $("#pvNext").hidden = !(info.next && d && d - t < 120);
  });
  $("#pvIntro").onclick = () => { introUsed = true; skip(85); };
  $("#pvNext").onclick = () => goNext();
  vs.addEventListener("ended", () => {
    record();
    if (outcome === "fail") return;
    if (prepared?.checkStatus && vs.duration && vs.duration < 40) return;
    if (!info.next || !prefs.autoNext) return;
    let n = 5;
    const box = $("#pvCount");
    const draw = () => box.innerHTML = `<div>${esc(info.next.short)} in <b>${n}</b></div><div class="pv-count-btns"><button class="pv-pill solid" id="pvNow">Play now</button><button class="pv-pill" id="pvCancel">Cancel</button></div>`;
    draw(); box.hidden = false;
    countTimer = setInterval(() => { n--; if (n <= 0) { clearInterval(countTimer); goNext(); } else draw(); }, 1000);
    box.onclick = e => { if (e.target.id === "pvNow") { clearInterval(countTimer); goNext(); } if (e.target.id === "pvCancel") { clearInterval(countTimer); box.hidden = true; } };
  });

  // Subtitles from the stream and from subtitle add-ons; turn on the last language picked
  const addSubs = list => {
    list.slice(0, 30).forEach((x, i) => {
      const fmt = /\.vtt(\?|$)/i.test(x.url) ? "vtt" : /\.ass|\.ssa/i.test(x.url) ? "ass" : "srt";
      vs.textTracks.add({ id: `kumo-${i}`, src: x.url, kind: "subtitles", label: `${LANGS[x.lang] || x.lang || "Subtitles"}${x.from && x.from !== "stream" ? " · " + x.from : ""}`, language: (x.lang || "und").slice(0, 3), type: fmt });
    });
    if (prefs.subLang && prefs.subLang !== "off") {
      const want = LANGS[prefs.subLang] || prefs.subLang;
      const t = [...vs.textTracks].find(t => t.language === prefs.subLang || (LANGS[t.language] || t.language) === want);
      if (t) t.mode = "showing";
    }
  };
  vs.addEventListener("text-track-change", e => { const t = e.detail; prefs.subLang = t ? t.language : "off"; store.set("playerPrefs", prefs); });
  customElements.whenDefined("media-player").then(() => gatherSubs(s, info)).then(addSubs).catch(() => {});

  current.keys = e => { if (e.key === "n" && info.next && !e.target.closest("input, select, textarea")) goNext(); };
  })).catch(() => ({ status: "fail", reason: "assets" }));
}

// Play the next episode with a source from the same add-on if possible, else the best playable one
async function goNext() {
  const c = current; if (!c?.info.next) return;
  const next = c.info.next;
  if (c.mount && next.watch) { cancelPlayback(); teardown(); current = null; autoStartOnce = true; goHash(next.watch); return; }
  const gen = ++playGen;
  teardown();
  openShell(`Loading ${next.short}…`);
  $("#playerStage").innerHTML = `<div class="pv-spin"></div>`;
  try {
    const { results, info } = await next.get();
    if (gen !== playGen) return;
    const rows = [];
    for (const r of results) for (const st of r.streams || []) rows.push({ a: r.a, s: st, audio: audioOf(st) });
    const same = rows.filter(r => r.a.key === c.addonKey);
    const pool = same.some(r => playable(r.s)) ? same : rows;
    if (pool.some(r => playable(r.s))) return playFromList(pool, null, info);
  } catch {}
  if (gen !== playGen) return;
  closePlayer();
  goHash(next.page);
  toast(`Pick a source for ${next.short}`);
}
function closePlayer() {
  teardown();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("#player").hidden = true;
  $("#player").style.display = "none";
  document.body.style.overflow = "";
  current = null;
  route();
}
$("#playerClose").onclick = closePlayer;
window.addEventListener("unhandledrejection", e => {
  const reason = e.reason;
  const name = reason && reason.name;
  const msg = String((reason && reason.message) || reason || "");
  if (name === "AbortError" || /aborted without reason|play\(\) request was interrupted/i.test(msg)) e.preventDefault();
});
document.addEventListener("keydown", e => {
  if (!$("#player").hidden && e.key === "Escape") return closePlayer();
  if (!$("#player").hidden || current?.mount) current?.keys?.(e);
});

// ---------- new-episode notifications ----------
// A notification exists only after an episode of a show you're watching has
// aired. Future air dates stay on the poster. Watching the episode (past the
// same 92% the rest of the app calls "seen") removes it, and it is not created
// again. The badge is the number of rows in the list.
let noteState = { items: [], dismissed: [] };
let notesError = false;
let notesGen = 0;
let nextAir = store.get("nextAir", {});
let swReload = false;

function noteContext() {
  const watchingIds = new Set();
  const addedAt = {};
  for (const [route, item] of Object.entries(watchlist)) {
    const id = Number((route.match(/^#\/a\/(\d+)$/) || [])[1]);
    if (!id) continue;
    watchingIds.add(id);
    if (item?.added) addedAt[id] = Math.floor(item.added / 1000);
  }
  return { watchingIds, addedAt, progress, nowSec: Math.floor(Date.now() / 1000) };
}
function persistNotes(next) {
  noteState = next;
  store.set("notes", noteState);
  renderBell();
}
function dismissIfWatched(key) {
  if (!KumoNotify.isWatched(progress[key])) return;
  const m = /^#\/a\/(\d+):(\d+)$/.exec(key || "");
  if (!m) return;
  persistNotes(KumoNotify.dismissEpisode(noteState, Number(m[1]), Number(m[2]), Math.floor(Date.now() / 1000)));
}
function pruneNextAir() {
  const now = Date.now() / 1000;
  let changed = false;
  for (const [id, v] of Object.entries(nextAir)) {
    if (!v || !v.episode || !(Number(v.airingAt) > now)) { delete nextAir[id]; changed = true; }
  }
  if (changed) store.set("nextAir", nextAir);
}
function airForId(id) {
  if (!id) return "";
  const v = nextAir[id] || nextAir[String(id)];
  return v ? KumoNotify.airLabel(v.episode, v.airingAt, Date.now()) : "";
}
function rememberMediaAir(list) {
  const now = Date.now() / 1000;
  let changed = false;
  for (const m of list || []) {
    if (!m || m.id == null) continue;
    const ne = m.nextAiringEpisode;
    const key = String(m.id);
    if (ne?.episode && Number(ne.airingAt) > now) {
      const prev = nextAir[key];
      if (!prev || prev.episode !== ne.episode || prev.airingAt !== ne.airingAt) {
        nextAir[key] = { episode: ne.episode, airingAt: ne.airingAt };
        changed = true;
      }
    } else if (nextAir[key]) {
      delete nextAir[key];
      changed = true;
    }
  }
  if (changed) store.set("nextAir", nextAir);
  syncAirPills();
}
function eachView(fn) {
  fn(document);
  for (const entry of viewNodes.values()) if (entry?.el) fn(entry.el);
}
function syncAirPills() {
  eachView(root => root.querySelectorAll("[data-air-for]").forEach(cover => {
    const label = airForId(cover.dataset.airFor);
    let pill = cover.querySelector(".air-pill");
    if (!label) { if (pill) pill.remove(); return; }
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "air-pill";
      cover.appendChild(pill);
    }
    if (pill.textContent !== label) pill.textContent = label;
  }));
}
function paintQuick(route) {
  const on = !!watchlist[route];
  eachView(root => {
    root.querySelectorAll(".quick-add").forEach(btn => {
      if (btn.dataset.quick !== route) return;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const name = btn.dataset.title || "this show";
      btn.setAttribute("aria-label", on ? `Remove ${name} from Watching` : `Add ${name} to Watching`);
      const mark = btn.querySelector("span");
      if (mark) mark.textContent = on ? "✓" : "+";
    });
    root.querySelectorAll("[data-watch]").forEach(btn => {
      if (btn.dataset.watch !== route) return;
      btn.textContent = on ? "✓ Watching" : "+ Watching";
    });
  });
}
const NOTES_QUERY = `query($ids:[Int],$from:Int,$to:Int,$page:Int){
  aired:Page(page:$page,perPage:50){pageInfo{hasNextPage}airingSchedules(mediaId_in:$ids,airingAt_greater:$from,airingAt_lesser:$to,sort:TIME_DESC){episode airingAt media{id title{romaji english} coverImage{large}}}}
  next:Page(perPage:50){media(id_in:$ids){id title{romaji english} coverImage{large} nextAiringEpisode{episode airingAt}}}}`;
async function loadNotes() {
  const gen = ++notesGen;
  const ctx = noteContext();
  persistNotes(KumoNotify.cleanNotes(noteState, ctx));
  const ids = [...ctx.watchingIds];
  if (!ids.length) { notesError = false; renderBell(); return; }
  const from = ctx.nowSec - 14 * 86400;
  const bucket = Math.floor(ctx.nowSec / (TTL.notes / 1000));
  try {
    const schedules = [];
    const medias = [];
    for (let i = 0; i < ids.length; i += 40) {
      const slice = ids.slice(i, i + 40);
      const idKey = slice.slice().sort((a, b) => a - b).join(",");
      for (let page = 1; page <= 3; page++) {
        const d = await anilist(NOTES_QUERY, { ids: slice, from, to: ctx.nowSec, page }, {
          key: "notes:" + idKey + ":" + bucket + ":" + page,
          ttl: TTL.notes,
          staleFactor: 6,
        });
        if (gen !== notesGen) return;
        schedules.push(...(d?.aired?.airingSchedules || []));
        if (page === 1) medias.push(...(d?.next?.media || []));
        if (!d?.aired?.pageInfo?.hasNextPage) break;
      }
    }
    if (gen !== notesGen) return;
    notesError = false;
    rememberMediaAir(medias);
    persistNotes(KumoNotify.ingestAired(noteState, schedules, noteContext()));
  } catch {
    if (gen !== notesGen) return;
    notesError = true;
    renderBell();
  }
}
function ago(t) {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderBell() {
  const unread = KumoNotify.unreadCount(noteState);
  const b = $("#bellCount");
  if (b) { b.textContent = String(unread); b.hidden = unread === 0; }
  const bell = $("#bellBtn");
  if (bell) bell.setAttribute("aria-label", unread ? `${unread} new episode${unread === 1 ? "" : "s"}` : "New episodes");
  const panel = $("#notesPanel");
  if (!panel || panel.hidden) return;
  const row = item => `<a class="note-row" href="#/watch/${item.mediaId}/${item.episode}">${item.poster ? `<img src="${esc(item.poster)}" alt="" width="36" height="54" loading="lazy" decoding="async">` : `<span class="note-ph" aria-hidden="true"></span>`}<div><b>${esc(item.title || "Episode " + item.episode)}</b><span>Episode ${item.episode} · ${ago(item.airingAt)}</span></div></a>`;
  const rows = noteState.items.map(row).join("");
  panel.innerHTML = `<div class="notes-head">New episodes</div>` +
    (!Object.keys(watchlist).length ? `<p class="notes-empty">Add a show to Watching and Kumo will tell you when a new episode airs.</p>`
      : notesError && !rows ? `<p class="notes-empty">Couldn't check for new episodes. Try again in a bit.</p>`
      : rows || `<p class="notes-empty">No new episodes. When one airs for a show you're watching, it stays here until you watch it.</p>`);
}
function toggleNotes(open) {
  const panel = $("#notesPanel");
  panel.hidden = open === undefined ? !panel.hidden : !open;
  panel.style.display = panel.hidden ? "none" : "";
  if (!panel.hidden) renderBell();
}
pruneNextAir();
noteState = KumoNotify.cleanNotes(store.get("notes", null), noteContext());
store.set("notes", noteState);
renderBell();
$("#bellBtn").onclick = e => { e.stopPropagation(); togglePanel("#acctPanel", false); toggleNotes(); };
document.addEventListener("click", e => { if (!e.target.closest("#notesPanel, #bellBtn")) toggleNotes(false); });
window.addEventListener("hashchange", () => toggleNotes(false));
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadNotes(); });
setInterval(loadNotes, 15 * 60 * 1000);
idle(loadNotes);

// ---------- accounts (Supabase) ----------
// Sign up / log in with email + password. Watching and progress are kept in one
// row per person (public.user_data, protected by row-level security).
const SUPABASE_URL = "https://xaiwuqyudxmypdairyab.supabase.co";
const SUPABASE_KEY = "sb_publishable_XH_vVGedmDfC0KTNUqpWbA_q35TWZXL"; // publishable key: safe in page code
let sb = null;
let account = null, syncTimer = null, syncState = "", recovering = false;
function initSupabase() {
  if (sb || !window.supabase || SUPABASE_KEY.startsWith("PASTE")) return;
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange((event, session) => {
    const was = account?.id;
    account = session?.user || null;
    if (/access_token|type=recovery/.test(location.hash)) history.replaceState(null, "", location.pathname + "#/");
    if (event === "PASSWORD_RECOVERY") { recovering = true; togglePanel("#acctPanel", true); }
    if (account && account.id !== was) { syncState = ""; pullAndMerge(); toast("Logged in"); }
    renderAccount();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pushNow(); else if (account) pullAndMerge(); });
  renderAccount();
}

function mergeData(remote) {
  const w = { ...(remote?.watchlist || {}) };
  for (const [r, item] of Object.entries(watchlist)) if (!w[r] || (item.added || 0) > (w[r].added || 0)) w[r] = item;
  for (const [r, t] of Object.entries(removed)) if (w[r] && (w[r].added || 0) < t) delete w[r];
  const p = { ...(remote?.progress || {}) };
  for (const [k, v] of Object.entries(progress)) if (!p[k] || (v.updated || 0) > (p[k].updated || 0)) p[k] = v;
  watchlist = w; progress = p;
  store.set("watchlist", watchlist); store.set("progress", progress);
}
async function pullAndMerge() {
  if (!sb || !account) return;
  const { data, error } = await sb.from("user_data").select("watchlist,progress").eq("user_id", account.id).maybeSingle();
  if (error) { syncState = "Couldn't sync. Check your connection."; return renderAccount(); }
  mergeData(data);
  await pushNow();
  loadNotes(); forceRoute = true; route();
}
async function pushNow() {
  if (!sb || !account) return;
  clearTimeout(syncTimer);
  const { error } = await sb.from("user_data").upsert({ user_id: account.id, watchlist, progress, updated_at: new Date().toISOString() });
  syncState = error ? "Couldn't sync. Check your connection." : "Synced " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  renderAccount();
}
function scheduleSync() { if (account) { clearTimeout(syncTimer); syncTimer = setTimeout(pushNow, 2000); } }

function renderAccount() {
  const btn = $("#acctBtn");
  btn.innerHTML = account ? `<span class="avatar">${esc((account.email || "?")[0].toUpperCase())}</span>`
    : `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.2-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.8-3.6-5-8-5Z"/></svg>`;
  btn.setAttribute("aria-label", account ? "Your account" : "Sign up or log in");
  const panel = $("#acctPanel"); if (panel.hidden) return;
  if (!sb) { panel.innerHTML = `<div class="notes-head">Account</div><p class="notes-empty">Accounts aren't switched on yet.</p>`; return; }
  if (account && recovering) {
    panel.innerHTML = `<div class="notes-head">Set a new password</div><form class="acct-body" id="pwForm">
      <label for="newPass">New password</label><input id="newPass" type="password" autocomplete="new-password" minlength="6" required>
      <button class="btn" type="submit">Save password</button><p class="acct-msg" id="pwMsg" role="status"></p></form>`;
    $("#pwForm").onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: $("#newPass").value });
      if (error) { $("#pwMsg").textContent = error.message; return; }
      recovering = false; toast("Password saved"); renderAccount();
    };
    return;
  }
  if (account) {
    panel.innerHTML = `<div class="notes-head">Account</div><div class="acct-body"><p class="acct-email">${esc(account.email)}</p>
      <p class="muted small">Your Watching list and progress sync to every device you log in on.${syncState ? "<br>" + esc(syncState) : ""}</p>
      <button class="btn ghost small" id="acctSync">Sync now</button> <button class="btn ghost small" id="acctOut">Log out</button></div>`;
    $("#acctSync").onclick = () => pullAndMerge();
    $("#acctOut").onclick = async () => { await pushNow(); await sb.auth.signOut(); toast("Logged out"); };
    return;
  }
  const mode = panel.dataset.mode || "signup";
  panel.innerHTML = `<div class="acct-tabs"><button data-mode="signup" aria-pressed="${mode === "signup"}">Create account</button><button data-mode="login" aria-pressed="${mode === "login"}">Log in</button></div>
    <form class="acct-body" id="acctForm">
      <label for="acctEmail">Email</label><input id="acctEmail" type="email" autocomplete="email" required>
      <label for="acctPass">Password</label><input id="acctPass" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" minlength="6" required>
      <button class="btn" type="submit">${mode === "signup" ? "Create account" : "Log in"}</button>
      ${mode === "login" ? `<button class="linkbtn" type="button" id="acctForgot">Forgot password?</button>` : `<p class="muted small">Syncs your Watching list and progress between devices.</p>`}
      <p class="acct-msg" id="acctMsg" role="status"></p>
    </form>`;
  panel.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { panel.dataset.mode = b.dataset.mode; renderAccount(); });
  const msg = t => { $("#acctMsg").textContent = t; };
  $("#acctForm").onsubmit = async e => {
    e.preventDefault();
    const email = $("#acctEmail").value.trim(), password = $("#acctPass").value;
    const btn = e.target.querySelector("[type=submit]"); btn.disabled = true; msg("");
    const res = mode === "signup"
      ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + "/" } })
      : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (res.error) return msg(res.error.message.includes("Invalid login") ? "That email and password don't match." : res.error.message);
    if (mode === "signup" && !res.data.session) msg(`Check ${email} for a confirmation link, then come back and log in.`);
  };
  const f = $("#acctForgot");
  if (f) f.onclick = async () => {
    const email = $("#acctEmail").value.trim();
    if (!email) return msg("Type your email above first.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
    msg(error ? error.message : `If ${email} has an account, a reset link is on its way.`);
  };
}
function togglePanel(id, open) {
  const p = $(id);
  p.hidden = open === undefined ? !p.hidden : !open;
  p.style.display = p.hidden ? "none" : "";
  return !p.hidden;
}
$("#acctBtn").onclick = e => {
  e.stopPropagation();
  toggleNotes(false);
  if (!togglePanel("#acctPanel")) return;
  if (sb) { renderAccount(); return; }
  $("#acctPanel").innerHTML = `<div class="notes-head">Account</div><p class="notes-empty">Loading…</p>`;
  ensureSupabase().then(() => { if (!$("#acctPanel").hidden) renderAccount(); }).catch(() => {
    if (!$("#acctPanel").hidden) $("#acctPanel").innerHTML = `<div class="notes-head">Account</div><p class="notes-empty">Couldn't reach the account service. Check your connection.</p>`;
  });
};
document.addEventListener("click", e => { if (!e.target.closest("#acctPanel, #acctBtn")) togglePanel("#acctPanel", false); });
window.addEventListener("hashchange", () => togglePanel("#acctPanel", false));
renderAccount();

window.addEventListener("hashchange", route);
route();
idle(() => { ensureSupabase().catch(() => {}); });
window.addEventListener("load", () => {
  // iOS will keep serving a cached sw.js for a day unless updateViaCache is
  // none, so a Home Screen icon can sit on the previous deploy. When a new
  // worker takes over and nothing is playing, reload once so this page matches it.
  if (!("serviceWorker" in navigator) || !/(^|\.)github\.io$/.test(location.hostname)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    if (!$("#player").hidden || current) { swReload = true; return; }
    location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(reg => {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});
});
