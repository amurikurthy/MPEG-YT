'use strict';
const { spawn } = require('child_process');

/**
 * Frame rates MPEG-1 video can carry (ffmpeg's mpeg1video rejects anything else).
 * Represented as [label, ffmpeg rate].
 */
const MPEG1_RATES = [
  [23.976, '24000/1001'],
  [24, '24'],
  [25, '25'],
  [29.97, '30000/1001'],
  [30, '30'],
  [50, '50'],
  [59.94, '60000/1001'],
  [60, '60'],
];
/** Rates offered to users. */
const USER_FPS = [24, 25, 30, 50, 60];

/** Bitrate presets offered as "Quality". */
const PRESETS = {
  saver: { label: 'Data saver', scale: 0.55 },
  standard: { label: 'Standard', scale: 1 },
  high: { label: 'High', scale: 1.6 },
  max: { label: 'Max', scale: 2.4 },
};

/** Baseline kbit/s for MPEG-1 at ~30fps, Standard preset. */
const BASE_KBPS = [
  [144, 250], [240, 450], [360, 900], [480, 1500], [720, 3000],
  [1080, 5500], [1440, 9000], [2160, 16000],
];

/** Snap any source rate to the nearest MPEG-1 legal rate. */
function snapRate(src) {
  if (!src || !Number.isFinite(src)) return MPEG1_RATES[4];
  let best = MPEG1_RATES[0];
  for (const r of MPEG1_RATES) if (Math.abs(r[0] - src) < Math.abs(best[0] - src)) best = r;
  return best;
}

/**
 * Decide output frame rate.
 *  - 'auto' (or anything invalid): the source rate snapped to an MPEG-1 rate.
 *  - a user rate: honored unless it exceeds the source (no point duplicating frames).
 */
function pickRate(requested, sourceFps) {
  const auto = snapRate(sourceFps);
  const want = Number(requested);
  if (!USER_FPS.includes(want)) return auto;
  if (sourceFps && want > sourceFps + 1) return auto;
  return MPEG1_RATES.find((r) => r[0] === want);
}

function pickHeight(requested, sourceHeight, maxHeight) {
  let h = Math.round(Number(requested) || 720);
  h = Math.max(144, Math.min(h, maxHeight));
  if (sourceHeight) h = Math.min(h, sourceHeight);
  return h - (h % 2);
}

function bitrateKbps(height, fps, preset, scale = 1) {
  let base = BASE_KBPS[BASE_KBPS.length - 1][1];
  for (const [h, k] of BASE_KBPS) {
    if (height <= h) {
      base = k;
      break;
    }
  }
  // More frames need more bits, but not linearly (inter-frame redundancy rises).
  const fpsFactor = Math.pow(fps / 30, 0.7);
  const p = PRESETS[preset] || PRESETS.standard;
  return Math.round(base * fpsFactor * p.scale * scale);
}

/**
 * Build ffmpeg arguments that turn a provider's Media into an MPEG-TS stream with
 * MPEG-1 video + MP2 audio — the only formats JSMpeg decodes.
 */
function buildArgs(media, opts, cfg) {
  const { start = 0, height, rate, kbps } = opts;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  for (const inp of media.inputs) {
    if (start > 0 && media.seekable) args.push('-ss', start.toFixed(3));
    if (/^https?:\/\//.test(inp.url)) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
      const headers = { ...(inp.headers || {}) };
      const ua = headers['User-Agent'] || headers['user-agent'];
      delete headers['User-Agent'];
      delete headers['user-agent'];
      if (ua) args.push('-user_agent', ua);
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (lines) args.push('-headers', lines);
    }
    if (inp.inputArgs) args.push(...inp.inputArgs);
    args.push('-i', inp.url);
  }

  let vIdx = media.inputs.findIndex((i) => i.hasVideo);
  const aIdx = media.inputs.findIndex((i) => i.hasAudio);
  let shortest = false;
  if (vIdx < 0) {
    // Audio-only source: render a plain background so the player has frames.
    args.push('-f', 'lavfi', '-i', `color=c=0x111318:s=${Math.round((height * 16) / 9 / 2) * 2}x${height}:r=${rate[1]}`);
    vIdx = media.inputs.length;
    shortest = true;
  }

  args.push('-map', `${vIdx}:v:0`);
  if (aIdx >= 0) args.push('-map', `${aIdx}:a:0`);

  args.push(
    '-vf', `scale=-2:${height}:flags=bicubic,fps=${rate[1]},format=yuv420p`,
    '-c:v', 'mpeg1video',
    '-r', rate[1],
    '-b:v', `${kbps}k`,
    '-maxrate', `${Math.round(kbps * 1.4)}k`,
    '-bufsize', `${kbps}k`,
    '-bf', '0', // JSMpeg does not support B-frames
    '-g', String(Math.round(rate[0] * 2)),
  );
  if (cfg.stream.ffmpegThreads) args.push('-threads', String(cfg.stream.ffmpegThreads));

  if (aIdx >= 0) args.push('-c:a', 'mp2', '-b:a', cfg.stream.audioBitrate, '-ar', '44100', '-ac', '2');
  else args.push('-an');
  if (shortest) args.push('-shortest');

  args.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1');
  return args;
}

/** Resolve user choices into concrete encode settings. */
function plan(media, req, cfg) {
  const height = pickHeight(req.height, media.sourceHeight, cfg.stream.maxHeight);
  const rate = pickRate(req.fps, media.fps);
  const preset = PRESETS[req.preset] ? req.preset : 'standard';
  const kbps = bitrateKbps(height, rate[0], preset, cfg.stream.bitrateScale);
  let start = Math.max(0, Number(req.start) || 0);
  if (!media.seekable) start = 0;
  if (media.duration && start > media.duration - 0.5) start = Math.max(0, media.duration - 0.5);
  return { height, rate, fps: rate[0], preset, kbps, start };
}

function spawnTranscoder(media, p, cfg) {
  const args = buildArgs(media, p, cfg);
  const child = spawn(cfg.bin.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrTail = '';
  child.stderr.on('data', (d) => {
    child.stderrTail = (child.stderrTail + d.toString()).slice(-2000);
  });
  return child;
}

module.exports = { plan, spawnTranscoder, buildArgs, PRESETS, USER_FPS, snapRate };
