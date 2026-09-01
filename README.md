# 💎 Diamond Operatore Player

A privacy-first, **pure-static** IPTV web player. Paste one IPTV URL, press Load, and browse **Live TV, Movies, Series and Radio** entirely in your browser - no backend, no accounts, no tracking.

- **Live app:** [diaop.de](https://diaop.de)
- **Source:** [github.com/Lamhour-Mohamed-Akram/diaop-player](https://github.com/Lamhour-Mohamed-Akram/diaop-player)
- **Privacy & disclaimer:** [policies.html](policies.html)

## How it works

```text
Paste IPTV URL → Load → Dashboard → Live TV / Movies / Series / Radio
                                     → Categories → Items → Player
```

One input accepts three kinds of URLs:

1. **Xtream-style M3U URL** - `http://server/get.php?username=U&password=P&type=m3u_plus&output=m3u8`
   The server, username and password are extracted **in memory** and the provider's `player_api.php` is used directly: provider categories, posters, movie/series descriptions, and proper series → seasons → episodes navigation. If the API is unreachable, the app falls back to fetching the M3U itself.
2. **Plain M3U/M3U8 playlist URL** - parsed client-side. Entries are classified into Live TV / Movies / Series / Radio from group names (multi-language keywords), URL hints and `SxxEyy` patterns; series are grouped into seasons and episodes.
3. **Direct stream URL** (`…/channel.m3u8`) - opens the player immediately.

Playback uses [hls.js](https://github.com/video-dev/hls.js) where needed, native HLS on Safari, and plain `<video>` for directly playable files.

## Features

- **In-browser MKV / Dolby playback** - MKV/AVI containers and Dolby (AC-3/E-AC-3) audio are handled fully client-side by a vendored [playsvideo](https://github.com/kzahel/playsvideo) engine (remux to fMP4 + wasm audio transcode). No server, no helper needed.
- **Single-connection movie streaming** - strict IPTV panels allow only ONE connection per movie file. For those, a sequential pipeline (`js/pv/single-stream.js`) streams the whole file through one open request: Mediabunny sequential demux, video passthrough, audio → AAC in-browser, fMP4 → MediaSource. Full seeking (one reconnection per seek, Matroska cluster + keyframe resync), auto-resume after CDN drops, and bounded memory. Engages automatically when the strict-panel pattern is detected.
- **Embedded subtitles** - text subtitle tracks (SRT/ASS) inside MKV files are extracted on the fly and offered in the caption picker, in sync with the browser's own CC menu.
- **Audio & subtitle track pickers**, per-stream Restart/Stop, movie & series descriptions from the provider API, season dropdowns, search, connection-limit awareness (polls the provider API and waits for a free slot instead of hammering).
- **Responsive** - phone-friendly layout: sequential navigation, category dropdown, touch-sized controls. iPhone Safari is supported via ManagedMediaSource (iOS 17.1+).
- **Session persistence** - the playlist URL (localStorage) and parsed playlist (IndexedDB) stay in your browser so a reload is instant; **Change Playlist** wipes everything.

## Privacy

- **No backend, no accounts, no analytics, no cookies, no telemetry.**
- Requests go only to your IPTV provider (plus cdnjs.cloudflare.com for hls.js). There is **no CORS proxy** - nothing is ever routed through third parties.
- Credentials are never logged to the console, and untrusted playlist/container metadata is sanitized before display.

## Run locally

Browsers restrict `fetch()` on `file://` pages, so serve the folder with any static server:

```sh
python3 -m http.server 9898
# then open http://localhost:9898
```

## Deploy

It's just static files - upload the folder to Netlify, GitHub Pages, Cloudflare Pages, or any web server. No build step.

> **HTTP providers - zero user action.** Most IPTV providers serve over plain HTTP, and a page hosted on **HTTPS cannot load HTTP streams** (browsers forbid mixed content). The app resolves this by itself: it first tries the provider over https (many panels support both); if the provider is http-only, it **hops to the plain-HTTP edition of this same app** (`http://diaop.de`, GitHub Pages with HTTPS not enforced), carrying the playlist URL in a `#fragment` that never leaves the browser, and connects there automatically. Nobody installs, downloads, or configures anything.

## Developer tools

`tools/audio-helper.py` is a small development utility (localhost relay + ffmpeg audio fallback) used by the test harness. It is never required: the web app is fully self-contained.

## Known limitations

- Providers that do not send CORS headers cannot be fetched by any browser page; the app explains this instead of proxying around it - by design.
- HTTP 458/509 responses mean the account's **max simultaneous connections** is in use - the app polls the provider API and reconnects when the slot frees.
- Image-based subtitles (PGS/VobSub) cannot be rendered as text and are not listed in the caption picker.
- EPG is not included yet.

## Project structure

```text
index.html          app shell (screens, no inline JS)
policies.html       privacy & disclaimer
css/styles.css      dark TV-style theme (responsive)
js/playlist.js      M3U parser, classifier, series grouping
js/xtream.js        Xtream Codes API client + URL auto-detection
js/player.js        playback orchestration (hls.js / native / engines)
js/app.js           state, SPA navigation, rendering
js/pv/              vendored in-browser engines (playsvideo MIT + single-stream pipeline)
js/vendor/          ffmpeg-core wasm audio decoder
tools/              optional local audio helper
```

## License

GPL-3.0 - see [LICENSE](LICENSE).

Bundled third-party components: [playsvideo](https://github.com/kzahel/playsvideo) (MIT), [Mediabunny](https://github.com/Vanilagy/mediabunny), [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0), ffmpeg-core wasm audio decoders (LGPL).
