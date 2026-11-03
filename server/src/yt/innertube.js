'use strict';
const crypto = require('crypto');
const { TTLCache } = require('../util/cache');
const N = require('./normalize');
const { HttpError } = require('./account');

let libPromise = null;
const lib = () => (libPromise ||= import('youtubei.js').then((m) => {
  try {
    m.Log?.setLevel?.(m.Log.Level.ERROR);
  } catch { /* older versions */ }
  return m;
}));

/**
 * Signed-out YouTube shows an empty home page to visitors without watch history,
 * so signed-out home is built from popular recent videos per topic. Signed in, the
 * real personalized home feed (and its own chips) is used.
 */
const TOPICS = [
  ['All', null],
  ['Music', 'music video'],
  ['Gaming', 'gaming'],
  ['News', 'news today'],
  ['Live', 'live'],
  ['Podcasts', 'podcast'],
  ['Sports', 'sports highlights'],
  ['Technology', 'tech review'],
  ['Science', 'science explained'],
  ['Comedy', 'comedy'],
  ['Cooking', 'cooking recipe'],
  ['Cars', 'cars'],
  ['Travel', 'travel 4k'],
  ['Movies', 'official trailer'],
];
const ALL_MIX = ['music video', 'tech review', 'gaming', 'podcast', 'news today', 'science explained'];

