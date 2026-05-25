# ADM 开发文档

> ADM (Automatic Deployment Model) — llama.cpp 图形化管理桌面应用

---

## 一、项目概述

### 1.1 项目目标

将 llama.cpp 复杂的 CLI 启动指令通过 GUI 界面化配置，让用户能够便捷地在本地部署和运行大语言模型。

### 1.2 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Tauri | 2.11.2 |
| 后端语言 | Rust | 2021 edition |
| 前端 | 原生 HTML/CSS/JS | - |
| 页面架构 | iframe 嵌入 + postMessage 通信 | - |
| 窗口模式 | 单窗口 | - |
| 硬件信息插件 | tauri-plugin-hwinfo | 0.2.3 |
| 系统信息 | sysinfo | 0.33 |
| HTTP 客户端 | reqwest | 0.12 |
| 异步运行时 | tokio | 1.x |
| 包管理器 | pnpm | - |

### 1.3 核心功能

1. **模型列表展示**：从远程 JSON (`https://adm.tuduoduo.top/model.json`) 获取模型列表，展示名称、大小、内存需求、工具调用、推理、图片识别支持能力及运行状态
2. **模型下载**：支持进度显示、断点续传（`.part` 文件）、本地模型扫描、HuggingFace 国内镜像自动替换（`huggingface.co` → `hf-mirror.com`）
3. **模型启动**：通过 CLI 方式调用 llama.cpp 启动模型，参数可视化配置
4. **硬件监控**：实时显示内存、显存、CPU 信息（使用 tauri-plugin-hwinfo 增强检测）
5. **模型交互**：内嵌 iframe 加载 llama.cpp-server 的 Web 页面，支持自动轮询检测服务就绪
6. **参数配置**：可视化配置 llama.cpp 启动参数，支持保存/加载/恢复默认
7. **自动更新**：检查更新并提示下载新版本

---

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
│  │  │  │ .html (模型    │ │ (设置页面)              │  │  │  │
│  │  │  │ 列表页)        │ │                         │  │  │  │
│  │  │  └────────────────┘ └─────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────────────┐   │  │  │
│  │  │  │ model_chat.html (模型对话交互页)          │   │  │  │
│  │  │  └──────────────────────────────────────────┘   │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │         ↕ postMessage 父子通信                         │  │
│  │         ↕ IPC (invoke / event / emit)                 │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │            Rust 后端 (Commands)                          │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │  │
│  │  │系统信息       │ │文件操作       │ │进程管理        │  │  │
│  │  │内存/CPU/GPU  │ │下载/续传      │ │llama.cpp       │  │  │
│  │  │hwinfo 插件    │ │模型扫描       │ │启动/停止       │  │  │
│  │  │              │ │.part 扫描     │ │config 持久化    │  │  │
│  │  └──────────────┘ └──────────────┘ └────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  AppState                                        │  │  │
│  │  │  ├─ running_process: Mutex<Option<u32>>          │  │  │
│  │  │  ├─ running_model_id: Mutex<Option<String>>      │  │  │
│  │  │  ├─ running_port: Mutex<Option<u16>>             │  │  │
│  │  │  └─ sys: Mutex<System>                           │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           llamacpp/ (可执行文件)                         │  │
│  │  ├── windows/ → llama-server.exe                        │  │
│  │  ├── linux/   → llama-server                            │  │
│  │  └── mac/     → llama-server                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 前后端职责划分

| 职责 | 前端 (JS) | 后端 (Rust) |
|------|-----------|-------------|
| UI 渲染与交互 | ✅ | ❌ |
| iframe 页面路由 | ✅ | ❌ |
| 事件转发 (postMessage) | ✅ | ❌ |
| 模型列表展示 | ✅ | ❌ |
| 系统信息采集 | ❌ | ✅ |
| 文件下载（含断点续传） | ❌ | ✅ |
| 进程管理 (llama.cpp) | ❌ | ✅ |
| 本地模型扫描 | ❌ | ✅ |
| .part 文件扫描 | ❌ | ✅ |
| GPU/VRAM 检测 | ❌ | ✅ |
| 配置文件读写 | ❌ | ✅ |
| 远程模型列表获取 | ❌ | ✅ |
| 自动更新检查 | ❌ | ✅ |

### 2.3 IPC 通信设计

#### Invoke 调用

前端通过 `window.__TAURI_INTERNALS__.invoke()` 或 `window.__TAURI__.core.invoke()` 调用 Rust Command。采用双兼容模式确保 Tauri 1.x 和 2.x 都能正常工作。

