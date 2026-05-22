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

### 1.3 核心功能

1. **模型列表展示**：从远程 JSON 获取模型列表，展示名称、大小、内存需求、工具调用、推理、图片识别支持能力及运行状态
2. **模型下载**：支持进度显示、断点续传（`.part` 文件）、本地模型扫描、HuggingFace 国内镜像自动替换
3. **模型启动**：通过 CLI 方式调用 llama.cpp 启动模型，参数可视化配置
4. **硬件监控**：实时显示内存、显存、CPU 信息（使用 tauri-plugin-hwinfo 增强检测）
5. **模型交互**：内嵌 iframe 加载 llama.cpp-server 的 Web 页面，支持自动轮询检测服务就绪
6. **参数配置**：可视化配置 llama.cpp 启动参数，支持保存/加载/恢复默认

---

## 二、架构设计

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────┐
│                   Tauri 单窗口                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │              index.html (主框架)                  │ │
│  │  ┌────────────────────────────────────────────┐  │ │
│  │  │       iframe #content-frame                │  │ │
│  │  │  ┌──────────────┐ ┌─────────────────────┐  │  │ │
│  │  │  │ model_list   │ │ settings.html       │  │  │ │
│  │  │  │ .html (模型  │ │ (设置页面)          │  │  │ │
│  │  │  │ 列表页)      │ │                     │  │  │ │
│  │  │  └──────────────┘ └─────────────────────┘  │  │ │
│  │  │  ┌──────────────────────────────────────┐  │  │ │
│  │  │  │ model_chat.html (模型对话交互页)      │  │  │ │
│  │  │  └──────────────────────────────────────┘  │  │ │
│  │  └────────────────────────────────────────────┘  │ │
│  │         ↕ postMessage 父子通信                    │ │
│  │         ↕ IPC (invoke / event / emit)             │ │
│  └──────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │            Rust 后端 (Commands)                   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐   │ │
│  │  │系统信息  │ │文件操作  │ │进程管理        │   │ │
│  │  │内存/CPU  │ │下载/续传 │ │llama.cpp       │   │ │
│  │  │GPU检测   │ │模型扫描  │ │启动/停止       │   │ │
│  │  │hwinfo    │ │part扫描  │ │config持久化    │   │ │
│  │  └──────────┘ └──────────┘ └────────────────┘   │ │
│  │  ┌────────────────────────────────────────────┐  │ │
│  │  │  AppState                                 │  │ │
│  │  │  ├─ running_process: Mutex<Option<u32>>   │  │ │
│  │  │  ├─ running_model_id: Mutex<Option<String>>│  │ │
│  │  │  ├─ running_port: Mutex<Option<u16>>      │  │ │
│  │  │  └─ sys: Mutex<System>                    │  │ │
│  │  └────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │           llamacpp/ (可执行文件)                  │ │
│  │  ├── windows/  → llama-server.exe               │ │
│  │  ├── linux/    → llama-server                   │ │
│  │  └── mac/      → llama-server                   │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
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

### 2.3 IPC 通信设计

#### Invoke 调用

前端通过 `window.__TAURI_INTERNALS__.invoke()` 或 `window.__TAURI__.core.invoke()` 调用 Rust Command。

```javascript
// 方式一
const invoke = window.__TAURI_INTERNALS__?.invoke;
// 方式二（Tauri 2.x 新版）
const invoke = window.__TAURI__?.core?.invoke;
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
│   ├── progect_doc.txt               # 需求文档
│   ├── llamacpp.txt                  # llama.cpp 参数参考
│   └── dev_doc.md                    # 开发文档（本文件）
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
│       ├── main.rs                   # 入口
│       └── lib.rs                    # 核心逻辑（AppState、所有 Commands）
├── models/                           # 模型文件存放目录（运行时创建）
│   ├── {model_id}.gguf               # 已下载的模型文件
│   └── {model_id}.gguf.part          # 下载未完成的临时文件
├── config.json                       # 启动参数配置文件（运行时创建）
├── package.json
├── pnpm-lock.yaml
├── AGENTS.md
└── .gitignore
```

**关键约定**：
- `models/` 目录和 `config.json` 在软件首次运行时由后端自动创建，位置在可执行文件的同级目录
- `llamacpp/` 目录作为 `bundle.resources` 打包到安装包中，运行时可通过相对路径找到
- 每个 HTML 页面的 CSS 和 JS 内联写在同一文件中，不单独拆分

---

## 四、页面设计

### 4.1 主框架 (`index.html`)

#### 4.1.1 窗口配置（实际）

```json
{
  "title": "ADM",
  "width": 1280,
  "height": 768,
  "center": true,
  "minWidth": 800,
  "minHeight": 600
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
  └── 5. 安装 message 监听器，接收子页面导航请求
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
    // ...
  }
});
```

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
│ │          │        │        │[下载] [启动]                       │
│ ├──────────┼────────┼────────┼──────────┼────────┼────────┼──────┤
│ │ ...      │ ...    │ ...    │ ...      │ ...    │ ...    │ ...  │
│ └──────────┴────────┴────────┴──────────┴────────┴────────┴──────┘
└───────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 模型列表数据源

- **远程地址**：`https://adm.tuduoduo.top/model.json`
- **获取方式**：Rust 后端通过 `fetch_model_list` Command 获取（原始文档为前端 fetch，实际改为后端代理请求）
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

