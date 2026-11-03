'use strict';
const { TTLCache } = require('../util/cache');
const { run, runJson } = require('../util/exec');
const { HttpError } = require('./account');

const YT = 'https://www.youtube.com';
const VCODEC_PREF = ['avc1', 'vp09', 'vp9', 'av01']; // cheapest to decode first

/**
 * Resolves playable stream URLs with yt-dlp (it keeps up with YouTube's signature
 * and anti-bot changes far better than anything hand-rolled). Only formats up to
 * 720p / 30 fps are considered - that's all the MPEG-1 output needs.
 */
class Streams {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    // Stream URLs expire after ~6h; keep well under that.
    this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
    this.watched = new TTLCache({ ttlMs: 6 * 3600_000, max: 2000 });
  }

  async init() {
    const v = (await run(this.config.bin.ytdlp, ['--version'], { timeoutMs: 15_000 })).trim();
    console.log(`[streams] yt-dlp ${v}`);
  }

  baseArgs() {
    const a = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node'];
    if (this.account.signedIn) a.push('--cookies', this.account.cookiesFile);
    return [...a, ...this.config.youtube.extraArgs];
  }

  reset() {
    this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
  }

  info(id) {
    if (!/^[\w-]{11}$/.test(id)) return Promise.reject(new HttpError(400, 'bad video id'));
    return this.infos.wrap(id, () =>
      runJson(this.config.bin.ytdlp, [...this.baseArgs(), '-J', '--no-playlist', `${YT}/watch?v=${id}`], { timeoutMs: 90_000 }));
  }

  /** Warm the cache (hover prefetch). */
  prefetch(id) {
    this.info(id).catch(() => {});
  }

  async resolve(id) {
    const info = await this.info(id);
    this.markWatched(id);
    const { maxHeight, maxFps } = this.config.stream;
    const live = info.live_status === 'is_live';
    const fmts = (info.formats || []).filter((f) => f.url);
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
      if (v && a) {
        return {
          inputs: [
            { url: v.url, headers: v.http_headers, hasVideo: true, hasAudio: false },
            { url: a.url, headers: a.http_headers, hasVideo: false, hasAudio: true },
          ],
          duration: info.duration,
          fps: v.fps,
          sourceHeight: v.height,
          seekable: true,
        };
      }
    }

    // Muxed fallback (live HLS, or videos without separate streams).
    const muxed = fmts.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none');
    const m = muxed.filter(fits).sort(rank)[0] || muxed.sort(rank).pop();
    if (!m) throw new HttpError(422, 'no playable format found');
    return {
      inputs: [{ url: m.url, headers: m.http_headers, hasVideo: true, hasAudio: true }],
      duration: live ? undefined : info.duration,
      fps: m.fps,
      sourceHeight: m.height,
      seekable: !live,
      live,
    };
  }

  /** Fire-and-forget: add a play to the signed-in account's YouTube history (once per 6h). */
  markWatched(id) {
    if (!this.account.signedIn || !this.config.youtube.markWatched || this.watched.get(id)) return;
    this.watched.set(id, true);
    run(this.config.bin.ytdlp, [...this.baseArgs(), '--mark-watched', '--simulate', '--no-playlist', `${YT}/watch?v=${id}`],
      { timeoutMs: 120_000 }).catch((e) => console.warn(`[streams] mark-watched ${id}: ${e.message}`));
  }
}

module.exports = { Streams };
