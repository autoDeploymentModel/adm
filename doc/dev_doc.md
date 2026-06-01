# ADM 开发文档

> ADM (Automatic Deployment Model) — llama.cpp 图形化管理桌面应用\
> 将 llama.cpp 的 CLI 启动指令通过 GUI 界面化配置，便捷部署和运行大语言模型。

***

## 文档信息

| 项目       | 值          |
| -------- | ---------- |
| 应用版本     | 0.1.8      |
| 文档版本     | 3.3        |
| Tauri 版本 | 2.11.2     |
| 最后更新     | 2026-06-01 |
| 维护者      | ADM 开发团队   |

***

## 一、项目概述

### 1.1 技术栈

| 层级       | 技术                          | 版本/说明                                           |
| -------- | --------------------------- | ----------------------------------------------- |
| 桌面框架     | Tauri                       | 2.11.2                                          |
| 后端语言     | Rust                        | 2021 edition, crate-type: staticlib+cdylib+rlib |
| 前端       | 原生 HTML/CSS/JS              | 单文件内联 CSS/JS，无框架依赖                              |
| 页面架构     | iframe 嵌入 + postMessage 通信  | 哈希路由                                            |
| 窗口模式     | 单窗口                         | 1280×768，最小 800×600                             |
| 硬件信息插件   | tauri-plugin-hwinfo         | 0.2.3                                           |
| 系统信息     | sysinfo                     | 0.33                                            |
| HTTP 客户端 | reqwest                     | 0.12 (with stream)                              |
| 异步运行时    | tokio                       | 1.x (full features)                             |
| 序列化      | serde                       | 1.0 (with derive)                               |
| 压缩       | zip + tar + flate2          | 纯 Rust 解压 ZIP/TAR.GZ                            |
| 包管理器     | pnpm                        | v9+                                             |
| 构建脚本     | Node.js (scripts/build.mjs) | 自定义构建入口                                         |

### 1.2 核心功能

| 功能              | 描述                                               |
| --------------- | ------------------------------------------------ |
| **模型列表展示**      | 从远程 JSON 获取模型列表，展示名称/大小/内存需求/工具调用/推理/图片识别支持及运行状态 |
| **模型下载**        | 进度显示、断点续传（`.part` 文件）、HuggingFace 自动替换为国内镜像      |
| **模型启动**        | 通过 CLI 调用 llama-server 启动模型，参数可视化配置              |
| **硬件监控**        | 实时显示内存/显存/CPU 信息（hwinfo 插件增强检测）                  |
| **模型交互**        | 内嵌 iframe 加载 llama-server 的 Web UI，自动轮询检测服务就绪    |
| **参数配置**        | 可视化配置 llama.cpp 启动参数，支持保存/加载/恢复默认                |
| **自动更新**        | 应用版本 → VC++ 运行库(Windows) → llamacpp 二进制（有序三重检查） |
| **llamacpp 管理** | 自动检测硬件并下载匹配的 llama-server 二进制                    |

***

## 二、架构设计

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                   Tauri 单窗口                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              index.html (主框架)                         │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │       iframe #content-frame                       │  │  │
│  │  │  ┌────────────────┐ ┌─────────────────────────┐  │  │  │
│  │  │  │ model_list     │ │ settings.html           │  │  │  │
│  │  │  │ .html          │ │ (设置页面)              │  │  │  │
│  │  │  └────────────────┘ └─────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────────────┐   │  │  │
│  │  │  │ model_chat.html (模型对话交互页)          │   │  │  │
│  │  │  └──────────────────────────────────────────┘   │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │         ↕ postMessage 父子通信                         │  │
│  │         ↕ IPC (invoke / event / emit)                 │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │         Rust 后端 (多模块架构，见 §3)                    │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │  │
│  │  │ pages/       │ │ pages/       │ │ pages/         │  │  │
│  │  │ index.rs     │ │ model_list.rs│ │ settings.rs    │  │  │
│  │  │ (硬件+更新)   │ │ (模型管理)    │ │ (配置持久化)   │  │  │
│  │  └──────┬───────┘ └──────┬───────┘ └───────┬────────┘  │  │
│  │         │                │                 │            │  │
│  │         └────────┬───────┴────────┬────────┘            │  │
│  │                  ▼                ▼                     │  │
│  │         ┌──────────────┐ ┌────────────────┐            │  │
│  │         │ common/      │ │ app_state.rs   │            │  │
│  │         │ types.rs     │ │ (全局状态)      │            │  │
│  │         │ config.rs    │ │                │            │  │
│  │         │ utils/       │ │ running_process│            │  │
│  │         │ platform.rs  │ │ running_model  │            │  │
│  │         │ archive.rs   │ │ running_port   │            │  │
│  │         └──────────────┘ │ download_prog  │            │  │
│  │                          └────────────────┘            │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           llamacpp/ (运行时获取)                         │  │
│  │  ├── windows/ → llama-server.exe / CUDA/CPU/AMD/Intel   │  │
│  │  ├── linux/   → llama-server                            │  │
│  │  └── mac/     → llama-server                            │  │
│  │  下载入口：check_update() → 自动检测硬件 → 下载对应包    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 前后端职责划分

| 职责                                  | 前端 (JS) | 后端 (Rust) |
| ----------------------------------- | ------- | --------- |
| UI 渲染与交互                            | ✅       | ❌         |
| iframe 页面路由与导航                      | ✅       | ❌         |
| 事件转发 (Tauri → postMessage → iframe) | ✅       | ❌         |
| 模型列表渲染与状态列                          | ✅       | ❌         |
| 系统信息采集                              | ❌       | ✅         |
| 文件下载（含断点续传）                         | ❌       | ✅         |
| 进程管理 (llama-server)                 | ❌       | ✅         |
| 本地模型扫描                              | ❌       | ✅         |
| .part 文件扫描                          | ❌       | ✅         |
| GPU/VRAM 检测                         | ❌       | ✅         |
| 配置文件读写                              | ❌       | ✅         |
| 远程模型列表获取                            | ❌       | ✅         |
| 应用/llamacpp 更新检查                    | ❌       | ✅         |
| llamacpp 下载和解压                      | ❌       | ✅         |

### 2.3 IPC 通信设计

#### Invoke 调用

前端通过 `window.__TAURI_INTERNALS__.invoke()` 或 `window.__TAURI__?.core?.invoke()` 调用 Rust Command。采用双兼容模式：