┌──────────┐  点击启动  ┌──────────────┐  运行中  ┌────────────────┐
│   启动   │─────────▶│  启动中...    │───────▶│ 查看模型 │ 关闭模型│
│ (可点击) │          │  (禁用)       │         └────────────────┘
└──────────┘          └──────────────┘         ┌────────────────┐
                                                │ 进程退出 → 重置 │
                                                └────────────────┘
```

**启动逻辑**：
1. 模型已下载 + RAM-C 满足 → 启动按钮可点击
2. 点击启动 → 调用 `load_settings` 读取启动参数 → 调用 `start_model`
3. 后端立即返回成功并发送 `model-started` 事件 → 按钮变为"查看模型"+"关闭模型"
4. 异步线程监控 stdout，检测到 `llama server listening` 等标志时再次触发 `model-started`
5. 进程退出时自动触发 `model-stopped` 事件

#### 4.2.6 页面初始化流程

```
页面加载
  │
  ├── 1. 调用 get_system_info → 获取系统信息，并通过 hwinfo 增强
  │
  ├── 2. 调用 scan_local_models → 扫描已下载模型
  │
  ├── 3. 调用 scan_part_files → 扫描未完成的 .part 文件
  │
  ├── 4. 调用 get_model_status → 获取当前运行模型状态
  │
  ├── 5. 调用 fetch_model_list → 从远程获取模型列表
  │
  ├── 6. 合并数据渲染模型列表表格
  │
  └── 7. 安装 postMessage 监听器，接收主窗口转发的事件
```

---

### 4.3 模型对话页 (`model_chat.html`)

#### 4.3.1 功能说明

当 llama.cpp-server 成功启动后，通过此页面加载 `http://127.0.0.1:{port}` 的 Web 界面。

#### 4.3.2 页面布局

```
┌──────────────────────────────────────────────────────┐
│ ← 返回    Qwen3.5-9B-Q4_K_M - 交互界面    已连接    │
├──────────────────────────────────────────────────────┤
│                                                      │
│         http://127.0.0.1:8080                        │
│         (iframe 全屏加载)                            │
│                                                      │
│         加载遮罩层：                                  │
│         "模型启动中，请耐心等待..."                    │
│         "正在连接模型服务..."                          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### 4.3.3 URL 参数传递

通过查询字符串传递模型 ID 和端口号：

```
model_chat.html?model_id=Qwen3.5-9B-Q4_K_M&port=8080
```

#### 4.3.4 服务就绪检测

采用 XHR 轮询机制检测 llama-server 是否已就绪：

```javascript
function checkService() {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", serverUrl, true);
  xhr.timeout = 3000;
  xhr.onload = function () {
    // 服务就绪，加载 iframe
    iframe.src = serverUrl;
    overlay.style.display = "none";
  };
  xhr.onerror = function () {
    retryCount++;
    if (retryCount < maxRetries) {  // maxRetries = 120（最多等2分钟）
      setTimeout(checkService, 1000);
    } else {
      loadingText.textContent = "连接超时，请检查模型是否正常启动";
    }
  };
  xhr.send();
}
```

---

### 4.4 设置页面 (`settings.html`)

#### 4.4.1 页面布局

```
┌───────────────────────────────────────────────────────┐
│ 设置                                                   │
├─────────────┬─────────────────────────────────────────┤
│             │                                         │
│ 模型启动参数 │  [参数表单 - 分组展示]                  │
│             │  基础参数 | GPU 参数                     │
│ 系统版本号   │  性能参数 | 采样参数                     │
│             │  服务参数                                │
│ 关于         │  [保存设置] [恢复默认]                   │
│             │                                         │
├─────────────┴─────────────────────────────────────────┤
│ (无底部硬件栏，settings.html 只位于 iframe 内)         │
└───────────────────────────────────────────────────────┘
```

#### 4.4.2 模型启动参数

可视化配置 llama-server 的常用启动参数，分为以下分组：

| 分组 | 参数 | CLI 参数 | 默认值 | 说明 |
|------|------|----------|--------|------|
| **基础参数** | 上下文大小 | `-c, --ctx-size` | 4096 | prompt 上下文长度 |
| | 预测 token 数 | `-n, --n-predict` | -1 (无限) | 生成最大 token 数 |
| | 批处理大小 | `-b, --batch-size` | 2048 | 逻辑最大批次 |
| | 微批次大小 | `-ub, --ubatch-size` | 512 | 物理最大批次 |
| **GPU 参数** | GPU 层数 | `-ngl, --n-gpu-layers` | auto | 存入 VRAM 的层数（支持 auto/all/数字/自定义） |
| **性能参数** | 线程数 | `-t, --threads` | 自动 | CPU 生成线程数 |
| | 批处理线程 | `-tb, --threads-batch` | 同线程数 | 批处理线程数 |
| | Flash Attention | `-fa, --flash-attn` | auto | on/off/auto |
| | KV 缓存类型 K | `-ctk, --cache-type-k` | f16 | K 的 KV 缓存数据类型（f16/f32/q8_0/q4_0/q4_1/q5_0/q5_1） |
| | KV 缓存类型 V | `-ctv, --cache-type-v` | f16 | V 的 KV 缓存数据类型 |
| | 内存锁定 | `--mlock` | false | 强制模型驻留 RAM |
| | 内存映射 | `--mmap` | true | 启用内存映射（取消勾选传递 --no-mmap） |
| **采样参数** | 温度 | `--temp` | 0.80 | 采样温度 |
| | Top-K | `--top-k` | 40 | Top-K 采样 |
| | Top-P | `--top-p` | 0.95 | Top-P 采样 |
| | Min-P | `--min-p` | 0.05 | Min-P 采样 |
| | 重复惩罚 | `--repeat-penalty` | 1.00 | 重复序列惩罚 |
| **服务参数** | 监听端口 | `--port` | 8080 | 服务监听端口 |
| | 监听地址 | `--host` | 127.0.0.1 | 服务监听地址（支持 127.0.0.1 / 0.0.0.0） |

**与原始文档的差异**：
- 移除了"分割模式"(`-sm, --split-mode`) 参数
- 移除了"张量分割"(`-ts, --tensor-split`) 参数

#### 4.4.3 参数配置持久化

- 保存路径：`{exe_dir}/config.json`
- 格式：`{ "launch_params": { ... } }`
- 调用 `save_settings` / `load_settings` Command 进行读写
- 不存在时使用 `Default` 实现返回默认参数

#### 4.4.4 系统版本号

| 信息项 | 说明 |
|--------|------|
| ADM 版本 | 从 tauri.conf.json 读取（0.1.0） |
| Tauri 版本 | 2.11.2 |
| llama.cpp 版本 | 调用 `llama-server --version` 获取 |
| 操作系统 | 从 navigator.platform 检测（Windows/Linux/macOS） |

#### 4.4.5 关于

- 项目介绍（ADM — Automatic Deployment Model）
- 开源许可
- 项目链接

---

## 五、Rust 后端 Command 设计

### 5.1 实际 Rust 依赖

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-hwinfo = "0.2.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sysinfo = "0.33"                          # 系统信息采集（CPU、内存）
reqwest = { version = "0.12", features = ["stream"] }  # HTTP 下载（支持流式）
tokio = { version = "1", features = ["full"] }          # 异步运行时
dirs = "6"                                # 获取标准目录路径
futures-util = "0.3"                      # 异步流处理（用于下载）
```

