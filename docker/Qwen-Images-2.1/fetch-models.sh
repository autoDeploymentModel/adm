#!/bin/sh
# 模型下载脚本（仅用于镜像构建阶段，安装到 /usr/local/bin/fetch-models.sh）
#
# 模型来源：https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF
#
# 特性：
#   * 幂等：已存在且 SHA256 校验通过的文件直接跳过，不重复下载；
#   * 断点续传：aria2c -c 续传半成品文件（配合 Dockerfile 的 cache 挂载，
#     构建中断后重新执行 docker build 不会从头下载十几 GB）；
#   * 完整性：以仓库自带 SHA256SUMS 为准，下载后必校验，最多重试 3 次。
set -eu

CACHE_DIR="${CACHE_DIR:-/var/cache/comfy-models}"
MODELS_DIR="${MODELS_DIR:-/opt/ComfyUI/models}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
HF_REPO="${HF_REPO:-abenzerps/Qwen-Image-2.1-Uncensored-GGUF}"
HF_REVISION="${HF_REVISION:-main}"

GGUF_FILE="${GGUF_FILE:-qwen-image-2.1-Q4_K_M.gguf}"
TE_FILE="${TE_FILE:-text_encoders/qwen3vl_8b_int8_convrot.safetensors}"
VAE_FILE="${VAE_FILE:-vae/qwen_image_2.1_vae_bf16.safetensors}"

SUMS_FILE="SHA256SUMS"

url_of() {
    printf '%s/%s/resolve/%s/%s\n' "$HF_ENDPOINT" "$HF_REPO" "$HF_REVISION" "$1"
}

hash_of() {
    awk -v f="$1" '{p = $2; sub(/^\*/, "", p)} p == f {print $1; exit}' "$CACHE_DIR/$SUMS_FILE"
}

file_size() {
    stat -c %s "$1" 2>/dev/null || echo 0
}

remote_size() {
    curl -fsIL --connect-timeout 10 --max-time 60 \
        --retry 3 --retry-delay 3 --retry-all-errors "$1" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1) == "content-length:" {n = $2} END {print n + 0}'
}

verify() {
    [ -f "$CACHE_DIR/$1" ] || return 1
    want="$(hash_of "$1")"
    [ -n "$want" ] || return 1
    got="$(sha256sum "$CACHE_DIR/$1" | cut -d ' ' -f 1)"
    [ "$got" = "$want" ]
}

fetch() {
    dest="$1"
    rel="$2"

    if verify "$rel"; then
        echo "[fetch-models] 已存在且校验通过，跳过下载: $rel"
    else
        if [ -z "$(hash_of "$rel")" ]; then
            echo "[fetch-models] 错误：$SUMS_FILE 中找不到 $rel" >&2
            return 1
        fi
        url="$(url_of "$rel")"
        mkdir -p "$CACHE_DIR/$(dirname "$rel")"
        ok=0
        for attempt in 1 2 3; do
            echo "[fetch-models] 开始下载（第 $attempt 次）: $rel"
            aria2c -c -x 8 -s 8 -k 4M --file-allocation=none \
                --auto-file-renaming=false --allow-overwrite=true \
                --max-tries=10 --retry-wait=5 \
                --console-log-level=warn --summary-interval=30 \
                --dir="$CACHE_DIR" --out="$rel" "$url" || true
            if verify "$rel"; then
                ok=1
                break
            fi
            if [ "$(file_size "$CACHE_DIR/$rel")" = "$(remote_size "$url")" ]; then
                echo "[fetch-models] 本地文件大小与远端一致但校验失败，删除后重下: $rel" >&2
                rm -f "$CACHE_DIR/$rel" "$CACHE_DIR/$rel.aria2"
            else
                echo "[fetch-models] 未下载完/校验失败，保留半成品以便续传: $rel" >&2
            fi
        done
        if [ "$ok" != "1" ]; then
            echo "[fetch-models] 下载失败: $rel（可执行 docker builder prune 清理构建缓存后重试）" >&2
            return 1
        fi
    fi

    mkdir -p "$MODELS_DIR/$dest"
    cp "$CACHE_DIR/$rel" "$MODELS_DIR/$dest/"
    echo "[fetch-models] 已安装: models/$dest/$(basename "$rel")"
}

mkdir -p "$CACHE_DIR"
echo "[fetch-models] 获取校验清单: $(url_of "$SUMS_FILE")"
curl -fsSL --connect-timeout 15 --retry 5 --retry-delay 3 --retry-all-errors \
    -o "$CACHE_DIR/$SUMS_FILE.tmp" "$(url_of "$SUMS_FILE")"
mv "$CACHE_DIR/$SUMS_FILE.tmp" "$CACHE_DIR/$SUMS_FILE"

fetch diffusion_models "$GGUF_FILE"
fetch text_encoders "$TE_FILE"
fetch vae "$VAE_FILE"

echo "[fetch-models] 完成，模型目录内容："
ls -lh "$MODELS_DIR"/*/* 2>/dev/null || true
