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
let removed = store.get("removed", {});     // route -> time removed, so a sync doesn't bring it back
let progress = store.get("progress", {});   // videoKey -> {t,d,updated,route,title,poster,label,ep}
let builtinOff = store.get("builtinOff", {});
let rdSettings = store.get("rd", {}); // {token, proxy} — token is optional; never committed
const saveAddons = () => store.set("addons", addons);
const saveRd = patch => { rdSettings = { ...rdSettings, ...patch }; store.set("rd", rdSettings); };

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

// AniList id -> the ids add-ons use (Kitsu, IMDb + season, MAL, TMDB), via the ARM mapping
// service, with Kitsu's own API as a fallback for the Kitsu id. Cached per show.
async function showIds(media) {
  const cache = store.get("ids", {});
  if (cache[media.id]) return cache[media.id];
  let ids = { anilist: media.id, mal: media.idMal };
  try {
    const r = await fetch(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${media.id}`);
    if (r.ok) { const j = await r.json(); ids = { ...ids, kitsu: j.kitsu, imdb: j.imdb, imdbSeason: j["thetvdb-season"] || j["themoviedb-season"], tmdb: j.themoviedb, mal: j.myanimelist || media.idMal }; }
  } catch {}
  if (!ids.kitsu && media.idMal) {
    for (const host of ["https://kitsu.app", "https://kitsu.io"]) {
      try {
        const r = await fetch(`${host}/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${media.idMal}&include=item`, { headers: { Accept: "application/vnd.api+json" } });
        const id = r.ok && (await r.json()).data?.[0]?.relationships?.item?.data?.id;
        if (id) { ids.kitsu = id; break; }
      } catch {}
    }
  }
  if (ids.kitsu || ids.imdb) { cache[media.id] = ids; store.set("ids", cache); }
  return ids;
}

// ---------- add-ons ----------
// Built-ins use the same shape as remote add-ons, with local handlers. None ship today:
// trailers have their own button on the show page.
const BUILTINS = [];

function allAddons() {
  return [
    ...BUILTINS.map(b => ({ ...b, builtin: true, enabled: !builtinOff[b.key] })),
    ...addons.map(a => ({ ...a, key: a.url })),
  ];
}
// Canonical form of an add-on's manifest link for duplicate checks: same host, path and
// ?settings (in any order) means the same install; different settings are different installs.
function addonKey(u) {
  try {
    const x = new URL(normaliseUrl(u));
    let path = x.pathname.replace(/\/+$/, "");
    if (!/\/manifest\.json$/i.test(path)) path += "/manifest.json";
    x.searchParams.sort();
    return `${x.origin}${path.replace(/\/manifest\.json$/i, "/manifest.json")}${x.search}`;
  } catch { return u; }
}
// Build a resource URL from an add-on's manifest URL, keeping any ?query the add-on uses for its settings
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
async function call(a, resource, type, id, ctx) {
  if (a.builtin) return a[resource]?.(type, id, ctx);
  const r = await fetch(addonUrl(a.url, `${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`));
  if (!r.ok) throw Object.assign(new Error(`${a.manifest.name}: HTTP ${r.status} for ${resource}`), { status: r.status });
  const j = await r.json();
  switch (resource) {
    case "catalog": return j.metas ?? [];
    case "meta": return j.meta ?? null;
    case "subtitles": return j.subtitles ?? [];
    case "stream": return j.streams ?? [];
    default: throw new Error(`Unsupported resource: ${resource}`);
  }
}
async function installAddon(url, quiet) {
  url = normaliseUrl(url);
  const manifestUrl = /manifest\.json/i.test(url) ? url : addonUrl(url, "manifest.json");
  if (addons.some(a => addonKey(a.url) === addonKey(manifestUrl))) { if (!quiet) toast("That add-on is already installed"); return false; }
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
function saveProgress(key, data) { progress[key] = { ...progress[key], ...data, updated: Date.now() }; store.set("progress", progress); scheduleSync(); }
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
// Ratings: AniList scores are 0–100, shown out of 10; add-on metas may carry imdbRating
const ratingBadge = r => r ? `<span class="rating" aria-label="Rated ${r} out of 10">★ ${r}</span>` : "";
const aniRating = m => m.averageScore ? (m.averageScore / 10).toFixed(1) : "";
const aniCard = m => card(`#/a/${m.id}`, titleOf(m), m.coverImage?.large, [m.seasonYear, m.format?.replace("_", " ")].filter(Boolean).join(" · "), ratingBadge(aniRating(m)));
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
      el.innerHTML = metas.length ? section(c.name || c.id, `<div class="rail">${metas.slice(0, 30).map(m => card(metaRoute(a, m.type, m.id), m.name, m.poster, m.releaseInfo, ratingBadge(m.imdbRating))).join("")}</div>`, a.manifest.name) : "";
    } catch { el.innerHTML = section(c.name || c.id, `<p class="note">${esc(a.manifest.name)} didn't respond.</p>`, a.manifest.name); }
  });
}

