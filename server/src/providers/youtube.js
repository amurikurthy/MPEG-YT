'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Provider, HttpError } = require('./base');
const { BrowserLoginSession } = require('../login/browser-session');
const { TTLCache } = require('../util/cache');
const { run, runJson } = require('../util/exec');

const YT = 'https://www.youtube.com';
const PAGE = 24;
const STD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];
const VCODEC_PREF = ['avc1', 'vp09', 'vp9', 'av01']; // cheapest-to-decode first

/**
 * YouTube via yt-dlp. Only metadata and stream URLs come from YouTube; the UI is
 * ours and the video itself goes through the MPEG-1 pipeline.
 */
class YouTubeProvider extends Provider {
  static id = 'youtube';
  static displayName = 'YouTube';

  constructor(config) {
    super(config);
    this.yc = config.youtube;
    this.lists = new TTLCache({ ttlMs: 15 * 60_000 });
    // Stream URLs expire after ~6h; keep well under that.
    this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
  }

  async init() {
    const v = (await run(this.config.bin.ytdlp, ['--version'], { timeoutMs: 15_000 })).trim();
    console.log(`[youtube] yt-dlp ${v}`);
    this.cookiesFile = this.yc.cookiesFile || path.join(this.config.configDir, 'youtube-cookies.txt');
    this.profileDir = path.join(this.config.configDir, 'youtube-signin-browser');
    this.login = null;
    this.watched = new TTLCache({ ttlMs: 6 * 3600_000, max: 2000 });
    await fsp.mkdir(path.dirname(this.cookiesFile), { recursive: true }).catch(() => {});
    this.refreshSignIn();
    if (this.signedIn) console.log(`[youtube] signed in (cookies: ${this.cookiesFile})${this.yc.markWatched ? ', watch history on' : ''}`);
  }

  // ---------- account ----------

  refreshSignIn() {
    let text = '';
    try {
      text = fs.readFileSync(this.cookiesFile, 'utf8');
    } catch { /* none */ }
    const was = this.signedIn;
    this.signedIn = hasLoginCookies(text);
    if (was !== undefined && was !== this.signedIn) {
      // Feeds, search results and stream URLs differ per account.
      this.lists = new TTLCache({ ttlMs: 15 * 60_000 });
      this.infos = new TTLCache({ ttlMs: 3 * 3600_000, max: 300 });
    }
  }

  account() {
    const methods = ['cookies'];
    if (this.config.login.enabled) methods.unshift('browser');
    return { signedIn: !!this.signedIn, methods };
  }

  async startLogin() {
    if (!this.config.login.enabled) throw new HttpError(404, 'in-app sign-in is disabled (LOGIN_BROWSER=0)');
    if (this.login && ['starting', 'running', 'finishing'].includes(this.login.state)) return this.login.status();
    await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    this.login = new BrowserLoginSession({
      config: this.config,
      url: 'https://accounts.google.com/ServiceLogin?service=youtube&hl=en&continue=' +
        encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2Faccount'),
      profileDir: this.profileDir,
      // Google's sign-in pages are titled just "YouTube". The account page ("Account - YouTube")
      // is only reachable once signed in (signed-out visitors are bounced back to sign-in).
      doneTitle: /^.+ - YouTube$/,
      onDone: () => this.importBrowserCookies(),
    });
    return this.login.start();
  }

  loginSession() {
    return this.login;
  }

  async finishLogin() {
    if (!this.login) throw new HttpError(409, 'no sign-in in progress');
    return { ...(await this.login.finish()), account: this.account() };
  }

  async cancelLogin() {
    if (this.login) await this.login.cancel();
    this.login = null;
    return this.account();
  }

  /** Pull cookies out of the sign-in browser's profile via yt-dlp, keep only YouTube/Google ones. */
  async importBrowserCookies() {
    const tmp = `${this.cookiesFile}.import`;
    await fsp.rm(tmp, { force: true });
    // Loading from the browser and saving with --cookies dumps the jar to a cookies.txt file.
    await run(this.config.bin.ytdlp, [
      '--ignore-config', '--no-warnings', '--js-runtimes', 'node',
      '--cookies-from-browser', `chromium+basictext:${this.profileDir}`,
      '--cookies', tmp, '--skip-download', '--flat-playlist', '--playlist-end', '1', ':ytrec',
    ], { timeoutMs: 90_000 }).catch((e) => console.warn(`[youtube] cookie import: ${e.message}`));
    const text = await fsp.readFile(tmp, 'utf8').catch(() => '');
    await fsp.rm(tmp, { force: true });
    if (!hasLoginCookies(text)) throw new Error('Sign-in was not completed - no YouTube session found.');
    await this.writeCookies(text);
  }

