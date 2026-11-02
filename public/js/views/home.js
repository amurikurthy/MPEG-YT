import { api } from '../api.js';
import { h, href, card, grid, skeletonGrid, errorBox, empty } from '../ui.js';
import { history } from '../state.js';

export async function render({ pid, provider, view, isCurrent }) {
  const page = h('div', { class: 'page' });
  view.replaceChildren(page);

  if (provider.account && !provider.account.signedIn) {
    page.append(h('div', { class: 'notice' },
      h('div', {}, h('strong', {}, 'Make it yours. '), `Sign in to ${provider.name} to see your recommendations and subscriptions.`),
      h('button', { class: 'btn', type: 'button', onclick: () => window.dispatchEvent(new Event('mpegyt:account')) }, 'Sign in')));
  }

  // Continue watching (local, instant).
  const recent = history.list(pid).filter((x) => x.pos > 10 && (!x.item.duration || x.pos < x.item.duration - 15)).slice(0, 8);
  if (recent.length) {
    page.append(h('section', { class: 'shelf' },
      h('h2', {}, 'Continue watching'),
      h('div', { class: 'grid' }, recent.map((r) =>
        card(pid, r.item, { progress: r.item.duration ? r.pos / r.item.duration : 0, startAt: r.pos })))));
  }

  if (!provider.capabilities.home) {
    if (!recent.length) page.append(empty(`Search ${provider.name} to get started.`));
    return;
  }

  const loading = h('section', { class: 'shelf' }, h('h2', { class: 'skeleton-text' }, ' '), skeletonGrid(8));
  page.append(loading);

  let shelves;
  try {
    shelves = await api.home(pid);
  } catch (e) {
    if (!isCurrent()) return;
    loading.replaceWith(errorBox(e.message, () => render({ pid, provider, view, isCurrent })));
    return;
  }
  if (!isCurrent()) return;
  loading.remove();
  if (!shelves.length && !recent.length) page.append(empty('Nothing here yet.'));
  for (const s of shelves) {
    const more = s.more
      ? h('a', { class: 'more', href: s.more.kind === 'search' ? href.search(pid, s.more.id) : href.collection(pid, s.more.id) }, 'See more')
      : null;
    page.append(h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, s.title), more), grid(pid, s.items)));
  }
}
