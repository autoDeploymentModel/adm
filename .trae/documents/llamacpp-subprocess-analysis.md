# llama.cpp 子进程控制分析

## 摘要

分析当前 ADM 项目中 llama.cpp（`llama-server.exe`）作为子进程的控制方式，评估其可行性、当前实现的质量，以及潜在的改进方向。

***

## 一、当前状态分析

### 1.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri App (Rust Backend)                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  model_list::start_model()          spawn + pipe stdout │ │
│  │  model_list::stop_model()           taskkill /F         │ │
│  │  model_list::get_model_status()     sysinfo PID check   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                    │ spawns                                   │
│                    ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  llama-server.exe (Child Process)                       │ │
│  │  - HTTP server on 127.0.0.1:{port} (default 8080)       │ │
│  │  - stdout/stderr piped → Tauri events → Frontend        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                    ▲ HTTP (chat/completions)                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Frontend (iframe: model_chat.html)                     │ │
│  │  - XHR GET http://127.0.0.1:{port} 检测服务就绪          │ │
│  │  - iframe.src = http://127.0.0.1:{port} 内嵌 WebUI     │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 关键实现文件

| 文件                                                                                     | 职责                           |
| -------------------------------------------------------------------------------------- | ---------------------------- |
| [start\_model](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L704-L953)        | 启动 llama-server 子进程          |
| [stop\_model](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L955-L993)         | 终止 llama-server 子进程          |
| [get\_model\_status](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L996-L1031) | 检查进程状态                       |
| [AppState](file:///f:/trae/adm/src-tauri/src/app_state.rs)                             | 进程状态管理（PID, port, model\_id） |
| [platform.rs](file:///f:/trae/adm/src-tauri/src/common/utils/platform.rs)              | 创建隐藏窗口命令的辅助函数                |
| [config.rs](file:///f:/trae/adm/src-tauri/src/common/config.rs)                        | 查找 llama-server 可执行文件路径      |
| [model\_chat.html](file:///f:/trae/adm/src/model_chat.html#L333-L392)                  | 前端通过 HTTP 连接 llama-server    |

### 1.3 当前子进程控制的具体方式

**启动流程** (`start_model`, model\_list.rs:853-865):

```rust
let mut cmd = create_hidden_command(&server_path);
let mut child = cmd
    .args(&args)
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(|e| format!("启动 llama-server 失败: {}", e))?;
let pid = child.id();
```

**日志转发** (model\_list.rs:894-950):

* 在独立线程中读取 stdout/stderr

* 逐行通过 `app.emit("model-log", ...)` 发送到前端

* 检测到 `"llama server listening"` 等关键词时额外发出 `model-started` 事件

**停止流程** (`stop_model`, model\_list.rs:955-993):

```rust
// Windows
std::process::Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/F"])
    .spawn()?
```

**进程状态检查** (`get_model_status`, model\_list.rs:1009-1015):

```rust
let mut sys = sysinfo::System::new();
sys.refresh_all();
sys.process(sysinfo::Pid::from_u32(pid)).is_some()
```

**退出时清理** (lib.rs:17-37):

* `on_window_event` 中监听 `CloseRequested`

* 如果有运行中的进程，执行 `taskkill /F`

***

## 二、可行性分析结论

**llama.cpp 完全可以作为子进程来控制，且当前项目已经实现了这一模式。** 具体来说：

### 2.1 完全可行（已实现的功能）

| 能力     | 实现方式                                            | 状态 |
| ------ | ----------------------------------------------- | -- |
| 进程启动   | `std::process::Command::spawn()`                | ✅  |
| 参数传递   | CLI args（`-m`, `-c`, `-ngl`, `--port` 等完整支持）    | ✅  |
| 进程终止   | `taskkill /PID /F` (Windows) / `kill -9` (Unix) | ✅  |
| 标准输出捕获 | piped stdout/stderr，转发到前端                       | ✅  |
| 进程状态监控 | sysinfo 库检查 PID 是否存在                            | ✅  |
| 端口管理   | `params.port` 可配置，默认 8080                       | ✅  |
| 应用退出清理 | window CloseRequested 事件处理                      | ✅  |

### 2.2 部分可行（有改进空间）

| 能力            | 当前问题                                   | 改进建议                                           |
| ------------- | -------------------------------------- | ---------------------------------------------- |
| **优雅关闭**      | 使用 `taskkill /F`（SIGKILL），非优雅关闭        | 先尝试 HTTP `/shutdown` API，再 fallback 到强制终止      |
| **状态检测准确性**   | 仅靠 PID 存在判断，PID 可能被 OS 回收重用            | 结合 HTTP health check (`GET /health` 或 `GET /`) |
| **子进程退出通知**   | 通过线程中 stdout EOF 判断，但不够可靠              | 使用 `child.wait()` 或 tokio 的 async wait         |
| **进程保活/自动重启** | 未实现                                    | 可添加 crash 检测 + 自动重启逻辑                          |
| **多实例管理**     | 只支持单进程（`running_process: Option<u32>`） | 可扩展为 `Vec<ProcessInfo>` 支持多个实例                 |
| **资源使用监控**    | 无                                      | 可添加 CPU/内存/RSS 采集                              |

### 2.3 需要特别注意/不可行

| 项目               | 说明                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **stdin 通信**     | `llama-server` 启动后作为独立 HTTP 服务器运行，不通过 stdin 交互。所有通信都通过 REST API 完成。如果需要 stdin 通信，应使用 `llama-cli` 而非 `llama-server`                          |
| **嵌入模式**         | 当前项目使用独立的 `llama-server.exe` 二进制文件，没有使用 Rust binding（如 `llama-cpp-rs` crate）。这种"子进程+HTTP"模式与嵌入式 API 调用模式不同，但更适合 GUI 应用场景，因为提供了更好的隔离性和独立重启能力 |
| **Windows 信号处理** | Windows 没有 POSIX 信号（SIGTERM/SIGKILL），必须使用 `taskkill /F` 或 `GenerateConsoleCtrlEvent`。当前使用 `taskkill /F` 是合理的                                |

***

## 三、与替代方案对比

| 方案                                  | 优势                                       | 劣势                             |
| ----------------------------------- | ---------------------------------------- | ------------------------------ |
| **子进程 + HTTP (当前方案)**               | 隔离性好、可独立重启、与任何语言兼容、llama-server 自带 WebUI | 进程间通信开销、需要管理端口、无法精细控制推理过程      |
| **Rust FFI binding (llama-cpp-rs)** | 零开销、直接控制推理、无网络开销                         | 编译复杂、构建体积大、crash 会影响主进程、代码复杂度高 |
| **C API (llama.h)**                 | 最底层控制                                    | 需要 unsafe Rust、内存管理复杂、开发成本极高   |

**结论**: 对于 GUI 桌面应用场景，**子进程+HTTP 是合理且推荐的方式**。

***

## 四、当前实现的问题与改进建议

### 4.1 已发现的 Bugs / 风险

1. **`sysinfo::System::new()`** **在每次状态检查时创建新实例** (model\_list.rs:1010-1011) — 性能低效且可能漏检。应复用 AppState 中的 `sys: Mutex<System>`。

2. **端口冲突风险** — 如果默认端口 8080 被占用，没有自动检测或备用端口逻辑。

3. **子进程 stdout/stderr 读取线程可能泄漏** — 线程在子进程退出后自然结束，但如果子进程 hang 住，线程也会 hang 住。

4. **无超时机制** — `start_model` 是异步但 spawn 后立即返回，前端轮询检测服务就绪，没有在后端设置合理的超时。

### 4.2 推荐改进（按优先级）

1. **高**: 增加优雅关闭 — 先发 `POST /shutdown`，再 fallback 到 `taskkill /F`
2. **高**: 复用 `sysinfo::System` 实例，避免每次 new
3. **中**: 端口自动分配（从指定端口开始找空闲端口）
4. **中**: 异步进程等待（使用 tokio::process::Command 或 spawn wait 任务）
5. **低**: 支持多实例（如需要同时运行 chat 模型和 embedding 模型）
6. **低**: 添加进程资源监控（CPU/内存）

***

## 五、核心代码路径总结

### 启动链路

```
Frontend (model_list.html)
  → invoke("start_model", {model_id, params})
    → [model_list.rs:start_model]
      → config::get_llama_server_path()         // 查找 llama-server.exe
      → 构建 CLI args (model path, params...)
      → create_hidden_command().args().spawn()   // 启动子进程
      → 保存 PID / port / model_id 到 AppState
      → emit("model-started")                    // 通知前端
      → spawn 线程读取 stdout/stderr            // 日志转发
```

### 停止链路

```
Frontend (model_list.html)
  → invoke("stop_model")
    → [model_list.rs:stop_model]
      → 从 AppState 获取 PID
      → taskkill /PID {pid} /F                   // 强制终止
      → 清空 AppState
```

### 状态检查链路

```
Frontend (轮询)
  → invoke("get_model_status")
    → [model_list.rs:get_model_status]
      → sysinfo::System 查 PID 是否存在
      → 返回 running / model_id / pid / port
```

***

## 六、验证建议

如需验证子进程控制方案的有效性：

1. **启动/停止测试**: 启动模型 → 检查进程是否存在 → 停止 → 检查进程是否消失
2. **异常退出处理**: 手动 kill llama-server 进程 → 检查状态是否正确更新
3. **端口冲突测试**: 先占用 8080 端口 → 尝试启动 → 观察错误处理
4. **并发启动测试**: 尝试在模型运行中再次启动 → 观察"已有模型在运行"提示
5. **退出清理测试**: 关闭应用 → 检查 llama-server 进程是否被清理