  async saveCookies(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new HttpError(400, 'invalid file');
    if (!hasLoginCookies(text)) {
      throw new HttpError(400, 'No signed-in YouTube session found in that file. Export cookies for youtube.com in Netscape (cookies.txt) format while signed in.');
    }
    await this.writeCookies(text);
    return this.account();
  }

  async writeCookies(text) {
    const keep = text.split(/\r?\n/).filter((line) => {
      if (!line || line.startsWith('# ')) return line.startsWith('# Netscape');
      const domain = line.replace(/^#HttpOnly_/, '').split('\t')[0];
      return /(^|\.)(youtube\.com|google\.com)$/.test(domain);
    });
    if (!keep[0] || !keep[0].startsWith('# Netscape')) keep.unshift('# Netscape HTTP Cookie File');
    await fsp.writeFile(this.cookiesFile, keep.join('\n') + '\n', { mode: 0o600 });
    this.refreshSignIn();
    console.log(`[youtube] signed in; cookies saved to ${this.cookiesFile}`);
  }

  async signOut() {
    if (this.login) await this.login.cancel();
    this.login = null;
    await fsp.rm(this.cookiesFile, { force: true });
    await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    this.refreshSignIn();
    console.log('[youtube] signed out');
    return this.account();
  }

  ytdlp(args, timeoutMs = 60_000) {
    const base = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node'];
    if (this.signedIn) base.push('--cookies', this.cookiesFile);
    return runJson(this.config.bin.ytdlp, [...base, ...this.yc.extraArgs, ...args], { timeoutMs });
  }

  // ---------- listing ----------

  async home() {
    const pairs = (arr) => arr.map((s) => {
      const [title, value] = s.includes('=') ? s.split('=', 2) : [s, s];
      return { title: title.trim(), value: value.trim() };
    });
    const jobs = [];
    // Signed in: your own feeds first (Recommended, Subscriptions, ...).
    if (this.signedIn) {
      for (const f of pairs(this.yc.accountFeeds)) {
        jobs.push({ title: f.title, run: () => this.feed(f.value, 24), more: { kind: 'collection', id: `feed:${f.value}` } });
      }
    }
    if (!this.signedIn || this.yc.homeShelvesExplicit) {
      for (const s of pairs(this.yc.homeShelves)) {
        jobs.push({ title: s.title, run: () => this.searchRaw(s.value, 16), more: { kind: 'search', id: s.value } });
      }
    }
    const results = await Promise.allSettled(jobs.map((j) => j.run()));
    results.forEach((r, i) => r.status === 'rejected' && console.warn(`[youtube] shelf "${jobs[i].title}": ${r.reason.message}`));
    return jobs
      .map((j, i) => ({
        title: j.title,
        items: results[i].status === 'fulfilled' ? results[i].value.filter((x) => x.kind === 'video') : [],
        more: j.more,
      }))
      .filter((s) => s.items.length);
  }

  /** Personal feeds via yt-dlp keywords (:ytrec, :ytsubs, :ytwatchlater, :ytfav, :ythis). Needs cookies. */
  feed(keyword, n) {
    if (!this.signedIn) return Promise.reject(new HttpError(403, 'sign-in required (set YTDLP_COOKIES)'));
    if (!/^:yt[a-z]+$/.test(keyword)) return Promise.reject(new HttpError(400, 'bad feed'));
    return this.lists.wrap(`f:${n}:${keyword}`, async () => {
      const data = await this.ytdlp(['--flat-playlist', '-J', '--playlist-end', String(n), keyword], 90_000);
      return (data.entries || []).map((e) => this.mapEntry(e)).filter(Boolean);
    }, 5 * 60_000);
  }

  searchRaw(query, n) {
    return this.lists.wrap(`s:${n}:${query}`, async () => {
      const data = await this.ytdlp(['--flat-playlist', '-J', `ytsearch${n}:${query}`]);
      return (data.entries || []).map((e) => this.mapEntry(e)).filter(Boolean);
    });
  }

  async search(query, { page = 1 } = {}) {
    page = Math.max(1, Math.min(10, +page || 1));
    const all = await this.searchRaw(query, PAGE * page);
    const items = all.slice(PAGE * (page - 1));
    return { items, next: items.length >= PAGE - 2 ? page + 1 : null };
  }

  async suggest(query) {
    const url =
      'https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=en&q=' +
      encodeURIComponent(query);
    return this.lists.wrap(`sg:${query}`, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const data = JSON.parse(await res.text());
      return Array.isArray(data[1]) ? data[1].slice(0, 10).map(String) : [];
    }, 60 * 60_000).catch(() => []);
  }

