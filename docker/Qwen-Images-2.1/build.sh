#!/bin/sh
# 一键构建镜像：自动挑「模型种子镜像」，重建时不再下载 14.6GB 模型；
# sources/ 里已有源码时（export-cache.sh 导出）克隆步骤也会自动跳过。
#
# 用法（一般直接执行即可，网络已配好）：
#   bash build.sh [镜像名:tag]        # 默认 comfyui-qwen-image-2.1:latest
#
# 网络默认配置：
#   - 除模型端点 hf-mirror.com 直连外，pip / apt / git 等全部走本机代理
#     （容器内的 127.0.0.1 是容器自身，故代理地址写成 host.docker.internal）
#   - pip 用官方 PyPI（经代理）；模型校验/下载走 hf-mirror 国内镜像（不经代理）
# 可用环境变量覆盖：
#   USE_PROXY=0 bash build.sh <tag>      关闭代理（pip 改回腾讯云镜像，全部直连）
#   PROXY=http://host.docker.internal:7890 bash build.sh <tag>   自定义代理地址
#   MODELS_SEED_IMAGE=<镜像> bash build.sh <tag>   手动指定种子镜像
# 追加的 --build-arg ... 仍会原样透传给 docker build。
#
# Windows 注意：请在 Git Bash 里执行（WSL 自带的 bash 默认找不到 docker）。
#
# 种子镜像挑选顺序：
#   1) MODELS_SEED_IMAGE 环境变量；
#   2) 本地已有的 comfyui-qwen-image-2.1 镜像中带模型的那个（上一版构建产物，零额外成本）；
#   3) models/ 目录 → 用 docker cp + commit 生成只含模型的镜像 comfyui-qwen-models:seed（一次性）；
#   4) 都没有 → 不预置，构建时联网下载。
set -eu

# ---- 网络配置 ----
USE_PROXY="${USE_PROXY:-1}"
PROXY="${PROXY:-http://host.docker.internal:10809}"
NO_PROXY_HOSTS="${NO_PROXY_HOSTS:-hf-mirror.com}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
if [ "$USE_PROXY" != "0" ]; then
    PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}"
    PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:-https://pypi.org/simple}"
else
    PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple/}"
    PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:-https://pypi.org/simple}"
fi

HERE=$(cd "$(dirname "$0")" && pwd)
TAG="${1:-comfyui-qwen-image-2.1:latest}"
if [ $# -gt 0 ]; then
    shift
fi

has_models() {
    docker run --rm --entrypoint sh "$1" -c 'ls /opt/ComfyUI/models/diffusion_models/*.gguf >/dev/null 2>&1' >/dev/null 2>&1
}

seed="${MODELS_SEED_IMAGE:-}"
if [ -z "$seed" ]; then
    for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -F 'comfyui-qwen-image-2.1' || true); do
        if has_models "$img"; then
            seed="$img"
            break
        fi
    done
fi

if [ -z "$seed" ] && [ -s "$HERE/models/qwen-image-2.1-Q4_K_M.gguf" ]; then
    base="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^pytorch/pytorch:' | head -n 1 || true)"
    if [ -n "$base" ]; then
        seed_image="comfyui-qwen-models:seed"
        echo "[build] 用 models/ 目录生成种子镜像 $seed_image（一次性，之后可直接复用）"
        cid="$(docker create --entrypoint sh "$base" \
            -c 'mkdir -p /opt/ComfyUI/models/diffusion_models /opt/ComfyUI/models/text_encoders /opt/ComfyUI/models/vae')"
        docker cp "$HERE/models/qwen-image-2.1-Q4_K_M.gguf" "$cid:/opt/ComfyUI/models/diffusion_models/"
        docker cp "$HERE/models/text_encoders/." "$cid:/opt/ComfyUI/models/text_encoders/"
        docker cp "$HERE/models/vae/." "$cid:/opt/ComfyUI/models/vae/"
        docker commit "$cid" "$seed_image" >/dev/null
        docker rm -f "$cid" >/dev/null
        seed="$seed_image"
    else
        echo "[build] 本地没有 pytorch/pytorch 基础镜像，无法从 models/ 生成种子镜像" >&2
    fi
fi

if [ -n "$seed" ]; then
    echo "[build] 模型种子镜像: $seed（本次构建不会下载模型）"
    set -- --build-arg "MODELS_SEED_IMAGE=$seed" "$@"
else
    echo "[build] 没有可用的模型种子（本地无含模型镜像、models/ 为空）→ 本次构建会联网下载模型" >&2
fi

if [ -n "$(ls -A "$HERE/sources/ComfyUI" 2>/dev/null)" ]; then
    echo "[build] 源码: 使用预置 sources/（不克隆）"
else
    echo "[build] 源码: sources/ 为空 → 构建时联网克隆 ComfyUI"
fi

echo "[build] 目标镜像: $TAG"

# ---- 组装 build-arg（放在用户透传参数之前，用户仍可用同名 --build-arg 覆盖）----
set -- --build-arg "PIP_INDEX_URL=$PIP_INDEX_URL" \
       --build-arg "PIP_EXTRA_INDEX_URL=$PIP_EXTRA_INDEX_URL" \
       --build-arg "HF_ENDPOINT=$HF_ENDPOINT" \
       "$@"
if [ "$USE_PROXY" != "0" ]; then
    echo "[build] 网络: 走代理 $PROXY（$NO_PROXY_HOSTS 直连不走代理）；pip 官方源; 模型端点 $HF_ENDPOINT"
    set -- --build-arg "http_proxy=$PROXY" \
           --build-arg "https_proxy=$PROXY" \
           --build-arg "no_proxy=$NO_PROXY_HOSTS" \
           "$@"
else
    echo "[build] 网络: 不走代理（USE_PROXY=0）；pip 腾讯云镜像; 模型端点 $HF_ENDPOINT"
fi

exec docker buildx build --provenance=false --sbom=false "$@" -t "$TAG" "$HERE"
