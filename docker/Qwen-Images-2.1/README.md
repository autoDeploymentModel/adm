# ComfyUI + Qwen-Image-2.1-Uncensored（GGUF）Docker 镜像

基于 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + [ComfyUI-GGUF（leejet fork）](https://github.com/leejet/ComfyUI-GGUF)，
并把 [abenzerps/Qwen-Image-2.1-Uncensored-GGUF](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF)
的 **diffusion model（GGUF）、text encoder、VAE** 全部内置进镜像，开箱即用、无需下载模型。

## 镜像内容

| 内容 | 镜像内位置 | 大小 |
| --- | --- | --- |
| ComfyUI（master） | `/opt/ComfyUI` | — |
| ComfyUI-GGUF（leejet fork） | `/opt/ComfyUI/custom_nodes/ComfyUI-GGUF` | — |
| 扩散模型（GGUF） | `models/diffusion_models/qwen-image-2.1-Q4_K_M.gguf` | 4.60 GB |
| 文本编码器 | `models/text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 9.35 GB |
| VAE | `models/vae/qwen_image_2.1_vae_bf16.safetensors` | 676 MB |

镜像总体积约 20 GB（基础镜像 ~4.3 GB + Python 依赖 ~1 GB + 模型 ~14.6 GB）。

## 前置要求

- Docker 23+（默认启用 BuildKit，本 Dockerfile 使用了构建缓存挂载）
- NVIDIA GPU + 驱动（对应 CUDA 12.8）+ [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- 磁盘预留 ≥ 50 GB（构建缓存 ~15 GB + 镜像 ~20 GB）

## 构建

```bash
# 仓库根目录执行；context 为本目录（docker/Qwen-Images-2.1）
docker build -t comfyui-qwen-image-2.1:latest docker/Qwen-Images-2.1/
```

默认配置已按国内网络优化，**直接构建即可、无需任何 `--build-arg`**：

- pip 主源：腾讯云 PyPI 镜像；兜底源：官方 PyPI（主源缺包时自动回退）
- 模型下载端点：`hf-mirror.com`（HuggingFace 国内镜像）

需要换源时（示例：纯走官方 PyPI + 官方 HuggingFace）：

```bash
docker build -t comfyui-qwen-image-2.1:latest \
  --build-arg PIP_INDEX_URL=https://pypi.org/simple \
  --build-arg PIP_EXTRA_INDEX_URL=https://pypi.org/simple \
  --build-arg HF_ENDPOINT=https://huggingface.co \
  docker/Qwen-Images-2.1/
```

> **关于 pip 源**：国内镜像站对 PyPI 的同步速度不一致，ComfyUI master 的依赖版本又很新（实测 `comfyui-workflow-templates` 腾讯云已同步 `0.11.66`，阿里云只到 `0.11.63`、华为云只到 `0.11.65`），源同步滞后会让 pip 直接报 `No matching distribution found`。所以默认是「腾讯云主源 + 官方 PyPI 兜底」：主源缺包时 pip 自动从官方源补齐。
> - 官方源也不通：`--build-arg PIP_EXTRA_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`（换成你网络里可用的镜像；不想要兜底就填成与主源相同，不要置空）
> - 模型端点同理：默认 `hf-mirror.com`，国际网络用 `--build-arg HF_ENDPOINT=https://huggingface.co` 覆盖

### 用本机代理构建（最稳，一次解决全部外网访问）

本机已有可用 HTTP 代理时（如 v2rayN / Clash 的 `127.0.0.1:10809`），让 Docker 走代理最省事：**Docker Desktop → Settings → Resources → Proxies** 填 `http://127.0.0.1:10809` → Apply & Restart。此后 Docker Hub 拉镜像、git clone、pip、HF 下载全部自动走代理。

只想给单次构建传代理时——注意容器里的 `127.0.0.1` 指容器自身，必须用 `host.docker.internal` 指向宿主机：

```bash
docker build -t comfyui-qwen-image-2.1:latest \
  --build-arg http_proxy=http://host.docker.internal:10809 \
  --build-arg https_proxy=http://host.docker.internal:10809 \
  docker/Qwen-Images-2.1/
```

提示：若代理规则把国内流量也绕出去导致变慢，可加 `--build-arg no_proxy=hf-mirror.com,mirrors.cloud.tencent.com,pypi.org` 让这几个直连。

### GitHub 直连不通（`GnuTLS recv error (-110)` / `Connection reset`）

可以走上一节的代理；不用代理时**无需手动处理**：克隆步骤会按「直连 → `ghfast.top` → `ghproxy.net` → `gh-proxy.com`」依次自动重试，任一成功即继续（这三个代理的 git 协议均实测可用）。分支名写错/改名的场景也已兜底：指定分支不存在时自动改用仓库默认分支。若全部失败，改用可用地址：

```bash
docker build -t comfyui-qwen-image-2.1:latest \
  --build-arg COMFYUI_REPO=<可用的 ComfyUI 仓库地址> \
  --build-arg COMFYUI_GGUF_REPO=<可用的 ComfyUI-GGUF 仓库地址> \
  docker/Qwen-Images-2.1/
```

或换一组镜像前缀（空白分隔，同时作用于两个仓库）：`--build-arg GIT_MIRROR_PREFIXES="https://你的代理/ https://备用代理/"`

### Docker Hub 拉不动（`failed to resolve ... registry-1.docker.io` 超时）

报错出现 `docker.io/docker/dockerfile:1`（BuildKit 前端镜像）或拉取 `pytorch/pytorch` 卡住，都是 Docker Hub 直连不通导致的。本 Dockerfile 已去掉 `# syntax=` 指令（不再需要前端镜像），剩下的唯一 Docker Hub 依赖就是基础镜像，按下面任一方式解决：

**方案 1：给 Docker 配镜像加速器（推荐，一次性解决后续所有 Docker Hub 拉取）**

Docker Desktop → Settings → Docker Engine，把 `registry-mirrors` 加进 JSON 后 Apply & Restart（Linux 则改 `/etc/docker/daemon.json` 重启 docker）：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://hub.rat.dev"
  ]
}
```

验证：`docker pull pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime` 能拉下来即可。以上均为第三方加速站（编写时 4 个都可达），时效性不定，失效就删掉/换新。

**方案 2：给基础镜像加镜像站前缀（不想改 daemon 配置时）**

```bash
docker build -t comfyui-qwen-image-2.1:latest \
  --build-arg PYTORCH_IMAGE=docker.m.daocloud.io/pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime \
  docker/Qwen-Images-2.1/
