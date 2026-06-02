# 文生图功能实现计划

## 概述

在现有 Tauri 应用中实现文本生成图片（SD）功能，包括：
1. sd-cli 推理框架的下载与校验（平台/显卡自动识别）
2. 文生图页面 UI 与交互逻辑
3. Rust 后端 sd-cli 进程管理与通信

---

## 一、Rust 后端改动

### 1.1 新增 `pages/model_image.rs` 模块

| Command | 描述 | 关键逻辑 |
|---------|------|----------|
| `check_sd_exists` | 检测 sd-cli 是否存在 | 在 `get_base_dir()/sd/` 目录下查找 `sd-cli.exe`(windows) 或 `sd-cli`(macos) |
| `download_and_extract_sd` | 下载并解压 sd-cli | 复用 llamacpp 下载模式：断点续传 → 解压 ZIP → macOS 设 755 权限。通过 `sd-download-progress` 事件上报进度 |
| `start_sd_generation` | 启动 sd-cli 生成图片 | 构建参数 → 创建子进程 → 实时发送日志事件 `sd-log` → 发送生成结果事件 `sd-complete` / `sd-error` |
| `stop_sd` | 停止 sd-cli 进程 | 同 `stop_model`，kill 进程并重置状态 |

#### `download_and_extract_sd` 实现要点

- 调用 `detect_hardware_for_llamacpp()`（复用 index.rs 已有的硬件检测逻辑）获取 GPU 厂商
- 根据检测结果选择下载 URL：
  - Windows + NVIDIA → `https://adm.tuduoduo.top/sd/sd-cuda.zip`
  - Windows + AMD → `https://adm.tuduoduo.top/sd/sd-vulkan.zip`
  - Windows + Intel → `https://adm.tuduoduo.top/sd/sd-vulkan.zip`
  - macOS → `https://adm.tuduoduo.top/sd/sd-macos.zip`
  - 匹配不到 → 返回错误
- 下载到 `{base_dir}/sd/.tmp_download/`，完成后解压到 `{base_dir}/sd/`
- 通过 `sd-download-progress` 事件发送 `{ status, progress }`

#### `start_sd_generation` 实现要点

参数：
- `modelId: String` — 用于查找本地模型文件
- `prompt: String` — 文生图提示词
- `width: u32` — 图片宽度（默认 1080）
- `height: u32` — 图片高度（默认 1920）

参数构建（参考 sd-cli 命令格式）：
```
{sd_cli_path} \
  --diffusion-model "{model_dir}/{diffusion_filename}" \
  --vae "{model_dir}/{vae_filename}" \
  --llm "{model_dir}/{llm_filename}" \
  -p "{prompt}" \
  --cfg-scale 1.0 \
  -v \
  --offload-to-cpu \
  --diffusion-fa \
  -H {height} \
  -W {width} \
  --steps 8
```

模型文件定位：
- `model_dir` = `{base_dir}/models/{model_id}/`
- 主模型文件：从 `model_url` 取文件名
- diffusion 模型文件：从 `model_diffusion` 取文件名（需查远程列表或本地扫描）
- vae 文件：从 `model_vae` 取文件名（同上）

需要获取远程模型列表缓存，或通过本地模型目录文件扫描来自动匹配。

进程管理：
- 复用 `app_state.rs` 中的 `running_process` / `running_model_id` 状态
- 通过 `sd-log` 事件输出实时日志
- 通过 `sd-progress` 事件输出进度（解析 sd-cli stdout 中的进度信息）
- 子进程退出时通过 `sd-complete` 或 `sd-error` 事件通知前端

### 1.2 修改 `pages/mod.rs`

添加 `pub mod model_image;` 模块声明。

### 1.3 修改 `lib.rs`

在 `invoke_handler` 注册新命令：
```rust
model_image::check_sd_exists,
model_image::download_and_extract_sd,
model_image::start_sd_generation,
model_image::stop_sd,
```

### 1.4 修改 `index.rs`（如需）

将 `detect_hardware_for_llamacpp` 和 `HardwareDetectResult` 改为 `pub` 或移动到 `common` 模块，供 `model_image.rs` 复用。