### 5.2 AppState 全局状态

```rust
struct AppState {
    running_process: Mutex<Option<u32>>,    // 运行中的进程 PID
    running_model_id: Mutex<Option<String>>, // 当前运行模型的 ID
    running_port: Mutex<Option<u16>>,        // 当前运行模型的端口
    sys: Mutex<System>,                      // sysinfo 实例（复用）
}
```

### 5.3 Command 列表

#### 5.3.1 `get_system_info` — 获取系统硬件信息

```rust
#[tauri::command]
async fn get_system_info(state: tauri::State<'_, AppState>) -> Result<SystemInfo, String>

struct SystemInfo {
    total_ram: u64,            // 总内存 (bytes)
    used_ram: u64,             // 已用内存 (bytes)
    total_vram: u64,           // 总显存 (bytes)，无显卡为 0
    used_vram: u64,            // 已用显存 (bytes)
    has_gpu: bool,             // 是否有显卡
    cpu_usage: f32,            // CPU 使用率 (%)
    cpu_physical_cores: usize, // 物理核心数
    cpu_logical_cores: usize,  // 逻辑线程数
}
```

**实现要点**：
- 复用 `AppState.sys` 中的 `System` 实例，每次 refresh_all()
- 显存通过 `get_gpu_info()` 函数跨平台获取

#### 5.3.2 `get_gpu_info` — 跨平台 GPU 显存检测

```rust
fn get_gpu_info() -> (u64, u64, bool)  // (total_vram, used_vram, has_gpu)
```

| 平台 | 检测方式 |
|------|----------|
| Windows | `wmic path win32_VideoController get AdapterRAM` |
| Linux | `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits` |
| macOS | `system_profiler SPDisplaysDataType`（仅检测是否存在 GPU） |

**前端增强**：前端还会通过 `plugin:hwinfo|get_gpu_info` 获取更精确的显存和 GPU 型号信息，覆盖 sysinfo 的数据。

#### 5.3.3 `scan_local_models` — 扫描本地已下载模型

```rust
#[tauri::command]
async fn scan_local_models() -> Result<Vec<String>, String>
```

**实现要点**：
- 扫描可执行文件目录下的 `models/` 文件夹
- 如果 `models/` 不存在则自动创建
- 返回所有 `.gguf` 文件的文件名（去掉扩展名）

#### 5.3.4 `scan_part_files` — 扫描未完成的下载文件

```rust
#[tauri::command]
async fn scan_part_files() -> Result<Vec<PartFileProgress>, String>

struct PartFileProgress {
    model_id: String,        // 模型 ID
    existing_size: u64,      // 已下载的字节数
}
```

**实现要点**：
- 扫描 `models/` 目录下的所有 `.gguf.part` 文件
- 解析文件名提取 `model_id`（去除 `.gguf.part` 后缀）
- 记录已下载字节数，用于前端显示"继续下载"按钮

#### 5.3.5 `fetch_model_list` — 获取远程模型列表

