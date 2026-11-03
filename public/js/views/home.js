import { api } from '../api.js';
import { h, videoCard, chipBar, skeletonGrid, errorBox, infinite } from '../ui.js';

let lastChip = null;

export async function render({ view, isCurrent }) {
  const chipsSlot = h('div', { class: 'chips-sticky' });
  let body = skeletonGrid(12);
  const page = h('div', { class: 'browse' }, chipsSlot, body);
  view.replaceChildren(page);
  let stop = () => {};

  async function load(chip) {
    lastChip = chip;
    stop();
    const loading = skeletonGrid(12);
    body.replaceWith(loading);
    body = loading;
    let data;
    try {
      data = await api.home(chip);
    } catch (e) {
      if (!isCurrent()) return;
      const err = errorBox(`Couldn’t load your feed. ${e.message}`, () => load(chip));
      body.replaceWith(err);
      body = err;
      return;
    }
    if (!isCurrent() || lastChip !== chip) return;
    if (!chipsSlot.firstChild || chip === undefined) chipsSlot.replaceChildren(chipBar(data.chips, data.chip, (c) => load(c)));
    document.title = 'MPEG-YT';
    const grid = h('div', { class: 'grid' }, data.items.map((it) => videoCard(it)));
    body.replaceWith(grid);
    body = grid;
    stop = infinite(grid, data.next, (items) => grid.append(...items.map((it) => videoCard(it))));
  }

  await load(undefined);
  return () => stop();
}
