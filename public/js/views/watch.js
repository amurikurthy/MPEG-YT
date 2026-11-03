import { api } from '../api.js';
import {
  h, icon, avatar, fmt, href, compactCard, channelName, skeletonList, errorBox, infinite, act, share, popover, toast,
} from '../ui.js';
import { history, prefs } from '../state.js';
import { CanvasPlayer } from '../player.js';

const AUTOPLAY_DELAY = 8;

export async function render({ view, params, app, isCurrent }) {
  const id = params.get('v');
  const listId = params.get('list');
  let startAt = Number(params.get('t')) || 0;
  if (!startAt) {
    // Resume where you left off (like YouTube), unless you were near the end.
    const h0 = history.get(id);
    if (h0 && h0.pos > 15 && (!h0.duration || h0.pos < h0.duration - 20)) startAt = h0.pos;
  }

  // ----- layout -----
  const theaterSlot = h('div', { class: 'theater-slot' });
  const playerSlot = h('div', { class: 'player-slot' });
  const info = h('div', { class: 'watch-info' }, h('div', { class: 'line sk', style: { width: '70%', height: '28px', marginTop: '12px' } }));
  const comments = h('section', { class: 'comments' });
  const playlistBox = h('div', { class: 'playlist-box', hidden: true });
  const related = h('div', { class: 'related' }, skeletonList(10, 'ccard'));
  const primary = h('div', { class: 'watch-primary' }, playerSlot, info, h('div', { class: 'related-inline' }), comments);
  const secondary = h('div', { class: 'watch-secondary' }, playlistBox, related);
  const root = h('div', { class: 'watch' }, theaterSlot, h('div', { class: 'watch-cols' }, primary, secondary));
  view.replaceChildren(root);

  let detail = null;
  let upNext = [];
  let playlist = null;
  let countdown = null;
  let theater = prefs.get('theater', false);

  const player = new CanvasPlayer(playerSlot, {
    id,
    startAt,
    streamCfg: app.session.stream,
    onProgress: (pos, dur) => detail && history.save(detail, pos, dur),
    onEnded: () => showEndScreen(),
    onNext: () => playNext(),
    onTheater: () => setTheater(!theater),
  });

  function setTheater(on) {
    theater = on;
    prefs.set('theater', on);
    root.classList.toggle('theater', on);
    // Moving the canvas keeps its WebGL context, so playback continues uninterrupted.
    if (on) theaterSlot.append(playerSlot);
    else primary.prepend(playerSlot);
    player.setTheater(on);
  }
  setTheater(theater);

  // Narrow screens: Up next moves under the description (as on YouTube).
  const relocate = () => {
    const narrow = window.innerWidth < 1016;
    const target = narrow ? primary.querySelector('.related-inline') : secondary;
    if (related.parentElement !== target) target.append(related);
  };
  relocate();
  window.addEventListener('resize', relocate);

  const nextVideo = () => {
    if (playlist) {
      const i = playlist.items.findIndex((v) => v.id === id);
      const nxt = playlist.items.slice(i + 1).find((v) => v.kind === 'video');
      if (nxt) return { item: nxt, url: `${href.watch(nxt.id)}&list=${encodeURIComponent(listId)}` };
    }
    const nxt = upNext.find((v) => v.kind === 'video');
    return nxt ? { item: nxt, url: href.watch(nxt.id) } : null;
  };
  const playNext = () => {
    const n = nextVideo();
    if (n) app.navigate(n.url);
  };

  function showEndScreen() {
    if (detail) history.save(detail, 0, detail.duration);
    const n = nextVideo();
    const el = player.endScreen;
    if (!n || prefs.get('autoplay', true) === false) return;
    let left = AUTOPLAY_DELAY;
    const label = h('div', { class: 'muted' }, `Up next in ${left}`);
    el.replaceChildren(h('div', { class: 'up-next' },
      label,
      h('a', { class: 'up-next-card', href: n.url },
        h('img', { src: n.item.thumbnail, alt: '' }),
        h('div', {}, h('strong', {}, n.item.title), h('div', { class: 'muted small' }, n.item.channel?.name || ''))),
      h('div', { class: 'up-next-actions' },
        h('button', { class: 'pill', type: 'button', onclick: () => { clearInterval(countdown); el.hidden = true; } }, 'Cancel'),
        h('a', { class: 'pill primary', href: n.url }, 'Play now'))));
    el.hidden = false;
    clearInterval(countdown);
    countdown = setInterval(() => {
      left -= 1;
      label.textContent = `Up next in ${left}`;
      if (left <= 0) {
        clearInterval(countdown);
        if (isCurrent()) app.navigate(n.url);
      }
    }, 1000);
  }

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (player.handleKey(e)) e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  let stopRelated = () => {};
  let stopComments = () => {};
  const commentsObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      commentsObserver.disconnect();
      loadComments('top');
    }
  }, { rootMargin: '600px' });

  const cleanup = () => {
    clearInterval(countdown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', relocate);
    commentsObserver.disconnect();
    stopRelated();
    stopComments();
    player.destroy();
  };

  // ----- data -----
  if (listId) {
    api.playlist(listId).then((pl) => {
      if (!isCurrent()) return;
      playlist = pl;
      renderPlaylist(playlistBox, pl, id, listId);
    }).catch(() => {});
  }

  try {
    detail = await api.video(id);
  } catch (e) {
    if (isCurrent()) {
      info.replaceChildren(errorBox(`Couldn’t load this video’s details. ${e.message}`));
      related.replaceChildren();
    }
    return cleanup;
  }
  if (!isCurrent()) return cleanup;
  document.title = `${detail.title} - MPEG-YT`;
  player.setDetail(detail);
  renderInfo(info, detail, app, (t) => player.seekTo(t));

  upNext = detail.related || [];
  const list = h('div', { class: 'list compact' }, upNext.map(compactCard));
  related.replaceChildren(list);
  stopRelated = infinite(list, detail.relatedNext, (items) => {
    upNext.push(...items);
    list.append(...items.map(compactCard).filter(Boolean));
  });

  commentsObserver.observe(comments);
  async function loadComments(sort) {
    stopComments();
    comments.replaceChildren(h('div', { class: 'spinner small' }));
    let c;
    try {
      c = await api.comments(id, sort);
    } catch (e) {
      comments.replaceChildren(h('p', { class: 'muted' }, /disabled|turned off/i.test(e.message) ? 'Comments are turned off.' : 'Comments couldn’t be loaded.'));
      return;
    }
    if (!isCurrent()) return;
    const sortBtn = h('button', { class: 'sort-btn', type: 'button' }, icon('sort'), 'Sort by');
    sortBtn.addEventListener('click', () => popover(sortBtn, [
      { label: `${sort === 'top' ? '✓ ' : ''}Top comments`, run: () => loadComments('top') },
      { label: `${sort === 'new' ? '✓ ' : ''}Newest first`, run: () => loadComments('new') },
    ]));
    const box = h('div', { class: 'comment-list' }, c.items.map(comment));
    comments.replaceChildren(
      h('div', { class: 'comments-head' }, h('h2', {}, c.countText || 'Comments'), sortBtn),
      c.items.length ? box : h('p', { class: 'muted' }, 'No comments yet.'));
    stopComments = infinite(box, c.next, (items) => box.append(...items.map(comment)));
  }

  return cleanup;
}

