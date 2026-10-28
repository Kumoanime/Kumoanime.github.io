"use strict";
// List status, the Monday-start week, and filler-list parsing. Pure data so
// the page and the tests share one set of rules.
(function (root) {
  const STATUSES = [
    { id: "watching", label: "Watching", route: "" },
    { id: "planning", label: "Plan to Watch", route: "planning" },
    { id: "completed", label: "Completed", route: "completed" },
    { id: "hold", label: "On Hold", route: "hold" },
    { id: "dropped", label: "Dropped", route: "dropped" },
  ];

  function listStatus(item) {
    if (!item) return "";
    const status = item.status;
    return STATUSES.some(row => row.id === status) ? status : "watching";
  }

  function isWatching(item) {
    return listStatus(item) === "watching";
  }

  function statusByRoute(route) {
    if (!route || route === "watching") return STATUSES[0];
    return STATUSES.find(row => row.id === route || row.route === route) || STATUSES[0];
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function weekBounds(nowMs) {
    const now = new Date(nowMs);
    const day = (now.getDay() + 6) % 7;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return {
      startMs: start.getTime(),
      from: Math.floor(start.getTime() / 1000) - 1,
      to: Math.floor(end.getTime() / 1000),
    };
  }

  function dayKey(sec) {
    const date = new Date(sec * 1000);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function weekDays(nowMs) {
    const start = new Date(weekBounds(nowMs).startMs);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      days.push({
        key: date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()),
        at: Math.floor(date.getTime() / 1000),
      });
    }
    return days;
  }

  function groupSchedules(rows) {
    const groups = [];
    const map = new Map();
    for (const row of rows || []) {
      if (!row || !row.airingAt) continue;
      const key = dayKey(row.airingAt);
      if (!map.has(key)) {
        const group = { key, at: row.airingAt, items: [] };
        map.set(key, group);
        groups.push(group);
      }
      map.get(key).items.push(row);
    }
    return groups;
  }

  function episodeList(body) {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.episodes)) return body.episodes;
    if (body && Array.isArray(body.items)) return body.items;
    if (body && Array.isArray(body.data)) return body.data;
    return null;
  }

  function fillerNumbers(body) {
    const list = episodeList(body);
    if (!list) return null;
    const set = {};
    for (const episode of list) {
      const number = Number(episode && (episode.episode_number ?? episode.episode ?? episode.number));
      const status = episode && (episode.status || episode.type);
      if (status === "filler" && number > 0) set[String(number)] = true;
    }
    return set;
  }

  function seriesIdFromSearch(body) {
    const items = body && (body.items || body.data || (Array.isArray(body) ? body : null));
    const first = items && items[0];
    return first && (first.id || first.series_id) || null;
  }

  function fillerFile(markdown, malId) {
    const want = String(malId || "");
    if (!want || !markdown) return "";
    const re = /\|\s*\[`([^`]+\.json)`\][^|\n]*\|\s*[^|\n]+\|\s*(\d+)\s*\|/g;
    let match;
    while ((match = re.exec(markdown))) {
      if (match[2] === want) return match[1];
    }
    return "";
  }

  function recTitle(status, title) {
    if (status === "watching" || status === "completed") return "Because you watched " + (title || "this");
    return "Related";
  }

  const api = {
    STATUSES, listStatus, isWatching, statusByRoute, weekBounds, dayKey, weekDays,
    groupSchedules, fillerNumbers, seriesIdFromSearch, fillerFile, recTitle,
  };
  root.KumoBrowse = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
