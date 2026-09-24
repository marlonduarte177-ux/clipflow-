# ClipFlow

Web app que convierte videos largos en clips cortos para redes sociales.
Infraestructura en AWS (Amplify, API Gateway, ECS Fargate, RDS PostgreSQL, S3, SQS, Cognito, CloudWatch).

## Estado

En construcción por fases. Ver `docs/`:

- [Fase 1 — Auditoría](docs/fase-1-auditoria.md)
- [Fase 2 — Arquitectura](docs/fase-2-arquitectura.md)

## Desarrollo local (se completa en las próximas fases)

```bash
cp .env.example .env        # rellenar valores (nunca subir .env)
docker compose up -d        # PostgreSQL local
```
