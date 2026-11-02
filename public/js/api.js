// Thin client for the provider-agnostic REST API, with an in-memory cache and
// in-flight de-duplication so back/forward navigation and hover-prefetch are instant.

const cache = new Map(); // url -> { exp, promise }
const DEFAULT_TTL = 5 * 60_000;

function get(url, { ttl = DEFAULT_TTL } = {}) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = fetch(url, { credentials: 'same-origin' }).then(async (r) => {
    if (r.ok) return r.json();
    let msg = r.statusText;
    try {
      msg = (await r.json()).error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  });
  cache.set(url, { exp: Date.now() + ttl, promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

const enc = encodeURIComponent;
const base = (pid) => `/api/p/${enc(pid)}`;

export const api = {
  providers: () => get('/api/providers', { ttl: Infinity }),
  home: (pid) => get(`${base(pid)}/home`),
  search: (pid, q, page = 1) => get(`${base(pid)}/search?q=${enc(q)}&page=${page}`),
  suggest: (pid, q) => get(`${base(pid)}/suggest?q=${enc(q)}`, { ttl: 30 * 60_000 }),
  item: (pid, id) => get(`${base(pid)}/item/${enc(id)}`, { ttl: 30 * 60_000 }),
  related: (pid, id) => get(`${base(pid)}/related/${enc(id)}`, { ttl: 30 * 60_000 }),
  collection: (pid, id) => get(`${base(pid)}/collection/${enc(id)}`),
  /** Drop cached responses (e.g. after signing in or out: feeds differ per account). */
  clear() {
    cache.clear();
  },
  /** Peek at a cached value without fetching (used for instant first paint). */
  peek(url) {
    const hit = cache.get(url);
    return hit && hit.exp > Date.now() ? hit.promise : null;
  },
};

/** Hover-prefetch: warms both the browser cache and the server's resolver cache. */
const prefetched = new Set();
export function prefetchItem(pid, id) {
  const key = `${pid}/${id}`;
  if (prefetched.has(key)) return;
  prefetched.add(key);
  api.item(pid, id).catch(() => prefetched.delete(key));
}
