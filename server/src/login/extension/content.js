/* global readPage, chrome */
// Sends the current sign-in step to the MPEG-YT server (through background.js)
// whenever it changes, and answers its questions about where things are.
(() => {
  let last = '';
  const sig = (p) => JSON.stringify({ ...p, loading: undefined, fields: p.fields.map((f) => ({ ...f, value: undefined })) });
  const send = (force) => {
    let p;
    try {
      p = readPage();
    } catch (e) {
      return;
    }
    const s = sig(p);
    if (!force && s === last) return;
    last = s;
    chrome.runtime.sendMessage({ t: 'page', page: p }).catch(() => {});
  };
  const el = (ref) => document.querySelector(`[data-mpegyt-ref="${CSS.escape(String(ref))}"]`);

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m.t === 'read') {
      send(true);
      reply({});
    } else if (m.t === 'locate') {
      const e = el(m.ref);
      if (!e) return reply({ box: null });
      e.scrollIntoView({ block: 'center', inline: 'center' });
      // Wait a frame for the scroll, then report screen coordinates.
      requestAnimationFrame(() => {
        const r = e.getBoundingClientRect();
        // Browser chrome above/left of the page (app window: usually none).
        const top = window.outerHeight - window.innerHeight;
        const left = window.outerWidth - window.innerWidth;
        reply({
          box: { x: window.screenX + left + r.left, y: window.screenY + top + r.top, w: r.width, h: r.height },
          view: { x: r.left, y: r.top, w: r.width, h: r.height },
          checked: e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.getAttribute('aria-checked') === 'true',
        });
      });
      return true; // async reply
    } else if (m.t === 'select') {
      const e = el(m.ref);
      if (e && e.tagName === 'SELECT') {
        e.value = m.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      reply({});
    } else if (m.t === 'back') {
      history.back();
      reply({});
    }
    return false;
  });

  send(true);
  new MutationObserver(() => {
    clearTimeout(window.__mpegytT);
    window.__mpegytT = setTimeout(() => send(false), 120);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(() => send(false), 1000);
  // Keeps the background worker (and its connection to the server) awake.
  setInterval(() => chrome.runtime.sendMessage({ t: 'ping' }).catch(() => {}), 10_000);
})();