// ---------- search + filter ----------
// One page: search bar on top, filter dropdowns under it, results below. Filters are
// kept in memory so going into a show and back keeps them.
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
async function runSearch(append) {
  const box = $("#results"); if (!box) return;
  if (!append) { searchPage = 1; searchItems = []; box.innerHTML = `<div class="grid">${Array(8).fill(`<div class="card"><div class="cover skel"></div></div>`).join("")}</div>`; }
  try {
    const d = await anilist(`query($page:Int,$search:String,$genre:[String],$season:MediaSeason,$year:Int,$format:[MediaFormat],$status:MediaStatus,$country:CountryCode,$score:Int,$source:MediaSource,$epsMin:Int,$epsMax:Int,$notIn:[Int],$sort:[MediaSort]){
      Page(page:$page,perPage:30){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,search:$search,genre_in:$genre,season:$season,seasonYear:$year,format_in:$format,status:$status,countryOfOrigin:$country,averageScore_greater:$score,source:$source,episodes_greater:$epsMin,episodes_lesser:$epsMax,id_not_in:$notIn,sort:$sort){${MEDIA_FIELDS}}}}`, filterVars());
    searchItems = searchItems.concat(d.Page.media);
    searchMore = d.Page.pageInfo.hasNextPage;
    box.innerHTML = searchItems.length
      ? `<div class="grid">${searchItems.map(aniCard).join("")}</div>${searchMore ? `<div class="more"><button class="btn ghost" id="loadMore">Load more</button></div>` : ""}`
      : `<div class="empty"><h3>Nothing matches</h3>Try fewer filters, or the show's Japanese or English title.</div>`;
    if ($("#loadMore")) $("#loadMore").onclick = e => { e.target.disabled = true; searchPage++; runSearch(true); };
  } catch { box.innerHTML = `<div class="empty"><h3>Search isn't working</h3>Couldn't reach AniList. Check your connection and try again.</div>`; }
}
function viewSearch(focus) {
  const active = Object.keys(FILTERS).filter(k => filters[k]).length;
  app.innerHTML = `
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
  const form = $("#filterForm");
  form.onsubmit = e => {
    e.preventDefault();
    filters.q = $("#q").value.trim();
    form.querySelectorAll("[data-f]").forEach(sel => filters[sel.dataset.f] = sel.value);
    $("#q").blur();
    viewSearch();
  };
  form.querySelectorAll("[data-f]").forEach(sel => sel.onchange = () => sel.classList.toggle("set", !!sel.value));
  if ($("#clearFilters")) $("#clearFilters").onclick = () => { filters = { q: filters.q }; viewSearch(); };
  if (focus) $("#q").focus();
  runSearch();
}

const mediaCache = {};
async function getMedia(id) {
  if (!mediaCache[id]) mediaCache[id] = (await anilist(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS} description(asHtml:false) studios(isMain:true){nodes{name}}}}`, { id: +id })).Media;
  return mediaCache[id];
}
function episodeCount(m) {
  if (m.format === "MOVIE") return 1;
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : m.episodes;
  return Math.max(aired || 0, 0) || 12;
}
async function viewAnime(id) {
  app.innerHTML = `<div class="hero skel" style="height:260px"></div>`;
  let m;
  try { m = await getMedia(id); }
  catch { app.innerHTML = `<div class="empty"><h3>Couldn't load this show</h3>AniList didn't respond. Go back and try again.</div>`; return; }
  const route = `#/a/${id}`, title = titleOf(m);
  const isMovie = m.format === "MOVIE";
  const count = episodeCount(m);
  const inList = !!watchlist[route];
  const studio = m.studios?.nodes?.[0]?.name;
  const next = m.nextAiringEpisode ? `Ep ${m.nextAiringEpisode.episode} airs ${new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : "";
  app.innerHTML = `
    <div class="hero">${m.bannerImage ? `<div class="banner" style="background-image:url('${esc(m.bannerImage)}')"></div>` : `<div class="banner"></div>`}
      <div class="hero-body"><div class="cover"><img src="${esc(m.coverImage?.large)}" alt=""></div>
        <div><h1>${esc(title)}</h1>${m.averageScore ? `<div class="score"><b>★ ${aniRating(m)}</b><span>/10 on AniList</span></div>` : ""}<div class="facts">${[studio, m.seasonYear, m.format?.replace("_", " "), m.episodes ? m.episodes + " eps" : ""].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    <p class="desc">${esc(stripHtml(m.description)).replace(/\n/g, "<br>")}</p>
    <div class="actions">
      <button class="btn" id="playNext">▶ ${isMovie ? "Play" : "Play episode " + nextEpisode(route, count)}</button>
      ${m.trailer?.site === "youtube" ? `<button class="btn ghost" id="playTrailer">🎬 Trailer</button>` : ""}
      <button class="btn ghost" id="toggleList">${inList ? "✓ Watching" : "+ Watching"}</button>
    </div>
    ${isMovie ? "" : section("Episodes", `<div class="eps">${Array.from({ length: count }, (_, i) => i + 1).map(n => {
      const p = progress[`${route}:${n}`]; const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      return `<button class="ep${pct > 92 ? " seen" : ""}" data-ep="${n}">${n}${pct ? `<span class="p" style="width:${pct}%"></span>` : ""}</button>`;
    }).join("")}</div>`, next)}`;
  $("#toggleList").onclick = () => { toggleWatch(route, title, m.coverImage?.large); viewAnime(id); };
  $("#playNext").onclick = () => { autoStartOnce = true; location.hash = `#/watch/${id}/${isMovie ? 1 : nextEpisode(route, count)}`; };
  if ($("#playTrailer")) $("#playTrailer").onclick = () => play({ ytId: m.trailer.id }, { label: `${title} · Trailer`, key: `${route}:trailer` });
  app.querySelectorAll("[data-ep]").forEach(b => b.onclick = () => { location.hash = `#/watch/${id}/${b.dataset.ep}`; });
}
function nextEpisode(route, count) {
  let last = 0;
  for (const [k, p] of Object.entries(progress)) if (k.startsWith(route + ":")) { const n = +k.split(":").pop(); if (p.d && p.t / p.d > 0.92) last = Math.max(last, n); else if (p.t > 0) last = Math.max(last, n - 1); }
  return Math.min(last + 1, count);
}

async function fetchAniStreams(ctx, ep, isMovie) {
  const x = await showIds(ctx.media);
  // candidate ids in the order add-ons most often expect them; each has the type to ask with
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
    // Try each id format the add-on accepts (up to 3) until one returns sources. A network
    // failure means the add-on itself is unreachable, so other ids won't help.
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
          if (!e.status) { report.push({ a, why: "didn't respond. It may be offline, or it blocks apps on other websites" }); return { a, failed: true }; }
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
  const results = await Promise.all(jobs);
  return { results, info, report };
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
        <div><h1>${esc(m.name)}</h1>${m.imdbRating ? `<div class="score"><b>★ ${esc(m.imdbRating)}</b><span>/10</span></div>` : ""}<div class="facts">${[m.releaseInfo, (m.genres || []).slice(0, 3).join(", "), a.manifest.name].filter(Boolean).map(esc).join(" · ")}</div></div></div></div>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ""}
    <div class="actions">${videos.length ? "" : `<button class="btn" id="playMain">▶ Play</button>`}<button class="btn ghost" id="toggleList">${inList ? "✓ Watching" : "+ Watching"}</button></div>
    ${videos.length ? section("Episodes", `<div class="vlist">${videos.map(v => `<button class="vrow" data-vid="${esc(v.id)}">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : ""}<div><b>${esc(v.title || v.name || "Episode " + v.episode)}</b><span>${[v.season != null ? "S" + v.season : "", v.episode != null ? "E" + v.episode : ""].join(" ")}</span></div></button>`).join("")}</div>`) : ""}
    <div id="streams"></div>`;
  const ctx = { route, title: m.name, poster: m.poster };
  $("#toggleList").onclick = () => { toggleWatch(route, m.name, m.poster); viewMeta(key, type, id); };
  const vLabel = v => v.title || v.name || `Episode ${v.episode}`;
  const fetchStreams = async i => { // i = index into videos, or -1 for a title without episodes
    const vid = i < 0 ? id : videos[i].id, label = i < 0 ? m.name : vLabel(videos[i]);
    const results = await Promise.all(allAddons().filter(x => x.enabled && handles(x, "stream", vid))
      .map(x => call(x, "stream", type, vid, ctx).then(s => ({ a: x, streams: s || [] }), () => ({ a: x, failed: true }))));
    const info = {
      ...ctx, key: `${route}:${vid}`, label: `${m.name}${label === m.name ? "" : " · " + label}`, short: label, subIds: [vid], subType: type,
      next: i >= 0 && i + 1 < videos.length ? { short: vLabel(videos[i + 1]), page: route, get: () => fetchStreams(i + 1) } : null,
    };
    return { results, info };
  };
  const load = async i => {
    const box = $("#streams");
    box.innerHTML = `<div class="streams"><h3>${esc(i < 0 ? m.name : vLabel(videos[i]))}</h3><p class="muted">Asking your add-ons…</p></div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const { results, info } = await fetchStreams(i);
    renderStreams(box, results, info);
  };
  $("#playMain") && ($("#playMain").onclick = () => load(-1));
  app.querySelectorAll("[data-vid]").forEach(b => b.onclick = () => load(videos.findIndex(x => x.id === b.dataset.vid)));
}

