# LearnHarness — cloud image (LH_MODE=cloud; docs/cloud-mode.md, docs/deploy-fly.md).
#
# Two stages: build the Next standalone server (the same payload the
# desktop app ships, curated by scripts/build-server.mjs), then run it on
# a slim Node image with Debian's Chromium for the agent's headless pages
# (demo verification, figure fallback). Data lives on a mounted volume at
# /data; nothing user-specific is ever baked into the image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# --ignore-scripts: skips electron's postinstall binary download (the
# desktop shell is not part of this image). Native packages (canvas,
# resvg) ship prebuilt per-platform binaries as optional dependencies.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN npm run build && node scripts/build-server.mjs

FROM node:22-bookworm-slim AS run
# Chromium for headless pages; fonts so figures and demos render text;
# tini as PID 1 (reaps Chromium children, forwards signals).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji tini \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	LH_MODE=cloud \
	LH_DATA_DIR=/data \
	LH_AUTH_FILE=/data/auth.json \
	CHROME_PATH=/usr/bin/chromium \
	HOSTNAME=0.0.0.0 \
	PORT=8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY scripts/cloud-entrypoint.sh /usr/local/bin/cloud-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/cloud-entrypoint.sh"]
CMD ["node", "server.js"]
