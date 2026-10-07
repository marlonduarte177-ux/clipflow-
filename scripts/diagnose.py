#!/usr/bin/env python3
"""
Diagnóstico de ClipFlow en AWS (solo lectura). Lo corre el workflow "Diagnóstico".

Muestra:
- los secretos de ClipFlow y si alguno está programado para borrarse (nunca sus valores);
- por qué se detuvieron los últimos procesadores (ECS);
- los últimos errores del procesador y de la API (CloudWatch).

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
FIELDS = ["msg", "step", "code", "error", "status", "reason", "detail", "result", "video", "stderr"]
PATTERN = '?"trabajo con error" ?"FFmpeg falló" ?"error inesperado" ?"IA no disponible" ?"IA saturada" ?"no se pudo" ?"\\"level\\":50"'


def log_errors(group: str, title: str) -> None:
    out("")
    out(f"## {title} (últimas {HOURS} h)")
    start = int((time.time() - HOURS * 3600) * 1000)
    data, err = aws("logs", "filter-log-events", "--log-group-name", group, "--start-time", str(start), "--filter-pattern", PATTERN, "--max-items", "2000")
    if err:
        out(f"- no se pudieron leer: {err}")
        return
    events = data.get("events", [])[-40:]
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


def main() -> None:
    out(f"# Diagnóstico de ClipFlow ({STAGE})")
    out("")
    secrets()
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
