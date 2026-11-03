/* global JSMpeg */
import { h, icon, fmt } from './ui.js';
import { prefs } from './state.js';

const MB = 1024 * 1024;
const audioCtx = () => JSMpeg.AudioOutput.WebAudio.CachedContext || null;
const now = () => performance.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Fullscreen with WebKit-prefixed fallbacks (older iPadOS Safari).
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const exitFs = () => (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
const requestFs = (el) => {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return null;
  const r = fn.call(el, { navigationUI: 'hide' });
  return r && typeof r.then === 'function' ? r : Promise.resolve();
};

/**
 * JSMpeg source backed by a WebSocket we opened ourselves (so we can read the
 * server's "meta" message and size the decode buffers before creating the player).
 *
 * `streaming = true` makes JSMpeg allocate ring buffers (bounded memory) instead
 * of growing ones; CanvasPlayer then flips the player into timed playback mode,
 * whose update loop syncs video to the audio clock and calls resume(headroom) -
 * which we forward to the server as flow control.
 */
class SocketSource {
  constructor(_url, options) {
    this.ws = options.socket;
    this.pendingData = options.pendingData;
    this.onControl = options.onControl;
    this.streaming = true;
    this.established = false;
    this.completed = false;
    this.progress = 0;
    this.destination = null;
    this.headroom = 0;
    this.lastFlow = 0;
    this.closed = false;
  }

  connect(destination) {
    this.destination = destination;
  }

  start() {
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    const queued = this.pendingData.splice(0);
    for (const d of queued) this.onMessage(d);
  }

  onMessage(data) {
    if (typeof data === 'string') {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.t === 'eof') this.completed = true;
      this.onControl && this.onControl(m);
      return;
    }
    if (!this.established) {
      this.established = true;
      this.progress = 1;
    }
    this.destination.write(data);
  }

  resume(headroom) {
    this.headroom = headroom;
    const t = now();
    if (t - this.lastFlow < 200 || this.closed) return;
    this.lastFlow = t;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'flow', h: Math.round(headroom * 100) / 100 }));
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

/**
 * Player UI + session management. Every (re)start - initial load or a seek - opens
 * a new stream on a fresh canvas stacked on top of the old one; the old canvas keeps
 * showing its last frame until the new stream decodes its first frame, so there is
 * no black flash. Output is always up to 720p / 30 fps (decided by the server).
 */
