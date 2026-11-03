'use strict';
const { spawn } = require('child_process');

/** Frame rates MPEG-1 can carry, as [fps, ffmpeg rate]. */
const MPEG1_RATES = [[23.976, '24000/1001'], [24, '24'], [25, '25'], [29.97, '30000/1001'], [30, '30']];

/**
 * Output frame rate: the source rate when it's a film/PAL rate (24/25 - converting
 * those to 30 would add judder), otherwise 30 fps. Never above 30.
 */
function pickRate(sourceFps) {
  if (!sourceFps || !Number.isFinite(sourceFps) || sourceFps > 26) return MPEG1_RATES[4];
  let best = MPEG1_RATES[0];
  for (const r of MPEG1_RATES) if (Math.abs(r[0] - sourceFps) < Math.abs(best[0] - sourceFps)) best = r;
  return best;
}

/** Plan the encode: up to 720p, up to 30 fps, fixed bitrate scaled to the output size. */
function plan(media, req, cfg) {
  const s = cfg.stream;
  let height = Math.min(s.maxHeight, media.sourceHeight || s.maxHeight);
  height -= height % 2;
  const rate = pickRate(media.fps);
  const kbps = Math.round(s.videoKbps * Math.min(1, (height / 720) ** 1.5) * (rate[0] / 30) ** 0.7);
  let start = Math.max(0, Number(req.start) || 0);
  if (!media.seekable) start = 0;
  if (media.duration && start > media.duration - 0.5) start = Math.max(0, media.duration - 0.5);
  return { height, rate, fps: rate[0], kbps, start };
}

/**
 * ffmpeg arguments turning a resolved YouTube stream into MPEG-TS with MPEG-1 video
 * and MP2 audio - the formats JSMpeg decodes.
 */
function buildArgs(media, p, cfg) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  for (const inp of media.inputs) {
    if (p.start > 0 && media.seekable) args.push('-ss', p.start.toFixed(3));
    if (inp.local) {
      // Served by the local source cache: fast, reliable, no headers needed.
      args.push('-multiple_requests', '1');
    } else if (/^https?:\/\//.test(inp.url)) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
      const headers = { ...(inp.headers || {}) };
      const ua = headers['User-Agent'] || headers['user-agent'];
      delete headers['User-Agent'];
      delete headers['user-agent'];
      if (ua) args.push('-user_agent', ua);
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (lines) args.push('-headers', lines);
    }
    args.push('-i', inp.url);
  }

  const vIdx = media.inputs.findIndex((i) => i.hasVideo);
  const aIdx = media.inputs.findIndex((i) => i.hasAudio);
  args.push('-map', `${vIdx < 0 ? 0 : vIdx}:v:0`);
  if (aIdx >= 0) args.push('-map', `${aIdx}:a:0`);

  args.push(
    '-vf', `scale=-2:${p.height}:flags=bicubic,fps=${p.rate[1]},format=yuv420p`,
    '-c:v', 'mpeg1video',
    '-r', p.rate[1],
    '-b:v', `${p.kbps}k`,
    '-maxrate', `${Math.round(p.kbps * 1.4)}k`,
    '-bufsize', `${p.kbps}k`,
    '-bf', '0', // JSMpeg does not support B-frames
    '-g', String(Math.round(p.fps * 2)),
  );
  if (cfg.stream.ffmpegThreads) args.push('-threads', String(cfg.stream.ffmpegThreads));

  if (aIdx >= 0) {
    // 48 kHz: the native rate of YouTube's audio and of most playback devices, so neither
    // the server nor the browser resamples. Loudness-normalized so videos play at the
    // level of other apps (EBU R128, single pass; its ~3 s look-ahead costs only ~40 ms
    // of startup because the transcode runs ahead of playback).
    const af = cfg.stream.normalizeAudio
      ? `loudnorm=I=${cfg.stream.loudnessTarget}:TP=-1.5:LRA=11,aresample=48000`
      : 'aresample=48000';
    args.push('-af', af, '-c:a', 'mp2', '-b:a', cfg.stream.audioBitrate, '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1');
  return args;
}

function spawnTranscoder(media, p, cfg) {
  const child = spawn(cfg.bin.ffmpeg, buildArgs(media, p, cfg), { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrTail = '';
  child.stderr.on('data', (d) => {
    child.stderrTail = (child.stderrTail + d.toString()).slice(-2000);
  });
  return child;
}

module.exports = { plan, spawnTranscoder, buildArgs, pickRate };
