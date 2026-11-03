import { api } from '../api.js';
import { h, icon, videoCard, videoRow, skeletonGrid, skeletonList, errorBox, empty, infinite, href, toast } from '../ui.js';
import { history } from '../state.js';

/** Subscriptions, History, You, Playlists and playlist pages (Watch later, Liked, ...). */
export async function render(ctx) {
  const { page } = ctx;
  if (page === 'subscriptions') return subscriptions(ctx);
  if (page === 'history') return historyPage(ctx);
  if (page === 'you') return you(ctx);
  if (page === 'playlists') return playlists(ctx);
  if (page === 'playlist') return playlist(ctx);
  return undefined;
}

function signInPrompt(app, iconName, title, text) {
  return h('div', { class: 'empty prompt' },
    icon(iconName, 120),
    h('h2', {}, title),
    h('p', {}, text),
    h('button', { class: 'signin-btn', type: 'button', onclick: () => app.signIn() }, icon('you'), 'Sign in'));
}

async function subscriptions({ view, app, isCurrent }) {
  document.title = 'Subscriptions - MPEG-YT';
  if (!app.session.signedIn) {
    view.replaceChildren(signInPrompt(app, 'subscriptions', 'Don’t miss new videos', 'Sign in to see updates from your favorite YouTube channels'));
    return undefined;
  }
  let body = skeletonGrid(12);
  view.replaceChildren(h('div', { class: 'browse' }, h('h1', { class: 'page-title' }, 'Latest'), body));
  try {
    const d = await api.feed('subscriptions');
    if (!isCurrent()) return undefined;
    if (!d.items.length) {
      body.replaceWith(empty('No new videos', 'Videos from channels you subscribe to will show up here.'));
      return undefined;
    }
    const grid = h('div', { class: 'grid' }, d.items.map((it) => videoCard(it)));
    body.replaceWith(grid);
    body = grid;
    return infinite(grid, d.next, (items) => grid.append(...items.map((it) => videoCard(it))));
  } catch (e) {
    if (isCurrent()) body.replaceWith(errorBox(e.message));
    return undefined;
  }
}

async function historyPage({ view, app, isCurrent }) {
  document.title = 'Watch history - MPEG-YT';
  const title = h('h1', { class: 'page-title' }, 'Watch history');
  if (!app.session.signedIn) {
    const items = history.list().map((x) => x.item).filter(Boolean);
    const clear = h('button', { class: 'pill', type: 'button', onclick: () => { history.clear(); toast('History cleared'); app.navigate('/feed/history', { replace: true }); } }, 'Clear all watch history');
    view.replaceChildren(h('div', { class: 'library' }, title,
      h('p', { class: 'muted' }, 'You’re signed out, so this history is stored on this device only. Sign in to see your YouTube history.'),
      items.length ? h('div', { class: 'list' }, items.map(videoRow)) : empty('Nothing here yet', 'Videos you watch will show up here.'),
      items.length ? clear : null));
    return undefined;
  }
  let body = skeletonList(6);
  view.replaceChildren(h('div', { class: 'library' }, title, body));
  try {
    const d = await api.feed('history');
    if (!isCurrent()) return undefined;
    const list = h('div', { class: 'list' }, d.items.map(videoRow));
    body.replaceWith(d.items.length ? list : empty('Nothing here yet', 'Videos you watch will show up here.'));
    return infinite(list, d.next, (items) => list.append(...items.map(videoRow)));
  } catch (e) {
    if (isCurrent()) body.replaceWith(errorBox(e.message));
    return undefined;
  }
}