// ---------- info under the player ----------

function renderInfo(el, d, app, seek) {
  const signedIn = () => app.session.signedIn;
  const needSignIn = () => {
    app.signIn();
    return false;
  };

  // Subscribe
  let subscribed = d.subscribed;
  const subBtn = h('button', { class: 'sub-btn', type: 'button' });
  const paintSub = () => {
    subBtn.textContent = subscribed ? 'Subscribed' : 'Subscribe';
    subBtn.classList.toggle('subscribed', subscribed);
  };
  paintSub();
  subBtn.addEventListener('click', async () => {
    if (!signedIn()) return needSignIn();
    const ok = await act(subscribed ? 'unsubscribe' : 'subscribe', d.channel.id, subscribed ? 'Subscription removed' : 'Subscription added');
    if (ok) {
      subscribed = !subscribed;
      paintSub();
      app.refreshSession();
    }
  });

  // Like / dislike
  let liked = d.liked;
  let likes = d.likes;
  const likeBtn = h('button', { class: 'seg-btn', type: 'button', 'aria-label': 'Like this video' });
  const dislikeBtn = h('button', { class: 'seg-btn', type: 'button', 'aria-label': 'Dislike this video' }, icon('dislike'));
  const paintLike = () => {
    likeBtn.replaceChildren(icon('liked'), Number.isFinite(likes) ? fmt.compact(likes) : 'Like');
    likeBtn.classList.toggle('on', liked);
  };
  paintLike();
  likeBtn.addEventListener('click', async () => {
    if (!signedIn()) return needSignIn();
    const ok = await act(liked ? 'unrate' : 'like', d.id);
    if (ok) {
      likes = Number.isFinite(likes) ? likes + (liked ? -1 : 1) : likes;
      liked = !liked;
      paintLike();
    }
  });
  dislikeBtn.addEventListener('click', async () => {
    if (!signedIn()) return needSignIn();
    if (await act('dislike', d.id, 'You dislike this video')) {
      if (liked) likes -= 1;
      liked = false;
      paintLike();
    }
  });

  const saveBtn = h('button', { class: 'pill', type: 'button' }, icon('save'), 'Save');
  saveBtn.addEventListener('click', () => (signedIn() ? act('watchlater', d.id, 'Saved to Watch later') : needSignIn()));

  // Description
  const descText = h('div', { class: 'desc-text' }, richText(d.description, seek));
  const more = h('button', { class: 'desc-more', type: 'button' }, '...more');
  const desc = h('div', { class: 'desc collapsed', tabindex: '0' },
    h('div', { class: 'desc-stats' },
      h('span', { title: d.viewsText }, d.live ? d.viewsText : d.shortViewsText || d.viewsText),
      h('span', { title: d.dateText }, d.relativeDate || d.dateText)),
    descText, more);
  const expand = () => {
    if (!desc.classList.contains('collapsed')) return;
    desc.classList.remove('collapsed');
    desc.querySelector('.desc-stats').firstChild.textContent = d.viewsText;
    desc.querySelector('.desc-stats').lastChild.textContent = d.dateText || d.relativeDate;
    more.replaceWith(h('button', { class: 'desc-more', type: 'button', onclick: (e) => {
      e.stopPropagation();
      desc.classList.add('collapsed');
      desc.querySelector('.desc-stats').firstChild.textContent = d.shortViewsText || d.viewsText;
      desc.querySelector('.desc-stats').lastChild.textContent = d.relativeDate || d.dateText;
      e.target.replaceWith(more);
    } }, 'Show less'));
  };
  desc.addEventListener('click', (e) => !e.target.closest('a') && expand());

  el.replaceChildren(
    h('h1', { class: 'watch-title' }, d.title),
    h('div', { class: 'watch-row' },
      h('div', { class: 'owner' },
        h('a', { href: href.channel(d.channel) }, avatar(d.channel.avatar, 40)),
        h('div', { class: 'owner-text' }, channelName(d.channel, 'owner-name'), h('div', { class: 'muted small' }, d.channel.subscribersText)),
        subBtn),
      h('div', { class: 'actions' },
        h('div', { class: 'seg' }, likeBtn, h('span', { class: 'seg-div' }), dislikeBtn),
        h('button', { class: 'pill', type: 'button', onclick: () => share(d) }, icon('share'), 'Share'),
        saveBtn)),
    desc);
}

