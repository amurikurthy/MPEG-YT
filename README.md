# MPEG-YT

A self-hosted, tablet-first YouTube browser. The interface is a fast, native web app, not
a streamed remote browser. **Only the video itself** goes through the streaming pipeline:

```
YouTube (via yt-dlp)
   └─► ffmpeg ─ MPEG-1 video + MP2 audio in MPEG-TS ─► WebSocket ─► JSMpeg (WASM) ─► WebGL <canvas>
                                                                              └─► Web Audio
```

There is no `<video>` element anywhere in the client.

## Run it

GitHub Actions builds the image for **amd64 and arm64** (so it runs on a Raspberry Pi too) and publishes it to
`ghcr.io/amurikurthy/mpeg-yt`. You only need [`docker-compose.yml`](docker-compose.yml):

```bash
mkdir mpeg-yt && cd mpeg-yt
curl -fsSLO https://raw.githubusercontent.com/amurikurthy/mpeg-yt/main/docker-compose.yml
docker compose up -d
```

Open `http://<host>:8080`.

Update with `docker compose pull && docker compose up -d`. The image is rebuilt on every push to `main` and
weekly, which keeps yt-dlp current with YouTube changes. Tags: `latest`, `sha-<commit>`, and `1.2.3` / `1.2` for
`v1.2.3` git tags. To build locally instead, uncomment `build: .` in the compose file and run
`docker compose up -d --build`.

On a tablet, use **Share → Add to Home Screen** (iPad) or **Install app** (Android/Chrome).
It then opens full-screen without browser chrome.

## Behind a reverse proxy (Pangolin, Traefik, Caddy, nginx…)

- **Target:** the proxy needs to reach the container on port **8080**. If the proxy (or Pangolin's
  **Newt**) runs in the same compose project, use the service name, e.g. `http://mpeg-yt:8080`, and you
  don't need a `ports:` mapping. Only publish `8080:8080` if something outside Docker must connect.
- **WebSockets** must be allowed. Video and the sign-in screen use them under `/api/`. Pangolin,
  Traefik and Caddy pass them through by default; nginx needs the usual `Upgrade`/`Connection` headers.
- **Health check:** `GET /healthz` returns `{"ok":true}`.
- The proxy's own login (e.g. Pangolin SSO) works as normal: the page and its WebSockets carry the proxy's
  session cookie.

Example with Pangolin's Newt in the same compose file:

```yaml
services:
  mpeg-yt:
    image: ghcr.io/amurikurthy/mpeg-yt:latest
    volumes: [./config:/config, ./cache:/cache]
    shm_size: "512mb"
    restart: unless-stopped
  newt:
    image: fosrl/newt
    restart: unless-stopped
    environment:
      PANGOLIN_ENDPOINT: https://pangolin.example.com
      NEWT_ID: ${NEWT_ID}
      NEWT_SECRET: ${NEWT_SECRET}      # keep in a .env file, not in the compose file
```

In Pangolin, set the resource target to **`http` → host `mpeg-yt` → port `8080`**, with health check
path `/healthz`.

## Features

- **YouTube browsing:** home shelves, search with suggestions and infinite scroll, channels, playlists, related videos, and your own feeds when signed in.
- **Stream settings** under the ⚙ button or the `720p HD` badge:
  - **Resolution:** 240p up to the source resolution, capped by `MAX_HEIGHT`.
  - **Frame rate:** *Auto* (source rate) or 24/25/30/50/60 fps. These are the rates MPEG-1 allows. Rates above the source are hidden; for YouTube, 50/60 picks a high-frame-rate source.
  - **Quality:** Data saver / Standard / High / Max, which set the bitrate (scaled by resolution and fps).
  - A live stats line shows resolution, fps, bitrate, seconds buffered and startup time.
- **Smooth playback.** Normal JSMpeg setups are tuned for low-latency live streaming. Here, the video is synced to the audio clock and buffers ahead. The player reports how much it has buffered, and the server pauses or resumes reading ffmpeg's output, so ffmpeg runs only as needed and uses no CPU while you're paused.
- **Fast:**
  - **Prefetch:** stream URLs are resolved on hover, or on touch-down on tablets.
  - **Startup:** the first frame typically arrives in 150–600 ms once the stream URL is resolved (prefetching usually does this before the tap).
  - **Seeking:** the new frame shows in about 250 ms, with no black flash (the old frame stays up until the new stream decodes).
  - **Navigation:** responses are cached, so going back is instant.