async function you({ view, app, isCurrent }) {
  document.title = 'You - MPEG-YT';
  const page = h('div', { class: 'library you' });
  view.replaceChildren(page);
  const shelf = (title, link, items, render = videoCard) => h('section', { class: 'shelf' },
    h('div', { class: 'shelf-head' }, h('h2', {}, title), link ? h('a', { class: 'pill', href: link }, 'View all') : null),
    items.length ? h('div', { class: 'shelf-row' }, items.slice(0, 12).map((it) => render(it))) : h('p', { class: 'muted' }, 'Nothing here yet.'));

  if (!app.session.signedIn) {
    page.append(signInPrompt(app, 'you', 'Enjoy your favorite videos', 'Sign in to access videos that you’ve liked or saved'));
    const local = history.list().map((x) => x.item).filter(Boolean);
    if (local.length) page.append(shelf('History (this device)', '/feed/history', local));
    return undefined;
  }
  const sections = [
    ['History', '/feed/history', api.feed('history')],
    ['Watch later', href.playlist('WL'), api.playlist('WL')],
    ['Liked videos', href.playlist('LL'), api.playlist('LL')],
    ['Playlists', '/feed/playlists', api.feed('playlists')],
  ];
  const slots = sections.map(([title]) => {
    const s = h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, title)), skeletonGrid(4));
    page.append(s);
    return s;
  });
  sections.forEach(([title, link, p], i) => p.then((d) => {
    if (isCurrent()) slots[i].replaceWith(shelf(title, link, d.items));
  }).catch((e) => {
    if (isCurrent()) slots[i].replaceWith(h('section', { class: 'shelf' }, h('h2', {}, title), h('p', { class: 'muted' }, e.message)));
  }));
  return undefined;
}

async function playlists({ view, app, isCurrent }) {
  document.title = 'Playlists - MPEG-YT';
  if (!app.session.signedIn) {
    view.replaceChildren(signInPrompt(app, 'playlists', 'Your playlists', 'Sign in to see your playlists'));
    return undefined;
  }
  let body = skeletonGrid(8);
  view.replaceChildren(h('div', { class: 'browse' }, h('h1', { class: 'page-title' }, 'Playlists'), body));
  try {
    const d = await api.feed('playlists');
    if (!isCurrent()) return undefined;
    body.replaceWith(d.items.length ? h('div', { class: 'grid' }, d.items.map((it) => videoCard(it))) : empty('No playlists yet'));
  } catch (e) {
    if (isCurrent()) body.replaceWith(errorBox(e.message));
  }
  return undefined;
}

async function playlist({ view, list, app, isCurrent }) {
  if ((list === 'WL' || list === 'LL') && !app.session.signedIn) {
    view.replaceChildren(signInPrompt(app, list === 'WL' ? 'watchlater' : 'liked', list === 'WL' ? 'Watch later' : 'Liked videos', 'Sign in to see videos you’ve saved'));
    return undefined;
  }
  let body = skeletonList(8);
  const side = h('aside', { class: 'pl-hero sk' });
  view.replaceChildren(h('div', { class: 'playlist-page' }, side, body));
  let d;
  try {
    d = await api.playlist(list);
  } catch (e) {
    if (isCurrent()) {
      side.remove();
      body.replaceWith(errorBox(e.message));
    }
    return undefined;
  }
  if (!isCurrent()) return undefined;
  document.title = `${d.title} - MPEG-YT`;
  const first = d.items.find((v) => v.kind === 'video');
  side.className = 'pl-hero';
  side.replaceChildren(
    d.thumbnail || first ? h('img', { class: 'pl-hero-img', src: d.thumbnail || first.thumbnail, alt: '' }) : null,
    h('h1', {}, d.title),
    h('div', { class: 'muted small' }, d.subtitle),
    first ? h('a', { class: 'pill primary play-all', href: `${href.watch(first.id)}&list=${encodeURIComponent(list)}` }, icon('play'), 'Play all') : null);
  if (!d.items.length) {
    body.replaceWith(empty('No videos in this playlist yet'));
    return undefined;
  }
  let n = 0;
  const row = (it) => {
    n += 1;
    const r = videoRow(it);
    const a = r.querySelector('a.thumb');
    if (a && it.kind === 'video') a.href = `${href.watch(it.id)}&list=${encodeURIComponent(list)}`;
    return h('div', { class: 'pl-row' }, h('span', { class: 'idx muted' }, String(n)), r);
  };
  const box = h('div', { class: 'list' }, d.items.map(row));
  body.replaceWith(box);
  return infinite(box, d.next, (items) => box.append(...items.map(row)));
}
