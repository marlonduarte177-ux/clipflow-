"""
Datos de un enlace (título, duración y miniatura) SIN bajar el video, para la tarjeta de «Nuevo video»
cuando la consulta rápida de la API no los trae (Kick bloquea a los servidores de AWS; TikTok,
Facebook e Instagram no dan la duración por oEmbed).

- Kick: la página del video, pidiéndola como un navegador real (curl-cffi), igual que el complemento
  del procesador. ~1 s.
- Las demás: yt-dlp solo con los datos del video (process=False: no lee los formatos). ~1 s.
- Si la plataforma no responde o bloquea, se reintenta una vez por el proxy residencial (variable de
  entorno CLIPFLOW_PROXY; nunca en los argumentos, que se ven en la lista de procesos).

Uso: python3 link_meta.py URL  → imprime un JSON {title, durationSeconds, thumbnailUrl} (vacío si no hay).
"""

import json
import os
import re
import sys

KICK_VOD = re.compile(
    r"^https?://(?:www\.)?kick\.com/[\w-]{1,60}/videos/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/?$",
    re.IGNORECASE,
)
TIMEOUT = 8


def https_or_none(value):
    return value if isinstance(value, str) and value.startswith("https://") else None


def seconds_or_none(value):
    return round(value) if isinstance(value, (int, float)) and value > 0 else None


def kick_record(page, video_id):
    """El objeto JSON de la página que tiene "id": video_id y "recording_url"."""
    decoder = json.JSONDecoder()
    for match in re.finditer(r'"id":"%s"' % re.escape(video_id), page):
        depth, start = 0, None
        for i in range(match.start(), -1, -1):
            ch = page[i]
            if ch == "}":
                depth += 1
            elif ch == "{":
                if depth == 0:
                    start = i
                    break
                depth -= 1
        if start is None:
            continue
        try:
            record, _ = decoder.raw_decode(page, start)
        except ValueError:
            continue
        if isinstance(record, dict) and "recording_url" in record:
            return record
    return None


def kick(url, video_id, proxy):
    from curl_cffi import requests

    proxies = {"http": proxy, "https": proxy} if proxy else None
    response = requests.get(url, impersonate="chrome", timeout=TIMEOUT, proxies=proxies, allow_redirects=False)
    response.raise_for_status()
    page = response.text.replace('\\"', '"').replace("\\/", "/")
    record = kick_record(page, video_id.lower())
    if not record:
        return None
    thumbnail = record.get("thumbnail") or {}
    return {
        "title": record.get("title") or record.get("session_title"),
        "durationSeconds": seconds_or_none(record.get("duration")),
        "thumbnailUrl": https_or_none(thumbnail.get("src") if isinstance(thumbnail, dict) else None),
    }


class SilentLogger:
    """Sin mensajes: lo que importa es el JSON de salida."""

    def debug(self, msg):
        pass

    info = warning = error = debug


def generic(url, proxy):
    from yt_dlp import YoutubeDL

    options = {
        "logger": SilentLogger(),
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "cachedir": False,
        "socket_timeout": TIMEOUT,
    }
    if proxy:
        options["proxy"] = proxy
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        # Enlaces cortos (vt.tiktok.com, fb.watch…): primero llevan al video.
        if info.get("_type") in ("url", "url_transparent") and info.get("url"):
            info = ydl.extract_info(info["url"], download=False, process=False)
    thumbnail = info.get("thumbnail")
    if not thumbnail and isinstance(info.get("thumbnails"), list) and info["thumbnails"]:
        thumbnail = info["thumbnails"][-1].get("url")
    return {
        "title": info.get("title"),
        "durationSeconds": seconds_or_none(info.get("duration")),
        "thumbnailUrl": https_or_none(thumbnail),
    }


def main():
    url = sys.argv[1]
    proxy = os.environ.get("CLIPFLOW_PROXY") or None
    match = KICK_VOD.match(url)
    best = {}
    for attempt in [None, proxy] if proxy else [None]:
        try:
            found = kick(url, match.group(1), attempt) if match else generic(url, attempt)
        except Exception:  # bloqueos, tiempo agotado, enlace privado: se prueba por el proxy
            found = None
        if found:
            best = found
            if found.get("durationSeconds"):
                break
    print(json.dumps({k: v for k, v in best.items() if v is not None}))


if __name__ == "__main__":
    main()