**主窗口（index.html）写法**：

```javascript
const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
const listen = window.__TAURI_INTERNALS__?.listen || window.__TAURI__?.event?.listen;
```

**iframe 子页面写法**（需增加 `window.parent` 回退）：

macOS 的 WKWebView 不会将 Tauri IPC 桥接注入到 iframe 中，因此 iframe 页面需要通过 `window.parent` 回退到主窗口获取 IPC 桥接。

```javascript
const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke || window.parent?.__TAURI_INTERNALS__?.invoke || window.parent?.__TAURI__?.core?.invoke;
const listen = window.__TAURI_INTERNALS__?.listen || window.__TAURI__?.event?.listen || window.parent?.__TAURI_INTERNALS__?.listen || window.parent?.__TAURI__?.event?.listen;
```

#### Event 监听

```
前端 JS ──invoke──▶  Rust Command  ──return──▶  前端 JS
前端 JS ◀──event────  Rust Event   ──emit────▶  前端 JS
```

#### 主窗口 ↔ iframe 通信

采用 `postMessage` 机制，主窗口监听 Tauri 事件后转发给 iframe 子页面：

```
Tauri Event (Rust → JS)
       │
       ▼
index.html (主框架) 监听 Tauri 事件
       │
       ▼
iframe.contentWindow.postMessage({ type, payload }, "*")
       │
       ▼
子页面 (model_list.html / settings.html) 监听 window.message 事件
```

子页面也可以通过 postMessage 导航：

```javascript
// 子页面请求导航
window.parent.postMessage({ type: "navigate", page: "model_list.html" }, "*");

// index.html 监听导航请求
window.addEventListener("message", function (event) {
  if (event.data && event.data.type === "navigate") {
    document.getElementById("content-frame").src = event.data.page;
  }
});
```

---

## 三、目录结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档（本文件）
│   ├── llamacpp.txt                  # llama.cpp 参数参考
│   └── progect_doc.txt               # 需求文档
├── src/                              # 前端资源
│   ├── index.html                    # 主框架页（外壳容器 + iframe + 硬件信息栏）
│   ├── model_list.html               # 模型列表页（嵌入 iframe 中显示）
│   ├── model_chat.html               # 模型对话交互页（嵌入 iframe 中显示）
│   └── settings.html                 # 设置页面（嵌入 iframe 中显示）
├── src-tauri/                        # Tauri 后端
│   ├── Cargo.toml                    # Rust 依赖配置
│   ├── Cargo.lock
│   ├── build.rs
│   ├── tauri.conf.json               # Tauri 核心配置
│   ├── tauri.windows.conf.json       # Windows 平台配置
│   ├── tauri.linux.conf.json         # Linux 平台配置
│   ├── tauri.macos.conf.json         # macOS 平台配置
│   ├── capabilities/
│   │   └── default.json              # 权限配置
│   ├── icons/                        # 应用图标
│   ├── llamacpp/                     # llama.cpp 可执行文件（构建时打包资源）
│   │   ├── windows/
│   │   │   └── llama-server.exe
│   │   ├── linux/
│   │   │   └── llama-server
│   │   └── mac/
│   │       └── llama-server
│   └── src/
│       ├── main.rs                   # 入口（仅包含 run() 调用）
│       └── lib.rs                    # 核心逻辑（AppState、所有 Commands）
├── models/                           # 模型文件存放目录（运行时创建）
│   ├── {model_id}.gguf               # 已下载的模型文件
│   └── {model_id}.gguf.part          # 下载未完成的临时文件
├── config.json                       # 启动参数配置文件（运行时创建）
├── package.json
│   ├── pnpm-lock.yaml
│   ├── AGENTS.md
│   └── .gitignore
```

**关键约定**：
- `models/` 目录和 `config.json` 在软件首次运行时由后端自动创建
  - Windows/Linux：位于可执行文件同级目录
  - macOS：位于 `~/Library/Application Support/com.adm.admapp/`（避免 App Translocation 导致路径不稳定和写入 .app 包破坏签名）
- `llamacpp/` 目录作为 `bundle.resources` 打包到安装包中，运行时可通过相对路径找到
- 每个 HTML 页面的 CSS 和 JS 内联写在同一文件中，不单独拆分
- 项目采用 `pnpm` 作为包管理器

---

## 四、页面设计

### 4.1 主框架 (`index.html`)

#### 4.1.1 窗口配置

```json
{
  "title": "ADM",
  "width": 1280,
  "height": 768,
  "center": true,
  "minWidth": 800,
  "minHeight": 600,
  "decorations": true
}
```

#### 4.1.2 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│  ADM                                                  _ □ X  │  ← 标题栏（Tauri 原生）
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
│ ☰首页 │ ⚙设置 │ 内存 32GB │ 显存 11GB(RTX 4090) │ CPU 8C/16T│  ← 底部硬件信息栏
└──────────────────────────────────────────────────────────────┘
```

