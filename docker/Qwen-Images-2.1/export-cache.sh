#!/bin/sh
# 准备本地缓存：模型 → models/，ComfyUI 源码 → sources/（两者都被 .gitignore 忽略、不入库）。
# 之后的构建会直接复用它们（模型走种子镜像、源码走构建上下文），不再联网下载 / 克隆。
#
# 来源按顺序自动选择，已有文件一律跳过：
#   1) 本地已有带模型的 comfyui-qwen-image-2.1 镜像  → 直接从镜像里导出（最快，纯本地拷贝）
#   2) 本地只有其它本项目镜像（如瘦身版 / 种子镜像）→ 用镜像里的脚本联网下载 / 提取源码
#   3) 一个镜像都没有，或 MODE=local             → 本地 git clone 源码 + fetch-models.sh 下载模型
#
# 用法：
#   bash export-cache.sh                    # 自动挑镜像
#   bash export-cache.sh <镜像名:tag>        # 指定镜像
#   MODE=local bash export-cache.sh         # 不借镜像，纯本地 clone + 下载（已下载的跳过）
#   FORCE=1  bash export-cache.sh            # 已有缓存也重新导出
#   MODE=download bash export-cache.sh       # 强制走「用镜像里的脚本联网下载」这一条路
set -eu

GGUF_FILE="${GGUF_FILE:-qwen-image-2.1-Q4_K_M.gguf}"
TE_FILE="${TE_FILE:-text_encoders/qwen3vl_8b_int8_convrot.safetensors}"
VAE_FILE="${VAE_FILE:-vae/qwen_image_2.1_vae_bf16.safetensors}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
HF_REPO="${HF_REPO:-abenzerps/Qwen-Image-2.1-Uncensored-GGUF}"
HF_REVISION="${HF_REVISION:-main}"
COMFYUI_REPO="${COMFYUI_REPO:-https://github.com/comfyanonymous/ComfyUI.git}"
COMFYUI_REF="${COMFYUI_REF:-master}"
COMFYUI_GGUF_REPO="${COMFYUI_GGUF_REPO:-https://github.com/leejet/ComfyUI-GGUF.git}"
COMFYUI_GGUF_REF="${COMFYUI_GGUF_REF:-main}"

HERE=$(cd "$(dirname "$0")" && pwd)
DEST="$HERE/models"
SRC="$HERE/sources"
MODE="${MODE:-auto}"

# ---- 选镜像 ----
# 带模型的项目镜像（可直接导出）> 任意本项目镜像（可借它的脚本联网下载）
pick_image() {
    if [ -n "${1:-}" ]; then
        echo "$1"
        return 0
    fi
    for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -F 'comfyui-qwen-image-2.1' | grep -v ':seed$' || true); do
        if docker run --rm --entrypoint sh "$img" -c 'ls /opt/ComfyUI/models/diffusion_models/*.gguf >/dev/null 2>&1' >/dev/null 2>&1; then
            echo "$img"
            return 0
        fi
    done
    for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'comfyui-qwen' || true); do
        if docker run --rm --entrypoint sh "$img" -c 'command -v fetch-models.sh >/dev/null 2>&1 || test -f /usr/local/bin/fetch-models.sh' >/dev/null 2>&1; then
            echo "$img"
            return 0
        fi
    done
    return 1
}

image=""
if [ "${MODE:-auto}" = "local" ]; then
    echo "[export-cache] MODE=local：不借镜像，直接在本地准备缓存"
elif image="$(pick_image "${1:-}")"; then
    echo "[export-cache] 使用镜像: $image"
else
    image=""
fi

# 本地无镜像可用（或 MODE=local）：git clone 源码 + 本地下载模型，全部幂等（已下载即跳过）
if [ -z "$image" ]; then
    # ---- 源码：ComfyUI 本体 + ComfyUI-GGUF 自定义节点（已有 .git 则跳过，不联网）----
    if [ -d "$SRC/ComfyUI/.git" ]; then
        echo "[export-cache] sources/ComfyUI 已有源码，跳过克隆"
    else
        echo "[export-cache] 克隆 ComfyUI 源码到 $SRC/ComfyUI（GitHub 不通会自动走国内镜像）"
        sh "$HERE/clone-repo.sh" "$COMFYUI_REF" "$SRC/ComfyUI" "$COMFYUI_REPO"
    fi
    GGUF_DEST="$SRC/ComfyUI/custom_nodes/ComfyUI-GGUF"
    if [ -d "$GGUF_DEST/.git" ]; then
        echo "[export-cache] sources/ComfyUI/custom_nodes/ComfyUI-GGUF 已有源码，跳过克隆"
    else
        echo "[export-cache] 克隆 ComfyUI-GGUF 源码到 $GGUF_DEST（GitHub 不通会自动走国内镜像）"
        mkdir -p "$SRC/ComfyUI/custom_nodes"
        sh "$HERE/clone-repo.sh" "$COMFYUI_GGUF_REF" "$GGUF_DEST" "$COMFYUI_GGUF_REPO"
    fi

    # ---- 模型：fetch-models.sh 幂等（SHA256 校验通过即跳过下载），SKIP_INSTALL=1 只留在缓存目录 ----
    # 落地布局与 build.sh 期望一致：models/<gguf>、models/text_encoders/…、models/vae/…
    for tool in curl sha256sum awk; do
        command -v "$tool" >/dev/null 2>&1 || { echo "[export-cache] 缺少 $tool，无法本地下载/校验模型" >&2; exit 1; }
    done
    if [ -n "${FORCE:-}" ]; then
        echo "[export-cache] FORCE=1：清理已有模型文件后重新下载"
        rm -f "$DEST/$GGUF_FILE" "$DEST/$TE_FILE" "$DEST/$VAE_FILE"
    fi
    echo "[export-cache] 本地准备模型（已存在且校验通过的文件会跳过下载）"
    CACHE_DIR="$DEST" SKIP_INSTALL=1 MODELS_DIR="$DEST" \
    HF_ENDPOINT="$HF_ENDPOINT" HF_REPO="$HF_REPO" HF_REVISION="$HF_REVISION" \
    GGUF_FILE="$GGUF_FILE" TE_FILE="$TE_FILE" VAE_FILE="$VAE_FILE" \
    sh "$HERE/fetch-models.sh"

    echo "[export-cache] 本地缓存准备完成（源码 + 模型）。下一步直接用 build.sh 构建（源码 / 模型都不再联网）："
    echo "  bash \"$HERE/build.sh\" <镜像名:tag>"
    du -sh "$DEST" "$SRC/ComfyUI" 2>/dev/null || true
    exit 0