function renderStreams(box, results, info) {
  const rows = [];
  for (const r of results) for (const s of r.streams) rows.push({ a: r.a, s });
  const failed = results.filter(r => r.failed).map(r => r.a.manifest.name);
  const kind = s => KumoPlayback.kindLabel(s) || "Unknown";
  box.innerHTML = `<div class="streams"><h3>${esc(info.short)}</h3>
    ${rows.length ? rows.map((x, i) => `<button class="stream" data-i="${i}"><div><b>${esc(x.s.name || x.a.manifest.name)}</b><span>${esc(x.s.title || x.s.description || "")}</span></div><span class="kind">${kind(x.s)}</span></button>`).join("")
      : `<p class="note">None of your add-ons have a source for this yet. ${addons.length ? "" : "Install an add-on under Add-ons to get episode sources."}</p>`}
    ${failed.length ? `<p class="note">No answer from: ${failed.map(esc).join(", ")}.</p>` : ""}</div>`;
  box.querySelectorAll("[data-i]").forEach(b => b.onclick = () => playFromList(rows, +b.dataset.i, info, null, { explicit: true }));
}

function toggleWatch(route, title, poster) {
  if (watchlist[route]) { delete watchlist[route]; removed[route] = Date.now(); store.set("removed", removed); toast("Removed from Watching"); }
  else { watchlist[route] = { route, title, poster, added: Date.now() }; toast("Added to Watching"); }
  store.set("watchlist", watchlist);
  loadNotes();
  scheduleSync();
}