```rust
#[tauri::command]
async fn fetch_model_list() -> Result<Vec<RemoteModel>, String>

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

**实现要点**：
- 使用 `reqwest` 向 `https://update.wukongyun.fun/model.json` 发送 GET 请求
- 设置 30 秒超时
- 反序列化 JSON 并返回

#### 5.3.6 `download_model` — 下载模型（支持断点续传）

```rust
#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    model_id: String,
    model_url: String,
) -> Result<(), String>
```

**核心功能**：
1. **国内镜像自动替换**：`https://huggingface.co/` → `https://hf-mirror.com/`
2. **断点续传检测**：检查是否存在 `.gguf.part` 文件，获取已下载字节数
3. **手动处理重定向**：hf-mirror.com 会 302 重定向到 S3 签名 URL，先请求获取最终 URL
4. **Range 请求**：续传时添加 `Range: bytes={existing_size}-` 请求头
5. **流式写入**：使用 `futures_util::StreamExt` 逐块下载，实时推送进度事件
6. **文件重命名**：下载完成后将 `.gguf.part` 重命名为 `.gguf`

**下载流程**：

```
判断最终文件(.gguf)是否已存在 → 是 → 发送 download-complete 事件
↓ 否
检测 .gguf.part 文件 → 获取已下载大小
↓
获取最终下载 URL（处理 302 重定向）
  ├── 新建客户端，设置 redirect::Policy::none()
  ├── 发送 GET 请求
  └── 从 Location 头获取 S3 签名 URL
↓
用最终 URL 发起下载
  ├── 有 existing_size → 添加 Range 请求头（断点续传）
  └── 无 existing_size → 全新下载
↓
流式下载 → 实时推送 download-progress 事件
↓
重命名 .part → .gguf → 推送 download-complete 事件
```

**事件**：
- `download-progress`：`{ model_id, progress: u8 (0-99), downloaded: u64, total: u64 }`
- `download-complete`：`{ model_id }`

#### 5.3.7 `start_model` — 启动模型

```rust
#[tauri::command]
async fn start_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    params: LaunchParams,
) -> Result<(), String>
```

**实现要点**：
- 检查是否有模型正在运行（`running_process` 是否为 None）
- 根据操作系统选择对应的 llama-server 可执行文件
- 拼接 CLI 参数（模型路径 + 所有配置参数）
- 使用 `std::process::Command` 启动子进程（stdout/stderr 管道化）
- **立即发送** `model-started` 事件，使前端按钮即时响应
- 异步线程监控 stdout，检测启动成功标志（`llama server listening` / `HTTP server listening` / `listening on`）
- 进程退出时自动发送 `model-stopped` 事件

**参数拼接规则**：

| 参数 | 拼接方式 |
|------|----------|
| ctx_size | `-c {value}` |
| n_predict | `-n {value}` |
| batch_size | `-b {value}` |
| ubatch_size | `-ub {value}` |
| n_gpu_layers | `-ngl {value}` |
| threads | `-t {value}` |
| threads_batch | `-tb {value}` |
| flash_attn | `-fa {value}` |
| cache_type_k | `-ctk {value}` |
| cache_type_v | `-ctv {value}` |
| mlock | `--mlock`（仅 true 时添加） |
| mmap | `--no-mmap`（仅 false 时添加，默认 true 不传参） |
| temperature | `--temp {value}` |
| top_k | `--top-k {value}` |
| top_p | `--top-p {value}` |
| min_p | `--min-p {value}` |
| repeat_penalty | `--repeat-penalty {value}` |
| port | `--port {value}`（默认 8080） |
| host | `--host {value}`（默认 127.0.0.1） |

#### 5.3.8 `stop_model` — 停止模型

```rust
#[tauri::command]
async fn stop_model(state: tauri::State<'_, AppState>) -> Result<(), String>
```

| 平台 | 终止方式 |
|------|----------|
| Windows | `taskkill /PID {pid} /F` |
| Linux / macOS | `kill -9 {pid}` |

停止后清除 `running_process`、`running_model_id`、`running_port` 状态。

#### 5.3.9 `get_model_status` — 获取模型运行状态

```rust
#[tauri::command]
async fn get_model_status(state: tauri::State<'_, AppState>) -> Result<ModelStatus, String>

struct ModelStatus {
    running: bool,
    model_id: Option<String>,
    pid: Option<u32>,
    port: Option<u16>,
}
```

**实现要点**：
- 检查 PID 对应的进程是否仍然存活（使用 sysinfo）
- 如果进程已不存在，自动清除状态

#### 5.3.10 `save_settings` / `load_settings` — 配置持久化

```rust
#[tauri::command]
async fn save_settings(settings: Settings) -> Result<(), String>

#[tauri::command]
async fn load_settings() -> Result<Settings, String>

struct Settings {
    launch_params: LaunchParams,
}
```

- **配置文件路径**：`{exe_dir}/config.json`
- **默认值**：`Settings::default()` 实现（与前端默认值一致）

#### 5.3.11 `get_llamacpp_version` — 获取 llama.cpp 版本

```rust
#[tauri::command]
async fn get_llamacpp_version() -> Result<String, String>
```

- 执行 `llama-server --version`
- 读取 stdout（或 stderr，如果 stdout 为空）
- 返回版本字符串