```javascript
// Tauri 2.x 通用获取方式 (带 parent 回退兼容 iframe)
const getInvoke = () =>
  window.__TAURI_INTERNALS__?.invoke ||
  window.__TAURI__?.core?.invoke ||
  window.__TAURI__?.invoke ||
  window.parent?.__TAURI_INTERNALS__?.invoke ||
  window.parent?.__TAURI__?.core?.invoke ||
  window.parent?.__TAURI__?.invoke;

const getListen = () =>
  window.__TAURI_INTERNALS__?.listen ||
  window.__TAURI__?.event?.listen ||
  window.__TAURI__?.listen ||
  window.parent?.__TAURI_INTERNALS__?.listen ||
  window.parent?.__TAURI__?.event?.listen ||
  window.parent?.__TAURI__?.listen;
```

> **重要**：macOS WKWebView 不会将 Tauri IPC 桥接到 iframe，因此 iframe 子页面必须通过 `window.parent` 回退获取 IPC。

#### Event 通信流

```
前端 JS ──invoke────▶  Rust Command  ──return──▶  前端 JS
前端 JS ◀──listen────  Rust Event    ──emit────▶  前端 JS
```

| 事件名                          | 触发方                                    | 载荷                                          | 说明               |
| ---------------------------- | -------------------------------------- | ------------------------------------------- | ---------------- |
| `download-progress`          | Rust `download_model()`                | `{ model_id, progress, downloaded, total, type }` | 模型下载进度更新（type: model/mmproj/diffusion/vae）         |
| `download-complete`          | Rust `download_model()`                | `{ model_id, type }`                              | 模型下载完成（type: model/mmproj/diffusion/vae）           |
| `model-started`              | Rust `start_model()`                   | `{ model_id, port }`                        | 模型启动成功           |
| `model-stopped`              | Rust (stdout/stderr 线程)                | `{ model_id }`                              | 模型进程退出           |
| `model-log`                  | Rust (stdout/stderr 线程)                | `{ model_id, line, source }`                | 模型日志行            |
| `llamacpp-download-progress` | Rust `download_and_extract_llamacpp()` | `{ status, progress }`                      | llamacpp 下载/解压进度 |

#### 主窗口 ↔ iframe 通信

```
Tauri Event (Rust → JS)
       │
       ▼
index.html 监听 Tauri 事件
       │
       ▼
iframe.contentWindow.postMessage({ type, payload }, "*")
       │
       ▼
子页面监听 window.message 事件

子页面 → 主窗口：postMessage({ type: "navigate", page: "..." })
```

***

## 三、项目目录结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档（本文件）
│   └── llamacpp.txt                  # llama.cpp 参数参考
├── scripts/                          # 构建与签名脚本
│   ├── build.mjs                     # Node.js 构建入口脚本
│   ├── fix-macos-damaged.sh          # macOS 修复损坏应用标记
│   ├── sign-macos.sh                 # macOS 代码签名
│   └── sign-windows.ps1              # Windows 代码签名
├── src/                              # 前端资源 (Tauri frontendDist)
│   ├── index.html                    # 主框架页（外壳容器 + iframe + 底部硬件信息栏）
│   ├── model_list.html               # 模型列表页（表格展示/下载/启动/停止）
│   ├── model_chat.html               # 模型对话交互页（内嵌 WebUI + 启动遮罩 + 日志面板）
│   └── settings.html                 # 设置页面（导航分栏 + 参数表单 + 版本/关于）
├── src-tauri/                        # Tauri 后端 (Rust)
│   ├── Cargo.toml                    # Rust 依赖配置
│   ├── Cargo.lock
│   ├── build.rs                      # Tauri 构建脚本（含 Windows 子系统配置）
│   ├── tauri.conf.json               # Tauri 核心配置
│   ├── capabilities/
│   │   └── default.json              # 权限配置（Tauri 2.x capability 系统）
│   ├── entitlements.plist            # macOS 沙盒授权
│   ├── icons/                        # 应用图标
│   └── src/
│       ├── main.rs                   # 入口（Windows 隐藏控制台 + adm_lib::run()）
│       ├── lib.rs                    # 模块声明 + tauri::Builder 配置 + command 注册
│       ├── app_state.rs              # AppState 全局状态定义
│       ├── common/
│       │   ├── mod.rs                # 公共模块声明
│       │   ├── types.rs              # 公共数据结构体（SystemInfo/LaunchParams/RemoteModel 等）
│       │   ├── config.rs             # 路径管理函数（目录/文件查找）
│       │   └── utils/
│       │       ├── mod.rs
│       │       ├── platform.rs       # 跨平台工具（隐藏窗口命令、GPU 检测）
│       │       └── archive.rs        # 压缩包解压（ZIP + TAR.GZ）
│       └── pages/                    # 按前端页面划分的业务模块
│           ├── mod.rs
│           ├── index.rs              # index.html 逻辑：硬件信息、更新检查、llamacpp 下载
│           ├── model_list.rs         # model_list.html 逻辑：模型扫描/下载/启停/状态
│           ├── model_chat.rs         # model_chat.html 逻辑（无独立 command，事件驱动）
│           └── settings.rs           # settings.html 逻辑：配置持久化、版本查询
├── website/                          # 项目官网资源
│   ├── index.html
│   └── images/
├── AGENTS.md                         # 项目技术栈说明
├── package.json
├── pnpm-lock.yaml
├── README.md / README_EN.md
└── .gitignore
```

### 3.1 关键运行时路径

| 路径                            | 位置规则                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `models/{model_id}.gguf`      | Windows/Linux: 与可执行文件同级下的 `models/` 目录；macOS: `~/Library/Application Support/com.adm.admapp/models/` |
| `models/{model_id}.gguf.part` | 同 `models/` 目录，下载未完成的临时文件                                                                            |
| `config.json`                 | 同 `models/` 父目录                                                                                      |
| `llamacpp/`                   | 运行时获取：优先资源目录 → 当前目录逐级向上查找 → 可执行文件同级目录                                                                |
| 前端代码组织                        | 每个 HTML 文件的 CSS 和 JS 内联在同一文件中                                                                        |

### 3.2 路径查找策略 (`common/config.rs`)

```
get_base_dir() 查找优先级：
  1. macOS: app_data_dir (~/Library/Application Support/...)
  2. 资源目录中存在 llamacpp/ → 该目录
  3. 当前目录逐级向上查找 llamacpp/ (直到根目录)
  4. 可执行文件所在目录
  5. current_dir() (最终回退)
