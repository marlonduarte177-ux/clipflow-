# Importar videos por enlace

Fecha: 01/10/2026. En **Subir video → Enlace** se pega el enlace de un video de **TikTok, Instagram,
Facebook, Kick o Twitch**, o un enlace directo a un archivo `.mp4`/`.mov`/`.webm`/`.mkv`. ClipFlow lo descarga y lo
procesa igual que un video subido.

**YouTube, por ahora no (02/10/2026).** Se probó con proxy residencial (Evomi) y con el generador
de tokens de YouTube, y YouTube siguió bloqueando la descarga (403). A pedido del dueño del producto
se quitó; se retomará más adelante.
- La API y la web avisan al pegar el enlace: "Por ahora no se pueden importar videos de YouTube.
  Descárgalo y súbelo como archivo. Por enlace funcionan TikTok, Instagram y Facebook".
- Lo mismo con Vimeo, X, Dailymotion y Reddit.

**Kick (02/10/2026):** se importan **clips** (`kick.com/canal/clips/clip_…` o `kick.com/canal?clip=clip_…`)
y **videos guardados** (`kick.com/canal/videos/…`), para crear clips o para "Descargar solo el video".
- Probado: dos clips reales bajaron en 1080p H.264 + AAC, que se ve en el iPhone sin convertir.
- **Códigos nuevos de Kick (arreglo del 02/10/2026):**
  - **Qué cambió:** desde septiembre de 2026 los enlaces de videos guardados usan otro código
    (`kick.com/canal/videos/01a0b24f-2b40-7d20-…`, un UUIDv7). La API que usa yt-dlp solo conoce el código
    antiguo y responde 404, así que la app decía "No encontramos un video" con videos de ayer.
  - **Solución:** un complemento propio de yt-dlp,
    `worker/ytdlp-plugins/clipflow/yt_dlp_plugins/extractor/kick_video_page.py`.
    - Lee la página del video, imitando a un navegador, y toma de su registro la dirección del video
      (`recording_url`), el título y la duración.
    - Solo actúa con los códigos nuevos; los antiguos los sigue resolviendo yt-dlp.
    - El procesador lo carga con `--plugin-dirs` y la imagen lo copia.
  - **Probado:** con un video de punicher de 2 h se leyeron el título y la duración, se bajaron 20 s en
    720p H.264 + AAC, y la descarga completa arrancó a ~35 MB/s.
  - Si yt-dlp lo resuelve en una versión futura, se puede borrar el complemento.
- **Kick se baja hasta 720p:** los videos guardados duran horas, y en 1080p60 pesan ~2,8 GB por hora; en
  720p, la mitad. Para clips verticales alcanza.
  - En los videos de Kick (HLS), yt-dlp no aplica el tope de tamaño antes de bajar. Sí se aplican el
    límite de 3 h y la revisión de tamaño después.
- **Canal en vivo:** se rechaza con "es una transmisión en vivo".
- **Canal sin transmitir:** "Ese enlace es de un canal, no de un video. Pega el enlace de un clip o de un
  video guardado".