### 5.4 后端事件列表

| 事件名 | 方向 | Payload | 触发时机 |
|--------|------|---------|----------|
| `download-progress` | Rust → JS | `{ model_id, progress, downloaded, total }` | 下载进行中（0-99%） |
| `download-complete` | Rust → JS | `{ model_id }` | 下载完成或检测到已存在的文件 |
| `download-error` | Rust → JS | `{ model_id, error }` | 下载失败 |
| `model-started` | Rust → JS | `{ model_id, port }` | 模型进程启动时立即发送 + 异步日志检测到启动标志时再次发送 |
| `model-stopped` | Rust → JS | `{ model_id }` | 进程退出时 |
| `model-error` | Rust → JS | `{ model_id, error }` | 模型启动/运行错误 |
| `model-log` | Rust → JS | `{ model_id, line }` | llama-server 每行 stdout 输出 |

### 5.5 窗口关闭处理

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        // 关闭时自动终止 llama-server 进程
        let pid = state.running_process.lock().ok().and_then(|l| *l);
        if let Some(pid) = pid {
            // Windows: taskkill /PID {pid} /F
            // Linux/Mac: kill -9 {pid}
        }
    }
})
```

---

## 六、前端实现设计

### 6.1 路由方案

采用 iframe 嵌套架构，无传统路由库：

```
父页面 index.html
  ├── iframe 加载 model_list.html  (默认首页)
  ├── iframe 加载 settings.html    (点击设置按钮)
  └── iframe 加载 model_chat.html  (点击查看模型)
```

导航方式：

```javascript
// 父页面直接切换 src
document.getElementById("content-frame").src = "model_list.html";
document.getElementById("content-frame").src = "settings.html";
document.getElementById("content-frame").src = "model_chat.html?model_id=...&port=...";

// 子页面通过 postMessage 请求父页面切换
window.parent.postMessage({ type: "navigate", page: "model_list.html" }, "*");
```

**页面映射**：

| 页面文件 | iframe src | 说明 |
|----------|------------|------|
| model_list.html | `model_list.html` | 首页 - 模型列表 |
| model_chat.html | `model_chat.html?model_id=xxx&port=8080` | 模型对话交互界面 |
| settings.html | `settings.html` | 设置页面 |

### 6.2 主框架实现 (`index.html`)

#### 6.2.1 HTML 结构

```html
<div id="app">
  <iframe id="content-frame" src="model_list.html"></iframe>
  <div id="hardware-bar">
    <div id="home-btn" onclick="goHome()">☰ 首页</div>
    <div id="settings-btn" onclick="goSettings()">⚙ 设置</div>
    <div class="hw-item"><span>内存</span><span id="ram-info">--</span></div>
    <div class="hw-item"><span id="gpu-label">显存</span><span id="vram-info">--</span></div>
    <div class="hw-item"><span>CPU</span><span id="cpu-info">--</span></div>
  </div>
</div>
```

#### 6.2.2 初始化流程

1. 获取 `invoke` / `listen` 句柄（兼容 `__TAURI_INTERNALS__` 和 `__TAURI__` 两种方式）
2. 调用 `get_system_info` 获取系统信息
3. 通过 `plugin:hwinfo|get_*_info` 获取增强硬件信息并覆盖
4. 设置所有 Tauri 事件监听器，转发给 iframe
5. 设置 message 监听器接收子页面导航请求

### 6.3 模型列表页实现 (`model_list.html`)

核心数据结构：

```javascript
let modelList = [];      // 远程模型列表
let localModels = [];    // 本地已下载模型 ID 列表
let partFiles = {};      // 未完成下载的文件信息：{ model_id: existing_size }
let systemInfo = null;   // 系统硬件信息
let runningModelId = null;  // 当前运行的模型 ID
let runningModelPort = null; // 当前运行的模型端口
```

#### 6.3.1 状态判断

```javascript
// RAM-C 判断
function isModelAvailable(needRam) {
  const ramc = (systemInfo.total_ram + systemInfo.total_vram) / (1024**3);
  return ramc >= parseInt(needRam);
}

// 本地文件判断
function isModelDownloaded(modelId) {
  return localModels.includes(modelId);
}
```

#### 6.3.2 事件监听

通过 `window.addEventListener("message", ...)` 接收主窗口转发的事件，处理 `download-progress`、`download-complete`、`model-started`、`model-stopped`、`download-error`、`model-error`。

### 6.4 模型对话页实现 (`model_chat.html`)

- 从 URL 查询参数获取 `model_id` 和 `port`
- 加载遮罩层显示"模型启动中，请耐心等待..."
- XHR 轮询检测服务器就绪（最多 2 分钟，每 1 秒一次）
- 就绪后加载 iframe 显示 `http://127.0.0.1:{port}`
- 顶部显示返回按钮和连接状态

### 6.5 设置页面实现 (`settings.html`)

- 左侧导航：模型启动参数 / 系统版本号 / 关于
- 启动参数表单分为 5 组（基础参数、GPU 参数、性能参数、采样参数、服务参数）
- GPU 层数支持"自定义"选项（选择 custom 时显示自定义输入框）
- 保存按钮调用 `save_settings` / 恢复默认按钮重置表单
- 加载时调用 `load_settings` 回填表单

---

## 七、Tauri 配置

