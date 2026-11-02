// Per-viewer conveniences kept in localStorage (always optional: storage may be blocked).

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

const PREFS = 'mpegyt.prefs';
const HISTORY = 'mpegyt.history';

export const prefs = {
  get(k, d) {
    const p = read(PREFS, {});
    return k in p ? p[k] : d;
  },
  set(k, v) {
    const p = read(PREFS, {});
    p[k] = v;
    write(PREFS, p);
  },
};

/** "Continue watching": last position per item, newest first, capped. */
export const history = {
  list(pid) {
    return read(HISTORY, []).filter((h) => h.pid === pid);
  },
  get(pid, id) {
    return read(HISTORY, []).find((h) => h.pid === pid && h.item.id === id);
  },
  save(pid, item, pos, duration) {
    if (!item || !item.id) return;
    const all = read(HISTORY, []).filter((h) => !(h.pid === pid && h.item.id === item.id));
    const slim = {
      kind: 'video', id: item.id, title: item.title, subtitle: item.subtitle,
      subtitleRef: item.subtitleRef, thumbnail: item.thumbnail, duration: duration || item.duration,
    };
    all.unshift({ pid, item: slim, pos, at: Date.now() });
    write(HISTORY, all.slice(0, 60));
  },
};
