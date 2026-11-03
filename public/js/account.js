/* global JSMpeg */
import { h, icon, toast } from './ui.js';

// Account UI: status sheet, cookies.txt upload, and the in-app sign-in browser
// (a server-side Chromium streamed to a canvas through JSMpeg's live mode).

const enc = encodeURIComponent;
const base = () => '/api/account';

async function call(_unused, path = '', { method = 'GET', body } = {}) {
  const r = await fetch(base() + path, {
    method,
    body,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'X-MPEG-YT': '1', 'Content-Type': 'text/plain' },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function wsUrl(path) {
  const tok = new URLSearchParams(location.search).get('token');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}${tok ? `?token=${enc(tok)}` : ''}`;
}

const provider = { name: 'YouTube' };

/**
 * Sign-in sheet.
 * @param {(account) => void} onChange  called after sign-in / sign-out
 */
export function openSignIn(onChange) {
  const pid = null;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onEsc);

  const body = h('div', { class: 'sheet-body' }, h('div', { class: 'spinner small' }));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${provider.name} account` },
    h('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Close', onclick: close }, '×'),
    body);
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() }, sheet);
  document.body.append(overlay);

  const render = (acct, message) => {
    const err = message ? h('p', { class: 'sheet-error' }, message) : null;
    if (acct.signedIn) {
      body.replaceChildren(...[
        h('div', { class: 'sheet-icon on' }, icon('account', 34)),
        h('h2', {}, `Signed in to ${provider.name}`),
        h('p', { class: 'muted' }, 'Your recommendations, subscriptions, Watch later and liked videos appear on the home page.'),
        err,
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'pill', type: 'button', onclick: async () => {
            try {
              const a = await call(pid, '/logout', { method: 'POST' });
              onChange(a);
              render(a);
            } catch (e) {
              render(acct, e.message);
            }
          } }, 'Sign out')),
      ].filter(Boolean));
      return;
    }

    const file = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const a = await call(pid, '/cookies', { method: 'POST', body: await f.text() });
        onChange(a);
        render(a);
      } catch (e) {
        render(acct, e.message);
      }
    });

    body.replaceChildren(...[
      h('div', { class: 'sheet-icon' }, icon('account', 34)),
      h('h2', {}, `Sign in to ${provider.name}`),
      h('p', { class: 'muted' }, 'See your own recommendations, subscriptions, Watch later and liked videos.'),
      err,
      h('div', { class: 'sheet-actions col' },
        acct.methods.includes('browser')
          ? h('button', { class: 'pill primary big', type: 'button', onclick: () => { close(); openSignInBrowser(onChange); } }, 'Sign in with Google')
          : null,
        acct.methods.includes('cookies')
          ? h('button', { class: 'link-btn', type: 'button', onclick: () => file.click() }, 'Or upload a cookies.txt file')
          : null,
        file),
      h('p', { class: 'fine' }, 'Sign-in happens in a private browser on your MPEG-YT server; only the resulting YouTube session is kept. Signing out deletes it.'),
    ].filter(Boolean));
  };

  call(pid).then((a) => render(a)).catch((e) => render({ signedIn: false, methods: [] }, e.message));
}

