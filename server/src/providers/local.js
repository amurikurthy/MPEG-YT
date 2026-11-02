'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Provider, HttpError } = require('./base');
const { TTLCache } = require('../util/cache');
const { run, runJson } = require('../util/exec');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv']);
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);
const STD_HEIGHTS = [240, 360, 480, 720, 1080, 1440, 2160];

/**
 * Plays files from a mounted folder (MEDIA_DIR). Also a compact reference for
 * writing new providers: folders are collections, files are videos.
 */
class LocalProvider extends Provider {
  static id = 'local';
  static displayName = 'Local files';

  constructor(config) {
    super(config);
    this.root = path.resolve(config.local.mediaDir);
    this.thumbDir = path.join(config.cacheDir, 'thumbs');
    this.scanCache = new TTLCache({ ttlMs: 30_000, max: 4 });
    this.probes = new TTLCache({ ttlMs: 3600_000, max: 2000 });
    this.thumbJobs = new TTLCache({ ttlMs: 3600_000, max: 5000 });
  }

  async init() {
    const st = await fsp.stat(this.root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`MEDIA_DIR ${this.root} is not a directory`);
    await fsp.mkdir(this.thumbDir, { recursive: true });
  }

  // ---------- ids & fs ----------

  encode(rel) {
    return Buffer.from(rel, 'utf8').toString('base64url');
  }

  decode(id) {
    const rel = Buffer.from(String(id), 'base64url').toString('utf8');
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new HttpError(400, 'bad id');
    return { rel, abs };
  }

