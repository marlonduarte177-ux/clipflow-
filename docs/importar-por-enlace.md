# Importar videos por enlace

Fecha: 01/10/2026. En **Subir video → Enlace** se pega el enlace de un video (YouTube, TikTok,
Instagram, Facebook, X, Vimeo y otros, o un enlace directo a un archivo `.mp4`/`.mov`/`.webm`/`.mkv`).
ClipFlow lo descarga y lo procesa igual que un video subido.

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
   - **Plataformas conocidas:** con **yt-dlp** (versión fijada `2026.8.19` en `worker/Dockerfile`),
     con `curl-cffi` para "parecerse" a un navegador real.
     - Hasta 1080p, prefiriendo H.264/AAC; todo en un `.mp4`.
     - Rechaza transmisiones en vivo y videos de más de 3 h.
     - Usa Node (ya en la imagen) como intérprete de JavaScript, que YouTube exige.
     - TikTok exige la imitación de navegador. Sin `curl-cffi`, en la primera prueba real
       (01/10/2026) TikTok respondió "Unexpected response". Con `curl-cffi` se probó un enlace
       `vt.tiktok.com`: lee título y duración y descarga H.264 + AAC.
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
- **yt-dlp** solo se usa con dominios de plataformas conocidas.
- **El enlace completo no se escribe en los registros**, solo el dominio: puede llevar datos
  privados.
- **IAM:** el worker puede **agregar** originales (`PutObject` y `AbortMultipartUpload` en
  `originals/*`), pero no borrarlos.

## Límites honestos

- **Bloqueos de las plataformas:** YouTube, Vimeo, Instagram y otras bloquean a menudo las descargas
  desde servidores de nube (AWS). Piden iniciar sesión o responden "403".
  - En las pruebas de desarrollo, YouTube leyó el video pero bloqueó la descarga (403), y Vimeo
    pidió iniciar sesión.
  - Cuando pasa, el usuario ve: "La plataforma bloqueó la descarga desde nuestros servidores.
    Descarga el video y súbelo como archivo".
  - Para YouTube y compañía hay un **proxy residencial** opcional (ver abajo).

## Proxy residencial (YouTube y plataformas que bloquean a AWS)

Desde el 02/10/2026 el procesador puede descargar a través de un proxy residencial (probado con
**Evomi**, ~0,49 USD/GB). Así la descarga sale desde IPs "de casa" en lugar de AWS.
- **Cuándo se usa:**
  - **YouTube y youtu.be:** siempre por el proxy, porque desde AWS siempre bloquean.
  - **El resto** (Instagram, Facebook, Vimeo…): primero sin proxy, que es gratis. Solo si la
    plataforma bloquea, se reintenta una vez por el proxy.
  - **TikTok:** ya funciona sin proxy, así que normalmente no gasta nada.
- **Por el proxy se descarga hasta 720p:** se paga por GB y para clips verticales alcanza.
  - Un video de 10 min pesa ~50–100 MB, unos 0,03–0,05 USD.
- **Sesión fija:** YouTube ata el enlace del video a la IP que lo pidió. Con Evomi el procesador
  agrega solo `_session-XXXXXXXX_lifetime-60` a la contraseña, para mantener la misma IP durante toda la descarga.
  - Con otro proveedor hay que pegar la URL ya con su sesión fija.
- **Seguridad:**
  - El usuario y la contraseña del proxy viven solo en Secrets Manager. Nunca están en GitHub ni en
    el código.
  - En los registros solo aparece el host del proxy; las contraseñas se borran de cualquier mensaje de error.
- **Si el proxy falla** (credenciales mal puestas o saldo agotado): el usuario ve "Nuestro servicio
  de descarga no respondió" y se reintenta. En CloudWatch el detalle empieza con `[proxy]`.
- **Sin proxy configurado** todo funciona igual que antes.
- **Configuración:** el procesador lee la variable `DOWNLOAD_PROXY_URL`, con el formato
  `http://USUARIO:CONTRASEÑA@rp.evomi.com:1000`. Si no es una URL válida, el proxy queda apagado.
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
- **yt-dlp:** reconoce plataformas sin dejarse engañar (`youtube.com.evil.com`), traduce sus
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