/** Description text with clickable links and timestamps (never parsed as HTML). */
function richText(text, seek) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"')]+)|(?:^|(?<=\s))((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$)/gm;
  let last = 0;
  let m;
  while ((m = re.exec(text || ''))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer' }, m[1]));
    else {
      const secs = m[2].split(':').reduce((a, p) => a * 60 + Number(p), 0);
      out.push(h('a', { href: '#', class: 'ts', onclick: (e) => { e.preventDefault(); e.stopPropagation(); seek(secs); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, m[2]));
    }
    last = m.index + m[0].length;
  }
  if (last < (text || '').length) out.push(text.slice(last));
  return out;
}

// ---------- comments ----------

function comment(c) {
  const text = h('div', { class: 'comment-text clamp4' }, c.text);
  const readMore = h('button', { class: 'desc-more', type: 'button', hidden: true, onclick: (e) => {
    text.classList.toggle('clamp4');
    e.target.textContent = text.classList.contains('clamp4') ? 'Read more' : 'Show less';
  } }, 'Read more');
  requestAnimationFrame(() => { readMore.hidden = text.scrollHeight <= text.clientHeight + 2; });
  return h('div', { class: 'comment' },
    h('a', { href: c.author.channelId ? `/channel/${c.author.channelId}` : null }, avatar(c.author.avatar, 40)),
    h('div', { class: 'comment-body' },
      c.pinned ? h('div', { class: 'muted small pinned' }, icon('pin', 14), 'Pinned') : null,
      h('div', { class: 'comment-head' },
        h('a', { class: `comment-author${c.byOwner ? ' owner' : ''}`, href: c.author.channelId ? `/channel/${c.author.channelId}` : null }, c.author.name),
        h('span', { class: 'muted small' }, c.publishedText)),
      text, readMore,
      h('div', { class: 'comment-actions' },
        h('span', { class: 'comment-likes' }, icon('liked', 16), c.likesText || ''),
        h('span', {}, icon('dislike', 16)),
        c.hearted ? h('span', { class: 'heart' }, icon('heart', 16)) : null,
        c.replies ? h('span', { class: 'replies' }, `${c.replies} repl${c.replies === 1 ? 'y' : 'ies'}`) : null)));
}

// ---------- playlist panel ----------

function renderPlaylist(box, pl, currentId, listId) {
  const idx = pl.items.findIndex((v) => v.id === currentId);
  box.replaceChildren(
    h('div', { class: 'playlist-head' },
      h('a', { class: 'playlist-title', href: href.playlist(listId) }, pl.title),
      h('div', { class: 'muted small' }, `${pl.subtitle ? `${pl.subtitle} · ` : ''}${idx + 1} / ${pl.items.length}`)),
    h('div', { class: 'playlist-items' }, pl.items.filter((v) => v.kind === 'video').map((v, i) =>
      h('a', { class: `playlist-item${v.id === currentId ? ' on' : ''}`, href: `${href.watch(v.id)}&list=${encodeURIComponent(listId)}` },
        h('span', { class: 'idx' }, v.id === currentId ? '▶' : String(i + 1)),
        h('img', { src: v.thumbnail, alt: '', loading: 'lazy' }),
        h('div', {}, h('div', { class: 'pl-item-title' }, v.title), h('div', { class: 'muted small' }, v.channel?.name || ''))))));
  box.hidden = false;
  const list = box.querySelector('.playlist-items');
  const cur = box.querySelector('.playlist-item.on');
  if (cur) list.scrollTop = cur.offsetTop - list.offsetTop - list.clientHeight / 2 + cur.clientHeight / 2;
  if (!pl.items.length) toast('This playlist is empty.');
}
