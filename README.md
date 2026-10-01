# ClipFlow

Web app que convierte videos largos en clips cortos para redes sociales.
Infraestructura en AWS (Amplify, API Gateway, ECS Fargate, RDS PostgreSQL, S3, SQS, Cognito, CloudWatch).

## Estado

En construcción por fases. Ver `docs/`:

- [Fase 1 — Auditoría](docs/fase-1-auditoria.md)
- [Fase 2 — Arquitectura](docs/fase-2-arquitectura.md)
- [Fase 3 — Autenticación](docs/fase-3-autenticacion.md) · [Pasos manuales AWS + GitHub](docs/fase-3-pasos-aws-github.md)
- [Fase 4 — Base de datos](docs/fase-4-base-de-datos.md)
- [Fase 5 — Subida de videos e infraestructura base](docs/fase-5-subida-videos.md)
- [Fases 6 y 7 — Cola de trabajos y procesador de video](docs/fase-6-7-procesamiento.md)
- [Fase 8 — Análisis con IA (OpenAI)](docs/fase-8-ia-openai.md)
- [Interfaz para celular y subtítulos en el video](docs/interfaz-movil.md)
- [Importar videos por enlace (con aviso de derechos de autor)](docs/importar-por-enlace.md)

## Estructura

| Carpeta | Qué contiene |
|---|---|
| `frontend/` | Web (Next.js): cuentas, proyectos, subida, progreso y resultados |
| `backend/` | API (Fastify) + `Dockerfile`: usuarios, proyectos, subida de videos a S3 |
| `worker/` | Procesador de video (Node.js + FFmpeg + OpenAI) + `Dockerfile`: clips 9:16, subtítulos y títulos |
| `shared/` | Configuración central, tipos, validaciones, esquema de base de datos y migraciones (`shared/drizzle/`) |
| `infrastructure/` | AWS CDK: Cognito, red, S3, RDS, SQS, worker y API (Fargate + API Gateway) |
| `docs/` | Documentación por fase |

## Comandos

```bash
npm install                      # instala todo el monorepo
cp .env.example .env             # variables locales (nunca subir .env)
docker compose up -d             # PostgreSQL local
npm run build -w @clipflow/shared
npm run db:migrate               # aplica las migraciones
npm test                         # tests de todos los paquetes (necesita PostgreSQL)
npm run typecheck && npm run lint
npm run dev:web                  # frontend en http://localhost:3000
npm run dev:api                  # API en http://localhost:4000
npm run dev:worker               # procesador de video (necesita FFmpeg instalado)
```

## Despliegue

GitHub → Actions → **Deploy** → Run workflow → `staging`.
Requiere los pasos de `docs/fase-3-pasos-aws-github.md`.
