'use strict';
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { run } = require('../util/exec');

/**
 * A short-lived, server-side browser used only for signing in to a platform.
 *
 * Chromium runs on a private virtual X display; ffmpeg captures that display as
 * MPEG-1 (JSMpeg's low-latency live mode) and the client sends taps/keys back,
 * which are injected with xdotool. Once the user has signed in, the provider
 * extracts the session cookies from the profile and the browser is torn down.
 *
 * Reusable by any provider whose only practical login is a web form.
 */
class BrowserLoginSession {
  /**
   * @param {object} o
   * @param {object} o.config        app config
   * @param {string} o.url           page to open
   * @param {string} o.profileDir    Chromium --user-data-dir (deleted on cleanup unless keepProfile)
   * @param {RegExp} [o.doneTitle]   window title that means "signed in" (auto-finish)
   * @param {() => Promise<void>} [o.onDone]  called after Chromium has exited cleanly
   */
  constructor(o) {
    this.o = o;
    this.width = o.config.login.width;
    this.height = o.config.login.height;
    this.display = `:${o.config.login.display}`;
    this.procs = {};
    this.viewers = new Set();
    this.state = 'idle'; // idle | starting | running | finishing | done | error
    this.error = null;
    this.lastActivity = Date.now();
    this.inputQueue = Promise.resolve();
    this.pendingMove = null;
  }

  status() {
    return { state: this.state, error: this.error, width: this.width, height: this.height };
  }

