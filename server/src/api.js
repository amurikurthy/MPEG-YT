'use strict';
const { HttpError } = require('./yt/account');

/**
 * REST API (all JSON):
 *   GET  /api/session                     sign-in state, account name/avatar, subscriptions for the sidebar
 *   GET  /api/home?chip=                  home feed (+ chips)
 *   GET  /api/search?q=&type=&date=&duration=&prioritize=&features=
 *   GET  /api/suggest?q=
 *   GET  /api/video/<id>                  watch page: details + Up next
 *   GET  /api/comments/<id>?sort=top|new
 *   GET  /api/channel/<id or @handle>?sort=Latest|Popular|Oldest
 *   GET  /api/feed/<subscriptions|history|watchlater|liked|playlists>
 *   GET  /api/playlist/<id>
 *   GET  /api/more/<token>                next page of any list above
 *   GET  /api/prefetch/<id>               warm stream resolution (hover)
 *   POST /api/action  {type, id}          like/dislike/unrate/subscribe/unsubscribe/watchlater/unwatchlater
 *   GET/POST /api/account/...             sign-in (see accountRoute)
 * POSTs must carry X-MPEG-YT: 1 - a custom header forces a CORS preflight, so other
 * sites can't trigger them with a plain form post.
 */
function createApi({ yt, streams, account, cfg }) {
  return async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop 'api'
    const q = url.searchParams;
    const [route, arg] = parts;
    try {
      if (req.method === 'POST' && req.headers['x-mpeg-yt'] !== '1') throw new HttpError(403, 'missing X-MPEG-YT header');

      switch (route) {
        case 'session': {
          const [me, guide] = await Promise.all([yt.me(), yt.guide()]);
          return json(res, 200, {
            ...account.status(),
            me,
            subscriptions: guide.subscriptions,
            stream: { bufferAhead: cfg.stream.bufferAhead },
          });
        }
        case 'home':
          return json(res, 200, await yt.home(q.get('chip') || undefined), 'private, max-age=60');
        case 'search': {
          const query = (q.get('q') || '').trim();
          if (!query) throw new HttpError(400, 'missing q');
          return json(res, 200, await yt.search(query, {
            type: q.get('type'),
            date: q.get('date'),
            duration: q.get('duration'),
            prioritize: q.get('prioritize'),
            features: (q.get('features') || '').split(',').filter(Boolean),
          }), 'private, max-age=60');
        }
        case 'suggest': {
          const query = (q.get('q') || '').trim();
          return json(res, 200, query ? await yt.suggest(query) : [], 'private, max-age=600');
        }
        case 'video':
          return json(res, 200, await yt.video(need(arg)), 'private, max-age=60');
        case 'comments':
          return json(res, 200, await yt.comments(need(arg), q.get('sort') === 'new' ? 'new' : 'top'));
        case 'channel':
          return json(res, 200, await yt.channel(need(arg), q.get('sort') || undefined), 'private, max-age=60');
        case 'feed':
          return json(res, 200, await yt.feed(need(arg)));
        case 'playlist':
          return json(res, 200, await yt.playlist(need(arg)));
        case 'more':
          return json(res, 200, await yt.more(need(arg)));
        case 'prefetch':
          streams.prefetch(need(arg));
          return json(res, 202, { ok: true });
        case 'action': {
          if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
          const body = JSON.parse((await readBody(req, 4096)) || '{}');
          return json(res, 200, await yt.action(String(body.type || ''), String(body.id || '')));
        }
        case 'account':
          return await accountRoute(account, req, res, parts.slice(1).join('/'));
        default:
          throw new HttpError(404, 'not found');
      }
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn(`[api] ${url.pathname}: ${e.message}`);
      return json(res, status, { error: e.message });
    }
  };
}

/**
 *   GET  /api/account                 status
 *   POST /api/account/login           start the in-app sign-in browser
 *   POST /api/account/login/finish    "Done" (also detected automatically)
 *   POST /api/account/login/cancel
 *   POST /api/account/cookies         body: Netscape cookies.txt
 *   POST /api/account/logout
 */
async function accountRoute(account, req, res, sub) {
  if (req.method === 'GET' && sub === '') return json(res, 200, account.status());
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  switch (sub) {
    case 'login': return json(res, 200, await account.startLogin());
    case 'login/finish': return json(res, 200, await account.finishLogin());
    case 'login/cancel': return json(res, 200, await account.cancelLogin());
    case 'cookies': return json(res, 200, await account.saveCookies(await readBody(req, 1024 * 1024)));
    case 'logout': return json(res, 200, await account.signOut());
    default: throw new HttpError(404, 'unknown account action');
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

function need(v) {
  if (!v) throw new HttpError(400, 'missing parameter');
  return v;
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
