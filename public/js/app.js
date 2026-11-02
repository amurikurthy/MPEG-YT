import { api } from './api.js';
import { h, href, errorBox, icon } from './ui.js';
import { prefs } from './state.js';
import { openAccount } from './account.js';
import * as home from './views/home.js';
import * as search from './views/search.js';
import * as watch from './views/watch.js';
import * as collection from './views/collection.js';

const view = document.getElementById('view');
const providerNav = document.getElementById('providers');
const form = document.getElementById('search');
const input = document.getElementById('q');
const suggestEl = document.getElementById('suggest');

const ctx = { providers: [], stream: null, pid: null };
let cleanup = null;
let renderSeq = 0;
const scrollPos = new Map();

// ---------- routing ----------
// #/<pid>                     provider home
// #/<pid>/search?q=...        search results
// #/<pid>/watch/<id>?t=..     watch page
// #/<pid>/c/<id>              collection (channel / playlist / folder)

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, params: new URLSearchParams(query) };
}

async function route() {
  const seq = ++renderSeq;
  const { parts, params } = parseHash();
  const known = (id) => ctx.providers.some((p) => p.id === id);

  let pid = parts[0];
  if (!pid || !known(pid)) {
    const fallback = known(prefs.get('provider')) ? prefs.get('provider') : ctx.providers[0]?.id;
    if (!fallback) return renderFatal('No sources are enabled on the server.');
    location.replace(href.home(fallback));
    return;
  }
  ctx.pid = pid;
  prefs.set('provider', pid);
  renderProviderNav();
  renderAccountButton();

  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
    cleanup = null;
  }

  const action = parts[1];
  const provider = ctx.providers.find((p) => p.id === pid);
  input.placeholder = provider.capabilities.search ? `Search ${provider.name}` : 'Search unavailable';
  input.disabled = !provider.capabilities.search;
  if (action !== 'search') input.value = '';

  const args = { ctx, provider, pid, params, view, isCurrent: () => seq === renderSeq };
  view.replaceChildren();
  document.body.dataset.view = action || 'home';

  let fn;
  if (!action) fn = () => home.render(args);
  else if (action === 'search') {
    input.value = params.get('q') || '';
    fn = () => search.render({ ...args, query: params.get('q') || '' });
  } else if (action === 'watch' && parts[2]) fn = () => watch.render({ ...args, id: parts.slice(2).join('/') });
  else if (action === 'c' && parts[2]) fn = () => collection.render({ ...args, id: parts.slice(2).join('/') });
  else fn = () => view.replaceChildren(errorBox('Page not found.'));

  const result = await fn();
  if (seq !== renderSeq) {
    if (typeof result === 'function') result();
    return;
  }
  cleanup = typeof result === 'function' ? result : null;

  // Restore scroll for back/forward, otherwise go to top.
  const y = scrollPos.get(location.hash);
  window.scrollTo(0, action === 'watch' ? 0 : y || 0);
}

window.addEventListener('hashchange', () => {
  hideSuggest();
  route();
});
// Remember scroll position of the page we're leaving.
let lastHash = location.hash;
window.addEventListener('scroll', () => { scrollPos.set(lastHash, window.scrollY); }, { passive: true });
window.addEventListener('hashchange', () => { lastHash = location.hash; });

// ---------- account ----------

const accountBtn = document.getElementById('account');
function renderAccountButton() {
  const p = ctx.providers.find((x) => x.id === ctx.pid);
  accountBtn.hidden = !p?.account;
  if (!p?.account) return;
  accountBtn.classList.toggle('signed-in', !!p.account.signedIn);
  accountBtn.replaceChildren(icon('account', 22));
  accountBtn.setAttribute('aria-label', p.account.signedIn ? `Signed in to ${p.name}` : `Sign in to ${p.name}`);
}
function showAccount() {
  const p = ctx.providers.find((x) => x.id === ctx.pid);
  if (!p?.account) return;
  openAccount(p, (acct) => {
    p.account = { ...p.account, ...acct };
    api.clear(); // feeds and results differ per account
    renderAccountButton();
    route();
  });
}
accountBtn.addEventListener('click', showAccount);
window.addEventListener('mpegyt:account', showAccount);

function renderProviderNav() {
  if (ctx.providers.length < 2) {
    providerNav.hidden = true;
    return;
  }
  providerNav.hidden = false;
  providerNav.replaceChildren(...ctx.providers.map((p) =>
    h('a', { href: href.home(p.id), class: p.id === ctx.pid ? 'on' : '', 'aria-current': p.id === ctx.pid ? 'page' : null }, p.name)));
}

function renderFatal(msg) {
  view.replaceChildren(errorBox(msg, () => location.reload()));
}

// ---------- search + suggestions ----------

let suggestions = [];
let selected = -1;
let suggestTimer;
let suggestSeq = 0;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || !ctx.pid) return;
  hideSuggest();
  input.blur();
  location.hash = href.search(ctx.pid, q);
});

input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = input.value.trim();
  const provider = ctx.providers.find((p) => p.id === ctx.pid);
  if (!q || !provider?.capabilities.suggest) return hideSuggest();
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    const list = await api.suggest(ctx.pid, q).catch(() => []);
    if (seq !== suggestSeq || input.value.trim() !== q) return;
    showSuggest(list);
  }, 90);
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
  }, s)));
  suggestEl.hidden = false;
}
function hideSuggest() {
  suggestEl.hidden = true;
  suggestions = [];
}

// "/" focuses search (like most media sites); ignored while typing.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// ---------- theme (dark default) ----------

const themeBtn = document.getElementById('theme');
function applyTheme(t) {
  const light = t === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name=color-scheme]').content = light ? 'light' : 'dark';
  document.querySelector('meta[name=theme-color]').content = light ? '#f7f8fa' : '#0e0f13';
  themeBtn.replaceChildren(icon(light ? 'moon' : 'sun', 20));
  themeBtn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
}
applyTheme(prefs.get('theme', 'dark'));
themeBtn.addEventListener('click', () => {
  const next = prefs.get('theme', 'dark') === 'light' ? 'dark' : 'light';
  prefs.set('theme', next);
  applyTheme(next);
});

// ---------- boot ----------

(async function boot() {
  try {
    const data = await api.providers();
    ctx.providers = data.providers;
    ctx.stream = data.stream;
  } catch (e) {
    return renderFatal(`Cannot reach the server: ${e.message}`);
  }
  route();
})();
