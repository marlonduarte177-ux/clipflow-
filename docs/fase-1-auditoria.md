# ClipFlow — Fase 1: Auditoría del repositorio

Fecha: 2026-09-24 · Rama: `claude/clipflow-aws-audit-vwp1ob`

## Qué existe

| Elemento | Estado |
|---|---|
| Commits | 1 (`Initial commit`) |
| Archivos | Solo `README.md` (2 líneas: `# clipflow-` / `Web app`) |
| Código frontend / backend / workers | No existe |
| `package.json`, dependencias | No existen |
| Base de datos, migraciones | No existen |
| Infraestructura como código | No existe |
| `.gitignore`, `.env.example` | No existen |
| Tests, CI (GitHub Actions) | No existen |
| Secretos commiteados | Ninguno (verificado: el único archivo es el README) |

Conclusión: no es una landing page ni una demo; el repositorio está vacío.
No hay nada que borrar ni migrar. Se construye desde cero, sin deuda técnica.

## Contradicción detectada en los requisitos

- Sección 19: "NO hay apps móviles ... no dejes arquitectura pendiente para eso".
- Sección 23: pide separar una carpeta `mobile`.

Decisión: **no crear `mobile/`**. La web será responsive/mobile-first y se usa desde el
navegador del celular. Como la API es independiente del frontend, una app nativa futura
podría agregarse sin cambiar el backend.

## Proveedor de IA: OpenAI desde la primera versión

Decisión del usuario (cambia la regla original de "no OpenAI todavía"): OpenAI se usa
**desde la primera versión** para transcripción/subtítulos y detección de momentos.

- Se mantiene la interfaz `AIAnalysisProvider` para no acoplar el backend a OpenAI.
- `OpenAIProvider` es la implementación real; `MockAIProvider` queda solo para tests
  automáticos y desarrollo sin clave (nunca se muestra como resultado real al usuario).
- La clave de OpenAI vive en AWS Secrets Manager y solo la lee el worker
  (nunca el frontend, GitHub ni el chat).

## Decisiones técnicas propuestas (a confirmar en Fase 2)

| Área | Propuesta | Por qué |
|---|---|---|
| IA | Interfaz `AIAnalysisProvider`; `OpenAIProvider` desde la primera versión | Desacoplado; OpenAI se conecta sin reescribir |
| Lenguaje | TypeScript en todo (web, API, worker, infra) | Un solo lenguaje para aprender |
| Monorepo | npm workspaces | Sin herramientas extra |
| Frontend | Next.js en **AWS Amplify Hosting** | Soporta Next.js con SSR de forma administrada, HTTPS y dominio propio |
| API | Node.js (Fastify) en contenedor **ECS Fargate** detrás de **ALB** | Sin límites de tiempo de Lambda, mismo contenedor en local y en AWS |
| Worker de video | Contenedor con **FFmpeg** en **ECS Fargate**, consume **SQS** | Hasta 16 vCPU / 120 GB RAM / 200 GB disco efímero; sin límite de 15 min |
| Base de datos | **RDS PostgreSQL** + migraciones versionadas (Drizzle o Prisma) | Requisito; migraciones reproducibles |
| Archivos | **S3** privado con prefijos `originals/ tmp/ clips/ exports/ thumbnails/ subtitles/`, URLs firmadas, lifecycle para `tmp/` | Requisito |
| Cola | **SQS** + Dead Letter Queue | Reintentos y aislamiento de fallos |
| Auth | **Cognito User Pool** (email + verificación + recuperación) | Sin manejar contraseñas; Google se agrega después como IdP |
| Secretos | **Secrets Manager** (DB) + **SSM Parameter Store** (config) | Nada de secretos en Git ni en el frontend |
| Logs | **CloudWatch Logs** + alarmas (DLQ, errores 5xx) | Requisito |
| IaC | **AWS CDK (TypeScript)** | Mismo lenguaje que la app; genera CloudFormation reproducible |
| Dominio | Route 53 + ACM + CloudFront/Amplify, opcional | No bloquea el desarrollo |
| Local | Docker Compose: Postgres + LocalStack (S3/SQS); Cognito real de desarrollo | Desarrollar sin gastar en RDS/Fargate |

## Qué debe preparar el usuario (sin compartir secretos)

1. Cuenta de AWS (con tarjeta). Activar MFA en el usuario root.
2. Crear un presupuesto (AWS Budgets) con alerta por email.
3. Elegir región (propuesta: `us-east-1`).
4. Más adelante: conectar GitHub Actions a AWS con OIDC (sin claves de acceso).

## Plan de fases

1. Auditoría — este documento.
2. Arquitectura — diagrama, red (VPC), costos estimados, esqueleto del monorepo, `.gitignore`, `.env.example`.
3. Autenticación — Cognito + páginas registro/login/logout/recuperación + rutas protegidas.
4. Base de datos — esquema completo y migraciones.
5. S3 + upload — URLs firmadas, validación, progreso.
6. Cola de trabajos — SQS, estados, reintentos, idempotencia.
7. Worker FFmpeg — recortes, 9:16, thumbnails, subtítulos, subida a S3.
8. Análisis — interfaz `AIAnalysisProvider` + `OpenAIProvider` (transcripción, subtítulos, momentos), señales locales (picos de audio, cambios de escena) y score configurable.
9. Dashboard — todo conectado a la API real.
10. Producción — dominio, HTTPS, backups, límites, monitoreo.
11. Preparar pagos y email (sin implementarlos).
