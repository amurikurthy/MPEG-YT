import { api, resetPrefetchBudget } from './api.js';
import { h, icon, avatar, popover, closeMenus, errorBox, toast, href } from './ui.js';
import { prefs } from './state.js';
import { openSignIn } from './account.js';
import * as home from './views/home.js';
import * as results from './views/results.js';
import * as watch from './views/watch.js';
import * as channel from './views/channel.js';
import * as library from './views/library.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');

/** Shared app state (also used by components via window.mpegyt). */
const app = (window.mpegyt = {
  session: { signedIn: false, subscriptions: [], methods: [], stream: { bufferAhead: 10 } },
  navigate,
  refreshSession,
  signIn: () => openSignIn(onAccountChange),
});

// ---------- routing (History API: same URLs as youtube.com) ----------

let cleanup = null;
let seq = 0;
const scroll = new Map();

function navigate(url, { replace = false } = {}) {
  closeMenus();
  scroll.set(location.pathname + location.search, window.scrollY);
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  route();
}

window.addEventListener('popstate', () => route(true));

// Intercept same-origin links so navigation never reloads the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});

function match() {
  const p = location.pathname;
  const params = new URLSearchParams(location.search);
  if (p === '/' || p === '/index.html') return ['home', () => home.render(ctx(params))];
  if (p === '/results') return ['results', () => results.render(ctx(params))];
  if (p === '/watch' && params.get('v')) return ['watch', () => watch.render(ctx(params))];
  let m;
  if ((m = /^\/channel\/(UC[\w-]{22})\/?/.exec(p))) return ['channel', () => channel.render({ ...ctx(params), id: m[1] })];
  if ((m = /^\/(@[^/]+)\/?/.exec(p))) return ['channel', () => channel.render({ ...ctx(params), id: decodeURIComponent(m[1]) })];
  if ((m = /^\/feed\/(subscriptions|history|you|playlists)\/?$/.exec(p))) return [m[1], () => library.render({ ...ctx(params), page: m[1] })];
  if (p === '/playlist' && params.get('list')) return ['playlist', () => library.render({ ...ctx(params), page: 'playlist', list: params.get('list') })];
  return ['404', () => view.replaceChildren(errorBox('This page isn’t available.'))];
}

function ctx(params) {
  const mySeq = seq;
  return { view, params, app, isCurrent: () => mySeq === seq };
}

async function route(isPop = false) {
  seq++;
  const mySeq = seq;
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
    cleanup = null;
  }
  closeMenus();
  closeDrawer();
  const [page, render] = match();
  resetPrefetchBudget();
  document.body.dataset.page = page;
  renderGuide();
  syncSearchBox();
  view.replaceChildren();
  document.title = 'MPEG-YT';
  const result = await render();
  if (mySeq !== seq) {
    if (typeof result === 'function') result();
    return;
  }
  cleanup = typeof result === 'function' ? result : null;
  const key = location.pathname + location.search;
  window.scrollTo(0, isPop && page !== 'watch' ? scroll.get(key) || 0 : 0);
}

// ---------- guide (left navigation) ----------

const guide = $('#guide');
const miniGuide = $('#mini-guide');
const scrim = $('#scrim');

function guideMode() {
  const page = document.body.dataset.page;
  const w = window.innerWidth;
  if (page === 'watch' || w < 792) return 'drawer'; // hidden until the menu button opens it
  if (w >= 1312 && prefs.get('guideExpanded', true)) return 'full';
  return 'mini';
}

function applyGuideMode() {
  const mode = guideMode();
  document.body.dataset.guide = mode;
}
window.addEventListener('resize', applyGuideMode);

$('#guide-btn').addEventListener('click', () => {
  const mode = guideMode();
  if (mode === 'drawer' || (mode === 'mini' && window.innerWidth < 1312)) {
    document.body.classList.toggle('drawer-open');
    scrim.hidden = !document.body.classList.contains('drawer-open');
  } else {
    prefs.set('guideExpanded', mode !== 'full');
    applyGuideMode();
  }
});
scrim.addEventListener('click', closeDrawer);
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  scrim.hidden = true;
}

