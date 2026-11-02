import { prefetchItem } from './api.js';

/** Tiny DOM builder. Text children are always inserted as text (no HTML injection). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  replay: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  volume: 'M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  mute: 'M4 9v6h4l5 4V5L8 9H4zm16.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z',
  settings: 'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.7a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  fullscreen: 'M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z',
  exitfs: 'M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z',
  back: 'M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  next: 'M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z',
  account: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z',
  moon: 'M12.3 2a10 10 0 1 0 9.7 12.4A8 8 0 0 1 12.3 2z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z',
};

export function icon(name, size = 24) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', ICONS[name] || '');
  svg.append(p);
  return svg;
}

// ---------- formatting ----------

export const fmt = {
  time(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  },
  compact(n) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  },
  views(n) {
    return Number.isFinite(n) ? `${fmt.compact(n)} views` : '';
  },
  ago(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [sec, unit] of units) if (s >= sec) return rtf.format(-Math.floor(s / sec), unit);
    return 'just now';
  },
};

// ---------- routing helpers ----------

const enc = encodeURIComponent;
export const href = {
  home: (pid) => `#/${enc(pid)}`,
  search: (pid, q) => `#/${enc(pid)}/search?q=${enc(q)}`,
  watch: (pid, id, t) => `#/${enc(pid)}/watch/${enc(id)}${t ? `?t=${Math.floor(t)}` : ''}`,
  collection: (pid, id) => `#/${enc(pid)}/c/${enc(id)}`,
  item: (pid, item) => (item.kind === 'collection' ? href.collection(pid, item.id) : href.watch(pid, item.id)),
};

// ---------- cards ----------

function thumb(src, cls, alt = '') {
  const wrap = h('div', { class: cls });
  if (src) {
    const img = h('img', { src, alt, loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    wrap.append(img);
  }
  return wrap;
}

/**
 * Render an Item. layout: 'grid' (thumbnail on top) | 'row' (thumbnail left).
 * opts.progress: 0..1 watched fraction; opts.startAt: resume position.
 */
export function card(pid, item, { layout = 'grid', progress, startAt } = {}) {
  if (item.kind === 'collection') {
    const round = item.variant === 'channel';
    const t = thumb(item.thumbnail, `thumb ${round ? 'round' : 'collection'}`);
    if (!item.thumbnail) t.append(h('div', { class: 'thumb-icon' }, icon(item.variant === 'folder' ? 'folder' : 'play', 40)));
    return h('a', { class: `card ${layout} collection ${round ? 'channel' : ''}`, href: href.collection(pid, item.id) },
      t,
      h('div', { class: 'meta' },
        h('div', { class: 'title' }, item.title),
        item.subtitle ? h('div', { class: 'sub' }, item.subtitle) : null));
  }

  const t = thumb(item.thumbnail, 'thumb');
  if (item.live) t.append(h('span', { class: 'badge live' }, 'LIVE'));
  else if (item.duration) t.append(h('span', { class: 'badge' }, fmt.time(item.duration)));
  if (progress > 0) t.append(h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, progress * 100)}%` } })));

  const facts = [fmt.views(item.views), fmt.ago(item.published)].filter(Boolean).join(' · ');
  const a = h('a', { class: `card ${layout} video`, href: href.watch(pid, item.id, startAt) },
    t,
    h('div', { class: 'meta' },
      h('div', { class: 'title', title: item.title }, item.title),
      item.subtitle ? h('div', { class: 'sub' }, item.subtitle) : null,
      facts ? h('div', { class: 'sub' }, facts) : null));

  // Warm metadata + stream URL resolution while the pointer rests on a card.
  let timer;
  a.addEventListener('pointerenter', () => { timer = setTimeout(() => prefetchItem(pid, item.id), 120); });
  a.addEventListener('pointerleave', () => clearTimeout(timer));
  a.addEventListener('focus', () => prefetchItem(pid, item.id));
  // Touch has no hover: start warming on finger-down, ~100-300ms before the click lands.
  a.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') prefetchItem(pid, item.id); }, { passive: true });
  return a;
}

export function grid(pid, items, opts) {
  return h('div', { class: 'grid' }, items.map((it) => card(pid, it, opts)));
}

export function skeletonGrid(n = 12) {
  return h('div', { class: 'grid' }, Array.from({ length: n }, () =>
    h('div', { class: 'card grid skeleton' }, h('div', { class: 'thumb' }), h('div', { class: 'meta' }, h('div', { class: 'line' }), h('div', { class: 'line short' })))));
}

export function skeletonRows(n = 8) {
  return h('div', { class: 'rows' }, Array.from({ length: n }, () =>
    h('div', { class: 'card row skeleton' }, h('div', { class: 'thumb' }), h('div', { class: 'meta' }, h('div', { class: 'line' }), h('div', { class: 'line short' })))));
}

export function errorBox(message, retry) {
  return h('div', { class: 'error-box' },
    h('p', {}, message || 'Something went wrong.'),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again') : null);
}

export function empty(message) {
  return h('div', { class: 'empty' }, message);
}
