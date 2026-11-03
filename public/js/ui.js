import { api, prefetch, prefetchWhenVisible } from './api.js';
import { history } from './state.js';

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

// Material Design icon paths (Apache-2.0).
const ICONS = {
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  subscriptions: 'M20 8H4V6h16v2zm-2-6H6v2h12V2zm4 10v8c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-8c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2zm-6 4-6-3.27v6.53L16 16z',
  you: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2a7.2 7.2 0 0 1-6-3.22c.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08a7.2 7.2 0 0 1-6 3.22z',
  history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  watchlater: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z',
  liked: 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
  dislike: 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z',
  playlists: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z',
  save: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  verified: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  chevronRight: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  chevronLeft: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  appearance: 'M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z',
  views: 'M10 8.64 15.27 12 10 15.36V8.64M8 5v14l11-7L8 5z',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  replay: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  exitfs: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  theater: 'M19 7H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 8H5V9h14v6z',
  theaterExit: 'M19 6H5c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H5V8h14v8z',
  account: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z',
  error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  pin: 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  live: 'M8.16 16.19a5.98 5.98 0 0 1 0-8.38l-1.41-1.42a7.98 7.98 0 0 0 0 11.22l1.41-1.42zm7.68-8.38a5.98 5.98 0 0 1 0 8.38l1.41 1.42a7.98 7.98 0 0 0 0-11.22l-1.41 1.42zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};

export function icon(name, size = 24) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `i i-${name}`);
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
    return Number.isFinite(n) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '';
  },
};

// ---------- links ----------

const enc = encodeURIComponent;
export const href = {
  watch: (id, t) => `/watch?v=${enc(id)}${t ? `&t=${Math.floor(t)}` : ''}`,
  channel: (c) => (c && c.id ? `/channel/${enc(c.id)}` : null),
  results: (q) => `/results?search_query=${enc(q)}`,
  playlist: (id) => `/playlist?list=${enc(id)}`,
};

// ---------- shared bits ----------

