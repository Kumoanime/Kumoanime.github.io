"use strict";
// Kumo: anime browser + player. Show info comes from AniList; streams come from
// Stremio-protocol add-ons the user installs (plus two built-in legal ones).

const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stripHtml = s => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("kumo." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kumo." + k, JSON.stringify(v)); } catch {} },
};
let addons = store.get("addons", []);      // [{url, manifest, enabled}]
let repos = store.get("repos", []);        // [{url, name, entries:[{url,name,description}]}]
let watchlist = store.get("watchlist", {}); // route -> {route,title,poster,added}
let progress = store.get("progress", {});   // videoKey -> {t,d,updated,route,title,poster,label,ep}
let builtinOff = store.get("builtinOff", {});
const saveAddons = () => store.set("addons", addons);

let tt;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; t.style.display = ""; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; t.style.display = "none"; }, 2600); }

// ---------- AniList ----------
const MEDIA_FIELDS = `id idMal title{romaji english} coverImage{large color} bannerImage format status episodes
  season seasonYear averageScore genres nextAiringEpisode{episode airingAt} trailer{id site}`;
async function anilist(query, variables = {}) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error("AniList " + r.status);
  return (await r.json()).data;
}
const listCache = {};
async function anilistList(key, vars) {
  if (listCache[key]) return listCache[key];
  const d = await anilist(`query($sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus,$search:String){
    Page(perPage:30){media(type:ANIME,isAdult:false,sort:$sort,season:$season,seasonYear:$year,status:$status,search:$search){${MEDIA_FIELDS}}}}`, vars);
  return (listCache[key] = d.Page.media);
}
const titleOf = m => m.title.english || m.title.romaji;
function currentSeason() {
  const d = new Date(), mo = d.getMonth();
  return { season: ["WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER"][mo], year: mo === 11 ? d.getFullYear() + 1 : d.getFullYear() };
}

// AniList (MAL id) -> Kitsu id, which anime add-ons use for stream ids
async function kitsuId(malId) {
  if (!malId) return null;
  const cache = store.get("kitsu", {});
  if (cache[malId]) return cache[malId];
  for (const host of ["https://kitsu.app", "https://kitsu.io"]) {
    try {
      const r = await fetch(`${host}/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`, { headers: { Accept: "application/vnd.api+json" } });
      if (!r.ok) continue;
      const j = await r.json();
      const id = j.data?.[0]?.relationships?.item?.data?.id;
      if (id) { cache[malId] = id; store.set("kitsu", cache); return id; }
    } catch {}
  }
  return null;
}

// ---------- add-ons ----------
// Built-ins use the same shape as remote add-ons, with local handlers.
const BUILTINS = [
  {
    key: "builtin:trailers",
    manifest: { id: "kumo.trailers", name: "Official trailers", version: "1.0.0", description: "Plays each show's official trailer from YouTube.", resources: ["stream"], types: ["series", "movie", "anime"], idPrefixes: ["anilist"] },
    async stream(type, id, ctx) {
      const t = ctx?.media?.trailer;
      return t && t.site === "youtube" ? [{ name: "Trailer", title: "Official trailer · YouTube", ytId: t.id }] : [];
    },
  },
  {
    key: "builtin:archive",
    manifest: { id: "kumo.archive", name: "Internet Archive classics", version: "1.0.0", description: "Public-domain cartoons and animation from archive.org, free to stream.", resources: ["catalog", "meta", "stream"], types: ["movie"], idPrefixes: ["ia:"], catalogs: [{ type: "movie", id: "ia-cartoons", name: "Public-domain cartoons" }] },
    async catalog() {
      const q = encodeURIComponent("collection:(classic_cartoons) AND mediatype:(movies)");
      const r = await fetch(`https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&rows=40&sort[]=downloads+desc&output=json`);
      const j = await r.json();
      return j.response.docs.map(d => ({ id: "ia:" + d.identifier, type: "movie", name: d.title, poster: `https://archive.org/services/img/${d.identifier}`, posterShape: "landscape", releaseInfo: d.year }));
    },
    async meta(type, id) {
      const ident = id.slice(3);
      const j = await (await fetch(`https://archive.org/metadata/${ident}`)).json();
      const md = j.metadata || {};
      return { id, type: "movie", name: [].concat(md.title)[0], description: stripHtml([].concat(md.description)[0]), poster: `https://archive.org/services/img/${ident}`, releaseInfo: md.year, _files: j.files };
    },
    async stream(type, id) {
      const ident = id.slice(3);
      const j = await (await fetch(`https://archive.org/metadata/${ident}`)).json();
      return (j.files || []).filter(f => /\.mp4$/i.test(f.name)).slice(0, 4)
        .map(f => ({ name: "Archive.org", title: `${f.name}${f.size ? " · " + Math.round(f.size / 1048576) + " MB" : ""}`, url: `https://archive.org/download/${ident}/${encodeURIComponent(f.name)}` }));
    },
  },
];