### 7.1 tauri.conf.json 完整配置

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ADM",
  "version": "0.1.0",
  "identifier": "com.adm.app",
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
    "resources": [
      "llamacpp/windows/**/*",
      "llamacpp/linux/**/*",
      "llamacpp/mac/**/*"
    ],
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

**关键配置说明**：
- `withGlobalTauri: true`：允许前端通过 `window.__TAURI_INTERNALS__` 访问 API
- `csp: null`：允许 iframe 加载外部页面（模型对话页需要加载 127.0.0.1:port）
- `bundle.resources`：将 llamacpp 可执行文件打包到安装包中
- 窗口尺寸：1280x768（相对于原始文档的 1024x768 增大）

### 7.2 capabilities/default.json 权限配置

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
    "core:window:allow-center"
  ]
}
```

---

## 八、数据流设计

### 8.1 模型列表数据流

```
远程 JSON API ──reqwest──▶ Rust fetch_model_list ──invoke──▶ 前端 JS
                                                              │
本地 models/ ──scan──▶ Rust scan_local_models ──invoke─────▶ 前端 JS
                                                              │
.part 文件 ──scan──▶ Rust scan_part_files ──invoke─────────▶ 前端 JS
                                                              │
系统硬件 ──sysinfo+hwinfo──▶ Rust get_system_info ──invoke──▶ 前端 JS
                                                              │
当前状态 ──Rust──▶ get_model_status ──invoke───────────────▶ 前端 JS
                                                              │
                                                              ▼
                                                       合并计算渲染
```

### 8.2 模型下载数据流

```
前端点击下载
  │
  ▼
invoke('download_model', { model_id, model_url })
  │
  ▼
Rust: 镜像替换 (huggingface.co → hf-mirror.com)
  │
  ▼
Rust: 检查 .part 文件 → 获取已下载大小
  │
  ▼
Rust: 手动处理 302 重定向 → 获取 S3 签名 URL
  │
  ▼
Rust: 流式下载（支持 Range 续传）
  │
  ├── emit('download-progress', { model_id, progress: 0-99 })
  │     │
  │     ▼
  │   主窗口接收 → postMessage → iframe 更新按钮文字 "X%"
  │
  ├── 完成 → 重命名 .part → .gguf
  │
  └── emit('download-complete', { model_id })
        │
        ▼
      主窗口接收 → postMessage → iframe 刷新列表
```

### 8.3 模型启动数据流

```
前端点击启动
  │
  ▼
invoke('load_settings') → 获取启动参数
  │
  ▼
invoke('start_model', { model_id, params })
  │
  ▼
Rust: 检查是否已有运行中的进程
  │
  ▼
Rust: 拼接 CLI 参数 + 启动 llama-server
  │
  ├── 立即 emit('model-started', { ... })  ← 立即响应
  │     │
  │     ▼
  │   前端按钮 → "查看模型" + "关闭模型"
  │
  ├── 异步线程监控 stdout
  │     ├── 每行 → emit('model-log')
  │     ├── 检测到 listening → 再次 emit('model-started')
  │     └── 进程退出 → emit('model-stopped')
  │
  └── 点击"查看模型" → 跳转 model_chat.html?model_id=...&port=...
