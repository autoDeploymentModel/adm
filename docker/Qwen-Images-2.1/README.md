# ComfyUI + Qwen-Image-2.1-Uncensored（GGUF）Docker 镜像

基于 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + [ComfyUI-GGUF（leejet fork）](https://github.com/leejet/ComfyUI-GGUF)，
并把 [abenzerps/Qwen-Image-2.1-Uncensored-GGUF](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF)
的 **diffusion model（GGUF）、text encoder、VAE** 全部内置进镜像，开箱即用、无需下载模型；
另内置**文生图 / 图生图（改图）**两份可直接运行的工作流，并移除前端「模板」入口（详见下文）。

## 镜像内容

| 内容 | 镜像内位置 | 大小 |
| --- | --- | --- |
| ComfyUI（master） | `/opt/ComfyUI` | — |
| ComfyUI-GGUF（leejet fork） | `/opt/ComfyUI/custom_nodes/ComfyUI-GGUF` | — |
| 扩散模型（GGUF） | `models/diffusion_models/qwen-image-2.1-Q4_K_M.gguf` | 4.60 GB |
| 文本编码器 | `models/text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 9.35 GB |
| VAE | `models/vae/qwen_image_2.1_vae_bf16.safetensors` | 676 MB |
| 内置工作流（文生图 / 图生图） | `/opt/ComfyUI/adm-workflows`（启动时装载到 `user/default/workflows/`） | — |

镜像总体积约 20 GB（基础镜像 ~4.3 GB + Python 依赖 ~1 GB + 模型 ~14.6 GB）。

界面侧在构建时做了三件事：**官方模板库裁剪**为只剩 Qwen-Image-2.1 的文生图 / 图像编辑两条（并改写为使用内置 GGUF 模型）、**移除前端「模板」入口**（侧栏按钮 + 顶部菜单项）、**默认跳过新手引导** —— 详见「在 ComfyUI 里使用」。

## 前置要求

- Docker 23+（默认启用 BuildKit，本 Dockerfile 使用了构建缓存挂载）
- NVIDIA GPU + 驱动（对应 CUDA 12.8）+ [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- 磁盘预留 ≥ 50 GB（构建缓存 ~15 GB + 镜像 ~20 GB）；若用本地缓存免下载（见「构建」），另加 ~15 GB 放 `models/`

## 构建

### 推荐：一键脚本（复用本地缓存，不重下模型、不重新克隆）

```bash
# ① 准备本地缓存（已有则跳过）：模型 → models/、ComfyUI 源码 → sources/
#    本地有带模型的镜像就直接导出，没有就用镜像里的脚本联网下载
bash docker/Qwen-Images-2.1/export-cache.sh

# ② 构建：自动挑「模型种子镜像」+ 使用 sources/，模型与源码都不联网
bash docker/Qwen-Images-2.1/build.sh comfyui-qwen-image-2.1:latest
```

本地没有任何镜像时，①改用 `MODE=local bash docker/Qwen-Images-2.1/export-cache.sh`：直接
git clone ComfyUI + ComfyUI-GGUF 源码到 `sources/`、用 `fetch-models.sh` 下载模型到 `models/`
（均已存在则跳过；没有 aria2c 时自动改用 curl）。之后 ②同样完全不联网。

等价的原始命令（`<上一版含模型的镜像>` 换成你本地已有的 tag）：

```bash
docker buildx build --provenance=false --sbom=false \
  --build-arg MODELS_SEED_IMAGE=<上一版含模型的镜像> \
  -t comfyui-qwen-image-2.1:latest docker/Qwen-Images-2.1/
```

### 从零构建（没有本地缓存，会联网下载模型、克隆源码）

```bash
# 仓库根目录执行；context 为本目录（docker/Qwen-Images-2.1）
docker build -t comfyui-qwen-image-2.1:latest docker/Qwen-Images-2.1/
```

默认配置已按国内网络优化，**直接构建即可、无需任何 `--build-arg`**：

- pip 主源：腾讯云 PyPI 镜像；兜底源：官方 PyPI（主源缺包时自动回退）
- 模型下载端点：`hf-mirror.com`（HuggingFace 国内镜像）

> 不想每次构建重下 14.6GB 模型：先跑一次 `bash docker/Qwen-Images-2.1/export-cache.sh` 导出本地缓存（模型 + ComfyUI 源码），之后用 `bash docker/Qwen-Images-2.1/build.sh <tag>` 构建即可 —— 模型走种子镜像、源码走 `sources/`，两样都不联网，详见「构建缓存与模型下载」。

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
| `MODELS_SEED_IMAGE` | 等于基础镜像（即无模型） | 指向含 `/opt/ComfyUI/models` 的镜像时，从该镜像快照直接拷模型：不联网、也不走构建上下文；`build.sh` 会自动挑（见「构建」与「构建缓存与模型下载」） |
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

浏览器打开 <http://localhost:8188>（ADM 桌面端里映射到 `64646`）。
追加参数直接跟在镜像名后，例如低显存模式：`... comfyui-qwen-image-2.1:latest --lowvram`（compose 用 `command: ["--lowvram"]`）。

容器启动时（entrypoint）会自动：把两份内置工作流装到 `user/default/workflows/`（同名已存在则不覆盖你的修改）、写入默认界面设置跳过新手引导、按环境变量固定监听地址与端口。

> **WSL2（Windows + Docker Desktop）会自动追加 `--disable-pinned-memory`**：该环境下 CUDA 的
> `cudaHostRegister`（锁页内存）会卡死 —— 表现为**第一次生成正常、第二次生成卡住不动**（CPU/GPU
> 都空闲、无报错、队列停在 running），卡点在文本编码器重新 staged 时取权重的驱动调用里。
> 关掉锁页内存后速度无影响（实测 18s/张），动态显存 DynamicVRAM 仍然保留。
> 需要保留锁页内存时用 `-e COMFYUI_PINNED_MEMORY=1`；想在其它平台也关掉用 `=0`。
> 若只想换一种规避方式，也可以启动时加 `--disable-dynamic-vram`（退回传统显存管理，略慢）。

## 在 ComfyUI 里使用

镜像内置两份可直接运行的工作流（容器启动时自动装载到 `user/default/workflows/`，已存在则不覆盖你的修改）：

| 工作流 | 用途 |
| --- | --- |
| `adm-qwen-image-2.1-t2i` | 文生图 |
| `adm-qwen-image-2.1-image-edit` | 图生图 / 改图（参考图 + 指令编辑） |

1. 打开 <http://localhost:8188>（ADM 桌面端映射到 `64646`），在左侧 **「工作流」** 列表里选对应工作流；
2. 填提示词（图生图再放参考图）→ 运行。首次运行要加载 4.6GB 的 GGUF 模型，需要等一会儿。

> 本镜像只带 Qwen-Image-2.1 一套模型：GGUF 扩散模型（`qwen-image-2.1-Q4_K_M.gguf`）+ `qwen3vl_8b_int8_convrot` 文本编码器 + Qwen VAE。
> 构建时已把官方模板库裁剪为只剩 Qwen-Image-2.1 的文生图 / 图像编辑两条并改写为 GGUF 节点，同时**移除前端「模板」入口**（侧栏按钮 + 顶部菜单项）并默认跳过新手引导 —— 只需用「工作流」列表即可，不会再撞上其它模型家族的"缺失模型 / 无效输入"。

手动搭节点的话用这三个：

- **Unet Loader (GGUF)** → `qwen-image-2.1-Q4_K_M.gguf`
- **CLIPLoader** → `qwen3vl_8b_int8_convrot.safetensors`，`type` 选 `qwen_image`
- **VAELoader** → `qwen_image_2.1_vae_bf16.safetensors`

显存建议（模型卡推荐）：扩散模型放显存、文本编码器放内存 —— 显存不足时加 `--lowvram`，文本编码器即改为在 CPU 上运行，几乎不影响出图速度。

## 推送到镜像仓库（阿里云 ACR 等）

构建时加 `--provenance=false --sbom=false` 关掉 BuildKit 的 attestation 证明清单：部分仓库（如阿里云 ACR 个人版）不认清单里的 `application/vnd.oci.empty.v1+json`，推送会报 `unknown manifest class for application/vnd.oci.empty.v1+json`（此时层其实都传完了，只差清单）。

```bash
REGISTRY=crpi-xxxxxxxx.cn-shenzhen.personal.cr.aliyuncs.com/adm1

docker login "$REGISTRY"

# 构建：用一键脚本（自动挑模型种子镜像 + 复用 sources/，不会重下模型；tag 自己换）
bash docker/Qwen-Images-2.1/build.sh "$REGISTRY/comfyui-qwen-image-2.1:20260922b"

# 推送（首次较慢，之后只补传缺失层）
docker push "$REGISTRY/comfyui-qwen-image-2.1:20260922b"
```

不想用脚本时，把上面的构建换成（同样关掉 provenance/SBOM；模型不会重下，仅做一次 SHA 校验）：

```bash
docker buildx build --provenance=false --sbom=false \
  --build-arg MODELS_SEED_IMAGE=<上一版含模型的镜像> \
  -t "$REGISTRY/comfyui-qwen-image-2.1:20260922b" \
  docker/Qwen-Images-2.1/
```

如果已经有一版完整镜像、只是推送卡在 attestation 报错上，**不必重新构建**：直接重打 tag 后按平台推送，attestation 清单不会带上去，且已上传的层会秒过：

```bash
docker tag comfyui-qwen-image-2.1:20260921 "$REGISTRY/comfyui-qwen-image-2.1:20260921"
docker push --platform linux/amd64 "$REGISTRY/comfyui-qwen-image-2.1:20260921"
```

（`docker push --platform` 需要 Docker CLI ≥ 25）

备选：一步构建 + 直推仓库，并使用 Docker 版清单格式（兼容性最好；配合 `--build-arg MODELS_SEED_IMAGE=...` 同样不会重下模型）：

```bash
docker buildx build --provenance=false --sbom=false \
  --output type=registry,oci-mediatypes=false \
  -t "$REGISTRY/comfyui-qwen-image-2.1:20260922b" \
  docker/Qwen-Images-2.1/
```

注：镜像约 20 GB，首次推送到 ACR 较慢；重复推送只补传缺失层。

## 目录与文件

| 文件 | 说明 |
| --- | --- |
| `Dockerfile` | 镜像定义（多阶段：`models_seed` 阶段用于从本地镜像直接拷模型） |
| `build.sh` | 一键构建：自动挑模型种子镜像 + 复用 `sources/` |
| `export-cache.sh` | 准备本地缓存 `models/`、`sources/`：已有则跳过；否则优先从本地镜像导出，没有就用镜像内的脚本联网下载 |
| `fetch-models.sh` | 模型下载脚本（SHA256SUMS 校验、aria2c 断点续传；有预置文件时跳过） |
| `clone-repo.sh` | 源码克隆脚本（GitHub 镜像自动回退；有预置 `sources/` 时直接拷贝） |
| `entrypoint.sh` | 启动脚本：装载内置工作流、写默认界面设置、固定监听地址与端口 |
| `prepare-templates.py` | 构建时裁剪并改写官方模板库（只留 Qwen-Image-2.1 两条） |
| `prepare-frontend.py` | 构建时移除前端「模板」入口（侧栏按钮 + 顶部菜单项） |
| `workflows/` | 两份内置工作流（文生图 / 图生图），构建时打进镜像 |
| `docker-compose.yml` | 运行示例 |
| `models/`、`sources/` | 本地缓存（`.gitignore` 忽略，可随时删） |

## 构建缓存与模型下载

**结论：想每次重建都不再下载模型、不再克隆源码，用一键脚本即可**（缓存导出一次，长期有效）：

```bash
# 1) 准备本地缓存（已有则跳过）：模型 → models/（~14.6GB），ComfyUI 源码 → sources/（~60MB）
#    本地有带模型的镜像就直接导出（纯本地拷贝）；没有就用镜像里的脚本联网下载
bash docker/Qwen-Images-2.1/export-cache.sh

# 2) 构建：自动挑「模型种子镜像」，源码直接用 sources/
bash docker/Qwen-Images-2.1/build.sh crpi-2210nfcb9oezh8zh.cn-shenzhen.personal.cr.aliyuncs.com/adm1/comfyui-qwen-image-2.1:20260922b
```

不想用脚本时，等价的手动命令（把 `<上一版含模型的镜像>` 换成你本地已有的 tag）：

```bash
docker buildx build --provenance=false --sbom=false \
  --build-arg MODELS_SEED_IMAGE=<上一版含模型的镜像> \
  -t <新 tag> docker/Qwen-Images-2.1/
```

### 为什么以前每次构建都要重下模型

模型的下载缓存挂在 BuildKit 的 `/var/cache/comfy-models`（`RUN --mount=type=cache`）。它**不在镜像层里**，下面任何一件事都会让它消失，下次构建就得重新下 14.6GB：

- 跑了 `docker builder prune` / `docker system prune`（清构建缓存）；
- 磁盘紧张时被 BuildKit 自动回收（缓存挂载 usage count 为 0，是优先回收对象）；
- 改了 Dockerfile 里模型步骤之前的任何一步（apt / 克隆 / pip / 模板补丁都算），这一步失效重跑；
- 换了 builder（不同 buildx 实例，或 Docker Desktop 换过数据盘）。

### 现在的两层保障

1. **种子镜像（首选）**：`MODELS_SEED_IMAGE` 指向任何含 `/opt/ComfyUI/models` 的镜像（如上一版构建产物），走镜像快照 —— **零上下文传输、零网络**。`build.sh` 会自动挑本地带模型的 `comfyui-qwen-image-2.1` 镜像；没有的话用 `models/` 目录现场生成 `comfyui-qwen-models:seed`。
2. **本地目录缓存**：`models/`（模型）+ `sources/`（ComfyUI 本体与 custom_nodes，供克隆步骤直接拷贝、不联网）。两者都在 `.gitignore` 里（不入库），删掉即回到「联网下载 / 克隆」的行为。

> `models/` **故意不放进构建上下文**（`.dockerignore` 已排除）：构建上下文每次都要整体传给 builder，实测 14.6GB 要传 ~16 分钟，比重新下载还慢。
>
> 仍然需要联网的步骤：apt 装系统包、pip 装 Python 包（有 pip 缓存挂载）、以及 `sources/` 为空时的 git clone。

其他相关：

- 释放下载缓存：`docker builder prune`（约 15 GB）；
- 复用宿主机已有模型跑容器（不打进镜像）：`-v /path/to/models:/opt/ComfyUI/models`，或用 `INSTALL_MODELS=0` 构建瘦镜像；
- 只在本机重打 tag / 复用已有镜像：可以完全不构建（见上文「推送到镜像仓库」的免重建推送）。

## 常见问题

- **每次构建都在重新下载 14.6GB 模型**：模型的下载缓存挂在 BuildKit 缓存挂载里（不属于镜像层），清构建缓存、磁盘紧张被回收、改动模型步骤之前的 Dockerfile 步骤都会让它重下 → 先 `bash docker/Qwen-Images-2.1/export-cache.sh` 导出本地缓存，再用 `bash docker/Qwen-Images-2.1/build.sh <tag>` 构建（自动用上一版镜像/缓存当种子），详见「构建缓存与模型下载」。
- **推送报 `unknown manifest class for application/vnd.oci.empty.v1+json`**：BuildKit 的 attestation 清单被仓库拒绝 → 见上文「推送到镜像仓库」，构建时加 `--provenance=false --sbom=false`。
- **「模板」入口 / 模板库怎么不见了**：按设计如此 —— 构建时移除了前端「模板」入口（侧栏按钮 + 顶部菜单），模板库也裁剪为只剩 Qwen-Image-2.1 两条；直接用左侧「工作流」里的两份内置工作流即可。
- **能删掉 `models/`、`sources/` 吗**：能。删掉即回到「联网下载模型 / 克隆源码」的行为；`models/` 约 15 GB、`sources/` 约 60 MB，二者都在 `.gitignore` 里、不入库。
- **构建还需要联网吗**：apt、pip（有 pip 缓存挂载）以及 `sources/` 为空时的 git clone 需要网络；模型与源码有本地缓存时都不联网。
- **`Unknown model architecture!`**：说明用的是旧版 `city96/ComfyUI-GGUF`；本镜像内置 leejet fork，可直接支持 Qwen-Image 2.1。
- **节点里选不到模型**：确认是用默认 `INSTALL_MODELS=1` 构建，且没有用空目录覆盖 `/opt/ComfyUI/models`。
- **构建中途失败**：直接重跑同一条 `docker build` 命令即可，已完成的文件会命中缓存/跳过。
- **pip 报 `No matching distribution found`**：所用 pip 镜像站同步滞后（缺 ComfyUI 新依赖版本）→ 保留默认的 `PIP_EXTRA_INDEX_URL=https://pypi.org/simple` 兜底，或换成同步完整的镜像源。
- **克隆 ComfyUI/ComfyUI-GGUF 报 `GnuTLS recv error (-110)`、`Connection reset`**：GitHub 直连被阻断 → 已内置镜像自动回退；若所有内置镜像也失败，按上文说明用 `COMFYUI_REPO` / `GIT_MIRROR_PREFIXES` 指定可用地址。
- **pip 报 `error: externally-managed-environment`**：Debian/Ubuntu 系 python 的 PEP 668 保护（新版 pytorch 镜像也是这种 python）→ 本 Dockerfile 已设 `PIP_BREAK_SYSTEM_PACKAGES=1` 解决；自己换基础镜像时保留该变量即可。构建日志里有一行 `python: x.y.z` / `torch: ...` 诊断输出：若显示 `torch: 未预装`，说明该基础镜像不含 PyTorch，构建会改从 PyPI 下载 torch（能跑但体积更大），建议用默认的 `pytorch/pytorch` 镜像。
- **老显卡驱动**：`--build-arg PYTORCH_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`（需驱动支持对应 CUDA 版本）。