/** Full-screen remote sign-in browser. */
export async function openSignInBrowser(onChange) {
  const pid = null;
  const canvas = h('canvas', { class: 'remote-canvas', tabindex: '-1' });
  const status = h('div', { class: 'remote-status' }, h('div', { class: 'spinner small' }), 'Starting secure sign-in browser…');
  const typer = h('input', {
    class: 'remote-typer', type: 'text', placeholder: 'Tap here to type', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Type into the sign-in page',
  });
  const keyBtn = (label, key, aria) => h('button', { class: 'pill small', type: 'button', 'aria-label': aria || label, onclick: () => send({ t: 'key', key }) }, label);
  const doneBtn = h('button', { class: 'pill primary small', type: 'button' }, 'Done');
  const cancelBtn = h('button', { class: 'pill small', type: 'button' }, 'Cancel');

  const stage = h('div', { class: 'remote-stage' }, canvas, status);
  const root = h('div', { class: 'remote', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Sign in to ${provider.name}` },
    h('header', { class: 'remote-bar' },
      h('div', { class: 'remote-title' }, h('strong', {}, `Sign in to ${provider.name}`), h('span', { class: 'muted' }, 'Google sign-in, running on your server')),
      cancelBtn, doneBtn),
    stage,
    h('footer', { class: 'remote-keys' },
      typer,
      keyBtn('Tab', 'Tab'), keyBtn('⌫', 'Backspace', 'Backspace'), keyBtn('Enter', 'Enter'), keyBtn('‹ Back', 'Alt+ArrowLeft', 'Go back')));
  document.body.append(root);
  document.body.classList.add('no-scroll');

  let player = null;
  let input = null;
  let poll = null;
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    try { player && player.destroy(); } catch { /* ignore */ }
    try { input && input.close(); } catch { /* ignore */ }
    root.remove();
    document.body.classList.remove('no-scroll');
  };
  const showStatus = (text, { spin = false, retry = false } = {}) => {
    status.replaceChildren(...[
      spin ? h('div', { class: 'spinner small' }) : null,
      h('span', {}, text),
      retry ? h('button', { class: 'pill primary small', type: 'button', onclick: () => { teardown(); openSignInBrowser(onChange); } }, 'Try again') : null,
    ].filter(Boolean));
    status.hidden = false;
  };
  const succeed = async () => {
    const a = await call(pid).catch(() => null);
    if (a && a.signedIn) {
      teardown();
      onChange(a);
      toast(`Signed in to ${provider.name}`);
    }
  };

  cancelBtn.addEventListener('click', async () => {
    teardown();
    await call(pid, '/login/cancel', { method: 'POST' }).catch(() => {});
  });
  doneBtn.addEventListener('click', async () => {
    showStatus('Saving your session…', { spin: true });
    try {
      const r = await call(pid, '/login/finish', { method: 'POST' });
      if (r.state === 'error') showStatus(r.error || 'Sign-in failed.', { retry: true });
      else await succeed();
    } catch (e) {
      showStatus(e.message, { retry: true });
    }
  });

  let session;
  try {
    session = await call(pid, '/login', { method: 'POST' });
  } catch (e) {
    showStatus(`Couldn't start sign-in: ${e.message}`, { retry: true });
    return;
  }
  if (closed) return;
  stage.style.setProperty('--ar', `${session.width} / ${session.height}`);

  // Screen: JSMpeg in its standard low-latency live mode.
  player = new JSMpeg.Player(wsUrl(`${base(pid)}/screen`), {
    canvas,
    audio: false,
    pauseWhenHidden: false,
    videoBufferSize: 2 * 1024 * 1024,
    onVideoDecode: () => { if (!status.dataset.sticky) status.hidden = true; },
  });

  // Input + status channel.
  input = new WebSocket(wsUrl(`${base(pid)}/input`));
  input.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'finishing') { status.dataset.sticky = '1'; showStatus('Signed in - saving your session…', { spin: true }); }
    else if (m.t === 'done') succeed();
    else if (m.t === 'error') showStatus(m.error || 'Sign-in failed.', { retry: true });
  };
  // Backup in case the status message is missed.
  poll = setInterval(succeed, 4000);

  function send(m) {
    if (input && input.readyState === WebSocket.OPEN) input.send(JSON.stringify(m));
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  // Pointer: mouse is forwarded live; touch becomes tap (click) or drag (scroll).
  let touch = null;
  let lastMove = 0;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse') return send({ t: 'down', b: e.button === 2 ? 3 : 1, ...pos(e) });
    touch = { x: e.clientX, y: e.clientY, acc: 0, scrolling: false, p: pos(e) };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      const t = performance.now();
      if (t - lastMove > 30) { lastMove = t; send({ t: 'move', ...pos(e) }); }
      return;
    }
    if (!touch) return;
    const dy = e.clientY - touch.y;
    if (!touch.scrolling && Math.abs(dy) > 10) touch.scrolling = true;
    if (touch.scrolling) {
      // Finger up = scroll down, like native scrolling. One wheel notch per ~36px.
      touch.acc += touch.y - e.clientY;
      touch.y = e.clientY;
      const steps = Math.trunc(touch.acc / 36);
      if (steps) {
        touch.acc -= steps * 36;
        send({ t: 'wheel', dy: steps });
      }
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return send({ t: 'up', b: e.button === 2 ? 3 : 1, ...pos(e) });
    if (touch && !touch.scrolling) {
      send({ t: 'move', ...touch.p });
      send({ t: 'down', b: 1, ...touch.p });
      send({ t: 'up', b: 1, ...touch.p });
      // Tapping a text field on the page: raise the on-screen keyboard via our input.
      setTimeout(() => typer.focus({ preventScroll: true }), 50);
    }
    touch = null;
  });
  canvas.addEventListener('pointercancel', () => { touch = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const steps = Math.max(1, Math.round(Math.abs(e.deltaY) / 60)) * Math.sign(e.deltaY);
    if (steps) send({ t: 'wheel', dy: steps });
  }, { passive: false });

  // Typing: text goes through as text (works with soft keyboards, IMEs and paste);
  // navigation keys go through as keys. The field is cleared immediately.
  typer.addEventListener('input', () => {
    const v = typer.value;
    if (v) send({ t: 'text', s: v });
    typer.value = '';
  });
  typer.addEventListener('keydown', (e) => {
    const special = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (e.isComposing) return;
    let key = e.key;
    if (key === 'Tab' && e.shiftKey) key = 'Shift+Tab';
    if (special.includes(e.key) && !typer.value) {
      e.preventDefault();
      send({ t: 'key', key });
    }
  });
  typer.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) {
      e.preventDefault();
      send({ t: 'text', s: text.slice(0, 512) });
    }
  });
  setTimeout(() => typer.focus({ preventScroll: true }), 300);
}
