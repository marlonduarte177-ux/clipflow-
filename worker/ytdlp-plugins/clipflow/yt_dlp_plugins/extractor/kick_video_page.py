"""
Complemento de yt-dlp para los videos guardados de Kick con el código NUEVO.

Desde septiembre de 2026 los enlaces de Kick usan un código UUIDv7
(kick.com/canal/videos/01a0b24f-2b40-7d20-...). La API que usa yt-dlp (v1/video/<id>) solo
conoce el código antiguo y responde 404, así que yt-dlp decía "no existe" con videos de ayer.

La página del video sí trae su registro con la dirección del video (`recording_url`, un HLS),
el título y la duración: se leen de ahí. Los códigos antiguos (UUIDv4) los sigue resolviendo el
extractor de yt-dlp, porque este solo acepta códigos v7 (el tercer grupo empieza con "7").
"""

import json
import re

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import ExtractorError, int_or_none, parse_iso8601, url_or_none


class KickVideoPageIE(InfoExtractor):
    IE_NAME = 'kick:vod:page'
    _VALID_URL = r'https?://(?:www\.)?kick\.com/(?P<channel>[\w-]+)/videos/(?P<id>[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12})'

    @staticmethod
    def _record(page, video_id):
        """El objeto JSON de la página que tiene "id": video_id y "recording_url"."""
        for match in re.finditer(r'"id":"%s"' % re.escape(video_id), page):
            # Retrocede hasta la llave que abre este objeto.
            depth, start = 0, None
            for i in range(match.start(), -1, -1):
                ch = page[i]
                if ch == '}':
                    depth += 1
                elif ch == '{':
                    if depth == 0:
                        start = i
                        break
                    depth -= 1
            if start is None:
                continue
            try:
                record, _ = json.JSONDecoder().raw_decode(page, start)
            except ValueError:
                continue
            if isinstance(record, dict) and 'recording_url' in record:
                return record
        return None

    def _real_extract(self, url):
        channel, video_id = self._match_valid_url(url).group('channel', 'id')
        webpage = self._download_webpage(url, video_id, impersonate=True)
        # El registro viene como JSON escapado dentro de un <script>.
        page = webpage.replace('\\"', '"').replace('\\/', '/')
        record = self._record(page, video_id)
        if not record:
            raise ExtractorError('Video unavailable: no video data in the page', expected=True)
        if record.get('status') not in (None, 'public'):
            raise ExtractorError('Private video', expected=True)
        if record.get('is_live'):
            raise ExtractorError('This video is live', expected=True)
        m3u8_url = url_or_none(record.get('recording_url'))
        if not m3u8_url:
            raise ExtractorError('Video unavailable: no recording', expected=True)

        info_channel = record.get('channel') or {}
        return {
            'id': video_id,
            'title': record.get('title') or record.get('session_title') or f'Kick {channel}',
            'duration': int_or_none(record.get('duration')),
            'timestamp': parse_iso8601(record.get('start_time')),
            'thumbnail': url_or_none((record.get('thumbnail') or {}).get('src')),
            'uploader': info_channel.get('username'),
            'channel': info_channel.get('slug') or channel,
            'is_live': False,
            'formats': self._extract_m3u8_formats(m3u8_url, video_id, 'mp4', m3u8_id='hls'),
        }
