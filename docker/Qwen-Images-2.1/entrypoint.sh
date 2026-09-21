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

# 锁页内存（pinned memory）在 WSL2 的 CUDA 直通下会卡死：第二次生成时文本编码器重新 staged，
# 取权重时线程会永久阻塞在 cudaHostRegister（comfy/pinned_memory.py 的 get_pin）里 —— 表现为
# CPU/GPU 都空闲、无任何报错、队列一直停在 running。所以在 WSL 里默认关掉它（速度无影响，
# 本机实测 18s/张；动态显存 DynamicVRAM 仍然保留）。
# COMFYUI_PINNED_MEMORY：auto（默认，仅 WSL 关）/ 0（所有平台都关）/ 1（强制保留）
PINNED_MEMORY="${COMFYUI_PINNED_MEMORY:-auto}"
EXTRA_ARGS=""
WSL_DETECTED=0
if [ -e /usr/lib/wsl/lib/libcuda.so ] || grep -qi microsoft /proc/version 2>/dev/null; then
    WSL_DETECTED=1
fi
case "$PINNED_MEMORY" in
    1|true|yes|on)
        ;;
    *)
        if [ "$WSL_DETECTED" = "1" ] || [ "$PINNED_MEMORY" = "0" ] || [ "$PINNED_MEMORY" = "false" ]; then
            case " $* " in
                *" --disable-pinned-memory "*) ;;
                *)
                    EXTRA_ARGS="--disable-pinned-memory"
                    echo "[comfyui] 已追加 --disable-pinned-memory（WSL2 下 cudaHostRegister 会导致第二次生成卡死；COMFYUI_PINNED_MEMORY=1 可强制保留）"
                    ;;
            esac
        fi
        ;;
esac

echo "[comfyui] 提示：左侧「工作流」里有内置的 adm-qwen-image-2.1-t2i（文生图）与 adm-qwen-image-2.1-image-edit（图生图/改图）"
echo "[comfyui] ${PY} main.py --listen ${LISTEN} --port ${PORT} ${EXTRA_ARGS} $*"

exec "$PY" main.py --listen "$LISTEN" --port "$PORT" $EXTRA_ARGS "$@"
