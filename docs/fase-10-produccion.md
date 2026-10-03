# ClipFlow — Fase 10: Producción

Estado al 03/10/2026.

## Hecho

- **Dominio propio:** la web abre en `https://clipflowia.com` (Amplify). La API y S3 aceptan ese dominio
  (CORS en `infrastructure/lib/stage-config.ts`).
- **HTTPS** en la web y la API; **backups** diarios de la base de datos (7 días) y protección contra
  borrado en producción.
- **«Descargar solo el video» desactivado** para cumplir con la pasarela de pago
  (`FEATURES.downloadOnly`, ver `docs/importar-por-enlace.md`).

### Alertas por correo (stack `clipflow-<entorno>-monitoring`)

| Alarma | Cuándo avisa |
|---|---|
| `alert-jobs-failed` | Un trabajo de video falló 6 veces y quedó en la cola de errores. |
| `alert-openai-account` | OpenAI rechazó la clave o la cuenta no tiene saldo: los videos salen sin IA. |
| `alert-download-proxy` | El proxy de descargas (Evomi) no tiene saldo (402). |
| `alert-api-5xx` | La API respondió 10 o más errores 5xx en 5 minutos. |
| `alert-db-storage` | A la base de datos le quedan menos de 2 GB. |
| `alert-db-cpu` | La CPU de la base de datos lleva 15 minutos por encima del 80 %. |
| Presupuesto mensual | El gasto de AWS del mes pasa el 80 % y el 100 % del presupuesto, o se prevé que pase el 100 %. |

Las alarmas también avisan cuando vuelven a la normalidad («OK»).
- El correo y el presupuesto **no están en el código**: llegan de variables del environment de GitHub.
- Sin correo, las alarmas existen pero no avisan a nadie, y no se crea el presupuesto.
- El presupuesto es de **toda la cuenta de AWS**: configúralo en un solo entorno.
- OpenAI no está en AWS: además, pon un límite de gasto en platform.openai.com → Limits.

### Tope diario por usuario

Mientras no hay planes, cada usuario puede, en 24 h:
- mandar a crear clips **20 videos**;
- y que esos videos sumen **300 minutos** (5 h).

Al pasarse, la API responde 429 `daily_limit` con un mensaje claro. Se revisa al empezar una subida
(con la duración del archivo), al importar por enlace y en «Crear clips».
- Configurable con `DAILY_MAX_JOBS` y `DAILY_MAX_VIDEO_MINUTES`.
- Costo máximo aproximado por usuario y día: 300 min × ~0,01 USD = ~3 USD de OpenAI.

## Pasos manuales (una vez)

1. GitHub → **Settings → Environments → staging → Environment variables → Add variable**:
   - `ALERT_EMAIL`: el correo que recibirá las alertas.
   - `MONTHLY_BUDGET_USD`: el presupuesto mensual de AWS en dólares (por ejemplo `60`).
2. **Actions → Deploy → staging**.
3. Llegará un correo de **AWS Notifications** → **Confirm subscription**. Sin confirmar, no llegan alertas.

### Páginas legales (públicas)

- `/terminos`, `/privacidad` y `/reembolsos`, enlazadas desde el pie de la página de inicio, el registro
  («Al crear tu cuenta aceptas…») y la página Cuenta. Los datos (responsable, país, correo, precios y
  condiciones de reembolso) están en un solo lugar: `frontend/src/lib/legal.ts`.
- Responsable: Marlon Duarte, Costa Rica. Contacto: soporte@clipflowia.com.
- **Reembolso:** dentro de los 7 días del cobro, si se procesaron como máximo 15 minutos de video desde ese
  cobro. Los minutos de un procesamiento que falla se devuelven (se implementa con los planes).
- Incluyen el texto que pide Paddle como comerciante registrado (Merchant of Record).
- «Ayuda y soporte» y «Sugerir una función» abren un correo a soporte@clipflowia.com.

## Pendiente

- Revisar con Paddle si aceptan la política de 7 días / 15 minutos y si piden las páginas en inglés.
- **Entorno de producción separado** o usar el actual como producción (por decidir).
- **Planes y pagos** con Paddle (ver `docs/planes-y-creditos.md`).
