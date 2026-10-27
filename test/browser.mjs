"use strict";
// Loads Kumo, installs a fixture add-on, and checks that a Real-Debrid
// error clip is skipped in favour of a file the browser can play.
import http from "http";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const puppeteer = require("/tmp/pw/node_modules/puppeteer-core");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MEDIA = "/tmp/kumo-media";
const HASH = "0123456789abcdef0123456789abcdef01234567";

function typeOf(file) {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const manifest = {
  id: "com.kumo.fixture", version: "1.0.0", name: "Test Debrid", description: "fixture",
  resources: ["stream"], types: ["series", "anime", "movie"], catalogs: [],
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (u.pathname === "/addon/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifest));
    return;
  }
  if (u.pathname.startsWith("/addon/stream/")) {
    const streams = {
      streams: [
        {
          name: "[RD⚡] Comet 1080p",
          description: "error clip",
          url: `http://127.0.0.1:${port}/playback/${HASH}/0/1/1/1?name=Ep`,
          behaviorHints: { filename: "Show.S01E01.1080p.mkv" },
        },
        {
          name: "[RD⚡] Comet 720p",
          description: "playable",
          url: `http://127.0.0.1:${port}/media/episode.mp4`,
          behaviorHints: { filename: "Show.S01E01.mp4" },
        },
        {
          name: "[RD⬇️] Comet 480p",
          description: "uncached",
          url: `http://127.0.0.1:${port}/media/episode.mp4?uncached=1`,
          behaviorHints: { filename: "Show.S01E01.480p.mkv" },
        },
      ],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(streams));
    return;
  }
  if (u.pathname.startsWith("/playback/")) {
    const body = fs.readFileSync(path.join(MEDIA, "status.mp4"));
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
    res.end(body);
    return;
  }
  if (u.pathname.startsWith("/media/")) {
    const body = fs.readFileSync(path.join(MEDIA, path.basename(u.pathname)));
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length, "Accept-Ranges": "bytes" });
    res.end(body);
    return;
  }
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": typeOf(file) });
  fs.createReadStream(file).pipe(res);
});

let port;
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
console.log("serving", origin);

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("kumo.playerPrefs", JSON.stringify({ autoNext: false, autoPlay: true, autoSkip: false }));
});
page.on("pageerror", err => console.log("pageerror", err.message));
page.on("console", msg => { if (msg.type() === "error") console.log("console", msg.text()); });

await page.goto(origin + "/#/addons", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#addonUrl");
await page.waitForFunction(() => !document.getElementById("splash"), { timeout: 5000 });
await page.type("#addonUrl", origin + "/addon/manifest.json");
await page.click("#addonForm button");
await page.waitForFunction(() => document.body.innerText.includes("Test Debrid"), { timeout: 10000 });
await page.evaluate(() => localStorage.setItem("kumo.playerPrefs", JSON.stringify({ autoNext: false, autoPlay: true, autoSkip: false })));

await page.goto(origin + "/#/watch/1/1", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  const err = document.querySelector(".err");
  return (v && v.readyState >= 2 && v.currentSrc.includes("episode.mp4")) || (err && /blocked|won't play|Safari/i.test(err.textContent));
}, { timeout: 25000 });

const result = await page.evaluate(() => {
  const v = document.querySelector("video");
  return {
    src: v ? v.currentSrc : "",
    ready: v ? v.readyState : 0,
    width: v ? v.videoWidth : 0,
    duration: v ? v.duration : 0,
    err: document.querySelector(".err")?.textContent || "",
    status: document.querySelector("#wtStatus")?.textContent || "",
    labels: [...document.querySelectorAll(".wt-src .nm")].map(n => n.textContent),
    showAll: [...document.querySelectorAll(".wt-toggle")].some(b => b.textContent.includes("Show all sources")),
    player: document.querySelector("#extPlayer")?.value || "",
  };
});
console.log(JSON.stringify(result, null, 2));

let blocked = "";
try {
  if (!result.showAll || result.player !== "infuse") {
    console.error("expected Show all sources and Infuse as the outside player");
    process.exitCode = 1;
  } else if (result.labels.some(n => n.includes("480p"))) {
    console.error("uncached source should be hidden until Show all sources");
    process.exitCode = 1;
  } else if (!result.src.includes("episode.mp4") || result.ready < 2 || !result.width) {
    console.error("expected the playable MP4, got the result above");
    process.exitCode = 1;
  } else if (result.src.includes("/playback/")) {
    console.error("player stayed on the debrid error clip");
    process.exitCode = 1;
  } else {
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.pause(); });
    const showAll = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".wt-toggle")].find(b => b.textContent.includes("Show all sources"));
      btn.click();
      return [...document.querySelectorAll(".wt-src")].map(b => ({
        name: b.querySelector(".nm").textContent,
        bad: b.classList.contains("bad"),
        note: b.querySelector("small").textContent,
      }));
    });
    console.log("after show all", JSON.stringify(showAll));
    const uncached = showAll.find(r => r.name.includes("480p"));
    const blockedRow = showAll.find(r => r.name.includes("1080p"));
    if (!uncached) {
      console.error("Show all sources did not reveal the uncached link");
      process.exitCode = 1;
    } else if (!blockedRow?.bad || !/Blocked by Real-Debrid/.test(blockedRow.note || "")) {
      console.error("a slate should stay listed as blocked and greyed when Show all is on");
      process.exitCode = 1;
    }
    await page.evaluate(async () => {
      const s = {
        name: "[RD⚡] Comet 1080p",
        url: location.origin + "/playback/0123456789abcdef0123456789abcdef01234567/0/1/1/1?name=Ep",
        behaviorHints: { filename: "Show.S01E01.mkv" },
      };
      const info = { label: "Blocked", key: "blocked", title: "Blocked", short: "Episode 1", route: "#/a/1" };
      await playFromList([{ a: { key: "x" }, s, audio: "sub" }], 0, info, document.querySelector("#watchStage"));
    });
    blocked = await page.evaluate(() => document.querySelector(".err")?.innerText || "");
    console.log("blocked-only message:", blocked.replace(/\s+/g, " ").slice(0, 240));
    if (!/blocked these files/i.test(blocked)) {
      console.error("expected the Real-Debrid blocked message");
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (process.exitCode) process.exit(process.exitCode);
console.log("browser playback check passed");
