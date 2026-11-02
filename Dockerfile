# MPEG-YT: native YouTube browser UI; video is transcoded to MPEG-1/MP2 and streamed
# over WebSocket to a JSMpeg WebGL canvas.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
      # in-app "Sign in with Google": a temporary browser on a virtual display
      chromium xvfb xauth xdotool fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (with its YouTube JS-challenge solver) in an isolated venv. It uses the
# bundled Node.js as its JavaScript runtime (--js-runtimes node).
# Rebuild the image regularly: YouTube changes often and yt-dlp follows.
ARG YTDLP_VERSION=
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]${YTDLP_VERSION:+==$YTDLP_VERSION}" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src ./server/src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# The entrypoint starts as root, fixes ownership of /config and /cache (bind mounts
# are often created root-owned), then drops to PUID:PGID (default 1000:1000).
RUN mkdir -p /config /cache && chown -R node:node /cache /config

ENV PORT=8080 \
    CACHE_DIR=/cache \
    CONFIG_DIR=/config \
    NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/src/index.js"]
