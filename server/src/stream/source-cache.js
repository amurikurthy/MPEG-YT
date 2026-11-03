'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

/**
 * Local cache + proxy for YouTube source streams.
 *
 * ffmpeg reads from http://127.0.0.1:<port>/<key> instead of from YouTube. The
 * proxy serves byte ranges from a sparse on-disk copy, fetching missing 512 KB
 * chunks from YouTube over persistent (keep-alive) connections, and keeps
 * downloading the rest of the file in the background while the video plays.
 *
 * Why: ffmpeg opens a new HTTPS connection for every seek inside a file and
 * opens the video and audio inputs one after the other (~8 connections per
 * start). Served locally, a seek into already-downloaded media never touches
 * the network, and the first chunks can be prefetched before you press play.
 */
const CHUNK = 512 * 1024;
const READAHEAD = 4; // chunks fetched ahead of what ffmpeg is reading
const FILL_CONCURRENCY = 2; // background download connections per file
// Persistent connections to YouTube; honours HTTPS_PROXY/NO_PROXY like other tools.
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30_000, proxyEnv: process.env });

class Entry {
  constructor(cache, key) {
    this.cache = cache;
    this.key = key;
    this.file = path.join(cache.dir, `${key}.bin`);
    this.url = null;
    this.headers = {};
    this.size = 0; // total bytes; known after the first response
    this.state = null; // Uint8Array per chunk: 0 missing, 1 downloading, 2 done
    this.waiters = new Map(); // chunk -> [resolve]
    this.fd = null;
    this.users = 0;
    this.lastUsed = Date.now();
    this.filling = false;
    this.failed = null;
    this.bytesOnDisk = 0;
  }

  get chunks() {
    return Math.ceil(this.size / CHUNK);
  }

  setSource(url, headers) {
    if (url && url !== this.url) {
      this.url = url;
      this.resolvedUrl = null;
    }
    if (headers) this.headers = headers;
    this.failed = null;
  }

  async open() {
    if (this.fd) return;
    await fsp.mkdir(this.cache.dir, { recursive: true });
    this.fd = await fsp.open(this.file, fs.existsSync(this.file) ? 'r+' : 'w+');
  }

  /** Fetch one chunk from YouTube and write it into the sparse file. */
  async download(i) {
    if (!this.url) throw new Error('no source URL');
    this.state[i] = 1;
    const start = i * CHUNK;
    const end = Math.min(this.size, start + CHUNK) - 1;
    try {
      const buf = await this.fetch(start, end);
      await this.fd.write(buf, 0, buf.length, start);
      this.state[i] = 2;
      this.bytesOnDisk += buf.length;
      this.cache.account(buf.length);
    } catch (e) {
      this.state[i] = 0;
      this.failed = e;
      throw e;
    } finally {
      for (const w of this.waiters.get(i) || []) w();
      this.waiters.delete(i);
    }
  }

  /**
   * Fetch a byte range. YouTube's video servers often redirect to another host;
   * redirects are followed and the final address reused for later chunks.
   */
  async fetch(start, end) {
    try {
      return await this.fetchFrom(this.resolvedUrl || this.url, start, end, 5);
    } catch (e) {
      if (!this.resolvedUrl) throw e;
      this.resolvedUrl = null; // the redirect target went stale: start over from the original URL
      return this.fetchFrom(this.url, start, end, 5);
    }
  }

  /**
   * YouTube's links only work from the IP address they were issued to (the ip=
   * parameter). If yt-dlp got the link over IPv4 and we download over IPv6 (or
   * the other way round), YouTube answers 403 - so connect with the same family.
   */
  linkFamily() {
    if (this.unpinned) return undefined;
    let ip = null;
    try {
      ip = new URL(this.url).searchParams.get('ip');
    } catch { /* no URL */ }
    if (!ip) return undefined;
    return ip.includes(':') ? 6 : 4;
  }

  fetchFrom(url, start, end, redirects) {
    return this.fetchOnce(url, start, end, redirects, this.linkFamily()).catch((e) => {
      // This server can't reach YouTube over that family at all: stop pinning.
      if (this.linkFamily() && /ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ECONNREFUSED|ENOTFOUND|EAI_|EAFNOSUPPORT/.test(e.code || e.message)) {
        this.unpinned = true;
        return this.fetchOnce(url, start, end, redirects, undefined);
      }
      throw e;
    });
  }

