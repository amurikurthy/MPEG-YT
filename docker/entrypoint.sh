#!/bin/sh
# Start as root only long enough to make the data folders usable, then run the
# app as an unprivileged user. Supports the common PUID/PGID convention so the
# files in bind-mounted folders (e.g. ./config) are owned by your host user.
set -e

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  [ "$PGID" = "$(id -g node)" ] || groupmod -o -g "$PGID" node
  [ "$PUID" = "$(id -u node)" ] || usermod -o -u "$PUID" node
  for d in "${CONFIG_DIR:-/config}" "${CACHE_DIR:-/cache}"; do
    mkdir -p "$d"
    # Bind mounts that Docker created on the host are owned by root.
    if [ "$(stat -c %u:%g "$d")" != "$PUID:$PGID" ] || [ -n "$(find "$d" -mindepth 1 ! -user "$PUID" -print -quit 2>/dev/null)" ]; then
      chown -R "$PUID:$PGID" "$d" 2>/dev/null || echo "[entrypoint] warning: could not change ownership of $d (read-only or network mount?)"
    fi
  done
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
fi

exec "$@"
