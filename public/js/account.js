/* global JSMpeg */
import { h, icon, toast } from './ui.js';

// Account UI: status sheet, cookies.txt upload, and in-app sign-in. Sign-in runs
// in a private Chromium on the server: its steps are shown here as a native form
// (openSignInForm); the live browser view (openSignInBrowser, streamed through
// JSMpeg) is the fallback for steps a form can't show.

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
          ? h('button', { class: 'pill primary big', type: 'button', onclick: () => { close(); openSignInForm(onChange); } }, 'Sign in with Google')
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


/**
 * Native sign-in form. The server reads each step of Google's sign-in page
 * (heading, text, fields, buttons, errors) and this renders it; what the user
 * enters is typed into the real page on the server.
 */
export async function openSignInForm(onChange) {
  const body = h('div', { class: 'signin-body' }, h('div', { class: 'signin-wait' }, h('div', { class: 'spinner small' }), h('span', {}, 'Starting secure sign-in…')));
  const browserLink = h('button', { class: 'link-btn', type: 'button' }, 'Use browser view');
  const cancelBtn = h('button', { class: 'link-btn', type: 'button' }, 'Cancel');
  const card = h('div', { class: 'signin-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Sign in to ${provider.name}` },
    h('div', { class: 'signin-brand' }, h('img', { src: '/logo.svg', alt: '', width: 29, height: 20 }), h('span', {}, 'Sign in with Google')),
    body,
    h('div', { class: 'signin-foot' }, browserLink, cancelBtn));
  const root = h('div', { class: 'signin' }, card);
  document.body.append(root);
  document.body.classList.add('no-scroll');

  let ws = null;
  let closed = false;
  let page = null;
  let shape = '';
  let busy = false;
  let busyTimer = null;
  let inBrowser = false;
  let autoBrowserFor = '';
  const values = new Map(); // what the user typed, by field ref (survives re-renders)

  const teardown = () => {
    if (closed) return;
    closed = true;
    clearTimeout(busyTimer);
    try { ws && ws.close(); } catch { /* ignore */ }
    root.remove();
    document.body.classList.remove('no-scroll');
  };
  const message = (text, { spin = false, retry = false } = {}) => {
    shape = '';
    body.replaceChildren(h('div', { class: 'signin-wait' }, ...[
      spin ? h('div', { class: 'spinner small' }) : null,
      h('span', {}, text),
      retry ? h('button', { class: 'pill primary small', type: 'button', onclick: () => { teardown(); openSignInForm(onChange); } }, 'Try again') : null,
    ].filter(Boolean)));
  };
  const succeed = async () => {
    const a = await call(null, '').catch(() => null);
    if (a && a.signedIn) {
      teardown();
      onChange(a);
      toast(`Signed in to ${provider.name}`);
    }
    return a;
  };
  const setBusy = (on) => {
    busy = on;
    clearTimeout(busyTimer);
    card.classList.toggle('busy', on);
    for (const b of body.querySelectorAll('button, input, select')) b.disabled = on;
    if (on) busyTimer = setTimeout(() => setBusy(false), 15_000);
  };
  const send = (m) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(m));
    setBusy(true);
  };

  const openBrowser = (reason) => {
    if (inBrowser) return;
    inBrowser = true;
    openSignInBrowser(onChange, {
      embedded: true,
      note: reason,
      onBack: () => { inBrowser = false; },
      onSignedIn: () => teardown(),
    });
  };
  browserLink.addEventListener('click', () => openBrowser());
  cancelBtn.addEventListener('click', async () => {
    teardown();
    await call(null, '/login/cancel', { method: 'POST' }).catch(() => {});
  });

  const submit = (ref) => {
    const fields = page.fields.map((f) => {
      const v = values.get(f.ref);
      if (f.kind === 'checkbox' || f.kind === 'radio') return { ref: f.ref, checked: v === undefined ? f.checked : !!v };
      return { ref: f.ref, value: v === undefined ? (f.value || '') : String(v) };
    });
    send({ t: 'form', fields, submit: ref || 'enter' });
  };

  const render = (pg) => {
    page = pg;
    const nextShape = JSON.stringify({ ...pg, loading: undefined, fields: pg.fields.map((f) => ({ ...f, value: undefined })) });
    setBusy(false);
    if (nextShape === shape) return; // same step: keep focus and what's typed
    shape = nextShape;

    // A step the form can't show (embedded puzzle etc.): straight to the browser view.
    if (pg.needsBrowser && autoBrowserFor !== nextShape) {
      autoBrowserFor = nextShape;
      openBrowser(pg.needsBrowser);
    }
    if (pg.loading) return message('Loading…', { spin: true });

    const primary = pg.buttons.find((b) => b.kind === 'primary');
    const options = pg.buttons.filter((b) => b.kind === 'option');
    const others = pg.buttons.filter((b) => b.kind === 'button');
    let firstInput = null;

    const fieldEl = (f) => {
      if (f.kind === 'checkbox' || f.kind === 'radio') {
        const box = h('input', { type: 'checkbox' });
        box.checked = values.has(f.ref) ? !!values.get(f.ref) : f.checked;
        // Applied right away: some steps (e.g. "check your phone") have nothing to submit.
        box.addEventListener('change', () => {
          values.set(f.ref, box.checked);
          send({ t: 'form', fields: [{ ref: f.ref, checked: box.checked }], submit: null });
        });
        return h('label', { class: 'signin-check' }, box, h('span', {}, f.label));
      }
      if (f.kind === 'select') {
        const sel = h('select', { class: 'signin-input', 'aria-label': f.label },
          ...f.options.map((o) => h('option', { value: o.value }, o.label)));
        sel.value = values.has(f.ref) ? values.get(f.ref) : f.value;
        sel.addEventListener('change', () => values.set(f.ref, sel.value));
        return h('label', { class: 'signin-field' }, h('span', {}, f.label), sel);
      }
      const attrs = {
        class: 'signin-input',
        'aria-label': f.label,
        placeholder: ' ',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocorrect: 'off',
        enterkeyhint: 'next',
      };
      if (f.kind === 'password') Object.assign(attrs, { type: 'password', autocomplete: 'current-password' });
      else if (f.kind === 'email') Object.assign(attrs, { type: 'email', autocomplete: 'username', inputmode: 'email' });
      else if (f.kind === 'code') Object.assign(attrs, { type: 'text', autocomplete: 'one-time-code', inputmode: /phone|number/i.test(f.label) && !/code/i.test(f.label) ? 'tel' : 'numeric' });
      else Object.assign(attrs, { type: 'text', autocomplete: 'off' });
      if (f.maxLength) attrs.maxlength = f.maxLength;
      const input = h('input', attrs);
      input.value = values.has(f.ref) ? values.get(f.ref) : (f.value || '');
      input.addEventListener('input', () => values.set(f.ref, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (!busy) submit(primary && primary.ref);
        }
      });
      if (!firstInput && !input.value) firstInput = input;
      const wrap = h('label', { class: 'signin-field' }, input, h('span', { class: 'signin-label' }, f.label || 'Enter text'));
      if (f.kind === 'password') {
        const eye = h('button', { class: 'signin-eye', type: 'button', 'aria-label': 'Show password' }, 'Show');
        eye.addEventListener('click', (e) => {
          e.preventDefault();
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          eye.textContent = show ? 'Hide' : 'Show';
        });
        wrap.append(eye);
      }
      return wrap;
    };

    body.replaceChildren(...[
      h('h2', { class: 'signin-title' }, pg.heading || 'Sign in'),
      ...pg.text.map((t) => h('p', { class: /^\d{1,3}$/.test(t) ? 'signin-big' : 'signin-text' }, t)),
      ...pg.images.filter((i) => i.src).map((i) => h('img', { class: 'signin-img', src: i.src, alt: i.alt, width: i.w, height: i.h })),
      pg.errors.length ? h('div', { class: 'signin-error', role: 'alert' }, icon('error', 18), h('span', {}, pg.errors.join(' '))) : null,
      pg.fields.length ? h('div', { class: 'signin-fields' }, ...pg.fields.map(fieldEl)) : null,
      options.length ? h('div', { class: 'signin-options' }, ...options.map((b) => h('button', { class: 'signin-option', type: 'button', onclick: () => send({ t: 'click', ref: b.ref }) },
        h('span', { class: 'signin-option-label' }, b.label), b.detail ? h('span', { class: 'signin-option-detail' }, b.detail) : null))) : null,
      h('div', { class: 'signin-actions' },
        h('div', { class: 'signin-secondary' }, ...others.map((b) => h('button', { class: 'link-btn', type: 'button', onclick: () => send({ t: 'click', ref: b.ref }) }, b.label))),
        primary || pg.fields.some((f) => f.kind !== 'checkbox' && f.kind !== 'radio')
          ? h('button', { class: 'pill primary signin-next', type: 'button', onclick: () => submit(primary && primary.ref) }, primary ? primary.label : 'Next')
          : null),
    ].filter(Boolean));
    if (firstInput && !inBrowser && matchMedia('(hover: hover)').matches) firstInput.focus({ preventScroll: true });
  };

  let session;
  try {
    session = await call(null, '/login', { method: 'POST' });
  } catch (e) {
    return message(`Couldn't start sign-in: ${e.message}`, { retry: true });
  }
  if (closed) return;
  if (session.state === 'error') return message(session.error || 'Sign-in failed.', { retry: true });

  ws = new WebSocket(wsUrl(`${base()}/input`));
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'page') render(m.page);
    else if (m.t === 'finishing') message('Signed in - saving your session…', { spin: true });
    else if (m.t === 'done') succeed();
    else if (m.t === 'error') message(m.error || 'Sign-in failed.', { retry: true });
  };
  ws.onclose = async () => {
    if (closed) return;
    const a = await succeed();
    if (!closed && !(a && a.signedIn)) {
      const st = a && a.login;
      message(st && st.error ? st.error : 'The sign-in session ended.', { retry: true });
    }
  };
  // If the page reader never reports (very old/odd browser builds), offer the browser view.
  setTimeout(() => { if (!closed && !page) message('The sign-in page is taking a while…', { spin: true }); }, 12_000);
  setTimeout(() => { if (!closed && !page) openBrowser('Showing the sign-in browser instead.'); }, 20_000);
}

