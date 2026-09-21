# 注意：本文件不使用 `# syntax=` 语法指令 —— 改由 Docker 内置前端解析，
# 避免构建时从 Docker Hub 拉取 docker/dockerfile 前端镜像（国内网络常拉不动）；
# 仍需 BuildKit（Docker Desktop 默认开启）以支持 RUN --mount=type=cache。
#
# ComfyUI + ComfyUI-GGUF + Qwen-Image-2.1-Uncensored(GGUF) 一体化镜像
# 模型来源：https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF
#
# 构建（在仓库根目录执行，context 为本目录 docker/Qwen-Images-2.1）：
#   docker build -t comfyui-qwen-image-2.1:latest docker/Qwen-Images-2.1/
#
# 可用 --build-arg 覆盖的参数如下（更多示例见同目录 README.md）：
#   PYTORCH_IMAGE   基础镜像，默认 CUDA 12.8 + torch 2.11（老驱动可换 cuda12.4 版本）
#   HF_ENDPOINT     HuggingFace 端点，默认 hf-mirror.com（国际网络可换 https://huggingface.co）
#   PIP_INDEX_URL / PIP_EXTRA_INDEX_URL  pip 主源与兜底源（默认腾讯云 + 官方 PyPI，镜像源同步滞后时自动回退）
#   GIT_MIRROR_PREFIXES  克隆 GitHub 失败时的镜像前缀（默认 ghfast.top / ghproxy.net / gh-proxy.com，自动回退）
#   GGUF_FILE       量化文件，默认 Q4_K_M（可选 Q4_0 / Q5_K_M / Q6_K / Q8_0）
#   TE_FILE         文本编码器，默认 int8（省内存），可换 text_encoders/qwen3vl_8b_bf16.safetensors
#   INSTALL_MODELS  置 0 则只装 ComfyUI，不含模型（运行时用 -v 挂载 models 目录）
#   COMFYUI_REPO / COMFYUI_REF / COMFYUI_GGUF_REPO / COMFYUI_GGUF_REF  源码仓库与分支（可指向镜像站）

ARG PYTORCH_IMAGE=pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime
FROM ${PYTORCH_IMAGE}

ARG COMFYUI_REPO=https://github.com/comfyanonymous/ComfyUI.git
ARG COMFYUI_REF=master
ARG COMFYUI_GGUF_REPO=https://github.com/leejet/ComfyUI-GGUF.git
# 注意：leejet fork 的默认分支是 main（非 master）；分支不存在时脚本会自动改用远端默认分支
ARG COMFYUI_GGUF_REF=main
ARG GIT_MIRROR_PREFIXES=
ARG PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple/
ARG PIP_EXTRA_INDEX_URL=https://pypi.org/simple
ARG HF_ENDPOINT=https://hf-mirror.com
ARG HF_REPO=abenzerps/Qwen-Image-2.1-Uncensored-GGUF
ARG HF_REVISION=main
ARG GGUF_FILE=qwen-image-2.1-Q4_K_M.gguf
ARG TE_FILE=text_encoders/qwen3vl_8b_int8_convrot.safetensors
ARG VAE_FILE=vae/qwen_image_2.1_vae_bf16.safetensors
ARG INSTALL_MODELS=1

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_EXTRA_INDEX_URL=${PIP_EXTRA_INDEX_URL} \
    PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      aria2 ca-certificates curl git build-essential \
 && rm -rf /var/lib/apt/lists/*

# 克隆脚本：直连 GitHub 失败时自动回退国内镜像（ghfast.top / ghproxy.net / gh-proxy.com）
COPY --chmod=0755 clone-repo.sh /usr/local/bin/clone-repo.sh

# 1) ComfyUI 本体 + Python 依赖
RUN GIT_MIRROR_PREFIXES="${GIT_MIRROR_PREFIXES}" \
    /usr/local/bin/clone-repo.sh "${COMFYUI_REF}" /opt/ComfyUI "${COMFYUI_REPO}" \
 && mkdir -p /opt/ComfyUI/models/diffusion_models \
             /opt/ComfyUI/models/text_encoders \
             /opt/ComfyUI/models/vae \
             /opt/ComfyUI/input /opt/ComfyUI/output /opt/ComfyUI/temp /opt/ComfyUI/user

# 诊断：打印基础镜像里的 python / torch 版本（不同 pytorch 镜像的 python 环境差异较大，便于排查）
RUN for py in python python3; do \
      command -v "$py" >/dev/null 2>&1 || continue; \
      "$py" -c "import sys, platform; print('python:', sys.version.split()[0], platform.machine())"; \
      "$py" -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.version.cuda)" \
        || echo "torch: 未预装，将由 pip 按 requirements.txt 安装"; \
      break; \
    done

# 注：Debian/Ubuntu 系 python 带 PEP 668 保护（externally-managed-environment），
# 容器内安装依赖靠上面的 PIP_BREAK_SYSTEM_PACKAGES=1（conda 系 python 上该变量无副作用）
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /opt/ComfyUI/requirements.txt

# 2) GGUF 自定义节点（leejet fork：原生支持 Qwen-Image 2.1）
RUN --mount=type=cache,target=/root/.cache/pip \
    GIT_MIRROR_PREFIXES="${GIT_MIRROR_PREFIXES}" \
    /usr/local/bin/clone-repo.sh "${COMFYUI_GGUF_REF}" /opt/ComfyUI/custom_nodes/ComfyUI-GGUF "${COMFYUI_GGUF_REPO}" \
 && pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-GGUF/requirements.txt

# 3) 模型文件（GGUF 扩散模型 / 文本编码器 / VAE 一并打进镜像）
#    下载缓存挂在 /var/cache/comfy-models：构建中断重跑可断点续传，且不会重复下载已校验通过的文件
COPY --chmod=0755 fetch-models.sh /usr/local/bin/fetch-models.sh

RUN --mount=type=cache,target=/var/cache/comfy-models,id=comfy-models \
    if [ "${INSTALL_MODELS}" = "1" ]; then \
      CACHE_DIR=/var/cache/comfy-models MODELS_DIR=/opt/ComfyUI/models \
      HF_ENDPOINT="${HF_ENDPOINT}" HF_REPO="${HF_REPO}" HF_REVISION="${HF_REVISION}" \
      GGUF_FILE="${GGUF_FILE}" TE_FILE="${TE_FILE}" VAE_FILE="${VAE_FILE}" \
      sh /usr/local/bin/fetch-models.sh; \
    fi

COPY --chmod=0755 entrypoint.sh /usr/local/bin/comfyui-entrypoint.sh

WORKDIR /opt/ComfyUI

# 监听地址/端口可用环境变量覆盖；docker run 的额外参数会追加到 main.py 之后（如 --lowvram）
ENV COMFYUI_LISTEN=0.0.0.0 \
    COMFYUI_PORT=8188

EXPOSE 8188

ENTRYPOINT ["/usr/local/bin/comfyui-entrypoint.sh"]
