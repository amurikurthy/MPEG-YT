"""Persistent yt-dlp worker for MPEG-YT.

Starting yt-dlp for every video costs ~2 s (Python start-up, imports, re-reading
YouTube's player code). This process stays loaded and answers requests over
stdin/stdout, one JSON object per line:

  -> {"id": 1, "url": "https://www.youtube.com/watch?v=...", "avoid": ["WEB_EMBEDDED_PLAYER"]}
  <- {"id": 1, "ok": true, "info": {...}}   or   {"id": 1, "ok": false, "error": "..."}

argv[1] is a JSON list of yt-dlp command-line options (the same ones the CLI
would get), parsed with yt-dlp's own parser so behaviour matches the CLI.

"avoid" lists YouTube client names (the c= parameter of stream links) whose
links YouTube has been refusing; the yt-dlp clients behind them are excluded
for that request (player_client=default,-<client>...).

"fast": true asks only yt-dlp's "visionos" client, without cookies: it needs no
JavaScript challenge solving and answers in ~1 s instead of ~3 s. The caller
falls back to a normal request when that doesn't give a playable result.
"""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

ARGS = json.loads(sys.argv[1])
FORMAT_FIELDS = (
    'format_id', 'url', 'protocol', 'vcodec', 'acodec', 'height', 'width', 'fps', 'tbr', 'abr',
    'asr', 'http_headers', 'format_note', 'language_preference', 'filesize', 'filesize_approx', 'ext',
)
INFO_FIELDS = ('id', 'title', 'duration', 'live_status', 'is_live')

out_lock = threading.Lock()
cookie_lock = threading.Lock()
local = threading.local()


def client_keys(names):
    """yt-dlp client keys for InnerTube client names, e.g. WEB_EMBEDDED_PLAYER -> web_embedded."""
    try:
        from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS
    except Exception:  # noqa: BLE001 - layout differs between versions
        return []
    wanted = set(names)
    return sorted(k for k, v in INNERTUBE_CLIENTS.items()
                  if not k.startswith('_') and v.get('INNERTUBE_CONTEXT', {}).get('client', {}).get('clientName') in wanted)


def without_cookies(args):
    out = []
    skip = False
    for a in args:
        if skip:
            skip = False
            continue
        if a in ('--cookies', '--cookies-from-browser'):
            skip = True
            continue
        out.append(a)
    return out


def options(avoid, fast=False):
    args = list(ARGS)
    if fast:
        args = without_cookies(args) + ['--extractor-args', 'youtube:player_client=visionos']
    # The user's own player_client choice (YTDLP_EXTRA_ARGS) wins.
    elif avoid and not any('player_client' in a for a in args):
        keys = client_keys(avoid)
        if keys:
            args += ['--extractor-args', 'youtube:player_client=' + ','.join(['default'] + ['-' + k for k in keys])]
    _parser, _opts, _urls, ydl_opts = yt_dlp.parse_options(args)
    ydl_opts.update(quiet=True, no_warnings=True, noprogress=True, skip_download=True, noplaylist=True)
    return ydl_opts


def ydl(avoid, fast=False):
    # YoutubeDL instances aren't thread-safe; keep one per worker thread (and client set).
    key = ('fast',) if fast else tuple(sorted(avoid))
    cache = getattr(local, 'ydls', None)
    if cache is None:
        cache = local.ydls = {}
    if key not in cache:
        cache[key] = yt_dlp.YoutubeDL(options(key, fast))
    return cache[key]


def reply(obj):
    line = json.dumps(obj, separators=(',', ':'))
    with out_lock:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


def handle(msg):
    try:
        fast = bool(msg.get('fast'))
        y = ydl([str(a) for a in msg.get('avoid') or []][:8], fast)
        info = y.extract_info(msg['url'], download=False)
        out = {k: info.get(k) for k in INFO_FIELDS}
        out['formats'] = [{k: f.get(k) for k in FORMAT_FIELDS} for f in info.get('formats') or []]
        if y.params.get('cookiefile') and not fast:
            # YouTube rotates cookies; persist them like the CLI does on exit.
            with cookie_lock:
                try:
                    y.cookiejar.save()
                except Exception:
                    pass
        reply({'id': msg['id'], 'ok': True, 'info': out})
    except Exception as e:  # noqa: BLE001 - every failure goes back to the caller
        reply({'id': msg['id'], 'ok': False, 'error': str(e)})


def main():
    pool = ThreadPoolExecutor(max_workers=3)
    reply({'ready': True, 'version': yt_dlp.version.__version__})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, msg)


if __name__ == '__main__':
    main()