  fetchOnce(url, start, end, redirects, family) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = (u.protocol === 'https:' ? https : http).get(u, {
        agent: u.protocol === 'https:' ? agent : undefined,
        headers: { ...this.headers, Range: `bytes=${start}-${end}` },
        timeout: 20_000,
        ...(family ? { family } : {}),
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          this.resolvedUrl = next;
          return resolve(this.fetchOnce(next, start, end, redirects - 1, family));
        }
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          const via = res.socket && res.socket.remoteFamily;
          return reject(Object.assign(new Error(`source HTTP ${res.statusCode}`), {
            status: res.statusCode,
            detail: `client ${new URL(this.url).searchParams.get('c') || '?'}, link for IPv${this.linkFamily() || '?'}, connected over ${via || 'proxy'}`,
          }));
        }
        const total = /\/(\d+)$/.exec(res.headers['content-range'] || '');
        if (total && !this.size) this.size = Number(total[1]);
        else if (!total && !this.size && res.headers['content-length']) this.size = Number(res.headers['content-length']);
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve(Buffer.concat(parts)));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('source timeout')));
      req.on('error', reject);
    });
  }

  /** Learn the file size (first request) and allocate the chunk map. */
  async init() {
    if (this.state) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.open();
        if (!this.size) {
          // The first chunk also tells us the total size.
          const buf = await this.fetch(0, CHUNK - 1);
          this.state = new Uint8Array(this.chunks);
          await this.fd.write(buf, 0, buf.length, 0);
          this.state[0] = 2;
          this.bytesOnDisk += buf.length;
          this.cache.account(buf.length);
        } else {
          this.state = new Uint8Array(this.chunks);
        }
      })().catch((e) => {
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  async ensure(i) {
    if (i < 0 || i >= this.chunks) return;
    if (this.state[i] === 2) return;
    if (this.state[i] === 1) {
      await new Promise((r) => {
        const list = this.waiters.get(i) || [];
        list.push(r);
        this.waiters.set(i, list);
      });
      if (this.state[i] !== 2) throw this.failed || new Error('chunk failed');
      return;
    }
    await this.download(i);
  }

  /** Download the whole file in the background, nearest-first from `from`. */
  fill(from = 0) {
    this.fillFrom = from;
    if (this.filling) return;
    this.filling = true;
    const next = () => {
      const n = this.chunks;
      for (let k = 0; k < n; k++) {
        const i = (this.fillFrom + k) % n;
        if (this.state[i] === 0) return i;
      }
      return -1;
    };
    const worker = async () => {
      for (;;) {
        if (this.cache.closed || this.evicted || Date.now() - this.lastUsed > 10 * 60_000) return;
        const i = next();
        if (i < 0) return;
        try {
          await this.download(i);
        } catch {
          return; // URL expired or network trouble: playback re-registers a fresh URL
        }
      }
    };
    Promise.all(Array.from({ length: FILL_CONCURRENCY }, worker)).finally(() => {
      this.filling = false;
    });
  }

  /** Serve an HTTP range request to ffmpeg. */
  async serve(req, res) {
    this.users++;
    this.lastUsed = Date.now();
    let closed = false;
    res.on('close', () => { closed = true; });
    try {
      await this.init();
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), this.size - 1) : this.size - 1;
      if (start >= this.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${this.size}` });
        return res.end();
      }
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...(m ? { 'Content-Range': `bytes ${start}-${end}/${this.size}` } : {}),
      });
      const first = Math.floor(start / CHUNK);
      const last = Math.floor(end / CHUNK);
      this.fill(first);
      for (let i = first; i <= last && !closed; i++) {
        for (let k = 1; k <= READAHEAD; k++) if (i + k <= last && this.state[i + k] === 0) this.ensure(i + k).catch(() => {});
        await this.ensure(i);
        const from = Math.max(start, i * CHUNK);
        const to = Math.min(end, (i + 1) * CHUNK - 1);
        const buf = Buffer.allocUnsafe(to - from + 1);
        await this.fd.read(buf, 0, buf.length, from);
        this.lastUsed = Date.now();
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r).once('close', r));
      }
      res.end();
    } catch (e) {
      // Pass YouTube's refusal through so ffmpeg (and the viewer) see why.
      if (!res.headersSent) res.writeHead(e.status || 502, { 'Content-Length': 0 }).end();
      else res.destroy();
      console.warn(`[cache] ${this.key}: ${e.status ? `YouTube answered HTTP ${e.status} (${e.detail})` : e.code || e.message}`);
    } finally {
      this.users--;
    }
  }

  async warm(bytes) {
    await this.init();
    const n = Math.min(this.chunks, Math.ceil(bytes / CHUNK));
    await Promise.all(Array.from({ length: n }, (_, i) => this.ensure(i)));
  }

  async remove() {
    this.evicted = true;
    try {
      await this.fd?.close();
    } catch { /* ignore */ }
    this.fd = null;
    await fsp.rm(this.file, { force: true });
  }
}

class SourceCache {
  constructor(cfg) {
    this.dir = path.join(cfg.cacheDir, 'sources');
    this.maxBytes = cfg.stream.sourceCacheMb * 1024 * 1024;
    this.entries = new Map();
    this.total = 0;
    this.port = 0;
    this.enabled = this.maxBytes > 0;
  }

  async init() {
    if (!this.enabled) return;
    // Sizes and chunk maps live in memory, so start with an empty cache.
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.dir, { recursive: true });
    this.server = http.createServer((req, res) => {
      const key = decodeURIComponent(req.url.slice(1));
      const e = this.entries.get(key);
      if (!e || !e.url) {
        res.writeHead(404).end();
        return;
      }
      e.serve(req, res);
    });
    this.server.keepAliveTimeout = 60_000;
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    console.log(`[cache] source cache ${Math.round(this.maxBytes / 1048576)} MB at ${this.dir}`);
  }

  static key(videoId, formatId) {
    const safe = `${videoId}-${formatId}`.replace(/[^\w-]/g, '_');
    return safe.length < 80 ? safe : crypto.createHash('sha1').update(safe).digest('hex');
  }

  /** Register (or refresh the URL of) a source; returns the local URL ffmpeg should read. */
  register(key, url, headers) {
    let e = this.entries.get(key);
    if (!e) {
      e = new Entry(this, key);
      this.entries.set(key, e);
    }
    e.setSource(url, headers);
    e.lastUsed = Date.now();
    return `http://127.0.0.1:${this.port}/${encodeURIComponent(key)}`;
  }

  /**
   * Downloaded parts of a source as [start, end] fractions of the file (merged runs of
   * chunks). Used for the seek bar's gray "loaded" ranges.
   */
  coverage(key) {
    const e = this.entries.get(key);
    if (!e || !e.state || !e.size) return null;
    const runs = [];
    const n = e.chunks;
    for (let i = 0; i < n; i++) {
      if (e.state[i] !== 2) continue;
      const a = (i * CHUNK) / e.size;
      const b = Math.min(1, ((i + 1) * CHUNK) / e.size);
      const last = runs[runs.length - 1];
      if (last && Math.abs(last[1] - a) < 1e-9) last[1] = b;
      else runs.push([a, b]);
    }
    return runs;
  }

  /** Prefetch the first `bytes` of a source so playback starts from local data. */
  warm(key, url, headers, bytes) {
    this.register(key, url, headers);
    return this.entries.get(key).warm(bytes).catch(() => {});
  }

  account(n) {
    this.total += n;
    if (this.total > this.maxBytes) this.evict();
  }

  evict() {
    const list = [...this.entries.values()].filter((e) => e.users === 0 && !e.filling).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of list) {
      if (this.total <= this.maxBytes * 0.8) break;
      this.total -= e.bytesOnDisk;
      this.entries.delete(e.key);
      e.remove();
    }
  }

  close() {
    this.closed = true;
    this.server?.close();
  }
}

module.exports = { SourceCache, CHUNK };
