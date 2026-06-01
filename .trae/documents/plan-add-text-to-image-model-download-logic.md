# 计划：新增文本生成图片模型连续下载3个文件的判断逻辑

## 背景

当前 `RemoteModel` 结构体中 `model_diffusion` 和 `model_vae` 字段仅在示例 JSON 文件中存在，但 Rust 后端和前端均未使用。对于 `model_type` 为 `"文本生成图片"` 的模型，需要连续下载 3 个文件：`model_url`（主模型）、`model_diffusion`（扩散模型）、`model_vae`（VAE 模型）。

## 修改步骤

### Step 1: 向 `RemoteModel` 结构体添加 `model_diffusion` 和 `model_vae` 字段

**文件**: `src-tauri/src/common/types.rs`

- 在 `model_mmproj` 字段之后，添加两个新字段：
  - `#[serde(default)] pub model_diffusion: Option<String>`
  - `#[serde(default)] pub model_vae: Option<String>`
- 使用 `#[serde(default)]` 确保旧版 JSON（不含这些字段）仍然能正确反序列化

### Step 2: 修改 `scan_local_models` 支持扫描非 .gguf 文件

**文件**: `src-tauri/src/pages/model_list.rs`

- 当前逻辑只扫描 `.gguf` 后缀的文件。VAE 模型文件可能是 `.safetensors` 格式，需要修改为扫描所有非 `.part` 的文件
- 这样 `LocalModel.files` 列表中会包含扩散模型和 VAE 文件名，供前端 `isModelDownloaded` 判断

### Step 3: 更新 `download_model` 函数支持连续下载 3 个文件

**文件**: `src-tauri/src/pages/model_list.rs`

- 为 `download_model` 添加两个新参数：`model_diffusion: Option<String>` 和 `model_vae: Option<String>`
- 下载顺序：
  1. 主模型：`model_url`（现有逻辑，保持不变）
  2. 扩散模型：如果 `model_diffusion` 存在且 `model_type == "文本生成图片"`
  3. VAE 模型：如果 `model_vae` 存在且 `model_type == "文本生成图片"`
- 扩散模型和 VAE 模型的下载逻辑复用现有 mmproj 的下载模式：
  - URL 镜像替换（huggingface.co → hf-mirror.com）
  - 从 URL 提取文件名
  - 支持 .part 断点续传
  - 流式下载 + 进度上报
  - 下载完成后重命名
- 进度事件 `type` 字段：
  - 主模型：`"model"`（现有）
  - 扩散模型：`"diffusion"`
  - VAE 模型：`"vae"`

### Step 4: 前端 — 渲染下载按钮时传递新字段

**文件**: `src/model_list.html`

- 在渲染下载按钮时，为 `data-*` 属性添加：
  - `data-model-diffusion`：`model.model_diffusion`
  - `data-model-vae`：`model.model_vae`
  - `data-model-type`：`model.model_type`
- 注意处理特殊字符转义

### Step 5: 前端 — 更新 `handleDownload` 函数

**文件**: `src/model_list.html`

- 从按钮 `dataset` 中读取 `modelDiffusion`、`modelVae`、`modelType`
- 调用 `invoke("download_model", ...)` 时传入新参数

### Step 6: 前端 — 更新下载进度事件处理

**文件**: `src/model_list.html`

- 新增下载状态跟踪：
  - `downloadingDiffusion`：跟踪扩散模型下载进度
  - `downloadingVae`：跟踪 VAE 模型下载进度
- 在 `download-progress` 事件中处理 `type === "diffusion"` 和 `type === "vae"`：
  - 更新对应的下载状态
  - 更新按钮文本显示当前下载进度
- 在 `download-complete` 事件中处理 `type === "diffusion"` 和 `type === "vae"`：
  - 更新 `localModels` 中的文件列表
  - 如果所有文件都下载完毕，更新按钮状态为"已下载"
  - 如果还有后续文件需要下载，自动触发下一个文件的下载状态

### Step 7: 前端 — 更新 `isModelDownloaded` 函数

**文件**: `src/model_list.html`

- 当 `model.model_type === "文本生成图片"` 时：
  - 检查主模型文件 `{model_id}.gguf` 是否存在
  - 从 `model.model_diffusion` URL 提取文件名，检查是否存在于 `local.files`
  - 从 `model.model_vae` URL 提取文件名，检查是否存在于 `local.files`
  - 三个文件都存在才返回 `true`

### Step 8: 更新开发文档

**文件**: `dev_doc.md`

- 记录新增的文本生成图片模型三文件下载功能
- 记录新增的 `model_diffusion` 和 `model_vae` 字段
- 记录下载进度事件的新 `type` 值