function guideLink(path, label, iconName, opts = {}) {
  const active = location.pathname === path || (opts.match && opts.match());
  return h('a', { class: `guide-item${active ? ' on' : ''}`, href: path, title: label },
    opts.img ? avatar(opts.img, 24) : icon(iconName), h('span', {}, label));
}

function renderGuide() {
  applyGuideMode();
  const s = app.session;
  const sections = [
    h('div', { class: 'guide-section' },
      guideLink('/', 'Home', 'home'),
      guideLink('/feed/subscriptions', 'Subscriptions', 'subscriptions')),
    h('div', { class: 'guide-section' },
      h('a', { class: 'guide-heading', href: '/feed/you' }, 'You', icon('chevronRight', 20)),
      guideLink('/feed/history', 'History', 'history'),
      s.signedIn ? guideLink('/feed/playlists', 'Playlists', 'playlists') : null,
      s.signedIn ? guideLink('/playlist?list=WL', 'Watch later', 'watchlater', { match: () => location.search.includes('list=WL') }) : null,
      s.signedIn ? guideLink('/playlist?list=LL', 'Liked videos', 'liked', { match: () => location.search.includes('list=LL') }) : null),
  ];
  if (s.signedIn && s.subscriptions?.length) {
    sections.push(h('div', { class: 'guide-section' },
      h('div', { class: 'guide-heading' }, 'Subscriptions'),
      s.subscriptions.map((c) => guideLink(`/channel/${c.id}`, c.name, null, { img: c.avatar }))));
  } else if (!s.signedIn) {
    sections.push(h('div', { class: 'guide-section guide-signin' },
      h('p', {}, 'Sign in to like videos, comment, and subscribe.'),
      signInButton()));
  }
  sections.push(h('div', { class: 'guide-footer' },
    h('button', { class: 'guide-item', type: 'button', onclick: toggleTheme }, icon('appearance'), h('span', {}, `Appearance: ${prefs.get('theme', 'dark') === 'light' ? 'Light' : 'Dark'}`)),
    h('p', { class: 'guide-fine' }, 'MPEG-YT · video streamed as MPEG-1 to a WebGL canvas')));
  guide.replaceChildren(...sections);

  miniGuide.replaceChildren(
    miniItem('/', 'Home', 'home'),
    miniItem('/feed/subscriptions', 'Subscriptions', 'subscriptions'),
    miniItem('/feed/you', 'You', 'you'),
    miniItem('/feed/history', 'History', 'history'));
}

function miniItem(path, label, iconName) {
  return h('a', { class: `mini-item${location.pathname === path ? ' on' : ''}`, href: path }, icon(iconName), h('span', {}, label));
}

// ---------- masthead: search ----------

const form = $('#search');
const input = $('#q');
const clearBtn = $('#q-clear');
const suggestEl = $('#suggest');
let suggestions = [];
let selected = -1;
let suggestTimer;
let suggestSeq = 0;

function syncSearchBox() {
  const q = location.pathname === '/results' ? new URLSearchParams(location.search).get('search_query') || '' : '';
  if (document.activeElement !== input) input.value = q;
  clearBtn.hidden = !input.value;
  document.body.classList.remove('mobile-search');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  hideSuggest();
  input.blur();
  navigate(href.results(q));
});
clearBtn.addEventListener('click', () => {
  input.value = '';
  clearBtn.hidden = true;
  hideSuggest();
  input.focus();
});
input.addEventListener('input', () => {
  clearBtn.hidden = !input.value;
  clearTimeout(suggestTimer);
  const q = input.value.trim();
  if (!q) return hideSuggest();
  suggestTimer = setTimeout(async () => {
    const mySeq = ++suggestSeq;
    const list = await api.suggest(q).catch(() => []);
    if (mySeq === suggestSeq && input.value.trim() === q) showSuggest(list);
  }, 80);
});
input.addEventListener('keydown', (e) => {
  if (suggestEl.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestions.length;
    selected = e.key === 'ArrowDown' ? (selected + 1) % n : (selected - 1 + n) % n;
    [...suggestEl.children].forEach((li, i) => li.classList.toggle('sel', i === selected));
    input.value = suggestions[selected];
  } else if (e.key === 'Escape') hideSuggest();
});
input.addEventListener('focus', () => input.value.trim() && suggestions.length && (suggestEl.hidden = false));
input.addEventListener('blur', () => setTimeout(hideSuggest, 150));

