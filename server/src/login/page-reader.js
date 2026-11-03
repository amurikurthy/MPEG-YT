'use strict';

/**
 * Reads whatever sign-in step the page is showing into a plain description the
 * app renders as a native form. Deliberately generic: no Google class names or
 * ids, only what the page exposes for screen readers (headings, labelled inputs,
 * buttons, alert regions). Steps it can't describe (an embedded challenge, a
 * page with nothing actionable) are flagged so the app falls back to the live
 * browser view.
 *
 * Runs inside the page (the bridge extension's content script), so it must be
 * self-contained.
 */
function readPage() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  window.__mpegytRef = window.__mpegytRef || 0;
  const refOf = (el) => {
    if (!el.dataset.mpegytRef) el.dataset.mpegytRef = String(++window.__mpegytRef);
    return el.dataset.mpegytRef;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.hidden || p.inert || p.getAttribute('aria-hidden') === 'true') return false;
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return false;
    }
    const r = el.getBoundingClientRect();
    // Multi-step pages slide old steps out sideways; those are off-screen.
    return r.width >= 2 && r.height >= 2 && r.right > 0 && r.left < W && r.bottom > -H && r.top < H * 3;
  };
  const textOfIds = (ids) => clean((ids || '').split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
  const labelOf = (el) => clean(
    el.getAttribute('aria-label')
    || textOfIds(el.getAttribute('aria-labelledby'))
    || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText)
    || el.closest('label')?.innerText
    || el.getAttribute('placeholder')
    || el.getAttribute('title')
    || el.getAttribute('name'));

  // Page chrome that isn't part of the step: footer links, language picker.
  const isChrome = (el) => !!el.closest('footer, [role=contentinfo], nav, [role=navigation], header [role=banner]')
    || /^(help|privacy|terms|english.*|language)$/i.test(clean(el.innerText || el.getAttribute('aria-label')));

  const out = {
    url: location.href,
    host: location.host,
    title: document.title,
    heading: '',
    text: [],
    errors: [],
    fields: [],
    buttons: [],
    images: [],
    needsBrowser: null,
    loading: false,
  };

  if (/^chrome-error:/.test(location.href) || document.documentElement.id === 't' && document.querySelector('#main-frame-error')) {
    out.errors.push(clean(document.body?.innerText).slice(0, 300) || 'The sign-in page could not be loaded.');
    out.pageError = true;
    return out;
  }

  const h = [...document.querySelectorAll('h1, [role=heading][aria-level="1"], h2')].find(visible);
  out.heading = clean(h?.innerText);

  // Errors: alert / live regions, and descriptions of invalid fields.
  const errs = new Set();
  for (const el of document.querySelectorAll('[role=alert], [aria-live=assertive]')) {
    if (visible(el) && clean(el.innerText)) errs.add(clean(el.innerText));
  }
  for (const el of document.querySelectorAll('[aria-invalid=true]')) {
    const t = textOfIds(el.getAttribute('aria-describedby') || el.getAttribute('aria-errormessage'));
    if (t) errs.add(t);
  }
  errs.delete(out.heading);
  out.errors = [...errs].slice(0, 4);

  // Fields.
  const inputs = document.querySelectorAll('input, textarea, select, [role=combobox]:not(input)');
  for (const el of inputs) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type) || !visible(el) || el.disabled) continue;
    if (isChrome(el)) continue;
    const f = { ref: refOf(el), label: labelOf(el), required: el.required || el.getAttribute('aria-required') === 'true' };
    if (type === 'checkbox' || type === 'radio' || el.getAttribute('role') === 'checkbox') {
      Object.assign(f, { kind: type === 'radio' ? 'radio' : 'checkbox', checked: !!el.checked || el.getAttribute('aria-checked') === 'true', name: el.name || '' });
      // Google styles checkboxes with a visually-hidden input; the label sits next to it.
      if (!f.label) f.label = clean(el.parentElement?.parentElement?.innerText);
    } else if (el.tagName === 'SELECT') {
      Object.assign(f, { kind: 'select', value: el.value, options: [...el.options].map((o) => ({ value: o.value, label: clean(o.text) })) });
    } else if (el.getAttribute('role') === 'combobox') {
      continue; // custom dropdowns: browser view
    } else {
      const ac = el.getAttribute('autocomplete') || '';
      const kind = type === 'password' ? 'password'
        : type === 'email' || /username|email/.test(ac) ? 'email'
          : type === 'tel' || el.inputMode === 'numeric' || el.inputMode === 'tel' || /one-time-code/.test(ac) ? 'code'
            : 'text';
      Object.assign(f, { kind, value: kind === 'password' ? '' : el.value, maxLength: el.maxLength > 0 ? el.maxLength : undefined, autocomplete: ac });
    }
    out.fields.push(f);
  }
  out.fields = out.fields.slice(0, 12);

  // Images worth showing: captchas, QR codes (not logos or avatars).
  for (const img of document.querySelectorAll('img')) {
    if (!visible(img)) continue;
    const r = img.getBoundingClientRect();
    if (/captcha|qr/i.test(`${img.id} ${img.alt} ${img.src}`) && r.width > 60) {
      // key: a new picture (e.g. a refreshed captcha) counts as a change.
      out.images.push({ ref: refOf(img), key: (img.currentSrc || img.src).slice(-80), alt: clean(img.alt) || 'Image', w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  // Embedded challenges (reCAPTCHA etc.) can't become a form.
  const frame = [...document.querySelectorAll('iframe')].find((f) => visible(f) && f.getBoundingClientRect().height > 60);
  if (frame) out.needsBrowser = 'This step has to be completed in the browser view.';

  // Buttons and choices.
  const PRIMARY = /^(next|continue|verify|sign in|done|confirm|yes|i agree|agree|accept|send|submit|allow|save|try again|get code|turn on|ok)$/i;
  const seen = new Set();
  const clickables = document.querySelectorAll('button, [role=button], [role=link], a[href], [role=radio], [role=option], [role=menuitem], [data-challengetype], li[tabindex]');
  for (const el of clickables) {
    if (!visible(el) || isChrome(el) || el.matches('input, label') || el.getAttribute('aria-disabled') === 'true' || el.disabled) continue;
    // Skip wrappers whose clickable child is listed instead, and things inside fields.
    if (el.querySelector('input:not([type=hidden])')) continue;
    if ([...seen].some((s) => s.contains(el) || el.contains(s))) {
      // Keep the outermost clickable (the row), drop nested pieces.
      const inner = [...seen].find((s) => el.contains(s));
      if (!inner) continue;
      seen.delete(inner);
      out.buttons = out.buttons.filter((b) => b.ref !== inner.dataset.mpegytRef);
    }
    const label = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
    if (!label || label.length > 200) continue;
    // Help articles would navigate away from the sign-in.
    if (/^learn more/i.test(label) || /support\.google\.com/.test(el.getAttribute('href') || '')) continue;
    // Audio challenges can't be played through the form.
    if (/^(listen|play)\b|audio/i.test(label)) continue;
    seen.add(el);
    const lines = (el.innerText || label).split('\n').map(clean).filter(Boolean);
    const option = el.matches('[role=radio], [role=option], [data-challengetype], li *, li') || lines.length > 1 || label.length > 32;
    out.buttons.push({
      ref: refOf(el),
      label: lines[0] || label,
      detail: lines.slice(1, 3).join(' · '),
      kind: PRIMARY.test(label) ? 'primary' : option ? 'option' : 'button',
    });
  }
  out.buttons = out.buttons.slice(0, 16);

  // Remaining text of the step (instructions, number-match digits, the account email...).
  const skip = new Set([...seen, h].filter(Boolean));
  const texts = [];
  const blocks = document.querySelectorAll('h2, h3, p, span, div, li, strong, b, samp, figcaption');
  for (const el of blocks) {
    if (texts.length >= 10) break;
    // Leaf-ish blocks only: their own text, not a container of other blocks.
    if (el.querySelector('p, div, li, button, input, h1, h2')) continue;
    const t = clean(el.innerText);
    if (!t || t.length > 400 || !visible(el) || isChrome(el)) continue;
    if ([...skip].some((s) => s.contains(el)) || el.closest('label, [role=alert], [aria-live=assertive], button, a, [role=button], [role=link]')) continue;
    if (t === out.heading || out.errors.includes(t) || out.fields.some((f) => f.label === t) || texts.includes(t)) continue;
    // (A lone number is shown big - e.g. the number to tap on your phone.)
    if (!/^\d{1,3}$/.test(t) && texts.some((x) => x.includes(t))) continue;
    if (/guest mode/i.test(t)) continue; // advice for shared computers, not this browser
    texts.push(t.replace(/\s*Learn more$/i, ''));
  }
  out.text = texts;

  const actionable = out.fields.length || out.buttons.some((b) => b.kind !== 'button' || /another way|back|cancel|skip/i.test(b.label));
  out.loading = out.loading || (!out.heading && !actionable && !out.text.length);
  if (!out.loading && !actionable && !out.text.length && !out.needsBrowser) out.needsBrowser = 'This step isn’t supported in the form.';
  return out;
}

module.exports = { readPage, readerScript: `/* generated from page-reader.js */\nconst readPage = ${readPage.toString()};\n` };