```

### 8.4 构建资源打包

llamacpp/ 目录通过 `bundle.resources` 配置打包到安装包中。运行时路径解析：

```rust
fn get_llama_server_path() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()?.parent()?;
    #[cfg(target_os = "windows")]
    let path = exe_dir.join("llamacpp").join("windows").join("llama-server.exe");
    // ...
}
```

---

## 九、跨平台处理

### 9.1 llama-server 路径解析

| 平台 | 路径 |
|------|------|
| Windows | `{exe_dir}/llamacpp/windows/llama-server.exe` |
| Linux | `{exe_dir}/llamacpp/linux/llama-server` |
| macOS | `{exe_dir}/llamacpp/mac/llama-server` |

### 9.2 GPU/显存检测

| 平台 | 后端检测 | 前端增强（hwinfo 插件） |
|------|----------|------------------------|
| Windows | WMI: `wmic path win32_VideoController get AdapterRAM` | `plugin:hwinfo\|get_gpu_info` |
| Linux | `nvidia-smi --query-gpu=memory.total,...` | `plugin:hwinfo\|get_gpu_info` |
| macOS | `system_profiler SPDisplaysDataType` | `plugin:hwinfo\|get_gpu_info` |

### 9.3 进程终止

| 平台 | 终止方式 |
|------|----------|
| Windows | `taskkill /PID {pid} /F` |
| Linux / macOS | `kill -9 {pid}` |

---

## 十、安全考虑

### 10.1 权限最小化

- 仅请求必要的 Tauri 权限（core:default, event相关, opener, window相关）
- 不使用 `shell:allow-execute` 等宽泛权限，通过自定义 Command 封装进程操作
- CSP 在开发阶段设为 null，生产环境应配置合理的 CSP

### 10.2 模型下载安全

- 仅从配置的远程地址下载模型
- 下载目录固定为 `models/`，防止路径遍历
- HuggingFace 国内镜像自动替换（不在前端暴露镜像地址）
- 302 重定向处理时不跟随，手动获取最终 URL 后再下载（防止安全风险）

### 10.3 进程管理安全

- llama-server 默认仅绑定 `127.0.0.1`，不暴露到外网
- 进程 PID 存储在内存的 AppState 中
- 应用退出时通过 `CloseRequested` 事件自动清理子进程
- 不允许用户自定义可执行文件路径

---

## 十一、性能优化

### 11.1 前端优化

- 硬件信息仅在启动时获取一次（不需要每秒轮询）
- 模型列表使用文档片段（`innerHTML` 批量设置）
- Tauri 事件通过 postMessage 透传，避免 iframe 直接频繁 IPC

### 11.2 后端优化

- `sysinfo` 的 `System` 对象复用到 AppState，避免每次都重新创建
- 下载使用流式处理 + 8KB 缓冲区，不将整个文件加载到内存
- llama-server 进程使用 `std::thread::spawn` 异步监控 stdout，不阻塞主线程
- 模型列表获取设置 30 秒超时

### 11.3 启动优化

- 首页加载时按顺序请求：系统信息 → 本地扫描 → 远程列表
- 启动模型后立即发送事件，无需等待服务完全就绪（前端按钮即时响应）
- 模型对话页使用 XHR 轮询检测服务就绪，避免 iframe 加载失败的白屏

---

## 十二、开发步骤

### Phase 1：基础框架搭建

1. 配置 tauri.conf.json（窗口、权限）
2. 搭建主框架 index.html（iframe + 硬件信息栏 + 事件转发系统）
3. 实现 Rust 后端基础 Command（get_system_info、scan_local_models）
4. 实现模型列表页 model_list.html（表格渲染）

### Phase 2：核心功能开发

5. 实现模型下载功能（download_model + 断点续传 + 进度事件）
6. 实现模型启动功能（start_model + 状态事件 + 实时日志）
7. 实现模型对话页 model_chat.html（iframe 嵌入 + 服务轮询检测）

### Phase 3：设置与配置

8. 实现设置页面 layout 和左侧导航
9. 实现模型启动参数配置表单（5 组参数）
10. 实现配置持久化（save_settings / load_settings）
11. 实现系统版本号和关于页面

### Phase 4：完善与优化

12. 集成 tauri-plugin-hwinfo 增强硬件检测
13. 错误处理与用户提示（Toast 通知）
14. 跨平台测试与适配
15. 性能优化
16. 打包与分发

---

## 十三、关键代码片段参考

### 13.1 Rust：断点续传下载

```rust
// 核心逻辑：手动处理 302 重定向 + Range 续传 + 流式写入
#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    model_id: String,
    model_url: String,
) -> Result<(), String> {
    // 1. 镜像替换
    let model_url = model_url.replace("https://huggingface.co/", "https://hf-mirror.com/");

    // 2. 检查现有文件
    let models_dir = get_exe_dir()?.join("models");
    let final_path = models_dir.join(format!("{}.gguf", model_id));
    let part_path = models_dir.join(format!("{}.gguf.part", model_id));

    if final_path.exists() {
        // 已存在 → 发送完成事件
        app.emit("download-complete", json!({ "model_id": &model_id })).ok();
        return Ok(());
    }

    let existing_size = if part_path.exists() {
        std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0)
    } else { 0 };

    // 3. 获取最终 URL（处理 302 重定向）
    let resolve_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?;
    let resolve_resp = resolve_client.get(&model_url).send().await.map_err(|e| e.to_string())?;
    let final_url = if resolve_resp.status().is_redirection() {
        resolve_resp.headers().get("location")
            .and_then(|v| v.to_str().ok()).map(|s| s.to_string())
            .unwrap_or(model_url.clone())
    } else { model_url.clone() };

    // 4. Range 续传下载
    let download_client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let mut req = download_client.get(&final_url);
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={}-", existing_size));
    }
    let response = req.send().await.map_err(|e| e.to_string())?;

    // 5. 流式写入
    let mut file = if existing_size > 0 {
        tokio::fs::OpenOptions::new().append(true).open(&part_path).await...
    } else {
        tokio::fs::File::create(&part_path).await...
    };

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        file.write_all(&chunk).await...;
        downloaded += chunk.len() as u64;
        // 推送进度（上限 99%）
        app.emit("download-progress", json!({ ... })).ok();
    }

    // 6. 重命名
    tokio::fs::rename(&part_path, &final_path).await...;
    app.emit("download-complete", json!({ "model_id": &model_id })).ok();
    Ok(())
}
```

### 13.2 Rust：启动 llama-server（异步日志监控）

```rust
#[tauri::command]
async fn start_model(...) -> Result<(), String> {
    // ... 参数拼接 ...

    let mut child = std::process::Command::new(&server_path)
        .args(&args)
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("启动失败: {}", e))?;

    // 保存状态
    *state.running_process.lock()? = Some(child.id());
    *state.running_model_id.lock()? = Some(model_id.clone());
    *state.running_port.lock()? = Some(port);

    // 立即发送事件
    app.emit("model-started", json!({ "model_id": &model_id, "port": port })).ok();

    // 异步监控进程输出
    std::thread::spawn(move || {
        let reader = BufReader::new(child.stdout.take().unwrap());
        for line in reader.lines() {
            if let Ok(line) = line {
                app_clone.emit("model-log", json!({ "model_id": &model_id_clone, "line": line })).ok();
                if line.contains("llama server listening") {
                    app_clone.emit("model-started", json!({...})).ok();
                }
            }
        }
        // 进程退出
        app_clone.emit("model-stopped", json!({ "model_id": &model_id_clone })).ok();
    });

    Ok(())
}
```

### 13.3 前端：事件转发与接收

```javascript
// 主窗口 (index.html)
listen("download-progress", (event) => {
  const frame = document.getElementById("content-frame");
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "download-progress", payload: event.payload }, "*");
  }
});