class YouTube {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    this.pages = new TTLCache({ ttlMs: 3 * 3600_000, max: 2000 }); // continuation token -> loader
    this.reset();
  }

  /** Drop the session and caches (sign-in state changed). */
  reset() {
    this.sessionPromise = null;
    this.cache = new TTLCache({ ttlMs: 5 * 60_000, max: 500 });
  }

  session() {
    if (!this.sessionPromise) {
      this.sessionPromise = lib().then(({ Innertube }) => Innertube.create({
        lang: this.config.youtube.lang,
        location: this.config.youtube.location,
        retrieve_player: false,
        cookie: this.account.cookieHeader() || undefined,
      })).catch((e) => {
        this.sessionPromise = null;
        throw e;
      });
    }
    return this.sessionPromise;
  }

  requireSignIn() {
    if (!this.account.signedIn) throw new HttpError(401, 'Sign in to use this feature.');
  }

  // ---------- continuations ----------

  /** Store a "load more" function; returns an opaque token for the client. */
  keep(loader) {
    const token = crypto.randomBytes(9).toString('base64url');
    this.pages.set(token, loader);
    return token;
  }

  async more(token) {
    const loader = this.pages.get(token);
    if (!loader) throw new HttpError(410, 'This list expired - reload the page.');
    return loader();
  }

  /** Wrap a youtubei.js feed into { items, next } with continuation support. */
  page(feed, pick = (f) => N.ordered(f.page), seen = new Set()) {
    const items = N.items(pick(feed) || [], seen);
    const next = feed.has_continuation
      ? this.keep(async () => this.page(await feed.getContinuation(), pick, seen))
      : null;
    return { items, next };
  }

  // ---------- home ----------

  /** fresh: skip the short-term cache (the client's continuation expired). */
  async home(chip, fresh = false) {
    const yt = await this.session();
    if (fresh) {
      this.cache.delete('home');
      this.cache.delete(`topic:${chip || 'All'}`);
    }
    if (this.account.signedIn) {
      try {
        const base = await this.cache.wrap('home', () => yt.getHomeFeed(), 5 * 60_000);
        const chips = (base.filters || []).filter(Boolean);
        const feed = chip && chip !== 'All' && chips.includes(chip) ? await base.applyFilter(chip) : base;
        const res = this.page(feed, (f) => N.ordered(f.page));
        if (res.items.length) return { chips: chips.length ? chips : ['All'], chip: chip || chips[0] || 'All', ...res };
      } catch (e) {
        console.warn(`[yt] home feed: ${e.message}`);
      }
    }
    const feed = await this.cache.wrap(`topic:${chip || 'All'}`, () => this.topicFeed(yt, chip), 5 * 60_000);
    return { ...feed, chips: TOPICS.map((t) => t[0]), chip: chip || 'All', personalized: false };
  }

  async topicFeed(yt, chip) {
    const filters = { type: 'video', upload_date: 'week', prioritize: 'popularity' };
    const topic = TOPICS.find((t) => t[0] === chip);
    if (topic && topic[1]) {
      const f = topic[0] === 'Live' ? { type: 'video', features: ['live'], prioritize: 'popularity' } : filters;
      return this.page(await yt.search(topic[1], f), (s) => s.results);
    }
    // "All": interleave several topics so the grid has variety; each keeps its own continuation.
    const seen = new Set();
    const searches = (await Promise.allSettled(ALL_MIX.map((q) => yt.search(q, filters))))
      .filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const mix = async (list) => {
      const pages = list.map((s) => N.items(s.results, seen));
      const items = [];
      for (let i = 0; pages.some((p) => p.length); i = (i + 1) % pages.length) {
        if (pages[i].length) items.push(...pages[i].splice(0, 2));
      }
      const live = list.filter((s) => s.has_continuation);
      const next = live.length
        ? this.keep(async () => mix((await Promise.allSettled(live.map((s) => s.getContinuation())))
          .filter((r) => r.status === 'fulfilled').map((r) => r.value)))
        : null;
      return { items, next };
    };
    return mix(searches);
  }

  // ---------- search ----------

  async search(query, opts = {}) {
    const yt = await this.session();
    const filters = {};
    if (['video', 'channel', 'playlist', 'movie'].includes(opts.type)) filters.type = opts.type;
    if (['today', 'week', 'month', 'year'].includes(opts.date)) filters.upload_date = opts.date;
    if (['under_three_mins', 'three_to_twenty_mins', 'over_twenty_mins'].includes(opts.duration)) filters.duration = opts.duration;
    if (opts.prioritize === 'popularity') filters.prioritize = 'popularity';
    const features = ['live', '4k', 'hd', 'subtitles', 'creative_commons'].filter((f) => (opts.features || []).includes(f));
    if (features.length) filters.features = features;
    const s = await yt.search(query, filters);
    const res = this.page(s, (x) => x.results);
    return { ...res, estimatedResults: s.estimated_results || undefined };
  }

  async suggest(query) {
    const yt = await this.session();
    return this.cache.wrap(`sg:${query}`, async () => (await yt.getSearchSuggestions(query)).slice(0, 12), 30 * 60_000)
      .catch(() => []);
  }

  // ---------- watch page ----------

  async video(id) {
    if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, 'bad video id');
    const yt = await this.session();
    const info = await this.cache.wrap(`v:${id}`, () => yt.getInfo(id), 10 * 60_000);
    const pi = info.primary_info || {};
    const si = info.secondary_info || {};
    const bi = info.basic_info || {};
    const owner = si.owner || {};
    const likeToggle = findDeep(pi.menu, (o) => o && o.like_button && typeof o.like_button.is_toggled === 'boolean');
    const seen = new Set([`video:${id}`]);
    const related = N.items(info.watch_next_feed || [], seen);
    let current = info;
    const relatedNext = info.wn_has_continuation
      ? this.keep(async function loadMore() {
        current = await current.getWatchNextContinuation();
        const items = N.items(current.watch_next_feed || [], seen);
        return { items, next: current.wn_has_continuation ? this.keep(loadMore.bind(this)) : null };
      }.bind(this))
      : null;

    return {
      id,
      title: N.clean(N.txt(pi.title)) || bi.title || '',
      viewsText: N.clean(N.txt(pi.view_count?.view_count)) || (bi.view_count != null ? `${bi.view_count.toLocaleString('en-US')} views` : ''),
      shortViewsText: N.clean(N.txt(pi.view_count?.short_view_count)),
      views: bi.view_count,
      dateText: N.clean(N.txt(pi.published)),
      relativeDate: N.clean(N.txt(pi.relative_date)),
      likes: bi.like_count,
      liked: likeToggle ? likeToggle.like_button.is_toggled : false,
      description: N.txt(si.description) || bi.short_description || '',
      channel: {
        id: owner.author?.id || bi.channel_id,
        name: N.clean(owner.author?.name) || bi.author || '',
        avatar: N.pickImage(owner.author?.thumbnails, 88),
        verified: !!(owner.author?.is_verified || owner.author?.is_verified_artist),
        subscribersText: N.clean(N.txt(owner.subscriber_count)),
      },
      subscribed: !!si.subscribe_button?.subscribed,
      live: !!bi.is_live,
      duration: bi.duration || undefined,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      commentsText: N.clean(N.txt(info.comments_entry_point_header?.comment_count)),
      related,
      relatedNext,
    };
  }

  async comments(id, sort = 'top') {
    if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, 'bad video id');
    const yt = await this.session();
    const c = await yt.getComments(id, sort === 'new' ? 'NEWEST_FIRST' : 'TOP_COMMENTS');
    const map = (thread) => {
      const cv = thread.comment || thread;
      if (!cv || !cv.content) return null;
      return {
        id: cv.comment_id,
        author: { name: N.clean(cv.author?.name), avatar: N.pickImage(cv.author?.thumbnails, 40), channelId: cv.author?.id },
        text: N.txt(cv.content),
        publishedText: N.clean(cv.published_time),
        likesText: N.clean(cv.like_count) === '0' ? '' : N.clean(cv.like_count),
        replies: Number(N.clean(cv.reply_count)) || 0,
        pinned: !!cv.is_pinned,
        byOwner: !!cv.author_is_channel_owner,
        hearted: !!cv.is_hearted,
      };
    };
    const pageOf = (feed) => ({
      items: (feed.contents || []).map(map).filter(Boolean),
      next: feed.has_continuation ? this.keep(async () => pageOf(await feed.getContinuation())) : null,
    });
    return { countText: N.clean(N.txt(c.header?.count)), ...pageOf(c) };
  }

  // ---------- channels ----------

  async channel(idOrHandle, sort) {
    const yt = await this.session();
    let id = idOrHandle;
    if (!/^UC[\w-]{22}$/.test(id)) {
      const handle = id.startsWith('@') ? id : `@${id}`;
      if (!/^@[\w.\-\u00C0-\uFFFF]{1,100}$/.test(handle)) throw new HttpError(400, 'bad channel');
      const ep = await yt.resolveURL(`https://www.youtube.com/${handle}`);
      id = ep?.payload?.browseId;
      if (!id) throw new HttpError(404, 'Channel not found');
    }
    const ch = await this.cache.wrap(`ch:${id}`, () => yt.getChannel(id), 10 * 60_000);
    const header = channelHeader(ch, id);
    let list = null;
    let sorts = [];
    if (ch.has_videos) {
      let vids = await ch.getVideos();
      sorts = vids.filters || [];
      if (sort && sorts.includes(sort) && sort !== sorts[0]) vids = await vids.applyFilter(sort);
      list = this.page(vids, (f) => N.ordered(f.page));
    }
    return { channel: header, sorts, sort: sort || sorts[0] || null, ...(list || { items: [], next: null }) };
  }

  // ---------- library (signed in) ----------

  async feed(name) {
    this.requireSignIn();
    const yt = await this.session();
    switch (name) {
      case 'subscriptions':
        return { title: 'Subscriptions', ...this.page(await yt.getSubscriptionsFeed(), (f) => N.ordered(f.page)) };
      case 'history': {
        const h = await yt.getHistory();
        return { title: 'Watch history', ...this.page(h, (f) => N.ordered(f.page)) };
      }
      case 'watchlater':
        return this.playlist('WL');
      case 'liked':
        return this.playlist('LL');
      case 'playlists': {
        const f = await yt.getPlaylists();
        return { title: 'Playlists', ...this.page(f, (x) => [...(x.playlists || []), ...(x.contents_memo?.getType?.('LockupView') || [])]) };
      }
      default:
        throw new HttpError(404, 'unknown feed');
    }
  }

  async playlist(id) {
    if (!/^[\w-]{2,64}$/.test(id)) throw new HttpError(400, 'bad playlist id');
    const yt = await this.session();
    const pl = await yt.getPlaylist(id);
    const info = pl.info || {};
    const title = id === 'WL' ? 'Watch later' : id === 'LL' ? 'Liked videos' : N.clean(info.title);
    return {
      title,
      subtitle: [N.clean(info.author?.name), N.clean(info.total_items), N.clean(info.views)].filter(Boolean).join(' • '),
      thumbnail: N.pickImage(info.thumbnails, 480),
      ...this.page(pl, (p) => p.items),
    };
  }

  /** Subscribed channels for the sidebar. */
  async guide() {
    if (!this.account.signedIn) return { subscriptions: [] };
    return this.cache.wrap('guide', async () => {
      const yt = await this.session();
      const g = await yt.getGuide();
      const out = [];
      const walk = (entries) => {
        for (const e of entries || []) {
          if (e?.expandable_items) walk(e.expandable_items);
          const browseId = e?.endpoint?.payload?.browseId;
          if (browseId && /^UC[\w-]{22}$/.test(browseId)) {
            out.push({ id: browseId, name: N.clean(N.txt(e.title)), avatar: N.pickImage(e.thumbnails, 48) });
          }
        }
      };
      for (const section of g.contents || []) {
        if (section.type === 'GuideSubscriptionsSection') walk(section.items);
      }
      return { subscriptions: out };
    }, 10 * 60_000).catch((e) => {
      console.warn(`[yt] guide: ${e.message}`);
      return { subscriptions: [] };
    });
  }

  async me() {
    if (!this.account.signedIn) return null;
    return this.cache.wrap('me', async () => {
      const yt = await this.session();
      const info = await yt.account.getInfo();
      const item = findDeep(info?.contents, (o) => o && (o.account_name || o.account_photo));
      if (!item) return { name: 'Your account' };
      return {
        name: N.clean(N.txt(item.account_name)),
        handle: N.clean(N.txt(item.channel_handle)),
        avatar: N.pickImage(item.account_photo, 64),
      };
    }, 30 * 60_000).catch(() => ({ name: 'Your account' }));
  }

  // ---------- actions (signed in) ----------

  async action(type, id) {
    this.requireSignIn();
    const yt = await this.session();
    const vid = () => {
      if (!/^[\w-]{11}$/.test(id || '')) throw new HttpError(400, 'bad video id');
      return id;
    };
    const cid = () => {
      if (!/^UC[\w-]{22}$/.test(id || '')) throw new HttpError(400, 'bad channel id');
      return id;
    };
    switch (type) {
      case 'like': await yt.interact.like(vid()); break;
      case 'dislike': await yt.interact.dislike(vid()); break;
      case 'unrate': await yt.interact.removeRating(vid()); break;
      case 'subscribe': await yt.interact.subscribe(cid()); this.cache.delete('guide'); break;
      case 'unsubscribe': await yt.interact.unsubscribe(cid()); this.cache.delete('guide'); break;
      case 'watchlater': await yt.playlist.addVideos('WL', [vid()]); break;
      case 'unwatchlater': await yt.playlist.removeVideos('WL', [vid()]); break;
      default: throw new HttpError(400, 'unknown action');
    }
    if (/like|rate/.test(type)) this.cache.delete(`v:${id}`);
    return { ok: true };
  }
}