function allAddons() {
  return [
    ...BUILTINS.map(b => ({ ...b, builtin: true, enabled: !builtinOff[b.key] })),
    ...addons.map(a => ({ ...a, key: a.url })),
  ];
}
function baseUrl(u) { return u.replace(/\/manifest\.json(\?.*)?$/, "").replace(/\/+$/, ""); }
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
async function call(a, resource, type, id, ctx) {
  if (a.builtin) return a[resource]?.(type, id, ctx);
  const r = await fetch(`${baseUrl(a.url)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return resource === "catalog" ? j.metas : resource === "meta" ? j.meta : j.streams;
}
async function installAddon(url, quiet) {
  url = normaliseUrl(url);
  const manifestUrl = /manifest\.json/.test(url) ? url : baseUrl(url) + "/manifest.json";
  if (addons.some(a => baseUrl(a.url) === baseUrl(manifestUrl))) { if (!quiet) toast("That add-on is already installed"); return false; }
  const r = await fetch(manifestUrl);
  if (!r.ok) throw new Error(`The link answered with error ${r.status}`);
  const manifest = await r.json();
  if (!manifest.id || !manifest.resources) throw new Error("That link isn't an add-on manifest");
  addons.push({ url: manifestUrl, manifest, enabled: true });
  saveAddons();
  if (!quiet) toast(`Installed ${manifest.name}`);
  return true;
}
// Repository: {name, addons:[url | {transportUrl|url, name, description}]} or a plain array of those
async function addRepo(url) {
  url = normaliseUrl(url);
  const r = await fetch(url);
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
function saveProgress(key, data) { progress[key] = { ...progress[key], ...data, updated: Date.now() }; store.set("progress", progress); }
function continueItems() {
  const byShow = {};
  for (const [k, p] of Object.entries(progress)) {
    if (!p.route || (p.d && p.t / p.d > 0.92)) continue;
    if (!byShow[p.route] || byShow[p.route].updated < p.updated) byShow[p.route] = { ...p, key: k };
  }
  return Object.values(byShow).sort((a, b) => b.updated - a.updated).slice(0, 15);
}

// ---------- views ----------
function card(href, title, poster, sub, extra = "") {
  return `<a class="card" href="${href}"><div class="cover">${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<div class="ph">${esc(title)}</div>`}${extra}</div>
    <div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</a>`;
}
const aniCard = m => card(`#/a/${m.id}`, titleOf(m), m.coverImage?.large, [m.seasonYear, m.format?.replace("_", " ")].filter(Boolean).join(" · "));
const skelRail = () => `<div class="rail">${Array(6).fill(`<div class="card"><div class="cover skel"></div></div>`).join("")}</div>`;
function section(title, body, note = "") { return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${note ? `<small>${esc(note)}</small>` : ""}</div>${body}</section>`; }

async function viewHome() {
  const cont = continueItems();
  const s = currentSeason();
  const rails = [
    ["trending", "Trending now", { sort: ["TRENDING_DESC"], status: "RELEASING" }],
    ["season", `${s.season[0] + s.season.slice(1).toLowerCase()} ${s.year}`, { sort: ["POPULARITY_DESC"], season: s.season, year: s.year }],
    ["top", "All-time favourites", { sort: ["SCORE_DESC"], status: "FINISHED" }],
  ];
  const catalogs = allAddons().filter(a => a.enabled && resourceSpec(a.manifest, "catalog"))
    .flatMap(a => (a.manifest.catalogs || []).filter(c => !(c.extra || []).some(e => e.isRequired) && !(c.extraRequired || []).length).slice(0, 3).map(c => ({ a, c })));
  app.innerHTML =
    (cont.length ? section("Continue watching", `<div class="rail">${cont.map(p => card(p.route, p.title, p.poster, p.label, p.d ? `<div class="bar-prog" style="width:${Math.min(100, p.t / p.d * 100)}%"></div>` : "")).join("")}</div>`) : "") +
    rails.map(([k, t]) => `<div id="rail-${k}">${section(t, skelRail())}</div>`).join("") +
    catalogs.map((x, i) => `<div id="cat-${i}">${section(x.c.name || x.c.id, skelRail(), x.a.manifest.name)}</div>`).join("") +
    (addons.length ? "" : section("Get more from Kumo", `<div class="empty"><h3>Add your first add-on</h3>Add-ons supply the episodes Kumo can play. <a href="#/addons">Open Add-ons</a> to install one by link or browse a repository.</div>`));
  rails.forEach(async ([k, t, vars]) => {
    const el = $(`#rail-${k}`); if (!el) return;
    try { const list = await anilistList(k, vars); el.innerHTML = section(t, `<div class="rail">${list.map(aniCard).join("")}</div>`); }
    catch { el.innerHTML = section(t, `<p class="note">Couldn't reach AniList for show info. Check your connection and reload.</p>`); }
  });
  catalogs.forEach(async ({ a, c }, i) => {
    const el = $(`#cat-${i}`); if (!el) return;
    try {
      const metas = (await call(a, "catalog", c.type, c.id)) || [];
      el.innerHTML = metas.length ? section(c.name || c.id, `<div class="rail">${metas.slice(0, 30).map(m => card(metaRoute(a, m.type, m.id), m.name, m.poster, m.releaseInfo)).join("")}</div>`, a.manifest.name) : "";
    } catch { el.innerHTML = section(c.name || c.id, `<p class="note">${esc(a.manifest.name)} didn't respond.</p>`, a.manifest.name); }
  });
}

