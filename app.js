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
// Built-ins use the same shape as remote add-ons, with local handlers. None ship today:
// trailers have their own button on the show page.
const BUILTINS = [];

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
  return resource === "catalog" ? j.metas : resource === "meta" ? j.meta : resource === "subtitles" ? j.subtitles : j.streams;
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
    }).join("")}</div>`, next)}
    <div id="streams"></div>`;
  const ctx = { media: m, route, title, poster: m.coverImage?.large, count };
  $("#toggleList").onclick = () => { toggleWatch(route, title, m.coverImage?.large); viewAnime(id); };
  $("#playNext").onclick = () => loadAniStreams(ctx, isMovie ? 1 : nextEpisode(route, count), isMovie);
  if ($("#playTrailer")) $("#playTrailer").onclick = () => play({ ytId: m.trailer.id }, { label: `${title} · Trailer`, key: `${route}:trailer` });
  app.querySelectorAll("[data-ep]").forEach(b => b.onclick = () => loadAniStreams(ctx, +b.dataset.ep, false));
  if (epParam) loadAniStreams(ctx, +epParam, isMovie);
}
function nextEpisode(route, count) {
  let last = 0;
  for (const [k, p] of Object.entries(progress)) if (k.startsWith(route + ":")) { const n = +k.split(":").pop(); if (p.d && p.t / p.d > 0.92) last = Math.max(last, n); else if (p.t > 0) last = Math.max(last, n - 1); }
  return Math.min(last + 1, count);
}

async function fetchAniStreams(ctx, ep, isMovie) {
  const kid = await kitsuId(ctx.media.idMal);
  // Kitsu ids first: most anime add-ons use them, and add-ons without idPrefixes get the first id
  const ids = [];
  if (kid) ids.push(isMovie ? `kitsu:${kid}` : `kitsu:${kid}:${ep}`);
  if (ctx.media.idMal) ids.push(isMovie ? `mal:${ctx.media.idMal}` : `mal:${ctx.media.idMal}:${ep}`);
  ids.push(`anilist:${ctx.media.id}:${ep}`);
  const jobs = [];
  for (const a of allAddons().filter(a => a.enabled)) {
    const spec = resourceSpec(a.manifest, "stream"); if (!spec) continue;
    const type = isMovie ? "movie" : spec.types.includes("anime") ? "anime" : "series";
    const sid = ids.find(i => handles(a, "stream", i));
    if (!sid) continue;
    jobs.push(call(a, "stream", type, sid, ctx).then(s => ({ a, streams: s || [] }), () => ({ a, failed: true })));
  }
  const label = isMovie ? "Movie" : `Episode ${ep}`;
  const info = {
    ...ctx, key: `${ctx.route}:${ep}`, label: `${ctx.title} · ${label}`, short: label, ep, subIds: ids, subType: isMovie ? "movie" : "series",
    next: !isMovie && ep < ctx.count ? { short: `Episode ${ep + 1}`, page: `${ctx.route}/${ep + 1}`, get: () => fetchAniStreams(ctx, ep + 1, false) } : null,
  };
  return { results: await Promise.all(jobs), info };
}
async function loadAniStreams(ctx, ep, isMovie) {
  app.querySelectorAll("[data-ep]").forEach(b => b.setAttribute("aria-current", +b.dataset.ep === ep));
  const box = $("#streams");
  box.innerHTML = `<div class="streams"><h3>${isMovie ? "Sources" : "Episode " + ep}</h3><p class="muted">Asking your add-ons…</p></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const { results, info } = await fetchAniStreams(ctx, ep, isMovie);
  renderStreams(box, results, info);
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
  const kind = s => s.ytId ? "YouTube" : s.url ? (/\.m3u8/i.test(s.url) ? "HLS" : "Video") : s.externalUrl ? "Opens site" : s.infoHash ? "Torrent" : "Unknown";
  box.innerHTML = `<div class="streams"><h3>${esc(info.short)}</h3>
    ${rows.length ? rows.map((x, i) => `<button class="stream" data-i="${i}"><div><b>${esc(x.s.name || x.a.manifest.name)}</b><span>${esc(x.s.title || x.s.description || "")}</span></div><span class="kind">${kind(x.s)}</span></button>`).join("")
      : `<p class="note">None of your add-ons have a source for this yet. ${addons.length ? "" : "Install an add-on under Add-ons to get episode sources."}</p>`}
    ${failed.length ? `<p class="note">No answer from: ${failed.map(esc).join(", ")}.</p>` : ""}</div>`;
  box.querySelectorAll("[data-i]").forEach(b => b.onclick = () => play(rows[+b.dataset.i].s, info, rows[+b.dataset.i].a.key));
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
// Custom controls over a plain <video>: tap to show/hide, double-tap a side to skip 10 s,
// Skip intro (85 s, a typical anime opening), Next episode + auto-play, speed, subtitles.
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const LANGS = { en: "English", eng: "English", ja: "Japanese", jpn: "Japanese", es: "Spanish", spa: "Spanish", pt: "Portuguese", por: "Portuguese", pob: "Portuguese (BR)", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German", it: "Italian", ita: "Italian", ar: "Arabic", ara: "Arabic", ru: "Russian", rus: "Russian", id: "Indonesian", ind: "Indonesian", tr: "Turkish", tur: "Turkish" };
const ICON = {
  play: `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">10</text></svg>`,
  fwd: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">10</text></svg>`,
  full: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
};
let prefs = store.get("playerPrefs", { speed: 1, subLang: "", autoNext: true });
let hls = null, saveTimer = null, current = null, hideTimer = null, countTimer = null, blobs = [];
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };
const playable = s => s && (s.url || s.ytId);

