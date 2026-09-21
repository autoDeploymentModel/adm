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

# 内置工作流：装载到用户目录（已存在则不覆盖，尊重用户自己的修改）
SEED_DIR=/opt/ComfyUI/adm-workflows
if [ -d "$SEED_DIR" ]; then
    mkdir -p /opt/ComfyUI/user/default/workflows
    for f in "$SEED_DIR"/*.json; do
        [ -e "$f" ] || continue
        name="$(basename "$f")"
        if [ ! -e "/opt/ComfyUI/user/default/workflows/$name" ]; then
            cp "$f" "/opt/ComfyUI/user/default/workflows/$name"
            echo "[comfyui] 已装载内置工作流: $name"
        fi
    done
fi

# 首次启动跳过新手引导（否则前端会自动弹出模板对话框 —— 模板入口已在构建时移除）
SETTINGS_FILE=/opt/ComfyUI/user/default/comfy.settings.json
if [ ! -e "$SETTINGS_FILE" ]; then
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    printf '{\n  "Comfy.TutorialCompleted": true\n}\n' > "$SETTINGS_FILE"
    echo "[comfyui] 已写入默认界面设置（跳过新手引导）"
fi

echo "[comfyui] 提示：左侧「工作流」里有内置的 adm-qwen-image-2.1-t2i（文生图）与 adm-qwen-image-2.1-image-edit（图生图/改图）"
echo "[comfyui] ${PY} main.py --listen ${LISTEN} --port ${PORT} $*"

exec "$PY" main.py --listen "$LISTEN" --port "$PORT" "$@"
