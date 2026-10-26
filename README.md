# Kumo

An anime browser and player for your phone. Show info and artwork come from [AniList](https://anilist.co). Episodes come from add-ons you install.

## Add-ons

Kumo speaks the open [Stremio add-on protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). Paste an add-on's `manifest.json` link under **Add-ons** to install it. Anime episodes are requested with Kitsu ids (`kitsu:<id>:<episode>`), then MAL, then AniList ids.

Built in: **Official trailers**, which plays each show's trailer from YouTube.

## Repositories

A repository is a JSON file that lists add-ons:

```json
{ "name": "My repo", "addons": ["https://example.com/manifest.json"] }
```

## Install on iPhone

Open the site in Safari, tap **Share**, then **Add to Home Screen**.
