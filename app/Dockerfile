# 48tools 2.0.0
# Multi-stage build: compile the public/admin web app, then run the Node service.

ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS client-builder
ENV NODE_ENV=development
WORKDIR /app/client
ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY client/package*.json ./
RUN npm ci --include=dev --no-audit --no-fund --registry="$NPM_REGISTRY"

COPY client/ ./
RUN npm run build

FROM public.ecr.aws/docker/library/python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS backup115-python

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="48tools" \
      org.opencontainers.image.version="2.0.0" \
      description="48tools 2.0.0 - private recording hub with public live playback"
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv libgomp1 ca-certificates \
    ffmpeg \
    chromium \
    tini \
    fonts-noto-cjk \
    fonts-liberation \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

# 封面渲染（cover-render.py）依赖一个独立的小型 python venv；ASR 已随 2.0.0 移除。
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY server/cover-requirements.txt /tmp/cover-requirements.txt
RUN python3 -m venv /opt/cover-venv && /opt/cover-venv/bin/pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /tmp/cover-requirements.txt

COPY --from=backup115-python /usr/local/ /opt/backup115-python/
COPY server/modules/backup115/requirements.lock.txt /tmp/backup115-requirements.lock.txt
RUN /opt/backup115-python/bin/python3.12 -m venv /opt/backup115 \
    && /opt/backup115/bin/python -m pip install --no-cache-dir --index-url "$PIP_INDEX_URL" --require-hashes -r /tmp/backup115-requirements.lock.txt
ENV BACKUP115_PYTHON=/opt/backup115/bin/python

ENV NODE_ENV=production \
    PORT=3000 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY"

COPY server/ ./
RUN rm -rf /app/client/dist
COPY --from=client-builder /app/client/dist /app/client/dist
COPY config/ /app/config-defaults/
COPY VERSION /app/VERSION
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /app/config /app/data /app/recordings /app/biliup

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/public/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