async function viewSearch(q) {
  $("#q").value = q;
  app.innerHTML = section(`Results for “${q}”`, `<div class="grid">${Array(8).fill(`<div class="card"><div class="cover skel"></div></div>`).join("")}</div>`);
  try {
    const list = await anilistList("search:" + q, { search: q, sort: ["SEARCH_MATCH"] });
    app.innerHTML = section(`Results for “${q}”`, list.length ? `<div class="grid">${list.map(aniCard).join("")}</div>` : `<div class="empty"><h3>Nothing found</h3>Try the show's Japanese or English title.</div>`);
  } catch { app.innerHTML = `<div class="empty"><h3>Search isn't working</h3>Couldn't reach AniList. Check your connection and try again.</div>`; }
}

const mediaCache = {};
async function viewAnime(id, epParam) {
  app.innerHTML = `<div class="hero skel" style="height:260px"></div>`;
  let m = mediaCache[id];
  if (!m) {
    try { m = mediaCache[id] = (await anilist(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS} description(asHtml:false) studios(isMain:true){nodes{name}}}}`, { id: +id })).Media; }
    catch { app.innerHTML = `<div class="empty"><h3>Couldn't load this show</h3>AniList didn't respond. Go back and try again.</div>`; return; }
  }
  const route = `#/a/${id}`, title = titleOf(m);
  const isMovie = m.format === "MOVIE";
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : m.episodes;
  const count = isMovie ? 1 : Math.max(aired || 0, 0) || 12;
  const inList = !!watchlist[route];
  const studio = m.studios?.nodes?.[0]?.name;
  const next = m.nextAiringEpisode ? `Ep ${m.nextAiringEpisode.episode} airs ${new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : "";
  app.innerHTML = `
    <div class="hero">${m.bannerImage ? `<div class="banner" style="background-image:url('${esc(m.bannerImage)}')"></div>` : `<div class="banner"></div>`}
      <div class="hero-body"><div class="cover"><img src="${esc(m.coverImage?.large)}" alt=""></div>
        <div><h1>${esc(title)}</h1><div class="facts">${[studio, m.seasonYear, m.format?.replace("_", " "), m.averageScore ? m.averageScore + "%" : "", m.episodes ? m.episodes + " eps" : ""].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    <p class="desc">${esc(stripHtml(m.description)).replace(/\n/g, "<br>")}</p>
    <div class="actions">
      <button class="btn" id="playNext">▶ ${isMovie ? "Play" : "Play episode " + nextEpisode(route, count)}</button>
      <button class="btn ghost" id="toggleList">${inList ? "✓ In my list" : "+ My list"}</button>
    </div>
    ${isMovie ? "" : section("Episodes", `<div class="eps">${Array.from({ length: count }, (_, i) => i + 1).map(n => {
      const p = progress[`${route}:${n}`]; const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      return `<button class="ep${pct > 92 ? " seen" : ""}" data-ep="${n}">${n}${pct ? `<span class="p" style="width:${pct}%"></span>` : ""}</button>`;
    }).join("")}</div>`, next)}
    <div id="streams"></div>`;
  const ctx = { media: m, route, title, poster: m.coverImage?.large };
  $("#toggleList").onclick = () => { toggleWatch(route, title, m.coverImage?.large); viewAnime(id); };
  $("#playNext").onclick = () => loadAniStreams(ctx, isMovie ? 1 : nextEpisode(route, count), isMovie);
  app.querySelectorAll("[data-ep]").forEach(b => b.onclick = () => loadAniStreams(ctx, +b.dataset.ep, false));
  if (epParam) loadAniStreams(ctx, +epParam, isMovie);
}
function nextEpisode(route, count) {
  let last = 0;
  for (const [k, p] of Object.entries(progress)) if (k.startsWith(route + ":")) { const n = +k.split(":").pop(); if (p.d && p.t / p.d > 0.92) last = Math.max(last, n); else if (p.t > 0) last = Math.max(last, n - 1); }
  return Math.min(last + 1, count);
}

async function loadAniStreams(ctx, ep, isMovie) {
  app.querySelectorAll("[data-ep]").forEach(b => b.setAttribute("aria-current", +b.dataset.ep === ep));
  const box = $("#streams");
  box.innerHTML = `<div class="streams"><h3>${isMovie ? "Sources" : "Episode " + ep}</h3><p class="muted">Asking your add-ons…</p></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const kid = await kitsuId(ctx.media.idMal);
  const jobs = [];
  for (const a of allAddons().filter(a => a.enabled)) {
    const spec = resourceSpec(a.manifest, "stream"); if (!spec) continue;
    const types = spec.types;
    const type = isMovie ? "movie" : types.includes("anime") ? "anime" : "series";
    // Kitsu ids first: most anime add-ons use them, and add-ons without idPrefixes get the first id
    const ids = [];
    if (kid) ids.push(isMovie ? `kitsu:${kid}` : `kitsu:${kid}:${ep}`);
    if (ctx.media.idMal) ids.push(isMovie ? `mal:${ctx.media.idMal}` : `mal:${ctx.media.idMal}:${ep}`);
    ids.push(`anilist:${ctx.media.id}:${ep}`);
    const sid = ids.find(i => handles(a, "stream", i));
    if (!sid) continue;
    jobs.push(call(a, "stream", type, sid, ctx).then(s => ({ a, streams: s || [] }), () => ({ a, failed: true })));
  }
  const label = isMovie ? "Movie" : `Episode ${ep}`;
  renderStreams(box, await Promise.all(jobs), { ...ctx, key: `${ctx.route}:${ep}`, label: `${ctx.title} · ${label}`, short: label, ep });
}

function metaRoute(a, type, id) { return `#/m/${encodeURIComponent(a.key)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`; }
async function viewMeta(key, type, id) {
  const a = allAddons().find(x => x.key === key);
  if (!a) { app.innerHTML = `<div class="empty"><h3>Add-on not installed</h3>This page came from an add-on that's been removed.</div>`; return; }
  app.innerHTML = `<div class="hero skel" style="height:260px"></div>`;
  let m;
  try { m = handles(a, "meta", id) ? await call(a, "meta", type, id) : null; } catch {}
  if (!m) { app.innerHTML = `<div class="empty"><h3>Couldn't load this title</h3>${esc(a.manifest.name)} didn't send its details.</div>`; return; }
  const route = metaRoute(a, type, id);
  const videos = (m.videos || []).slice().sort((x, y) => (x.season || 0) - (y.season || 0) || (x.episode || 0) - (y.episode || 0));
  const inList = !!watchlist[route];
  app.innerHTML = `
    <div class="hero">${m.background ? `<div class="banner" style="background-image:url('${esc(m.background)}')"></div>` : `<div class="banner"></div>`}
      <div class="hero-body"><div class="cover">${m.poster ? `<img src="${esc(m.poster)}" alt="">` : ""}</div>
        <div><h1>${esc(m.name)}</h1><div class="facts">${[m.releaseInfo, (m.genres || []).slice(0, 3).join(", "), a.manifest.name].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ""}
    <div class="actions">${videos.length ? "" : `<button class="btn" id="playMain">▶ Play</button>`}<button class="btn ghost" id="toggleList">${inList ? "✓ In my list" : "+ My list"}</button></div>
    ${videos.length ? section("Episodes", `<div class="vlist">${videos.map(v => `<button class="vrow" data-vid="${esc(v.id)}">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : ""}<div><b>${esc(v.title || v.name || "Episode " + v.episode)}</b><span>${[v.season != null ? "S" + v.season : "", v.episode != null ? "E" + v.episode : ""].join(" ")}</span></div></button>`).join("")}</div>`) : ""}
    <div id="streams"></div>`;
  const ctx = { route, title: m.name, poster: m.poster };
  $("#toggleList").onclick = () => { toggleWatch(route, m.name, m.poster); viewMeta(key, type, id); };
  const load = async (vid, label) => {
    const box = $("#streams");
    box.innerHTML = `<div class="streams"><h3>${esc(label)}</h3><p class="muted">Asking your add-ons…</p></div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const results = await Promise.all(allAddons().filter(x => x.enabled && handles(x, "stream", vid))
      .map(x => call(x, "stream", type, vid, ctx).then(s => ({ a: x, streams: s || [] }), () => ({ a: x, failed: true }))));
    renderStreams(box, results, { ...ctx, key: `${route}:${vid}`, label: `${m.name}${label === m.name ? "" : " · " + label}`, short: label });
  };
  $("#playMain") && ($("#playMain").onclick = () => load(id, m.name));
  app.querySelectorAll("[data-vid]").forEach(b => b.onclick = () => { const v = videos.find(x => x.id === b.dataset.vid); load(v.id, v.title || v.name || `Episode ${v.episode}`); });
}

function renderStreams(box, results, info) {
  const rows = [];
  for (const r of results) for (const s of r.streams) rows.push({ a: r.a, s });
  const failed = results.filter(r => r.failed).map(r => r.a.manifest.name);
  const kind = s => s.ytId ? "YouTube" : s.url ? (/\.m3u8/i.test(s.url) ? "HLS" : "Video") : s.externalUrl ? "Opens site" : s.infoHash ? "Torrent" : "Unknown";
  box.innerHTML = `<div class="streams"><h3>${esc(info.short)}</h3>
    ${rows.length ? rows.map((x, i) => `<button class="stream" data-i="${i}"><div><b>${esc(x.s.name || x.a.manifest.name)}</b><span>${esc(x.s.title || x.s.description || "")}</span></div><span class="kind">${kind(x.s)}</span></button>`).join("")
      : `<p class="note">None of your add-ons have a source for this yet. ${addons.length ? "" : "Kumo's built-in add-ons only cover trailers and public-domain classics, so install more under Add-ons."}</p>`}
    ${failed.length ? `<p class="note">No answer from: ${failed.map(esc).join(", ")}.</p>` : ""}</div>`;
  box.querySelectorAll("[data-i]").forEach(b => b.onclick = () => play(rows[+b.dataset.i].s, info));
}

function toggleWatch(route, title, poster) {
  if (watchlist[route]) { delete watchlist[route]; toast("Removed from My list"); }
  else { watchlist[route] = { route, title, poster, added: Date.now() }; toast("Added to My list"); }
  store.set("watchlist", watchlist);
}

function viewList() {
  const items = Object.values(watchlist).sort((a, b) => b.added - a.added);
  const cont = continueItems();
  app.innerHTML =
    section("My list", items.length ? `<div class="grid">${items.map(w => card(w.route, w.title, w.poster, "")).join("")}</div>` : `<div class="empty"><h3>Nothing saved yet</h3>Tap <b>+ My list</b> on any show to keep it here.</div>`) +
    (cont.length ? section("Recently watched", `<div class="grid">${cont.map(p => card(p.route, p.title, p.poster, p.label)).join("")}</div>`) : "") +
    `<p class="note">Your list and progress are saved on this device.</p>`;
}

function viewAddons() {
  const all = allAddons();
  const installed = new Set(addons.map(a => baseUrl(a.url)));
  app.innerHTML = `
    <section class="section"><div class="section-head"><h2>Install an add-on</h2></div>
      <p class="note">Paste the link to a Stremio-compatible add-on (it usually ends in <code>manifest.json</code>).</p>
      <form class="field" id="addonForm"><input id="addonUrl" placeholder="https://example.com/manifest.json" inputmode="url" autocomplete="off"><button class="btn">Install</button></form>
      <div class="section-head"><h2>Add a repository</h2></div>
      <p class="note">A repository is a link to a list of add-ons. Add one to browse what's in it.</p>
      <form class="field" id="repoForm"><input id="repoUrl" placeholder="https://example.com/repo.json" inputmode="url" autocomplete="off"><button class="btn">Add</button></form>
    </section>
    ${section("Installed", all.map((a, i) => `
      <div class="addon">${a.manifest.logo ? `<img src="${esc(a.manifest.logo)}" alt="">` : `<div class="logo-ph">${esc((a.manifest.name || "?")[0])}</div>`}
        <div class="info"><b>${esc(a.manifest.name)}</b><p>${esc(a.manifest.description || "")}</p>
          <div class="tags">${a.builtin ? `<span class="tag">Built in</span>` : ""}${(a.manifest.resources || []).map(r => `<span class="tag">${esc(typeof r === "string" ? r : r.name)}</span>`).join("")}<span class="tag">v${esc(a.manifest.version)}</span></div></div>
        <div class="ctrl"><input type="checkbox" class="switch" id="sw-${i}" data-key="${esc(a.key)}" aria-label="Turn ${esc(a.manifest.name)} on or off" ${a.enabled ? "checked" : ""}>
          ${a.builtin ? "" : `<button class="btn ghost small" data-remove="${esc(a.key)}">Remove</button>`}</div>
      </div>`).join(""), `${all.filter(a => a.enabled).length} on`)}
    ${repos.map(r => section(r.name, r.entries.map(e => {
      const has = installed.has(baseUrl(normaliseUrl(e.url)));
      return `<div class="addon"><div class="logo-ph">${esc((e.name || "?")[0])}</div><div class="info"><b>${esc(e.name || e.url)}</b><p>${esc(e.description || e.url)}</p></div>
        <div class="ctrl">${has ? `<span class="tag on">Installed</span>` : `<button class="btn small" data-install="${esc(e.url)}">Install</button>`}</div></div>`;
    }).join("") + `<button class="btn ghost small" data-unrepo="${esc(r.url)}">Remove repository</button>`, "Repository")).join("")}`;

  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); viewAddons(); } catch (e) { toast(e.message.includes("fetch") ? "Couldn't reach that link. Check it's https and online." : e.message); btn.disabled = false; } };
  $("#addonForm").onsubmit = e => { e.preventDefault(); const v = $("#addonUrl").value; if (v.trim()) busy(e.submitter || e.target.querySelector("button"), () => installAddon(v)); };
  $("#repoForm").onsubmit = e => { e.preventDefault(); const v = $("#repoUrl").value; if (v.trim()) busy(e.submitter || e.target.querySelector("button"), () => addRepo(v)); };
  app.querySelectorAll("[data-install]").forEach(b => b.onclick = () => busy(b, () => installAddon(b.dataset.install)));
  app.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => { addons = addons.filter(a => a.url !== b.dataset.remove); saveAddons(); toast("Add-on removed"); viewAddons(); });
  app.querySelectorAll("[data-unrepo]").forEach(b => b.onclick = () => { repos = repos.filter(r => r.url !== b.dataset.unrepo); store.set("repos", repos); viewAddons(); });
  app.querySelectorAll(".switch").forEach(sw => sw.onchange = () => {
    const k = sw.dataset.key;
    if (k.startsWith("builtin:")) { builtinOff[k] = !sw.checked; store.set("builtinOff", builtinOff); }
    else { const a = addons.find(x => x.url === k); if (a) { a.enabled = sw.checked; saveAddons(); } }
  });
}

// ---------- player ----------
let hls = null, saveTimer = null, current = null;
function play(s, info) {
  if (s.externalUrl && !s.url && !s.ytId) { window.open(s.externalUrl, "_blank", "noopener"); return; }
  const stage = $("#playerStage");
  $("#playerTitle").textContent = info.label;
  $("#player").hidden = false;
  $("#player").style.display = "";
  document.body.style.overflow = "hidden";
  current = info;
  if (s.ytId) {
    stage.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.ytId)}?autoplay=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(info.label)}"></iframe>`;
    return;
  }
  if (!s.url) {
    stage.innerHTML = `<div class="err">${s.infoHash ? "This source is a torrent, which web browsers can't play. Pick a different source." : "This source has no playable link."}</div>`;
    return;
  }
  stage.innerHTML = `<video id="vid" controls playsinline autoplay preload="metadata"></video>`;
  const v = $("#vid");
  const isHls = /\.m3u8(\?|$)/i.test(s.url);
  if (isHls && !v.canPlayType("application/vnd.apple.mpegurl") && window.Hls?.isSupported()) { hls = new Hls(); hls.loadSource(s.url); hls.attachMedia(v); }
  else v.src = s.url;
  const prev = progress[info.key];
  v.addEventListener("loadedmetadata", () => { if (prev?.t && prev.d && prev.t / prev.d < 0.92) v.currentTime = prev.t; }, { once: true });
  v.addEventListener("error", () => { stage.insertAdjacentHTML("beforeend", `<div class="err">This source wouldn't play. Close the player and try another one.</div>`); });
  const record = () => { if (v.duration) saveProgress(info.key, { t: v.currentTime, d: v.duration, route: info.route, title: info.title, poster: info.poster, label: info.short }); };
  saveTimer = setInterval(record, 5000);
  v.addEventListener("pause", record);
  v.addEventListener("ended", record);
  current.record = record;
}
function closePlayer() {
  current?.record?.();
  clearInterval(saveTimer); hls?.destroy(); hls = null;
  $("#playerStage").innerHTML = "";
  $("#player").hidden = true;
  $("#player").style.display = "none";
  document.body.style.overflow = "";
  current = null;
  route();
}
$("#playerClose").onclick = closePlayer;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#player").hidden) closePlayer(); });

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, ...rest] = h.split("/");
  document.querySelectorAll(".tabbar a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === ({ "": "home", list: "list", addons: "addons" }[p] || "") ? "page" : "false"));
  window.scrollTo(0, 0);
  if (!p) return viewHome();
  if (p === "search") return viewSearch(decodeURIComponent(rest.join("/")));
  if (p === "a") return viewAnime(rest[0], rest[1]);
  if (p === "m") return viewMeta(decodeURIComponent(rest[0]), decodeURIComponent(rest[1]), decodeURIComponent(rest.slice(2).join("/")));
  if (p === "list") return viewList();
  if (p === "addons") return viewAddons();
  viewHome();
}
$("#searchForm").onsubmit = e => { e.preventDefault(); const q = $("#q").value.trim(); if (q) location.hash = "#/search/" + encodeURIComponent(q); };
window.addEventListener("hashchange", route);
route();