// 子页面 (model_list.html)
window.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || !data.type) return;
  switch (data.type) {
    case "download-progress":
      const btn = document.querySelector(`[data-model-id="${data.payload.model_id}"]`);
      if (btn) btn.textContent = data.payload.progress + "%";
      break;
    case "download-complete":
      // 刷新列表
      break;
    case "model-started":
      runningModelId = data.payload.model_id;
      runningModelPort = data.payload.port;
      renderModelTable();
      break;
  }
});
```

### 13.4 前端：hwinfo 插件增强

```javascript
// 在 model_list.html 或 index.html 中
try {
  const gpuInfo = await invoke("plugin:hwinfo|get_gpu_info");
  if (gpuInfo && gpuInfo.vramMb) {
    systemInfo.total_vram = gpuInfo.vramMb * 1024 * 1024;
    systemInfo.has_gpu = true;
  }
} catch (_) {}

try {
  const ramInfo = await invoke("plugin:hwinfo|get_ram_info");
  if (ramInfo && ramInfo.sizeMb) {
    systemInfo.total_ram = ramInfo.sizeMb * 1024 * 1024;
  }
} catch (_) {}
```

---

## 十四、错误处理规范

### 14.1 Rust 端错误处理

- 所有 Command 返回 `Result<T, String>`，错误信息使用中文描述
- 启动前检查：已有模型运行中 → 返回"已有模型在运行中..."
- 文件操作错误：包含文件路径信息
- 网络错误：区分超时、状态码异常、HTTP 错误码
- 断点续传不支持的错误：提示用户重新下载

### 14.2 前端错误处理

- IPC 调用使用 try-catch 包裹
- 网络请求失败时显示 Toast 提示（红色错误消息）
- 模型下载失败时显示错误 + 恢复按钮状态
- 模型启动失败时显示错误信息
- Toast 4 秒自动消失

---

## 十五、与原始文档的关键差异

| 项目 | 原始文档 | 实际实现 |
|------|----------|----------|
| **窗口尺寸** | 1024x768 | 1280x768 |
| **路由方案** | 哈希路由 + 页面跳转 | iframe 嵌入 + postMessage 通信 |
| **页面文件** | index.html(首页)、model.html(展示) | index.html(主框架)、model_list.html(列表)、model_chat.html(对话) |
| **模型列表获取** | 前端 fetch | 后端 `fetch_model_list` Command |
| **模型字段** | model_id、model_url、model_size、need_ram | 额外增加：support_tools、support_reasoning、support_images |
| **模型表格** | 4 列（名称、大小、内存、状态、操作） | 8 列（增加工具调用、推理、图片识别） |
| **下载功能** | 简单流式下载 | 断点续传 + HuggingFace 镜像 + 302 重定向处理 |
| **硬件增强** | 仅 sysinfo | sysinfo + tauri-plugin-hwinfo |
| **硬件刷新** | 1 秒轮询 | 启动时一次（不再轮询） |
| **启动事件** | 等待 listening 后发送 | 立即发送 + 异步日志检测再次发送 |
| **设置参数** | 包含分割模式、张量分割 | 移除这两个参数 |
| **资源打包** | `llamacpp/**/*` | `llamacpp/windows/**/*`, `llamacpp/linux/**/*`, `llamacpp/mac/**/*` |
| **窗口关闭** | 未提及 | `CloseRequested` 事件自动清理子进程 |

---

## 十六、测试要点

| 测试项 | 测试内容 | 预期结果 |
|--------|----------|----------|
| 模型列表加载 | 启动应用，检查模型列表 | 正确显示远程模型列表（含功能标签） |
| RAM-C 判断 | 内存/显存不足时 | 下载和启动按钮禁用，状态显示"不可用" |
| 模型下载 | 点击下载按钮 | 显示进度 0-99%，完成后按钮变为"已下载" |
| 断点续传 | 下载中断后重新下载 | 显示"继续下载"，从已下载位置续传 |
| 本地模型检测 | 重启应用，已有模型 | 已下载模型按钮显示"已下载" |
| 模型启动 | 点击启动按钮 | 按钮变为"启动中..." → "查看模型"+"关闭模型" |
| 模型对话 | 点击"查看模型" | 轮询检测服务就绪，加载 iframe 显示交互界面 |
| 模型停止 | 点击"关闭模型" | 进程终止，按钮恢复为"启动" |
| 应用退出 | 有关闭模型时退出 | 自动终止 llama-server 进程 |
| 设置保存 | 修改参数后重启 | 参数被正确保存和恢复 |
| hwinfo 集成 | 查看硬件信息栏 | 显示更精确的硬件型号和容量 |
| 跨平台 | 在 Windows/Linux/Mac 运行 | 正确选择对应平台的 llama-server |