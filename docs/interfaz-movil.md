# Interfaz nueva (pensada para celular) y subtítulos en el video

Fecha: 01/10/2026. El diseño se aprobó antes de programarlo, como una maqueta interactiva de 5
pantallas.

## Qué cambió para el usuario

| Pantalla | Qué hace |
|---|---|
| **Barra inferior** (celular) | "Mis videos", "Subir video" y "Cuenta". El botón central es verde y tiene la forma del logo CF; la sección actual se marca en verde. En computadora, los mismos enlaces van arriba. |
| **Mis videos** (`/dashboard`) | Tarjetas con miniatura (el mejor clip), nombre y estado: barra de avance si se procesa, "N clips listos" si terminó. Filtro por proyecto, crear proyecto y eliminar. |
| **Subir video** (`/dashboard/subir`) | El video empieza a subirse apenas se elige. Mientras sube, se eligen la **duración de los clips** (15/30/45/60/90 s) y el **estilo de subtítulos**. "Crear clips" confirma; si la subida no terminó, el procesamiento empieza solo al terminar. |
| **Progreso** (`/dashboard/videos/:id` mientras procesa) | Anillo con el porcentaje real, tiempo transcurrido y estimado de lo que falta. Debajo, la lista de pasos y un aviso de que se puede cerrar la página. |
| **Tus clips** (la misma página al terminar) | Cuadrícula vertical ordenada por puntaje, con puntaje, duración y título, y filtros Todos / Aprobados / Descartados. |
| **Ver un clip** | Reproductor, **Descargar** y **Compartir**. Compartir abre el menú del celular con el archivo de video (TikTok, Instagram, WhatsApp…); si el navegador no puede, lo dice y ofrece descargar. También: aprobar, descartar, `.srt` y **transcripción** con el idioma detectado. La frase que suena se resalta y tocar una frase salta a ese momento. Además: copiar texto y "Ver todo el video" (transcripción completa). |
| **Cuenta** | Correo y cerrar sesión. |

## Subtítulos dibujados en el video

Los estilos son:
- **Resaltado** (por defecto): de a 1–3 palabras en MAYÚSCULAS y la palabra que suena en verde lima.
  Usa el tiempo de cada palabra que da Whisper (`timestamp_granularities[]=word`, mismo precio). Si
  no lo hay, lo reparte según el largo de cada palabra.
- **Clásico**: frases cortas en una caja oscura.
- **Sin subtítulos**: el video sale limpio. El `.srt` y la transcripción siguen disponibles.

Cómo se hace:
- **Archivo ASS:** el worker lo genera (`worker/src/subtitles.ts`) y FFmpeg lo dibuja con libass
  sobre el video final 1080x1920, en la parte baja de la imagen.
- **Fuente:** Montserrat ExtraBold (licencia OFL, `worker/fonts/`), incluida en la imagen Docker.
  Se probó en Debian bookworm con su FFmpeg 5.1, el mismo de la imagen.
