import { api } from '../api.js';
import { h, icon, videoRow, chipBar, skeletonList, errorBox, empty, infinite } from '../ui.js';

/**
 * Search results. YouTube's own filters (upload date, type, duration, features,
 * prioritize relevance/popularity) are applied server-side; "Upload date" and
 * "View count" sorting reorder the loaded results by their real dates and counts.
 */
const GROUPS = [
  { key: 'date', title: 'Upload date', options: [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']] },
  { key: 'type', title: 'Type', options: [['video', 'Video'], ['channel', 'Channel'], ['playlist', 'Playlist'], ['movie', 'Movie']] },
  { key: 'duration', title: 'Duration', options: [['under_three_mins', 'Under 3 minutes'], ['three_to_twenty_mins', '3 - 20 minutes'], ['over_twenty_mins', 'Over 20 minutes']] },
  { key: 'features', title: 'Features', options: [['live', 'Live'], ['4k', '4K'], ['hd', 'HD'], ['subtitles', 'Subtitles/CC'], ['creative_commons', 'Creative Commons']] },
  { key: 'sort', title: 'Sort by', options: [['', 'Relevance'], ['popularity', 'Popularity'], ['date', 'Upload date'], ['views', 'View count']] },
];

const QUICK = [
  { label: 'All', value: 'all' },
  { label: 'Videos', value: 'type=video' },
  { label: 'Channels', value: 'type=channel' },
  { label: 'Playlists', value: 'type=playlist' },
  { label: 'Live', value: 'features=live' },
  { label: 'Recently uploaded', value: 'date=week&sort=date' },
  { label: 'Most viewed', value: 'sort=views' },
  { label: 'Popular', value: 'sort=popularity' },
  { label: 'Over 20 minutes', value: 'duration=over_twenty_mins' },
];

export async function render({ view, params, app, isCurrent }) {
  const query = (params.get('search_query') || '').trim();
  if (!query) return void app.navigate('/', { replace: true });
  document.title = `${query} - MPEG-YT`;

  const f = {
    type: params.get('type') || '',
    date: params.get('date') || '',
    duration: params.get('duration') || '',
    features: params.get('features') || '',
    sort: params.get('sort') || '',
  };
  const setFilters = (patch) => {
    const next = new URLSearchParams({ search_query: query });
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) next.set(k, v);
    app.navigate(`/results?${next}`);
  };

  // Quick chips
  const activeQuick = QUICK.find((q) => q.value !== 'all' && q.value.split('&').every((kv) => {
    const [k, v] = kv.split('=');
    return f[k] === v;
  }) && Object.entries(f).filter(([, v]) => v).length === q.value.split('&').length)?.value || (Object.values(f).some(Boolean) ? null : 'all');
  const chips = chipBar(QUICK, activeQuick, (value) => {
    if (value === 'all') return setFilters({ type: '', date: '', duration: '', features: '', sort: '' });
    const patch = { type: '', date: '', duration: '', features: '', sort: '' };
    for (const kv of value.split('&')) {
      const [k, v] = kv.split('=');
      patch[k] = v;
    }
    setFilters(patch);
  });

  const activeCount = Object.values(f).filter(Boolean).length;
  const filtersBtn = h('button', { class: `pill filters-btn${activeCount ? ' on' : ''}`, type: 'button', 'aria-expanded': 'false' },
    icon('tune', 20), 'Filters', activeCount ? h('span', { class: 'count' }, activeCount) : null);
  const panel = h('div', { class: 'filters-panel', hidden: true }, GROUPS.map((g) =>
    h('div', { class: 'filter-group' },
      h('div', { class: 'filter-title' }, g.title),
      g.options.map(([value, label]) => {
        const on = g.key === 'features' ? f.features.split(',').includes(value) : (f[g.key] || '') === value;
        return h('button', {
          class: `filter-opt${on ? ' on' : ''}`,
          type: 'button',
          onclick: () => {
            if (g.key === 'features') {
              const set = new Set(f.features.split(',').filter(Boolean));
              if (set.has(value)) set.delete(value);
              else set.add(value);
              setFilters({ features: [...set].join(',') });
            } else setFilters({ [g.key]: on ? '' : value });
          },
        }, label, on && value ? icon('close', 16) : null);
      }))));
  filtersBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    filtersBtn.setAttribute('aria-expanded', String(!panel.hidden));
  });

  let list = skeletonList(6);
  const page = h('div', { class: 'results' }, h('div', { class: 'results-bar' }, chips, filtersBtn), panel, list);
  view.replaceChildren(page);

  let data;
  try {
    data = await api.search(query, {
      type: f.type,
      date: f.date,
      duration: f.duration,
      features: f.features,
      // "View count" sorting starts from YouTube's popularity ranking, then orders by count.
      prioritize: f.sort === 'popularity' || f.sort === 'views' ? 'popularity' : '',
    });
  } catch (e) {
    if (isCurrent()) list.replaceWith(errorBox(e.message, () => app.navigate(location.pathname + location.search, { replace: true })));
    return;
  }
  if (!isCurrent()) return;
  if (!data.items.length) {
    list.replaceWith(empty('No results found', 'Try different keywords or remove search filters.'));
    return;
  }

  const all = [...data.items];
  const sorter = f.sort === 'date' ? (a, b) => (a.age ?? Infinity) - (b.age ?? Infinity)
    : f.sort === 'views' ? (a, b) => (b.views ?? -1) - (a.views ?? -1)
      : null;
  const ordered = () => {
    if (!sorter) return all;
    // Channels and playlists stay on top; videos are ordered.
    const others = all.filter((i) => i.kind !== 'video');
    return [...others, ...all.filter((i) => i.kind === 'video').sort(sorter)];
  };
  const box = h('div', { class: 'list' }, ordered().map(videoRow));
  list.replaceWith(box);
  return infinite(box, data.next, (items) => {
    all.push(...items);
    if (sorter) box.replaceChildren(...ordered().map(videoRow));
    else box.append(...items.map(videoRow));
  });
}
