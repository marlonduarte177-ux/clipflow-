# Imagen de la API de ClipFlow. Se construye desde la RAÍZ del repositorio:
#   docker build -f backend/Dockerfile .
# (AWS CDK la construye y la sube a ECR automáticamente al desplegar.)

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
# Solo las dependencias de shared y backend (no las del frontend ni de CDK).
RUN npm ci -w @clipflow/shared -w @clipflow/backend
COPY shared shared
COPY backend backend
RUN npm run build -w @clipflow/shared && npm run build -w @clipflow/backend \
  && npm prune --omit=dev -w @clipflow/shared -w @clipflow/backend

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    # Certificados de Amazon RDS: permiten conectar a la base con TLS verificado.
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
WORKDIR /app
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem certs/rds-global-bundle.pem
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/shared/drizzle shared/drizzle
COPY --from=build /app/backend/package.json backend/
COPY --from=build /app/backend/dist backend/dist
# Nunca como root.
USER node
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]
