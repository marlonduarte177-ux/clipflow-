# Pagos con Polar (planes y minutos)

Cambiado de Paddle a Polar el 18/10/2026. Reglas del negocio: ver [planes-y-creditos.md](planes-y-creditos.md).

## Cómo funciona

| Plan | Precio | Minutos |
|---|---|---|
| **Prueba gratis** | **0 USD** por 7 días (pide tarjeta) | **60**. Al terminar pasa sola al Básico, salvo que se cancele antes |
| **Básico** | **9.99 USD/mes** | **200** cada mes |
| **Pro** | **19.99 USD/mes** | **400** cada mes |
| **Max** | **39.99 USD/mes** | **1000** cada mes |

La prueba es el Básico con 7 días gratis y solo se ofrece a quien nunca tuvo un plan. Pro y Max se
contratan directamente (se cobran desde el primer día).

- **La web** (Cuenta → Suscripción, o `/dashboard/planes`) muestra los planes. Al tocar «Empezar 7 días
  gratis» o «Elegir …», la API pide a Polar un enlace de pago (`POST /billing/checkout`) y la web abre la
  página de pago de Polar. ClipFlow nunca ve la tarjeta. Al pagar, Polar vuelve a
  `/dashboard/planes?pago=ok` y la página espera a que el plan aparezca activo.
- **Gestionar suscripción** (cambiar de plan o de tarjeta, facturas, cancelar) abre el portal de clientes
  de Polar (`POST /billing/portal`). Con un plan activo no se abre otro pago: se cambia desde ahí.
- **Polar avisa a la API** (webhook `POST /billing/polar-webhook`). La API comprueba la **firma** de cada
  aviso con la clave secreta y:
  - guarda la suscripción (estado, fecha de renovación, si se cancela al final del periodo);
  - al empezar la prueba deja el saldo en 60 min;
  - con cada pago de un plan (fin de la prueba, renovación o cambio de plan) deja el saldo en los minutos
    del plan (200, 400 o 1000). Los minutos **no se acumulan**;
  - si la suscripción termina (cancelada y vencida, o sin pago), el saldo queda en 0.
  - si cancela **durante la prueba**, la prueba termina en ese momento: el saldo queda en 0 y no vuelve
    aunque la reactive (los minutos del Básico llegan con el primer cobro). Así nadie usa los 60 min
    gratis y cancela antes de pagar. Puede contratar un plan pagado cuando quiera.
  Los avisos repetidos no cargan minutos dos veces y los avisos viejos no pisan el estado nuevo.
- **Sin plan no se procesa:** la API responde «Necesitas un plan…» al subir, importar, crear clips o
  reintentar. La web muestra el enlace «Ver planes».
- **Si los minutos no alcanzan, no empieza:** la web obliga a elegir un tramo más corto en «Duración del
  video» (ya viene marcado uno que alcanza) y la API lo vuelve a revisar antes de subir, importar,
  procesar o reintentar. Un video que falló por eso se reintenta eligiendo un tramo desde su página.
- **El procesador descuenta los minutos** del video (redondeado hacia arriba) apenas lo mide; si el
  procesamiento **falla o se cancela, los devuelve**.
- **Eliminar la cuenta** con un plan (o una prueba) que se sigue renovando no se permite: primero hay que
  cancelarlo.
- Los correos de `BILLING_FREE_EMAILS` (p. ej. el tuyo) no necesitan plan.

Mientras `BILLING_ENABLED` no sea `true`, **todo sigue como antes** (se procesa sin plan).

## Qué es secreto y qué no

| Valor | Dónde va | ¿Secreto? |
|---|---|---|
| Token de Polar (`polar_oat_…`) | AWS Secrets Manager: `clipflow-staging/polar-access-token` | **Sí** |
| Clave de los avisos de Polar | AWS Secrets Manager: `clipflow-staging/polar-webhook-secret` | **Sí** |
| Correos exentos | GitHub → Environments → staging → **Secrets**: `BILLING_FREE_EMAILS` | Sí (no sale en los registros públicos) |
| ID de cada producto, `POLAR_SERVER` | GitHub → Environments → staging → **Variables** | No |

Nunca pegues el token ni la clave de los avisos en GitHub, en el código ni en un chat.