fi

# 该镜像是否自带模型（自带则走纯本地导出，否则借它的脚本联网下载）
image_has_models=0
if [ "$MODE" != "download" ] && docker run --rm --entrypoint sh "$image" -c 'ls /opt/ComfyUI/models/diffusion_models/*.gguf >/dev/null 2>&1' >/dev/null 2>&1; then
    image_has_models=1
fi

# ---- 1) 模型（约 14.6GB）----
if [ -z "${FORCE:-}" ] && [ -s "$DEST/$GGUF_FILE" ] && [ -s "$DEST/$TE_FILE" ] && [ -s "$DEST/$VAE_FILE" ]; then
    echo "[export-cache] models/ 里已有三份模型文件，跳过（FORCE=1 可强制重来）"
elif [ "$image_has_models" = "1" ]; then
    echo "[export-cache] 从镜像导出模型到 $DEST（约 14.6GB，纯本地拷贝）"
    mkdir -p "$DEST/text_encoders" "$DEST/vae"
    cid="$(docker create "$image")"
    trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT INT TERM
    # 镜像里：models/diffusion_models/<gguf>、models/text_encoders/…、models/vae/…
    # 缓存目录（models/）用仓库里的路径：gguf 在根目录，另外两个带子目录
    docker cp "$cid:/opt/ComfyUI/models/diffusion_models/$(basename "$GGUF_FILE")" "$DEST/$GGUF_FILE"
    docker cp "$cid:/opt/ComfyUI/models/$TE_FILE" "$DEST/$TE_FILE"
    docker cp "$cid:/opt/ComfyUI/models/$VAE_FILE" "$DEST/$VAE_FILE"
    docker rm -f "$cid" >/dev/null 2>&1 || true
    trap - EXIT INT TERM
else
    echo "[export-cache] 镜像里没有模型 → 用镜像内的 fetch-models.sh 联网下载到 $DEST（已有的文件会校验后跳过）"
    mkdir -p "$DEST/text_encoders" "$DEST/vae"
    docker run --rm -v "$DEST:/cache" --entrypoint sh "$image" -c \
        'CACHE_DIR=/cache MODELS_DIR=/tmp/models SKIP_INSTALL=1 HF_ENDPOINT="'"$HF_ENDPOINT"'" HF_REPO="'"$HF_REPO"'" HF_REVISION="'"$HF_REVISION"'" \
         GGUF_FILE="'"$GGUF_FILE"'" TE_FILE="'"$TE_FILE"'" VAE_FILE="'"$VAE_FILE"'" sh /usr/local/bin/fetch-models.sh'
fi

# 校验清单（有它构建时才能不联网校验并跳过下载），失败不致命
if command -v curl >/dev/null 2>&1; then
    if curl -fsSL --connect-timeout 15 --retry 3 --retry-delay 3 --retry-all-errors \
        -o "$DEST/SHA256SUMS" "$HF_ENDPOINT/$HF_REPO/resolve/$HF_REVISION/SHA256SUMS"; then
        echo "[export-cache] 已附带校验清单 SHA256SUMS"
    else
        rm -f "$DEST/SHA256SUMS"
        echo "[export-cache] 校验清单下载失败（构建时会自行获取，可忽略）" >&2
    fi
fi

# ---- 2) 源码（ComfyUI 本体 + custom_nodes，约 60MB；排除 models / input / output / temp）----
if [ -z "${FORCE:-}" ] && [ -d "$SRC/ComfyUI/.git" ]; then
    echo "[export-cache] sources/ 里已有源码，跳过（FORCE=1 可强制重来）"
else
    echo "[export-cache] 从镜像导出源码到 $SRC/ComfyUI"
    mkdir -p "$SRC/ComfyUI"
    docker run --rm -v "$SRC:/out" --entrypoint sh "$image" -c \
        'tar -C /opt/ComfyUI --exclude=./models --exclude=./input --exclude=./output --exclude=./temp -cf - . | tar -C /out/ComfyUI -xf -'
    echo "[export-cache] 源码导出完成"
fi

echo "[export-cache] 完成。下一步直接用 build.sh 构建（模型 / 源码都不再联网）："
echo "  bash \"$HERE/build.sh\" <镜像名:tag>"
du -sh "$DEST" "$SRC/ComfyUI" 2>/dev/null || true
