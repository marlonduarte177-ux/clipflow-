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


def billing() -> None:
    """Pagos: qué valores de Paddle le llegaron a la API (solo si están llenos, nunca su contenido)."""
    out("")
    out("## Pagos (Paddle): valores que recibió la API")
    tasks, err = aws("ecs", "list-task-definitions", "--family-prefix", f"{PREFIX}-api", "--sort", "DESC", "--max-items", "1")
    arns = (tasks or {}).get("taskDefinitionArns", [])
    if err or not arns:
        # El nombre de la familia lo pone CDK: se busca la que tenga el contenedor "api".
        listed, err = aws("ecs", "list-task-definitions", "--sort", "DESC", "--max-items", "40")
        arns = [a for a in (listed or {}).get("taskDefinitionArns", []) if "ApiTask" in a and PREFIX.replace("-", "") in a.replace("-", "")][:1]
    if not arns:
        out(f"- no se encontró la definición de la API: {err or 'sin resultados'}")
        return
    described, err = aws("ecs", "describe-task-definition", "--task-definition", arns[0])
    if err:
        out(f"- no se pudo leer: {err}")
        return
    containers = described["taskDefinition"]["containerDefinitions"]
    env = {e["name"]: e.get("value", "") for c in containers for e in c.get("environment", [])}
    secrets = {s["name"] for c in containers for s in c.get("secrets", [])}
    keys = ["BILLING_ENABLED", "PADDLE_ENVIRONMENT", "PADDLE_CLIENT_TOKEN", "PADDLE_PRICE_TRIAL_FEE",
            "PADDLE_PRICE_BASIC", "PADDLE_PRICE_PRO", "PADDLE_PRICE_MAX", "PADDLE_PORTAL_URL", "BILLING_FREE_EMAILS"]
    for k in keys:
        if k not in env:
            out(f"- `{k}`: no existe (falta desplegar esta versión)")
        elif k in ("BILLING_ENABLED", "PADDLE_ENVIRONMENT"):
            out(f"- `{k}`: {env[k] or 'vacío'}")
        else:
            v = env[k]
            ok = bool(v) and (not k.startswith("PADDLE_PRICE") or v.startswith("pri_")) and (k != "PADDLE_CLIENT_TOKEN" or v.startswith(("test_", "live_")))
            # Los ids de precio no son secretos; aun así solo se muestra cómo empiezan (pri_, pro_, 9.99…).
            hint = f" (empieza con «{v[:4]}», debería ser «pri_»)" if v and not ok and k.startswith("PADDLE_PRICE") else ""
            out(f"- `{k}`: {'ok' if ok else ('vacío' if not v else 'formato raro' + hint)}")
    out(f"- `PADDLE_WEBHOOK_SECRET`: {'conectado a Secrets Manager' if 'PADDLE_WEBHOOK_SECRET' in secrets else 'no conectado'}")
    meta, err = aws("secretsmanager", "describe-secret", "--secret-id", f"{PREFIX}/paddle-webhook-secret")
    if not err and meta:
        out(f"- clave de avisos cambiada por última vez: {meta.get('LastChangedDate', '?')} (la API la lee al arrancar)")


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
FIELDS = ["msg", "step", "code", "error", "status", "reason", "detail", "result", "video", "clip", "section", "source", "box", "segment", "crop", "filter", "err", "stderr"]
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


def paddle_events() -> None:
    """Avisos de Paddle que llegaron a la API y qué se hizo con ellos (sin datos del cliente)."""
    out("")
    out(f"## Avisos de Paddle recibidos (últimas {HOURS} h)")
    start = int((time.time() - HOURS * 3600) * 1000)
    pattern = '?"paddle-webhook" ?"aviso de Paddle" ?"suscripción actualizada" ?"minutos del plan" ?"precio que no es de ClipFlow"'
    data, err = aws("logs", "filter-log-events", "--log-group-name", f"/clipflow/{STAGE}/api", "--start-time", str(start),
                    "--filter-pattern", pattern, "--max-items", "500")
    if err:
        out(f"- no se pudieron leer: {err}")
        return
    events = data.get("events", [])[-25:]
    if not events:
        out("- ninguno: Paddle no envió avisos a la API (revisa la URL en Paddle → Notifications)")
        return
    # Respuesta de cada aviso: el registro "request completed" lleva el mismo reqId.
    req_ids = []
    for e in events:
        try:
            rid = json.loads(e["message"]).get("reqId")
        except (json.JSONDecodeError, KeyError):
            rid = None
        if rid and rid not in req_ids:
            req_ids.append(rid)
    if req_ids:
        related, _ = aws("logs", "filter-log-events", "--log-group-name", f"/clipflow/{STAGE}/api", "--start-time", str(start),
                         "--filter-pattern", "{ " + " || ".join(f'($.reqId = "{r}")' for r in req_ids[-10:]) + " }", "--max-items", "500")
        seen = {e["eventId"] for e in events}
        events = sorted(events + [e for e in (related or {}).get("events", []) if e["eventId"] not in seen], key=lambda e: e["timestamp"])[-40:]
    for e in events:
        try:
            entry = json.loads(e["message"])
        except (json.JSONDecodeError, KeyError):
            continue
        parts = [entry.get("msg", ""), f"id={entry.get('reqId')}" if entry.get("reqId") else ""]
        for key in ("event", "status", "plan", "applied", "reason", "clave"):
            if key in entry:
                parts.append(f"{key}={entry[key]}")
        if isinstance(entry.get("req"), dict):
            parts.append(f"{entry['req'].get('method')} {entry['req'].get('url')}")
        if isinstance(entry.get("res"), dict):
            parts.append(f"respuesta={entry['res'].get('statusCode')}")
        out(f"- {when(e['timestamp'])}: " + " · ".join(str(p) for p in parts if p))


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
    billing()
    if os.environ.get("MEDIA", "true") == "true":
        media()
    stopped_tasks()
    log_errors(f"/clipflow/{STAGE}/worker", "Errores del procesador")
    log_errors(f"/clipflow/{STAGE}/api", "Errores de la API")
    paddle_events()
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
