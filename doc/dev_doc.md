# ADM 开发文档

> ADM (Automatic Deployment Model) — llama.cpp 图形化管理桌面应用\
> 将 llama.cpp 的 CLI 启动指令通过 GUI 界面化配置，便捷部署和运行大语言模型。

***

## 文档信息

| 项目       | 值          |
| -------- | ---------- |
| 应用版本     | 0.1.8      |
| 文档版本     | 3.9        |
| Tauri 版本 | 2.11.2     |
| 最后更新     | 2026-06-21 |
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
| **自动更新**        | 启动时：应用版本 → VC++ 运行库(Windows) → llamacpp 二进制（有序三重检查）；admAgent 版本检查改在点击底部栏 Agent 按钮时触发（仅 Windows） |
| **llamacpp 管理** | 自动检测硬件并下载匹配的 llama-server 二进制                    |

***

## 二、架构设计

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                   Tauri 单窗口 (SPA)                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              index.html (SPA 外壳)                       │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │   #view-root (hash 路由异步挂载视图模块)          │  │  │
│  │  │  ┌────────────────┐ ┌─────────────────────────┐  │  │  │
│  │  │  │ views/        │ │ views/                  │  │  │  │
│  │  │  │ model_list.js │ │ settings.js             │  │  │  │
│  │  │  │ (模型列表)     │ │ (设置页)               │  │  │  │
│  │  │  └────────────────┘ └─────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────────────┐   │  │  │
│  │  │  │ views/model_chat.js / model_image.js     │   │  │  │
│  │  │  └──────────────────────────────────────────┘   │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │  #agent-frame (方案 A：独立 iframe，仅路由 #/agent)   │  │
│  │         ↕ 直接 IPC (window.__adm_invoke / listen)     │  │
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
| SPA 路由与视图生命周期 (mount/unmount)    | ✅       | ❌         |
| 视图模块加载 (动态 import())              | ✅       | ❌         |
| 模型列表渲染与状态列                          | ✅       | ❌         |
| 系统信息采集                              | ❌       | ✅         |
| 文件下载（含断点续传）                         | ❌       | ✅         |
| 进程管理 (llama-server / sd-cli)       | ❌       | ✅         |
| 本地模型扫描                              | ❌       | ✅         |
| .part 文件扫描                          | ❌       | ✅         |
| GPU/VRAM 检测                         | ❌       | ✅         |
| 配置文件读写                              | ❌       | ✅         |
| 远程模型列表获取                            | ❌       | ✅         |
| 应用/llamacpp 更新检查                    | ❌       | ✅         |
| llamacpp 下载和解压                      | ❌       | ✅         |

### 2.3 IPC 通信设计

#### Invoke / Listen 调用

SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke` / `.event.listen`，无需 `postMessage` 代理。`index.html` 初始化时把这两个引用暴露为全局：

```javascript
// index.html 初始化
window.__adm_invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
window.__adm_listen = window.__TAURI__?.event?.listen || window.__TAURI_INTERNALS__?.listen;
window.__adm_state = { systemInfo, runningModelId, runningModelPort, modelList, ... }; // 跨视图共享
```

各视图模块统一通过 `window.__adm_invoke(...)` / `window.__adm_listen(...)` 调用 IPC，不再有 `window.parent` 回退与 `__invoke__` 代理。

> **注意**：macOS WKWebView 不会将 Tauri IPC 注入 iframe，因此 **Agent 终端（`agent.html`）仍保留为独立 iframe 并自带 `window.parent` 回退**（方案 A）；其余 4 个视图已 SPA 化，直接调用主窗口 IPC。

#### Event 通信流

```
前端 JS ──invoke────▶  Rust Command  ──return──▶  前端 JS
前端 JS ◀──listen────  Rust Event    ──emit────▶  前端 JS
```

视图 `mount` 时 `listen(event, handler)` 并保存 unlisten 句柄，`unmount` 时统一调用以防事件重复绑定（泄漏）。

| 事件名                          | 触发方                                    | 载荷                                          | 说明               |
| ---------------------------- | -------------------------------------- | ------------------------------------------- | ---------------- |
| `download-progress`          | Rust `download_model()`                | `{ model_id, progress, downloaded, total, type }` | 模型下载进度更新（type: model/mmproj/diffusion/vae）         |
| `download-complete`          | Rust `download_model()`                | `{ model_id, type }`                              | 模型下载完成（type: model/mmproj/diffusion/vae）           |
| `model-started`              | Rust `start_model()`                   | `{ model_id, port }`                        | 模型启动成功           |
| `model-stopped`              | Rust (stdout/stderr 线程)                | `{ model_id }`                              | 模型进程退出           |
| `model-log`                  | Rust (stdout/stderr 线程)                | `{ model_id, line, source }`                | 模型日志行            |
| `llamacpp-download-progress` | Rust `download_and_extract_llamacpp()` | `{ status, progress }`                      | llamacpp 下载/解压进度 |
| `sd-download-progress`       | Rust `download_and_extract_sd()`       | `{ status, progress }`                      | sd-cli 下载/解压进度    |
| `sd-log`                     | Rust `start_sd_generation()`           | `{ model_id, line, source }`                | sd-cli 运行时日志       |
| `sd-started`                 | Rust `start_sd_generation()`           | `{ model_id }`                              | sd-cli 进程启动         |
| `sd-complete`                | Rust (stdout/stderr 线程)               | `{ model_id }`                              | sd-cli 进程结束         |

#### 主窗口 ↔ Agent iframe 通信（仅 agent.html，方案 A）

```
Tauri Event (Rust → JS)
       │
       ▼
index.html 监听 Tauri 事件 (agent-terminal-data / exit / ready / download-progress)
       │
       ▼
#agent-frame.contentWindow.postMessage({ type, payload }, "*")
       │
       ▼
