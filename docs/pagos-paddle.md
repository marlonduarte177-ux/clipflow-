# Pagos con Paddle (planes y minutos)

Implementado el 08/10/2026. Reglas del negocio: ver [planes-y-creditos.md](planes-y-creditos.md).

## Cómo funciona

| | Prueba | Pro |
|---|---|---|
| Cobro | **1 USD** al empezar | **15 USD/mes** |
| Minutos | **60** durante 7 días | **600** cada mes |
| Después | pasa sola a Pro (salvo que cancele) | se renueva cada mes |

- **La web** (Cuenta → Suscripción, o `/dashboard/planes`) muestra los planes. Al tocar «Empezar prueba» se
  abre el pago de Paddle encima de la página (Paddle.js). ClipFlow nunca ve la tarjeta.
- **Paddle avisa a la API** (webhook `POST /billing/paddle-webhook`). La API comprueba la **firma** de cada
  aviso con la clave secreta y:
  - guarda la suscripción (estado, fecha de renovación, si se cancela al final del periodo);
  - con cada pago deja el saldo en **60** (prueba) o **600** (Pro). Los minutos **no se acumulan**;
  - si la suscripción termina (cancelada o sin pago), el saldo queda en 0.
  Los avisos repetidos no cargan minutos dos veces y los avisos viejos no pisan el estado nuevo.
- **Sin plan no se procesa:** la API responde «Necesitas un plan…» al subir, importar, crear clips o
  reintentar. La web muestra el enlace «Ver planes».
- **El procesador descuenta los minutos** del video (redondeado hacia arriba) apenas lo mide. Si no
  alcanzan: «Este video dura X min y te quedan Y min…». Si el procesamiento **falla o se cancela, los
  devuelve**. Volver a analizar un video ya pagado no cobra otra vez.
- **Eliminar la cuenta** con un plan que se sigue renovando no se permite: primero hay que cancelarlo.
- Los correos de `BILLING_FREE_EMAILS` (p. ej. el tuyo) no necesitan plan.

Mientras `BILLING_ENABLED` no sea `true`, **todo sigue como antes** (se procesa sin plan). Así se puede
desplegar y configurar Paddle con calma.

## Qué es secreto y qué no

| Valor | Dónde va | ¿Secreto? |
|---|---|---|
| Clave de los avisos (`pdl_ntfset_…`) | AWS Secrets Manager: `clipflow-staging/paddle-webhook-secret` | **Sí** |
| Correos exentos | GitHub → Environments → staging → **Secrets**: `BILLING_FREE_EMAILS` | Sí (no se muestra en los registros públicos) |
| Token de Paddle.js (`test_…` / `live_…`) | GitHub → Environments → staging → **Variables** | No (Paddle lo hace público a propósito) |
| Precios (`pri_…`), entorno, portal | GitHub → Environments → staging → **Variables** | No |

Nunca pegues la clave de los avisos ni la **API key** de Paddle en GitHub, en el código ni en un chat.
ClipFlow no necesita la API key de Paddle.

## Pasos (una vez). Empieza en **sandbox** (pruebas, sin dinero real)

1. **Despliega** (Actions → Deploy → staging). En el resumen del despliegue aparecen
   `PaddleWebhookUrl` (la dirección de los avisos) y `PaddleWebhookSecretName`.
2. Crea una cuenta en **sandbox-vendors.paddle.com**.
3. **Catalog → Products → New product** «ClipFlow Pro» con **dos precios**:
   - «Pro mensual»: 15 USD, **Recurring** cada 1 mes, sin prueba. Copia su id (`pri_…`).
   - «Pro con prueba»: 15 USD, **Recurring** cada 1 mes, **Trial 7 days**. Copia su id.
4. **Catalog → Products → New product** «Prueba ClipFlow 7 días» con un precio de **1 USD, One-time**.
   Copia su id.
5. **Developer tools → Authentication → Client-side tokens → New token**. Copia el token (`test_…`).
6. **Checkout → Checkout settings → Default payment link:** `https://clipflowia.com/dashboard/planes`.
   (En la cuenta real, Paddle además aprueba tu dominio en **Checkout → Website approval**.)
7. **Developer tools → Notifications → New destination:**
   - URL: el `PaddleWebhookUrl` del paso 1.
   - Eventos: `subscription.created`, `subscription.updated`, `subscription.activated`,
     `subscription.trialing`, `subscription.past_due`, `subscription.canceled`, `transaction.completed`.
   - Guarda y copia la **Secret key** (`pdl_ntfset_…`).
8. **AWS → Secrets Manager → `clipflow-staging/paddle-webhook-secret` → Retrieve secret value → Edit:**
   borra el valor de relleno y pega la Secret key del paso 7 (solo el texto, sin comillas).
9. **Portal de clientes** (cambiar tarjeta, facturas, cancelar): en Paddle, **Checkout → Customer portal**,
   copia el enlace.
10. **GitHub → Settings → Environments → staging:**
    - **Variables:** `PADDLE_ENVIRONMENT` = `sandbox`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PRO`,
      `PADDLE_PRICE_PRO_TRIAL`, `PADDLE_PRICE_TRIAL_FEE`, `PADDLE_PORTAL_URL`, y `BILLING_ENABLED` = `true`.
    - **Secrets:** `BILLING_FREE_EMAILS` = tu correo de ClipFlow (varios, separados por coma).
11. **Despliega otra vez** (Actions → Deploy → staging).
12. **Prueba** con otra cuenta de ClipFlow: Cuenta → Suscripción → «Empezar prueba por 1 USD», tarjeta de
    prueba `4242 4242 4242 4242`, cualquier fecha futura y CVC `100`. En unos segundos la página dice «Tu
    plan está activo» con 60 min. Revisa en Paddle → Transactions que se cobró **1 USD**.

## Pasar a cobros reales

Repite los pasos 3–10 en **vendors.paddle.com** (la cuenta real, ya aprobada por Paddle) y cambia
`PADDLE_ENVIRONMENT` a `production`. Los ids, el token y la clave de los avisos de la cuenta real son
distintos a los de sandbox. Despliega de nuevo.

## Si algo falla

- **El pago se hizo pero el plan no aparece:** la clave del paso 8 no coincide o el paso 7 tiene otra URL.
  En Paddle → Notifications → el destino → **Logs** se ve si la API respondió 401 (firma) o 503 (falta la
  clave). Paddle reintenta solo; al corregir la clave, usa **Replay** en esos avisos.
- **Diagnóstico** (Actions → Diagnóstico) muestra los avisos rechazados en «Errores de la API».
