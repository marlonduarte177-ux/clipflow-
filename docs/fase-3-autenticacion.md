# ClipFlow — Fase 3: Autenticación

Estado: **código terminado y probado**. Falta desplegarlo en AWS: está bloqueado hasta que AWS
termine de verificar la cuenta y se completen los pasos de
[fase-3-pasos-aws-github.md](fase-3-pasos-aws-github.md).

## Qué se construyó

| Parte | Archivos | Qué hace |
|---|---|---|
| Cognito (infraestructura) | `infrastructure/lib/auth-stack.ts` | User pool: registro con email, verificación por código, contraseña fuerte (10+ caracteres, mayúsculas, minúsculas, números), recuperación por email. Cliente web sin secreto, login SRP, no revela si un email tiene cuenta. En producción está protegido contra borrado. |
| Páginas web | `frontend/src/app/(auth)/*` | `/registro`, `/verificar`, `/login`, `/recuperar` |
| Panel protegido | `frontend/src/app/dashboard`, `frontend/src/proxy.ts`, `frontend/src/lib/session.ts` | Sin sesión → redirige a `/login`. La sesión se comprueba dos veces: en el proxy y en el servidor. |
| Cerrar sesión | `frontend/src/components/sign-out-button.tsx` | Cierra la sesión en Cognito y limpia las cookies |
| API | `backend/src/auth.ts`, `backend/src/app.ts` | Verifica la firma, la expiración, el emisor y el cliente del token de Cognito. `GET /health` es público; `GET /me` está protegido. |
| Configuración central | `shared/src/product-config.ts` | Duraciones de clip, pesos del score y límites de subida en un solo lugar, cambiables por variables de entorno |
| CI | `.github/workflows/ci.yml` | En cada Pull Request: tipos, lint, tests, build del frontend y síntesis de CDK |
| Despliegue | `.github/workflows/deploy.yml` | Manual (Actions → Deploy), entra a AWS con OIDC y sin claves |

## Pruebas

29 tests automáticos, todos pasan (también en GitHub Actions, PR #1):

- **API (11):** sin token → 401; token mal formado o inválido → 401; token sin firmar (`alg: none`) → rechazado; token válido → devuelve el usuario; CORS solo para orígenes permitidos; configuración incompleta → error claro.
- **Infraestructura (6):** el user pool y el cliente tienen la configuración de seguridad esperada; producción protegida contra borrado.
- **Frontend (6):** no se puede redirigir a sitios externos tras el login (open redirect); los mensajes de error no revelan si un usuario existe.
- **Configuración (6):** valores por defecto, sobrescritura por entorno y rechazo de valores inválidos.

Prueba manual: `/dashboard` sin sesión responde con una redirección a `/login?next=/dashboard`.

## Errores encontrados durante el desarrollo (ya corregidos)

1. **Tipo del error en la API** (`backend/src/app.ts`): TypeScript no sabía que el error del manejador era un error de Fastify. Se declaró el tipo `FastifyError`.
2. **`LayoutProps` no encontrado** (`frontend/src/app/layout.tsx`): la plantilla de Next.js usa un tipo que solo existe después de compilar. Se reemplazó por el tipo explícito `{ children: ReactNode }`.

Ninguno llegó a GitHub: los detectó la verificación de tipos antes del commit.

## Qué falta para que funcione en AWS

1. Que AWS termine de verificar la cuenta.
2. Pasos A, B y C de [fase-3-pasos-aws-github.md](fase-3-pasos-aws-github.md).
3. GitHub → Actions → **Deploy** → `staging`. Crea Cognito y muestra el `UserPoolId` y el `UserPoolClientId`.
4. Publicar el frontend en Amplify Hosting con esos dos valores (se hará con pasos guiados).

Hasta entonces, las páginas muestran "La autenticación todavía no está configurada" en vez de
simular que funcionan.