function showSuggest(list) {
  suggestions = list;
  selected = -1;
  if (!list.length) return hideSuggest();
  suggestEl.replaceChildren(...list.map((s) => h('li', {
    role: 'option',
    onpointerdown: (e) => {
      e.preventDefault();
      input.value = s;
      form.requestSubmit();
    },
  }, icon('search', 20), h('span', {}, s))));
  suggestEl.hidden = false;
}
function hideSuggest() {
  suggestEl.hidden = true;
}

// "/" focuses search, like on YouTube.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// Small screens: the search box opens over the masthead.
$('#search-open').addEventListener('click', () => {
  document.body.classList.add('mobile-search');
  input.focus();
});
$('#search-back').addEventListener('click', () => document.body.classList.remove('mobile-search'));

// Voice search where the browser supports it (Chrome, Edge, Safari).
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceBtn = $('#voice');
if (Recognition) {
  voiceBtn.hidden = false;
  voiceBtn.addEventListener('click', () => {
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    voiceBtn.classList.add('listening');
    toast('Listening…');
    rec.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join('');
      input.value = text;
      if (e.results[e.results.length - 1].isFinal) form.requestSubmit();
    };
    rec.onend = () => voiceBtn.classList.remove('listening');
    rec.onerror = () => toast('Didn’t catch that. Try again.');
    rec.start();
  });
}

// ---------- masthead: account ----------

const accountSlot = $('#account-slot');

function signInButton() {
  return h('button', { class: 'signin-btn', type: 'button', onclick: () => app.signIn() }, icon('you'), 'Sign in');
}

function renderAccount() {
  const s = app.session;
  if (!s.signedIn) {
    const settings = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings' }, icon('more'));
    settings.addEventListener('click', () => popover(settings, [
      { icon: 'appearance', label: `Appearance: ${prefs.get('theme', 'dark') === 'light' ? 'Light' : 'Dark'}`, run: toggleTheme },
    ]));
    accountSlot.replaceChildren(settings, signInButton());
    return;
  }
  const me = s.me || {};
  const btn = h('button', { class: 'me-btn', type: 'button', 'aria-label': 'Account menu' }, avatar(me.avatar, 32));
  btn.addEventListener('click', () => {
    const menu = popover(btn, [
      { icon: 'you', label: 'Your history & playlists', run: () => navigate('/feed/you') },
      { icon: 'appearance', label: `Appearance: ${prefs.get('theme', 'dark') === 'light' ? 'Light' : 'Dark'}`, run: toggleTheme },
      {
        icon: 'logout',
        label: 'Sign out',
        run: async () => {
          await api.account.logout().catch((e) => toast(e.message));
          onAccountChange();
          toast('Signed out');
        },
      },
    ]);
    menu.classList.add('account-menu');
    menu.prepend(h('div', { class: 'account-head' }, avatar(me.avatar, 40), h('div', {}, h('strong', {}, me.name || 'Your account'), me.handle ? h('div', { class: 'muted small' }, me.handle) : null)));
  });
  accountSlot.replaceChildren(btn);
}

async function refreshSession() {
  try {
    app.session = { ...app.session, ...(await api.session()) };
  } catch { /* keep previous */ }
  renderAccount();
  renderGuide();
}

async function onAccountChange() {
  api.clear(); // feeds and recommendations differ per account
  await refreshSession();
  route();
}

// ---------- theme ----------

function toggleTheme() {
  const next = prefs.get('theme', 'dark') === 'light' ? 'dark' : 'light';
  prefs.set('theme', next);
  applyTheme();
  renderGuide();
}
function applyTheme() {
  const light = prefs.get('theme', 'dark') === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name=color-scheme]').content = light ? 'light' : 'dark';
  document.querySelector('meta[name=theme-color]').content = light ? '#ffffff' : '#0f0f0f';
}

// ---------- boot ----------

applyTheme();
renderAccount();
renderGuide();
route();
refreshSession();