#### 4.1.3 初始化流程

```
页面加载
  │
  ├── 1. 调用 invoke("get_system_info") → 获取系统硬件信息
  │
  ├── 2. 尝试调用 plugin:hwinfo|get_cpu_info / get_ram_info / get_gpu_info / get_os_info
  │        → 若成功，用 hwinfo 数据覆盖 sysinfo 数据（更精确）
  │
  ├── 3. 更新硬件信息栏显示
  │
  ├── 4. 设置 Tauri 事件监听，监听以下事件并转发给 iframe：
  │        download-progress → postMessage 转发
  │        download-complete → postMessage 转发
  │        model-started     → postMessage 转发
  │        model-stopped     → postMessage 转发
  │        model-error       → postMessage 转发
  │        model-log         → postMessage 转发
  │        download-error    → postMessage 转发
  │
  ├── 5. 安装 message 监听器，接收子页面导航请求
  │
  └── 6. 延迟 3 秒后静默检查更新（有新版本才弹窗）
```

#### 4.1.4 硬件信息栏

| 信息项 | 显示格式 | 数据来源 | 更新时机 |
|--------|----------|----------|----------|
| 内存 | `总内存` (如 32GB) | sysinfo + hwinfo 增强 | 启动时一次 |
| 显存 | `总显存` (如 11GB)，无显卡显示"无显卡"，有显卡显示型号 | hwinfo GPU 检测 | 启动时一次 |
| CPU | `型号 物理核心C/逻辑线程T` (如 Intel i7 8C/16T) | sysinfo + hwinfo | 启动时一次 |

**数据优先级**：hwinfo 插件 > sysinfo（hwinfo 提供更精确的硬件型号和容量）

#### 4.1.5 事件转发机制

```javascript
// index.html 接收 Tauri 事件 → 转发给 iframe
listen("download-progress", (event) => {
  const frame = document.getElementById("content-frame");
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "download-progress", payload: event.payload }, "*");
  }
});

// 子页面接收转发的事件
window.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || !data.type) return;
  switch (data.type) {
    case "download-progress": // 更新下载进度按钮
    case "download-complete": // 刷新模型列表
    case "model-started":     // 显示已启动状态
    case "model-stopped":     // 显示停止状态
    case "model-error":       // 显示错误提示
    case "model-log":         // 显示日志
    case "download-error":    // 显示下载错误
    // ...
  }
});
```

#### 4.1.6 自动更新功能

- 启动时静默检查更新（3 秒延迟），有新版本才弹窗
- 设置页面支持手动点击"检查新版本"
- 更新服务器：`https://adm.tuduoduo.top/update.json`
- 弹窗包含：当前版本、最新版本、下载按钮、更新说明链接

---

### 4.2 模型列表页 (`model_list.html`)

#### 4.2.1 页面布局

```
┌───────────────────────────────────────────────────────────────────┐
│ 模型列表                                                          │
├───────────────────────────────────────────────────────────────────┤
│ ┌──────────┬────────┬────────┬──────────┬────────┬────────┬──────┤
│ │ 模型名称 │模型大小│内存需求│ 工具调用 │  推理  │图片识别│状态  │
│ ├──────────┼────────┼────────┼──────────┼────────┼────────┼──────┤
│ │ Qwen3.5  │ 5.6GB  │ 32 GB  │  支持    │ 支持   │ 不支持 │可用  │
│ │ -9B-Q4.. │        │        │          │        │        │      │
│ │          │        │        │          │        │        │[下载]│
│ ├──────────┼────────┼────────┼──────────┼────────┼────────┼──────┤
│ │ ...      │ ...    │ ...    │ ...      │ ...    │ ...    │ ...  │
│ └──────────┴────────┴────────┴──────────┴────────┴────────┴──────┘
└───────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 模型列表数据源

- **远程地址**：`https://adm.tuduoduo.top/model.json`
- **获取方式**：Rust 后端通过 `fetch_model_list` Command 获取
- **数据格式**：

