'use strict';

/**
 * Turns youtubei.js parser nodes (YouTube's own InnerTube data) into small, flat
 * JSON objects for the UI. YouTube serves the same video in several shapes
 * (Video, CompactVideo, GridVideo, the newer LockupView, ...), so each is mapped
 * onto one of:
 *
 *   { kind: 'video', id, title, thumbnail, duration, durationText, live, upcoming,
 *     channel: { id, name, avatar, verified }, viewsText, views, publishedText, age,
 *     badges[], snippet, progress }
 *   { kind: 'channel', id, name, avatar, handle, subscribersText, snippet, verified }
 *   { kind: 'playlist', id, title, thumbnail, countText, channel }
 */

const txt = (t) => {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return String(t);
  const s = typeof t.toString === 'function' ? t.toString() : '';
  return s && s !== '[object Object]' ? s : t.text || '';
};
const N_A = 'N/A';
const clean = (s) => (s && s !== N_A ? s.trim() : '');

const fixUrl = (u) => (u && u.startsWith('//') ? `https:${u}` : u || '');

/** Pick the smallest image at least `min` px wide (or the largest available). */
function pickImage(list, min = 360) {
  const arr = (Array.isArray(list) ? list : []).filter((i) => i && i.url);
  if (!arr.length) return '';
  const sorted = [...arr].sort((a, b) => (a.width || 0) - (b.width || 0));
  return fixUrl((sorted.find((i) => (i.width || 0) >= min) || sorted[sorted.length - 1]).url);
}