agent.html 监听 window.message 事件

agent.html → 主窗口：postMessage({ type: "agent-focus-me" / "agent-read-clipboard" / "navigate", ... })
```

***

## 三、项目目录结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档（本文件）
│   └── llamacpp.txt                  # llama.cpp 参数参考
├── scripts/                          # 构建、签名与工具脚本
│   ├── build.mjs                     # Node.js 构建入口脚本
│   ├── fix-macos-damaged.sh          # macOS 修复损坏应用标记
│   ├── generate-icons.py             # 图标自动生成（从 source.png 生成全套图标）
│   ├── sign-macos.sh                 # macOS 代码签名
│   └── sign-windows.ps1              # Windows 代码签名
├── src/                              # 前端资源 (Tauri frontendDist)
│   ├── index.html                    # SPA 外壳（#view-root 容器 + #agent-frame + 底部硬件栏/导航 + 全局 IPC/状态 + 路由器）
│   ├── views/                        # 4 个 ES 模块视图（CSS+JS 内联在模板字符串里）
│   │   ├── model_list.js             # 模型列表视图（表格展示/下载/启动/停止）
│   │   ├── model_chat.js             # 模型对话交互视图（内嵌 WebUI + 启动遮罩 + 日志面板）
│   │   ├── model_image.js            # 文生图视图（文本输入/宽高设置/图片生成/日志）
│   │   └── settings.js               # 设置视图（导航分栏 + 参数表单 + 版本/关于）
│   ├── agent.html                    # Agent 终端页（方案 A：独立 iframe，#agent-frame 加载）
│   └── model_types.json              # 模型类型筛选数据（fetch 读取）
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
│           ├── model_list.rs         # views/model_list.js 逻辑：模型扫描/下载/启停/状态
│           ├── model_chat.rs         # views/model_chat.js 逻辑（无独立 command，事件驱动）
│           ├── model_image.rs        # views/model_image.js 逻辑：sd-cli 下载/检测/生成/停止
│           └── settings.rs           # views/settings.js 逻辑：配置持久化、版本查询
├── website/                          # 项目官网资源
│   ├── index.html                    # 官网首页（含 SEO: OG/Twitter Card/JSON-LD/Canonical）
│   ├── robots.txt                    # 搜索引擎爬虫规则
│   ├── sitemap.xml                   # 站点地图
│   └── images/                       # 官网图片
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
                      └─────────────┘   │   model_image.rs │
                             ▲          │   settings.rs    │
                             │          └─────────────────┘
              ┌──────────────┴──────────────┐
              │ 所有 pages 模块依赖 common   │
              │ pages/model_list/model_image│
              │ 也依赖 app_state            │
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
            // 窗口关闭时清理 llama-server / sd-cli 进程：
            // 1. 按记录的 PID 杀整棵进程树（kill_process_tree）
            // 2. 兜底按进程名强杀残留（kill_process_by_name），防止 PID 记录丢失/复用导致孤儿进程残留
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
            model_list::get_downloading_phases,
            // pages/model_image.rs
            model_image::check_sd_exists,
            model_image::download_and_extract_sd,
            model_image::start_sd_generation,
            model_image::stop_sd,
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
| `LaunchParams`         | 模型启动参数（见 §5.5），新增 `dry_multiplier`、`dry_allowed_length`、`dry_penalty_last_n`、`presence_penalty`、`frequency_penalty`、`preset_mode`、`spec_draft_n_max`、`spec_type` 字段。MTP 模型自动检测（见 §6.8） |
| `RemoteModel`          | 远程模型数据：model\_id、model\_url、model\_size、need\_ram、support\_tools/reasoning/images、model\_diffusion、model\_vae |
| `Settings`             | 用户配置包装：`{ launch_params: LaunchParams }`                                            |
| `PartFileProgress`     | 断点续传进度：model\_id、existing\_size                                                     |
| `UpdateInfo`           | 远程更新信息：版本号、llamacpp 版本、admAgent 版本、各平台下载配置                                                      |
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
| `detect_gpu_vendor()`            | 返回 GPU 厂商字符串：`"nvidia"` / `"amd"` / `"intel"` / `"apple"` / `None`         |
| `decode_wmic_output(bytes)` [私有] | Windows 下解码 wmic UTF-16 输出                                                 |

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
| `check_update`                  | `(app: AppHandle) → Result<UpdateCheckResult>`  | 检查应用版本、VC++ 运行库(Windows)、llamacpp 更新（admAgent 不在此处检查）          |
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
| Windows + 其他/无 GPU           | Vulkan 包 (zip)     |

### 4.9 `pages/model_list.rs` — 模型列表页面

**对应前端**：`views/model_list.js`（模型表格、下载/启动/停止按钮）

**Commands**：

| Command                                     | 说明                      | 关键逻辑                                           |
| ------------------------------------------- | ----------------------- | ---------------------------------------------- |
| `scan_local_models(app)`                    | 扫描 `models/*.gguf`      | 返回已下载的 model\_id 列表                            |
| `scan_part_files(app)`                      | 扫描 `models/*.gguf.part` | 返回断点续传文件信息                                     |
| `fetch_model_list()`                        | 远程获取模型列表                | `GET https://adm.tuduoduo.top/model.json`      |
| `download_model(app, model_id, model_url, model_diffusion, model_vae)`  | 下载模型                    | 断点续传 + HuggingFace 镜像替换 + 进度事件 + AppState 进度同步。文本生成图片模型自动连续下载主模型、diffusion、vae 三个文件 |
| `start_model(app, state, model_id, params)` | 启动 llama-server         | 参数拼装 + 进程 spawn + stdout/stderr 线程 + PID 记录    |
| `stop_model(state)`                         | 停止 llama-server         | `kill_process_tree`（taskkill /PID /T /F 或 kill -9 -<pgid>）+ 状态清空 |
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
         → 进程退出时：清除 AppState 状态 → 发送 model-stopped 事件
```

### 4.10 `pages/model_chat.rs` — 模型交互页面

**对应前端**：`views/model_chat.js`

**特点**：此页面**没有独立的 Tauri Command**，完全通过事件驱动 + 前端 JS 实现功能：

- URL 参数接收 `model_id` 和 `port`
- 轮询检测 `http://127.0.0.1:{port}` 服务就绪（每 1 秒，最多 2 分钟）
- 就绪后加载 iframe 显示 llama-server Web UI
- 监听 `model-log` / `model-started` / `model-stopped` 事件
- 日志面板展示

### 4.11 `pages/model_image.rs` — 文生图页面

**对应前端**：`views/model_image.js`

**Commands**：

| Command                        | 签名                                                                                 | 说明                       |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------ |
| `check_sd_exists`              | `(app: AppHandle) → Result<bool>`                                                  | 检测 sd-cli 可执行文件是否存在      |
| `download_and_extract_sd`      | `(app: AppHandle) → Result<()>`                                                     | 下载并解压 sd-cli（自动检测 GPU 型号） |
| `start_sd_generation`          | `(app, state, model_id, prompt, width, height, model_url, model_diffusion, model_vae) → Result<()>` | 启动 sd-cli 生成图片          |
| `stop_sd`                      | `(state: State<AppState>) → Result<()>`                                             | 停止 sd-cli 进程             |

**sd-cli 下载 URL 策略**：

| 硬件条件               | 下载 URL                    |
| ------------------ | --------------------------- |
| Windows + NVIDIA   | `sd-cuda.zip`               |
| Windows + AMD      | `sd-vulkan.zip`              |
| Windows + Intel    | `sd-vulkan.zip`              |
| macOS              | `sd-macos.zip`               |
| 其他/未检测到 GPU     | `sd-vulkan.zip`              |

**生成参数构造**：`start_sd_generation` 从 model_url/model_diffusion/model_vae 提取文件名，在 `{base_dir}/models/{model_id}/` 目录下查找对应的模型文件，构建 sd-cli 完整参数并启动子进程。子进程 stdout/stderr 通过 `sd-log` 事件实时输出，进程退出时发送 `sd-complete` 事件。

### 4.12 `pages/settings.rs` — 设置页面

**对应前端**：`views/settings.js`

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
│  │           #view-root 内容区域 (动态 import 视图模块)    │  │
│  │            model_list / settings / model_chat / image  │  │
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
  ├── 1. 初始化全局 IPC（window.__adm_invoke / __adm_listen）与共享状态（window.__adm_state）
  │
  ├── 2. invoke("get_system_info") → 获取系统硬件信息
  │
  ├── 3. 尝试调用 hwinfo 插件增强检测
  │        plugin:hwinfo|get_cpu_info / get_ram_info / get_gpu_info / get_os_info
  │   → 若成功，用 hwinfo 数据覆盖 sysinfo 数据（更精确）
  │
  ├── 4. 更新底部硬件信息栏
  │
  ├── 5. 设置 Tauri 事件监听（llamacpp / adm-agent / agent 终端，保留转发给 #agent-frame）
  │
  ├── 6. renderRoute() 解析 location.hash → 动态 import 视图模块，mount 进 #view-root
  │
  └── 7. 延迟 3 秒后静默 check_update → 有新版本才弹窗（不含 admAgent；admAgent 版本检查在点击底部栏 Agent 按钮时触发）
      ① 先检查系统版本更新 → 有更新则弹窗提示
      ② 用户关闭系统更新弹窗后 → 检查 VC++ 运行库（仅 Windows）
      ③ 若 VC++ 运行库未安装 → 提示下载安装
      ④ VC++ 安装完成后 → 检查 llamacpp 版本/下载
      ⑤ 若系统无更新且 VC++ 已安装 → 直接检查 llamacpp 版本/下载
      ⑥ llamacpp 处理完成后 → 检查 admAgent 版本（仅 Windows）：
        本地执行 `admAgent -v` 解析版本，与 `update.json` 的 `admAgentVersion` 对比，
        不同则下载 `https://adm.tuduoduo.top/agent/win/admAgent.exe` 并替换
```

#### 硬件信息栏

| 信息项 | 显示格式                                    | 数据来源                | 更新时机  |
| --- | --------------------------------------- | ------------------- | ----- |
| 内存  | `总内存` (如 32GB)                          | sysinfo + hwinfo 增强 | 启动时一次 |
| 显存  | `总显存 (型号)` (如 11GB RTX 4090)，无显卡显示"无显卡" | hwinfo GPU 检测       | 启动时一次 |
| CPU | `型号 物理核心C/逻辑线程T` (如 Intel i7 8C/16T)    | sysinfo + hwinfo    | 启动时一次 |

**数据优先级**：`hwinfo 插件 > sysinfo`

#### 导航处理（SPA hash 路由）

`index.html` 用 `<script type="module">` 内的 `renderRoute()` 解析 `location.hash` 并动态 `import()` 视图模块，挂载进 `#view-root`：

```javascript
// 路由表
const routes = {
  "/list":     { load: () => import("./views/model_list.js"),     nav: "home-btn" },
  "/chat":     { load: () => import("./views/model_chat.js"),     nav: "home-btn" },
  "/image":    { load: () => import("./views/model_image.js"),    nav: "home-btn" },
  "/settings": { load: () => import("./views/settings.js"),       nav: "settings-btn" },
  // "/agent" 不加载视图模块，由 showAgentFrame() 显隐 #agent-frame (方案 A)
};

// 子页面发起导航请求（替代原 postMessage({type:"navigate"})）
function navigateTo(hash) { location.hash = hash; }  // 如 "#/chat?model_id=xxx&port=1010"
```

视图切换时调用上一个视图的 `unmount()`（解绑 `listen` 句柄、`clearInterval`），再注入新模板并 `mount()`，共享 `window.__adm_state` 跨视图不丢状态。

### 5.2 模型列表页 (`views/model_list.js`)

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

### 5.3 模型交互页 (`views/model_chat.js`)

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

### 5.4 设置页 (`views/settings.js`)

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
| **推测解码** | MTP 推测解码类型 | `--spec-type` | 自动检测（文件名含 MTP 时设为 draft-mtp） |
| <br />  | MTP 推测 token 数 | `--spec-draft-n-max` | 自动检测（文件名含 MTP 时设为 2） |
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

### 5.5 文生图页 (`views/model_image.js`)

#### 页面布局

```
┌──────────────────────────────────────────────┐
│ [← 返回]  文生图 - {model_id}  ✓ SD 就绪    │ ← header
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────┐ │
│ │ 提示词                                    │ │
│ │ ┌──────────────────────────────────────┐ │ │
│ │ │ textarea 文本输入框                    │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────┘ │
│ 宽度: [1080]  高度: [1920]                  │
│ [生成图片]                                   │
│                                              │
│ 生成结果                                     │
│ ┌──────────────────────────────────────────┐ │
│ │  🖼️ 生成的图片将显示在这里                │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ 运行日志                    [清空]           │
│ ┌──────────────────────────────────────────┐ │
│ │ sd-cli 运行日志输出                       │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

#### 页面状态流转

```
页面加载
  │
  ├── 获取 URL 参数 model_id
  │
  ├── invoke("check_sd_exists")
  │     ├── false → 显示下载进度区
  │     │          invoke("download_and_extract_sd")
  │     │          监听 sd-download-progress 事件更新进度条
  │     │          下载完成 → 切换到生成界面
  │     │
  │     └── true  → 显示生成界面（就绪状态）
  │
  └── 生成流程
        └── 用户输入提示词 + 宽高 → 点击生成
             ├── invoke("fetch_model_list") 获取远程模型文件信息
             ├── invoke("start_sd_generation", { modelId, prompt, width, height, modelUrl, modelDiffusion, modelVae })
             │    └── Rust 后端构建命令并启动 sd-cli 子进程
             ├── 监听 sd-log 事件 → 实时显示运行日志
             ├── 监听 sd-started 事件 → 更新状态
             └── 监听 sd-complete 事件 → 恢复按钮状态
```

#### 关键逻辑

**sd-cli 检测与下载**：
- 检测 `{base_dir}/sd/sd-cli.exe`(Windows) 或 `{base_dir}/sd/sd-cli`(macOS) 是否存在
- 不存在时自动下载：
  - Windows + NVIDIA → `sd-cuda.zip`
  - Windows + AMD → `sd-vulkan.zip`
  - Windows + Intel → `sd-vulkan.zip`
  - macOS → `sd-macos.zip`
- 支持断点续传，解压后设置执行权限

**文本生成**：
- 收集 prompt + width + height
- 通过 `fetch_model_list` 获取模型 URL，提取文件名构建本地路径
- 调用 `start_sd_generation` 启动 sd-cli 进程
- sd-cli 参数包含 `--diffusion-model`, `--vae`, `--llm`, `-p`, `--cfg-scale 1.0`, `--offload-to-cpu`, `--diffusion-fa`, `-H`, `-W`, `--steps 8`

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
    ├── model_list.rs        # views/model_list.js → 模型扫描/下载/启动/停止
    ├── model_chat.rs        # views/model_chat.js → 无独立 command（声明占位）
    └── settings.rs          # views/settings.js → 配置保存/加载、版本查询
```

### 6.2 核心数据结构 (`common/types.rs`)

```rust
SystemInfo     — total_ram, used_ram, total_vram, used_vram, has_gpu, cpu_usage, cores
ModelStatus    — running: bool, model_id, pid, port
LaunchParams   — 所有 llama-server CLI 参数的 Option 封装（ctx_size, n_gpu_layers, temp 等）
RemoteModel    — 远程模型信息：model_id, model_url, model_size, need_ram, support_*, model_diffusion, model_vae
Settings       — 用户配置包装：{ launch_params: LaunchParams }
UpdateInfo     — 远程更新信息：version, llamacpp_version, adm_agent_version, windows/mac 平台更新
UpdateCheckResult — 更新检查结果：has_update, 各平台下载 URL, llamacpp 版本对比, vc_redist_installed
AdmAgentUpdateCheck — admAgent 版本检查结果（点击 Agent 按钮时调用）：needs_update, remote_version, local_version, download_url
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
| `model-stopped`              | model\_list.rs | 进程退出（stdout/stderr 线程结束，并已清除 AppState） | `{model_id}`                              |
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
  │         └── MTP 自动检测：若模型文件名包含 "mtp"（大小写不敏感），自动追加 --spec-draft-n-max 2 --spec-type draft-mtp
  │             优先使用 params.spec_type 手动配置（设为 "none" 可禁用）
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
  │        └── 线程结束 → 清除 AppState → emit model-stopped
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
| `https://adm.tuduoduo.top/update.json` | 应用版本更新检查；含 `llamacppVersion` 与 `admAgentVersion` 字段 |
| `https://adm.tuduoduo.top/agent/win/admAgent.exe` | admAgent 版本更新下载地址（仅 Windows） |
| `https://adm.tuduoduo.top/model.json`  | 远程模型列表   |

***

## 八、IPC 通信设计

### 8.1 Invoke 调用

SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke`。`index.html` 初始化时把引用暴露到全局，所有视图模块通过 `window.__adm_invoke` 调用：

```javascript
// index.html 初始化
window.__adm_invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
window.__adm_listen = window.__TAURI__?.event?.listen || window.__TAURI_INTERNALS__?.listen;
```

各视图模块内统一使用 `window.__adm_invoke("cmd", args)` / `window.__adm_listen("event", handler)`，**不再有 `window.parent` 回退与 `__invoke__` 代理**。

### 8.2 Agent iframe 子页面 IPC（仅 agent.html，方案 A）

macOS WKWebView 不会将 Tauri IPC 注入到 iframe 中，因此 **`agent.html` 作为独立 iframe 仍保留 `window.parent` 回退**：

```javascript
const getInvoke = () =>
  window.__TAURI_INTERNALS__?.invoke ||
  window.__TAURI__?.core?.invoke ||
  window.parent?.__TAURI_INTERNALS__?.invoke ||
  window.parent?.__TAURI__?.core?.invoke;
```

### 8.3 Event 收发架构

```
Rust (emit) ──→ 前端 JS (window.__adm_listen) ──→ 视图模块 handler（mount 时绑定，unmount 时解绑）
                                          └──→ #agent-frame.contentWindow（仅 agent 相关事件，postMessage 转发）
```

**主框架转发逻辑**：`index.html` 仅把 Agent 相关 Tauri 事件（`agent-terminal-data` / `agent-terminal-exit` / `agent-terminal-ready` / `agent-download-progress`）通过 `postMessage` 转发给 `#agent-frame`；其余 4 个 SPA 视图**直接** `listen`，无需转发。

**SPA 导航**：视图内通过 `location.hash = "#/chat?model_id=..."` 切换路由，不再使用 `postMessage({type:"navigate"})`。

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
| Windows + 无/其他 GPU | —       | `vulkan.zip`         |
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
- 停止模型/SD 使用 `taskkill /PID /T /F` 强杀整棵进程树；窗口关闭时还会按进程名（`llama-server.exe` / `sd-cli.exe`）兜底清理残留，避免子进程沦为孤儿
- Unix 下 llama-server / sd-cli 以独立进程组（`process_group(0)` + setsid）启动，关闭时用 `kill -9 -<pgid>` 一次性杀掉整棵树

### 10.3 下载相关

- HuggingFace 国内镜像自动替换：`huggingface.co` → `hf-mirror.com`
- 断点续传基于 HTTP `Range` 头 + `.part` 后缀文件
- `get_downloading_models` Command 可在页面切换后恢复进度显示

***

## 十一、应用图标

### 11.1 图标源文件

- **源文件**: `src-tauri/icons/source.png` (≥256×256 RGBA PNG)
- 后续需要更换图标时，替换此文件后重新运行生成脚本即可

### 11.2 图标文件清单

| 文件 | 尺寸 | 用途 |
|------|------|------|
| `source.png` | ≥256×256 | 源图（唯一需要维护的原始素材） |
| `32x32.png` | 32×32 | 小图标 |
| `64x64.png` | 64×64 | 中等图标 |
| `128x128.png` | 128×128 | 大图标 |
| `256x256.png` | 256×256 | 高清图标 |
| `icon.ico` | 多分辨率(16/32/48/64/128/256) | Windows 应用图标（含 256×256 保证桌面高清显示） |
| `icon.icns` | 3 种(ic07/ic08/ic09) | macOS 应用图标 |

### 11.3 自动生成

使用 `scripts/generate-icons.py` 从 `source.png` 一键生成所有图标：

```bash
python scripts/generate-icons.py
```

脚本会依次执行：
1. 缩放 PNG 到 32/64/128/256 四种尺寸
2. 合成多分辨率 .ico（含 256×256，解决 Windows 桌面图标模糊）
3. 合成 .icns（含 ic07/ic08/ic09 三种 macOS 图标类型）

### 11.4 关键修复说明

桌面图标模糊的根因是 `icon.ico` 内缺少 **256×256** 尺寸。Windows 在高 DPI 下会将 128×128 放大显示，导致模糊。新生成的 .ico 包含 256×256 后即可在桌面保持清晰。

---

## 十三、Agent 终端

底部栏「设置」右侧新增「Agent」按钮，点击后进入内嵌命令终端并自动运行 `admAgent` 工具。

### 13.1 交互流程

1. 点击底部栏 **Agent** 按钮（`index.html` 的 `goAgent()`）。
2. 调用 `check_adm_agent` 检查本地是否已下载 `admAgent`：
   - **Windows**：默认路径为软件所在根目录（`exe` 同级目录），文件名 `admAgent.exe`。
   - **macOS**：默认路径为应用用户目录（`app_data_dir`，如 `~/Library/Application Support/com.adm.admapp`），文件名 `admAgent`。
3. 若已存在，直接打开 `agent.html` 终端页面。
4. 若不存在，弹出下载进度弹窗（`#agent-download-overlay`），调用 `download_adm_agent` 下载：
   - Windows：`http://adm.tuduoduo.top/admAgent.exe`
   - macOS：`http://adm.tuduoduo.top/admAgent`
   - 下载过程通过 `agent-download-progress` 事件向前端推送进度。
5. 下载完成后自动进入 `agent.html` 终端页面。

### 13.2 内嵌终端实现

- `agent.html` 使用 `xterm.js`（已离线内置在 `src/vendor/xterm/`）作为终端界面。
- `start_agent_terminal` 通过 `portable-pty` 创建 PTY：
  - **Windows**：**直接启动 `admAgent.exe`**（不再经过 `powershell.exe`）。原因：release 版 `adm.exe` 带 `#![windows_subsystem = "windows"]`（无控制台），`portable-pty` 的 ConPTY 在「无控制台父进程」中拉起 `powershell.exe` 会触发 `0xc0000142` 初始化失败；直接以 admAgent 作为 PTY 子进程规避该问题。`--cwd` 作为参数传入。
  - **macOS**：启动系统默认 shell（`$SHELL`，通常为 `/bin/zsh`，以 `-i` 交互模式运行），再写入启动命令运行 admAgent。
- PTY 输出经后台线程读取后以 base64 通过 `agent-terminal-data` 事件推送到前端；前端按键经 `agent_terminal_input` 写回 PTY。
- **会话代次 + 读取线程生命周期（防重复输出）**：每次 `start_agent_terminal` 会 bump 一个单调递增的「Agent 终端代次」(`AppState.agent_generation`)，并把该值随每帧 `agent-terminal-data` 的 payload (`{ data, gen }`) 与 `agent-terminal-ready` 的 payload (`{ gen }`) 一同下发给前端。前端 `agent.html` 在收到 `ready` 时记录 `currentAgentGen`，此后仅接受 `gen === currentAgentGen` 的数据帧，旧代次残留输出一律丢弃——从结构上杜绝「同一输出显示两遍」。
- **读取线程回收**：`AgentSession` 保存 `reader_stop: Arc<AtomicBool>` 与 `reader_handle: JoinHandle`。(重)启动 / 停止时经 `stop_agent_session_clean` 先置位 stop、再 kill 子进程树（让阻塞 `read` 收到 EOF 唤醒）、最后 `is_finished()` 轮询 join（500ms 超时），确保旧线程在 spawn 新会话前完全退出，不会与新线程并发向同一事件推送数据。
- 终端就绪后自动向 shell 发送启动命令运行 `admAgent` 工具（同时启动终端与 `admAgent`）。
- **启动前自动生成 `admAgent.json`**：`ensure_adm_agent_config` 读取 ADM 配置文件（`config.json`）中 `launch_params.ctx_size` 作为上下文大小，于用户目录 `<home>/.config/admAgent/admAgent.json` 生成（或更新）配置。默认结构为 `{ "model": { "provider": "local", "model": "localModel" }, "providers": { "local": { ... } } }`；`context_window` 取该值，`default_max_tokens` 取其 30%（四舍五入）；若文件已存在则仅就地更新这两个字段，尽量保留其它内容。`ctx_size` 缺失或非法时回退默认 `context_window = 25600`。
  - **触发时机 1（更早）**：点击 Agent 按钮时，`goAgent()` 在平台判断通过后即调用 `prepare_adm_agent_config`（早于模型运行检查与 admAgent 下载）。
  - **触发时机 2（兜底）**：`start_agent_terminal` 创建 PTY 之前也会再调用一次，保证最终一致。
- 支持通过 `agent_terminal_resize` 调整终端大小、`stop_agent_terminal` 关闭会话；窗口关闭时 `lib.rs` 会调用 `kill_agent_session` 清理子进程。
- **resize 统一节流（减少 TUI 整屏重绘）**：`agent.html` 的 `scheduleFitResize(delay)` 作为唯一 fit + resize 入口（带 trailing 节流），`ResizeObserver`、`window resize`、`agent-resize` 消息、`agent-terminal-ready`、`startAgentNow` 末尾全部走该入口，避免多源重复触发 `fitAddon.fit()` + `agent_terminal_resize` 导致 ratatui 反复整屏重绘放大重复观感。首帧 / ready 时用 `delay=0` 立即执行。
- **避免在 iframe 隐藏时创建 PTY（防止 TUI 右边栏错位 / 重复）**：`index.html` 在把 `agent-frame` 显示为 `block` 后再设置 `src`；`agent.html` 初始化时若容器尺寸为 0（仍不可见），则通过 `ResizeObserver` 与父窗口 `agent-resize` 消息延迟到真正显示后再启动终端。这样可保证 `xterm` 的 `fitAddon` 取到真实尺寸，`start_agent_terminal` 创建 PTY 时行列数正确，避免 admAgent 的 TUI 右边栏上下文按错误宽度布局，从而出现错位或重复显示。
- **复制 / 粘贴（终端级体验）**：`agent.html` 通过 `term.attachCustomKeyEventHandler` 实现类似真实终端的 Ctrl+C / Ctrl+V：
  - **Ctrl+C**：有文本选区时复制选区到系统剪贴板（优先 `navigator.clipboard.writeText`，失败回退 `textarea + document.execCommand('copy')`）；无选区时放行，xterm 把 `\x03`(SIGINT) 发给 admAgent，等价于终端中断。
  - **Ctrl+V**：从系统剪贴板读取文本并经 `term.paste()` 写入 PTY。若 iframe 内 `navigator.clipboard.readText` 受限，则通过 `agent-read-clipboard` 事件委托父窗口 `index.html` 代理读取（回传 `agent-clipboard-result`）。读取失败时终端内提示「无法访问剪贴板」。
- **中文 IME 偶发重复输入修复（三重防线）**：xterm 在 IME 合成结束时存在两条可能同时触发的发送路径——(A) `compositionend → _finalizeComposition` 用 `setTimeout(0)` 异步 `triggerDataEvent`；(B) 紧跟的 `input(insertText)` 事件在纯 IME 选词（`_keyDownSeen=false`）时同步 `triggerDataEvent`。两条路径发出同一段合成文本 → 打字重复。`agent.html` 的修复：
  - **防线 0（源头拦截，确定性）**：document 捕获阶段监听 `input`，若事件来自 xterm 辅助 textarea、`inputType === "insertText"`、文本与刚结束的合成严格一致且距 `compositionend` 不到 500ms，`stopImmediatePropagation()` 吞掉它（先于 xterm 注册在 textarea 上的 `_inputEvent` 执行），只保留路径 A 这唯一一次发送。不依赖任何调度时延，主线程拥塞时也必然命中。
  - **防线 1（onData 合成文本去重，安全网）**：首次见到合成文本放行；2000ms 窗口内再次见到丢弃【仅一次】并清空合成记录（每次 `compositionend` 最多只丢一个副本，后续相同内容一律放行）。窗口取 2000ms 是因为终端重启（设置工作目录 / 增删云端模型）后 TUI 首屏整帧渲染拥塞主线程，`setTimeout(0)` 可能延迟数百毫秒，更小的窗口会在该场景漏判。
  - **防线 2（通用相邻去重，兜底）**：连续两次 `onData` 收到完全相同文本、间隔 <150ms 且 600ms 内有 IME 合成活动，判为重复丢弃。
  - **粘贴绕过**：`term.paste` 覆写在粘贴期间置 `_suppressImeDedup`，粘贴内容不参与 IME 去重（防止粘贴文本恰好等于刚合成文本时被误丢）。
- **启动守卫 `startRequested`（防并发启动）**：`startAgentNow()` 从进入起占用 `startRequested`，覆盖 `await start_agent_terminal` 整个异步窗口，成功后释放（运行中状态由 `terminalStarted` 表达），失败也释放。`confirmWorkdir()` / `restartAgentTerminal()` 在 `await stop_agent_terminal` 前先占用守卫。否则窗口期内 `agent-resize` / `ResizeObserver` 触发 `handleEnterAgent` / `maybeStartTerminal` 会并发发起第二次 `start_agent_terminal`，产生无法回收的孤儿 admAgent 进程；守卫在启动成功后释放，也保证了进程退出后 `handleEnterAgent` 能重新拉起。

### 13.3 相关命令（`src-tauri/src/pages/agent.rs`）

| 命令 | 说明 |
|------|------|
| `prepare_adm_agent_config` | 点击 Agent 按钮时（平台判断通过后）提前调用：生成 / 更新 `admAgent.json`（早于模型检查与 admAgent 下载，不依赖两者） |
| `check_adm_agent` | 检查本地 `admAgent` 是否存在，返回路径（Agent 按钮点击时优先级 2 判断本地是否已下载） |
| `check_adm_agent_update` | 点击 Agent 按钮时触发（优先级 3）：拉取远程清单比对本地 `admAgent` 版本号，返回是否需要更新及下载地址（仅 Windows） |
| `download_adm_agent` | 首次安装：下载 `admAgent` 工具并推送进度（Agent 按钮点击时优先级 2 调用） |
| `download_adm_agent_update` | 版本更新用：从 `check_adm_agent_update` 下发的地址下载并替换 `admAgent`（仅 Windows，推送 `adm-agent-update-progress`）。**替换前会自动停掉仍在运行的 Agent 终端**以释放 Windows 文件锁，避免「Agent 页未关闭时回到首页再进入触发更新 → 升级失败」的问题 |
| `start_agent_terminal` | 启动内嵌 PTY 终端并自动运行 `admAgent` |
| `agent_terminal_input` | 向前端按键写入 PTY |
| `agent_terminal_resize` | 调整终端行列 |
| `stop_agent_terminal` | 关闭终端会话 |
| `add_cloud_provider` | 新增云端模型 Provider：写入 `admAgent.json` 的 `providers` 分支（`type=openai-compat`，含 `models` 数组）。写入前先 `ensure_adm_agent_config` 保证文件含合法 `providers.local`，避免后续启动 Agent 时被默认结构覆盖。provider key 与 model id 由模型名称派生（slugify），原子写入。上下文大小 `256K=256000`（K×1000、M×1000000） |
| `list_cloud_providers` | 列出 `admAgent.json` 中已添加的云端模型 Provider（排除自动管理的 `local`），返回每项 `key/name/base_url/api_key/context_window`，供「模型管理」弹窗列表展示与编辑回填 |
| `update_cloud_provider` | 按 `key` 定位并更新指定 Provider 的全部参数；模型名称变更时同步重派生 model id，保留同一 key 以免产生孤儿条目 |

- **云端模型管理（前端 `agent.html`）**：顶部栏「添加云端模型」弹出表单（模型名称 / Base URL / API Key / 上下文大小，默认 256000），「模型管理」弹出已添加模型列表，每项带「编辑」按钮，编辑复用同一表单并回填参数。
- **云端 provider 不被覆盖**：`add_cloud_provider` / `update_cloud_provider` 均保持 `providers.local` 存在；由于 `ensure_adm_agent_config` 仅原地更新 `providers.local`，用户新增 / 编辑的云端 provider 在改上下文大小、重进 Agent 页等场景下均被保留。

---

## 十二、参考资料

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

*文档版本: 3.13*\
*最后更新: 2026-07-23*\
*维护者: ADM 开发团队*

***

### 更新日志

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-07-23 | **3.13** | 修复 Agent 终端设置工作目录（或增删云端模型触发重启）后偶发打字重复：<br>1. **新增防线 0（源头拦截）**：document 捕获阶段吞掉 `compositionend` 后紧跟的冗余 `input(insertText)` 事件（xterm IME 双路径中的同步路径），只保留 `setTimeout(0)` finalize 路径这唯一一次发送，不再依赖调度时延<br>2. **防线 1 强化**：onData 合成文本去重窗口 250ms → 2000ms（终端重启后 TUI 首屏整帧渲染拥塞主线程，`setTimeout(0)` 可能延迟数百毫秒，原窗口漏判是本次 bug 的直接原因）；每次 `compositionend` 最多只丢一个副本（丢弃后立即清空合成记录），粘贴经 `_suppressImeDedup` 绕过去重，杜绝误丢合法输入<br>3. **启动守卫修复**：`startAgentNow()` 进入即占用 `startRequested`、成功/失败后释放；`confirmWorkdir()` / `restartAgentTerminal()` 停旧会话前先占用守卫——修复裸调 `startAgentNow` 期间 `handleEnterAgent` / `maybeStartTerminal` 可能并发发起第二次 `start_agent_terminal` 产生孤儿 admAgent 进程的问题，同时恢复「进程退出后重进 Agent 页自动重启」路径（此前守卫在成功启动后永久滞留会堵死该路径） |
| 2026-07-20 | **3.12** | 修复 Agent 终端内容较多时出现重复输出的问题（三层加固）：<br>1. **会话代次标记**：`AppState` 新增 `agent_generation`，`start_agent_terminal` 每次 +1；`agent-terminal-data` / `agent-terminal-ready` 的 payload 携带 `gen` 字段。前端 `agent.html` 在 `ready` 时记录 `currentAgentGen`，此后仅接受当前代次的数据帧，旧会话残留输出一律丢弃——结构上杜绝「同一输出显示两遍」<br>2. **读取线程生命周期**：`AgentSession` 新增 `reader_stop: Arc<AtomicBool>` 与 `reader_handle: JoinHandle`；新增 `stop_agent_session_clean`：置位 stop → kill 子进程树（让阻塞 read 收 EOF 唤醒）→ `is_finished()` 轮询 join（500ms 超时）。`start_agent_terminal` / `stop_agent_terminal` / `kill_agent_session` 均改用该函数，确保旧线程在 spawn 新会话前完全退出，不再与新线程并发 emit<br>3. **resize 统一节流**：`agent.html` 新增 `scheduleFitResize(delay)` 作为唯一 fit + resize 入口（trailing 节流），`ResizeObserver` / `window resize` / `agent-resize` / `ready` / `startAgentNow` 末尾全部走该入口，减少 ratatui 整屏重绘次数<br>4. **`handleEnterAgent` 健壮化**：`get_agent_status` 返回 `Err` 时不再兜底重启（避免进程 spawn 瞬时空窗误判为「未运行」而二次拉起 → 两个 admAgent 并发写 PTY） |
| 2026-07-18 | **3.11** | 修复主程序关闭后 llama-server / sd-cli 进程残留问题：<br>1. 新增 `platform::kill_process_tree`（taskkill /PID /T /F 或 kill -9 -<pgid>）和 `platform::kill_process_by_name` 兜底清理<br>2. 窗口关闭事件改为先按 PID 杀整棵进程树，再按进程名兜底强杀残留，避免 PID 记录丢失/复用导致孤儿进程<br>3. Unix 下 llama-server / sd-cli 以独立进程组（process_group(0) + setsid）启动，`kill -9 -<pgid>` 可一次杀掉整棵树<br>4. `stop_model` / `stop_sd` 改用 `kill_process_tree`，与窗口关闭逻辑一致 |
| 2026-06-21 | **3.9** | 官网 SEO 优化：<br>1. 添加 Open Graph / Twitter Card 元标签<br>2. 添加 canonical URL 和 JSON-LD 结构化数据<br>3. 创建 robots.txt 和 sitemap.xml<br>4. 图片添加 loading="lazy"，emoji 图标添加 role="img" + aria-label<br>5. 修复"文生图"特性图标损坏的 emoji |
| 2026-07-11 | **3.10** | 修复 admAgent 升级失败：<br>1. `download_adm_agent_update` 在替换 `admAgent.exe` 前，先停掉仍在运行的 Agent 终端进程树，释放 Windows 文件锁<br>2. 对删除旧文件的 `remove_file` 增加重试（最多 15 次、间隔 200ms），容忍进程退出延迟<br>3. 修复场景：Agent 页已打开 → 回首页 → 再次进入并弹出升级提示时，因旧进程占用二进制导致 rename 失败报「升级失败」，现无需手动关闭 Agent 进程即可完成更新 |
| 2026-06-21 | **3.8** | MTP 模型自动检测：<br>1. `LaunchParams` 新增 `spec_draft_n_max`、`spec_type` 字段<br>2. `start_model` 自动检测模型文件名是否包含 MTP，追加 `--spec-draft-n-max 3 --spec-type draft-mtp` 参数<br>3. 支持用户通过 `params.spec_type` 手动覆盖（设为 `"none"` 可禁用自动检测） |
| 2026-06-16 | **3.7** | 修复桌面图标模糊问题：<br>1. 新增 `scripts/generate-icons.py` 一键生成所有图标<br>2. PNG 尺寸改为 32/64/128/256，移除旧的 @2x/@4x 命名<br>3. 重新生成 `icon.ico`，从单张 128×128 升级为 6 张分辨率(含 256×256)解决模糊<br>4. 重新生成 `icon.icns`（含 ic07/ic08/ic09 三种 macOS 类型）<br>5. 更新 `tauri.conf.json` bundle.icon 配置 |
| 2026-06-10 | 3.6 | 修复模型启动失败后无法重新启动的问题：<br>1. start_model 后台线程检测到进程退出时，在发送 model-stopped 事件前清除 AppState 中的 running_process/running_model_id/running_port 状态<br>2. 更新开发文档中模型启动流程说明 |
| 2026-06-10 | 3.5 | GPU 检测回退策略改进：<br>1. llamacpp 和 sd-cli 下载时，未检测到支持的 GPU 或未知 GPU 型号时，不再抛出错误，统一回退下载 Vulkan 版本<br>2. 更新开发文档中硬件适配策略表和更新日志 |
| 2026-06-10 | 3.4 | 修复 llamacpp 下载失败问题：<br>1. reqwest TLS 后端从 native-tls 切换到 rustls-tls，避免 Windows 上 SSL/TLS 兼容性问题<br>2. URL 为空时前端直接提示，不再发送无效请求<br>3. 改进下载错误提示，区分 builder/connect/timeout/TLS 等错误类型 |