```json
[{
  "model_id": "Qwen3.5-9B-Q4_K_M",
  "model_url": "https://huggingface.co/...",
  "model_size": "5.6GB",
  "need_ram": "32",
  "support_tools": true,
  "support_reasoning": true,
  "support_images": false
}]
```

| 字段 | 说明 | 列显示 |
|------|------|--------|
| `model_id` | 模型名称，也作为本地文件名标识 | ✅ 模型名称列 |
| `model_url` | 模型下载地址（自动将 huggingface.co 替换为 hf-mirror.com） | ❌ 不显示 |
| `model_size` | 模型文件大小 | ✅ 模型大小列 |
| `need_ram` | 最低内存需求（GB），整数 | ✅ 内存需求列 |
| `support_tools` | 是否支持工具调用 | ✅ 工具调用列 |
| `support_reasoning` | 是否支持推理 | ✅ 推理列 |
| `support_images` | 是否支持图片识别 | ✅ 图片识别列 |

#### 4.2.3 状态列逻辑

```
状态判断流程：
┌─────────────────────────┐
│ 获取 RAM-C（内存+显存总量）│
└────────────┬────────────┘
             │
     ┌───────▼───────┐
     │ RAM-C >= need_ram │
     └───┬───────┬───┘
         │       │
    是   │       │  否
         │       │
    ┌────▼──┐  ┌─▼──────┐
    │ 可用  │  │ 不可用  │
    └───────┘  └────────┘

    额外：正在运行的模型 → 状态显示"已启动"
```

#### 4.2.4 下载按钮状态机

```
┌──────────┐  RAM-C不足  ┌──────────┐
│  不可用   │◄──────────│  初始    │
│ (disabled)│           │ (检查条件)│
└──────────┘           └────┬─────┘
                            │ RAM-C满足
                     ┌──────▼──────┐
                     │   可下载    │
                     │  (可点击)   │
                     └──────┬──────┘
                            │ 点击下载
                     ┌──────▼──────┐
                     │  下载中 X%  │
                     │ (显示进度)  │
                     └──────┬──────┘
                            │ 下载完成
                     ┌──────▼──────┐
                     │   已下载    │
                     │ (disabled)  │
                     └─────────────┘

断点续传检测：存在 .gguf.part 文件时 → 显示"继续下载"
```

**下载进度**：
- 点击下载后，按钮文字变为 `0%` ~ `99%` 实时更新
- 有 `.part` 文件时按钮显示"继续下载"，点击后显示"继续下载中..."
- 下载完成（100%）后 `.part` 重命名为 `.gguf`，按钮变为`已下载`（disabled）
- 每次软件启动时调用 `scan_local_models` 扫描 `models/` 目录，调用 `scan_part_files` 检测未完成的下载

#### 4.2.5 启动按钮状态机

```
┌──────────┐           ┌──────────┐
│  不可用   │◄─────────│ 模型未下载│
│ (disabled)│ 或 RAM-C │ 或RAM-C  │
└──────────┘  不足      │ 不足     │
                        └──────────┘
```

---

### 4.3 模型交互页 (`model_chat.html`)

#### 4.3.1 页面设计

- 顶部栏：返回按钮、模型名称、连接状态指示器
- 主体：iframe 嵌入 llama.cpp-server 的 Web UI
- 加载遮罩：服务就绪前显示"模型启动中，请耐心等待..."

#### 4.3.2 服务就绪检测

```
页面加载
  │
  ├── 1. 解析 URL 参数：model_id、port
  │
  ├── 2. 显示加载遮罩，文字"模型启动中，请耐心等待..."
  │
  ├── 3. 延迟 1 秒后开始轮询检测服务
  │        (每 1 秒一次，最多 120 次 = 2 分钟)
  │
  ├── 4. XHR 请求 http://127.0.0.1:{port}
  │        成功 → 加载 iframe → 隐藏遮罩 → 显示"已连接"
  │        失败 → 重试计数+1
  │
  └── 5. 超时后显示"连接超时，请检查模型是否正常启动"
```

---

### 4.4 设置页 (`settings.html`)

#### 4.4.1 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│ 设置                                                         │
├──────────────────────────────────────────────────────────────┤
│ ┌────────────────┬─────────────────────────────────────────┐ │
│ │ 导航栏         │ 内容区                                   │ │
│ │────────────────│─────────────────────────────────────────│ │
│ │ ▶ 模型启动参数 │ 参数表单（基础/GPU/性能/采样/服务）      │ │
│ │   系统版本号   │ 版本信息表格 + 检查更新按钮              │ │
│ │   关于         │ 项目介绍 + 链接                          │ │
│ └────────────────┴─────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

