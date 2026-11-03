'use strict';
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { run } = require('../util/exec');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { readerScript } = require('./page-reader');

/**
 * A short-lived, server-side browser used only for signing in to a platform.
 *
 * Chromium runs on a private virtual X display and is driven over the DevTools
 * protocol (a private pipe): the current sign-in step is read into a plain
 * description (see page-reader.js) that the app shows as a native form, and what
 * the user enters is typed/clicked into the real page as trusted input events.
 *
 * Fallback for steps a form can't express: ffmpeg captures the display as MPEG-1
 * (JSMpeg's low-latency live mode) and the client sends taps/keys back, injected
 * with xdotool. Once the user has signed in, the account module extracts the
 * session cookies from the profile and the browser is torn down.
 *
 * The browser exists only for the few minutes the sign-in takes.
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
    // Chromium needs writable HOME/XDG folders (and dies without a window if it has
    // none); keep them next to the throwaway profile instead of trusting $HOME.
    const home = `${this.o.profileDir}-home`;
    const env = {
      ...process.env,
      DISPLAY: this.display,
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_CACHE_HOME: `${home}/.cache`,
      XDG_RUNTIME_DIR: `${home}/.run`,
    };

    try {
      await fsp.mkdir(this.o.profileDir, { recursive: true });
      for (const d of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR]) await fsp.mkdir(d, { recursive: true, mode: 0o700 });
      // No "Save password?" bubbles or sign-in-to-Chrome prompts over the page.
      await fsp.mkdir(`${this.o.profileDir}/Default`, { recursive: true });
      await fsp.writeFile(`${this.o.profileDir}/Default/Preferences`, JSON.stringify({
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
        profile: { password_manager_enabled: false },
        signin: { allowed: false },
        autofill: { profile_enabled: false, credit_card_enabled: false },
      }));
      // Stale lock from a crashed run would stop Chromium from starting.
      await fsp.rm(`${this.o.profileDir}/SingletonLock`, { force: true });
      await fsp.rm(`/tmp/.X${this.display.slice(1)}-lock`, { force: true });

      this.procs.xvfb = spawn(bin.xvfb, [this.display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
      await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${this.display.slice(1)}`), 5000, 'virtual display did not start');
      await this.startBridge();

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
        '--disable-breakpad',
        '--disable-crash-reporter',
        // No GPU in a container: render in software rather than show a black window.
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--lang=en-US',
        '--force-device-scale-factor=1',
        '--window-position=0,0',
        `--window-size=${this.width},${this.height}`,
        // The sign-in bridge (see startBridge); nothing else may be loaded.
        `--disable-extensions-except=${this.extDir}`,
        `--load-extension=${this.extDir}`,
        ...(this.o.config.login.extraArgs || []),
        `--app=${this.o.url}`,
      ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      const chrome = this.procs.chrome;
      let stderr = '';
      chrome.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      chrome.on('error', (e) => this.fail(`Could not start the sign-in browser: ${e.message}`));
      chrome.on('exit', (code, signal) => {
        if (this.state !== 'running' && this.state !== 'starting') return;
        const why = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[[\d/:.]+:(INFO|WARNING|VERBOSE)/.test(l)).slice(-3).join(' | ');
        console.warn(`[login] chromium exited (${signal || code}): ${why || 'no output'}`);
        this.fail(`The sign-in browser closed unexpectedly${why ? ` (${why.slice(0, 300)})` : ''}.`);
      });
      // Catch a browser that dies on startup instead of leaving a black screen.
      await new Promise((r) => setTimeout(r, 1500));
      if (chrome.exitCode !== null || chrome.signalCode) throw new Error(this.error || 'The sign-in browser did not start.');

      this.env = env;
      this.state = 'running';
      this.watchTimer = setInterval(() => this.watch(), 1500);
    } catch (e) {
      this.fail(e.message);
      throw e;
    }
    return this.status();
  }

  /**
   * Private channel to the bridge extension inside the sign-in browser: a
   * WebSocket on 127.0.0.1 with a random port and a one-time key. (The DevTools
   * protocol can't be used: Google refuses sign-in from any browser started with
   * remote debugging enabled.)
   */
  async startBridge() {
    const key = crypto.randomBytes(24).toString('hex');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 4 * 1024 * 1024 });
    await new Promise((resolve, reject) => wss.once('listening', resolve).once('error', reject));
    this.bridgeServer = wss;
    this.bridgeCalls = new Map();
    wss.on('connection', (ws, req) => {
      if (new URL(req.url, 'http://x').searchParams.get('key') !== key) return ws.close();
      this.bridge = ws;
      ws.on('message', (data) => {
        let m;
        try {
          m = JSON.parse(data);
        } catch {
          return;
        }
        if (m.t === 'reply') {
          const call = this.bridgeCalls.get(m.id);
          if (call) {
            this.bridgeCalls.delete(m.id);
            clearTimeout(call.timer);
            call.resolve(m);
          }
        } else if (m.t === 'page' && m.page) {
          this.onPage(m.page).catch(() => {});
        }
      });
      ws.on('close', () => {
        if (this.bridge === ws) this.bridge = null;
      });
    });
    // The extension, with this session's address and key.
    const dir = `${this.o.profileDir}-ext`;
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const src = path.join(__dirname, 'extension');
    for (const f of await fsp.readdir(src)) await fsp.copyFile(path.join(src, f), path.join(dir, f));
    await fsp.writeFile(path.join(dir, 'reader.js'), readerScript);
    await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ port: wss.address().port, key }));
    this.extDir = dir;
  }

  /** Ask the extension something; resolves with its reply (or null). */
  ask(msg, timeoutMs = 5000) {
    const ws = this.bridge;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.resolve(null);
    const id = ++this.bridgeSeq || (this.bridgeSeq = 1);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bridgeCalls.delete(id);
        resolve(null);
      }, timeoutMs);
      this.bridgeCalls.set(id, { resolve, timer });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** A new sign-in step from the page: pass it to the form. */
  async onPage(pg) {
    if (this.state !== 'running') return;
    for (const img of pg.images || []) {
      const loc = await this.ask({ t: 'locate', ref: img.ref });
      const shot = loc && loc.view ? await this.ask({ t: 'snap', box: loc.view }) : null;
      img.src = shot && shot.src ? shot.src : null;
    }
    this.page = pg;
    this.broadcast({ t: 'page', page: pg });
  }

  xdo(args) {
    return run(this.o.config.bin.xdotool, args, { timeoutMs: 15_000, env: { DISPLAY: this.display } });
  }

  /** A real (OS-level) click in the middle of an element; returns what the page said about it. */
  async click(ref) {
    const loc = await this.ask({ t: 'locate', ref });
    if (!loc || !loc.box) return null;
    const x = Math.round(loc.box.x + loc.box.w / 2);
    const y = Math.round(loc.box.y + loc.box.h / 2);
    await this.xdo(['mousemove', String(x), String(y), 'click', '1']);
    return loc;
  }

  /** Put a value into a field the way a person would: click it, select all, type. */
  async fill(f) {
    const field = this.page && this.page.fields.find((x) => x.ref === f.ref);
    if (!field) return;
    if (field.kind === 'checkbox' || field.kind === 'radio') {
      const loc = await this.ask({ t: 'locate', ref: f.ref });
      if (loc && typeof f.checked === 'boolean' && f.checked !== !!loc.checked) await this.click(f.ref);
      return;
    }
    if (field.kind === 'select') {
      await this.ask({ t: 'select', ref: f.ref, value: String(f.value || '') });
      return;
    }
    if (!(await this.click(f.ref))) return;
    await this.xdo(['key', '--clearmodifiers', 'ctrl+a', 'BackSpace']);
    if (f.value) await this.xdo(['type', '--clearmodifiers', '--delay', '8', '--', String(f.value)]);
  }

  /** Form submission from the app: fill fields, then click a button (or press Enter). */
  async act(msg) {
    try {
      if (msg.t === 'form') {
        for (const f of msg.fields || []) await this.fill(f);
        if (msg.submit === 'enter') await this.xdo(['key', '--clearmodifiers', 'Return']);
        else if (msg.submit) await this.click(msg.submit);
      } else if (msg.t === 'click') {
        await this.click(msg.ref);
      } else if (msg.t === 'nav' && msg.to === 'back') {
        await this.ask({ t: 'back' });
      }
    } catch (e) {
      console.warn(`[login] ${msg.t}: ${e.message}`);
    }
    // Report the resulting step even if it looks unchanged, so the form can stop its spinner.
    await delay(500);
    this.ask({ t: 'read' });
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
      if (this.procs.ffmpeg === ff) this.procs.ffmpeg = null;
      if (this.state === 'running' && this.viewers.size) setTimeout(() => this.state === 'running' && this.viewers.size && !this.procs.ffmpeg && this.startCapture(env), 500);
    });
  }

  /**
   * Attach a screen viewer (JSMpeg WebSocket). The display is only captured while
   * someone watches it (the browser view); the form needs no video.
   */
  addViewer(ws) {
    this.viewers.add(ws);
    this.lastActivity = Date.now();
    clearTimeout(this.captureStop);
    if (!this.procs.ffmpeg && this.state === 'running') this.startCapture(this.env);
    ws.on('close', () => {
      this.viewers.delete(ws);
      if (this.viewers.size) return;
      clearTimeout(this.captureStop);
      this.captureStop = setTimeout(() => {
        if (!this.viewers.size && this.procs.ffmpeg) this.procs.ffmpeg.kill('SIGKILL');
      }, 10_000);
    });
    // New viewers need no restart: a new GOP (with sequence header) starts every second (-g 25).
  }

  addInputSocket(ws) {
    this.inputSockets = this.inputSockets || new Set();
    this.inputSockets.add(ws);
    this.lastActivity = Date.now();
    ws.on('close', () => this.inputSockets.delete(ws));
    if (this.page && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'page', page: this.page }));
    else this.ask({ t: 'read' });
  }

  /** Inputs from the client, already validated by parseInput. */
  input(msg) {
    this.lastActivity = Date.now();
    if (this.state !== 'running') return;
    if (msg.t === 'form' || msg.t === 'click' || msg.t === 'nav') {
      this.actions = (this.actions || Promise.resolve()).then(() => this.act(msg));
      return;
    }
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
    if (Date.now() - this.lastActivity > this.o.config.login.idleTimeoutMs && !this.viewers.size && !this.inputSockets?.size) {
      this.fail('Sign-in timed out.');
      return this.cleanup();
    }
    if (!this.o.doneTitle) return;
    try {
      const out = await run(this.o.config.bin.xdotool, ['search', '--name', this.o.doneTitle.source], { timeoutMs: 3000, env: { DISPLAY: this.display } });
      if (out.trim()) this.finish().catch(() => {});
    } catch { /* no match */ }
  }

  /** Close Chromium cleanly (flushes cookies to disk), then hand over to the account module. */
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
    clearTimeout(this.captureStop);
    this.page = null;
    if (this.bridgeServer) {
      for (const c of this.bridgeServer.clients) c.terminate();
      this.bridgeServer.close();
      this.bridgeServer = null;
    }
    this.bridge = null;
    if (this.extDir) await fsp.rm(this.extDir, { recursive: true, force: true }).catch(() => {});
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
  const ref = (v) => typeof v === 'string' && /^\d{1,7}$/.test(v);
  if (m.t === 'click' && !ref(m.ref)) return null;
  if (m.t === 'form') {
    if (!Array.isArray(m.fields) || m.fields.length > 16) return null;
    if (m.submit != null && m.submit !== 'enter' && !ref(m.submit)) return null;
    const ok = m.fields.every((f) => f && ref(f.ref)
      && (f.value === undefined || (typeof f.value === 'string' && f.value.length <= 512))
      && (f.checked === undefined || typeof f.checked === 'boolean'));
    if (!ok) return null;
  }
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
