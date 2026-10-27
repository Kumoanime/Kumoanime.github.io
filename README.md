# Kumo

An anime browser and player for your phone. Show info and artwork come from [AniList](https://anilist.co). Episodes come from add-ons you install.

## Add-ons

Kumo speaks the open [Stremio add-on protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). Paste an add-on's `manifest.json` link under **Add-ons** to install it. Anime episodes are requested with Kitsu ids (`kitsu:<id>:<episode>`), then MAL, then AniList ids.

Each show page has a **Trailer** button that plays the official trailer from YouTube.

## Real-Debrid on iPhone

Safari cannot play the MKV files Real-Debrid returns, so those sources used to sit on a black screen, spin, or play the add-on's short error clip. Kumo now skips that clip, prefers sources marked cached (the lightning bolt), and asks Real-Debrid for an HLS stream Safari can play.

Real-Debrid's API does not allow browser calls. Deploy `rd-proxy/worker.js` (Cloudflare Worker: `npx wrangler deploy` inside `rd-proxy/`), then on the Add-ons page paste the worker's address. Redeploy that worker when `worker.js` changes. Kumo follows Comet's playback link through the worker's `/resolve` path, then asks Real-Debrid to transcode the file Comet already unrestricted. If the Comet or Torrentio install link still contains your key, Kumo uses that; otherwise paste a token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken). The token stays in the browser. The proxy does not carry the video.

Until that proxy is saved, a source can still be opened in VLC or Infuse from the player message. Those apps can play the original file.

## Repositories

A repository is a JSON file that lists add-ons:

```json
{ "name": "My repo", "addons": ["https://example.com/manifest.json"] }
```

## Install on iPhone

Open the site in Safari, tap **Share**, then **Add to Home Screen**.
