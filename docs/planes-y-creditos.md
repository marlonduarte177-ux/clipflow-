# Planes, minutos y descargas (decidido el 03/10/2026)

**Implementado con Paddle** (08/10/2026): ver [pagos-paddle.md](pagos-paddle.md). Se activa con
`BILLING_ENABLED=true`; hasta entonces no hay límites. No se cargan minutos a mano.

## Cómo funciona

- **El plan** es lo que el cliente paga; **los minutos** (créditos) son lo que recibe y gasta.
- **1 crédito = 1 minuto de video.** El libro de créditos (`credit_ledger`) ya existe; `GET /me`
  devuelve `creditMinutes` y la página Cuenta lo muestra.

| Plan | Precio | Minutos |
|---|---|---|
| Prueba | **1.99 USD** por 7 días (una vez) | **60 min**; después pasa sola a Básico, salvo que cancele |
| Básico | **9.99 USD/mes** | **200 min** por mes |
| Pro | **19.99 USD/mes** | **400 min** por mes |
| Max | **39.99 USD/mes** | **1000 min** por mes |

(Precios decididos el 08/10/2026; antes eran Prueba 1 USD y Pro 15 USD con 600 min.)

Reglas:
- **Los minutos no se acumulan** de un mes a otro.
- **Se descuentan los minutos del video** al crear clips. Si el procesamiento falla, se devuelven.
- **Volver a analizar con IA** un video que quedó sin análisis no vuelve a cobrar los minutos.
- **Sin plan activo no se procesa.** Así nadie abre cuentas gratis para gastar OpenAI.
- **Paquete extra** (opcional, por decidir): p. ej. 5 USD por 200 min.

## «Descargar solo el video»

> Desactivado el 03/10/2026 por Paddle (ver `docs/importar-por-enlace.md`). Si se reactiva, aplican estas reglas.

- **No gasta minutos** (no usa OpenAI).
- **Pro: ilimitadas mientras no pasen por el proxy residencial (Evomi).** TikTok, Kick, Twitch y los
  enlaces directos bajan sin proxy, así que no tienen límite.
- **Las que sí pasan por Evomi** (cuando Instagram o Facebook bloquean al servidor) tienen un tope,
  porque Evomi se paga por GB. Por decidir: p. ej. 2 GB al mes por usuario.
- Prueba: mismo criterio, con un tope menor (por decidir).

## Costos de referencia

- ~0,01 USD por minuto de video (Whisper ~0,006 + GPT y servidor). Medido: 2,5 h ≈ 0,93 USD de OpenAI.
- Costo máximo si se usan todos los minutos (~0,01 USD/min): Prueba ~0,60 USD de 1.99; Básico ~2 USD de
  9.99; Pro ~4 USD de 19.99; Max ~10 USD de 39.99 (más la comisión de Paddle).

## Pendiente

1. Configurar Paddle y activar los cobros (pasos en [pagos-paddle.md](pagos-paddle.md)).
2. Paquete extra de minutos (por decidir).
