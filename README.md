# ClipFlow

Web app que convierte videos largos en clips cortos para redes sociales.
Infraestructura en AWS (Amplify, API Gateway, ECS Fargate, RDS PostgreSQL, S3, SQS, Cognito, CloudWatch).

## Estado

En construcción por fases. Ver `docs/`:

- [Fase 1 — Auditoría](docs/fase-1-auditoria.md)
- [Fase 2 — Arquitectura](docs/fase-2-arquitectura.md)
- [Fase 3 — Autenticación](docs/fase-3-autenticacion.md) · [Pasos manuales AWS + GitHub](docs/fase-3-pasos-aws-github.md)
- [Fase 4 — Base de datos](docs/fase-4-base-de-datos.md)

## Estructura

| Carpeta | Qué contiene |
|---|---|
| `frontend/` | Web (Next.js): landing, registro, login, recuperación, panel |
| `backend/` | API (Fastify): valida tokens de Cognito, usuarios y proyectos |
| `shared/` | Configuración central, tipos, validaciones, esquema de base de datos y migraciones (`shared/drizzle/`) |
| `infrastructure/` | AWS CDK: Cognito (más servicios en las próximas fases) |
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
```

## Despliegue

GitHub → Actions → **Deploy** → Run workflow → `staging`.
Requiere los pasos de `docs/fase-3-pasos-aws-github.md`.
