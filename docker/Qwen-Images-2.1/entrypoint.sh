#!/bin/sh
# ComfyUI 启动入口：固定 --listen/--port（可用环境变量覆盖），
# docker run / compose 的 command 参数会原样追加到 main.py 之后，例如 --lowvram。
set -eu

cd /opt/ComfyUI

LISTEN="${COMFYUI_LISTEN:-0.0.0.0}"
PORT="${COMFYUI_PORT:-8188}"

PY="${COMFYUI_PYTHON:-}"
if [ -z "$PY" ]; then
    if command -v python >/dev/null 2>&1; then
        PY=python
    else
        PY=python3
    fi
fi

echo "[comfyui] ${PY} main.py --listen ${LISTEN} --port ${PORT} $*"

exec "$PY" main.py --listen "$LISTEN" --port "$PORT" "$@"