export class CanvasPlayer {
  /**
   * @param {HTMLElement} mount
   * @param {object} o  { id, startAt, streamCfg, detail?, onEnded?, onProgress?, onNext?, onTheater? }
   */
  constructor(mount, o) {
    this.o = o;
    this.id = o.id;
    this.streamCfg = o.streamCfg;
    this.detail = o.detail || null;
    this.duration = o.detail?.duration || null;
    this.seekable = true;
    this.live = false;
    this.meta = null;
    this.paused = false;
    this.ended = false;
    this.active = null; // visible entry
    this.pending = null; // loading entry, not yet showing frames
    this.seekTarget = o.startAt || 0;
    this.lastPos = o.startAt || 0;
    this.destroyed = false;

    this.volume = prefs.get('volume', 1);
    this.muted = prefs.get('muted', false);

    this.buildDom(mount);
    this.bindEvents();
    this.load(this.seekTarget);
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---------- DOM ----------

  buildDom(mount) {
    this.stage = h('div', { class: 'stage' });
    this.spinner = h('div', { class: 'spinner', hidden: true });
    this.center = h('button', { class: 'center-btn', type: 'button', hidden: true, 'aria-label': 'Play' }, icon('play', 44));
    this.unmute = h('button', { class: 'unmute', type: 'button', hidden: true }, icon('mute', 18), ' Tap to unmute');
    this.errorEl = h('div', { class: 'player-error', hidden: true });
    this.endScreen = h('div', { class: 'end-screen', hidden: true });

    this.seekBuf = h('div', { class: 'buf' });
    this.seekProg = h('div', { class: 'prog' });
    this.seekKnob = h('div', { class: 'knob' });
    this.seekTip = h('div', { class: 'tip', hidden: true });
    this.seek = h('div', { class: 'seek', role: 'slider', tabindex: '-1', 'aria-label': 'Seek' },
      h('div', { class: 'track' }, this.seekBuf, this.seekProg), this.seekKnob, this.seekTip);

    this.playBtn = h('button', { class: 'ctl', type: 'button', 'aria-label': 'Play/pause (k)' }, icon('pause'));
    this.volBtn = h('button', { class: 'ctl', type: 'button', 'aria-label': 'Mute (m)' }, icon('volume'));
    this.volRange = h('input', { class: 'vol', type: 'range', min: '0', max: '1', step: '0.02', value: String(this.volume), 'aria-label': 'Volume' });
    this.timeEl = h('div', { class: 'time' }, '0:00');
    this.nextBtn = this.o.onNext ? h('button', { class: 'ctl', type: 'button', 'aria-label': 'Next (Shift+N)', title: 'Next (Shift+N)' }, icon('next')) : null;
    this.theaterBtn = this.o.onTheater ? h('button', { class: 'ctl', type: 'button', 'aria-label': 'Theater mode (t)', title: 'Theater mode (t)' }, icon('theater')) : null;
    this.fsBtn = h('button', { class: 'ctl', type: 'button', 'aria-label': 'Full screen (f)', title: 'Full screen (f)' }, icon('fullscreen'));

    this.controls = h('div', { class: 'controls' },
      this.seek,
      h('div', { class: 'row' },
        this.playBtn,
        this.nextBtn,
        h('div', { class: 'volume' }, this.volBtn, this.volRange),
        this.timeEl,
        h('div', { class: 'spacer' }),
        this.theaterBtn, this.fsBtn));

    this.root = h('div', { class: 'player', tabindex: '0' },
      this.stage, this.spinner, this.center, this.unmute, this.errorEl, this.endScreen, this.controls);
    mount.append(this.root);
    this.syncVolumeUi();
  }

  bindEvents() {
    const r = this.root;
    // Mouse: click = play/pause, double-click = fullscreen.
    this.stage.addEventListener('click', () => {
      if (this.lastPointer !== 'mouse') return;
      this.toggle();
    });
    this.stage.addEventListener('dblclick', () => this.lastPointer === 'mouse' && this.toggleFullscreen());
    // Touch: tap = show/hide controls, double-tap sides = seek ∓10s (taps accumulate),
    // double-tap middle = fullscreen.
    this.stage.addEventListener('pointerup', (e) => this.onStageTap(e));
    this.center.addEventListener('click', () => (this.ended ? this.replay() : this.toggle()));
    r.addEventListener('pointerdown', (e) => {
      this.lastPointer = e.pointerType;
      this.downAt = { x: e.clientX, y: e.clientY, t: now() };
      if (e.pointerType !== 'mouse' && !this.isTouch) {
        this.isTouch = true;
        r.classList.add('touch');
      }
    }, true);
    r.addEventListener('contextmenu', (e) => this.isTouch && e.preventDefault());
    this.playBtn.addEventListener('click', () => this.toggle());
    this.volBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.volRange.addEventListener('input', () => this.setVolume(+this.volRange.value));
    this.fsBtn.addEventListener('click', () => this.toggleFullscreen());
    this.nextBtn?.addEventListener('click', () => this.o.onNext());
    this.theaterBtn?.addEventListener('click', () => this.o.onTheater());
    this.unmute.addEventListener('click', (e) => {
      e.stopPropagation();
      audioCtx()?.resume();
      this.unmute.hidden = true;
    });
    this.onFsChange = () => {
      const fs = fsElement() === this.root || this.root.classList.contains('pseudo-fs');
      this.fsBtn.replaceChildren(icon(fs ? 'exitfs' : 'fullscreen'));
    };
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('webkitfullscreenchange', this.onFsChange);

    // Auto-hide controls while playing.
    const wake = (this.wake = () => {
      r.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.paused && this.dragPos == null) r.classList.add('idle');
      }, this.isTouch ? 3500 : 2600);
    });
    r.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && wake());
    // Touching the control bar keeps it alive; taps on the video are handled by onStageTap.
    r.addEventListener('pointerdown', (e) => (e.pointerType === 'mouse' || !this.stage.contains(e.target)) && wake());
    r.addEventListener('keydown', wake);
    r.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && !this.paused && r.classList.add('idle'));
    wake();

    // Seek bar: hover preview + drag.
    const frac = (e) => {
      const b = this.seek.getBoundingClientRect();
      return clamp((e.clientX - b.left) / b.width, 0, 1);
    };
    let dragging = false;
    this.seek.addEventListener('pointermove', (e) => {
      if (!this.duration) return;
      const f = frac(e);
      this.seekTip.hidden = false;
      this.seekTip.textContent = fmt.time(f * this.duration);
      this.seekTip.style.left = `${f * 100}%`;
      if (dragging) this.drawProgress(f * this.duration);
    });
    this.seek.addEventListener('pointerleave', () => { if (!dragging) this.seekTip.hidden = true; });
    this.seek.addEventListener('pointerdown', (e) => {
      if (!this.duration || !this.seekable) return;
      dragging = true;
      this.dragPos = frac(e) * this.duration;
      this.seek.setPointerCapture(e.pointerId);
      this.seek.classList.add('dragging');
      this.seekTip.hidden = false;
      this.seekTip.textContent = fmt.time(this.dragPos);
      this.seekTip.style.left = `${(this.dragPos / this.duration) * 100}%`;
      this.drawProgress(this.dragPos);
    });
    this.seek.addEventListener('pointermove', (e) => { if (dragging) this.dragPos = frac(e) * this.duration; });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.seek.classList.remove('dragging');
      this.seekTip.hidden = true;
      const t = frac(e) * this.duration;
      this.dragPos = null;
      this.seekTo(t);
    };
    this.seek.addEventListener('pointerup', end);
    this.seek.addEventListener('pointercancel', end);

    // Autoplay policy: resume audio on the first gesture anywhere.
    this.onGesture = () => {
      const ctx = audioCtx();
      if (ctx && ctx.state === 'suspended' && !this.paused) ctx.resume();
      this.unmute.hidden = true;
    };
    document.addEventListener('pointerdown', this.onGesture, true);
    document.addEventListener('keydown', this.onGesture, true);

    // Pause cleanly when the tab is hidden; resume when shown.
    this.onVisibility = () => {
      if (document.hidden && !this.paused) {
        this.hiddenPause = true;
        this.pause();
      } else if (!document.hidden && this.hiddenPause) {
        this.hiddenPause = false;
        this.play();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ---------- stream lifecycle ----------

  wsUrl(t) {
    const q = new URLSearchParams({ id: this.id, t: t.toFixed(2) });
    const tok = new URLSearchParams(location.search).get('token');
    if (tok) q.set('token', tok);
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream?${q}`;
  }

  load(t) {
    if (this.destroyed) return;
    this.hideError();
    this.ended = false;
    this.endScreen.hidden = true;
    this.seekTarget = t;
    this.loadStartedAt = now();

    if (this.pending) this.dispose(this.pending);
    if (this.active) this.halt(this.active);

    const ws = new WebSocket(this.wsUrl(t));
    ws.binaryType = 'arraybuffer';
    const entry = { ws, pending: [], t0: t, meta: null, player: null, canvas: null, started: false, lastFrame: 0 };
    this.pending = entry;

    ws.onmessage = (ev) => {
      if (entry.meta) return void entry.pending.push(ev.data);
      if (typeof ev.data !== 'string') return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'error') return this.fail(entry, m.message, m.code);
      if (m.t === 'meta') {
        entry.meta = m;
        entry.t0 = m.start;
        this.applyMeta(m);
        this.createPlayer(entry);
      }
    };
    ws.onclose = () => {
      if (entry.disposed || entry.source?.completed || entry.failed) return;
      this.fail(entry, 'Connection to the server was lost.');
    };
  }

  createPlayer(entry) {
    const canvas = h('canvas', { class: 'pending' });
    this.stage.append(canvas);
    entry.canvas = canvas;

    // Size ring buffers to hold the server's buffer-ahead window plus socket slack;
    // overflowing a JSMpeg ring buffer discards it, so be generous.
    const ahead = this.streamCfg.bufferAhead || 10;
    // Capped at 64MB: tablets (iPad Safari especially) kill tabs with large heaps.
    const videoBufferSize = clamp(Math.ceil((entry.meta.kbps * 1.4 * 1000) / 8 * (ahead + 4)) + 6 * MB, 4 * MB, 64 * MB);

    const player = new JSMpeg.Player('ws-managed', {
      canvas,
      source: SocketSource,
      socket: entry.ws,
      pendingData: entry.pending,
      onControl: (m) => this.onControl(entry, m),
      audio: true,
      video: true,
      loop: false,
      pauseWhenHidden: false,
      disableGl: false,
      preserveDrawingBuffer: false,
      videoBufferSize,
      audioBufferSize: 2 * MB,
      maxAudioLag: 0.25,
      onVideoDecode: () => this.onFrame(entry),
      onEnded: () => this.onEnded(entry),
    });
    // Timed playback (A/V sync to the audio clock + headroom reporting) on top of
    // the bounded ring buffers that were allocated for "streaming".
    player.options.streaming = false;
    entry.player = player;
    entry.source = player.source;
    this.applyVolume(player);
  }

  onControl(entry, m) {
    if (m.t === 'error') this.fail(entry, m.message, m.code);
  }

  onFrame(entry) {
    entry.lastFrame = now();
    if (entry.started) return;
    entry.started = true;
    entry.canvas.classList.remove('pending');
    const old = this.active;
    this.active = entry;
    if (this.pending === entry) this.pending = null;
    if (old && old !== entry) this.dispose(old);
    this.seekTarget = null;
    this.startupMs = Math.round(now() - this.loadStartedAt);
    if (this.paused) this.freeze(entry);
    const ctx = audioCtx();
    if (ctx && ctx.state === 'suspended' && !this.paused) this.unmute.hidden = false;
  }

  onEnded(entry) {
    if (entry !== this.active) return;
    this.lastPos = this.duration || this.position;
    this.ended = true;
    this.paused = true;
    this.root.classList.remove('idle');
    this.playBtn.replaceChildren(icon('replay'));
    this.o.onEnded && this.o.onEnded(this);
  }

  /** Stop a visible entry (keeps its last frame on screen). */
  halt(entry) {
    if (entry.player) {
      this.lastPos = this.position;
      entry.player.pause();
      entry.source.destroy();
    } else {
      entry.ws.onclose = null;
      entry.ws.close();
    }
  }

  dispose(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.player) {
      try {
        entry.player.destroy();
      } catch { /* ignore */ }
    } else {
      entry.ws.onclose = null;
      try {
        entry.ws.close();
      } catch { /* ignore */ }
    }
    entry.canvas && entry.canvas.remove();
    if (this.active === entry) this.active = null;
    if (this.pending === entry) this.pending = null;
  }

  fail(entry, message, code) {
    if (entry.failed || entry.disposed) return;
    entry.failed = true;
    if (entry !== this.active && entry !== this.pending) return;
    const signIn = code === 'signin' && window.mpegyt && !window.mpegyt.session?.signedIn;
    this.errorEl.replaceChildren(...[
      h('p', {}, message || 'Playback failed.'),
      signIn ? h('button', { class: 'btn', type: 'button', onclick: () => window.mpegyt.signIn() }, 'Sign in') : null,
      code === 'unavailable' ? null : h('button', { class: `btn${signIn ? ' ghost' : ''}`, type: 'button', onclick: () => this.load(this.position) }, 'Retry'),
    ].filter(Boolean));
    this.errorEl.hidden = false;
  }

  hideError() {
    this.errorEl.hidden = true;
  }

  applyMeta(m) {
    this.meta = m;
    if (m.duration) this.duration = m.duration;
    this.seekable = m.seekable;
    this.live = m.live;
    this.root.classList.toggle('live', !!m.live);
  }

  // ---------- transport ----------

  get position() {
    if (this.dragPos != null) return this.dragPos;
    if (this.seekTarget != null) return this.seekTarget;
    const e = this.active;
    if (!e || !e.player) return this.lastPos;
    const ct = e.player.currentTime;
    let p = e.t0 + (Number.isFinite(ct) && ct > 0 ? ct : 0);
    if (this.duration) p = Math.min(p, this.duration);
    this.lastPos = p;
    return p;
  }

  /** Soft pause: stop JSMpeg's update loop and freeze the audio clock. */
  freeze(entry) {
    const pl = entry.player;
    if (!pl || entry.frozenAt) return;
    if (pl.animationId) cancelAnimationFrame(pl.animationId);
    pl.animationId = null;
    entry.frozenAt = JSMpeg.Now();
  }

  thaw(entry) {
    const pl = entry.player;
    if (!pl || !entry.frozenAt) return;
    const d = JSMpeg.Now() - entry.frozenAt;
    entry.frozenAt = 0;
    // Shift wall-clock references so the pause doesn't count as elapsed playback.
    pl.startTime += d;
    if (pl.audioOut) pl.audioOut.wallclockStartTime += d;
    pl.play();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.active && this.active.started) this.freeze(this.active);
    audioCtx()?.suspend();
    this.playBtn.replaceChildren(icon('play'));
    this.root.classList.remove('idle');
    this.flash('pause');
  }

  play() {
    if (this.ended) return this.replay();
    if (!this.paused) return;
    this.paused = false;
    audioCtx()?.resume();
    if (this.active) this.thaw(this.active);
    this.playBtn.replaceChildren(icon('pause'));
    this.flash('play');
  }

  toggle() {
    this.paused || this.ended ? this.play() : this.pause();
  }

  replay() {
    this.paused = false;
    this.ended = false;
    audioCtx()?.resume();
    this.playBtn.replaceChildren(icon('pause'));
    this.load(0);
  }

  seekTo(t) {
    if (!this.seekable) return;
    const max = this.duration ? Math.max(0, this.duration - 1) : t;
    t = clamp(t, 0, max);
    if (this.ended) {
      this.ended = false;
      this.paused = false;
      this.playBtn.replaceChildren(icon('pause'));
    }
    this.load(t);
  }

  seekBy(d) {
    this.seekTo(this.position + d);
  }

  // ---------- volume ----------

  applyVolume(pl) {
    if (pl && pl.audioOut) pl.volume = this.muted ? 0 : this.volume;
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.muted = this.volume === 0;
    prefs.set('volume', this.volume);
    prefs.set('muted', this.muted);
    this.active && this.applyVolume(this.active.player);
    this.pending && this.applyVolume(this.pending.player);
    this.syncVolumeUi();
  }

  setMuted(m) {
    this.muted = m;
    if (!m && this.volume === 0) this.volume = 0.5;
    prefs.set('muted', m);
    this.active && this.applyVolume(this.active.player);
    this.syncVolumeUi();
  }

  syncVolumeUi() {
    this.volRange.value = String(this.muted ? 0 : this.volume);
    this.volRange.style.setProperty('--v', `${(this.muted ? 0 : this.volume) * 100}%`);
    this.volBtn.replaceChildren(icon(this.muted || this.volume === 0 ? 'mute' : 'volume'));
  }

  setDetail(detail) {
    this.detail = detail;
    if (!this.duration && detail.duration) this.duration = detail.duration;
  }

  setTheater(on) {
    this.theaterBtn?.replaceChildren(icon(on ? 'theaterExit' : 'theater'));
  }

  // ---------- misc UI ----------

  isFullscreen() {
    return fsElement() === this.root || this.root.classList.contains('pseudo-fs');
  }

  toggleFullscreen() {
    if (this.root.classList.contains('pseudo-fs')) {
      this.root.classList.remove('pseudo-fs');
      return this.onFsChange();
    }
    if (fsElement()) {
      exitFs();
      return;
    }
    const p = requestFs(this.root);
    if (!p) {
      // iPhone Safari has no element fullscreen; fall back to a fixed overlay
      // (installing to the home screen gives a chrome-free window anyway).
      this.root.classList.add('pseudo-fs');
      return this.onFsChange();
    }
    p.then(() => {
      // Phones: rotate to landscape for widescreen video (ignored where unsupported).
      if (this.isTouch && screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {
      this.root.classList.add('pseudo-fs');
      this.onFsChange();
    });
  }

  // ---------- touch gestures ----------

  onStageTap(e) {
    if (e.pointerType === 'mouse') return;
    // Swipe down while fullscreen exits fullscreen (the stage is touch-action:none there).
    const d = this.downAt;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dy) > 70 && Math.abs(dx) < 80 && now() - d.t < 600) {
        if (dy > 0 && this.isFullscreen()) this.toggleFullscreen();
        return;
      }
      if (Math.hypot(dx, dy) > 24) return; // a drag, not a tap
    }
    const b = this.stage.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width;
    const side = x < 0.35 ? -1 : x > 0.65 ? 1 : 0;
    const t = now();

    // Already in a double-tap seek run on this side: every further tap adds 10s.
    if (this.tapSeek && side === this.tapSeek.side && t - this.tapSeek.last < 700) {
      this.queueTapSeek(side);
      return;
    }
    if (this.lastTap && t - this.lastTap.t < 300 && Math.abs(e.clientX - this.lastTap.x) < 60) {
      clearTimeout(this.singleTapTimer);
      this.lastTap = null;
      if (side === 0) this.toggleFullscreen();
      else if (this.seekable && !this.live) this.queueTapSeek(side);
      return;
    }
    this.lastTap = { t, x: e.clientX };
    clearTimeout(this.singleTapTimer);
    this.singleTapTimer = setTimeout(() => {
      // Single tap toggles the controls overlay.
      if (this.root.classList.contains('idle') || this.paused) this.wake();
      else {
        clearTimeout(this.idleTimer);
        this.root.classList.add('idle');
      }
    }, 260);
  }

  queueTapSeek(side) {
    const t = now();
    if (!this.tapSeek || this.tapSeek.side !== side) {
      this.tapSeek = { side, amount: 0, base: this.position, last: t };
    }
    this.tapSeek.amount += 10;
    this.tapSeek.last = t;
    this.showRipple(side, this.tapSeek.amount);
    // One stream restart per burst of taps.
    clearTimeout(this.tapSeekTimer);
    this.tapSeekTimer = setTimeout(() => {
      const s = this.tapSeek;
      this.tapSeek = null;
      if (s) this.seekTo(s.base + s.side * s.amount);
    }, 550);
  }

  showRipple(side, amount) {
    let el = this.ripple;
    if (!el || el.dataset.side !== String(side)) {
      el?.remove();
      el = this.ripple = h('div', { class: `ripple ${side < 0 ? 'left' : 'right'}`, 'data-side': String(side) },
        h('div', { class: 'ripple-label' }));
      this.root.append(el);
    }
    el.firstChild.textContent = `${side < 0 ? '−' : '+'}${amount}s`;
    el.classList.remove('go');
    void el.offsetWidth; // restart animation
    el.classList.add('go');
    clearTimeout(this.rippleTimer);
    this.rippleTimer = setTimeout(() => {
      el.remove();
      if (this.ripple === el) this.ripple = null;
    }, 900);
  }

  flash(name) {
    if (this.isTouch) return;
    const f = h('div', { class: 'flash' }, icon(name, 40));
    this.root.append(f);
    setTimeout(() => f.remove(), 500);
  }

  drawProgress(pos) {
    const d = this.duration;
    const f = d ? clamp(pos / d, 0, 1) : 0;
    this.seekProg.style.width = `${f * 100}%`;
    this.seekKnob.style.left = `${f * 100}%`;
  }

  tick = () => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.tick);
    const pos = this.position;
    const d = this.duration;

    if (this.dragPos == null) this.drawProgress(pos);
    const headroom = this.active?.source?.headroom || 0;
    this.seekBuf.style.width = d ? `${clamp((pos + Math.max(0, headroom)) / d, 0, 1) * 100}%` : '0';

    const text = this.live ? 'LIVE' : d ? `${fmt.time(pos)} / ${fmt.time(d)}` : fmt.time(pos);
    if (this.timeEl.textContent !== text) this.timeEl.textContent = text;

    // Spinner: loading, or playing but no new frame for a while.
    const e = this.active;
    const loading = !!this.pending && !this.pending.failed;
    const stalled = e && e.started && !this.paused && !this.ended && now() - e.lastFrame > 600;
    const spin = (loading && now() - this.loadStartedAt > 150) || stalled;
    if (this.spinner.hidden === !!spin) this.spinner.hidden = !spin;

    const controlsUp = !this.root.classList.contains('idle');
    const showCenter = (this.paused && !loading) || this.ended || (this.isTouch && controlsUp && !spin && !this.tapSeek);
    const centerIcon = this.ended ? 'replay' : this.paused ? 'play' : 'pause';
    if (this.center.hidden === showCenter || this.center.dataset.icon !== centerIcon) {
      this.center.hidden = !showCenter;
      this.center.dataset.icon = centerIcon;
      this.center.replaceChildren(icon(centerIcon, 44));
    }

    if (this.o.onProgress && now() - (this.lastReport || 0) > 3000 && e?.started) {
      this.lastReport = now();
      this.o.onProgress(pos, d);
    }
  };

  /** Keyboard shortcuts (called by the watch view). Returns true if handled. */
  handleKey(e) {
    const k = e.key;
    if (k === ' ' || k === 'k') this.toggle();
    else if (k === 'ArrowLeft') this.seekBy(-5);
    else if (k === 'ArrowRight') this.seekBy(5);
    else if (k === 'j') this.seekBy(-10);
    else if (k === 'l') this.seekBy(10);
    else if (k === 'ArrowUp') this.setVolume(this.volume + 0.05);
    else if (k === 'ArrowDown') this.setVolume(this.volume - 0.05);
    else if (k === 'm') this.setMuted(!this.muted);
    else if (k === 'f') this.toggleFullscreen();
    else if (k === 't' && this.o.onTheater) this.o.onTheater();
    else if (k === 'N' && e.shiftKey && this.o.onNext) this.o.onNext();
    else if (/^[0-9]$/.test(k) && this.duration) this.seekTo((+k / 10) * this.duration);
    else return false;
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    if (this.o.onProgress && this.active?.started) this.o.onProgress(this.position, this.duration);
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.tapSeekTimer);
    clearTimeout(this.singleTapTimer);
    clearTimeout(this.idleTimer);
    if (this.pending) this.dispose(this.pending);
    if (this.active) this.dispose(this.active);
    audioCtx()?.resume();
    document.removeEventListener('fullscreenchange', this.onFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onFsChange);
    document.removeEventListener('pointerdown', this.onGesture, true);
    document.removeEventListener('keydown', this.onGesture, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (fsElement() === this.root) exitFs();
    this.root.remove();
  }
}