#### 4.4.2 模型启动参数

| 参数组 | 参数 | CLI 标志 | 默认值 | 说明 |
|--------|------|----------|--------|------|
| 基础参数 | 上下文大小 | `-c, --ctx-size` | 4096 | |
| | 预测 token 数 | `-n, --n-predict` | -1 | -1 表示无限 |
| | 批处理大小 | `-b, --batch-size` | 2048 | |
| | 微批次大小 | `-ub, --ubatch-size` | 512 | |
| GPU 参数 | GPU 层数 | `-ngl, --n-gpu-layers` | auto | auto/all/0/数字/自定义 |
| 性能参数 | 线程数 | `-t, --threads` | 自动 | 留空为自动 |
| | 批处理线程数 | `-tb, --threads-batch` | 同线程数 | |
| | Flash Attention | `-fa, --flash-attn` | auto | auto/on/off |
| | KV 缓存类型 K | `-ctk, --cache-type-k` | f16 | f16/f32/q8_0/q4_0/q4_1/q5_0/q5_1 |
| | KV 缓存类型 V | `-ctv, --cache-type-v` | f16 | 同上 |
| | 内存锁定 | `--mlock` | false | 强制模型驻留 RAM |
| | 内存映射 | `--mmap` | true | 启用内存映射 |
| 采样参数 | 温度 | `--temp` | 0.8 | |
| | Top-K | `--top-k` | 40 | |
| | Top-P | `--top-p` | 0.95 | |
| | Min-P | `--min-p` | 0.05 | |
| | 重复惩罚 | `--repeat-penalty` | 1.0 | |
| 服务参数 | 监听端口 | `--port` | 8080 | |
| | 监听地址 | `--host` | 127.0.0.1 | 127.0.0.1 / 0.0.0.0 |

#### 4.4.3 配置持久化

- 配置文件路径：
  - Windows/Linux：`{exe_dir}/config.json`
  - macOS：`~/Library/Application Support/com.adm.admapp/config.json`
- 保存：点击"保存设置"写入配置
- 加载：启动模型时自动读取配置
- 恢复默认：点击"恢复默认"重置为内置默认值

---

## 五、Rust 后端实现

### 5.1 核心数据结构

#### AppState

```rust
struct AppState {
    running_process: Mutex<Option<u32>>,
    running_model_id: Mutex<Option<String>>,
    running_port: Mutex<Option<u16>>,
    sys: Mutex<System>,
}
```

#### LaunchParams

```rust
struct LaunchParams {
    ctx_size: Option<i32>,
    n_predict: Option<i32>,
    batch_size: Option<i32>,
    ubatch_size: Option<i32>,
    n_gpu_layers: Option<String>,
    threads: Option<i32>,
    threads_batch: Option<i32>,
    flash_attn: Option<String>,
    cache_type_k: Option<String>,
    cache_type_v: Option<String>,
    mlock: Option<bool>,
    mmap: Option<bool>,
    temperature: Option<f64>,
    top_k: Option<i32>,
    top_p: Option<f64>,
    min_p: Option<f64>,
    repeat_penalty: Option<f64>,
    port: Option<u16>,
    host: Option<String>,
}
```

#### RemoteModel

```rust
struct RemoteModel {
    model_id: String,
    model_url: String,
    model_size: String,
    need_ram: String,
    support_tools: bool,
    support_reasoning: bool,
    support_images: bool,
}
```

### 5.2 Command 列表

| Command | 功能 | 参数 | 返回值 |
|---------|------|------|--------|
| `get_system_info` | 获取系统硬件信息 | - | `SystemInfo` |
| `scan_local_models` | 扫描本地已下载模型 | - | `Vec<String>` (model_ids) |
| `scan_part_files` | 扫描未完成的下载 | - | `Vec<PartFileProgress>` |
| `fetch_model_list` | 获取远程模型列表 | - | `Vec<RemoteModel>` |
| `download_model` | 下载模型（支持断点续传） | `model_id`, `model_url` | `()` |
| `start_model` | 启动模型 | `model_id`, `params` | `()` |
| `stop_model` | 停止模型 | - | `()` |
| `get_model_status` | 获取当前运行状态 | - | `ModelStatus` |
| `save_settings` | 保存启动参数配置 | `Settings` | `()` |
| `load_settings` | 加载启动参数配置 | - | `Settings` |
| `get_app_version` | 获取应用版本 | - | `String` |
| `get_llamacpp_version` | 获取 llama.cpp 版本 | - | `String` |
| `check_update` | 检查更新 | - | `UpdateCheckResult` |

