import { api } from '../api.js';
import { h, card, skeletonGrid, errorBox, empty } from '../ui.js';

export async function render({ pid, view, query, isCurrent }) {
  document.title = `${query} · MPEG-YT`;
  const results = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel' });
  const page = h('div', { class: 'page' }, h('h1', { class: 'page-title' }, `Results for “${query}”`), skeletonGrid(12));
  view.replaceChildren(page);

  let next = 1;
  let busy = false;
  const seen = new Set();

  async function loadMore(first) {
    if (busy || !next) return;
    busy = true;
    try {
      const res = await api.search(pid, query, next);
      if (!isCurrent()) return;
      if (first) page.lastChild.replaceWith(results);
      for (const it of res.items) {
        const key = `${it.kind}:${it.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.append(card(pid, it));
      }
      next = res.next;
      if (first && !results.children.length) results.replaceWith(empty('No results.'));
      if (next && first) page.append(sentinel);
      if (!next) sentinel.remove();
    } catch (e) {
      if (!isCurrent()) return;
      if (first) page.lastChild.replaceWith(errorBox(e.message, () => render({ pid, view, query, isCurrent })));
      next = null;
    } finally {
      busy = false;
    }
  }

  await loadMore(true);
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore(false);
  }, { rootMargin: '800px' });
  io.observe(sentinel);
  return () => io.disconnect();
}