function viewList() {
  const items = Object.values(watchlist).sort((a, b) => b.added - a.added);
  const cont = continueItems();
  app.innerHTML =
    section("Watching", items.length ? `<div class="grid">${items.map(w => card(w.route, w.title, w.poster, "")).join("")}</div>` : `<div class="empty"><h3>You're not watching anything yet</h3>Tap <b>+ Watching</b> on any show to keep it here and get told when new episodes come out.</div>`) +
    (cont.length ? section("Recently watched", `<div class="grid">${cont.map(p => card(p.route, p.title, p.poster, p.label)).join("")}</div>`) : "") +
    `<p class="note">Your shows and progress are saved on this device.</p>`;
}

function viewAddons() {
  const all = allAddons();
  const installed = new Set(addons.map(a => addonKey(a.url)));
  app.innerHTML = `
    <section class="section"><div class="section-head"><h2>Install an add-on</h2></div>
      <p class="note">Paste the link to a Stremio-compatible add-on (it usually ends in <code>manifest.json</code>).</p>
      <form class="field" id="addonForm"><input id="addonUrl" placeholder="https://example.com/manifest.json" inputmode="url" autocomplete="off"><button class="btn">Install</button></form>
      <div class="section-head"><h2>Add a repository</h2></div>
      <p class="note">A repository is a link to a list of add-ons. Add one to browse what's in it.</p>
      <form class="field" id="repoForm"><input id="repoUrl" placeholder="https://example.com/repo.json" inputmode="url" autocomplete="off"><button class="btn">Add</button></form>
    </section>
    ${rdSection()}
    ${section("Installed", all.map((a, i) => `
      <div class="addon">${a.manifest.logo ? `<img src="${esc(a.manifest.logo)}" alt="">` : `<div class="logo-ph">${esc((a.manifest.name || "?")[0])}</div>`}
        <div class="info"><b>${esc(a.manifest.name)}</b><p>${esc(a.manifest.description || "")}</p>
          <div class="tags">${a.builtin ? `<span class="tag">Built in</span>` : ""}${(a.manifest.resources || []).map(r => `<span class="tag">${esc(typeof r === "string" ? r : r.name)}</span>`).join("")}<span class="tag">v${esc(a.manifest.version)}</span></div></div>
        <div class="ctrl"><input type="checkbox" class="switch" id="sw-${i}" data-key="${esc(a.key)}" aria-label="Turn ${esc(a.manifest.name)} on or off" ${a.enabled ? "checked" : ""}>
          ${a.builtin ? "" : `<button class="btn ghost small" data-remove="${esc(a.key)}">Remove</button>`}</div>
      </div>`).join(""), `${all.filter(a => a.enabled).length} on`)}
    ${repos.map(r => section(r.name, r.entries.map(e => {
      const has = installed.has(addonKey(e.url));
      return `<div class="addon"><div class="logo-ph">${esc((e.name || "?")[0])}</div><div class="info"><b>${esc(e.name || e.url)}</b><p>${esc(e.description || e.url)}</p></div>
        <div class="ctrl">${has ? `<span class="tag on">Installed</span>` : `<button class="btn small" data-install="${esc(e.url)}">Install</button>`}</div></div>`;
    }).join("") + `<button class="btn ghost small" data-unrepo="${esc(r.url)}">Remove repository</button>`, "Repository")).join("")}`;

  $("#rdForm").onsubmit = e => {
    e.preventDefault();
    const token = $("#rdToken").value.trim(), proxy = $("#rdProxy").value.trim();
    const patch = { proxy };
    if (token) patch.token = token;
    saveRd(patch);
    rdPlayCache.clear();
    rdCorsBlocked = false;
    toast("Real-Debrid settings saved");
    viewAddons();
  };
  if ($("#rdClear")) $("#rdClear").onclick = () => { saveRd({ token: "" }); rdPlayCache.clear(); rdCorsBlocked = false; toast("Forgot the pasted token"); viewAddons(); };
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

// ---------- watch page ----------
// Player on the page, toggles and Prev/Next under it, then sources grouped SUB / DUB.
// Opening an episode asks every add-on straight away and starts the first playable source.
let autoStartOnce = false;
const audioOf = s => { const t = `${s.name || ""} ${s.title || ""} ${s.description || ""}`; return /\bdub(bed)?\b|\beng(lish)? ?dub|\bdual\b/i.test(t) ? "dub" : /\bsub(bed|s)?\b|\bsoft ?sub|\bhard ?sub/i.test(t) ? "sub" : "other"; };
async function viewWatch(id, ep) {
  ep = +ep || 1;
  app.innerHTML = `<div class="watch-stage skel"></div>`;
  let m;
  try { m = await getMedia(id); }
  catch { app.innerHTML = `<div class="empty"><h3>Couldn't load this episode</h3>AniList didn't respond. Go back and try again.</div>`; return; }
  const here = location.hash;
  const route = `#/a/${id}`, title = titleOf(m), isMovie = m.format === "MOVIE", count = episodeCount(m);
  const ctx = { media: m, route, title, poster: m.coverImage?.large, count };
  const autostart = autoStartOnce || prefs.autoPlay; autoStartOnce = false;
  const toggle = (k, label) => `<button class="wt-toggle" data-pref="${k}" aria-pressed="${!!prefs[k]}"><span class="box" aria-hidden="true"></span>${label}</button>`;
  const air = m.nextAiringEpisode ? `Episode ${m.nextAiringEpisode.episode} arrives ${new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}.` : "";
  app.innerHTML = `
    <div class="watch-stage" id="watchStage">
      <div class="wt-poster" style="background-image:url('${esc(m.bannerImage || m.coverImage?.large || "")}')"></div>
      <button class="wt-play" id="wtStart" aria-label="Play">${ICON.play}</button>
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
      ${isMovie ? "" : `<div class="wt-nav"><button class="wt-navbtn" id="wtPrev" ${ep <= 1 ? "disabled" : ""}>⏮ Prev</button><button class="wt-navbtn" id="wtNext" ${ep >= count ? "disabled" : ""}>Next ⏭</button></div>`}
    </div>
    <div class="wt-info">You're watching <b>${isMovie ? esc(title) : "Episode " + ep}</b>${isMovie ? "" : ` of <a href="${route}">${esc(title)}</a>`}. If a source doesn't work, try another one below.</div>
    <div id="wtSources" class="wt-sources"><p class="muted">Asking your add-ons…</p></div>
    ${air ? `<div class="wt-air">🔔 ${esc(air)}</div>` : ""}
    ${isMovie ? "" : section("Episodes", `<div class="eps">${Array.from({ length: count }, (_, i) => i + 1).map(n => {
      const p = progress[`${route}:${n}`]; const pct = p?.d ? Math.min(100, p.t / p.d * 100) : 0;
      return `<a class="ep${pct > 92 ? " seen" : ""}" href="#/watch/${id}/${n}" ${n === ep ? 'aria-current="true"' : ""}>${n}${pct ? `<span class="p" style="width:${pct}%"></span>` : ""}</a>`;
    }).join("")}</div>`)}`;
  app.querySelectorAll("[data-pref]").forEach(b => b.onclick = () => {
    prefs[b.dataset.pref] = !prefs[b.dataset.pref];
    store.set("playerPrefs", prefs);
    b.setAttribute("aria-pressed", String(!!prefs[b.dataset.pref]));
    if (b.dataset.pref === "showAllSources") refreshSources();
  });
  const extPlayer = $("#extPlayer");
  if (extPlayer) {
    extPlayer.value = ["infuse", "vlc", "outplayer"].includes(prefs.externalPlayer) ? prefs.externalPlayer : "infuse";
    extPlayer.onchange = () => { prefs.externalPlayer = extPlayer.value; store.set("playerPrefs", prefs); };
  }
  if ($("#wtPrev")) $("#wtPrev").onclick = () => { autoStartOnce = true; location.hash = `#/watch/${id}/${ep - 1}`; };
  if ($("#wtNext")) $("#wtNext").onclick = () => { autoStartOnce = true; location.hash = `#/watch/${id}/${ep + 1}`; };

  const { results, info, report } = await fetchAniStreams(ctx, ep, isMovie);
  if (location.hash !== here) return;
  const rows = [];
  for (const r of results) for (const st of r.streams) rows.push({ a: r.a, s: st, audio: audioOf(st) });
  const groups = [["sub", "SUB", "CC"], ["dub", "DUB", "🎙"], ["other", rows.some(r => r.audio !== "other") ? "Other" : "Sources", "▶"]];
  const kind = st => KumoPlayback.kindLabel(st);
  const tagOf = disp => disp === "blocked" ? "Blocked by Real-Debrid" : disp === "uncached" ? "Not cached" : disp === "wrong-ip" ? "Different connection" : disp === "slate" ? "Unavailable" : disp === "failed" ? "Didn't play" : "";
  refreshSources = () => {
    const host = $("#wtSources");
    if (!host || location.hash !== here) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty"><h3>No sources for this episode</h3>${addons.filter(a => a.enabled).length ? "None of your add-ons have it yet. Try again later or add another add-on." : `You haven't installed any add-ons. <a href="#/addons">Open Add-ons</a> to add one.`}</div>`;
    } else {
      const visible = rows.map((r, i) => ({ ...r, i })).filter(r => !KumoPlayback.hideFromList(r.s, verdictOf(r.s.url), prefs.showAllSources));
      host.innerHTML = visible.length ? groups.map(([g, label, icon]) => {
        const list = visible.filter(r => r.audio === g);
        return list.length ? `<div class="wt-group"><div class="wt-group-h"><span class="wt-badge">${icon}</span>${label}</div><div class="wt-grid">${list.map(r => {
          const disp = KumoPlayback.listDisposition(r.s, verdictOf(r.s.url));
          const tag = tagOf(disp);
          const bad = disp !== "ready";
          return `<button class="wt-src${bad ? " bad" : ""}" data-i="${r.i}" data-disp="${disp}" ${playable(r.s) || r.s.externalUrl ? "" : "disabled"}><span class="dot">▶</span><span class="nm">${esc((r.s.name || r.a.manifest.name).split("\n")[0])}</span><small>${esc(r.a.manifest.name)}${kind(r.s) ? " · " + kind(r.s) : ""}${tag ? " · " + esc(tag) : ""}</small></button>`;
        }).join("")}</div></div>` : "";
      }).join("") : `<p class="muted">Nothing here can play immediately. Turn on Show all sources for uncached and blocked links.</p>`;
    }
    if (report.length) host.insertAdjacentHTML("beforeend", `<details class="wt-report"${rows.some(r => playable(r.s) && !KumoPlayback.hideFromList(r.s, verdictOf(r.s.url), prefs.showAllSources)) ? "" : " open"}><summary>Add-on status (${report.length})</summary><ul>${report.map(r => `<li><b>${esc(r.a.manifest.name)}</b> ${esc(r.why)}.</li>`).join("")}</ul></details>`);
    host.querySelectorAll(".wt-src").forEach(b => b.onclick = () => playPicked(+b.dataset.i));
  };
  const playPicked = i => {
    const row = rows[i];
    const verdict = verdictOf(row?.s?.url);
    if (row?.s?.url && verdict === "external" && !KumoPlayback.isUncachedStream(row.s)) {
      highlightSource(i);
      handoffExternal($("#watchStage"), info, row.s.url);
      return;
    }
    playFromList(rows, i, info, $("#watchStage"), { explicit: true });
  };
  refreshSources();
  const playAuto = () => playFromList(rows, null, info, $("#watchStage"));
  // Subbed before dubbed, and a cached Real-Debrid source before an uncached one.
  const first = KumoPlayback.playbackOrder(rows, null, { safari: isSafariPlayer(), skipUncached: true }).find(r => playable(r.s))
    || KumoPlayback.playbackOrder(rows, null, { safari: isSafariPlayer() }).find(r => playable(r.s));
  if (!first) { $("#wtStatus").textContent = rows.length ? "Pick a source below." : "No sources found."; $("#wtStart").hidden = true; return; }
  $("#wtStatus").textContent = "";
  $("#wtStart").onclick = () => playAuto();
  inspectSources(rows, here);
  if (autostart) playAuto();
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
  app.querySelectorAll(".wt-src").forEach(b => b.classList.toggle("on", +b.dataset.i === index));
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
  return new Promise(resolve => {
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
  });
}

