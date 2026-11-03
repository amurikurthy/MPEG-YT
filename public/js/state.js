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

/**
 * Resume positions (and a local watch history for when you're signed out),
 * newest first, capped.
 */
const WATCHED = 'mpegyt.watched';
export const history = {
  list() {
    return read(WATCHED, []);
  },
  /** -> { pos, duration } or undefined */
  get(id) {
    return read(WATCHED, []).find((h) => h.id === id);
  },
  save(item, pos, duration) {
    if (!item || !item.id) return;
    const all = read(WATCHED, []).filter((h) => h.id !== item.id);
    all.unshift({
      id: item.id,
      pos,
      duration: duration || item.duration,
      at: Date.now(),
      item: {
        kind: 'video', id: item.id, title: item.title, thumbnail: item.thumbnail,
        channel: item.channel ? { id: item.channel.id, name: item.channel.name, avatar: item.channel.avatar, verified: item.channel.verified } : undefined,
        durationText: item.durationText, viewsText: item.shortViewsText?.replace(/ views?$/, '') || item.viewsText, publishedText: item.relativeDate || item.publishedText,
      },
    });
    write(WATCHED, all.slice(0, 200));
  },
  clear() {
    write(WATCHED, []);
  },
};
