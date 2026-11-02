'use strict';
const { plan, spawnTranscoder } = require('./transcoder');

const WS_HIGH_WATER = 4 * 1024 * 1024; // bytes queued in the socket before we stop reading ffmpeg
const WS_LOW_WATER = 1 * 1024 * 1024;
let active = 0;

/**
 * One WebSocket = one playback session = one ffmpeg process.
 *
 * Server -> client:  text   {"t":"meta", start, duration, height, fps, kbps, preset, live}
 *                    binary MPEG-TS chunks (fed straight into JSMpeg's demuxer)
 *                    text   {"t":"eof"} | {"t":"error", message}
 * Client -> server:  text   {"t":"flow", h}   seconds of media buffered ahead of the playhead
 *
 * Flow control: ffmpeg runs as fast as it can until the client reports more
 * than `bufferAhead` seconds of headroom; then we stop reading its stdout, the
 * pipe fills, and ffmpeg blocks (no CPU burn while paused). We resume when
 * headroom falls below bufferAhead - 4s. This gives a fast start and seeks
 * plus smooth, buffered playback, instead of JSMpeg's low-latency live mode.
 */
async function handleStream(ws, params, registry, cfg) {
  const fail = (message) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'error', message }));
      ws.close(1011, 'error');
    }
  };

  const provider = registry.get(params.get('p'));
  if (!provider) return fail('unknown provider');
  const id = params.get('id');
  if (!id) return fail('missing id');
  if (active >= cfg.stream.maxConcurrent) return fail('server busy: too many concurrent streams');

  active++;
  let child = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    active--;
    if (child && child.exitCode === null) {
      // ffmpeg may be blocked writing into a paused pipe, where SIGTERM's graceful
      // shutdown would hang; its output is worthless now, so kill outright.
      child.stdout.destroy();
      child.kill('SIGKILL');
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  const req = {
    height: params.get('h'),
    fps: params.get('fps'),
    preset: params.get('preset'),
    start: params.get('t'),
  };

  let media;
  try {
    media = await provider.resolve(id, { height: +req.height || cfg.stream.defaultHeight, fps: +req.fps || 30 });
  } catch (e) {
    cleanup();
    return fail(e.message);
  }
  if (closed) return;

  const p = plan(media, req, cfg);
  ws.send(JSON.stringify({
    t: 'meta',
    start: p.start,
    duration: media.duration || null,
    height: p.height,
    fps: p.fps,
    kbps: p.kbps,
    preset: p.preset,
    live: !!media.live,
    seekable: !!media.seekable,
  }));

  child = spawnTranscoder(media, p, cfg);
  const out = child.stdout;
  const high = cfg.stream.bufferAhead;
  const low = Math.max(1, high - 4);
  let headroom = null; // unknown until the client reports
  let reading = true;

  const updateFlow = () => {
    const sockFull = ws.bufferedAmount > WS_HIGH_WATER;
    const sockOk = ws.bufferedAmount < WS_LOW_WATER;
    if (reading && (sockFull || (headroom !== null && headroom > high))) {
      out.pause();
      reading = false;
    } else if (!reading && sockOk && (headroom === null || headroom < low)) {
      out.resume();
      reading = true;
    }
  };

  out.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > WS_HIGH_WATER) updateFlow();
  });

  const timer = setInterval(updateFlow, 200);
  ws.on('close', () => clearInterval(timer));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && msg.t === 'flow' && Number.isFinite(msg.h)) {
      headroom = msg.h;
      updateFlow();
    }
  });

  child.on('error', (e) => fail(`ffmpeg: ${e.message}`));
  child.on('close', (code, signal) => {
    clearInterval(timer);
    if (closed || ws.readyState !== ws.OPEN) return;
    if (code === 0) {
      ws.send(JSON.stringify({ t: 'eof' }));
    } else {
      const tail = child.stderrTail.trim().split('\n').slice(-2).join(' | ');
      console.warn(`[stream] ffmpeg exited ${signal || code}: ${tail}`);
      fail(`transcoder stopped (${signal || code}) ${tail}`.trim());
    }
  });
}

module.exports = { handleStream, activeStreams: () => active };