  async collection(id) {
    const [type, value] = splitRef(id);
    if (type === 'feed') {
      const label = (this.yc.accountFeeds.find((f) => f.endsWith(`=${value}`)) || value).split('=')[0];
      return { title: label, items: await this.feed(value, 60) };
    }
    let url;
    if (type === 'channel') url = `${YT}/channel/${encodeURIComponent(value)}/videos`;
    else if (type === 'playlist') url = `${YT}/playlist?list=${encodeURIComponent(value)}`;
    else throw new HttpError(400, 'unknown collection');
    return this.lists.wrap(`c:${id}`, async () => {
      const data = await this.ytdlp(['--flat-playlist', '-J', '--playlist-end', '60', url]);
      const thumbs = (data.thumbnails || []).filter((t) => t.url);
      const avatar = thumbs.find((t) => /avatar/i.test(t.id || '')) || thumbs[thumbs.length - 1];
      return {
        title: data.channel || data.title || value,
        subtitle: type === 'channel' ? data.channel_follower_count ? `${compact(data.channel_follower_count)} subscribers` : '' : data.channel || '',
        thumbnail: avatar ? fixUrl(avatar.url) : undefined,
        items: (data.entries || []).map((e) => this.mapEntry(e, data)).filter(Boolean),
      };
    });
  }

  // ---------- single video ----------

  info(id) {
    if (!/^[\w-]{11}$/.test(id)) return Promise.reject(new HttpError(400, 'bad video id'));
    return this.infos.wrap(id, () =>
      this.ytdlp(['-J', '--no-playlist', `${YT}/watch?v=${id}`], 90_000),
    );
  }

  async item(id) {
    const i = await this.info(id);
    const live = i.live_status === 'is_live';
    return {
      kind: 'video',
      id,
      title: i.title,
      subtitle: i.channel || i.uploader,
      subtitleRef: i.channel_id ? { kind: 'collection', id: `channel:${i.channel_id}` } : undefined,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration: i.duration,
      views: i.view_count,
      likes: i.like_count,
      published: ymd(i.upload_date),
      live,
      description: i.description || '',
      qualities: this.qualities(i),
      sourceFps: Math.max(0, ...(i.formats || []).filter((f) => f.vcodec !== 'none' && f.url).map((f) => f.fps || 0)) || 30,
      seekable: !live,
      extra: i.channel_follower_count ? { Subscribers: compact(i.channel_follower_count) } : undefined,
    };
  }

