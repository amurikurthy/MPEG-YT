'use strict';

/**
 * Small TTL cache with in-flight de-duplication: concurrent callers asking for
 * the same key share one pending promise (important for hover-prefetch).
 */
class TTLCache {
  constructor({ ttlMs = 5 * 60_000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
  }

  /** Return cached value or compute it once (errors are not cached). */
  wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve()
      .then(fn)
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { TTLCache };
