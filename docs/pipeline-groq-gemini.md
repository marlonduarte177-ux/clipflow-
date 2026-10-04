# Pipeline nuevo: Groq (transcripción) + Gemini (elegir momentos)

Estado al 04/10/2026: **construido y apagado por defecto** (`AI_PIPELINE=classic`). Se decide con la
prueba lado a lado antes de dejarlo fijo.

## Qué hace

1. **Transcripción con Groq**, modelo `whisper-large-v3`, con tiempos por palabra para los subtítulos.
   - Usa la misma API que OpenAI (`https://api.groq.com/openai/v1`), así que reutiliza el cliente de OpenAI:
     reintentos, filtro de alucinaciones y tiempos por palabra.
   - **Respaldo:** si Groq falla, transcribe OpenAI Whisper.
2. **Gemini elige los momentos mirando el video** (imagen + audio) junto con la transcripción.
   - El procesador prepara **partes de ~10 min** (con 1 min de solape) en **baja resolución**: 360 p, 2
     fotogramas por segundo y audio mono. Se suben con la Files API y se borran al terminar.
   - Resolución del análisis: `GEMINI_MEDIA_RESOLUTION=low` (por defecto) o `medium`.
   - Por cada clip, Gemini devuelve **inicio, fin, título con gancho, puntaje (0–100) y por qué es un buen
     momento**.
     - El título se usa tal cual.
     - El motivo se guarda en `clips.ai_reason`. Es solo para revisión interna: no se muestra a usuarios.
   - **Sin habla** (gameplay), Gemini igual elige momentos mirando el video.
   - **Respaldo:** si Gemini falla, elige los momentos `gpt-4o-mini` con la transcripción (como antes).
3. **El clip final** se corta siempre del video original en calidad completa, con el encuadre de caras y
   los subtítulos de siempre. La copia de baja resolución solo sirve para el análisis.

Módulos:
- `worker/src/ai/gemini.ts`: subida, pedido, JSON estricto, costo y reintentos.
- `worker/src/ai/gemini-pipeline.ts`: la cadena con respaldos.
- `makeVideoParts` en `worker/src/ffmpeg.ts`: las partes de baja resolución.

## Modelo de Gemini

- **Gemini 2.5 Flash se apaga el 16/10/2026**, y las cuentas nuevas ya no pueden usarlo. Por eso se usa
  `GEMINI_MODEL=gemini-3.5-flash`.
- La prueba lado a lado compara también `gemini-3.1-flash-lite`, que es mucho más barato.

| Modelo | Entrada (texto/imagen/video) | Entrada (audio) | Salida |
|---|---|---|---|
| gemini-3.5-flash | 1,50 USD / 1M tokens | 1,50 | 9,00 |
| gemini-3.1-flash-lite | 0,25 | 0,50 | 1,50 |

Groq whisper-large-v3: 0,111 USD por hora de audio (~0,0019 USD/min).

**Estimación por minuto de video** en baja resolución:
- Cálculo: ~70 tokens por fotograma × 1 fps + 32 tokens/s de audio ≈ 6.100 tokens/min, más la transcripción.
- Gemini 3.5 Flash: ~0,01 USD/min. Gemini 3.1 Flash-Lite: ~0,002 USD/min.
- Pipeline actual: Whisper 0,006 + gpt-4o-mini ~0,0002 USD/min.
- Los números reales salen de la prueba lado a lado: el costo se calcula con los tokens que informa cada
  pedido.

## Claves (nunca en el código ni en GitHub)

Las dos viven en **AWS Secrets Manager**. El despliegue crea los secretos con un valor de relleno y, mientras
no se reemplace, el pipeline nuevo queda apagado.
- `clipflow-staging/groq-api-key`: la clave de console.groq.com (empieza con `gsk_`).
- `clipflow-staging/gemini-api-key`: la clave de aistudio.google.com (empieza con `AQ.`; las claves antiguas, con `AIza`).
  - **Activar la facturación** en ese proyecto de Google. En el nivel gratis, Google puede usar los datos para
    mejorar sus productos, y la Política de privacidad dice que usamos el servicio de pago.

## Prueba lado a lado (solo administradores)

- Acceso: los correos de la variable de GitHub `ADMIN_EMAILS` (environment staging).
- En la página de un video, el administrador ve **«Comparar pipelines (interno)»**.
  - Crea una copia del video por pipeline (copia del original dentro de S3): `[Actual]`,
    `[Gemini 3.5 Flash]` y `[Gemini 3.1 Flash-Lite]`.
  - Cada copia se procesa sin reutilizar transcripciones, para medir el costo real.
- `/dashboard/comparar` muestra, por pipeline:
  - costo total y de IA **por minuto de video**, con el desglose;
  - quién transcribió y quién eligió los momentos, y si se usó un respaldo y por qué;
  - los clips con título, puntaje, motivo y miniatura (toca para ver el clip).
- API: `GET /admin/me`, `POST /admin/compare/:videoId`, `GET /admin/comparisons`. Los pipelines a comparar
  se configuran con `COMPARE_PIPELINES` en la API.

## Dejarlo fijo

Cambiar `AI_PIPELINE` a `"gemini"` en `infrastructure/lib/worker-stack.ts` y desplegar. Para volver atrás, `"classic"`.