- **Seguridad:** el texto de la transcripción se limpia (`{ } \`) para que no pueda inyectar
  comandos de ASS.

Si no hubo habla o falló la IA, no hay texto que dibujar y el clip sale sin subtítulos.

## API

- `POST /videos/:id/complete` y `POST /videos/:id/process` aceptan `clipDurationSeconds` y
  `subtitleStyle` (`highlight` | `classic` | `none`).
  - Una duración no permitida responde 400 sin terminar la subida.
  - Se guardan en `processing_jobs.params`.
- `GET /videos` y `GET /videos/:id` traen `thumbnailUrl` (miniatura del mejor clip, URL temporal) y
  `clipCount` (sin contar descartados).
- `GET /videos/:id/clips` trae `transcript: { vttUrl, language }`: la transcripción completa del
  último procesamiento con IA.
  - El worker la guarda en `subtitles/<usuario>/<trabajo>/full.vtt`. Esa carpeta ya tenía permisos
    y se borra al eliminar el video.
  - Videos procesados antes de este cambio no la tienen y devuelven `null`.

## Cómo se verificó

- **Tests:**
  - Opciones al subir: valores por defecto, elegidas y duración inválida.
  - Miniatura, conteo y aislamiento entre usuarios.
  - Transcripción completa: solo con IA y si el archivo existe.
  - Tiempos por palabra de Whisper.
  - Generador ASS: grupos, colores, tiempos, huecos, inyección, sin texto.
  - De punta a punta: el mismo clip con "Resaltado" cambia solo en la franja de los subtítulos;
    con "Sin subtítulos", no.
  - Lectura de WebVTT y nombres de idioma en la web.
- **Capturas reales** con Chromium a 390x844 y a 1280x800. Se usó una API falsa con datos de
  ejemplo, solo para las capturas: no está en el repositorio. Se recorrieron Mis videos, Subir video
  (elegir archivo, cambiar opciones y "Crear clips" lleva al progreso con las opciones elegidas),
  Progreso, Tus clips, Ver un clip con su transcripción y la transcripción completa, sin errores en
  la consola.

## Idioma: español e inglés (03/10/2026)

Toda la app está en **español e inglés**. El usuario elige en **Cuenta → Idioma**.
- **Cómo se decide el idioma:** la cookie `clipflow-lang` (la guarda el selector, dura un año). Sin cookie,
  se usa el idioma del navegador: inglés si empieza por `en`, si no español.
- **Textos de la web:** `frontend/src/i18n/messages.ts`, con las dos versiones lado a lado. TypeScript exige
  que el inglés tenga las mismas claves que el español, y un test verifica que ninguna quede vacía.
  - En componentes del navegador: `const t = useT()`. En los de servidor: `const t = await getT()`.
  - Títulos de pestaña: `pageTitle("clave")`.
- **Mensajes del servidor** (errores de la API, del procesador y de la IA): el servidor responde siempre
  en español y la web los traduce con `translateMessage` (`shared/src/i18n.ts`).
  - Un test revisa el código de la API, la validación y el procesador, y falla si un mensaje nuevo para el
    usuario no tiene traducción. Al agregar un mensaje, agrega su traducción ahí.
  - Si alguno se escapa, se muestra en español (nunca se rompe).
- **Lo que no cambia de idioma:** los subtítulos, las transcripciones y los títulos de los clips (están en
  el idioma en que se habla en el video), y los nombres de proyectos y videos.
- Las páginas legales tienen su propia versión por dirección (`/terminos` y `/en/terms`, etc.).

## Cuenta: nombre (03/10/2026)

- **Nombre:** la fila abre `/dashboard/cuenta/nombre` para escribirlo; se guarda en Cognito (atributo
  `name`) y se muestra en Cuenta. Sin nombre, la fila dice «Agregar nombre».
- **Redes conectadas** se quitó hasta que exista la función (publicar directo exige que cada red apruebe
  la app).

## Más opciones (07/10/2026)

- **Duraciones:** 15, 30, 45, 60 y 90 s, 3 min y 4 min. Cada clip dura lo elegido ±5 s.
- **Estilos de subtítulos:**
  - Resaltado
  - Clásico
  - **Palabra** (una sola palabra, grande, con un salto)
  - **Amarillo**
  - **Neón** (brillo naranja)
  - **Minimal** (minúsculas, sin borde)
  - Sin subtítulos
- **Subida en segundo plano:**
  - La subida de un archivo vive en el layout del panel (`UploadProvider`), así que sigue mientras el
    usuario va a Mis videos o Cuenta.
  - Una barra flotante muestra el avance y lleva a elegir las opciones o al video terminado.
  - Solo se corta si se cierra o recarga la página: el navegador avisa antes y pide que la pantalla
    no se apague. Un navegador no permite seguir subiendo con la página cerrada.
