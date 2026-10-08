#!/usr/bin/env python3
"""
Diagnóstico de ClipFlow en AWS (solo lectura). Lo corre el workflow "Diagnóstico".

Muestra:
- los secretos de ClipFlow y si alguno está programado para borrarse (nunca sus valores);
- por qué se detuvieron los últimos procesadores (ECS);
- los últimos errores del procesador y de la API (CloudWatch);
- medidas de los últimos videos (ffprobe: tamaño, giro, inicio del audio y de la imagen) y, en los
  últimos clips, cuándo empieza a sonar la voz frente a cuándo aparece cada subtítulo. Solo números:
  nunca imagen, sonido ni texto.

El repositorio es público y los registros de GitHub Actions también: todo lo que se imprime pasa
por `redact` (códigos de usuario/video, número de cuenta, correos, enlaces y credenciales).
"""
import json
import os
import re
import subprocess
import sys
import time

STAGE = os.environ.get("STAGE", "staging")
HOURS = max(1, min(168, int(os.environ.get("HOURS", "24") or "24")))
PREFIX = f"clipflow-{STAGE}"
SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")
lines: list[str] = []


def redact(text: str) -> str:
    text = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>", text, flags=re.I)
    text = re.sub(r"\b\d{12}\b", "<cuenta>", text)
    text = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1<credenciales>@", text)
    text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "<correo>", text)
    text = re.sub(r"(https?://[^\s?\"']+)\?[^\s\"']*", r"\1?<…>", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}", "<clave>", text)
    return text


def out(text: str = "") -> None:
    safe = redact(text)
    print(safe)
    lines.append(safe)


def aws(*args: str):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if result.returncode != 0:
        return None, redact(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "error")
    return (json.loads(result.stdout) if result.stdout.strip() else {}), None


def when(ms: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ms / 1000))


def secrets() -> None:
    out("## Secretos (solo nombres y estado, nunca valores)")
    data, err = aws("secretsmanager", "list-secrets", "--include-planned-deletion", "--filters", f"Key=name,Values={PREFIX}/")
    if err:
        out(f"- no se pudieron listar: {err}")
        return
    for s in sorted(data.get("SecretList", []), key=lambda s: s["Name"]):
        state = "⚠️ PROGRAMADO PARA BORRARSE" if s.get("DeletedDate") else "ok"
        out(f"- `{s['Name']}`: {state}")


def stopped_tasks() -> None:
    out("")
    out("## Procesadores detenidos (ECS)")
    cluster = f"{PREFIX}-workers"
    listed, err = aws("ecs", "list-tasks", "--cluster", cluster, "--desired-status", "STOPPED")
    if err:
        out(f"- no se pudieron listar: {err}")
        return
    arns = listed.get("taskArns", [])[:10]
    if not arns:
        out("- ninguno en la última hora (ECS solo los recuerda un rato)")
        return
    described, err = aws("ecs", "describe-tasks", "--cluster", cluster, "--tasks", *arns)
    if err:
        out(f"- no se pudieron leer: {err}")
        return
    for task in sorted(described.get("tasks", []), key=lambda t: str(t.get("stoppedAt", "")), reverse=True):
        exits = ", ".join(
            f"salida {c.get('exitCode', '?')}{(' ' + c['reason']) if c.get('reason') else ''}" for c in task.get("containers", [])
        )
        out(f"- {task.get('stoppedAt', '?')}: {task.get('stoppedReason', '?')} ({exits})")


# Lo que interesa de cada línea de registro (los registros son JSON de pino).
FIELDS = ["msg", "step", "code", "error", "status", "reason", "detail", "result", "video", "clip", "section", "source", "box", "segment", "crop", "filter", "stderr"]
PATTERN = '?"aviso de Paddle" ?"trabajo con error" ?"FFmpeg falló" ?"error inesperado" ?"IA no disponible" ?"IA saturada" ?"no se pudo" ?"\\"level\\":50"'


def log_errors(group: str, title: str) -> None:
    out("")
    out(f"## {title} (últimas {HOURS} h)")
    start = int((time.time() - HOURS * 3600) * 1000)
    data, err = aws("logs", "filter-log-events", "--log-group-name", group, "--start-time", str(start), "--filter-pattern", PATTERN, "--max-items", "2000")
    if err:
        out(f"- no se pudieron leer: {err}")
        return
    events = data.get("events", [])[-15:]
    if not events:
        out("- sin errores")
        return
    for e in events:
        try:
            entry = json.loads(e["message"])
        except (json.JSONDecodeError, KeyError):
            out(f"- {when(e['timestamp'])}: {e.get('message', '')[:500]}")
            continue
        parts = []
        for key in FIELDS:
            if key in entry and entry[key] not in (None, ""):
                value = entry[key] if isinstance(entry[key], str) else json.dumps(entry[key], ensure_ascii=False)
                parts.append(f"{key}={value[-900:] if key == 'stderr' else value[:400]}")
        out(f"- {when(e['timestamp'])}: " + " · ".join(parts))