- **Tablet-first touch UI:**
  - **Taps:** tap shows or hides the controls; a large centre button plays and pauses.
  - **Double-tap the left or right side:** skip ∓10 s. Keep tapping to add more (+20, +30…); a single seek happens at the end.
  - **Double-tap the middle:** fullscreen. **Swipe down:** exit fullscreen.
  - **Layout:** 48 px touch targets, carousels with the next card peeking in, related videos as a 2-up grid in portrait and a side column in landscape, safe-area insets.
- **Dark mode** by default, with a light theme toggle in the top bar.
- **Keyboard** (desktop, or an iPad with a keyboard): `space`/`k` play/pause, `j`/`l` ∓10 s, `←`/`→` ∓5 s, `↑`/`↓` volume, `m` mute, `f` fullscreen, `0`–`9` jump to that tenth of the video, `/` search.
- Continue watching (stored per device), up-next autoplay, optional shared-token auth.

## How audio works

ffmpeg encodes the audio as **MP2** and muxes it into the same MPEG-TS stream as the MPEG-1 video, over one WebSocket. JSMpeg demuxes the stream, decodes the MP2 in WebAssembly and schedules the samples through the **Web Audio API**. The audio clock is the master clock: each video frame is shown when the audio reaches its timestamp, which keeps lip-sync tight.

Browsers block audio until the user interacts with the page. The first tap or click unlocks it; if it's still blocked, a **Tap to unmute** button appears. Pausing suspends the audio context, so resuming continues exactly where it stopped.

## Signing in (your recommendations)

Tap the **account button** in the top bar, or **Sign in** on the home page, then **Sign in with Google**.

- A temporary Chromium starts **inside the container** on Google's sign-in page. It's streamed to your screen through the same MPEG-1 → JSMpeg canvas pipeline as videos. Tap the page to click, drag to scroll, and type with the bar at the bottom (Tab, ⌫, Enter and Back buttons are there too). Passwords, 2FA prompts and account pickers all work as on any website.
- When Google sends you back to YouTube, MPEG-YT notices automatically. You can also tap **Done**. It then extracts the YouTube session cookies, saves them to `/config/youtube-cookies.txt` (mode 600, YouTube/Google cookies only), and **deletes the browser and its profile**.
- The home page then shows **Recommended**, **Subscriptions**, **Watch later** and **Liked videos** (configurable with `YOUTUBE_FEEDS`). Set `YOUTUBE_MARK_WATCHED=1` to add what you play to your YouTube history, so recommendations keep tracking what you watch here.
- **Sign out** in the same menu deletes the saved session.

Fallback: if Google refuses the embedded sign-in (it sometimes does for unfamiliar devices or server IPs), choose **Or upload a cookies.txt file** and upload YouTube cookies exported from your normal browser, e.g. with a "Get cookies.txt LOCALLY" extension.

Notes:
- Signed-in access also helps playback. YouTube increasingly blocks anonymous requests from server and VPN IPs ("Sign in to confirm you're not a bot"), and a signed-in session avoids that.
- Your session lives on the server, so anyone who can open your MPEG-YT can use it. Set `AUTH_TOKEN` if the server is reachable beyond your own network.
- Google sometimes flags automated access to accounts; a secondary account is the cautious choice.

## Configuration

| Variable | Default | |
|---|---|---|
| `PROVIDERS` | `youtube` | Enabled sources: built-in ids or absolute paths to provider modules |
| `DEFAULT_HEIGHT` / `MAX_HEIGHT` | `720` / `1080` | Output resolution default and cap |
| `BITRATE_SCALE` | `1` | Multiplies all bitrate presets |
| `AUDIO_BITRATE` | `160k` | MP2 bitrate |
| `BUFFER_AHEAD` | `10` | Seconds the client may buffer before ffmpeg is paused |
| `MAX_STREAMS` | `8` | Concurrent transcodes |
| `FFMPEG_THREADS` | auto | |
| `AUTH_TOKEN` | — | If set, open `/?token=…` once; a cookie is then set |
| `PUID` / `PGID` | `1000` / `1000` | User/group the app runs as; `/config` and `/cache` are chowned to it at start |
| `CONFIG_DIR` | `/config` | Where the sign-in session is saved; mount it as a volume |
| `LOGIN_BROWSER` | on | `0` disables in-app sign-in (cookies.txt upload still works) |
| `YTDLP_COOKIES` | — | Use a cookies.txt you manage yourself instead of in-app sign-in |
| `YOUTUBE_FEEDS` | Recommended, Subscriptions, Watch later, Liked | `Label=:ytfeed` pairs shown when signed in |
| `YOUTUBE_HOME` | 4 topic shelves | `Label=search query` pairs shown when signed out (or always, if set) |
| `YOUTUBE_MARK_WATCHED` | off | Add played videos to your YouTube watch history |
| `YTDLP_EXTRA_ARGS` | — | Comma-separated extra yt-dlp flags |