```

***

## 四、Rust 后端模块详解

### 4.1 模块依赖关系

```
                        ┌──────────┐
                        │ lib.rs   │ (入口 + 注册)
                        └────┬─────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────────┐
    │ app_state   │   │  common/    │   │   pages/        │
    │ (全局状态)   │   │  types.rs   │   │   index.rs      │
    └─────────────┘   │  config.rs  │   │   model_list.rs │
                      │  utils/     │   │   model_chat.rs  │
                      └─────────────┘   │   settings.rs    │
                             ▲          └─────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │ 所有 pages 模块依赖 common   │
              │ pages/model_list 也依赖      │
              │ app_state                   │
              └─────────────────────────────┘
```

**依赖规则**：

- `common/` 和 `app_state.rs` 不依赖 `pages/`
- `pages/` 模块依赖 `common/` 中的类型和配置函数
- `pages/model_list.rs` 通过 `tauri::State` 注入访问 `AppState`
- `lib.rs` 统一注册所有 modules、commands、plugins

### 4.2 `lib.rs` — 入口

**职责**：模块声明、Tauri Builder 配置、插件/状态注册、Command 注册。

```rust
mod app_state;
mod common;
mod pages;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_hwinfo::init())
        .manage(AppState::new())
        .on_window_event(|window, event| {
            // 窗口关闭时清理 llama-server 进程
        })
        .invoke_handler(tauri::generate_handler![
            // pages/index.rs
            index::get_system_info,
            index::check_update,
            index::download_and_extract_llamacpp,
            // pages/model_list.rs
            model_list::scan_local_models,
            model_list::scan_part_files,
            model_list::fetch_model_list,
            model_list::download_model,
            model_list::start_model,
            model_list::stop_model,
            model_list::get_model_status,
            model_list::get_downloading_models,
            // pages/settings.rs
            settings::save_settings,
            settings::load_settings,
            settings::get_app_version,
            settings::get_llamacpp_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 4.3 `app_state.rs` — 全局状态

```
AppState {
    running_process:   Mutex<Option<u32>>           // 当前 llama-server PID
    running_model_id:  Mutex<Option<String>>        // 当前运行的模型 ID
    running_port:      Mutex<Option<u16>>           // 当前服务端口
    downloading_progress: Mutex<HashMap<String, u8>> // 所有正在下载的模型进度
    sys:               Mutex<System>                // sysinfo 系统信息缓存
}
```

| 方法                     | 说明                                 |
| ---------------------- | ---------------------------------- |
| `new()`                | 初始化所有字段为 None/空，System::new\_all() |
| `get_running_pid()`    | 获取当前进程 PID                         |
| `set_running_pid(pid)` | 设置运行中的 PID                         |
| `clear_running()`      | 清空所有运行状态（进程/模型/端口）                 |

**新增** **`downloading_progress`** **字段**：用于页面切换后恢复下载进度的百分比显示，通过 `get_downloading_models` command 暴露。

### 4.4 `common/types.rs` — 公共数据类型

| 结构体                    | 说明                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `SystemInfo`           | 系统信息返回值：RAM(总/已用)、VRAM(总/已用)、CPU 使用率/核心数                                            |
| `ModelStatus`          | 模型运行状态：是否运行、model\_id、pid、port                                                      |
| `LaunchParams`         | 模型启动参数（见 §5.5），新增 `dry_multiplier`、`dry_allowed_length`、`dry_penalty_last_n`、`presence_penalty`、`frequency_penalty`、`preset_mode` 字段 |
| `RemoteModel`          | 远程模型数据：model\_id、model\_url、model\_size、need\_ram、support\_tools/reasoning/images、model\_diffusion、model\_vae |
| `Settings`             | 用户配置包装：`{ launch_params: LaunchParams }`                                            |
| `PartFileProgress`     | 断点续传进度：model\_id、existing\_size                                                     |
| `UpdateInfo`           | 远程更新信息：版本号、llamacpp 版本、各平台下载配置                                                      |
| `UpdateCheckResult`    | 更新检查结果：应用/llamacpp 是否有更新、下载地址、VC++ 运行库状态、更新日志                                       |
| `HardwareDetectResult` | 硬件检测结果：os、gpu\_vendor、gpu\_name、nvidia\_series                                      |

### 4.5 `common/config.rs` — 路径管理

| 函数                              | 说明                                                |
| ------------------------------- | ------------------------------------------------- |
| `get_resource_dir()`            | 获取资源目录（Tauri 资源路径）                                |
| `get_exe_dir()`                 | 获取可执行文件所在目录                                       |
| `get_data_dir(app)`             | 获取数据目录（macOS 用 app\_data\_dir，其它同 exe\_dir）       |
| `get_base_dir(app)`             | 获取基础目录（按优先级查找 llamacpp 所在的基础路径）                   |
| `get_llamacpp_dir(app)`         | 获取 llamacpp 子目录 `{base_dir}/llamacpp`             |
| `get_llama_server_path(app)`    | 在 llamacpp 目录中查找 llama-server 可执行文件               |
| `find_llama_server_in_dir(dir)` | 递归在目录中寻找 llama-server(windows) 或 llama-server(其他) |

### 4.6 `common/utils/platform.rs` — 跨平台工具

| 函数                               | 说明                                                                        |
| -------------------------------- | ------------------------------------------------------------------------- |
| `create_hidden_command(program)` | Windows: 创建 `CREATE_NO_WINDOW` 命令；其他: 普通命令                                |
| `get_gpu_info()`                 | 跨平台 VRAM 检测：Windows 调用 wmic，Linux 调用 nvidia-smi，macOS 调用 system\_profiler |

### 4.7 `common/utils/archive.rs` — 压缩包解压

| 函数                                       | 说明                                    |
| ---------------------------------------- | ------------------------------------- |
| `extract_zip(archive_path, dest_dir)`    | 解压 ZIP，跳过目录，只提取文件到目标目录                |
| `extract_tar_gz(archive_path, dest_dir)` | 解压 TAR.GZ，跳过 `__MACOSX` 和 `.DS_Store` |

### 4.8 `pages/index.rs` — 主框架页面

**对应前端**：`index.html`（硬件信息栏、更新弹窗）

**Commands**：

| Command                         | 签名                                              | 说明                                              |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `get_system_info`               | `(state: State<AppState>) → Result<SystemInfo>` | 获取 RAM/VRAM/CPU 信息，调 `platform::get_gpu_info()` |
| `check_update`                  | `(app: AppHandle) → Result<UpdateCheckResult>`  | 检查应用版本、VC++ 运行库(Windows)、llamacpp 更新          |
| `download_and_extract_llamacpp` | `(app: AppHandle, url: String) → Result<()>`    | 下载并解压 llamacpp（含断点续传）                           |

**辅助函数**：

| 函数                                    | 说明                                     |
| ------------------------------------- | -------------------------------------- |
| `extract_nvidia_series(gpu_name)`     | 从 GPU 名提取 NVIDIA 系列号（RTX 3060 → 30）    |
| `detect_hardware_for_llamacpp()`      | 检测 OS/GPU 信息，返回 `HardwareDetectResult` |
| `get_llamacpp_download_url(hardware)` | 根据硬件类型返回对应的 llamacpp 下载 URL            |
| `compare_versions(current, remote)`   | 语义化版本号比较                               |
| `check_vc_redist_installed()`         | (Windows) 检测 VC++ 2015-2022 运行库是否安装  |

**VC++ 运行库检测**（仅 Windows）：
- 通过查询注册表 `HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64` 检测
- 未安装时前端提示下载 `https://aka.ms/vs/17/release/vc_redist.x64.exe`

**llamacpp 下载 URL 策略**：

| 硬件条件                         | 下载 URL             |
| ---------------------------- | ------------------ |
| macOS                        | macOS 通用包 (tar.gz) |
| Windows + NVIDIA             | CUDA 12 包 (zip)    |
| Windows + AMD                | Vulkan 包 (zip)     |
| Windows + Intel              | Vulkan 包 (zip)     |
| Windows + 其他/无 GPU           | 抛出异常提示          |

### 4.9 `pages/model_list.rs` — 模型列表页面

**对应前端**：`model_list.html`（模型表格、下载/启动/停止按钮）

**Commands**：

| Command                                     | 说明                      | 关键逻辑                                           |
| ------------------------------------------- | ----------------------- | ---------------------------------------------- |
| `scan_local_models(app)`                    | 扫描 `models/*.gguf`      | 返回已下载的 model\_id 列表                            |
| `scan_part_files(app)`                      | 扫描 `models/*.gguf.part` | 返回断点续传文件信息                                     |
| `fetch_model_list()`                        | 远程获取模型列表                | `GET https://adm.tuduoduo.top/model.json`      |
| `download_model(app, model_id, model_url, model_diffusion, model_vae)`  | 下载模型                    | 断点续传 + HuggingFace 镜像替换 + 进度事件 + AppState 进度同步。文本生成图片模型自动连续下载主模型、diffusion、vae 三个文件 |
| `start_model(app, state, model_id, params)` | 启动 llama-server         | 参数拼装 + 进程 spawn + stdout/stderr 线程 + PID 记录    |
| `stop_model(state)`                         | 停止 llama-server         | taskkill(SIGKILL) / kill -9 + 状态清空             |
| `get_model_status(state)`                   | 查询运行状态                  | 校验 PID 是否存活，僵尸进程自动清理                           |
| `get_downloading_models(state)`             | 获取所有下载中模型进度             | 用于页面切换后恢复进度显示                                  |

**下载流程**：

```
download_model(model_id, model_url, model_diffusion, model_vae)
  │
  ├── 1. huggingface.co → hf-mirror.com (自动替换)
  │
  ├── 2. 检查 final_path (.gguf) 是否存在 → 存在则直接返回完成
  │
  ├── 3. 检查 part_path (.gguf.part) 是否存在 → 获取已有字节数
  │
  ├── 4. 发起 GET 请求 (支持 Range 断点续传)
  │
  ├── 5. 流式写入 .part 文件，每块发送 download-progress 事件
  │
  ├── 6. 下载完成 → .part 重命名为 .gguf → 发送 download-complete (type: "model")
  │
  ├── 7. 如果 model_diffusion 存在 → 自动下载 diffusion 文件
  │        (相同流程，事件 type: "diffusion")
  │
  └── 8. 如果 model_vae 存在 → 自动下载 vae 文件
             (相同流程，事件 type: "vae")
```

**模型启动流程**：

```
start_model(model_id, params)
  │
  ├── 1. 检查是否有模型已在运行 → 是则返回错误
  │
  ├── 2. 查找 llama-server 可执行路径
  │
  ├── 3. 验证 model_path (.gguf) 是否存在
  │
  ├── 4. 从 LaunchParams 拼装 CLI 参数
  │
  ├── 5. spawn 子进程 (macOS 设置 DYLD_LIBRARY_PATH)
  │
  ├── 6. 记录 PID/ModelID/Port 到 AppState
  │
  ├── 7. 发送 model-started 事件
  │
  └── 8. 启动 stdout/stderr 线程 → 逐行发送 model-log 事件
         → 检测到 "listening on" 时重新发送 model-started
         → 进程退出时发送 model-stopped 事件
```

### 4.10 `pages/model_chat.rs` — 模型交互页面

**对应前端**：`model_chat.html`

**特点**：此页面**没有独立的 Tauri Command**，完全通过事件驱动 + 前端 JS 实现功能：

- URL 参数接收 `model_id` 和 `port`
- 轮询检测 `http://127.0.0.1:{port}` 服务就绪（每 1 秒，最多 2 分钟）
- 就绪后加载 iframe 显示 llama-server Web UI
- 监听 `model-log` / `model-started` / `model-stopped` 事件
- 日志面板展示

### 4.11 `pages/settings.rs` — 设置页面

**对应前端**：`settings.html`

**Commands**：

| Command                        | 说明                                         |
| ------------------------------ | ------------------------------------------ |
| `save_settings(app, settings)` | 写入 `config.json`（先写 `.tmp` 再 rename，保证原子性） |
| `load_settings(app)`           | 读取 `config.json`，不存在则返回默认值                 |
| `get_app_version(app)`         | 返回 `tauri.conf.json` 中的 version            |
| `get_llamacpp_version(app)`    | 执行 `llama-server --version`，解析输出的版本号       |

***

## 五、页面设计

### 5.1 主框架 (`index.html`)

#### 窗口配置 (`tauri.conf.json`)

```json
{
  "app": {
    "windows": [{
      "label": "main",
      "title": "ADM",
      "width": 1280,
      "height": 768,
      "center": true,
      "minWidth": 800,
      "minHeight": 600,
      "decorations": true
    }],
    "withGlobalTauri": true,
    "security": { "csp": null }
  }
}
```

#### 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│  ADM                                                  _ □ X  │  ← Tauri 原生标题栏
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │           iframe 内容区域 (model_list.html /            │  │
│  │            settings.html / model_chat.html)             │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ☰首页 │ ⚙设置 │ 内存 32GB  │ 显存 11GB(RTX 4090)  │ CPU    │  ← 底部硬件信息栏
│                                                       8C/16T │
└──────────────────────────────────────────────────────────────┘
```

#### 初始化流程

```
页面加载
  │
  ├── 1. 获取 IPC 桥接（兼容多版本 + parent 回退）
  │
  ├── 2. invoke("get_system_info") → 获取系统硬件信息
  │
  ├── 3. 尝试调用 hwinfo 插件增强检测
  │        plugin:hwinfo|get_cpu_info / get_ram_info / get_gpu_info / get_os_info
  │   → 若成功，用 hwinfo 数据覆盖 sysinfo 数据（更精确）
  │
  ├── 4. 更新底部硬件信息栏
  │
  ├── 5. 设置 Tauri 事件监听，转发给 iframe（download-progress/model-started 等）
  │
  ├── 6. 监听 message 事件，接收 iframe 子页面的 navigate 请求
  │
  └── 7. 延迟 3 秒后静默 check_update → 有新版本才弹窗
          ① 先检查系统版本更新 → 有更新则弹窗提示
          ② 用户关闭系统更新弹窗后 → 检查 VC++ 运行库（仅 Windows）
          ③ 若 VC++ 运行库未安装 → 提示下载安装
          ④ VC++ 安装完成后 → 检查 llamacpp 版本/下载
          ⑤ 若系统无更新且 VC++ 已安装 → 直接检查 llamacpp 版本/下载
```

#### 硬件信息栏

| 信息项 | 显示格式                                    | 数据来源                | 更新时机  |
| --- | --------------------------------------- | ------------------- | ----- |
| 内存  | `总内存` (如 32GB)                          | sysinfo + hwinfo 增强 | 启动时一次 |
| 显存  | `总显存 (型号)` (如 11GB RTX 4090)，无显卡显示"无显卡" | hwinfo GPU 检测       | 启动时一次 |
| CPU | `型号 物理核心C/逻辑线程T` (如 Intel i7 8C/16T)    | sysinfo + hwinfo    | 启动时一次 |

**数据优先级**：`hwinfo 插件 > sysinfo`

#### 导航处理

```javascript
// 主窗口接收子页面导航请求
window.addEventListener("message", function (event) {
  if (event.data && event.data.type === "navigate") {
    document.getElementById("content-frame").src = event.data.page;
  }
});

// 子页面发起导航请求
function navigateTo(page) {
  window.parent.postMessage({ type: "navigate", page }, "*");
}
```

### 5.2 模型列表页 (`model_list.html`)

#### 页面布局

```
┌───────────────────────────────────────────────────────────────────┐
│ 模型列表                                                          │
├───────────────────────────────────────────────────────────────────┤
│ ┌──────────┬────────┬────────┬──────────┬────────┬────────┬──────┐│
│ │ 模型名称 │模型大小│内存需求│ 工具调用 │  推理  │图片识别│状态  ││
│ ├──────────┼────────┼────────┼──────────┼────────┼────────┼──────┤│
│ │ Qwen3.5  │ 5.6GB  │ 32 GB  │  ✓ 支持  │ ✓ 支持 │ ✗ 不支持│已启动││
│ │ -9B-Q4.. │        │        │          │        │         │[停止]││
│ ├──────────┼────────┼────────┼──────────┼────────┼────────┼──────┤│
│ │ ...      │ ...    │ ...    │ ...      │ ...    │ ...    │ ...  ││
│ └──────────┴────────┴────────┴──────────┴────────┴────────┴──────┘│
└───────────────────────────────────────────────────────────────────┘
```

#### 数据源

- **远程地址**：`https://adm.tuduoduo.top/model.json`
- **获取方式**：Rust backend `fetch_model_list()` command
- **支持特性列**：`support_tools` / `support_reasoning` / `support_images`

#### 下载按钮状态机

```
                    RAM-C 不足
       ┌──────────────────────────────┐
       │                              │
       ▼                              │
┌──────────┐    RAM-C 满足    ┌──────────┐
│  不可用   │◄────────────────│  初始    │
│(disabled)│                 │(检查条件)│
└────┬─────┘                 └────┬─────┘
     │  存在 .part 文件            │ 点击下载
     │                            ▼
     │                     ┌──────────┐
     │                     │ 继续下载  │
     │                     └────┬─────┘
     │                          │ 点击下载
     │                          ▼
     │              ┌─────────────────────┐
     │              │  下载中 0%~99%      │
     │              │  (实时更新进度)     │
     │              └──────────┬──────────┘
     │                         │ 下载完成
     │                         ▼
     └───────────────────┌──────────┐
                         │  已下载  │
                         │(disabled)│
                         └──────────┘
```

#### 启动按钮状态机

```
                        ┌─────────────────────┐
                        │   模型未下载         │
                        │   或 RAM-C 不足      │
                        └──────────┬──────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │     不可用           │
                        │    (disabled)        │
                        └─────────────────────┘
                                   ▲
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
     ┌─────────────────┐                    ┌─────────────────┐
     │   已启动        │◄────停止─────      │   已下载        │
     │ (disabled)      │                    │   (enabled)     │
     └─────────────────┘                    │   [启动]        │
                                            └─────────────────┘
```

### 5.3 模型交互页 (`model_chat.html`)

#### 页面布局

| 区域   | 内容                              |
| ---- | ------------------------------- |
| 顶部栏  | 返回按钮、模型名称、连接状态指示器、日志面板按钮        |
| 主体   | iframe 嵌入 llama-server 的 Web UI |
| 加载遮罩 | 服务就绪前显示"模型启动中，请耐心等待..."         |

#### 服务就绪检测

```
页面加载
  │
  ├── 1. 解析 URL 参数：model_id、port
  │
  ├── 2. 显示加载遮罩，文字"模型启动中，请耐心等待..."
  │
  ├── 3. 延迟 1 秒后开始轮询检测服务（每 1 秒一次，最多 120 次 = 2 分钟）
  │
  ├── 4. XHR 请求 http://127.0.0.1:{port}
  │        成功 → 加载 iframe → 隐藏遮罩 → 显示"已连接"
  │        失败 → 重试计数+1
  │
  └── 5. 超时后显示"连接超时，请检查模型是否正常启动"
```

#### 日志面板

右上角日志按钮打开浮动日志面板，显示通过 `model-log` 事件接收到的 llama-server stdout/stderr 输出。面板可在侧边锚定或浮窗显示。

***

### 5.4 设置页 (`settings.html`)

#### 页面布局

```
┌─────────────────────────────────────────────────────────────┐
│ 设置                                                         │
├─────────────────────────────────────────────────────────────┤
│ ┌──────────┬──────────────────────────────────────────────┐ │
│ │ 导航栏    │ 内容区                                       │ │
│ │──────────│──────────────────────────────────────────────│ │
│ │ ▶ 模型   │ 参数表单（基础/GPU/性能/采样/推理/服务分组）   │ │
│ │   启动    │                                              │ │
│ │   参数    │                                              │ │
│ │──────────│──────────────────────────────────────────────│ │
│ │   版本    │ 应用版本 / llamacpp 版本 + 检查更新/下载按钮   │ │
│ │──────────│──────────────────────────────────────────────│ │
│ │   关于    │ 项目介绍 + GitHub 链接 + 许可证               │ │
│ └──────────┴──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

#### 推荐模式

设置页面顶部新增推荐模式下拉列表，可快速配置采样参数：

| 模式 | 说明 | 温度 | Top-K | Top-P | Min-P | 重复惩罚 | DRY 乘数 | DRY 允许长度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 默认（日常聊天） | 平衡参数 | 0.7 | 40 | 0.95 | 0.0 | 1.1 | 0.8 | 2 |
| 创意写作 | 文学创作修辞友好 | 0.85 | 40 | 0.95 | 0.0 | 1.05 | 0.4 | 3 |
| 写代码/编程 | 低随机性稳定输出 | 0.2 | 35 | 0.9 | 0.0 | 1.1 | 0.4 | 2 |

切换模式后自动填充采样参数并保存，无需点击保存按钮。

#### 启动参数分组

| 参数组     | 参数              | CLI 标志             | 默认值       |
| ------- | --------------- | ------------------ | --------- |
| **推荐模式** | 选择模式 | 快速配置 | 默认（日常聊天） |
| **基础**  | 上下文大小           | `-c`               | 4096      |
| <br />  | 预测 token 数      | `-n`               | -1        |
| <br />  | 批处理大小           | `-b`               | 2048      |
| <br />  | 微批次大小           | `-ub`              | 512       |
| **GPU** | GPU 层数          | `-ngl`             | auto      |
| **性能**  | 线程数             | `-t`               | 自动检测      |
| <br />  | 批处理线程数          | `-tb`              | 同线程数      |
| <br />  | Flash Attention | `-fa`              | auto      |
| <br />  | KV 缓存类型 K       | `-ctk`             | f16       |
| <br />  | KV 缓存类型 V       | `-ctv`             | f16       |
| <br />  | 内存锁定            | `--mlock`          | false     |
| <br />  | 内存映射            | `--mmap`           | true      |
| **采样**  | 温度              | `--temp`           | 0.7       |
| <br />  | Top-K           | `--top-k`          | 40        |
| <br />  | Top-P           | `--top-p`          | 0.95      |
| <br />  | Min-P           | `--min-p`          | 0.0       |
| <br />  | 重复惩罚            | `--repeat-penalty` | 1.1       |
| <br />  | 重复窗口            | `--repeat-last-n`  | -1        |
| <br />  | DRY 乘数          | `--dry-multiplier` | 0.8       |
| <br />  | DRY 允许长度 | `--dry-allowed-length` | 2 |
| <br />  | DRY 惩罚窗口 | `--dry-penalty-last-n` | -1 |
| <br />  | 存在惩罚 | `--presence-penalty` | 0.0 |
| <br />  | 频率惩罚 | `--frequency-penalty` | 0.0 |
| **推理**  | 推理模式            | `--reasoning`      | auto      |
| **服务**  | 端口              | `--port`           | 8080      |
| <br />  | 监听地址            | `--host`           | 127.0.0.1 |

#### 配置持久化

- **文件路径**：同 models 目录下的 `config.json`
- **写入策略**：先写 `.tmp` 临时文件，`sync_all()` 同步后 `rename` 原子替换
- **保存**：设置页填写参数后点击"保存设置"
- **加载**：启动模型时自动调用 `load_settings` 读取
- **恢复默认**：点击"恢复默认"重置为内置默认值

#### 版本与更新区域

| 功能             | Command                                             |
| -------------- | --------------------------------------------------- |
| 获取应用版本         | `get_app_version`                                   |
| 获取 llamacpp 版本 | `get_llamacpp_version`（执行 `llama-server --version`） |
| 检查应用更新         | `check_update`（在 index.rs 中实现）                      |
| 下载/更新 llamacpp | `download_and_extract_llamacpp`（在 index.rs 中实现）     |

***

## 六、Rust 后端实现

### 6.1 模块架构

```
src-tauri/src/
├── main.rs                  # 入口，调用 adm_lib::run()
├── lib.rs                   # tauri::Builder 配置 + command 注册
├── app_state.rs             # 全局状态（AppState）
├── common/
│   ├── mod.rs               # 模块声明 + 重导出
│   ├── types.rs             # 公共数据结构（序列化/反序列化）
│   ├── config.rs            # 路径管理函数
│   └── utils/
│       ├── mod.rs
│       ├── platform.rs      # 跨平台工具（隐藏窗口启动、GPU 信息）
│       └── archive.rs       # ZIP/TAR.GZ 纯 Rust 解压
└── pages/
    ├── mod.rs               # 模块声明
    ├── index.rs             # index.html → 硬件信息、更新检查、llamacpp 下载
    ├── model_list.rs        # model_list.html → 模型扫描/下载/启动/停止
    ├── model_chat.rs        # model_chat.html → 无独立 command（声明占位）
    └── settings.rs          # settings.html → 配置保存/加载、版本查询
```

### 6.2 核心数据结构 (`common/types.rs`)

```rust
SystemInfo     — total_ram, used_ram, total_vram, used_vram, has_gpu, cpu_usage, cores
ModelStatus    — running: bool, model_id, pid, port
LaunchParams   — 所有 llama-server CLI 参数的 Option 封装（ctx_size, n_gpu_layers, temp 等）
RemoteModel    — 远程模型信息：model_id, model_url, model_size, need_ram, support_*, model_diffusion, model_vae
Settings       — 用户配置包装：{ launch_params: LaunchParams }
UpdateInfo     — 远程更新信息：version, llamacpp_version, windows/mac 平台更新
UpdateCheckResult — 更新检查结果：has_update, 各平台下载 URL, llamacpp 版本对比, vc_redist_installed
PartFileProgress   — .part 文件进度：model_id, existing_size
HardwareDetectResult — 硬件检测结果：os, gpu_vendor, gpu_name, nvidia_series
```

### 6.3 AppState (`app_state.rs`)

```rust
pub struct AppState {
    running_process:     Mutex<Option<u32>>,             // 当前 llama-server PID
    running_model_id:   Mutex<Option<String>>,          // 当前运行模型 ID
    running_port:       Mutex<Option<u16>>,              // 当前服务端口
    downloading_progress: Mutex<HashMap<String, u8>>,   // 下载进度缓存（页面切换恢复用）
    sys:                Mutex<System>,                   // sysinfo 缓存
}
```

相比旧版本新增了 `downloading_progress`，用于模型下载过程中页面切换后恢复百分比显示。

### 6.4 路径管理 (`common/config.rs`)

路径查找优先级（`get_base_dir`）：

1. **macOS app data** → `~/Library/Application Support/com.adm.admapp/`
2. **resource dir** 中存在 `llamacpp/` 子目录 → 返回 resource dir
3. **current\_dir** 向上遍历查找 `llamacpp/` 目录
4. **exe dir** 中存在 `llamacpp/` 子目录
5. 回退到 `get_exe_dir()`

**get\_data\_dir**：macOS 返回 `app_data_dir`，其他平台返回 `get_base_dir()`。

**get\_llama\_server\_path**：在 `llamacpp/` 目录中递归查找 `llama-server`（Windows 下为 `llama-server.exe`）。

### 6.5 Command 注册总表

所有 Command 在 `lib.rs` 中通过 `tauri::generate_handler!` 注册：

| Command                         | 所属模块                 | 描述                       |
| ------------------------------- | -------------------- | ------------------------ |
| `get_system_info`               | pages/index.rs       | 获取系统内存/显存/CPU 信息         |
| `check_update`                  | pages/index.rs       | 检查应用、VC++ 运行库(Windows)、llamacpp 更新 |
| `download_and_extract_llamacpp` | pages/index.rs       | 下载并解压 llamacpp 到资源目录     |
| `scan_local_models`             | pages/model\_list.rs | 扫描本地已下载的 `.gguf` 模型      |
| `scan_part_files`               | pages/model\_list.rs | 扫描未完成的 `.gguf.part` 下载文件 |
| `fetch_model_list`              | pages/model\_list.rs | 从远程获取模型列表                |
| `download_model`                | pages/model\_list.rs | 下载模型（断点续传 + 进度事件，文本生成图片模型含3个文件连续下载）        |
| `start_model`                   | pages/model\_list.rs | 启动 llama-server 进程       |
| `stop_model`                    | pages/model\_list.rs | 停止 llama-server 进程       |
| `get_model_status`              | pages/model\_list.rs | 查询当前模型运行状态               |
| `get_downloading_models`        | pages/model\_list.rs | 获取所有下载中的模型进度（HashMap）    |
| `save_settings`                 | pages/settings.rs    | 保存启动参数配置                 |
| `load_settings`                 | pages/settings.rs    | 加载启动参数配置                 |
| `get_app_version`               | pages/settings.rs    | 获取应用版本号                  |
| `get_llamacpp_version`          | pages/settings.rs    | 获取 llama-server 版本号      |

### 6.6 Event 事件列表

| Event                        | 来源             | 触发时机                            | Payload                                   |
| ---------------------------- | -------------- | ------------------------------- | ----------------------------------------- |
| `download-progress`          | model\_list.rs | 模型下载中实时上报                       | `{model_id, progress, downloaded, total, type}`（type: model/mmproj/diffusion/vae） |
| `download-complete`          | model\_list.rs | 模型下载完成                          | `{model_id, type}`（type: model/mmproj/diffusion/vae）                              |
| `model-started`              | model\_list.rs | 模型启动成功 / 检测到 listening 日志       | `{model_id, port}`                        |
| `model-stopped`              | model\_list.rs | 进程退出（stdout/stderr 线程结束）        | `{model_id}`                              |
| `model-log`                  | model\_list.rs | llama-server stdout/stderr 每行输出 | `{model_id, line, source}`                |
| `llamacpp-download-progress` | index.rs       | llamacpp 下载/解压过程                | `{status, progress}`                      |

### 6.7 模型下载流程

```
前端点击"下载"
  │
  ├── 1. 自动替换 huggingface.co → hf-mirror.com（国内镜像加速）
  │
  ├── 2. 检查 {model_id}.gguf 是否存在 → 存在直接返回完成
  │
  ├── 3. 检查 {model_id}.gguf.part 是否存在
  │        ├── 存在 → 获取已下载字节数，设置 Range header 续传
  │        └── 不存在 → 从 0 开始下载
  │
  ├── 4. 发送 GET 请求（支持重定向跟踪）
  │        ├── 302 → 跟进 Location 获取最终 URL
  │        └── 200 → 直接下载
  │
  ├── 5. 流式写入 .part 文件，每 chunk 上报 download-progress 事件（type: "model"）
  │
  ├── 6. 下载完成 → .part 重命名为 .gguf → emit download-complete（type: "model"）
  │
  ├── 7. 如果存在 model_diffusion → 自动下载 diffusion 文件
  │        (相同流程，事件 type: "diffusion")
  │
  └── 8. 如果存在 model_vae → 自动下载 vae 文件
             (相同流程，事件 type: "vae")
```

### 6.8 模型启动流程

```
前端点击"启动"
  │
  ├── 1. 检查 AppState.running_process → 有值则返回错误
  │
  ├── 2. 获取 llama-server 可执行文件路径（递归查找）
  │
  ├── 3. 校验模型文件 {model_id}.gguf 存在
  │
  ├── 4. 读取 config.json → 获取 LaunchParams
  │
  ├── 5. 构建命令行参数（见参数配置表）
  │
  ├── 6. 静默启动（Windows 隐藏控制台窗口）
  │        macOS 设置 DYLD_LIBRARY_PATH 环境变量
  │
  ├── 7. 记录 PID / ModelID / Port 到 AppState
  │
  ├── 8. emit model-started 事件
  │
  ├── 9. 后台线程读取 stdout/stderr
  │        ├── 逐行 emit model-log 事件
  │        ├── 检测到 listening → 再次 emit model-started（含 port）
  │        └── 线程结束 → emit model-stopped
  │
  └── 10. 返回启动成功
```

***

## 七、构建与部署

### 7.1 常用命令

| 命令                         | 说明                    |
| -------------------------- | --------------------- |
| `pnpm tauri dev`           | 开发模式启动（热重载前端、Rust 编译） |
| `pnpm tauri build`         | 构建生产版本                |
| `pnpm tauri:build:windows` | 构建 Windows 目标         |
| `pnpm tauri:build:macos`   | 构建 macOS 目标           |
| `pnpm tauri:build:linux`   | 构建 Linux 目标           |
| `pnpm tauri clean`         | 清理构建目录                |

> 注：AGENTS.md 中约定使用 `pnpm tauri dev` / `pnpm tauri build` 直接调用。`package.json` 中的 `tauri:dev` / `tauri:build` 别名也可用。

### 7.2 构建配置

**tauri.conf.json** 关键配置：

- `version`: `0.1.8`（发布时更新）
- `frontendDist`: `../src`（直接使用原生 HTML 文件，无需打包工具）
- `withGlobalTauri`: `true`（全局注入 `__TAURI__` / `__TAURI_INTERNALS__`）
- `windows`: 单窗口 1280×768，居中，带原生标题栏
- `bundle`: 打包全部目标（all），未配置额外 resources（llamacpp 通过首次启动下载）

**平台条件编译配置**：

- `tauri.windows.conf.json`
- `tauri.linux.conf.json`
- `tauri.macos.conf.json`

**Windows 特殊处理**：

- `main.rs`: `#![windows_subsystem = "windows"]` 隐藏控制台窗口
- `build.rs`: Windows 目标附加 `/SUBSYSTEM:WINDOWS` 链接参数
- 平台工具：`create_hidden_command` 设置 `CREATE_NO_WINDOW` flag

### 7.3 Capability 权限系统

`capabilities/default.json` 定义了主窗口的权限：

```json
{
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "opener:default",
    "core:window:default",
    "core:window:allow-center",
    "hwinfo:allow-cpu-info",
    "hwinfo:allow-gpu-info",
    "hwinfo:allow-ram-info",
    "hwinfo:allow-os-info"
  ]
}
```

### 7.4 签名与发布脚本

| 脚本                             | 用途                               |
| ------------------------------ | -------------------------------- |
| `scripts/build.mjs`            | Node.js 构建入口（直接调用 `tauri build`） |
| `scripts/sign-macos.sh`        | macOS 应用签名                       |
| `scripts/sign-windows.ps1`     | Windows 应用签名                     |
| `scripts/fix-macos-damaged.sh` | 修复 macOS "已损坏" 提示                |

**发布流程**（以 macOS 为例）：

```
pnpm tauri:build:macos
pnpm sign:macos
```

### 7.5 更新服务器

| 端点                                     | 用途       |
| -------------------------------------- | -------- |
| `https://adm.tuduoduo.top/update.json` | 应用版本更新检查 |
| `https://adm.tuduoduo.top/model.json`  | 远程模型列表   |

***

## 八、IPC 通信设计

### 8.1 Invoke 调用

前端通过 `window.__TAURI_INTERNALS__.invoke()` 调用 Rust Command。兼容多版本写法：

```javascript
const invoke = window.__TAURI_INTERNALS__?.invoke ||
               window.__TAURI__?.core?.invoke ||
               window.__TAURI__?.invoke;
```

### 8.2 iframe 子页面 IPC（关键⚠️）

macOS WKWebView 不会将 Tauri IPC 注入到 iframe 中，因此子页面必须通过 `window.parent` 回退获取：

```javascript
const getInvoke = () =>
  window.__TAURI_INTERNALS__?.invoke ||
  window.__TAURI__?.core?.invoke ||
  window.parent?.__TAURI_INTERNALS__?.invoke ||
  window.parent?.__TAURI__?.core?.invoke;
```

### 8.3 Event 收发架构

```
Rust (emit) ──→ 前端 JS (listen) ──postMessage──→ iframe/contentWindow
                                                        │
                                                        ▼
                                              子页面监听 window.message
```

**主框架转发逻辑**：`index.html` 监听所有 Tauri 事件，通过 `frame.contentWindow.postMessage()` 转发给 iframe 子页面。

**子页面导航**：子页面发送 `{ type: "navigate", page: "..." }` 给 `window.parent`，主框架据此切换 iframe 的 `src`。

***

## 九、llamacpp 自动下载机制

### 9.1 触发时机

1. **应用启动**：`check_update` 静默检查时比对 `llamacpp_version`
2. **设置页**：用户手动点击"下载/更新 llamacpp"

### 9.2 硬件适配策略

`detect_hardware_for_llamacpp()` 根据当前系统选择对应版本：

| OS                 | GPU 条件  | 下载 URL               |
| ------------------ | ------- | -------------------- |
| macOS              | 所有      | `macos.tar.gz`       |
| Windows + NVIDIA   | 任意      | `windows-CUDA12.zip` |
| Windows + AMD      | 任意      | `vulkan.zip`         |
| Windows + Intel    | 任意      | `vulkan.zip`         |
| Windows + 无/其他 GPU | —       | 抛出异常提示           |
| Linux              | —       | 暂不支持自动下载             |

### 9.3 版本比对

1. 先检查 `llamacpp/` 目录下是否存在 `llama-server` 二进制文件
2. 存在则执行 `llama-server --version` 解析版本号
3. 与 `update.json` 中的 `llamacppVersion` 字段对比
4. 版本不同或二进制不存在 → 触发下载

***

## 十、FAQ / 常见问题

### 10.1 macOS 相关

- **模型/配置文件路径**：`~/Library/Application Support/com.adm.admapp/`
- **"已损坏" 提示**：运行 `pnpm fix:macos` 或 `xattr -cr /Applications/ADM.app`
- 启动 llacpp 时需设置 `DYLD_LIBRARY_PATH` 环境变量

### 10.2 Windows 相关

- 所有子进程通过 `CREATE_NO_WINDOW` 标志启动，避免弹出命令行窗口
- 停止模型使用 `taskkill /PID /F` 强制终止

### 10.3 下载相关

- HuggingFace 国内镜像自动替换：`huggingface.co` → `hf-mirror.com`
- 断点续传基于 HTTP `Range` 头 + `.part` 后缀文件
- `get_downloading_models` Command 可在页面切换后恢复进度显示

***

## 十一、参考资料

### A. llama.cpp 参数详解

详见 `doc/llamacpp.txt`

### B. Tauri 官方文档

- 中文文档: <https://www.tauri.net.cn/>
- 英文文档: <https://v2.tauri.app/>

### C. 相关项目

| 项目                  | 地址                                                 |
| ------------------- | -------------------------------------------------- |
| llama.cpp           | <https://github.com/ggml-org/llama.cpp>            |
| Tauri               | <https://github.com/tauri-apps/tauri>              |
| sysinfo             | <https://github.com/GuillaumeGomez/sysinfo>        |
| reqwest             | <https://github.com/seanmonstar/reqwest>           |
| tauri-plugin-hwinfo | <https://github.com/nikolchaa/tauri-plugin-hwinfo> |

***

*文档版本: 3.3*\
*最后更新: 2026-06-01*\
*维护者: ADM 开发团队*