/** "1.4M views" | "5.3M" | "23,498,855 views" | "No views" -> number */
function parseCount(s) {
  if (!s) return undefined;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(s).replace(/ /g, ' '));
  if (!m) return /no views/i.test(s) ? 0 : undefined;
  let n = parseFloat(m[2] ? m[1].replace(',', '.') : m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  const mul = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  n *= mul;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** "4d ago" | "13 days ago" | "Streamed 2 years ago" | "1 month ago" -> seconds */
function parseAge(s) {
  if (!s) return undefined;
  const m = /(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|wk|week|mo|month|y|yr|year)s?\b/i.exec(s);
  if (!m) return /just now|live now|streaming/i.test(s) ? 0 : undefined;
  const unit = m[2].toLowerCase();
  const sec = unit.startsWith('mo') ? 2592000
    : unit.startsWith('s') ? 1
      : unit === 'm' || unit.startsWith('min') ? 60
        : unit.startsWith('h') ? 3600
          : unit.startsWith('d') ? 86400
            : unit.startsWith('w') ? 604800
              : 31536000;
  return Number(m[1]) * sec;
}

/** "8:37" | "1:02:03" -> seconds */
function parseDuration(s) {
  if (!s || !/^\d+(:\d\d){1,2}$/.test(s.trim())) return undefined;
  return s.trim().split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Compact view text the way YouTube's grid shows it: "1.4M". */
function shortViews(text) {
  const t = clean(text).replace(/\s*views?$/i, '').replace(/\s*watching$/i, '');
  return t;
}

function author(a) {
  if (!a) return undefined;
  return {
    id: a.id && a.id !== N_A ? a.id : undefined,
    name: clean(a.name),
    avatar: pickImage(a.thumbnails, 68),
    verified: !!(a.is_verified || a.is_verified_artist),
  };
}

function progressFromOverlays(overlays) {
  for (const o of overlays || []) {
    if (o?.type === 'ThumbnailOverlayResumePlayback' && Number.isFinite(o.percent_duration_watched)) return o.percent_duration_watched / 100;
    const pb = o?.progress_bar;
    if (pb && Number.isFinite(pb.start_percent)) return pb.start_percent / 100;
  }
  return undefined;
}

function fromVideo(v) {
  const id = v.video_id || v.id;
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const badgeLabels = (v.badges || []).map((b) => clean(b.label || b.text || txt(b))).filter(Boolean);
  const live = !!v.is_live || badgeLabels.some((b) => /^live$/i.test(b));
  const durationText = clean(txt(v.length_text) || txt(v.duration?.text) || v.duration?.text);
  const viewsRaw = clean(txt(v.short_view_count)) || clean(txt(v.view_count));
  const publishedText = clean(txt(v.published));
  return {
    kind: 'video',
    id,
    title: clean(txt(v.title)),
    thumbnail: pickImage(v.thumbnails || v.thumbnail, 480) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    durationText: live ? '' : durationText,
    duration: parseDuration(durationText),
    live,
    upcoming: !!v.upcoming,
    channel: author(v.author),
    viewsText: shortViews(viewsRaw),
    views: parseCount(clean(txt(v.view_count)) || viewsRaw),
    publishedText,
    age: parseAge(publishedText),
    badges: badgeLabels.filter((b) => !/^live$/i.test(b)),
    snippet: clean(txt(v.description_snippet)) || clean(txt(v.snippets?.[0]?.text)),
    progress: progressFromOverlays(v.thumbnail_overlays),
  };
}

/** The 2025+ "lockup" layout used by home, related videos, channel tabs and playlists. */
function fromLockup(l) {
  const kind = l.content_type;
  const md = l.metadata || {};
  const rows = md.metadata?.metadata_rows || [];
  const parts = rows.map((r) => (r.metadata_parts || []).map((p) => clean(txt(p.text))).filter(Boolean));
  const overlays = l.content_image?.overlays || l.content_image?.primary_thumbnail?.overlays || [];
  const badgeTexts = [];
  for (const o of overlays) for (const b of o?.badges || []) badgeTexts.push(clean(b.text));
  const avatarView = md.image?.avatar || md.image;
  const channelId = md.image?.renderer_context?.command_context?.on_tap?.payload?.browseId
    || l.renderer_context?.command_context?.on_tap?.payload?.browseId_channel;
  // Classify parts by content, not position: home/related use [channel] + [views, age],
  // channel tabs only [views, age], playlists [channel, "N videos"].
  const isViews = (t) => /\b(views?|watching)\b/i.test(t) || /^[\d.,]+\s*[KMB]?$/i.test(t);
  const isAge = (t) => /\b(ago|streamed|premiere[sd]?|scheduled|updated)\b/i.test(t);
  const flat = parts.flat();
  const channelName = (parts[0] || []).find((t) => !isViews(t) && !isAge(t)) || '';
  const verified = (rows[0]?.badges || []).some((b) => /CHECK|VERIFIED/i.test(b?.icon_name || b?.type || ''));
  const image = l.content_image?.image || l.content_image?.primary_thumbnail?.image;

  if (kind === 'VIDEO') {
    const id = l.content_id;
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    const durationText = badgeTexts.find((t) => /^\d+(:\d\d){1,2}$/.test(t)) || '';
    const live = badgeTexts.some((t) => /^live$/i.test(t));
    const viewsText = flat.find((t) => t !== channelName && isViews(t)) || '';
    const publishedText = flat.find(isAge) || '';
    return {
      kind: 'video',
      id,
      title: clean(txt(md.title)),
      thumbnail: pickImage(image, 480) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durationText: live ? '' : durationText,
      duration: parseDuration(durationText),
      live,
      channel: channelName ? { id: channelId, name: channelName, avatar: pickImage(avatarView?.image, 68), verified } : undefined,
      viewsText: shortViews(viewsText),
      views: parseCount(viewsText),
      publishedText,
      age: parseAge(publishedText),
      badges: badgeTexts.filter((t) => t && !/^\d+(:\d\d){1,2}$/.test(t) && !/^live$/i.test(t)),
      progress: progressFromOverlays(overlays),
    };
  }
  if (kind === 'PLAYLIST' || kind === 'ALBUM' || kind === 'PODCAST') {
    const id = l.content_id;
    if (!id || /^RD/.test(id)) return null; // auto-generated mixes can't be listed reliably
    return {
      kind: 'playlist',
      id,
      title: clean(txt(md.title)),
      thumbnail: pickImage(image, 480),
      countText: badgeTexts.find((t) => /video|episode|lesson/i.test(t)) || badgeTexts[0] || '',
      channel: channelName ? { id: channelId, name: channelName } : undefined,
    };
  }
  return null;
}

function fromChannel(c) {
  const a = c.author || {};
  // YouTube's search channel card puts the @handle in subscriber_count and subs in video_count.
  const s1 = clean(txt(c.subscriber_count));
  const s2 = clean(txt(c.video_count));
  const handle = [s1, s2].find((s) => s.startsWith('@')) || '';
  const subs = [s1, s2].find((s) => /subscriber/i.test(s)) || '';
  return {
    kind: 'channel',
    id: a.id || c.id,
    name: clean(a.name),
    avatar: pickImage(a.thumbnails, 136),
    handle,
    subscribersText: subs,
    snippet: clean(txt(c.description_snippet)),
    verified: !!a.is_verified,
  };
}

function fromPlaylist(p) {
  const id = p.id || p.playlist_id;
  if (!id || /^RD/.test(id)) return null;
  return {
    kind: 'playlist',
    id,
    title: clean(txt(p.title)),
    thumbnail: pickImage(p.thumbnails || p.first_videos?.[0]?.thumbnails, 480),
    countText: clean(txt(p.video_count)) || clean(txt(p.video_count_short)),
    channel: author(p.author),
  };
}

const SHORTS_TYPES = /^(ReelItem|ShortsLockupView|ReelShelf|ShortsShelf|ReelShelfRenderer)$/;

function endpointOf(n) {
  return n.endpoint || n.on_tap_endpoint || n.navigation_endpoint || n.renderer_context?.command_context?.on_tap || null;
}

/**
 * Is this a Short (or a shelf of Shorts)? YouTube marks them in several ways depending
 * on the feed - dedicated node types, a "SHORT" lockup, a reel endpoint, a /shorts/ URL
 * or a Shorts thumbnail overlay - and history in particular serves them as ordinary
 * video items, so check every signal.
 */
function isShort(n) {
  if (!n || typeof n !== 'object') return false;
  if (SHORTS_TYPES.test(n.type || '')) return true;
  if (n.type === 'RichItem') return isShort(n.content);
  if (n.type === 'LockupView' && n.content_type === 'SHORT') return true;
  const e = endpointOf(n);
  if (e && (e.name === 'reelWatchEndpoint' || /^\/shorts\//.test(e.metadata?.url || '') || e.metadata?.page_type === 'WEB_PAGE_TYPE_SHORTS')) return true;
  const overlays = [...(n.thumbnail_overlays || []), ...(n.content_image?.overlays || [])];
  for (const o of overlays) {
    if (/SHORTS/i.test(o?.style || '')) return true;
    if ((o?.badges || []).some((b) => /SHORTS/i.test(b?.badge_style || ''))) return true;
  }
  return false;
}

/** Map any supported node; unknown or unsupported (Shorts) -> null. */
function item(node) {
  if (!node || isShort(node)) return null;
  switch (node.type) {
    case 'RichItem':
      return item(node.content);
    case 'LockupView':
      return fromLockup(node);
    case 'Video':
    case 'CompactVideo':
    case 'GridVideo':
    case 'PlaylistVideo':
    case 'PlaylistPanelVideo':
      return fromVideo(node);
    case 'Channel':
    case 'GridChannel':
      return fromChannel(node);
    case 'Playlist':
    case 'GridPlaylist':
    case 'CompactPlaylist':
      return fromPlaylist(node);
    default:
      return null;
  }
}

/** Map a list, dropping unsupported nodes and duplicates. */
function items(nodes, seen = new Set()) {
  const out = [];
  for (const n of nodes || []) {
    const it = item(n);
    if (!it) continue;
    const key = `${it.kind}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

const ITEM_TYPES = new Set([
  'RichItem', 'LockupView', 'Video', 'CompactVideo', 'GridVideo', 'PlaylistVideo', 'PlaylistPanelVideo',
  'Channel', 'GridChannel', 'Playlist', 'GridPlaylist', 'CompactPlaylist',
]);
// Branches that never contain feed items but can be large.
const SKIP_KEYS = new Set([
  'endpoint', 'on_tap', 'on_tap_endpoint', 'navigation_endpoint', 'renderer_context', 'menu', 'payload',
  'command', 'commands', 'accessibility', 'thumbnails', 'thumbnail', 'contents_memo', 'header', 'sidebar',
]);

/**
 * All feed items in document order. (youtubei.js's feed.videos groups items by node
 * type, which reorders mixed feeds - e.g. history, where Shorts are a different type
 * and ended up at the top.) Shorts and Shorts shelves are skipped entirely.
 */
function ordered(root) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 30 || seen.has(v)) return;
    seen.add(v);
    // youtubei.js wraps parsed sections (SuperParsedResult) behind item()/array().
    if (typeof v.item === 'function' && 'is_array' in v) {
      let inner = null;
      try {
        inner = v.is_array ? v.array() : v.is_null ? null : v.item();
      } catch { /* empty section */ }
      walk(inner, depth + 1);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v.type && isShort(v)) return;
    if (v.type && ITEM_TYPES.has(v.type)) {
      out.push(v);
      return;
    }
    for (const k of Object.keys(v)) if (!SKIP_KEYS.has(k)) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return out;
}

module.exports = { item, items, ordered, isShort, txt, clean, pickImage, parseCount, parseAge, parseDuration, shortViews, author, fixUrl };
