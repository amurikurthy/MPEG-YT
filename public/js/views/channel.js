import { api } from '../api.js';
import { h, icon, avatar, videoCard, chipBar, skeletonGrid, errorBox, empty, infinite, act } from '../ui.js';

export async function render({ view, id, params, app, isCurrent }) {
  const sort = params.get('sort') || undefined;
  const head = h('div', { class: 'channel-head' }, h('div', { class: 'channel-banner sk' }), h('div', { class: 'line sk', style: { width: '40%', height: '36px' } }));
  let body = skeletonGrid(12);
  const page = h('div', { class: 'channel' }, head, body);
  view.replaceChildren(page);

  let data;
  try {
    data = await api.channel(id, sort);
  } catch (e) {
    if (isCurrent()) {
      head.replaceChildren();
      body.replaceWith(errorBox(e.status === 404 ? 'This channel doesn’t exist.' : e.message));
    }
    return;
  }
  if (!isCurrent()) return;
  const c = data.channel;
  document.title = `${c.name} - MPEG-YT`;

  let subscribed = c.subscribed || app.session.subscriptions?.some((s) => s.id === c.id);
  const subBtn = h('button', { class: 'sub-btn big', type: 'button' });
  const paint = () => {
    subBtn.textContent = subscribed ? 'Subscribed' : 'Subscribe';
    subBtn.classList.toggle('subscribed', subscribed);
  };
  paint();
  subBtn.addEventListener('click', async () => {
    if (!app.session.signedIn) return app.signIn();
    if (await act(subscribed ? 'unsubscribe' : 'subscribe', c.id, subscribed ? 'Subscription removed' : 'Subscription added')) {
      subscribed = !subscribed;
      paint();
      app.refreshSession();
    }
  });

  const descEl = c.description ? h('button', { class: 'channel-desc', type: 'button' }, h('span', {}, c.description), icon('chevronRight', 18)) : null;
  descEl?.addEventListener('click', () => descEl.classList.toggle('open'));

  head.replaceChildren(
    c.banner ? h('div', { class: 'channel-banner' }, h('img', { src: c.banner, alt: '', referrerpolicy: 'no-referrer' })) : null,
    h('div', { class: 'channel-info' },
      avatar(c.avatar, 160),
      h('div', { class: 'channel-text' },
        h('h1', {}, c.name),
        h('div', { class: 'muted' }, h('strong', { class: 'handle' }, c.handle), [c.subscribersText, c.videosText].filter(Boolean).map((t) => ` • ${t}`).join('')),
        descEl,
        subBtn)),
    h('div', { class: 'tabs' }, h('span', { class: 'tab on' }, 'Videos')));

  const sorts = data.sorts.length ? chipBar(data.sorts, data.sort, (s) => app.navigate(`${location.pathname}?sort=${encodeURIComponent(s)}`)) : null;
  if (!data.items.length) {
    body.replaceWith(empty('This channel doesn’t have any videos.'));
    return;
  }
  const grid = h('div', { class: 'grid channel-grid' }, data.items.map((it) => videoCard(it, { showChannel: false })));
  body.replaceWith(h('div', { class: 'channel-videos' }, sorts, grid));
  body = grid;
  return infinite(grid, data.next, (items) => grid.append(...items.map((it) => videoCard(it, { showChannel: false }))));
}
