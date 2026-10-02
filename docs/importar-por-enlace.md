# Importar videos por enlace

Fecha: 01/10/2026. En **Subir video → Enlace** se pega el enlace de un video de **TikTok, Instagram o
Facebook**, o un enlace directo a un archivo `.mp4`/`.mov`/`.webm`/`.mkv`. ClipFlow lo descarga y lo
procesa igual que un video subido.

**YouTube, por ahora no (02/10/2026).** Se probó con proxy residencial (Evomi) y con el generador
de tokens de YouTube, y YouTube siguió bloqueando la descarga (403). A pedido del dueño del producto
se quitó; se retomará más adelante.
- La API y la web avisan al pegar el enlace: "Por ahora no se pueden importar videos de YouTube.
  Descárgalo y súbelo como archivo. Por enlace funcionan TikTok, Instagram y Facebook".
- Lo mismo con Vimeo, X, Twitch, Dailymotion, Reddit y Kick.
- El worker también lo rechaza, por si llega un enlace guardado antes del cambio.
- **Si se retoma:** el generador de tokens está en el historial de git (PR #21). Se quitó de la
  imagen para no mantenerlo sin uso.

## Descargar solo el video (02/10/2026)

Debajo del campo del enlace hay un botón **"Descargar solo el video"**: baja el video tal cual,
sin crear clips.
- **Misma ventana de derechos de autor;** el botón dice "Acepto, descargar".
- **El procesador** descarga el video, lo revisa con ffprobe y lo guarda en S3. No hay análisis, IA
  ni clips, así que es rápido y no gasta OpenAI. La barra muestra "Descargando el video" →
  "Preparando tu descarga".
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