function openShell(label) {
  $("#playerTitle").textContent = label;
  $("#player").hidden = false; $("#player").style.display = "";
  document.body.style.overflow = "hidden";
}
function teardown() {
  current?.record?.();
  clearInterval(saveTimer); clearTimeout(hideTimer); clearInterval(countTimer);
  hls?.destroy(); hls = null;
  blobs.forEach(u => URL.revokeObjectURL(u)); blobs = [];
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
async function subTrackUrl(url) {
  const txt = await (await fetch(url)).text();
  const vtt = /^﻿?WEBVTT/.test(txt) ? txt : "WEBVTT\n\n" + txt.replace(/\r/g, "").replace(/(\d+:\d+:\d+),(\d+)/g, "$1.$2");
  const u = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  blobs.push(u); return u;
}

function play(s, info, addonKey) {
  if (s.externalUrl && !s.url && !s.ytId) { window.open(s.externalUrl, "_blank", "noopener"); return; }
  teardown();
  openShell(info.label);
  current = { info, addonKey };
  const stage = $("#playerStage");
  if (s.ytId) {
    stage.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.ytId)}?autoplay=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(info.label)}"></iframe>`;
    return;
  }
  if (!s.url) {
    stage.innerHTML = `<div class="err">${s.infoHash ? "This source is a torrent, which web browsers can't play. Pick a different source." : "This source has no playable link."}</div>`;
    return;
  }
  stage.innerHTML = `
    <div class="pv" id="pv">
      <video id="vid" playsinline autoplay preload="metadata" crossorigin="anonymous"></video>
      <div class="pv-zones"><div data-zone="-10"></div><div data-zone="0"></div><div data-zone="10"></div></div>
      <div class="pv-flash" id="pvFlash" hidden></div>
      <div class="pv-spin" id="pvSpin"></div>
      <div class="pv-pills">
        <button class="pv-pill" id="pvIntro" hidden>Skip intro »</button>
        <button class="pv-pill solid" id="pvNext" hidden>${info.next ? esc(info.next.short) + " ▶" : ""}</button>
      </div>
      <div class="pv-count" id="pvCount" hidden></div>
      <div class="pv-ui">
        <div class="pv-mid">
          <button class="pv-btn" id="pvBack" aria-label="Back 10 seconds">${ICON.back}</button>
          <button class="pv-btn big" id="pvPlay" aria-label="Pause">${ICON.pause}</button>
          <button class="pv-btn" id="pvFwd" aria-label="Forward 10 seconds">${ICON.fwd}</button>
        </div>
        <div class="pv-bar">
          <span class="pv-time" id="pvTime">0:00</span>
          <input type="range" id="pvSeek" min="0" max="1000" value="0" step="1" aria-label="Seek">
          <span class="pv-time" id="pvDur">0:00</span>
        </div>
        <div class="pv-row">
          <button class="pv-chip" id="pvSpeed" aria-label="Playback speed">${prefs.speed}×</button>
          <button class="pv-chip" id="pvCC" aria-label="Subtitles">CC</button>
          ${info.next ? `<button class="pv-chip" id="pvAuto" aria-pressed="${prefs.autoNext}">Auto-play ${prefs.autoNext ? "on" : "off"}</button>` : ""}
          <button class="pv-chip icon" id="pvFull" aria-label="Fullscreen">${ICON.full}</button>
        </div>
        <div class="pv-menu" id="pvMenu" hidden></div>
      </div>
    </div>`;
  const v = $("#vid"), pv = $("#pv");
  if (/\.m3u8(\?|$)/i.test(s.url) && !v.canPlayType("application/vnd.apple.mpegurl") && window.Hls?.isSupported()) { hls = new Hls(); hls.loadSource(s.url); hls.attachMedia(v); }
  else v.src = s.url;
  v.playbackRate = prefs.speed;
  v.addEventListener("loadedmetadata", () => { v.playbackRate = prefs.speed; const prev = progress[info.key]; if (prev?.t && prev.d && prev.t / prev.d < 0.92) v.currentTime = prev.t; }, { once: true });
  // some hosts refuse crossorigin requests; retry once without it (subtitles from blobs still work)
  v.addEventListener("error", () => {
    if (v.hasAttribute("crossorigin") && !hls) { v.removeAttribute("crossorigin"); v.src = s.url; v.load(); return; }
    $("#pvSpin").hidden = true;
    stage.insertAdjacentHTML("beforeend", `<div class="err">This source wouldn't play. Close the player and try another one.</div>`);
  });

  // controls visibility
  const show = () => { $("#player").classList.remove("idle"); clearTimeout(hideTimer); if (!v.paused && $("#pvMenu").hidden) hideTimer = setTimeout(() => $("#player").classList.add("idle"), 3000); };
  const toggleUI = () => $("#player").classList.contains("idle") ? show() : (!v.paused && $("#player").classList.add("idle"));
  const flash = txt => { const f = $("#pvFlash"); f.textContent = txt; f.hidden = false; f.style.animation = "none"; void f.offsetWidth; f.style.animation = ""; clearTimeout(flash.t); flash.t = setTimeout(() => f.hidden = true, 600); };
  const skip = d => { v.currentTime = Math.min(Math.max(0, v.currentTime + d), (v.duration || 1e9) - 0.5); flash(d > 0 ? `+${d}s` : `${d}s`); show(); };
  const togglePlay = () => { v.paused ? v.play() : v.pause(); show(); };

  // tap once to show/hide controls, double-tap left/right third to skip 10 s
  let lastTap = { t: 0, z: null }, tapTimer = null;
  pv.querySelectorAll("[data-zone]").forEach(z => z.addEventListener("click", () => {
    const d = +z.dataset.zone, now = Date.now();
    if (d && lastTap.z === d && now - lastTap.t < 300) { clearTimeout(tapTimer); skip(d); lastTap = { t: 0, z: null }; return; }
    lastTap = { t: now, z: d };
    clearTimeout(tapTimer); tapTimer = setTimeout(toggleUI, d ? 260 : 0);
  }));
  $("#pvBack").onclick = () => skip(-10);
  $("#pvFwd").onclick = () => skip(10);
  $("#pvPlay").onclick = togglePlay;
  v.addEventListener("play", () => { $("#pvPlay").innerHTML = ICON.pause; $("#pvPlay").setAttribute("aria-label", "Pause"); show(); });
  v.addEventListener("pause", () => { $("#pvPlay").innerHTML = ICON.play; $("#pvPlay").setAttribute("aria-label", "Play"); show(); });
  v.addEventListener("waiting", () => $("#pvSpin").hidden = false);
  v.addEventListener("playing", () => $("#pvSpin").hidden = true);
  v.addEventListener("canplay", () => $("#pvSpin").hidden = true);

  // seek bar, time, Skip intro and Next episode visibility
  let seeking = false, introUsed = false;
  const seek = $("#pvSeek");
  seek.addEventListener("input", () => { seeking = true; if (v.duration) $("#pvTime").textContent = fmt(seek.value / 1000 * v.duration); show(); });
  seek.addEventListener("change", () => { if (v.duration) v.currentTime = seek.value / 1000 * v.duration; seeking = false; });
  v.addEventListener("timeupdate", () => {
    const d = v.duration || 0, t = v.currentTime;
    if (!seeking && d) { seek.value = Math.round(t / d * 1000); $("#pvTime").textContent = fmt(t); seek.style.setProperty("--p", (t / d * 100) + "%"); }
    $("#pvDur").textContent = fmt(d);
    $("#pvIntro").hidden = introUsed || !(d > 600 && t > 3 && t < 180);
    $("#pvNext").hidden = !(info.next && d && d - t < 120);
  });
  $("#pvIntro").onclick = () => { introUsed = true; skip(85); };
  $("#pvNext").onclick = () => goNext();

  // auto-play the next episode when this one ends
  v.addEventListener("ended", () => {
    record();
    if (!info.next || !prefs.autoNext) return show();
    let n = 5;
    const box = $("#pvCount");
    const draw = () => box.innerHTML = `<div>${esc(info.next.short)} in <b>${n}</b></div><div class="pv-count-btns"><button class="pv-pill solid" id="pvNow">Play now</button><button class="pv-pill" id="pvCancel">Cancel</button></div>`;
    draw(); box.hidden = false;
    countTimer = setInterval(() => { n--; if (n <= 0) { clearInterval(countTimer); goNext(); } else draw(); }, 1000);
    box.onclick = e => { if (e.target.id === "pvNow") { clearInterval(countTimer); goNext(); } if (e.target.id === "pvCancel") { clearInterval(countTimer); box.hidden = true; show(); } };
  });
  if ($("#pvAuto")) $("#pvAuto").onclick = e => { prefs.autoNext = !prefs.autoNext; store.set("playerPrefs", prefs); e.currentTarget.textContent = `Auto-play ${prefs.autoNext ? "on" : "off"}`; e.currentTarget.setAttribute("aria-pressed", prefs.autoNext); };

  // speed and subtitle menus
  const menu = $("#pvMenu");
  const openMenu = (html, onPick) => { menu.innerHTML = html; menu.hidden = false; show(); menu.onclick = e => { const b = e.target.closest("[data-v]"); if (b) { onPick(b.dataset.v); menu.hidden = true; show(); } }; };
  $("#pvSpeed").onclick = e => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return show(); }
    openMenu(`<div class="pv-menu-h">Speed</div>` + SPEEDS.map(x => `<button data-v="${x}" aria-pressed="${x === prefs.speed}">${x === 1 ? "Normal" : x + "×"}</button>`).join(""), x => {
      prefs.speed = +x; v.playbackRate = prefs.speed; store.set("playerPrefs", prefs); $("#pvSpeed").textContent = `${prefs.speed}×`;
    });
  };
  let subs = [], subsLoaded = false;
  const embedded = () => [...v.textTracks].filter(t => !t.label.startsWith("kumo:"));
  const setSub = async val => {
    [...v.textTracks].forEach(t => t.mode = "disabled");
    $("#pvCC").classList.toggle("on", val !== "off");
    if (val === "off") { prefs.subLang = "off"; return store.set("playerPrefs", prefs); }
    if (val.startsWith("e:")) { const t = embedded()[+val.slice(2)]; if (t) { t.mode = "showing"; prefs.subLang = t.language || prefs.subLang; } return store.set("playerPrefs", prefs); }
    const sub = subs[+val];
    try {
      let track = [...v.querySelectorAll("track")].find(t => t.dataset.src === sub.url);
      if (!track) {
        track = document.createElement("track");
        track.kind = "subtitles"; track.label = "kumo:" + (LANGS[sub.lang] || sub.lang || "Subtitles"); track.srclang = (sub.lang || "und").slice(0, 3);
        track.dataset.src = sub.url; track.src = await subTrackUrl(sub.url);
        v.appendChild(track);
      }
      setTimeout(() => { [...v.textTracks].forEach(t => t.mode = t.label === track.label && t === track.track ? "showing" : "disabled"); track.track.mode = "showing"; }, 50);
      prefs.subLang = sub.lang; store.set("playerPrefs", prefs);
    } catch { toast("Couldn't load those subtitles. Try another."); $("#pvCC").classList.remove("on"); }
  };
  gatherSubs(s, info).then(list => {
    subs = list; subsLoaded = true;
    if (prefs.subLang && prefs.subLang !== "off") { const i = subs.findIndex(x => x.lang === prefs.subLang || LANGS[x.lang] === LANGS[prefs.subLang]); if (i >= 0) setSub(String(i)); }
  });
  $("#pvCC").onclick = e => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return show(); }
    const emb = embedded();
    const items = [`<button data-v="off">Off</button>`]
      .concat(emb.map((t, i) => `<button data-v="e:${i}" aria-pressed="${t.mode === "showing"}">${esc(t.label || LANGS[t.language] || t.language || "Track " + (i + 1))}</button>`))
      .concat(subs.map((x, i) => `<button data-v="${i}">${esc(LANGS[x.lang] || x.lang || "Subtitles")} <small>${esc(x.from)}</small></button>`));
    openMenu(`<div class="pv-menu-h">Subtitles</div>` + items.join("") + (subsLoaded ? (items.length === 1 ? `<p class="pv-menu-note">No subtitles found for this source.</p>` : "") : `<p class="pv-menu-note">Looking for subtitles…</p>`), setSub);
  };

  $("#pvFull").onclick = () => {
    const el = $("#player");
    if (document.fullscreenElement) return document.exitFullscreen();
    if (el.requestFullscreen) el.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  };
  pv.addEventListener("mousemove", show);

  const record = () => { if (v.duration) saveProgress(info.key, { t: v.currentTime, d: v.duration, route: info.route, title: info.title, poster: info.poster, label: info.short }); };
  saveTimer = setInterval(record, 5000);
  v.addEventListener("pause", record);
  current.record = record;
  current.keys = e => {
    if (e.target.closest("input, select, textarea") && e.target.id !== "pvSeek") return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") skip(-10);
    else if (e.key === "ArrowRight") skip(10);
    else if (e.key === "f") $("#pvFull").click();
    else if (e.key === "n" && info.next) goNext();
  };
  show();
}

