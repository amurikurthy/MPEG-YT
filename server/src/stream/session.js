'use strict';
const { plan, spawnTranscoder } = require('./transcoder');

const WS_HIGH_WATER = 4 * 1024 * 1024; // bytes queued in the socket before we stop reading ffmpeg
const WS_LOW_WATER = 1 * 1024 * 1024;
let active = 0;

/**
 * One WebSocket = one playback session = one ffmpeg process.
 *
 * Server -> client:  text   {"t":"meta", start, duration, height, fps, kbps, live}
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
async function handleStream(ws, params, streams, cfg) {
  const id = params.get('id');
  const fail = (raw) => {
    // A refused/expired source link: forget it so the next attempt resolves fresh ones.
    if (id && RETRYABLE.test(String(raw))) streams.invalidate?.(id);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'error', ...explain(raw, streams.account?.signedIn) }));
      ws.close(1011, 'error');
    }
  };

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
    start: params.get('t'),
  };

  const t0 = Date.now();
  let resolvedIn = 0;
  let media;
  try {
    media = await streams.resolve(id);
    resolvedIn = Date.now() - t0;
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
    live: !!media.live,
    seekable: !!media.seekable,
  }));

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

  let out = null;
  let sent = 0;
  let retried = false;
  const spawn = () => {
    child = spawnTranscoder(media, p, cfg);
    out = child.stdout;
    reading = true;
    out.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      // Start-up time, for diagnosing slow starts: link lookup vs. download + encode.
      if (!sent) console.log(`[stream] ${id}: first data after ${Date.now() - t0} ms (links ${resolvedIn} ms${retried ? ', after a retry' : ''})`);
      sent += chunk.length;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount > WS_HIGH_WATER) updateFlow();
    });
    child.on('error', (e) => fail(`ffmpeg: ${e.message}`));
    child.on('close', onExit);
  };

  const onExit = async (code, signal) => {
    if (closed || ws.readyState !== ws.OPEN) return clearInterval(timer);
    if (code === 0) {
      clearInterval(timer);
      return ws.send(JSON.stringify({ t: 'eof' }));
    }
    const tail = child.stderrTail.trim().split('\n').slice(-2).join(' | ');
    console.warn(`[stream] ${id}: ffmpeg exited ${signal || code}: ${tail}`);
    // YouTube refused the cached stream links (expired, or issued to a different
    // session): resolve fresh ones and start over - nothing was sent yet, so the
    // viewer just sees a slightly longer load.
    if (!retried && sent === 0 && RETRYABLE.test(tail)) {
      retried = true;
      streams.invalidate?.(id);
      try {
        media = await streams.resolve(id);
      } catch (e) {
        clearInterval(timer);
        return fail(e.message);
      }
      if (closed) return;
      console.log(`[stream] ${id}: retrying with fresh stream links`);
      return spawn();
    }
    clearInterval(timer);
    fail(`transcoder stopped (${signal || code}) ${tail}`.trim());
  };

  const timer = setInterval(updateFlow, 200);
  spawn();
  // Report what's already downloaded (seek bar's gray ranges) about once a second.
  let lastCached = '';
  const cachedTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN || typeof streams.coverage !== 'function') return;
    const ranges = streams.coverage(media);
    const key = JSON.stringify(ranges);
    if (!ranges || key === lastCached) return;
    lastCached = key;
    ws.send(JSON.stringify({ t: 'cached', ranges }));
  }, 1000);
  ws.on('close', () => clearInterval(cachedTimer));
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
}

/** Errors that fresh stream links usually fix. */
const RETRYABLE = /\b(403|410)\b|forbidden|\bgone\b|expired/i;

/** Turn yt-dlp/ffmpeg failures into something a viewer can act on. */
function explain(raw, signedIn = false) {
  const msg = String(raw || '');
  if (/confirm you.?re not a bot|sign in to confirm|LOGIN_REQUIRED/i.test(msg)) {
    return { code: 'signin', message: 'YouTube wants this server to sign in before it plays videos. Sign in to continue.' };
  }
  if (/age.?restricted|confirm your age|inappropriate for some users/i.test(msg)) {
    return { code: 'signin', message: 'This video is age-restricted. Sign in with an account that can watch it.' };
  }
  if (RETRYABLE.test(msg) && signedIn) {
    return { code: 'expired', message: 'YouTube stopped sending this video. Retrying usually fixes it.' };
  }
  if (RETRYABLE.test(msg)) {
    return { code: 'signin', message: 'YouTube refused to send this video to the server. Signing in usually fixes this.' };
  }
  if (/members.?only|join this channel/i.test(msg)) return { code: 'unavailable', message: 'This video is for channel members only.' };
  if (/private video/i.test(msg)) return { code: 'unavailable', message: 'This video is private.' };
  if (/not available in your country|geo.?restrict/i.test(msg)) return { code: 'unavailable', message: 'This video isn’t available in your server’s country.' };
  if (/video unavailable|has been removed|does not exist/i.test(msg)) return { code: 'unavailable', message: 'This video isn’t available anymore.' };
  if (/live event will begin|premieres? in/i.test(msg)) return { code: 'unavailable', message: 'This video hasn’t started yet.' };
  if (/server busy/i.test(msg)) return { code: 'busy', message: 'The server is busy with other streams. Try again in a moment.' };
  // Keep the useful tail of tool errors, drop the noise.
  const tail = msg.replace(/^.*?ERROR:\s*(\[[^\]]*\]\s*[\w-]+:\s*)?/s, '').replace(/\s*See\s+https?:\/\/\S+.*$/s, '').trim();
  return { code: 'error', message: tail || 'Playback failed.' };
}

module.exports = { handleStream, activeStreams: () => active, explain };