### 1.5 考虑：GPUVendor 检测逻辑提取

当前 `detect_hardware_for_llamacpp` 内部检测 GPU 的逻辑可拆为公共函数 `detect_gpu_vendor() -> Option<String>`，移到 `common/utils/platform.rs` 供多处复用。

---

## 二、前端改动

### 2.1 重写 `model_image.html`

整体结构（参考 `model_chat.html` 的进程管理 + `model_list.html` 的事件通信）：

#### 页面状态

1. **初始化状态** — 页面加载后，自动调用 `check_sd_exists` + `fetch_model_list` 获取模型信息
2. **SD 下载状态** — 如果 sd-cli 不存在，显示下载进度条
3. **就绪状态** — sd-cli 存在，显示生成界面
4. **生成中状态** — 正在生成图片，按钮禁用显示"生成中..."

#### UI 布局

```
┌──────────────────────────────────────┐
│ [← 返回]  文生图 - {model_id}       │ ← header
├──────────────────────────────────────┤
│  ┌──────────────────────────────────┐│
│  │ 文本输入框 (textarea)            ││
│  └──────────────────────────────────┘│
│  宽度: [1080]  高度: [1920]         │ ← 数字输入
│  [生成图片]  (按钮)                  │
├──────────────────────────────────────┤
│                                      │
│  ┌──────────────────────────────┐    │
│  │  生成的图片显示区域           │    │
│  │  (刚进入时显示占位文案)       │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌─── 控制台日志 ─────────────────┐  │
│  │  sd-cli 运行日志              │  │
│  └───────────────────────────────┘  │
└──────────────────────────────────────┘
```

#### 关键交互逻辑

1. **页面初始化**（`initPage`）
   - 从 URL 参数获取 `model_id`
   - 调用 `invoke("check_sd_exists")`
   - 如果不存在 → 自动调用 `invoke("download_and_extract_sd")` 并显示进度条
   - 如果存在 → 显示就绪界面

2. **点击"生成图片"**
   - 收集 prompt + width + height
   - 调用 `invoke("start_sd_generation", { modelId, prompt, width, height })`
   - 按钮变为"生成中..."并禁用
   - 监听 `sd-log` 事件显示实时日志
   - 监听 `sd-complete` 事件显示生成结果（图片路径）
   - 监听 `sd-error` 事件显示错误信息

3. **事件监听**
   - `sd-download-progress` — SD 下载进度更新
   - `sd-download-complete` — SD 下载完成
   - `sd-log` — sd-cli 实时日志
   - `sd-progress` — 生成进度百分比
   - `sd-complete` — 生成完成
   - `sd-error` — 生成出错

4. **图片显示**
   - sd-cli 生成的图片保存到本地目录，通过 Tauri 文件路径或 base64 显示

### 2.2 更新 `index.html` 事件转发

在 `index.html` 的事件转发列表中添加 sd 相关事件：
- `sd-download-progress`
- `sd-download-complete`
- `sd-log`
- `sd-progress`
- `sd-complete`
- `sd-error`

---

## 三、执行顺序

1. **Rust 后端**
   - 1a. 创建 `pages/model_image.rs` 文件
   - 1b. 修改 `pages/mod.rs` 添加模块声明
   - 1c. 修改 `lib.rs` 注册命令
   - 1d. 将 GPU 检测逻辑提取为公共函数（如需要）

2. **前端**
   - 2a. 重写 `model_image.html`
   - 2b. 修改 `index.html` 添加 sd 事件转发

3. **验证**
   - 3a. `pnpm tauri build` 确认无编译错误

---

## 四、注意事项

- sd-cli 下载逻辑严格复用 llamacpp 下载的断点续传 + 解压模式
- macOS 下 sd 目录位于用户目录（`app_data_dir`），Windows 下位于 exe 同级
- 模型文件查找：通过本地模型目录结构自动匹配 diffusion/vae/llm 文件
- sd-cli 运行需独占进程（与 llama-server 可能冲突，需在 `AppState` 中区分或使用独立状态）
- 生成图片的输出路径待定，可输出到 `{base_dir}/sd/output/` 目录，由 sd-cli 自身决定文件名