### 5.3 关键实现要点

#### 5.3.1 目录路径查找策略

项目使用两个核心路径函数处理跨平台数据存储：

**`get_data_dir`**：获取数据存储目录（models、config.json 等）

```rust
fn get_data_dir(app: Option<&tauri::AppHandle>) -> Result<std::path::PathBuf, String> {
    // macOS: ~/Library/Application Support/com.adm.admapp/
    // 原因：macOS .app 包内路径不稳定（App Translocation 机制），
    // 且写入 .app 包内会破坏代码签名
    #[cfg(target_os = "macos")]
    if let Some(app_handle) = app {
        if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
            std::fs::create_dir_all(&app_data_dir).ok();
            return Ok(app_data_dir);
        }
    }
    // Windows/Linux: 使用可执行文件同级目录
    get_exe_dir()
}
```

**`get_base_dir`**：获取 llamacpp 目录的父路径

```rust
fn get_base_dir(app: Option<&tauri::AppHandle>) -> Result<std::path::PathBuf, String> {
    // 1. 资源目录查找（发布模式，llamacpp 打包在 .app/Resources/ 内）
    if let Some(app_handle) = app {
        if let Ok(resource_dir) = get_resource_dir(app_handle) {
            let test_path = resource_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(resource_dir);
            }
        }
    }
    
    // 2. 当前工作目录查找（开发模式）
    if let Ok(current_dir) = std::env::current_dir() {
        let mut test_dir = current_dir.clone();
        loop {
            let test_path = test_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(test_dir);
            }
            if !test_dir.pop() {
                break;
            }
        }
    }

    // 3. macOS app_data_dir 查找（用户手动安装的 llamacpp）
    #[cfg(target_os = "macos")]
    {
        if let Some(app_handle) = app {
            if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                let test_path = app_data_dir.join("llamacpp");
                if test_path.exists() {
                    return Ok(app_data_dir);
                }
            }
        }
    }

    // 4. 可执行文件目录查找（旧版本兼容）
    if let Ok(exe_dir) = get_exe_dir() {
        let test_path = exe_dir.join("llamacpp");
        if test_path.exists() {
            return Ok(exe_dir);
        }
    }

    // 5. 默认回退：macOS 用 app_data_dir，其他用 exe_dir
    #[cfg(target_os = "macos")]
    {
        if let Some(app_handle) = app {
            if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                std::fs::create_dir_all(&app_data_dir).ok();
                return Ok(app_data_dir);
            }
        }
    }

    get_exe_dir()
}
```

**各平台数据存储路径对照**：

| 数据 | Windows | Linux | macOS |
|------|---------|-------|-------|
| models/ | `{exe_dir}/models/` | `{exe_dir}/models/` | `~/Library/Application Support/com.adm.admapp/models/` |
| config.json | `{exe_dir}/config.json` | `{exe_dir}/config.json` | `~/Library/Application Support/com.adm.admapp/config.json` |
| llamacpp/ | `{exe_dir}/llamacpp/` | `{exe_dir}/llamacpp/` | `ADM.app/Contents/Resources/llamacpp/` 或 `~/Library/Application Support/com.adm.admapp/llamacpp/` |

#### 5.3.2 断点续传下载实现

```
下载流程：
1. 检查最终文件是否存在 → 存在则直接返回完成
2. 检查 .part 文件是否存在 → 获取已下载字节数
3. 获取最终下载 URL（处理 302 重定向）
   - 创建不跟随重定向的客户端
   - 从 Location 头获取真实 S3 签名 URL
4. 发起下载请求（添加 Range 头实现续传）
   - 续传时服务器应返回 206 Partial Content
   - 全新下载返回 200
5. 流式写入 .part 文件
   - 使用 tokio::fs::OpenOptions::new().append(true) 追加写入
   - 每接收一个 chunk 就 emit download-progress 事件
6. 下载完成 → 重命名 .part → .gguf → emit download-complete
```

**关键代码**：
```rust
// 处理重定向
let resolve_client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .build()?;

let resolve_resp = resolve_client.get(&model_url).send().await?;
let final_url = if status.is_redirection() {
    resolve_resp.headers().get("location").unwrap()
} else {
    &model_url
};

// 添加 Range 头
if existing_size > 0 {
    req = req.header("Range", format!("bytes={}-", existing_size));
}
```

