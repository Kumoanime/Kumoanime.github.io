"use strict";
const assert = require("assert");
const B = require("../browse.js");

assert.equal(B.listStatus(null), "");
assert.equal(B.listStatus({}), "watching");
assert.equal(B.listStatus({ status: "nope" }), "watching");
assert.equal(B.listStatus({ status: "planning" }), "planning");
assert.equal(B.isWatching({ status: "planning" }), false);
assert.equal(B.isWatching({}), true);
assert.equal(B.isWatching(null), false);
assert.equal(B.statusByRoute("hold").id, "hold");
assert.equal(B.statusByRoute("").id, "watching");

const bounds = B.weekBounds(Date.UTC(2026, 9, 28, 12, 0, 0));
assert.equal(new Date(bounds.startMs).getDay(), 1, "week starts Monday");
assert.equal(bounds.to - (bounds.from + 1), 7 * 86400);
assert.equal(B.weekDays(Date.UTC(2026, 9, 28, 12, 0, 0)).length, 7);

const grouped = B.groupSchedules([
  { airingAt: bounds.from + 3600, episode: 1 },
  { airingAt: bounds.from + 7200, episode: 2 },
  { airingAt: bounds.from + 86400 + 10, episode: 3 },
]);
assert.equal(grouped.length, 2);
assert.deepEqual(grouped[0].items.map(row => row.episode), [1, 2]);

assert.equal(B.seriesIdFromSearch({ items: [{ id: 33 }] }), 33);
assert.equal(B.seriesIdFromSearch({ items: [] }), null);
assert.deepEqual(B.fillerNumbers([
  { episode_number: 1, status: "canon" },
  { episode_number: 26, status: "filler" },
  { episode: 2, status: "mixed" },
]), { "26": true });
assert.deepEqual(B.fillerNumbers({ episodes: [{ episode: 4, type: "filler" }, { episode: 5, type: "manga-canon" }] }), { "4": true });
assert.equal(B.fillerNumbers({ nope: true }), null);

const readme = "| [`death-note.json`](./data/shows/death-note.json) | Death Note | 1535 | 37 |\n| [`naruto.json`](./data/shows/naruto.json) | Naruto | 20 | 220 |";
assert.equal(B.fillerFile(readme, 20), "naruto.json");
assert.equal(B.fillerFile(readme, 999), "");

assert.equal(B.recTitle("watching", "Naruto"), "Because you watched Naruto");
assert.equal(B.recTitle("completed", "Naruto"), "Because you watched Naruto");
assert.equal(B.recTitle("planning", "Naruto"), "Related");
assert.equal(B.recTitle("", "Naruto"), "Related");

console.log("browse.test.js ok");