```

**方案 3：让 Docker Desktop 走代理**：Settings → Resources → Proxies 配置 HTTPS 代理。

### 可覆盖的构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `PYTORCH_IMAGE` | `pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime` | 基础镜像；老驱动可换 `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`；Docker Hub 不可达时加镜像站前缀（见上文） |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 模型下载端点（默认已是国内镜像，无需传参；国际网络可改 `https://huggingface.co`） |
| `HF_REPO` / `HF_REVISION` | `abenzerps/Qwen-Image-2.1-Uncensored-GGUF` / `main` | 模型仓库与版本 |
| `GGUF_FILE` | `qwen-image-2.1-Q4_K_M.gguf` | 量化档位，见下表 |
| `TE_FILE` | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 文本编码器（int8 省内存；换 bf16 需 ~17.5 GB） |
| `VAE_FILE` | `vae/qwen_image_2.1_vae_bf16.safetensors` | VAE |
| `INSTALL_MODELS` | `1` | 置 `0` 只装 ComfyUI，模型用卷挂载 |
| `PIP_INDEX_URL` | `https://mirrors.cloud.tencent.com/pypi/simple/` | pip 主源（换源见上文说明） |
| `PIP_EXTRA_INDEX_URL` | `https://pypi.org/simple` | pip 兜底源，主源缺包/滞后时自动回退 |
| `COMFYUI_REPO/REF`、`COMFYUI_GGUF_REPO/REF` | `master`（ComfyUI）/ `main`（ComfyUI-GGUF） | 源码来源与分支；指定分支不存在时自动改用远端默认分支 |
| `GIT_MIRROR_PREFIXES` | `ghfast.top` / `ghproxy.net` / `gh-proxy.com` | 克隆 GitHub 失败时的镜像前缀（空白分隔），设置后替换内置列表 |

量化档位（`GGUF_FILE` 可选项）：

