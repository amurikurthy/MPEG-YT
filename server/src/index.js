'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { createApi } = require('./api');
const { Account } = require('./yt/account');
const { Streams } = require('./yt/streams');
const { YouTube } = require('./yt/innertube');
const { handleStream, activeStreams } = require('./stream/session');
const { parseInput } = require('./login/browser-session');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

// ---------- auth (optional shared token) ----------

const tokenHash = cfg.authToken ? crypto.createHash('sha256').update(cfg.authToken).digest('hex') : '';
function authed(req, url) {
  if (!cfg.authToken) return true;
  const cookie = /(?:^|;\s*)mpegyt_auth=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (cookie && safeEq(cookie[1], tokenHash)) return true;
  const t = url.searchParams.get('token');
  return !!t && safeEq(crypto.createHash('sha256').update(t).digest('hex'), tokenHash);
}
function safeEq(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------- static files ----------

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.resolve(cfg.publicDir, '.' + rel);
  if (!file.startsWith(cfg.publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // App routes such as /@some.channel contain dots; anything that isn't a real
      // asset gets the app shell, which shows its own "not available" page.
      if (!/^\/(js|css|vendor|icons)\//.test(rel) && rel !== '/index.html') {
        return serveStatic(req, res, new URL('/', 'http://x'));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    };
    if (url.searchParams.get('token') && cfg.authToken && authed(req, url)) {
      headers['Set-Cookie'] = `mpegyt_auth=${tokenHash}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- boot ----------

function checkWritable(dir, purpose) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (e) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    console.warn(`[server] WARNING: ${dir} is not writable by uid ${uid} (${e.code || e.message}); ${purpose} will not work. ` +
      `Fix with: chown -R ${uid} <host folder mounted at ${dir}>`);
  }
}

async function main() {
  checkWritable(cfg.configDir, 'saving your sign-in');
  checkWritable(cfg.cacheDir, 'caching');
  let yt = null;
  let streams = null;
  const account = new Account(cfg, {
    // Sign-in changed: feeds, recommendations and stream access all depend on it.
    onChange: () => {
      yt?.reset();
      streams?.reset();
    },
  });
  await account.init();
  streams = new Streams(cfg, account);
  await streams.init().catch((e) => console.warn(`[streams] yt-dlp not available: ${e.message}`));
  yt = new YouTube(cfg, account);
  yt.session().catch((e) => console.warn(`[yt] could not reach YouTube yet: ${e.message}`));
  const api = createApi({ yt, streams, account, cfg });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, streams: activeStreams() }));
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      return api(req, res, url);
    }
    // Static UI files are public; everything with data lives behind /api.
    return serveStatic(req, res, url);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
      socket.destroy();
    };
    if (!authed(req, url)) return reject(401, 'Unauthorized');

    // Sign-in browser: /api/account/screen (video) and /api/account/input (events + status).
    const m = /^\/api\/account\/(screen|input)$/.exec(url.pathname);
    if (m) {
      const session = account.loginSession();
      if (!session || session.state !== 'running') return reject(409, 'Conflict');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        if (m[1] === 'screen') return session.addViewer(ws);
        session.addInputSocket(ws);
        ws.on('message', (data, isBinary) => {
          if (isBinary || data.length > 4096) return;
          const msg = parseInput(data.toString());
          if (msg) session.input(msg);
        });
      });
    }

    if (url.pathname !== '/api/stream') return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._socket.setNoDelay(true);
      handleStream(ws, url.searchParams, streams, cfg).catch((e) => {
        console.error('[stream]', e);
        ws.close(1011);
      });
    });
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`[server] listening on http://${cfg.host}:${cfg.port}`);
  });

  const shutdown = () => {
    wss.clients.forEach((c) => c.terminate());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
