'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TTLCache } = require('../util/cache');
const { run, runJson } = require('../util/exec');
const { HttpError } = require('./account');
const { SourceCache } = require('../stream/source-cache');

const YT = 'https://www.youtube.com';
const VCODEC_PREF = ['avc1', 'vp09', 'vp9', 'av01']; // cheapest to decode first
const WARM_BYTES = 1024 * 1024; // prefetch: first ~1 MB of video and audio

/**
 * Keeps yt-dlp loaded in one Python process (see ytdlp_worker.py) instead of
 * starting it per video - roughly halves the time to resolve a video.
 */
class YtdlpWorker {
  constructor(python, args) {
    this.python = python;
    this.args = args;
    this.pending = new Map();
    this.seq = 0;
    this.start();
  }

  start() {
    const script = path.join(__dirname, 'ytdlp_worker.py');
    this.proc = spawn(this.python, [script, JSON.stringify(this.args)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => {
      this.onReady = resolve;
      this.proc.once('error', reject);
      setTimeout(() => reject(new Error('yt-dlp worker did not start')), 20_000).unref();
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready) {
          this.onReady(msg.version);
          continue;
        }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.info);
        else p.reject(new Error(`yt-dlp failed: ${msg.error}`));
      }
    });
    this.proc.stderr.on('data', () => {}); // errors come back per request
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('yt-dlp worker exited'));
      }
      this.pending.clear();
      if (!this.stopped) setTimeout(() => this.start(), 1000);
    });
  }

  extract(url, avoid = [], timeoutMs = 90_000) {
    return this.ready.then(() => new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('yt-dlp timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, url, avoid })}\n`);
    }));
  }

  stop() {
    this.stopped = true;
    this.proc.kill();
  }
}

/**
 * Resolves playable stream URLs with yt-dlp (it keeps up with YouTube's signature
 * and anti-bot changes far better than anything hand-rolled). Only formats up to
 * 720p / 30 fps are considered - that's all the MPEG-1 output needs. Sources go
 * through the local source cache, so seeks and re-watches read from disk.
 */
