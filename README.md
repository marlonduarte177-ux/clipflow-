# ClipFlow

Web app que convierte videos largos en clips cortos para redes sociales.
Infraestructura en AWS (Amplify, API Gateway, ECS Fargate, RDS PostgreSQL, S3, SQS, Cognito, CloudWatch).

## Estado

En construcción por fases. Ver `docs/`:

- [Fase 1 — Auditoría](docs/fase-1-auditoria.md)
- [Fase 2 — Arquitectura](docs/fase-2-arquitectura.md)
- [Fase 3 — Autenticación](docs/fase-3-autenticacion.md) · [Pasos manuales AWS + GitHub](docs/fase-3-pasos-aws-github.md)

## Estructura

| Carpeta | Qué contiene |
|---|---|
| `frontend/` | Web (Next.js): landing, registro, login, recuperación, panel |
| `backend/` | API (Fastify): valida tokens de Cognito |
| `shared/` | Configuración central (duraciones de clip, pesos del score, límites) y tipos |
| `infrastructure/` | AWS CDK: Cognito (más servicios en las próximas fases) |
| `docs/` | Documentación por fase |

## Comandos

```bash
npm install                      # instala todo el monorepo
npm run build -w @clipflow/shared
npm test                         # tests de todos los paquetes
npm run typecheck && npm run lint
cp .env.example .env             # variables locales (nunca subir .env)
npm run dev:web                  # frontend en http://localhost:3000
npm run dev:api                  # API en http://localhost:4000
docker compose up -d             # PostgreSQL local (desde la Fase 4)
```

## Despliegue

GitHub → Actions → **Deploy** → Run workflow → `staging`.
Requiere los pasos de `docs/fase-3-pasos-aws-github.md`.