| 文件 | 大小 |
| --- | --- |
| `qwen-image-2.1-Q8_0.gguf` | 7.59 GB |
| `qwen-image-2.1-Q6_K.gguf` | 5.88 GB |
| `qwen-image-2.1-Q5_K_M.gguf` | 5.22 GB |
| `qwen-image-2.1-Q4_K_M.gguf`（推荐） | 4.60 GB |
| `qwen-image-2.1-Q4_0.gguf` | 4.05 GB |

## 运行

docker compose（首次会先构建）：

```bash
docker compose -f docker/Qwen-Images-2.1/docker-compose.yml up -d
```

或直接 docker run：

```bash
docker run -d --name comfyui --gpus all -p 8188:8188 --shm-size 8g \
  -v "$PWD/docker/Qwen-Images-2.1/data/output:/opt/ComfyUI/output" \
  -v "$PWD/docker/Qwen-Images-2.1/data/user:/opt/ComfyUI/user" \
  comfyui-qwen-image-2.1:latest
```

浏览器打开 <http://localhost:8188>。
追加参数直接跟在镜像名后，例如低显存模式：`... comfyui-qwen-image-2.1:latest --lowvram`（compose 用 `command: ["--lowvram"]`）。

## 在 ComfyUI 里使用

1. 加载官方工作流模板（`image_qwen_image_2_1_t2i.json` 文生图 / `image_qwen_image_2_1_image_edit.json` 图像编辑），把 `UNETLoader` 换成 **`Unet Loader (GGUF)`**；
2. 或手动搭三个加载节点：
   - **Unet Loader (GGUF)** → `qwen-image-2.1-Q4_K_M.gguf`
   - **CLIPLoader** → `qwen3vl_8b_int8_convrot.safetensors`，`type` 选 `qwen_image`
   - **VAELoader** → `qwen_image_2.1_vae_bf16.safetensors`

显存建议（模型卡推荐）：扩散模型放显存、文本编码器放内存 —— 显存不足时加 `--lowvram`，文本编码器即改为在 CPU 上运行，几乎不影响出图速度。

## 构建缓存与体积管理

- 模型下载缓存在 BuildKit 的 `/var/cache/comfy-models`，配合仓库 `SHA256SUMS` 校验与 aria2c 断点续传：构建中断后**重新执行同一条 docker build 不会重下已完成的文件**；
- 清理下载缓存：`docker builder prune`（会释放 ~15 GB）；
- 想复用宿主机已有模型：挂载 `-v /path/to/models:/opt/ComfyUI/models`，或用 `INSTALL_MODELS=0` 构建瘦镜像。

## 常见问题

- **`Unknown model architecture!`**：说明用的是旧版 `city96/ComfyUI-GGUF`；本镜像内置 leejet fork，可直接支持 Qwen-Image 2.1。
- **节点里选不到模型**：确认是用默认 `INSTALL_MODELS=1` 构建，且没有用空目录覆盖 `/opt/ComfyUI/models`。
- **构建中途失败**：直接重跑同一条 `docker build` 命令即可，已完成的文件会命中缓存/跳过。
- **pip 报 `No matching distribution found`**：所用 pip 镜像站同步滞后（缺 ComfyUI 新依赖版本）→ 保留默认的 `PIP_EXTRA_INDEX_URL=https://pypi.org/simple` 兜底，或换成同步完整的镜像源。
- **克隆 ComfyUI/ComfyUI-GGUF 报 `GnuTLS recv error (-110)`、`Connection reset`**：GitHub 直连被阻断 → 已内置镜像自动回退；若所有内置镜像也失败，按上文说明用 `COMFYUI_REPO` / `GIT_MIRROR_PREFIXES` 指定可用地址。
- **pip 报 `error: externally-managed-environment`**：Debian/Ubuntu 系 python 的 PEP 668 保护（新版 pytorch 镜像也是这种 python）→ 本 Dockerfile 已设 `PIP_BREAK_SYSTEM_PACKAGES=1` 解决；自己换基础镜像时保留该变量即可。构建日志里有一行 `python: x.y.z` / `torch: ...` 诊断输出：若显示 `torch: 未预装`，说明该基础镜像不含 PyTorch，构建会改从 PyPI 下载 torch（能跑但体积更大），建议用默认的 `pytorch/pytorch` 镜像。
- **老显卡驱动**：`--build-arg PYTORCH_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`（需驱动支持对应 CUDA 版本）。
