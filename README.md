# Kumo

An anime browser and player for your phone. Show info and artwork come from [AniList](https://anilist.co). Episodes come from add-ons you install.

## Add-ons

Kumo speaks the open [Stremio add-on protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). Paste an add-on's `manifest.json` link under **Add-ons** to install it. Anime episodes are requested with Kitsu ids (`kitsu:<id>:<episode>`), then MAL, then AniList ids.

Each show page has a **Trailer** button that plays the official trailer from YouTube.

## Real-Debrid on iPhone

Safari cannot play the MKV files Real-Debrid returns. Kumo hides uncached sources and links that come back as Comet's error slate until you turn on **Show all sources**. A cached source that cannot play in the page opens in Infuse, VLC, or Outplayer (the choice is on the watch page). That choice is remembered, and a source that failed stays greyed out on the next visit.

Public ElfHosted Comet ties each playback link to the phone that loaded the list ([wrong IP](https://docs.elfhosted.com/m/wrong-ip)). The download host does not send CORS headers, so the page cannot read the file id and cannot start HLS itself. Infuse or VLC on that same phone can. In-app playback needs a private or self-hosted Comet, or AIOStreams, whose links are not locked to one IP — or another add-on such as Torrentio — plus the proxy below.

Real-Debrid's API does not allow browser calls. Deploy `rd-proxy/worker.js` (Cloudflare Worker: `npx wrangler deploy` inside `rd-proxy/`), then on the Add-ons page paste the worker's address. Redeploy that worker when `worker.js` changes. The worker asks Real-Debrid to transcode a file id when one is known, and it can follow a private Comet link. It cannot follow a public ElfHosted link. Kumo does not call `addMagnet` for these files. If the Comet or Torrentio install link still contains your key, Kumo uses that; otherwise paste a token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken). The token stays in the browser. The proxy does not carry the video.

## Repositories

A repository is a JSON file that lists add-ons:

```json
{ "name": "My repo", "addons": ["https://example.com/manifest.json"] }
```

## Install on iPhone

Open the site in Safari, tap **Share**, then **Add to Home Screen**.
