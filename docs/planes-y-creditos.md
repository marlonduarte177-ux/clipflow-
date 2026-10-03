# Planes, minutos y descargas (decidido el 03/10/2026)

Se implementa **junto con la pasarela de pago**, antes del lanzamiento. Hasta entonces no hay
límites: staging sigue abierto para pruebas. No se cargarán minutos a mano.

## Cómo funciona

- **El plan** es lo que el cliente paga; **los minutos** (créditos) son lo que recibe y gasta.
- **1 crédito = 1 minuto de video.** El libro de créditos (`credit_ledger`) ya existe; `GET /me`
  devuelve `creditMinutes` y la página Cuenta lo muestra.

| | Prueba | Pro (mensual) |
|---|---|---|
| Precio | **1 USD por 7 días** | **15 USD/mes** |
| Minutos | **60 min** | **600 min** por mes |
| Al terminar | pasa solo a Pro, salvo que cancele | se renueva cada mes |

Reglas:
- **Los minutos no se acumulan** de un mes a otro.
- **Se descuentan los minutos del video** al crear clips. Si el procesamiento falla, se devuelven.
- **Volver a analizar con IA** un video que quedó sin análisis no vuelve a cobrar los minutos.
- **Sin plan activo no se procesa.** Así nadie abre cuentas gratis para gastar OpenAI.
- **Paquete extra** (opcional, por decidir): p. ej. 5 USD por 200 min.

## «Descargar solo el video»

- **No gasta minutos** (no usa OpenAI).
- **Pro: ilimitadas mientras no pasen por el proxy residencial (Evomi).** TikTok, Kick, Twitch y los
  enlaces directos bajan sin proxy, así que no tienen límite.
- **Las que sí pasan por Evomi** (cuando Instagram o Facebook bloquean al servidor) tienen un tope,
  porque Evomi se paga por GB. Por decidir: p. ej. 2 GB al mes por usuario.
- Prueba: mismo criterio, con un tope menor (por decidir).

## Costos de referencia

- ~0,01 USD por minuto de video (Whisper ~0,006 + GPT y servidor). Medido: 2,5 h ≈ 0,93 USD de OpenAI.
- Prueba: hasta ~0,60 USD de costo por 1 USD. Pro: hasta ~6 USD de costo por 15 USD.

## Pendiente

1. Elegir la pasarela. Stripe permite el cobro inicial de 1 USD con renovación automática, pero
   no está en todos los países; alternativas: Mercado Pago, Paddle, Lemon Squeezy.
2. Implementar: cobro y renovación (webhooks), carga de minutos por plan, descuento al procesar,
   bloqueo sin minutos, página de planes («Mejorar»), tope de descargas por Evomi.