## Adding a platform later (e.g. Plex)

MPEG-YT is YouTube-only for now, but sources are pluggable **providers**: one file each, implementing a small normalized contract documented in [`server/src/providers/base.js`](server/src/providers/base.js). The UI, the API and the streaming pipeline never know which platform they're talking to.

```js
// server/src/providers/plex.js
const { Provider } = require('./base');

class PlexProvider extends Provider {
  static id = 'plex';
  static displayName = 'Plex';

  async init() { /* read PLEX_URL / PLEX_TOKEN, verify connectivity */ }
  async home() { /* On Deck, Recently Added, libraries → Shelf[] */ }
  async search(q) { /* /hubs/search → { items: Item[] } */ }
  async collection(id) { /* library / show / season → { title, items } */ }
  async item(id) { /* metadata → Detail (qualities, sourceFps, duration…) */ }
  async thumbnail(id) { /* proxy artwork so the token never reaches the browser */ }
  async resolve(id) {
    // Any input ffmpeg can read: the part's direct-play URL is ideal.
    return { inputs: [{ url: `${base}/library/parts/…?X-Plex-Token=…`, hasVideo: true, hasAudio: true }],
             duration, fps, sourceHeight, seekable: true };
  }
}
module.exports = PlexProvider;
```

A second, disabled-by-default provider, [`local.js`](server/src/providers/local.js), plays files from a folder. It's a compact reference implementation and a handy way to test the pipeline without YouTube: set `PROVIDERS=youtube,local`, `MEDIA_DIR=/media` and mount a folder. With more than one provider enabled, the UI shows source tabs automatically.

Enable a new provider with `PROVIDERS=youtube,plex`, or mount it anywhere and use an absolute path (`PROVIDERS=youtube,/plugins/plex.js`). The UI shows only what a provider implements: the capabilities come from the methods it overrides. Only `item` and `resolve` are required.

## Project layout

```
server/src/
  index.js              HTTP server, static files, WebSocket upgrade, auth
  api.js                REST: /api/providers, /api/p/<provider>/{home,search,suggest,item,related,collection,thumb}
  providers/            base.js (contract) · youtube.js · local.js (reference, off by default) · index.js (registry)
  stream/transcoder.js  resolution / frame-rate / bitrate planning, ffmpeg arguments
  stream/session.js     one WebSocket = one ffmpeg; flow control
  login/browser-session.js  temporary sign-in browser: Xvfb + Chromium → ffmpeg x11grab → JSMpeg, xdotool input
public/
  js/player.js          custom JSMpeg source, timed playback, canvas swap, touch gestures, settings
  js/app.js             router, search + suggestions, provider tabs, theme
  js/account.js         account sheet, cookies.txt upload, remote sign-in screen
  js/views/             home · search · watch · collection
  vendor/jsmpeg.min.js  JSMpeg (MIT, phoboslab/jsmpeg)
```

## Limitations

- **CPU:** MPEG-1 is inefficient. 720p30 Standard is about 3 Mbit/s, and each viewer costs one ffmpeg transcode. Use `MAX_STREAMS` and `MAX_HEIGHT` to fit your hardware.
- **Picture-in-picture and background audio:** neither is available. Both depend on `<video>`, which this design deliberately avoids.
- **iPhone fullscreen:** iPhone Safari has no element fullscreen, so the player uses a full-window overlay instead. Installing to the home screen gives the cleanest result. iPad and Android use real fullscreen.
- **Keeping YouTube working:** YouTube changes often. Rebuild the image to update yt-dlp (`docker compose build --pull`).