def newest(bucket: str, prefix: str, suffix: str, count: int) -> list[str]:
    data, err = aws("s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix, "--max-items", "5000")
    if err or not data:
        out(f"- no se pudieron listar: {err}")
        return []
    objs = [o for o in data.get("Contents", []) if o["Key"].endswith(suffix)]
    return [o["Key"] for o in sorted(objs, key=lambda o: o["LastModified"], reverse=True)[:count]]


def presign(bucket: str, key: str) -> str:
    return subprocess.run(["aws", "s3", "presign", f"s3://{bucket}/{key}", "--expires-in", "900"], capture_output=True, text=True).stdout.strip()


def ffprobe(url: str, *args: str):
    r = subprocess.run(["ffprobe", "-v", "error", "-of", "json", *args, url], capture_output=True, text=True, timeout=180)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def originals(bucket: str) -> None:
    out("")
    out("## Últimos videos originales (medidas)")
    for key in newest(bucket, "originals/", "", 4):
        url = presign(bucket, key)
        info = ffprobe(url, "-show_entries", "format=duration,start_time:stream=index,codec_type,codec_name,width,height,coded_width,coded_height,sample_aspect_ratio,start_time,duration,pix_fmt:stream_side_data=rotation")
        if not info:
            out(f"- `{key.split('/')[-1]}`: no se pudo leer")
            continue
        fmt = info.get("format", {})
        out(f"- video ({float(fmt.get('duration', 0)):.0f} s, inicio {fmt.get('start_time')}):")
        for st in info.get("streams", []):
            rot = [d.get("rotation") for d in st.get("side_data_list", []) if "rotation" in d]
            if st.get("codec_type") == "video":
                out(f"  - imagen #{st.get('index')}: {st.get('codec_name')} {st.get('width')}x{st.get('height')} (codificado {st.get('coded_width')}x{st.get('coded_height')}) sar={st.get('sample_aspect_ratio')} {st.get('pix_fmt')} giro={rot or 0} inicio={st.get('start_time')}")
            elif st.get("codec_type") == "audio":
                out(f"  - audio #{st.get('index')}: {st.get('codec_name')} inicio={st.get('start_time')}")
            else:
                out(f"  - otra pista #{st.get('index')}: {st.get('codec_type')} {st.get('codec_name')}")
        # Tamaño real de los fotogramas en varios puntos (si cambia a mitad, el recorte falla).
        dur = float(fmt.get("duration", 0) or 0)
        sizes = []
        for at in [0, dur * 0.25, dur * 0.5, dur * 0.75]:
            fr = ffprobe(url, "-select_streams", "v:0", "-read_intervals", f"{at:.1f}%+#1", "-show_entries", "frame=width,height")
            f0 = (fr or {}).get("frames", [{}])
            sizes.append(f"{at:.0f}s→{f0[0].get('width')}x{f0[0].get('height')}" if f0 else f"{at:.0f}s→?")
        out(f"  - fotogramas: {', '.join(sizes)}")


def speech_starts(url: str) -> list[float]:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", url, "-vn", "-af", "silencedetect=n=-32dB:d=0.35", "-f", "null", "-"], capture_output=True, text=True, timeout=300)
    return [float(m) for m in re.findall(r"silence_end: ([\d.]+)", r.stderr)]


def cue_starts(vtt: str) -> list[float]:
    def sec(t: str) -> float:
        parts = t.replace(",", ".").split(":")
        return sum(float(x) * 60 ** i for i, x in enumerate(reversed(parts)))
    return [sec(m) for m in re.findall(r"^([\d:.,]+) -->", vtt, flags=re.M)]


def clips(bucket: str) -> None:
    out("")
    out("## Últimos clips: ¿cuándo suena la voz y cuándo aparece cada subtítulo? (segundos)")
    for key in newest(bucket, "clips/", ".mp4", 3):
        sub_key = "subtitles/" + key[len("clips/"):-4] + ".vtt"
        url = presign(bucket, key)
        vtt = subprocess.run(["curl", "-sf", presign(bucket, sub_key)], capture_output=True, text=True).stdout
        cues = cue_starts(vtt)[:12]
        voice = speech_starts(url)[:12]
        out(f"- clip: subtítulos empiezan en {[round(c, 2) for c in cues]}")
        out(f"        la voz empieza (tras silencio) en {[round(v, 2) for v in voice]}")
        # Para cada inicio de voz, el subtítulo más cercano: la diferencia típica es el desfase.
        diffs = sorted(min((c - v for c in cues), key=abs) for v in voice if cues)
        if diffs:
            out(f"        desfase típico subtítulo−voz: {diffs[len(diffs) // 2]:+.2f} s (positivo = el subtítulo llega tarde)")


def media() -> None:
    who, err = aws("sts", "get-caller-identity")
    if err:
        out(f"- no se pudo leer la cuenta: {err}")
        return
    bucket = f"{PREFIX}-media-{who['Account']}"
    originals(bucket)
    clips(bucket)


def main() -> None:
    out(f"# Diagnóstico de ClipFlow ({STAGE})")
    out("")
    secrets()
    if os.environ.get("MEDIA", "true") == "true":
        media()
    stopped_tasks()
    log_errors(f"/clipflow/{STAGE}/worker", "Errores del procesador")
    log_errors(f"/clipflow/{STAGE}/api", "Errores de la API")
    if SUMMARY:
        with open(SUMMARY, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    # También como avisos (anotaciones) del workflow: se leen desde la API de GitHub sin descargar
    # el registro completo. Como mucho 10 avisos por paso, en trozos.
    text = "\n".join(lines)
    chunks = [text[i : i + 3500] for i in range(0, len(text), 3500)][:10]
    for n, chunk in enumerate(chunks, 1):
        body = chunk.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::notice title=Diagnóstico {n}/{len(chunks)}::{body}")


if __name__ == "__main__":
    sys.exit(main())
