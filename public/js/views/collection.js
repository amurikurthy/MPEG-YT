import { api } from '../api.js';
import { h, grid, skeletonGrid, errorBox, empty, icon } from '../ui.js';

export async function render({ pid, id, view, isCurrent }) {
  const head = h('div', { class: 'collection-head' }, h('div', { class: 'avatar skeleton' }), h('div', {}, h('h1', { class: 'skeleton-text' }, ' ')));
  const body = skeletonGrid(12);
  view.replaceChildren(h('div', { class: 'page' }, head, body));

  let data;
  try {
    data = await api.collection(pid, id);
  } catch (e) {
    if (isCurrent()) body.replaceWith(errorBox(e.message, () => render({ pid, id, view, isCurrent })));
    return;
  }
  if (!isCurrent()) return;
  document.title = `${data.title} · MPEG-YT`;
  const avatar = data.thumbnail
    ? h('img', { class: 'avatar', src: data.thumbnail, alt: '' })
    : h('div', { class: 'avatar' }, icon('folder', 36));
  head.replaceChildren(avatar, h('div', {}, h('h1', {}, data.title), data.subtitle ? h('p', { class: 'sub' }, data.subtitle) : null));
  body.replaceWith(data.items.length ? grid(pid, data.items) : empty('This is empty.'));
}
