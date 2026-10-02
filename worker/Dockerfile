# Imagen del procesador de video (Node.js + FFmpeg). Se construye desde la RAÍZ:
#   docker build -f worker/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app
# .npmrc: onnxruntime-node sin descargar binarios de GPU (solo CPU, que ya vienen en el paquete).
COPY package.json package-lock.json tsconfig.base.json .npmrc ./
COPY shared/package.json shared/
COPY worker/package.json worker/
RUN npm ci -w @clipflow/shared -w @clipflow/worker
COPY shared shared
COPY worker worker
RUN npm run build -w @clipflow/shared && npm run build -w @clipflow/worker \
  && npm prune --omit=dev -w @clipflow/shared -w @clipflow/worker
# El detector de caras solo necesita los binarios de Linux de esta arquitectura (~45 MB de ~290 MB).
RUN ort=node_modules/onnxruntime-node/bin/napi-v6 \
  && find "$ort" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
  && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} +

# Generador de "tokens de origen" (PO tokens) de YouTube para yt-dlp (bgutil-ytdlp-pot-provider,
# GPL-3.0; corre como programa aparte). Sin ese token YouTube responde 403 al descargar, aunque la
# IP sea residencial. Se actualiza cambiando BGUTIL_VERSION (igual en el plugin de abajo).
FROM node:22-bookworm-slim AS potoken
ARG BGUTIL_VERSION=2.0.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${BGUTIL_VERSION}" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
  && cd /opt/bgutil/server \
  && npm ci --no-audit --no-fund \
  && npx tsc \
  && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
# FFmpeg y, para importar videos por enlace, yt-dlp (versión fijada; se actualiza cambiando
# YTDLP_VERSION: las plataformas cambian seguido). Usa Node (ya instalado) para YouTube y
# curl-cffi para "parecerse" a un navegador real, que TikTok exige.
ARG YTDLP_VERSION=2026.8.19
ARG BGUTIL_VERSION=2.0.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]==${YTDLP_VERSION}" \
    "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}" \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    ORT_DISABLE_TELEMETRY=1 \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem \
    WORKER_TMP_DIR=/tmp/clipflow \
    YTDLP_POT_HOME=/opt/bgutil-pot \
    XDG_CACHE_HOME=/tmp/clipflow/.cache
COPY --from=potoken /opt/bgutil/server /opt/bgutil-pot
WORKDIR /app
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem certs/rds-global-bundle.pem
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/shared/drizzle shared/drizzle
COPY --from=build /app/worker/package.json worker/
COPY --from=build /app/worker/dist worker/dist
# Modelo del detector de caras (YuNet, MIT, ~230 KB).
COPY --from=build /app/worker/models worker/models
# Fuente de los subtítulos dibujados en el video (Montserrat ExtraBold, licencia OFL).
COPY --from=build /app/worker/fonts worker/fonts
RUN mkdir -p /tmp/clipflow && chown node:node /tmp/clipflow
USER node
CMD ["node", "worker/dist/main.js"]