  async start() {
    if (this.state === 'starting' || this.state === 'running') return this.status();
    this.state = 'starting';
    this.error = null;
    const bin = this.o.config.bin;
    const env = { ...process.env, DISPLAY: this.display };

    try {
      await fsp.mkdir(this.o.profileDir, { recursive: true });
      // Stale lock from a crashed run would stop Chromium from starting.
      await fsp.rm(`${this.o.profileDir}/SingletonLock`, { force: true });
      await fsp.rm(`/tmp/.X${this.display.slice(1)}-lock`, { force: true });

      this.procs.xvfb = spawn(bin.xvfb, [this.display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
      await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${this.display.slice(1)}`), 5000, 'virtual display did not start');

      this.procs.chrome = spawn(bin.chromium, [
        `--user-data-dir=${this.o.profileDir}`,
        // Chromium's sandbox needs user namespaces, which containers usually lack.
        // The browser is only pointed at the sign-in page and lives for minutes.
        '--no-sandbox',
        // ...and hide the resulting "unsupported command-line flag" warning bar.
        '--test-type',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        // Cookies encrypted with Chromium's fixed "basic" key so yt-dlp can read them.
        '--password-store=basic',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--disable-sync',
        '--lang=en-US',
        '--force-device-scale-factor=1',
        '--window-position=0,0',
        `--window-size=${this.width},${this.height}`,
        `--app=${this.o.url}`,
      ], { env, stdio: 'ignore' });
      this.procs.chrome.on('exit', () => {
        if (this.state === 'running') this.fail('The sign-in browser closed unexpectedly.');
      });

      this.startCapture(env);
      this.state = 'running';
      this.watchTimer = setInterval(() => this.watch(), 1500);
    } catch (e) {
      this.fail(e.message);
      throw e;
    }
    return this.status();
  }

  startCapture(env) {
    const ff = spawn(this.o.config.bin.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '25',
      '-video_size', `${this.width}x${this.height}`, '-i', `${this.display}.0+0,0`,
      '-c:v', 'mpeg1video', '-q:v', '4', '-bf', '0', '-g', '25', '-r', '25', '-an',
      '-f', 'mpegts', '-muxdelay', '0.001', 'pipe:1',
    ], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    this.procs.ffmpeg = ff;
    ff.stdout.on('data', (chunk) => {
      for (const ws of this.viewers) {
        // Live view: if a viewer can't keep up, skip data rather than queue it.
        if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(chunk, { binary: true });
      }
    });
    ff.on('exit', () => {
      if (this.state === 'running') setTimeout(() => this.state === 'running' && this.startCapture(env), 500);
    });
  }

  /** Attach a screen viewer (JSMpeg WebSocket). Restart capture so the viewer gets a fresh header. */
  addViewer(ws) {
    this.viewers.add(ws);
    this.lastActivity = Date.now();
    ws.on('close', () => this.viewers.delete(ws));
    // No restart needed: a new GOP (with sequence header) starts every second (-g 25).
  }

  addInputSocket(ws) {
    this.inputSockets = this.inputSockets || new Set();
    this.inputSockets.add(ws);
    ws.on('close', () => this.inputSockets.delete(ws));
  }

  /** Inputs from the client, already validated by parseInput. */
  input(msg) {
    this.lastActivity = Date.now();
    if (this.state !== 'running') return;
    const W = this.width;
    const H = this.height;
    const xy = (m) => [clampInt(m.x * W, 0, W - 1), clampInt(m.y * H, 0, H - 1)];
    switch (msg.t) {
      case 'move': {
        // Coalesce rapid moves; only the latest position matters.
        const first = !this.pendingMove;
        this.pendingMove = xy(msg);
        if (first) this.enqueue(() => {
          const [x, y] = this.pendingMove;
          this.pendingMove = null;
          return ['mousemove', String(x), String(y)];
        });
        break;
      }
      case 'down':
      case 'up': {
        const [x, y] = xy(msg);
        const btn = String([1, 2, 3].includes(msg.b) ? msg.b : 1);
        this.enqueue(() => ['mousemove', String(x), String(y), msg.t === 'down' ? 'mousedown' : 'mouseup', btn]);
        break;
      }
      case 'wheel': {
        const n = clampInt(Math.abs(msg.dy), 1, 15);
        this.enqueue(() => ['click', '--repeat', String(n), '--delay', '10', msg.dy > 0 ? '5' : '4']);
        break;
      }
      case 'key':
        if (KEYS[msg.key]) this.enqueue(() => ['key', '--clearmodifiers', KEYS[msg.key]]);
        else if (msg.combo && /^(ctrl|alt|shift)\+[a-z]$/.test(msg.combo)) this.enqueue(() => ['key', msg.combo]);
        break;
      case 'text':
        if (typeof msg.s === 'string' && msg.s.length <= 512) this.enqueue(() => ['type', '--delay', '12', '--', msg.s]);
        break;
      default:
    }
  }

  enqueue(argsFn) {
    this.inputQueue = this.inputQueue
      .then(() => run(this.o.config.bin.xdotool, argsFn(), { timeoutMs: 10_000, env: { DISPLAY: this.display } }))
      .catch(() => {});
  }

  /** Auto-finish when the browser lands on the signed-in page; time out abandoned sessions. */
  async watch() {
    if (this.state !== 'running') return;
    if (Date.now() - this.lastActivity > this.o.config.login.idleTimeoutMs && !this.viewers.size) {
      this.fail('Sign-in timed out.');
      return this.cleanup();
    }
    if (!this.o.doneTitle) return;
    try {
      const out = await run(this.o.config.bin.xdotool, ['search', '--name', this.o.doneTitle.source], { timeoutMs: 3000, env: { DISPLAY: this.display } });
      if (out.trim()) this.finish().catch(() => {});
    } catch { /* no match */ }
  }

  /** Close Chromium cleanly (flushes cookies to disk), then hand over to the provider. */
  async finish() {
    if (this.state !== 'running') return this.status();
    this.state = 'finishing';
    clearInterval(this.watchTimer);
    this.broadcast({ t: 'finishing' });
    const chrome = this.procs.chrome;
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((r) => chrome.once('exit', r));
      chrome.kill('SIGTERM');
      await Promise.race([exited, delay(8000)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    try {
      await this.o.onDone();
      this.state = 'done';
    } catch (e) {
      this.fail(e.message);
    }
    this.broadcast({ t: this.state, error: this.error });
    await this.cleanup();
    return this.status();
  }

  fail(message) {
    this.state = 'error';
    this.error = message;
  }

  broadcast(msg) {
    // Screen sockets are binary-only (JSMpeg); status goes over the input sockets.
    for (const ws of this.inputSockets || []) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async cleanup() {
    clearInterval(this.watchTimer);
    for (const p of [this.procs.ffmpeg, this.procs.chrome, this.procs.xvfb]) {
      if (p && p.exitCode === null) p.kill('SIGKILL');
    }
    this.procs = {};
    for (const ws of this.viewers) ws.close();
    this.viewers.clear();
    if (!this.o.keepProfile) await fsp.rm(this.o.profileDir, { recursive: true, force: true }).catch(() => {});
  }

  async cancel() {
    if (this.state === 'running' || this.state === 'starting') this.state = 'idle';
    await this.cleanup();
    this.state = 'idle';
    return this.status();
  }
}

/** Browser KeyboardEvent.key → X keysym for non-text keys. Text goes through xdotool type. */
const KEYS = {
  Enter: 'Return', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', Escape: 'Escape',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ' ': 'space',
  'Shift+Tab': 'shift+Tab', 'Alt+ArrowLeft': 'alt+Left',
};

/** Validate one client input message (untrusted). */
function parseInput(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m.t !== 'string') return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (['move', 'down', 'up'].includes(m.t) && !(num(m.x) && num(m.y))) return null;
  if (m.t === 'wheel' && !num(m.dy)) return null;
  return m;
}

function clampInt(v, a, b) {
  return Math.max(a, Math.min(b, Math.round(v)));
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error(msg);
}

module.exports = { BrowserLoginSession, parseInput };
