// Client for the MPEG-YT API, with an in-memory cache and in-flight de-duplication
// so back/forward navigation and hover-prefetch are instant.

const cache = new Map(); // url -> { exp, promise }
const DEFAULT_TTL = 5 * 60_000;

async function request(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  let data = null;
  try {
    data = await r.json();
  } catch { /* empty */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || r.statusText);
    err.status = r.status;
    throw err;
  }
  return data;
}

function get(url, { ttl = DEFAULT_TTL } = {}) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = request(url);
  cache.set(url, { exp: Date.now() + ttl, promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

function post(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'X-MPEG-YT': '1', 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
  });
}

const enc = encodeURIComponent;
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${enc(v)}`).join('&');

export const api = {
  session: () => request('/api/session'),
  home: (chip) => get(`/api/home?${qs({ chip })}`),
  search: (q, f = {}) => get(`/api/search?${qs({ q, ...f })}`),
  suggest: (q) => get(`/api/suggest?q=${enc(q)}`, { ttl: 30 * 60_000 }),
  video: (id) => get(`/api/video/${enc(id)}`, { ttl: 10 * 60_000 }),
  comments: (id, sort) => get(`/api/comments/${enc(id)}?${qs({ sort })}`, { ttl: 60_000 }),
  channel: (id, sort) => get(`/api/channel/${enc(id)}?${qs({ sort })}`),
  feed: (name) => get(`/api/feed/${enc(name)}`, { ttl: 60_000 }),
  playlist: (id) => get(`/api/playlist/${enc(id)}`, { ttl: 60_000 }),
  more: (token) => request(`/api/more/${enc(token)}`),
  action: (type, id) => post('/api/action', { type, id }).then((r) => {
    // Lists that the action changes.
    for (const k of [...cache.keys()]) if (/\/api\/(feed|playlist|video)/.test(k)) cache.delete(k);
    return r;
  }),
  account: {
    status: () => request('/api/account'),
    login: () => post('/api/account/login'),
    finish: () => post('/api/account/login/finish'),
    cancel: () => post('/api/account/login/cancel'),
    cookies: (text) => post('/api/account/cookies', text),
    logout: () => post('/api/account/logout'),
  },
  /** Drop cached responses (e.g. after signing in or out: feeds differ per account). */
  clear() {
    cache.clear();
  },
};

/**
 * Prefetch a video: its details (instant watch page) and, on the server, stream
 * resolution plus the first ~1 MB of video/audio (playback starts from local data).
 */
const prefetched = new Set();
export function prefetch(id) {
  if (!id || prefetched.has(id)) return;
  prefetched.add(id);
  api.video(id).catch(() => prefetched.delete(id));
  fetch(`/api/prefetch/${enc(id)}`, { credentials: 'same-origin' }).catch(() => {});
}

/**
 * Touch screens have no hover: prefetch a few cards that stay on screen for a
 * moment. Budgeted per page so scrolling a long feed doesn't hammer YouTube.
 */
const VISIBLE_BUDGET = 4;
let budget = VISIBLE_BUDGET;
const timers = new WeakMap();
const io = typeof IntersectionObserver !== 'undefined' && matchMedia('(pointer: coarse)').matches
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        timers.set(e.target, setTimeout(() => {
          io.unobserve(e.target);
          if (budget > 0 && !prefetched.has(e.target.dataset.prefetch)) {
            budget -= 1;
            prefetch(e.target.dataset.prefetch);
          }
        }, 1000));
      } else clearTimeout(timers.get(e.target));
    }
  }, { threshold: [0, 0.6] })
  : null;

export function prefetchWhenVisible(el, id) {
  if (!io) return;
  el.dataset.prefetch = id;
  io.observe(el);
}

/** New page: fresh budget. */
export function resetPrefetchBudget() {
  budget = VISIBLE_BUDGET;
}
