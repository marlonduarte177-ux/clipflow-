# Editor de clips

Por ahora **solo para los correos de administrador** (`BILLING_FREE_EMAILS`). El público no ve nada de
esto (la API ni siquiera le dice si un clip se puede editar).

## Fase 1: modo viral automático

- Al abrir un clip que todavía no tiene versión viral aparece **«¿Cómo quieres editarlo?»**: modo viral
  (recomendado), editar a mano (fase 3), «Aplicar a los N clips» y «Música de fondo». «Hacerlo viral»
  crea un trabajo `render_clip` y la página del video muestra su avance.
- El procesador toma el clip **sin subtítulos** (copia limpia), mide el volumen cada 0.1 s y junta los
  sonidos detectados (gritos, risas, vítores) para elegir los momentos fuertes (máx. 1 cada 7 s,
  separados 2.6 s, y siempre un golpe suave al inicio). Con FFmpeg:
  - subtítulos **karaoke**: palabra por palabra en MAYÚSCULAS, la que suena en amarillo (#ffd60a) con
    un «pop», Montserrat ExtraBold 96 con borde negro, en el tercio inferior;
  - **zoom golpe** (+16 % que vuelve en 0.38 s), **temblor** (18 px, 0.32 s) en los más fuertes y
    **flash** (brillo, 0.09 s) en los 2 más fuertes;
  - **música** de fondo al 12 % (si hay pistas en `music/`), con fundido al inicio y al final;
  - salida **1080x1920 a 60 fps** (H.264, CRF 20, AAC 160 kbps).
- La versión viral se guarda **aparte** (`clips/<usuario>/<trabajo de edición>/<clip>.mp4`): el clip
  original no cambia. En el clip se elige **Viral / Original** y se descarga o comparte la que se ve.

### Copia limpia

Los trabajos de un administrador (`params.editable`) guardan, además de cada clip:
- el clip sin subtítulos dibujados (`clips/<u>/<trabajo>/<n>-clean.mp4`; una sola pasada de FFmpeg con
  dos salidas, o el mismo clip si no lleva subtítulos);
- sus palabras con tiempo y sus sonidos (`subtitles/<u>/<trabajo>/<n>.edit.json`).

Clips anteriores al editor: si el video se **subió como archivo**, el procesador rehace el clip limpio
desde el original (y toma las palabras de su WebVTT). Si vino de un **enlace**, el original ya se borró:
hay que volver a crear los clips del video.

### Música (la sube el dueño)

1. AWS → **S3** → el bucket de ClipFlow (`clipflow-staging-…`).
2. **Create folder** → `music` → **Create folder**.
3. Entra a `music/` → **Upload** → **Add files** → tus pistas MP3 (o M4A, WAV, OGG) **libres de
   derechos** → **Upload**.
4. Listo: el próximo modo viral ya las usa (cada clip toma una distinta). Sin pistas, sale sin música.

El procesador solo puede **leer** esa carpeta (y listar su contenido); no puede borrarla ni cambiarla.

### Costo

El modo viral es un trabajo de FFmpeg aparte: ~1 a 2 veces el tiempo de generar ese clip (sale a 60 fps
con efectos). Sin IA ni servicios externos: solo el tiempo del procesador (se registra en `usage`).