function img(src, cls, alt = '') {
  if (!src) return h('div', { class: `${cls} placeholder` });
  const i = h('img', { class: cls, src, alt, loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' });
  i.addEventListener('load', () => i.classList.add('loaded'), { once: true });
  i.addEventListener('error', () => i.classList.add('broken'), { once: true });
  return i;
}

export function avatar(src, size = 36, alt = '') {
  return h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px` } }, img(src, 'avatar-img', alt));
}

export function channelName(c, cls = 'channel-name') {
  if (!c || !c.name) return null;
  const inner = [c.name, c.verified ? icon('verified', 14) : null];
  const link = href.channel(c);
  return link ? h('a', { class: cls, href: link, title: c.name }, inner) : h('span', { class: cls }, inner);
}

function thumb(item, { size = 'grid' } = {}) {
  const resume = history.get(item.id);
  const progress = item.progress ?? (resume && resume.duration ? resume.pos / resume.duration : 0);
  return h('a', { class: `thumb t-${size}`, href: href.watch(item.id), tabindex: '-1', 'aria-hidden': 'true' },
    img(item.thumbnail, 'thumb-img'),
    item.live
      ? h('span', { class: 'badge live' }, icon('live', 14), 'LIVE')
      : item.durationText ? h('span', { class: 'badge' }, item.durationText) : null,
    progress > 0.02 ? h('div', { class: 'resume' }, h('span', { style: { width: `${Math.min(100, progress * 100)}%` } })) : null);
}

/** "▷ 1.4M  4d ago" - the compact stats line from the grid. */
function stats(item, { long = false } = {}) {
  const views = item.live ? (item.viewsText ? `${item.viewsText} watching` : '') : item.viewsText ? (long ? `${item.viewsText} views` : item.viewsText) : '';
  return h('span', { class: 'stats' },
    views ? h('span', { class: 'views' }, long ? null : icon('views', 14), views) : null,
    item.publishedText ? h('span', { class: 'age' }, item.publishedText) : null);
}

function warm(el, id) {
  let t;
  el.addEventListener('pointerenter', () => { t = setTimeout(() => prefetch(id), 150); });
  el.addEventListener('pointerleave', () => clearTimeout(t));
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') prefetch(id); }, { passive: true });
  prefetchWhenVisible(el, id);
}

// ---------- cards ----------

/** Home / subscriptions / channel grid card (as in the screenshot). */
export function videoCard(item, { showChannel = true } = {}) {
  if (item.kind === 'playlist') return playlistCard(item);
  if (item.kind === 'channel') return channelCard(item);
  const el = h('div', { class: 'vcard' },
    thumb(item),
    h('div', { class: 'vcard-details' },
      showChannel && item.channel
        ? h(item.channel.id ? 'a' : 'span', { class: 'vcard-avatar', href: href.channel(item.channel), tabindex: '-1' }, avatar(item.channel.avatar, 36))
        : null,
      h('div', { class: 'vcard-meta' },
        h('a', { class: 'vcard-title', href: href.watch(item.id), title: item.title }, item.title),
        h('div', { class: 'byline' }, showChannel ? channelName(item.channel) : null, stats(item))),
      kebab(item)));
  warm(el, item.id);
  return el;
}

/** Search results row: big thumbnail left. */
export function videoRow(item) {
  if (item.kind === 'channel') return channelRow(item);
  if (item.kind === 'playlist') return playlistCard(item, 'row');
  const el = h('div', { class: 'vrow' },
    thumb(item, { size: 'row' }),
    h('div', { class: 'vrow-meta' },
      h('div', { class: 'vrow-head' },
        h('a', { class: 'vrow-title', href: href.watch(item.id), title: item.title }, item.title),
        kebab(item)),
      h('div', { class: 'vrow-stats' }, stats(item, { long: true })),
      item.channel ? h('div', { class: 'vrow-channel' },
        item.channel.id ? h('a', { href: href.channel(item.channel), tabindex: '-1' }, avatar(item.channel.avatar, 24)) : avatar(item.channel.avatar, 24),
        channelName(item.channel)) : null,
      item.snippet ? h('div', { class: 'vrow-snippet' }, item.snippet) : null,
      item.badges?.length ? h('div', { class: 'chips-inline' }, item.badges.map((b) => h('span', { class: 'tag' }, b))) : null));
  warm(el, item.id);
  return el;
}

/** Up next (watch page right column). */
export function compactCard(item) {
  if (item.kind !== 'video') return item.kind === 'playlist' ? playlistCard(item, 'compact') : null;
  const el = h('div', { class: 'ccard' },
    thumb(item, { size: 'compact' }),
    h('div', { class: 'ccard-meta' },
      h('a', { class: 'ccard-title', href: href.watch(item.id), title: item.title }, item.title),
      channelName(item.channel),
      stats(item, { long: true })),
    kebab(item));
  warm(el, item.id);
  return el;
}

export function channelRow(c) {
  return h('div', { class: 'chrow' },
    h('a', { class: 'chrow-avatar', href: href.channel(c) }, avatar(c.avatar, 136)),
    h('div', { class: 'chrow-meta' },
      h('a', { class: 'chrow-name', href: href.channel(c) }, c.name, c.verified ? icon('verified', 16) : null),
      h('div', { class: 'muted small' }, [c.handle, c.subscribersText].filter(Boolean).join(' • ')),
      c.snippet ? h('div', { class: 'muted small clamp2' }, c.snippet) : null));
}

export function channelCard(c) {
  return h('a', { class: 'chcard', href: href.channel(c) }, avatar(c.avatar, 120), h('div', { class: 'chcard-name' }, c.name), h('div', { class: 'muted small' }, c.subscribersText || c.handle || ''));
}

export function playlistCard(p, layout = 'grid') {
  return h('div', { class: `plcard plcard-${layout}` },
    h('a', { class: 'thumb plthumb', href: href.playlist(p.id) },
      img(p.thumbnail, 'thumb-img'),
      h('span', { class: 'badge pl' }, icon('playlists', 14), p.countText || 'Playlist')),
    h('div', { class: 'plcard-meta' },
      h('a', { class: 'vcard-title', href: href.playlist(p.id) }, p.title),
      p.channel ? channelName(p.channel) : null,
      h('a', { class: 'muted small link', href: href.playlist(p.id) }, 'View full playlist')));
}

// ---------- ⋮ menu ----------

let openMenu = null;
export function closeMenus() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.kebab')) closeMenus();
}, true);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());
window.addEventListener('scroll', closeMenus, { passive: true });

export function popover(anchor, items) {
  closeMenus();
  const menu = h('div', { class: 'popover', role: 'menu' }, items.filter(Boolean).map((it) =>
    h('button', { class: 'popover-item', type: 'button', role: 'menuitem', onclick: () => { closeMenus(); it.run(); } },
      it.icon ? icon(it.icon) : null, it.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const ht = menu.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const top = r.bottom + ht + 8 > window.innerHeight ? Math.max(8, r.top - ht) : r.bottom;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenu = menu;
  return menu;
}

function kebab(item) {
  const btn = h('button', { class: 'kebab icon-btn', type: 'button', 'aria-label': 'Action menu' }, icon('more'));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openMenu) return closeMenus();
    const signedIn = window.mpegyt?.session?.signedIn;
    popover(btn, [
      signedIn && { icon: 'watchlater', label: 'Save to Watch later', run: () => act('watchlater', item.id, 'Saved to Watch later') },
      { icon: 'share', label: 'Share', run: () => share(item) },
      item.channel?.id && { icon: 'you', label: 'Go to channel', run: () => window.mpegyt.navigate(href.channel(item.channel)) },
    ]);
  });
  return btn;
}

export async function act(type, id, done) {
  try {
    await api.action(type, id);
    if (done) toast(done);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

export async function share(item) {
  const url = `https://www.youtube.com/watch?v=${item.id}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: item.title, url });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard');
    }
  } catch { /* cancelled */ }
}

