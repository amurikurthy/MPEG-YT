/* global chrome */
// Bridge between the sign-in page (content.js) and the MPEG-YT server, which
// listens on 127.0.0.1 for this browser only (address + key in config.json).
let ws = null;
let cfg = null;
let tabId = null;
const queue = [];

async function connect() {
  if (ws && ws.readyState <= 1) return;
  cfg = cfg || await (await fetch(chrome.runtime.getURL('config.json'))).json();
  ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/?key=${encodeURIComponent(cfg.key)}`);
  ws.onopen = () => {
    while (queue.length) ws.send(queue.shift());
  };
  ws.onclose = () => {
    ws = null;
    setTimeout(connect, 500);
  };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    let res = {};
    try {
      if (m.t === 'snap') res = { src: await snap(m.box) };
      else if (tabId != null) res = await chrome.tabs.sendMessage(tabId, m);
    } catch (e) {
      res = { error: String(e && e.message || e) };
    }
    if (m.id && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'reply', id: m.id, ...res }));
  };
}

function post(msg) {
  const s = JSON.stringify(msg);
  if (ws && ws.readyState === 1) ws.send(s);
  else {
    queue.push(s);
    if (queue.length > 5) queue.shift();
    connect();
  }
}

/** Picture of part of the page (captcha / QR code) as a PNG data URL. */
async function snap(box) {
  const shot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, Math.round(box.x), Math.round(box.y), w, h, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (sender.tab) tabId = sender.tab.id;
  if (m.t === 'page') post(m);
  else connect();
});
connect();
