import { api } from '../api.js';
import { h, href, card, fmt, skeletonRows, errorBox, icon } from '../ui.js';
import { history } from '../state.js';
import { CanvasPlayer } from '../player.js';

const AUTOPLAY_DELAY = 6;

export async function render({ ctx, pid, id, params, view, isCurrent, provider }) {
  // Start the stream immediately; metadata fills in around it.
  const resume = params.has('t') ? +params.get('t') : 0;
  const playerMount = h('div', { class: 'player-wrap' });
  const info = h('div', { class: 'watch-info' }, h('div', { class: 'line skeleton-text', style: { width: '70%', height: '28px' } }));
  const side = h('aside', { class: 'watch-side' }, provider.capabilities.related ? skeletonRows(8) : null);
  view.replaceChildren(h('div', { class: 'watch' }, h('div', { class: 'watch-main' }, playerMount, info), side));

  let detail = null;
  let related = [];
  let countdown = null;

  const player = new CanvasPlayer(playerMount, {
    pid,
    id,
    startAt: resume,
    streamCfg: ctx.stream,
    onProgress: (pos, dur) => detail && history.save(pid, detail, pos, dur),
    onEnded: () => showEndScreen(),
  });

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (player.handleKey(e)) e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  function showEndScreen() {
    if (detail) history.save(pid, detail, 0, detail.duration);
    const next = related.find((r) => r.kind === 'video');
    const el = player.endScreen;
    if (!next) return;
    let left = AUTOPLAY_DELAY;
    const label = h('span', {}, `Up next in ${left}`);
    el.replaceChildren(h('div', { class: 'up-next' },
      label,
      h('a', { class: 'up-next-card', href: href.watch(pid, next.id) },
        next.thumbnail ? h('img', { src: next.thumbnail, alt: '' }) : null,
        h('div', {}, h('strong', {}, next.title), h('div', { class: 'sub' }, next.subtitle || ''))),
      h('div', { class: 'up-next-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { clearInterval(countdown); el.hidden = true; } }, 'Cancel'),
        h('a', { class: 'btn', href: href.watch(pid, next.id) }, icon('next', 18), ' Play now'))));
    el.hidden = false;
    clearInterval(countdown);
    countdown = setInterval(() => {
      left -= 1;
      label.textContent = `Up next in ${left}`;
      if (left <= 0) {
        clearInterval(countdown);
        if (isCurrent()) location.hash = href.watch(pid, next.id);
      }
    }, 1000);
  }

  const cleanup = () => {
    clearInterval(countdown);
    document.removeEventListener('keydown', onKey);
    player.destroy();
  };

  // Metadata
  api.item(pid, id).then((d) => {
    if (!isCurrent()) return;
    detail = d;
    document.title = `${d.title} · MPEG-YT`;
    player.setDetail(d);
    renderInfo(info, pid, d);
  }).catch((e) => {
    if (isCurrent()) info.replaceChildren(errorBox(`Couldn't load details: ${e.message}`));
  });

  // Related
  if (provider.capabilities.related) {
    api.related(pid, id).then((items) => {
      if (!isCurrent()) return;
      related = items;
      if (!items.length) return side.replaceChildren();
      side.replaceChildren(h('h3', {}, 'Up next'), h('div', { class: 'rows' }, items.map((it) => card(pid, it, { layout: 'row' }))));
    }).catch(() => isCurrent() && side.replaceChildren());
  }

  return cleanup;
}

function renderInfo(el, pid, d) {
  const facts = [fmt.views(d.views), d.published ? new Date(d.published).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '', d.likes ? `${fmt.compact(d.likes)} likes` : '']
    .filter(Boolean).join(' · ');
  const channel = d.subtitleRef
    ? h('a', { class: 'channel', href: href.collection(pid, d.subtitleRef.id) }, d.subtitle)
    : d.subtitle ? h('span', { class: 'channel' }, d.subtitle) : null;

  const extra = d.extra ? Object.entries(d.extra).filter(([, v]) => v) : [];
  const desc = (d.description || '').trim();
  const descEl = desc ? h('div', { class: 'desc collapsed' }, linkify(desc)) : null;
  const toggle = desc && desc.length > 240
    ? h('button', { class: 'link-btn', type: 'button', onclick: (e) => {
      const c = descEl.classList.toggle('collapsed');
      e.target.textContent = c ? 'Show more' : 'Show less';
    } }, 'Show more')
    : null;
  if (descEl && !toggle) descEl.classList.remove('collapsed');

  el.replaceChildren(...[
    h('h1', { class: 'watch-title' }, d.title),
    h('div', { class: 'watch-meta' }, channel, facts ? h('span', { class: 'facts' }, facts) : null),
    extra.length ? h('div', { class: 'chips' }, extra.map(([k, v]) => h('span', { class: 'chip' }, h('b', {}, k), ' ', v))) : null,
    descEl ? h('div', { class: 'desc-box' }, descEl, toggle) : null,
  ].filter(Boolean));
}

/** Turn URLs in plain text into links, without ever interpreting text as HTML. */
function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"')]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