#### 5.3.3 模型启动与进程管理

```
启动流程：
1. 检查是否已有模型在运行 → 是则拒绝
2. 查找 llama-server 可执行文件路径
3. 构建 CLI 参数列表
4. 使用 create_hidden_command 启动子进程（Windows 隐藏控制台）
5. 记录 PID、model_id、port 到 AppState
6. 立即 emit model-started 事件
7. 后台线程读取 stdout/stderr 并 emit model-log
8. 检测 "llama server listening" 关键词再次 emit model-started
9. 进程退出后 emit model-stopped
```

**Windows 隐藏控制台**：
```rust
#[cfg(target_os = "windows")]
fn create_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}
```

#### 5.3.4 自动更新实现

```
更新检查流程：
1. 获取当前版本号（从 tauri.conf.json）
2. 请求 https://adm.tuduoduo.top/update.json
3. 解析 UpdateInfo 结构
4. 比较版本号（semver 简单比较）
5. 根据平台选择下载链接：
   - Windows → update_info.windows.app_url
   - macOS → update_info.mac_os.app_url
   - Linux → 无自动更新
6. 返回 UpdateCheckResult 给前端
```

**UpdateInfo 结构**：
```json
{
  "version": "0.1.2",
  "windows": {
    "appUrl": "https://...",
    "content": "更新说明..."
  },
  "mac": {
    "appUrl": "https://...",
    "content": "更新说明..."
  }
}
```

---

## 六、Tauri 配置