function channelHeader(ch, id) {
  const md = ch.metadata || {};
  const content = ch.header?.content || {};
  const rows = content.metadata?.metadata_rows || [];
  const parts = rows.flatMap((r) => (r.metadata_parts || []).map((p) => N.clean(N.txt(p.text))).filter(Boolean));
  const avatarView = content.image?.avatar || content.image;
  const bannerImg = content.banner?.image || ch.header?.banner;
  return {
    id,
    name: N.clean(N.txt(content.title?.text)) || N.clean(N.txt(content.title)) || N.clean(md.title),
    avatar: N.pickImage(avatarView?.image || md.thumbnail || md.avatar, 160),
    banner: N.pickImage(bannerImg, 1060),
    handle: parts.find((p) => p.startsWith('@')) || (md.vanity_channel_url || '').split('/').pop() || '',
    subscribersText: parts.find((p) => /subscriber/i.test(p)) || '',
    videosText: parts.find((p) => /video/i.test(p)) || '',
    description: N.clean(N.txt(content.description?.description)) || N.clean(md.description),
    subscribed: !!(ch.subscribe_button?.subscribed ?? findDeep(content.actions, (o) => o && typeof o.subscribed === 'boolean')?.subscribed),
  };
}

/** Depth-first search through a parsed node tree (bounded). */
function findDeep(root, pred, depth = 0, seen = new Set()) {
  if (!root || typeof root !== 'object' || depth > 8 || seen.has(root)) return null;
  seen.add(root);
  if (pred(root)) return root;
  for (const v of Array.isArray(root) ? root : Object.values(root)) {
    const r = findDeep(v, pred, depth + 1, seen);
    if (r) return r;
  }
  return null;
}

module.exports = { YouTube };
