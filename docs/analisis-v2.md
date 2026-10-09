# Análisis v2: oye, ve y usa un modelo de gama alta

Implementado el 09/10/2026. Mientras no se active, **los videos de los usuarios siguen con la versión
actual**. La versión nueva solo la usa la **prueba lado a lado** del dueño hasta que se active.

## Qué cambia

| | Actual (`classic`) | Nueva (`v2`) |
|---|---|---|
| Transcripción | Whisper (OpenAI) | Whisper (igual) |
| Elige los momentos | `gpt-4o-mini`, solo con la transcripción | **`gpt-6.1-sol`**, con transcripción + sonidos + fotogramas |
| Sonidos | — | **Detector local YAMNet**: risas, gritos, aplausos y vítores con sus tiempos, marcados en la transcripción como `[risas]`, `[grito]`, `[aplausos]`, `[vítores]` |
| Imágenes | — | **Un fotograma cada 5–10 s** (5 s en videos de hasta 30 min, hasta 10 s desde 1 h), JPEG de hasta 512 px, detalle `low` |
| Instrucciones | Momentos que se entienden solos | + **gancho en los primeros 3 s**, reacciones fuertes, risas, gritos y jugadas clave; más fuerza a los tramos con `[risas]`/`[grito]`; cortes en frases completas; **duración pedida ±5 s** |
| Puntaje | Fuerza de la IA + reacción (volumen, acción, chat…) | Igual **+0,10** si el clip tiene risas o gritos (+0,05 más con dos o más; +0,05 con aplausos o vítores; tope +0,15) |
| Títulos | Pedido aparte a `gpt-4o-mini` | Los propone el mismo modelo con cada momento (vio y oyó el clip) |
| Videos sin habla (gameplay) | Se eligen por volumen, acción y movimiento | La IA elige por lo que **ve y oye** (sin subtítulos inventados) |

Lo que NO cambia: el encuadre (caras, franjas negras), los subtítulos, el corte en frases completas y la
duración obligatoria (±5 s). Si la IA falla, el video se procesa igual que hoy (por señales).

### Por qué `gpt-6.1-sol`

Según la página de modelos de OpenAI (octubre de 2026): *"Near-Astra performance for complex work at a
lower cost"*: casi lo mismo que el más caro (`gpt-6-astra`, 10/50 USD por millón de tokens) por la
quinta parte (**2 USD entrada / 0,10 en caché / 10 USD salida**). Acepta imágenes y respuestas en JSON
estricto. Es un modelo que razona: se le pide esfuerzo `medium` (su valor por defecto).

### Detector de sonidos (YAMNet)

- Modelo de Google ([tensorflow/models, research/audioset/yamnet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)),
  licencia **Apache 2.0**, 521 clases de AudioSet. Convertido a ONNX (`worker/models/yamnet.onnx`,
  ver `worker/test-fixtures/README.md`) y ejecutado con onnxruntime en el procesador: **sin costo por
  video**. Tarda ~1 min por hora de audio, en paralelo con la transcripción.
- El espectrograma se calcula en TypeScript igual que el original; un test compara contra el resultado
  de TensorFlow.
- Umbrales: risas 0,25; gritos 0,40 (la voz fuerte de un streamer también suena un poco a "grito");
  aplausos y vítores 0,30. Se pueden ajustar en `worker/src/sounds/yamnet.ts`.

## Probarla ANTES de unir el PR (prueba lado a lado)

1. **Desplegar la rama del PR en staging**: GitHub → Actions → **Deploy** → *Run workflow* → en
   **"Use workflow from"** elige la rama del PR → stage `staging` → *Run workflow*.
   - Los videos de los usuarios siguen con la versión actual (`AI_PIPELINE` vacío = `classic`).
   - Si GitHub no deja desplegar esa rama (el environment `staging` solo permite `main`), se puede unir
     el PR sin riesgo: nada cambia para los usuarios hasta poner `AI_PIPELINE = v2`.
2. En la web, con tu cuenta (la de `BILLING_FREE_EMAILS`), abre un video ya subido → abajo aparece
   **«Comparar versión actual y nueva»** (otros usuarios no lo ven).
3. Se crean dos copias del video, `[Actual] …` y `[Nueva] …`, y cada una se procesa con su versión.
   Cada una **transcribe de nuevo** para que el costo sea el real.
4. **Ver pruebas** (`/dashboard/comparar`): las dos versiones lado a lado, con:
   - **costo real por hora de video**: tokens que informa OpenAI × precio del modelo, minutos de Whisper
     y tiempo del servidor (Fargate 0,1975 USD/h), llevado a 60 min;
   - desglose: transcripción, elegir momentos (texto + imágenes) y servidor; tiempo total;
   - sonidos detectados y fotogramas que vio la IA;
   - los clips con su puntaje, título y motivo: tocar uno lo reproduce ahí mismo.
5. Las copias quedan en "Mis videos"; se borran como cualquier video.

## Activarla para todos

GitHub → Settings → Environments → staging → **Variables** → `AI_PIPELINE` = `v2` → Deploy.
Para volver atrás: `AI_PIPELINE` = `classic` (o borrarla) y Deploy.

## Costo estimado por hora de video (a confirmar con la prueba)

| | Actual | Nueva |
|---|---|---|
| Whisper (0,006 USD/min) | 0,36 | 0,36 |
| Elegir momentos | ~0,01 (`gpt-4o-mini`) | ~0,30–0,45 (`gpt-6.1-sol`: ~90 mil tokens de entrada con 360 fotogramas y ~20 mil de salida con lo que "piensa") |
| Sonidos (YAMNet) | — | 0 (local; ~1 min de servidor) |
| Servidor (Fargate) | ~0,05–0,08 | ~0,06–0,10 |
| **Total** | **~0,43** | **~0,75–0,90** |

Los números reales de cada video salen en la página de la prueba (y en la tabla `usage`).

## Configuración (worker)

| Variable | Valor | Qué es |
|---|---|---|
| `AI_PIPELINE` | `classic` | Versión para los usuarios (`v2` = la nueva). Desde la variable de GitHub `AI_PIPELINE`. |
| `OPENAI_V2_MODEL` | `gpt-6.1-sol` | Modelo que elige los momentos en la versión nueva |
| `OPENAI_V2_REASONING_EFFORT` | `medium` | `low` / `medium` / `high` |
| `OPENAI_V2_*_COST_PER_1M_TOKENS_USD` | 2 / 0,1 / 10 | Precios para calcular el costo real |
| `AI_V2_FRAME_MIN_SECONDS` / `MAX` | 5 / 10 | Intervalo de los fotogramas |
| `SOUND_DETECTION_ENABLED` | `true` | Detector de sonidos |

## Privacidad

En la versión nueva OpenAI recibe, además del audio y la transcripción, fotogramas del video en baja
resolución. La política de privacidad ya lo dice. El detector de sonidos corre dentro de nuestro
servidor: el audio no sale para eso.
