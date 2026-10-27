"use strict";
// Rules for the new-episode bell. Pure data so the same checks run in the
// page and in node tests: only episodes that have actually aired, never
// twice, and never after the user has watched them.

(function (root) {
  const DAY = 86400;
  const WATCHED = 0.92;

  function episodeKey(mediaId, episode) {
    const id = Number(mediaId);
    const ep = Number(episode);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(ep) || ep <= 0) return "";
    return id + ":" + ep;
  }

  function progressKey(mediaId, episode) {
    return "#/a/" + Number(mediaId) + ":" + Number(episode);
  }

  function isWatched(entry) {
    return !!(entry && Number(entry.d) > 0 && Number(entry.t) / Number(entry.d) > WATCHED);
  }

  function hasAired(airingAt, nowSec) {
    const t = Number(airingAt);
    return t > 0 && t <= Number(nowSec);
  }

  function titleFrom(n) {
    if (!n) return "";
    if (typeof n.title === "string") return n.title;
    if (n.title && (n.title.english || n.title.romaji)) return n.title.english || n.title.romaji || "";
    if (n.media) return titleFrom(n.media);
    return "";
  }

  function posterFrom(n) {
    if (!n) return "";
    if (typeof n.poster === "string" && n.poster) return n.poster;
    if (n.coverImage && n.coverImage.large) return n.coverImage.large;
    if (n.media) return posterFrom(n.media);
    return "";
  }

  function isAnnouncement(n) {
    return !!(n && (n.upcoming || n.announcement || n.kind === "upcoming" || n.kind === "announcement"));
  }

  // Older builds kept "Coming up" rows beside aired ones. Announcements are
  // dropped here on purpose: a future air date is not a notification.
  function candidatesFrom(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(n => !isAnnouncement(n));
    const out = [];
    if (Array.isArray(raw.items)) out.push(...raw.items.filter(n => !isAnnouncement(n)));
    if (Array.isArray(raw.aired)) {
      for (const n of raw.aired) {
        if (isAnnouncement(n)) continue;
        out.push({
          mediaId: n.mediaId || (n.media && n.media.id),
          episode: n.episode,
          airingAt: n.airingAt,
          title: titleFrom(n),
          poster: posterFrom(n),
        });
      }
    }
    return out;
  }

  function cleanNotes(raw, opts) {
    const now = Number(opts && opts.nowSec);
    const watching = opts && opts.watchingIds || null;
    const progress = (opts && opts.progress) || {};
    const seen = new Set();
    const items = [];
    const dismissed = [];
    const dismissedKeys = new Set();
    const pushDismissed = (key, at) => {
      if (!key || dismissedKeys.has(key)) return;
      dismissedKeys.add(key);
      const t = Number(at) || 0;
      // The bell only looks back two weeks, plus a little slack. Older
      // dismissals cannot be recreated, so they don't need to stay stored.
      if (t && t < now - 21 * DAY) return;
      dismissed.push({ key, at: t || now });
    };
    const prior = Array.isArray(raw) ? [] : (raw && Array.isArray(raw.dismissed) ? raw.dismissed : []);
    for (const d of prior) {
      if (typeof d === "string") pushDismissed(d, 0);
      else if (d && d.key) pushDismissed(String(d.key), d.at || d.airingAt || 0);
    }
    for (const n of candidatesFrom(raw)) {
      if (isAnnouncement(n)) continue;
      const mediaId = Number(n.mediaId != null ? n.mediaId : (n.media && n.media.id));
      const episode = Number(n.episode);
      const key = episodeKey(mediaId, episode);
      if (!key || seen.has(key)) continue;
      const airingAt = Number(n.airingAt);
      if (!hasAired(airingAt, now)) continue;
      if (watching && !watching.has(mediaId)) continue;
      if (dismissedKeys.has(key) || isWatched(progress[progressKey(mediaId, episode)])) {
        pushDismissed(key, airingAt);
        continue;
      }
      seen.add(key);
      items.push({
        key,
        mediaId,
        episode,
        airingAt,
        title: titleFrom(n),
        poster: posterFrom(n),
      });
    }
    items.sort((a, b) => b.airingAt - a.airingAt || b.episode - a.episode);
    return { items, dismissed };
  }

  function ingestAired(state, schedules, opts) {
    const now = Number(opts && opts.nowSec);
    const watching = opts && opts.watchingIds || null;
    const addedAt = (opts && opts.addedAt) || {};
    const baseItems = (state && state.items) || [];
    const extra = [];
    for (const n of schedules || []) {
      const mediaId = Number(n.media && n.media.id != null ? n.media.id : n.mediaId);
      const episode = Number(n.episode);
      const airingAt = Number(n.airingAt);
      if (!episodeKey(mediaId, episode) || !hasAired(airingAt, now)) continue;
      if (watching && !watching.has(mediaId)) continue;
      const added = Number(addedAt[mediaId] || 0);
      // Added to Watching after this episode aired: it isn't new.
      if (added && airingAt < added) continue;
      extra.push({
        mediaId,
        episode,
        airingAt,
        title: titleFrom(n),
        poster: posterFrom(n),
      });
    }
    return cleanNotes({
      items: baseItems.concat(extra),
      dismissed: (state && state.dismissed) || [],
    }, opts || {});
  }

  function dismissEpisode(state, mediaId, episode, nowSec) {
    const key = episodeKey(mediaId, episode);
    const base = state || { items: [], dismissed: [] };
    if (!key) return cleanNotes(base, { nowSec, watchingIds: null, progress: {} });
    return cleanNotes({
      items: base.items || [],
      dismissed: (base.dismissed || []).concat([{ key, at: nowSec }]),
    }, { nowSec, watchingIds: null, progress: {} });
  }

  // The badge is the list. There is no separate "already opened the bell" count.
  function unreadCount(state) {
    return state && state.items ? state.items.length : 0;
  }

  // Compact poster label. Examples: "Ep 8 · Sat", "Ep 8 in 2d".
  function airLabel(episode, airingAtSec, nowMs, locale) {
    const ep = Number(episode);
    const at = Number(airingAtSec);
    if (!ep || !at) return "";
    const when = at * 1000;
    const now = Number(nowMs);
    if (!(when > now)) return "";
    const start = ms => {
      const d = new Date(ms);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    const days = Math.round((start(when) - start(now)) / 86400000);
    if (days >= 1 && days <= 6) return "Ep " + ep + " in " + days + "d";
    const date = new Date(when);
    const loc = locale || undefined;
    if (days <= 0) return "Ep " + ep + " · " + date.toLocaleDateString(loc, { weekday: "short" });
    return "Ep " + ep + " · " + date.toLocaleDateString(loc, { day: "numeric", month: "short" });
  }

  const api = {
    episodeKey, progressKey, isWatched, hasAired, cleanNotes, ingestAired,
    dismissEpisode, unreadCount, airLabel, WATCHED,
  };
  root.KumoNotify = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