### 6.1 核心配置 (`tauri.conf.json`)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ADM",
  "version": "0.1.2",
  "identifier": "com.adm.admapp",
  "build": {
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "ADM",
        "width": 1280,
        "height": 768,
        "center": true,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "resources": [],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

### 6.2 权限配置 (`capabilities/default.json`)

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
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

### 6.3 平台特定配置

- `tauri.windows.conf.json`：Windows 特定配置
- `tauri.linux.conf.json`：Linux 特定配置
- `tauri.macos.conf.json`：macOS 特定配置

---

## 七、依赖配置

### 7.1 Cargo.toml

```toml
[package]
name = "adm"
version = "0.1.0"
description = "A Tauri App"
authors = ["you"]
edition = "2021"

[lib]
name = "adm_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-hwinfo = "0.2.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sysinfo = "0.33"
reqwest = { version = "0.12", features = ["stream"] }
tokio = { version = "1", features = ["full"] }
dirs = "6"
futures-util = "0.3"
```

### 7.2 package.json

```json
{
  "name": "adm",
  "private": true,
  "version": "0.1.2",
  "type": "module",
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "tauri:build:windows": "tauri build --target x86_64-pc-windows-msvc",
    "tauri:build:linux": "tauri build --target x86_64-unknown-linux-gnu",
    "tauri:build:macos": "tauri build --target x86_64-apple-darwin"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  },
  "dependencies": {
    "tauri-plugin-hwinfo": "^0.2.3"
  }
}
```

---

## 八、开发指南

### 8.1 开发环境准备

#### 前置条件

- [Rust](https://www.rust-lang.org/) (推荐使用 rustup 安装)
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)

#### 获取 llama-server

将 llama.cpp 编译后的 `llama-server` 可执行文件放置到对应目录：

```
src-tauri/llamacpp/windows/llama-server.exe
src-tauri/llamacpp/linux/llama-server
src-tauri/llamacpp/mac/llama-server
```

可从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 下载预编译版本。

### 8.2 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式运行
pnpm tauri dev

# 构建生产版本
pnpm tauri build

# 清理构建目录
pnpm tauri clean
```

### 8.3 跨平台构建

```bash
# Windows
pnpm tauri build --target x86_64-pc-windows-msvc

# Linux
pnpm tauri build --target x86_64-unknown-linux-gnu

# macOS
pnpm tauri build --target x86_64-apple-darwin
```

---

## 九、调试技巧

### 9.1 常见问题排查

#### 问题：llama-server 找不到

**原因**：`llamacpp/` 目录路径查找失败

**排查**：
1. 检查 `src-tauri/llamacpp/{platform}/` 目录是否存在
2. 检查可执行文件权限（Linux/macOS 需要 `chmod +x`）
3. 查看 `get_base_dir()` 的查找日志

#### 问题：下载中断后无法续传

**原因**：服务器不支持 Range 请求或 `.part` 文件损坏

**排查**：
1. 检查 `.part` 文件大小是否合理
2. 查看 HTTP 响应状态码（应为 206）
3. 删除 `.part` 文件重新下载

#### 问题：模型启动后前端无响应

**原因**：进程启动失败或端口被占用

**排查**：
1. 查看 `model-log` 事件输出
2. 检查端口 8080 是否被占用
3. 手动运行 `llama-server -m model.gguf --port 8080` 测试

#### 问题：macOS 上 iframe 页面 invoke 报错 "invoke is not a function"

**原因**：macOS 的 WKWebView 不会将 Tauri IPC 桥接注入到 iframe 中，导致 `window.__TAURI_INTERNALS__` 和 `window.__TAURI__` 在 iframe 内为 `undefined`

**解决方案**：iframe 子页面需增加 `window.parent` 回退获取主窗口的 IPC 桥接：
```javascript
const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke
  || window.parent?.__TAURI_INTERNALS__?.invoke || window.parent?.__TAURI__?.core?.invoke;
```

#### 问题：macOS 上 llamacpp 每次启动都重复下载

**原因**：macOS 的 App Translocation 机制会将网络下载的 `.app` 放到随机临时目录运行，导致 `get_exe_dir()` 每次返回不同路径；且写入 `.app` 包内会破坏代码签名

**解决方案**：macOS 使用 `app_data_dir`（`~/Library/Application Support/com.adm.admapp/`）存储数据文件，路径稳定且不受 App Translocation 影响

#### 问题：macOS 上显存显示为 0

**原因**：Apple Silicon 采用统一内存架构，GPU 和 CPU 共享同一块物理内存，不存在独立显存

**说明**：当前实现将系统总内存作为显存近似值返回，这是 Apple Silicon 架构下的合理近似

### 9.2 日志查看

- Rust 日志：在 `tauri dev` 终端查看
- 前端日志：浏览器开发者工具 Console
- 模型日志：通过 `model-log` Tauri 事件接收

---

## 十、安全考虑

### 10.1 CSP 配置

当前 CSP 设置为 `null`（宽松模式），允许所有资源加载。生产环境建议：

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* https://adm.tuduoduo.top;"
}
```

### 10.2 权限最小化

`capabilities/default.json` 已遵循最小权限原则：
- 仅开放必要的 hwinfo 权限
- 仅允许 `core:event:listen` 和 `core:event:emit`
- 未启用 `fs`、`shell` 等高风险权限

### 10.3 输入验证

- 所有用户输入（参数配置）在 Rust 端进行类型验证
- 下载 URL 自动替换为受信任的镜像源
- 更新服务器 URL 固定，不可配置

---

## 十一、性能优化

### 11.1 下载优化

- 使用 `reqwest` 的 `stream` 功能实现流式下载
- 每接收一个 chunk 立即写入文件并更新进度
- 避免一次性加载整个文件到内存

### 11.2 启动优化

- 硬件信息获取在页面初始化时一次性完成
- 模型列表异步加载，不阻塞 UI 渲染
- 服务就绪检测采用轮询而非长连接

### 11.3 内存优化

- `sysinfo::System` 使用 `Mutex` 保护，避免重复创建
- 后台日志线程使用 `BufReader` 缓冲读取
- 大文件下载使用流式处理，不占用大量内存

---

## 十二、未来规划

### 12.1 功能扩展

- [ ] 支持多模型同时运行
- [ ] 添加模型管理（删除、重命名）
- [ ] 支持本地模型导入
- [ ] 添加模型评分和评论系统
- [ ] 支持插件扩展

### 12.2 性能优化

- [ ] 模型列表缓存（避免每次启动都拉取远程）
- [ ] 下载队列管理（支持多模型并行下载）
- [ ] 启动参数模板（预设常用配置）

### 12.3 用户体验

- [ ] 深色/浅色主题切换
- [ ] 多语言支持
- [ ] 快捷键操作
- [ ] 启动动画优化

---

## 附录

### A. llama.cpp 参数详解

详见 `doc/llamacpp.txt`

### B. Tauri 官方文档

- 中文文档: https://www.tauri.app.cn/
- 英文文档: https://v2.tauri.app/

### C. 相关项目

- llama.cpp: https://github.com/ggml-org/llama.cpp
- Tauri: https://github.com/tauri-apps/tauri
- sysinfo: https://github.com/GuillaumeGomez/sysinfo
- reqwest: https://github.com/seanmonstar/reqwest

---

*文档版本: 1.1*
*最后更新: 2026-05-25*
*维护者: ADM 开发团队*