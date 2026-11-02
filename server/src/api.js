'use strict';
const { HttpError } = require('./providers/base');
const { PRESETS, USER_FPS } = require('./stream/transcoder');

/**
 * Provider-agnostic REST API. Every route is /api/p/<provider>/<action>[/<id>].
 * Responses are the normalized shapes documented in providers/base.js.
 */
function createApi(registry, cfg) {
  const routes = {
    home: (p) => p.home(),
    search: (p, _id, q) => {
      const query = (q.get('q') || '').trim();
      if (!query) throw new HttpError(400, 'missing q');
      return p.search(query, { page: q.get('page') });
    },
    suggest: (p, _id, q) => {
      const query = (q.get('q') || '').trim();
      return query ? p.suggest(query) : [];
    },
    item: (p, id) => p.item(need(id)),
    related: (p, id) => p.related(need(id)),
    collection: (p, id) => p.collection(need(id)),
  };

  return async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

    if (parts[1] === 'providers' && parts.length === 2) {
      return json(res, 200, {
        providers: registry.list(),
        stream: {
          defaultHeight: cfg.stream.defaultHeight,
          maxHeight: cfg.stream.maxHeight,
          bufferAhead: cfg.stream.bufferAhead,
          frameRates: USER_FPS,
          presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
        },
      }, 'public, max-age=60');
    }

    if (parts[1] !== 'p' || parts.length < 4) return json(res, 404, { error: 'not found' });
    const provider = registry.get(parts[2]);
    if (!provider) return json(res, 404, { error: 'unknown provider' });
    const action = parts[3];
    const id = parts[4] !== undefined ? decodeURIComponent(parts.slice(4).join('/')) : undefined;

    try {
      if (action === 'account') return await accountRoute(provider, req, res, parts.slice(4));
      if (action === 'thumb') {
        const t = await provider.thumbnail(need(id));
        if (!t) return json(res, 404, { error: 'no thumbnail' });
        res.writeHead(200, { 'Content-Type': t.type, 'Cache-Control': 'public, max-age=86400' });
        if (Buffer.isBuffer(t.body)) return res.end(t.body);
        return t.body.pipe(res);
      }
      const fn = routes[action];
      if (!fn) return json(res, 404, { error: 'unknown action' });
      const data = await fn(provider, id, url.searchParams);
      return json(res, 200, data, action === 'suggest' ? 'private, max-age=300' : 'private, max-age=60');
    } catch (e) {
      const status = e.status || 502;
      if (status >= 500) console.warn(`[api] ${provider.id}/${action}: ${e.message}`);
      return json(res, status, { error: e.message });
    }
  };
}

/**
 * Account routes (only for providers implementing account()):
 *   GET  /api/p/<id>/account                 status
 *   POST /api/p/<id>/account/login           start the in-app sign-in browser
 *   POST /api/p/<id>/account/login/finish    "I'm signed in" (also detected automatically)
 *   POST /api/p/<id>/account/login/cancel
 *   POST /api/p/<id>/account/cookies         body: Netscape cookies.txt
 *   POST /api/p/<id>/account/logout
 * POSTs must carry X-MPEG-YT: 1 - a custom header forces a CORS preflight, so other
 * sites can't trigger these with a plain form post.
 */
async function accountRoute(provider, req, res, rest) {
  if (typeof provider.account !== 'function') return json(res, 404, { error: 'accounts not supported' });
  const sub = rest.join('/');
  if (req.method === 'GET' && sub === '') {
    const login = provider.loginSession?.();
    return json(res, 200, { ...provider.account(), login: login ? login.status() : null });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (req.headers['x-mpeg-yt'] !== '1') return json(res, 403, { error: 'missing X-MPEG-YT header' });
  switch (sub) {
    case 'login': return json(res, 200, await provider.startLogin());
    case 'login/finish': return json(res, 200, await provider.finishLogin());
    case 'login/cancel': return json(res, 200, await provider.cancelLogin());
    case 'cookies': return json(res, 200, await provider.saveCookies(await readBody(req, 1024 * 1024)));
    case 'logout': return json(res, 200, await provider.signOut());
    default: return json(res, 404, { error: 'unknown account action' });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function need(id) {
  if (!id) throw new HttpError(400, 'missing id');
  return id;
}

function json(res, status, body, cache = 'no-store') {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': cache,
  });
  res.end(data);
}

module.exports = { createApi };