// Play the next episode with a source from the same add-on if possible, else the best playable one
async function goNext() {
  const c = current; if (!c?.info.next) return;
  const next = c.info.next;
  if (c.mount && next.watch) { cancelPlayback(); teardown(); current = null; autoStartOnce = true; location.hash = next.watch; return; }
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
  location.hash = next.page;
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
document.addEventListener("keydown", e => {
  if (!$("#player").hidden && e.key === "Escape") return closePlayer();
  if (!$("#player").hidden || current?.mount) current?.keys?.(e);
});

// ---------- new-episode notifications ----------
// Built from the Watching list each time the app opens: episodes aired in the last
// 14 days, plus each show's next episode. "Seen" is the time the bell was last opened.
let notes = { aired: [], upcoming: [] }, notesSeen = store.get("notesSeen", 0);
async function loadNotes() {
  const ids = Object.keys(watchlist).map(r => (r.match(/^#\/a\/(\d+)$/) || [])[1]).filter(Boolean).map(Number);
  if (!ids.length) { notes = { aired: [], upcoming: [] }; return renderBell(); }
  const now = Math.floor(Date.now() / 1000);
  try {
    const d = await anilist(`query($ids:[Int],$from:Int,$to:Int){
      aired:Page(perPage:50){airingSchedules(mediaId_in:$ids,airingAt_greater:$from,airingAt_lesser:$to,sort:TIME_DESC){episode airingAt media{id title{romaji english} coverImage{large}}}}
      next:Page(perPage:50){media(id_in:$ids){id title{romaji english} coverImage{large} nextAiringEpisode{episode airingAt}}}}`, { ids, from: now - 14 * 86400, to: now });
    notes = {
      aired: d.aired.airingSchedules,
      upcoming: d.next.media.filter(m => m.nextAiringEpisode).sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt),
    };
  } catch { notes.error = true; }
  renderBell();
}
function ago(t) {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderBell() {
  const unread = notes.aired.filter(n => n.airingAt * 1000 > notesSeen).length;
  const b = $("#bellCount"); b.textContent = unread > 9 ? "9+" : unread; b.hidden = !unread;
  $("#bellBtn").setAttribute("aria-label", unread ? `${unread} new episode${unread > 1 ? "s" : ""}` : "New episodes");
  const panel = $("#notesPanel"); if (panel.hidden) return;
  const row = (m, ep, when, fresh) => `<a class="note-row${fresh ? " fresh" : ""}" href="#/a/${m.id}/${ep}"><img src="${esc(m.coverImage?.large)}" alt=""><div><b>${esc(titleOf(m))}</b><span>Episode ${ep} · ${when}</span></div></a>`;
  panel.innerHTML = `<div class="notes-head">New episodes</div>` +
    (Object.keys(watchlist).length === 0 ? `<p class="notes-empty">Add shows to <b>Watching</b> and new episodes will show up here.</p>`
      : notes.error ? `<p class="notes-empty">Couldn't check for new episodes. Try again in a bit.</p>`
      : (notes.aired.length ? notes.aired.map(n => row(n.media, n.episode, ago(n.airingAt), n.airingAt * 1000 > notesSeen)).join("") : `<p class="notes-empty">No new episodes in the last two weeks.</p>`) +
        (notes.upcoming.length ? `<div class="notes-head">Coming up</div>` + notes.upcoming.map(m => row(m, m.nextAiringEpisode.episode, new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), false)).join("") : ""));
}
function toggleNotes(open) {
  const panel = $("#notesPanel");
  panel.hidden = open === undefined ? !panel.hidden : !open;
  panel.style.display = panel.hidden ? "none" : "";
  if (!panel.hidden) { renderBell(); notesSeen = Date.now(); store.set("notesSeen", notesSeen); setTimeout(() => { $("#bellCount").hidden = true; }, 600); }
}
$("#bellBtn").onclick = e => { e.stopPropagation(); togglePanel("#acctPanel", false); toggleNotes(); };
document.addEventListener("click", e => { if (!e.target.closest("#notesPanel, #bellBtn")) toggleNotes(false); });
window.addEventListener("hashchange", () => toggleNotes(false));
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadNotes(); });
setInterval(loadNotes, 15 * 60 * 1000);
loadNotes();

// ---------- accounts (Supabase) ----------
// Sign up / log in with email + password. Watching and progress are kept in one
// row per person (public.user_data, protected by row-level security).
const SUPABASE_URL = "https://xaiwuqyudxmypdairyab.supabase.co";
const SUPABASE_KEY = "sb_publishable_XH_vVGedmDfC0KTNUqpWbA_q35TWZXL"; // publishable key: safe in page code
const sb = window.supabase && !SUPABASE_KEY.startsWith("PASTE") ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, detectSessionInUrl: true } }) : null;
let account = null, syncTimer = null, syncState = "", recovering = false;

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
  loadNotes(); route();
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
$("#acctBtn").onclick = e => { e.stopPropagation(); toggleNotes(false); if (togglePanel("#acctPanel")) renderAccount(); };
document.addEventListener("click", e => { if (!e.target.closest("#acctPanel, #acctBtn")) togglePanel("#acctPanel", false); });
window.addEventListener("hashchange", () => togglePanel("#acctPanel", false));
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const was = account?.id;
    account = session?.user || null;
    if (/access_token|type=recovery/.test(location.hash)) history.replaceState(null, "", location.pathname + "#/");
    if (event === "PASSWORD_RECOVERY") { recovering = true; togglePanel("#acctPanel", true); }
    if (account && account.id !== was) { syncState = ""; pullAndMerge(); toast("Logged in"); }
    renderAccount();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pushNow(); else if (account) pullAndMerge(); });
}
renderAccount();

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, ...rest] = h.split("/");
  document.querySelectorAll(".dock a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === ({ "": "home", search: "search", list: "list", addons: "addons" }[p] || "") ? "page" : "false"));
  window.scrollTo(0, 0);
  cancelPlayback();
  if (current?.mount) { teardown(); current = null; }
  if (!p) return viewHome();
  if (p === "watch") return viewWatch(rest[0], rest[1]);
  if (p === "search") { if (rest[0]) filters.q = decodeURIComponent(rest.join("/")); return viewSearch(!rest[0] && !filters.q); }
  if (p === "a") { if (rest[1]) { location.replace(`#/watch/${rest[0]}/${rest[1]}`); return; } return viewAnime(rest[0]); }
  if (p === "m") return viewMeta(decodeURIComponent(rest[0]), decodeURIComponent(rest[1]), decodeURIComponent(rest.slice(2).join("/")));
  if (p === "list") return viewList();
  if (p === "addons") return viewAddons();
  viewHome();
}
window.addEventListener("hashchange", route);
route();
// A home-screen launch on iOS can keep the previous HTML until it is fetched
// again. Once this version is running, a network-first worker updates later
// deploys. It only covers the app shell: video, Range, and cross-origin
// requests are not intercepted.
if ("serviceWorker" in navigator && /(^|\.)github\.io$/.test(location.hostname)) navigator.serviceWorker.register("./sw.js").catch(() => {});