/**
 * Full-screen remote sign-in browser.
 * opts.embedded: opened from the form - "Back" returns there instead of cancelling.
 */
export async function openSignInBrowser(onChange, opts = {}) {
  const pid = null;
  const canvas = h('canvas', { class: 'remote-canvas', tabindex: '-1' });
  const status = h('div', { class: 'remote-status' }, h('div', { class: 'spinner small' }), 'Starting secure sign-in browser…');
  const typer = h('input', {
    class: 'remote-typer', type: 'text', placeholder: 'Tap here to type', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Type into the sign-in page',
  });
  const keyBtn = (label, key, aria) => h('button', { class: 'pill small', type: 'button', 'aria-label': aria || label, onclick: () => send({ t: 'key', key }) }, label);
  const doneBtn = h('button', { class: 'pill primary small', type: 'button' }, 'Done');
  const cancelBtn = h('button', { class: 'pill small', type: 'button' }, opts.embedded ? 'Back to form' : 'Cancel');

  const stage = h('div', { class: 'remote-stage' }, canvas, status);
  const root = h('div', { class: 'remote', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Sign in to ${provider.name}` },
    h('header', { class: 'remote-bar' },
      h('div', { class: 'remote-title' }, h('strong', {}, `Sign in to ${provider.name}`), h('span', { class: 'muted' }, opts.note || 'Google sign-in, running on your server')),
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
      if (opts.onSignedIn) opts.onSignedIn();
      onChange(a);
      toast(`Signed in to ${provider.name}`);
    }
  };

  cancelBtn.addEventListener('click', async () => {
    teardown();
    if (opts.embedded) return opts.onBack && opts.onBack();
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