## Pasos (una vez). Empieza en **sandbox** (pruebas, sin dinero real)

1. **Despliega** (Actions → Deploy → staging). En el resumen aparecen `PolarWebhookUrl` (la dirección de
   los avisos), `PolarAccessTokenSecretName` y `PolarWebhookSecretName`.
2. Entra a **sandbox.polar.sh** y crea tu organización de pruebas.
3. **Products → New Product.** Crea 3 productos, todos con precio fijo **recurrente mensual** en USD y
   **sin** periodo de prueba (la prueba de 7 días la agrega ClipFlow al Básico):

   | Producto | Precio | Variable de GitHub |
   |---|---|---|
   | ClipFlow Básico | 9.99 USD / mes | `POLAR_PRODUCT_BASIC` |
   | ClipFlow Pro | 19.99 USD / mes | `POLAR_PRODUCT_PRO` |
   | ClipFlow Max | 39.99 USD / mes | `POLAR_PRODUCT_MAX` |

   De cada producto copia su **ID** (en la lista de productos: «⋯» → *Copy Product ID*; tiene la forma
   `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
4. **Settings → Developers → New Token.** Nombre: `ClipFlow API`. Permisos (scopes): `checkouts:write` y
   `customer_sessions:write`. Sin vencimiento (o el más largo). Copia el token (`polar_oat_…`).
5. **AWS → Secrets Manager → `clipflow-staging/polar-access-token` → Retrieve secret value → Edit:**
   borra el valor de relleno y pega el token del paso 4 (solo el texto, sin comillas).
6. **Settings → Webhooks → Add Endpoint:**
   - URL: el `PolarWebhookUrl` del paso 1.
   - Format: **Raw**.
   - Secret: deja el que genera Polar y cópialo.
   - Eventos: `subscription.created`, `subscription.active`, `subscription.updated`,
     `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, `subscription.past_due`,
     `subscription.cycled` y `order.paid`.
7. **AWS → Secrets Manager → `clipflow-staging/polar-webhook-secret` → Edit:** pega el Secret del paso 6.
8. **GitHub → Settings → Environments → staging:**
   - **Variables:** `POLAR_SERVER` = `sandbox`, `POLAR_PRODUCT_BASIC`, `POLAR_PRODUCT_PRO`,
     `POLAR_PRODUCT_MAX` (los IDs del paso 3) y `BILLING_ENABLED` = `true`.
   - **Secrets:** `BILLING_FREE_EMAILS` = tu correo de ClipFlow (varios, separados por coma).
   - Las variables `PADDLE_…` ya no se usan: puedes borrarlas.
9. **Despliega otra vez** (Actions → Deploy → staging).
10. **Prueba** con otra cuenta de ClipFlow: Cuenta → Suscripción → «Empezar 7 días gratis», tarjeta de
    prueba `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC. Al volver, la página dice «Tu plan
    está activo» con 60 min y «Prueba gratis · En prueba».

## Pasar a cobros reales

Repite los pasos 3–8 en **polar.sh** (la cuenta real) y cambia `POLAR_SERVER` a `production`. Los IDs, el
token y la clave de los avisos de la cuenta real son distintos a los de sandbox. Despliega de nuevo.

## Si algo falla

- **«Disponible muy pronto» en los planes:** falta el token del paso 5 (o no empieza por `polar_oat_`), o
  falta algún ID de producto del paso 8. Un token o una clave nuevos pegados en Secrets Manager se usan
  solos en menos de un minuto (no hace falta desplegar). El token necesita los permisos `checkouts:write`
  y `customer_sessions:write`: sin ellos Polar responde `insufficient_scope` (se ve en el Diagnóstico).
- **El pago se hizo pero el plan no aparece:** la clave del paso 7 no coincide o el paso 6 tiene otra URL.
  En Polar → Settings → Webhooks → el endpoint se ve si la API respondió 403 (firma) o 503 (falta la clave).
  Al corregir la clave, reenvía esos avisos (*Redeliver*). Polar apaga el endpoint si falla
  muchas veces seguidas: vuelve a activarlo ahí mismo.
- **Diagnóstico** (Actions → Diagnóstico) muestra los valores de Polar que recibió la API y los avisos que
  llegaron.