// Play the next episode with a source from the same add-on if possible, else the first playable one
async function goNext() {
  const c = current; if (!c?.info.next) return;
  const next = c.info.next;
  teardown();
  openShell(`Loading ${next.short}…`);
  $("#playerStage").innerHTML = `<div class="pv-spin"></div>`;
  try {
    const { results, info } = await next.get();
    const pick = results.find(r => r.a.key === c.addonKey)?.streams.find(playable)
      ? results.find(r => r.a.key === c.addonKey) : results.find(r => r.streams?.some(playable));
    if (pick) return play(pick.streams.find(playable), info, pick.a.key);
  } catch {}
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
  if ($("#player").hidden) return;
  if (e.key === "Escape") return closePlayer();
  current?.keys?.(e);
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
  if (!p) return viewHome();
  if (p === "search") { if (rest[0]) filters.q = decodeURIComponent(rest.join("/")); return viewSearch(!rest[0] && !filters.q); }
  if (p === "a") return viewAnime(rest[0], rest[1]);
  if (p === "m") return viewMeta(decodeURIComponent(rest[0]), decodeURIComponent(rest[1]), decodeURIComponent(rest.slice(2).join("/")));
  if (p === "list") return viewList();
  if (p === "addons") return viewAddons();
  viewHome();
}
window.addEventListener("hashchange", route);
route();
