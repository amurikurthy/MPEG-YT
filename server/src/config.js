'use strict';
const path = require('path');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? +v : d);
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

module.exports = {
  port: num(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  publicDir: path.resolve(__dirname, '../../public'),

  /** Optional shared secret. If set, open the UI once with ?token=<secret>. */
  authToken: env.AUTH_TOKEN || '',

  /** Everything is streamed as MPEG-1 at up to 720p and 30 fps. */
  stream: {
    maxHeight: 720,
    maxFps: 30,
    videoKbps: num(env.VIDEO_BITRATE_KBPS, 3500),
    audioBitrate: env.AUDIO_BITRATE || '192k',
    /**
     * Loudness target in LUFS. Other apps (Spotify, YouTube's own app) play around
     * -14 LUFS; a little louder by default because MPEG-YT has no OS-level boost.
     * Set AUDIO_NORMALIZE=0 to pass audio through at its original level.
     */
    loudnessTarget: num(env.AUDIO_LOUDNESS, -12),
    normalizeAudio: !/^(0|false|no)$/i.test(env.AUDIO_NORMALIZE || ''),
    /** Seconds the client may buffer ahead before ffmpeg is paused (rides out network/CPU hiccups). */
    bufferAhead: num(env.BUFFER_AHEAD, 30),
    ffmpegThreads: num(env.FFMPEG_THREADS, 0),
    maxConcurrent: num(env.MAX_STREAMS, 8),
  },

  bin: {
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ytdlp: env.YTDLP_PATH || 'yt-dlp',
    chromium: env.CHROMIUM_PATH || 'chromium',
    xvfb: env.XVFB_PATH || 'Xvfb',
    xdotool: env.XDOTOOL_PATH || 'xdotool',
  },

  cacheDir: env.CACHE_DIR || '/tmp/mpeg-yt-cache',
  /** Persistent state: the saved sign-in. Mount it as a volume. */
  configDir: env.CONFIG_DIR || '/config',

  /** In-app sign-in browser (see login/browser-session.js). */
  login: {
    enabled: !/^(0|false|no)$/i.test(env.LOGIN_BROWSER || ''),
    width: num(env.LOGIN_WIDTH, 1024),
    height: num(env.LOGIN_HEIGHT, 768),
    display: num(env.LOGIN_DISPLAY, 87),
    idleTimeoutMs: num(env.LOGIN_IDLE_TIMEOUT, 300) * 1000,
  },

  youtube: {
    lang: env.YT_LANG || 'en',
    location: env.YT_LOCATION || 'US',
    /** Optional: a cookies.txt you manage yourself instead of signing in from the app. */
    cookiesFile: env.YTDLP_COOKIES || '',
    extraArgs: list(env.YTDLP_EXTRA_ARGS, []),
    /** When signed in, report played videos to YouTube watch history. On by default, like YouTube. */
    markWatched: !/^(0|false|no)$/i.test(env.YOUTUBE_MARK_WATCHED || ''),
  },
};
