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

  /** Comma-separated provider ids (built-in) or absolute paths to provider modules. */
  providers: list(env.PROVIDERS, ['youtube']),

  stream: {
    /** Seconds of media the client may buffer ahead before the server pauses ffmpeg. */
    bufferAhead: num(env.BUFFER_AHEAD, 10),
    maxHeight: num(env.MAX_HEIGHT, 1080),
    defaultHeight: num(env.DEFAULT_HEIGHT, 720),
    /** Multiplies the per-resolution video bitrate table in stream/transcoder.js. */
    bitrateScale: num(env.BITRATE_SCALE, 1),
    audioBitrate: env.AUDIO_BITRATE || '160k',
    ffmpegThreads: num(env.FFMPEG_THREADS, 0),
    maxConcurrent: num(env.MAX_STREAMS, 8),
  },

  bin: {
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    ytdlp: env.YTDLP_PATH || 'yt-dlp',
    chromium: env.CHROMIUM_PATH || 'chromium',
    xvfb: env.XVFB_PATH || 'Xvfb',
    xdotool: env.XDOTOOL_PATH || 'xdotool',
  },

  cacheDir: env.CACHE_DIR || '/tmp/mpeg-yt-cache',
  /** Persistent state: saved sign-in cookies. Mount it as a volume. */
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
    /**
     * Optional: path to a Netscape cookies.txt. Normally unnecessary - sign in from the
     * app instead, which saves cookies to CONFIG_DIR/youtube-cookies.txt.
     */
    cookiesFile: env.YTDLP_COOKIES || '',
    /** "Label=feed" pairs shown on the home page when signed in (yt-dlp feed keywords). */
    accountFeeds: list(env.YOUTUBE_FEEDS, [
      'Recommended=:ytrec',
      'Subscriptions=:ytsubs',
      'Watch later=:ytwatchlater',
      'Liked videos=:ytfav',
    ]),
    /** When signed in, report played videos to YouTube watch history (improves recommendations). */
    markWatched: /^(1|true|yes)$/i.test(env.YOUTUBE_MARK_WATCHED || ''),
    /** Explicitly configured topic shelves are kept even when signed in. */
    homeShelvesExplicit: !!env.YOUTUBE_HOME,
    extraArgs: list(env.YTDLP_EXTRA_ARGS, []),
    /** "Label=query" pairs used to build the home page shelves. */
    homeShelves: list(env.YOUTUBE_HOME, [
      'Trending=trending today',
      'Music=new music videos',
      'Gaming=gaming highlights',
      'Science & Tech=science technology explained',
    ]),
  },

  local: {
    mediaDir: env.MEDIA_DIR || '/media',
  },
};