// ---------- chips ----------

/** Horizontally scrolling chip bar with arrow buttons (YouTube style). */
export function chipBar(chips, active, onPick) {
  const track = h('div', { class: 'chips-track' }, chips.map((c) => {
    const label = typeof c === 'string' ? c : c.label;
    const value = typeof c === 'string' ? c : c.value;
    return h('button', {
      class: `chip${value === active ? ' on' : ''}`, type: 'button', 'aria-pressed': value === active ? 'true' : 'false',
      onclick: (e) => {
        track.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget));
        onPick(value);
      },
    }, label);
  }));
  const left = h('button', { class: 'chips-arrow left icon-btn', type: 'button', 'aria-label': 'Previous', hidden: true, onclick: () => track.scrollBy({ left: -track.clientWidth * 0.7, behavior: 'smooth' }) }, icon('chevronLeft'));
  const right = h('button', { class: 'chips-arrow right icon-btn', type: 'button', 'aria-label': 'Next', hidden: true, onclick: () => track.scrollBy({ left: track.clientWidth * 0.7, behavior: 'smooth' }) }, icon('chevronRight'));
  const update = () => {
    left.hidden = track.scrollLeft < 4;
    right.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  track.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(track);
  return h('div', { class: 'chips' }, left, track, right);
}

// ---------- states ----------

export function skeletonGrid(n = 12) {
  return h('div', { class: 'grid' }, Array.from({ length: n }, () =>
    h('div', { class: 'vcard skeleton' }, h('div', { class: 'thumb' }), h('div', { class: 'vcard-details' }, h('span', { class: 'avatar sk', style: { width: '36px', height: '36px' } }), h('div', { class: 'vcard-meta' }, h('div', { class: 'line' }), h('div', { class: 'line short' }))))));
}

export function skeletonList(n = 8, cls = 'vrow') {
  return h('div', { class: 'list' }, Array.from({ length: n }, () =>
    h('div', { class: `${cls} skeleton` }, h('div', { class: `thumb ${cls === 'vrow' ? 't-row' : 't-compact'}` }), h('div', { class: 'grow' }, h('div', { class: 'line' }), h('div', { class: 'line short' })))));
}

export function errorBox(message, retry) {
  return h('div', { class: 'error-box' },
    h('p', {}, message || 'Something went wrong.'),
    retry ? h('button', { class: 'pill', type: 'button', onclick: retry }, 'Try again') : null);
}

export function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', {}, title), text ? h('p', {}, text) : null, action || null);
}

export function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

/** Infinite scroll: call load() when the sentinel approaches the viewport. */
export function infinite(container, next, render) {
  let token = next;
  let busy = false;
  const sentinel = h('div', { class: 'sentinel' }, h('div', { class: 'spinner small' }));
  if (!token) return () => {};
  container.after(sentinel);
  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting) || busy || !token) return;
    busy = true;
    try {
      const res = await api.more(token);
      render(res.items);
      token = res.next;
    } catch {
      token = null;
    } finally {
      busy = false;
      if (!token) {
        io.disconnect();
        sentinel.remove();
      }
    }
  }, { rootMargin: '1200px' });
  io.observe(sentinel);
  return () => {
    io.disconnect();
    sentinel.remove();
  };
}