class Streams {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    // Stream URLs expire after ~6h; keep well under that.
    this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
    this.watched = new TTLCache({ ttlMs: 6 * 3600_000, max: 2000 });
    this.cache = new SourceCache(config);
    // YouTube clients whose links YouTube has been refusing (403), by the c= name in the link.
    this.refused = new Map(); // client name -> until (ms)
    this.cache.onRefused = (url) => this.noteRefused(url);
    this.worker = null;
  }

  async init() {
    await this.cache.init().catch((e) => {
      this.cache.enabled = false;
      console.warn(`[cache] disabled: ${e.message}`);
    });
    const v = (await run(this.config.bin.ytdlp, ['--version'], { timeoutMs: 15_000 })).trim();
    console.log(`[streams] yt-dlp ${v}`);
    this.python = await this.findPython();
    this.startWorker();
  }

  /** The Python that has yt-dlp installed (the venv next to the yt-dlp binary in the image). */
  async findPython() {
    const candidates = [process.env.YTDLP_PYTHON];
    try {
      const bin = (await run('sh', ['-c', `command -v ${this.config.bin.ytdlp}`], { timeoutMs: 5000 })).trim();
      const dir = path.dirname(fs.realpathSync(bin));
      candidates.push(path.join(dir, 'python3'), path.join(dir, 'python'));
    } catch { /* not on PATH */ }
    candidates.push('python3');
    for (const py of candidates.filter(Boolean)) {
      try {
        await run(py, ['-c', 'import yt_dlp'], { timeoutMs: 15_000 });
        return py;
      } catch { /* try next */ }
    }
    return null;
  }

  startWorker() {
    this.worker?.stop();
    this.worker = null;
    if (!this.python) {
      console.warn('[streams] yt-dlp Python module not found; using the yt-dlp command (slower)');
      return;
    }
    this.worker = new YtdlpWorker(this.python, this.baseArgs());
    this.worker.ready.then(() => console.log('[streams] yt-dlp worker ready')).catch((e) => {
      console.warn(`[streams] yt-dlp worker failed (${e.message}); using the yt-dlp command`);
      this.worker?.stop();
      this.worker = null;
    });
  }

  baseArgs() {
    const a = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node', '--cache-dir', path.join(this.config.cacheDir, 'yt-dlp')];
    if (this.account.signedIn) a.push('--cookies', this.account.cookiesFile);
    return [...a, ...this.config.youtube.extraArgs];
  }

  /** Sign-in changed: new cookies for everything. */
  reset() {
    this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
    if (this.python) this.startWorker();
  }

  /** Forget a video's resolved stream links (YouTube refused them); the next play re-resolves. */
  invalidate(id) {
    this.infos.delete(id);
  }

  /** YouTube refused a link: avoid the client that issued it for a while. */
  noteRefused(url) {
    let c = null;
    try {
      c = new URL(url).searchParams.get('c');
    } catch { /* not a URL */ }
    if (!c || !/^[A-Z0-9_]{2,40}$/.test(c)) return;
    if (!this.refused.has(c)) console.warn(`[streams] YouTube is refusing ${c} links; using other clients for a while`);
    this.refused.set(c, Date.now() + 6 * 3600_000);
  }

  /**
   * Clients to avoid. Signed in, yt-dlp asks the embedded-player client first,
   * and YouTube often refuses its links to servers - so skip it from the start.
   */
  avoidClients() {
    const now = Date.now();
    const out = new Set(this.account.signedIn ? ['WEB_EMBEDDED_PLAYER'] : []);
    for (const [c, until] of this.refused) {
      if (until > now) out.add(c);
      else this.refused.delete(c);
    }
    return [...out];
  }

  extract(url, avoid) {
    if (this.worker) return this.worker.extract(url, avoid);
    const args = [...this.baseArgs()];
    const keys = avoid.map((c) => CLIENT_KEYS[c]).filter(Boolean).flat();
    if (keys.length && !args.some((a) => a.includes('player_client'))) {
      args.push('--extractor-args', `youtube:player_client=${['default', ...keys.map((k) => `-${k}`)].join(',')}`);
    }
    return runJson(this.config.bin.ytdlp, [...args, '-J', '--no-playlist', url], { timeoutMs: 90_000 });
  }

  info(id) {
    if (!/^[\w-]{11}$/.test(id)) return Promise.reject(new HttpError(400, 'bad video id'));
    const url = `${YT}/watch?v=${id}`;
    return this.infos.wrap(id, async () => {
      const avoid = this.avoidClients();
      if (!avoid.length) return this.extract(url, []);
      // Without those clients some videos (e.g. age-restricted ones that only play
      // embedded) have nothing playable: then let yt-dlp choose as usual.
      try {
        const info = await this.extract(url, avoid);
        this.select(info);
        return info;
      } catch (e) {
        if (/private|members|removed|unavailable|not available/i.test(e.message)) throw e;
        return this.extract(url, []);
      }
    });
  }

  /**
   * Hover / Up-next prefetch: resolve the stream and download the first ~1 MB of
   * video and audio, so pressing play starts from local data.
   */
  prefetch(id) {
    this.info(id).then((info) => {
      if (!this.cache.enabled) return;
      const sel = this.select(info);
      for (const f of sel.cacheable) this.cache.warm(SourceCache.key(id, f.format_id), f.url, f.http_headers, WARM_BYTES);
    }).catch(() => {});
  }

  /** Pick formats: up to 720p / 30 fps video + best audio, or a muxed fallback. */
  select(info) {
    const all = (info.formats || []).filter((f) => f.url);
    // Formats from clients YouTube has been refusing, only as a last resort.
    const avoid = new Set(this.avoidClients());
    const clientOf = (f) => {
      try {
        return new URL(f.url).searchParams.get('c');
      } catch {
        return null;
      }
    };
    const preferred = avoid.size ? all.filter((f) => !avoid.has(clientOf(f))) : all;
    if (preferred.length < all.length) {
      try {
        return this.selectFrom(preferred, info);
      } catch { /* fall through to everything */ }
    }
    return this.selectFrom(all, info);
  }

  selectFrom(fmts, info) {
    const { maxHeight, maxFps } = this.config.stream;
    const live = info.live_status === 'is_live';
    const isHttp = (f) => f.protocol === 'https' || f.protocol === 'http';
    const codecRank = (f) => {
      const i = VCODEC_PREF.findIndex((c) => (f.vcodec || '').startsWith(c));
      return i < 0 ? 99 : i;
    };
    const fits = (f) => (f.height || 0) <= maxHeight + 8;
    // Prefer the tallest format that fits, then <=30 fps (no point decoding 60 to output 30),
    // then the cheapest codec, then the lowest bitrate.
    const rank = (a, b) =>
      (b.height || 0) - (a.height || 0) ||
      ((a.fps || 30) > maxFps + 1) - ((b.fps || 30) > maxFps + 1) ||
      codecRank(a) - codecRank(b) ||
      (a.tbr || 0) - (b.tbr || 0);

    if (!live) {
      const v = fmts.filter((f) => isHttp(f) && f.vcodec !== 'none' && f.acodec === 'none' && fits(f)).sort(rank)[0];
      const audio = fmts.filter((f) => isHttp(f) && f.acodec !== 'none' && f.vcodec === 'none')
        .sort((x, y) => (y.abr || 0) - (x.abr || 0));
      // Prefer the original-language track over dubs.
      const a = audio.find((f) => /original/i.test(f.format_note || '') || (f.language_preference ?? 0) >= 10)
        || audio.find((f) => (f.language_preference ?? 0) >= 0) || audio[0];
      if (v && a) return { live, video: v, audio: a, cacheable: [v, a] };
    }
    // Muxed fallback (live HLS, or videos without separate streams).
    const muxed = fmts.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none');
    const m = muxed.filter(fits).sort(rank)[0] || muxed.sort(rank).pop();
    if (!m) throw new HttpError(422, 'no playable format found');
    return { live, muxed: m, cacheable: !live && isHttp(m) ? [m] : [] };
  }

  async resolve(id) {
    const info = await this.info(id);
    this.markWatched(id);
    const sel = this.select(info);
    // ffmpeg opens its inputs one after another; fetch the start of every source in
    // parallel right now so neither waits on the network when ffmpeg gets to it.
    if (this.cache.enabled) {
      for (const f of sel.cacheable) this.cache.warm(SourceCache.key(id, f.format_id), f.url, f.http_headers, WARM_BYTES);
    }
    const input = (f, hasVideo, hasAudio) => {
      const cached = this.cache.enabled && sel.cacheable.includes(f);
      return {
        // Local URL through the source cache, or YouTube directly (live streams).
        url: cached ? this.cache.register(SourceCache.key(id, f.format_id), f.url, f.http_headers) : f.url,
        headers: cached ? undefined : f.http_headers,
        local: cached,
        cacheKey: cached ? SourceCache.key(id, f.format_id) : undefined,
        hasVideo,
        hasAudio,
      };
    };
    if (sel.video) {
      return {
        inputs: [input(sel.video, true, false), input(sel.audio, false, true)],
        duration: info.duration,
        fps: sel.video.fps,
        sourceHeight: sel.video.height,
        seekable: true,
      };
    }
    return {
      inputs: [input(sel.muxed, true, true)],
      duration: sel.live ? undefined : info.duration,
      fps: sel.muxed.fps,
      sourceHeight: sel.muxed.height,
      seekable: !sel.live,
      live: sel.live,
    };
  }

  /** Parts of a resolved stream already downloaded (all inputs), as [start, end] fractions. */
  coverage(media) {
    const keys = media.inputs.map((i) => i.cacheKey).filter(Boolean);
    if (!keys.length || keys.length !== media.inputs.length) return null;
    let acc = [[0, 1]];
    for (const k of keys) {
      const runs = this.cache.coverage(k);
      if (!runs) return null;
      // Intersect: a moment is playable from disk only if both video and audio are there.
      const out = [];
      for (const [a1, b1] of acc) {
        for (const [a2, b2] of runs) {
          const a = Math.max(a1, a2);
          const b = Math.min(b1, b2);
          if (b > a) out.push([a, b]);
        }
      }
      acc = out;
    }
    return acc.map(([a, b]) => [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4]);
  }

  /** Fire-and-forget: add a play to the signed-in account's YouTube history (once per 6h). */
  markWatched(id) {
    if (!this.account.signedIn || !this.config.youtube.markWatched || this.watched.get(id)) return;
    this.watched.set(id, true);
    run(this.config.bin.ytdlp, [...this.baseArgs(), '--mark-watched', '--simulate', '--no-playlist', `${YT}/watch?v=${id}`],
      { timeoutMs: 120_000 }).catch((e) => console.warn(`[streams] mark-watched ${id}: ${e.message}`));
  }
}

/** InnerTube client names (c= in links) -> yt-dlp client keys, for the CLI fallback. */
const CLIENT_KEYS = {
  WEB_EMBEDDED_PLAYER: ['web_embedded'],
  WEB: ['web', 'web_safari'],
  MWEB: ['mweb'],
  TVHTML5: ['tv', 'tv_downgraded', 'tv_samsung'],
  TVHTML5_SIMPLY: ['tv_simply'],
  ANDROID: ['android'],
  ANDROID_VR: ['android_vr'],
  IOS: ['ios'],
  VISIONOS: ['visionos'],
  WEB_CREATOR: ['web_creator'],
  WEB_REMIX: ['web_music'],
};

module.exports = { Streams };