- **Videos guardados de más de 3 h:** se rechazan por el límite de duración.
- El worker también lo rechaza, por si llega un enlace guardado antes del cambio.
- **Si se retoma:** el generador de tokens está en el historial de git (PR #21). Se quitó de la
  imagen para no mantenerlo sin uso.

**Twitch (03/10/2026):** se importan **clips** (`twitch.tv/canal/clip/…`, `clips.twitch.tv/…`) y
**videos guardados** (`twitch.tv/videos/123…`), para crear clips o para "Descargar solo el video".
- Mismos límites que Kick: hasta **720p** y **3 h**; un canal en vivo se rechaza.
- Videos solo para suscriptores: "Este video es solo para suscriptores del canal, así que no se puede
  importar." Videos borrados o caducados: "No encontramos un video…".
- Algunos clips de Twitch vienen en HEVC: al crear clips se recomprimen igual; en "Descargar solo el
  video" se pasan a H.264 para el iPhone.

## Streams largos de Kick y Twitch: primero una copia liviana (03/10/2026)

Un video guardado de **10 min o más** (al crear clips; no en "Descargar solo el video") no se baja entero
en 720p. En su lugar:
1. **Se leen los datos del enlace** (título, duración, si está en vivo) sin bajar nada.
2. **Se baja una copia liviana** (la calidad más baja, ~160p, con el audio en AAC). Con ella se transcribe,
   se miden las señales y se eligen los momentos. Bajarla es mucho más rápido y ocupa poco.
3. **Por cada clip elegido,** se baja **solo ese tramo** en 720p directo desde la plataforma
   (FFmpeg con `-ss` antes de la entrada y recompresión, así el corte es exacto: medido ±0,05 s).
4. El clip se genera desde ese tramo, con su propio encuadre, y el tramo se borra.

Detalles:
- En S3 queda la copia liviana como "original", marcada con `probe.clipflowAnalysisCopy`.
  - Volver a procesar usa esa copia y vuelve a bajar los tramos.
  - `GET /videos/:id/download` responde 409 `analysis_copy`: "De este video guardamos solo una copia
    liviana para elegir los momentos. Para bajarlo completo, impórtalo con «Descargar solo el video»".
- Si un tramo falla, se reintenta una vez; si la plataforma ya no deja abrir el video (p. ej. se borró),
  el trabajo falla con un mensaje claro.
- Los clips de Twitch/Kick y los videos de menos de 10 min se bajan enteros, como antes.

## Chat de Twitch como señal extra (03/10/2026)

En los **videos guardados de Twitch** (`twitch.tv/videos/…`) también se lee el **chat del directo** y se
usa para elegir los momentos: donde el chat explota suele haber un buen clip.
- **Cómo se lee:** con la misma API pública que usa el reproductor web de Twitch (GraphQL). No necesita
  cuenta, claves ni secretos nuestros. Módulo: `worker/src/chat/twitch.ts`.
- **Qué se mide:** cada 15 s se lee una página de mensajes (en streams de más de ~4 h, cada más
  segundos: máximo 900 consultas) y se calcula la actividad de esa ventana:
  - **mensajes por segundo;**
  - **emotes y risas** (KEKW, LUL, jaja, xd, POG, "clip"…): cada uno pesa 1,5;
  - **cheers (bits)** ("Cheer500"): pesan más según los bits;
  - **subs y donaciones** que anuncian los bots del canal (StreamElements, Streamlabs, Nightbot,
    Moobot, Fossabot…): pesan 4.
- **Retraso del chat:** la gente escribe unos segundos después de lo que pasa; la señal se adelanta 6 s.
- **Peso en el score:** `chat` = 0,4 (variable `SCORE_WEIGHT_CHAT` para cambiarlo; 0 lo desactiva).
- **Nunca hace fallar el trabajo:** si el chat no se puede leer (VOD sin repetición del chat, Twitch
  caído), los momentos se eligen con las demás señales. Tiene un límite de 2 min y corre en paralelo
  con la transcripción.
- **Resultado:** el trabajo guarda `result.chat` ("used"/"unavailable") y `result.chatMessages`. La web
  muestra "También se usó el chat del directo de Twitch…".
- **Probado:** un VOD real de 29 min: 118 muestras y 3220 mensajes leídos en 3 s.
- **Límites honestos:**
  - Las suscripciones y donaciones **solo cuentan si aparecen en el chat** (un bot que las anuncia o
    un cheer). Las alertas en pantalla del stream no están en el chat guardado.
  - Los clips de Twitch no tienen chat guardado, así que no lo usan.
  - **Kick:** su API de historial del chat devuelve muy pocos mensajes (a veces ninguno), así que por
    ahora no se usa.
  - No tiene costo: no usa OpenAI ni el proxy.

## Descargar solo el video (02/10/2026)

> **Desactivado el 03/10/2026** para cumplir con la pasarela de pago (Paddle). El interruptor es
> `FEATURES.downloadOnly` en `shared/src/features.ts` (un solo lugar para la API y la web). Con `false`:
> - la web no muestra el botón, y de los videos que ya se habían bajado solo ofrece «Crear clips»;
> - la API responde 403 `download_disabled` a `POST /videos/import` con `downloadOnly: true`, y a
>   `GET /videos/:id/download` de un video importado por enlace;
> - los clips generados se siguen pudiendo descargar, y un archivo subido por el usuario también.
> Para reactivarlo: poner `true`, fusionar y desplegar. Lo que sigue describe cómo funciona activado.

Debajo del campo del enlace hay un botón **"Descargar solo el video"**: baja el video tal cual,
sin crear clips.
- **Misma ventana de derechos de autor;** el botón dice "Acepto, descargar".
- **El procesador** descarga el video, lo revisa con ffprobe y lo guarda en S3. No hay análisis, IA
  ni clips, así que es rápido y no gasta OpenAI. La barra muestra "Descargando el video" →
  "Preparando tu descarga".
- **Formato para el celular (arreglo del 02/10/2026):** Instagram y Facebook entregan a menudo la
  imagen en **VP9 o AV1** dentro de un `.mp4`. El iPhone solo reproducía el **audio**, y en la vista
  previa aparecía solo el nombre del archivo.
  - Ahora, antes de guardarlo, el procesador lo deja en **H.264 + AAC** con `faststart`.
  - Lo que ya es compatible se copia sin recomprimir; solo se convierte lo que haga falta.
  - En el registro, la línea "video listo para descargar" dice qué se convirtió.
  - Los videos descargados antes del arreglo hay que importarlos otra vez.
- **Cuando termina,** el video muestra "Tu video está listo" con dos botones:
  - **Descargar:** pide `GET /videos/:id/download`, una URL firmada de 15 min con el título como nombre
    de archivo.
  - **Compartir:** el menú del celular, que en iPhone incluye "Guardar video" en Fotos. Solo aparece en
    videos de hasta 200 MB, porque baja el archivo entero al celular.
- **Debajo,** "¿Quieres clips de este video?" permite elegir duración y subtítulos y crear clips con
  el video ya descargado, sin pegar el enlace otra vez.
  - Por eso el trabajo de "solo descarga" usa otra clave interna (`download:`): crear clips después
    abre un trabajo nuevo (`analyze:`).
- **En "Mis videos"** aparece la etiqueta "Listo para descargar".
- **API:** `POST /videos/import` con `downloadOnly: true`, sin opciones de clips. El trabajo guarda
  `params.downloadOnly` y el resultado, `result.downloadOnly`.

## Aviso de derechos de autor

Antes de importar se abre una ventana obligatoria:
- **Qué explica:**
  - solo deben importarse videos propios o con permiso de quien tiene los derechos;
  - reutilizar contenido ajeno puede infringir derechos de autor y las reglas de la plataforma;
  - el usuario es responsable de lo que importa;
  - se guardan el enlace y la fecha de la confirmación.
- **Aceptar es tocar el botón:** el botón dice "Acepto, importar" y la ventana aclara que al tocarlo
  el usuario confirma que el video es suyo o que tiene permiso.
  - Al principio había además una casilla obligatoria; se quitó a pedido del dueño del producto
    (01/10/2026).
- **La API también la exige** (`rightsConfirmed: true`) y guarda `videos.rights_confirmed_at` y
  `videos.source_url`.
- **Al subir un archivo** se muestra una nota corta: "Al subir un video confirmas que es tuyo o que
  tienes permiso para usarlo".

**Recomendación para la fase 10 (producción):** publicar Términos de uso y un correo o formulario
para que titulares de derechos pidan bajar contenido. Es lo que esperan las plataformas y la ley de
varios países.

## Cómo funciona

1. **Web** → `POST /videos/import`. La API valida el enlace, el proyecto y el límite de videos en
   curso (3, sumando subidas e importaciones). Crea el video en estado `importing` y su trabajo. La
   API **nunca descarga nada**.
2. **El worker descarga** (nueva etapa `downloading`; la barra muestra "Descargando el video"):
   - **TikTok, Instagram y Facebook:** con **yt-dlp** (versión fijada `2026.8.19` en `worker/Dockerfile`),
     con `curl-cffi` para "parecerse" a un navegador real.
     - Hasta 1080p, prefiriendo H.264/AAC; todo en un `.mp4`.
     - Rechaza transmisiones en vivo y videos de más de 3 h.
     - TikTok exige la imitación de navegador. Sin `curl-cffi`, en la primera prueba real
       (01/10/2026) TikTok respondió "Unexpected response". Con `curl-cffi` se probó un enlace
       `vt.tiktok.com`: lee título y duración y descarga H.264 + AAC.
     - **FFmpeg con ruta completa (arreglo del 02/10/2026):** yt-dlp recibía solo el nombre `ffmpeg`,
       lo buscaba en la carpeta actual y seguía sin FFmpeg (el aviso lo ocultaba `--no-warnings`).
       - Sin FFmpeg no podía unir video y audio separados, que es como los entregan Instagram y Facebook,
         y el archivo final nunca existía: la app mostraba "Ocurrió un error temporal al descargar el
         enlace (ENOENT)".
       - TikTok funcionaba porque entrega video y audio juntos.
       - Ahora se pasa la ruta completa, buscada en el PATH. Si aun así faltara el archivo final, se usa
         el único que quedó, o se avisa "No pudimos unir el video y el audio" y se reintenta.
   - **Otros enlaces:** deben ser un archivo de video directo. Si es una página web, se explica que
     hay que subirlo como archivo.
3. **Guarda el original** en S3 (`originals/…`; en partes si pesa más de 256 MB) y usa el título
   de la plataforma como nombre. Desde ahí sigue el proceso normal.
4. **Si falla:**
   - un error definitivo (privado, bloqueado, demasiado largo, no es un video) deja el video
     **rechazado** con el motivo en lenguaje simple;
   - un corte temporal se **reintenta** solo.
   - **"Reintentar"** en un enlace que no se pudo descargar lo **vuelve a descargar** (antes buscaba un
     archivo que nunca existió). Mientras se reintenta, la web no muestra el error viejo.

## Si aparece "Ocurrió un error temporal…"

Ese mensaje sale cuando algo falla de forma inesperada (no es un bloqueo de la plataforma).
- **Desde 01/10/2026 dice en qué paso falló y un código corto.** Ejemplo: "Ocurrió un error temporal al
  guardar el video importado (AccessDenied)".
  - El paso indica dónde mirar.
  - El código es el nombre técnico del error: `AccessDenied` es un permiso de S3, `ENOSPC` es falta de disco.
  - No se muestra el mensaje completo porque puede llevar datos internos.
- **El detalle completo queda en CloudWatch:**
  1. Abre AWS → CloudWatch → Grupos de registros → `/clipflow/staging/worker`.
  2. Busca `error inesperado`. Cada línea trae el paso (`step`), el código (`code`), el mensaje
     (`error`) y dónde ocurrió (`stack`).
- **Prueba del 01/10/2026:** se probó en local el enlace `vt.tiktok.com/ZSbUY2r6S` que falló en AWS.
  - El video dura 54 min, pesa 307 MB y viene en HEVC + MP3.
  - Se descargó con la misma versión de yt-dlp y los mismos parámetros que el procesador.
  - Se procesó completo, con clips de 60 s, y generó 15 clips sin error.
  - Por eso el fallo es algo propio de AWS; el nuevo mensaje dirá cuál.

## Seguridad (SSRF)

Un enlace podría intentar que el servidor se conecte a direcciones internas, como las credenciales
de AWS en `169.254.170.2`. Para evitarlo:
- **La API** rechaza:
  - protocolos que no sean http(s);
  - usuario o contraseña dentro del enlace;
  - `localhost` y direcciones privadas, también escritas como número (`2130706433`), en
    hexadecimal o como IPv6 (`::ffff:7f00:1`).
- **En descargas directas, el worker** comprueba la **IP real al conectar**, en cada redirección.
  Así no hay carrera con el DNS: un dominio que resuelve a una IP interna también se bloquea.
- **yt-dlp** solo se usa con los dominios de TikTok, Instagram y Facebook.
- **El enlace completo no se escribe en los registros**, solo el dominio: puede llevar datos
  privados.
- **IAM:** el worker puede **agregar** originales (`PutObject` y `AbortMultipartUpload` en
  `originals/*`), pero no borrarlos.

## Límites honestos

- **Bloqueos de las plataformas:** Instagram y Facebook a veces bloquean las descargas desde
  servidores de nube (AWS): piden iniciar sesión o responden "403".
  - Cuando pasa, primero se reintenta por el **proxy residencial** (ver abajo).
  - Si aun así falla, el usuario ve el motivo y la sugerencia de subirlo como archivo.

## Proxy residencial (plataformas que bloquean a AWS)

Desde el 02/10/2026 el procesador puede descargar a través de un proxy residencial (probado con
**Evomi**, ~0,49 USD/GB). Así la descarga sale desde IPs "de casa" en lugar de AWS.
- **Cuándo se usa:** siempre se intenta primero sin proxy, que es gratis. Solo si la plataforma
  bloquea, se reintenta una vez por el proxy.
  - **TikTok** funciona sin proxy, así que normalmente no gasta nada.
  - **Instagram y Facebook** usan el proxy solo cuando bloquean a AWS.
  - **Sin uso no hay costo:** Evomi cobra por GB usado, no por mes.
- **Por el proxy se descarga hasta 720p:** se paga por GB y para clips verticales alcanza.
  - Un video de 10 min pesa ~50–100 MB, unos 0,03–0,05 USD.
- **Opciones de Evomi:** el procesador las agrega solo a la contraseña.
  - **País fijo, EE. UU.** (`_country-US`). Con "Mundial", cada descarga salía de un país al azar
    y algunos videos volvían "no disponible en tu país" (visto el 02/10/2026).
    Si la contraseña ya trae `_country-XX`, se respeta.
  - **Sesión fija** (`_session-XXXXXXXX_lifetime-60`): las plataformas atan el enlace del video a la
    IP que lo pidió, así que se mantiene la misma IP durante toda la descarga.
  - Con otro proveedor hay que pegar la URL ya con su país y su sesión fija.
- **Restricción de edad:** la plataforma exige una cuenta y el proxy no lo arregla. La app lo dice
  con su propio mensaje.
- **Seguridad:**
  - El usuario y la contraseña del proxy viven solo en Secrets Manager. Nunca están en GitHub ni en
    el código.
  - En los registros solo aparece el host del proxy; las contraseñas se borran de cualquier mensaje de error.
- **Si el proxy falla**, la app dice el motivo entre paréntesis. Ejemplo: "Nuestro servicio de
  descarga no respondió (proxy: usuario o contraseña incorrectos, 407)".
  - **407:** el usuario o la contraseña del secreto están mal. Revisa también los símbolos codificados.
  - **402:** la cuenta no tiene saldo.
  - **403:** el proveedor no permite ese sitio; puede pedir verificar la identidad (KYC).
  - Estos tres no se reintentan, porque no se arreglan solos. Un corte de conexión sí se reintenta.
  - En CloudWatch el detalle completo empieza con `[proxy]`.
- **Sin proxy configurado** todo funciona igual que antes.
  - Si una plataforma bloquea y el proxy no se puede usar, el mensaje lo dice al final: `(proxy: sin
    configurar)` o `(proxy: mal escrito)`.
- **Configuración:** el procesador lee la variable `DOWNLOAD_PROXY_URL`. Acepta estos formatos:
  - `http://USUARIO:CONTRASEÑA@rp.evomi.com:1000`;
  - el que copia Evomi: `rp.evomi.com:1000:USUARIO:CONTRASEÑA`, con o sin `http://` delante. Los
    símbolos de la contraseña se codifican solos.
  - La infraestructura crea el secreto `clipflow-<etapa>/download-proxy` con un valor de relleno, y ECS
    se lo entrega solo al procesador.

### Cómo activarlo (una sola vez)

1. Despliega (Actions → Deploy → staging).
2. En Evomi, en la pantalla del proxy residencial, elige **HTTP** y **puerto 1000**. El país no
   importa: el procesador fija EE. UU. Copia el proxy tal cual lo muestra Evomi.
3. En AWS → **Secrets Manager**, abre `clipflow-staging/download-proxy`.
4. Toca **Recuperar el valor del secreto → Editar** y pestaña **Texto sin formato**.
5. Borra lo que hay y pega el proxy de Evomi tal cual, por ejemplo
   `rp.evomi.com:1000:TU_USUARIO:TU_CONTRASEÑA`.
6. Guarda.
   - El procesador se apaga cuando no hay trabajo, así que el siguiente video ya usa el proxy.
   - Si hay un video procesándose en ese momento, el proxy empieza a usarse cuando el procesador vuelva a arrancar.
7. Para comprobarlo, busca `worker iniciado` en CloudWatch (`/clipflow/staging/worker`): debe decir
   `downloadProxy: "rp.evomi.com"`.

Con el formato `http://USUARIO:CONTRASEÑA@…`, los símbolos `@`, `:` o `/` del usuario o la contraseña
hay que escribirlos codificados: `@` → `%40`, `:` → `%3A`, `/` → `%2F`. Con el formato de Evomi no hace falta.

- **Videos privados o con restricción de edad:** no se pueden importar.
- **yt-dlp hay que actualizarlo seguido** (las plataformas cambian): se cambia `YTDLP_VERSION` en el
  Dockerfile y se vuelve a desplegar.

## Costos

No hay costo de API: la descarga la hace el mismo worker. En AWS el tráfico que entra es gratis.
El original ocupa S3 igual que un video subido y se borra al eliminar el video.

## Pruebas

- **Validación de enlaces:** protocolos, credenciales, IPs internas escritas de varias formas,
  confirmación obligatoria.
- **API:**
  - crea el video `importing` con su trabajo y opciones, guarda el enlace y la confirmación, y no
    sube nada a S3;
  - rechaza sin confirmación o con enlaces internos;
  - protege proyectos ajenos;
  - aplica el límite de 3.
- **Descarga directa con un servidor local:**
  - descarga y redirecciones, con su avance;
  - bloqueo de direcciones locales y de una redirección a los metadatos de AWS;
  - una página que no es video;
  - un archivo demasiado grande;
  - un 404.
- **yt-dlp:** reconoce TikTok, Instagram y Facebook sin dejarse engañar (`tiktok.com.evil.com`), rechaza YouTube con su aviso, traduce sus
  errores, y se probó de verdad descargando con yt-dlp, si está instalado.
- **Procesador:**
  - un video importado se descarga, queda como original con su título y genera clips;
  - un error definitivo lo rechaza con el motivo;
  - un corte temporal se reintenta;
  - reintentar un enlace rechazado lo vuelve a descargar.
- **Imagen:** la instalación de yt-dlp se probó en Debian bookworm (la base de la imagen).
- **Web (capturas reales):**
  - pestaña Enlace;
  - el aviso de enlace interno;
  - la ventana de derechos;
  - la importación envía las opciones elegidas;
  - la pantalla "Descargando el video";
  - el estado en Mis videos.
