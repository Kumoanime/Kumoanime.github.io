"use strict";
const assert = require("assert");
const N = require("../notify.js");

const now = 1_800_000_000;
const demo = (episode, airingAt, id = 5) => ({
  episode,
  airingAt,
  media: { id, title: { english: "Demo" }, coverImage: { large: "https://img/p.jpg" } },
});
const ctx = (extra = {}) => ({
  nowSec: now,
  watchingIds: new Set([5]),
  progress: {},
  addedAt: { 5: now - 14 * 86400 },
  ...extra,
});

assert.equal(N.isWatched({ t: 92, d: 100 }), false, "exactly 92% is not watched yet");
assert.equal(N.isWatched({ t: 93, d: 100 }), true);
assert.equal(N.isWatched({ t: 10, d: 0 }), false);
assert.equal(N.isWatched(null), false);
assert.equal(N.hasAired(now, now), true);
assert.equal(N.hasAired(now + 1, now), false);
assert.equal(N.hasAired(0, now), false);

// Future episodes and air-date announcements never become notifications.
let cleaned = N.cleanNotes({
  aired: [demo(2, now - 3600), demo(2, now - 3600), demo(8, now + 86400)],
  upcoming: [
    { id: 5, title: { english: "Demo" }, nextAiringEpisode: { episode: 9, airingAt: now + 5000 }, coverImage: { large: "x" } },
    { id: 5, nextAiringEpisode: { episode: 1, airingAt: now - 50 } },
  ],
  items: [{ mediaId: 5, episode: 4, airingAt: now + 10, title: "Soon", upcoming: true }],
}, ctx());
assert.deepEqual(cleaned.items.map(n => n.episode), [2]);
assert.equal(N.unreadCount(cleaned), cleaned.items.length);

// Watched episodes are removed and not created again.
cleaned = N.cleanNotes({
  items: [
    { mediaId: 5, episode: 3, airingAt: now - 100, title: "Demo", poster: "p" },
    { mediaId: 5, episode: 2, airingAt: now - 200, title: "Demo", poster: "p" },
    { mediaId: 5, episode: 2, airingAt: now - 200, title: "Demo again" },
    { mediaId: 9, episode: 1, airingAt: now - 100, title: "Not on the list" },
    { foo: "stale" },
  ],
}, ctx({ progress: { "#/a/5:2": { t: 99, d: 100 } } }));
assert.deepEqual(cleaned.items.map(n => n.episode), [3]);
assert.ok(cleaned.dismissed.some(d => d.key === "5:2"));
assert.equal(N.unreadCount(cleaned), 1);

let state = N.ingestAired({ items: [], dismissed: [] }, [
  demo(3, now - 100),
  demo(4, now - 50),
  demo(4, now - 50),
  demo(5, now + 86400),
  demo(1, now - 30, 9),
], ctx({ progress: { "#/a/5:3": { t: 100, d: 100 } } }));
assert.deepEqual(state.items.map(n => n.episode), [4]);
assert.equal(N.unreadCount(state), state.items.length);
state = N.ingestAired(state, [demo(4, now - 50), demo(3, now - 100)], ctx());
assert.deepEqual(state.items.map(n => n.episode), [4], "the same episode never notifies twice");

state = N.dismissEpisode(state, 5, 4, now);
assert.equal(state.items.length, 0);
state = N.ingestAired(state, [demo(4, now - 50)], ctx());
assert.equal(state.items.length, 0, "watching it keeps it from coming back");
assert.equal(N.unreadCount(state), 0);

// Aired before the show was added to Watching: not a new episode.
state = N.ingestAired({ items: [], dismissed: [] }, [demo(4, now - 5000)], ctx({ addedAt: { 5: now - 10 } }));
assert.equal(state.items.length, 0);
state = N.ingestAired({ items: [], dismissed: [] }, [demo(4, now - 5)], ctx({ addedAt: { 5: now - 10 } }));
assert.equal(state.items.length, 1);

// Dropping a show drops its notifications. They are not kept as "upcoming".
cleaned = N.cleanNotes({
  items: [{ mediaId: 5, episode: 4, airingAt: now - 5, title: "Demo" }],
  dismissed: [],
}, ctx({ watchingIds: new Set() }));
assert.equal(cleaned.items.length, 0);

// Poster air labels: relative inside a week, weekday when it's today, nothing once it has aired.
const today = new Date(2026, 9, 27, 15, 0, 0);
const laterToday = new Date(2026, 9, 27, 21, 0, 0);
const inTwo = new Date(2026, 9, 29, 18, 0, 0);
const inTen = new Date(2026, 10, 6, 18, 0, 0);
const wd = laterToday.toLocaleDateString("en-US", { weekday: "short" });
const md = inTen.toLocaleDateString("en-US", { day: "numeric", month: "short" });
assert.equal(N.airLabel(8, Math.floor(laterToday.getTime() / 1000), today.getTime(), "en-US"), "Ep 8 · " + wd);
assert.equal(N.airLabel(8, Math.floor(inTwo.getTime() / 1000), today.getTime(), "en-US"), "Ep 8 in 2d");
assert.equal(N.airLabel(8, Math.floor(inTen.getTime() / 1000), today.getTime(), "en-US"), "Ep 8 · " + md);
assert.equal(N.airLabel(8, Math.floor(today.getTime() / 1000) - 60, today.getTime(), "en-US"), "");
assert.equal(N.airLabel(0, Math.floor(inTwo.getTime() / 1000), today.getTime(), "en-US"), "");

console.log("notify rules passed");
