"""Persistent yt-dlp worker for MPEG-YT.

Starting yt-dlp for every video costs ~2 s (Python start-up, imports, re-reading
YouTube's player code). This process stays loaded and answers requests over
stdin/stdout, one JSON object per line:

  -> {"id": 1, "url": "https://www.youtube.com/watch?v=..."}
  <- {"id": 1, "ok": true, "info": {...}}   or   {"id": 1, "ok": false, "error": "..."}

argv[1] is a JSON list of yt-dlp command-line options (the same ones the CLI
would get), parsed with yt-dlp's own parser so behaviour matches the CLI.
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


def options():
    _parser, _opts, _urls, ydl_opts = yt_dlp.parse_options(ARGS)
    ydl_opts.update(quiet=True, no_warnings=True, noprogress=True, skip_download=True, noplaylist=True)
    return ydl_opts


def ydl():
    # YoutubeDL instances aren't thread-safe; keep one per worker thread.
    if getattr(local, 'ydl', None) is None:
        local.ydl = yt_dlp.YoutubeDL(options())
    return local.ydl


def reply(obj):
    line = json.dumps(obj, separators=(',', ':'))
    with out_lock:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


def handle(msg):
    try:
        y = ydl()
        info = y.extract_info(msg['url'], download=False)
        out = {k: info.get(k) for k in INFO_FIELDS}
        out['formats'] = [{k: f.get(k) for k in FORMAT_FIELDS} for f in info.get('formats') or []]
        if y.params.get('cookiefile'):
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