  async related(id) {
    const i = await this.info(id);
    const words = (i.title || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
    const q = words.join(' ') || i.channel;
    const items = await this.searchRaw(q, 20);
    return items.filter((x) => x.kind === 'video' && x.id !== id);
  }

  qualities(info) {
    const max = this.config.stream.maxHeight;
    const hs = new Set();
    for (const f of info.formats || []) {
      if (f.vcodec && f.vcodec !== 'none' && f.height && f.url) {
        const std = STD_HEIGHTS.filter((h) => h <= f.height).pop();
        if (std && std <= max) hs.add(std);
      }
    }
    const out = [...hs].sort((a, b) => a - b);
    return out.length ? out : [360];
  }

  async resolve(id, { height, fps = 30 }) {
    const info = await this.info(id);
    this.markWatched(id);
    const live = info.live_status === 'is_live';
    const fmts = (info.formats || []).filter((f) => f.url);
    const isHttp = (f) => f.protocol === 'https' || f.protocol === 'http';
    const codecRank = (f) => {
      const i = VCODEC_PREF.findIndex((c) => (f.vcodec || '').startsWith(c));
      return i < 0 ? 99 : i;
    };
    // Prefer the tallest format that fits; among equal heights, one whose frame rate
    // covers the requested output rate (60fps formats only help if 50/60 was asked for).
    const fpsOk = (f) => ((f.fps || 30) >= fps - 1 ? 0 : 1);
    const fpsCost = (f) => (fps > 31 ? 0 : (f.fps || 30) > 31 ? 1 : 0); // don't decode 60 to output 30
    const byHeight = (a, b) =>
      (b.height || 0) - (a.height || 0) ||
      fpsOk(a) - fpsOk(b) ||
      fpsCost(a) - fpsCost(b) ||
      codecRank(a) - codecRank(b) ||
      (a.tbr || 0) - (b.tbr || 0);
    const fitsHeight = (f) => (f.height || 0) <= height + 8;

    if (!live) {
      const vOnly = fmts.filter((f) => isHttp(f) && f.vcodec !== 'none' && f.acodec === 'none' && fitsHeight(f));
      const aOnly = fmts.filter((f) => isHttp(f) && f.acodec !== 'none' && f.vcodec === 'none');
      vOnly.sort(byHeight);
      aOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));
      const v = vOnly[0];
      const a = aOnly.find((f) => (f.language_preference ?? 0) >= 0) || aOnly[0];
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

    // Muxed fallback (live HLS, or videos without DASH formats).
    const muxed = fmts.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none' && fitsHeight(f)).sort(byHeight);
    const m = muxed[0] || fmts.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none').sort(byHeight).pop();
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

  /** Fire-and-forget: report a play to the signed-in account's watch history (once per 6h). */
  markWatched(id) {
    if (!this.signedIn || !this.yc.markWatched || this.watched.get(id)) return;
    this.watched.set(id, true);
    run(this.config.bin.ytdlp, [
      '--ignore-config', '--no-warnings', '--js-runtimes', 'node', '--cookies', this.cookiesFile,
      '--mark-watched', '--simulate', '--no-playlist', `${YT}/watch?v=${id}`,
    ], { timeoutMs: 120_000 }).catch((e) => console.warn(`[youtube] mark-watched ${id}: ${e.message}`));
  }

  // ---------- mapping ----------

  mapEntry(e, parent = {}) {
    if (!e || !e.id) return null;
    const url = e.url || '';
    const isChannel = e.ie_key === 'YoutubeTab' && (/\/(channel|c|user)\/|\/@/.test(url) || /^UC[\w-]{22}$/.test(e.id));
    const isPlaylist = e.ie_key === 'YoutubeTab' && /list=/.test(url);
    if (isChannel) {
      const thumbs = (e.thumbnails || []).filter((t) => t.url);
      return {
        kind: 'collection',
        variant: 'channel',
        id: `channel:${e.channel_id || e.id}`,
        title: e.channel || e.title,
        subtitle: e.channel_follower_count ? `${compact(e.channel_follower_count)} subscribers` : 'Channel',
        thumbnail: thumbs.length ? fixUrl(thumbs[thumbs.length - 1].url) : undefined,
      };
    }
    if (isPlaylist) {
      return {
        kind: 'collection',
        variant: 'playlist',
        id: `playlist:${e.id}`,
        title: e.title,
        subtitle: e.channel || e.uploader || 'Playlist',
        thumbnail: (e.thumbnails || []).length ? fixUrl(e.thumbnails[e.thumbnails.length - 1].url) : undefined,
      };
    }
    if (!/^[\w-]{11}$/.test(e.id)) return null;
    if (/\/shorts\//.test(url)) return null; // vertical shorts don't suit this player
    const channel = e.channel || e.uploader || parent.channel;
    const channelId = e.channel_id || parent.channel_id;
    return {
      kind: 'video',
      id: e.id,
      title: e.title,
      subtitle: channel,
      subtitleRef: channelId ? { kind: 'collection', id: `channel:${channelId}` } : undefined,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      duration: e.duration || undefined,
      views: e.view_count || undefined,
      published: ymd(e.upload_date) || (e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined),
      live: e.live_status === 'is_live' || undefined,
    };
  }
}

/** True if a Netscape cookies.txt holds a signed-in YouTube session. */
function hasLoginCookies(text) {
  return /^(#HttpOnly_)?\.?(www\.)?youtube\.com\t.*\t(LOGIN_INFO|SAPISID|__Secure-3PAPISID)\t/m.test(text || '');
}

function splitRef(id) {
  const i = id.indexOf(':');
  return i < 0 ? ['', id] : [id.slice(0, i), id.slice(i + 1)];
}
function ymd(s) {
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : undefined;
}
function fixUrl(u) {
  return u && u.startsWith('//') ? `https:${u}` : u;
}
function compact(n) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

module.exports = YouTubeProvider;
