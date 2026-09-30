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

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    ORT_DISABLE_TELEMETRY=1 \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem \
    WORKER_TMP_DIR=/tmp/clipflow
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
RUN mkdir -p /tmp/clipflow && chown node:node /tmp/clipflow
USER node
CMD ["node", "worker/dist/main.js"]