  scan() {
    return this.scanCache.wrap('all', async () => {
      const files = [];
      const walk = async (dir, depth) => {
        if (depth > 8) return;
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs, depth + 1);
          else if (e.isFile() && isMedia(e.name)) {
            const st = await fsp.stat(abs).catch(() => null);
            if (st) files.push({ rel: path.relative(this.root, abs), mtime: st.mtimeMs });
          }
        }
      };
      await walk(this.root, 0);
      return files;
    });
  }

  fileItem(rel, mtime) {
    const id = this.encode(rel);
    const dir = path.dirname(rel);
    return {
      kind: 'video',
      id,
      title: prettyName(rel),
      subtitle: dir === '.' ? 'Media' : path.basename(dir),
      subtitleRef: dir === '.' ? undefined : { kind: 'collection', id: this.encode(dir) },
      thumbnail: `/api/p/${this.id}/thumb/${id}`,
      published: mtime ? new Date(mtime).toISOString() : undefined,
    };
  }

  folderItem(rel, count) {
    return {
      kind: 'collection',
      variant: 'folder',
      id: this.encode(rel),
      title: path.basename(rel),
      subtitle: `${count} item${count === 1 ? '' : 's'}`,
    };
  }

  // ---------- provider API ----------

  async home() {
    const files = await this.scan();
    const recent = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 24);
    const folders = new Map();
    for (const f of files) {
      const top = f.rel.split(path.sep)[0];
      if (top !== f.rel) folders.set(top, (folders.get(top) || 0) + 1);
    }
    const shelves = [{ title: 'Recently added', items: recent.map((f) => this.fileItem(f.rel, f.mtime)) }];
    if (folders.size) {
      shelves.push({
        title: 'Folders',
        items: [...folders].sort().map(([rel, n]) => this.folderItem(rel, n)),
      });
    }
    return shelves.filter((s) => s.items.length);
  }

  async search(query) {
    const q = query.toLowerCase();
    const files = await this.scan();
    return {
      items: files.filter((f) => f.rel.toLowerCase().includes(q)).slice(0, 96).map((f) => this.fileItem(f.rel, f.mtime)),
      next: null,
    };
  }

  async suggest(query) {
    const q = query.toLowerCase();
    const files = await this.scan();
    return [...new Set(files.map((f) => prettyName(f.rel)).filter((n) => n.toLowerCase().includes(q)))].slice(0, 8);
  }

  async collection(id) {
    const { rel, abs } = this.decode(id);
    const files = await this.scan();
    const prefix = rel === '' || rel === '.' ? '' : rel + path.sep;
    const sub = new Map();
    const direct = [];
    for (const f of files) {
      if (!f.rel.startsWith(prefix)) continue;
      const rest = f.rel.slice(prefix.length);
      const i = rest.indexOf(path.sep);
      if (i < 0) direct.push(f);
      else sub.set(rest.slice(0, i), (sub.get(rest.slice(0, i)) || 0) + 1);
    }
    direct.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    return {
      title: path.basename(abs),
      subtitle: `${direct.length} files`,
      items: [
        ...[...sub].sort().map(([name, n]) => this.folderItem(prefix + name, n)),
        ...direct.map((f) => this.fileItem(f.rel, f.mtime)),
      ],
    };
  }

  probe(abs) {
    return this.probes.wrap(abs, async () => {
      const p = await runJson(this.config.bin.ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs,
      ], { timeoutMs: 20_000 });
      const v = (p.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      const a = (p.streams || []).find((s) => s.codec_type === 'audio');
      const [n, d] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
      return {
        duration: +p.format?.duration || undefined,
        height: v?.height,
        width: v?.width,
        fps: d ? n / d : undefined,
        vcodec: v?.codec_name,
        acodec: a?.codec_name,
        hasVideo: !!v,
        hasAudio: !!a,
        size: +p.format?.size || undefined,
      };
    });
  }

  async item(id) {
    const { rel, abs } = this.decode(id);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, 'not found');
    const pr = await this.probe(abs);
    const max = this.config.stream.maxHeight;
    const src = pr.height || 360;
    let q = STD_HEIGHTS.filter((h) => h <= Math.min(src, max));
    if (!q.length) q = [Math.min(src, max)];
    return {
      ...this.fileItem(rel, st.mtimeMs),
      duration: pr.duration,
      description: '',
      qualities: q,
      sourceFps: pr.fps || 30,
      seekable: true,
      extra: {
        File: path.basename(rel),
        Source: [pr.width && `${pr.width}×${pr.height}`, pr.vcodec, pr.acodec, pr.fps && `${pr.fps.toFixed(2)} fps`]
          .filter(Boolean).join(' · '),
        Size: pr.size ? `${(pr.size / 1048576).toFixed(1)} MB` : '',
      },
    };
  }

  async related(id) {
    const { rel } = this.decode(id);
    const dir = path.dirname(rel);
    const files = await this.scan();
    return files
      .filter((f) => path.dirname(f.rel) === dir && f.rel !== rel)
      .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))
      .slice(0, 30)
      .map((f) => this.fileItem(f.rel, f.mtime));
  }

  async thumbnail(id) {
    const { abs } = this.decode(id);
    const key = crypto.createHash('sha1').update(abs).digest('hex');
    const out = path.join(this.thumbDir, `${key}.jpg`);
    const ok = await this.thumbJobs.wrap(out, async () => {
      if (await fsp.stat(out).catch(() => null)) return true;
      const pr = await this.probe(abs);
      if (!pr.hasVideo) return false;
      const at = pr.duration ? Math.min(pr.duration * 0.1, 120) : 1;
      await run(this.config.bin.ffmpeg, [
        '-v', 'error', '-ss', at.toFixed(2), '-i', abs, '-frames:v', '1',
        '-vf', 'scale=480:-2', '-q:v', '4', '-y', out,
      ], { timeoutMs: 30_000 }).catch(() => null);
      return !!(await fsp.stat(out).catch(() => null));
    });
    return ok ? { body: fs.createReadStream(out), type: 'image/jpeg' } : null;
  }

  async resolve(id) {
    const { abs } = this.decode(id);
    const pr = await this.probe(abs);
    return {
      inputs: [{ url: abs, hasVideo: pr.hasVideo, hasAudio: pr.hasAudio }],
      duration: pr.duration,
      fps: pr.fps,
      sourceHeight: pr.height,
      seekable: true,
    };
  }
}

function isMedia(name) {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext);
}
function prettyName(rel) {
  return path.basename(rel, path.extname(rel)).replace(/[._]+/g, ' ').trim();
}

module.exports = LocalProvider;
