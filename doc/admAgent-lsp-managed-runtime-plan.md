# admAgent LSP 运行时托管与打包方案（审核稿）

> 状态：P0 核心、安装进度 SSE、P1 单主过滤、桌面 API 切换与 Node 托管 runtime 已落地（2026-11-19）；离线 pack、API token 未完成；自动修复触发已按要求移除。
> 现状基线：仓库 HEAD `1058156`（2026-11-19）。
> 只读约束：已放开（2026-11-19，`AGENTS.md` 硬规则 2 / `doc/conventions.md` 已改为可修改）；本文保留为实施记录与后续审核材料。
> 改动边界（已定）：**所有代码改动只在 `admAgent/`**——LSP 状态、运行时探测、托管安装、修复、CLI 与 HTTP API 全部由 server 实现。
> 桌面端不在本地实现探测/安装/修复，只通过 API/SSE 消费状态并触发修复；`admAgent/` 修改按第 7 节落地，本文保留为审核材料。

## 本文导航

1. [结论](#1-结论)
2. [现状：LSP 是怎么实现的](#2-现状lsp-是怎么实现的)
3. [需求与约束](#3-需求与约束)
4. [方案对比与决策](#4-方案对比与决策)
5. [目标架构](#5-目标架构)（重点：5.2 Manifest、5.3 解析、5.6 安装/GC、5.7 PATH、5.11 API）
6. [默认白名单与排除清单](#6-默认白名单与排除清单)
7. [分阶段实施](#7-分阶段实施)
8. [改动文件地图](#8-改动文件地图初步)
9. [验收标准](#9-验收标准)
10. [决策记录与待确认项](#10-决策记录与待确认项)
11. [附录：现状相关文件](#11-附录现状相关文件)

---

## 1. 结论

**不做“把所有常用 LSP 塞进一个可执行文件”的全量单二进制。**

推荐方案：

> **admAgent 作为唯一 supervisor，共享 Node/Python/原生运行时，按 server 安装和升级；另外提供可选的“语言族离线 pack”（node / python / native）。**
>
> **实现位置：全部在 admAgent（Go server）。LSP 状态与修复动作统一通过 HTTP API/SSE 提供给桌面端、TUI 和 headless；桌面端只做展示与调用，不在本地实现探测/安装/修复。**

理由：

1. **体积**：排除商业/账号限制后，可打包的 server 反而更多；Node 运行时约 80-110MB（解压后），Python venv 100-200MB，clangd/rust-analyzer/deno 都是几十到上百 MB，全量单二进制会到 600MB-1GB+，安装包和更新都不可接受。
2. **更新耦合**：语言服务器更新远快于 ADM；共享运行时 + 按 server 安装可以让 runtime 安全更新和 server 功能更新互不牵连。
3. **许可与合规**：单二进制会把 MIT/Apache/BSD 与 GPL/AGPL/EPL/MPL 以及传递依赖（例如 `jedi-language-server` 依赖 LGPL-2.1+ 的 `docstring-to-markdown`）混进同一产物；分进程、分文件更容易做 notices、源码提供和替换。
4. **签名/公证**：每个 server 单独签名/公证可控；一个巨大二进制里再解压执行多个可执行文件，Windows Authenticode、macOS Gatekeeper 和杀软误报都更难处理。
5. **进程模型**：LSP 本来就需要一个 server 一个进程（崩溃隔离、不同运行时、原生扩展、CPU 阻塞）；“单二进制”最多只是 supervisor 单文件，不是单进程。
6. **单一事实来源**：状态分类、修复动作、安装目录、版本与许可证都在 server（manifest + `state.json`）；桌面端/TUI 调同一 API，避免 Rust `LSP_FIX_TABLE` 与 powernap/manifest 双份表漂移。

“一个文件”的合理实现是**一个离线 pack**（压缩包，admAgent 校验和解压），不是单个 exe。

---

## 2. 现状：LSP 是怎么实现的

### 2.1 总体架构

```text
ADM 桌面端 / TUI
      │
      ▼
admAgent server（Go，每个 workspace 一个 App 实例）
      │
      ├─ lsp.Manager（internal/lsp/manager.go）
      │     ├─ powernap v0.1.6 内置 LSP 目录（365 个条目）
      │     ├─ 用户 admAgent.json 的 lsp map
      │     ├─ 自动启动白名单 / 黑名单 / PATH 探测
      │     └─ lsp.Client（internal/lsp/client.go）
      │            └─ powernap client ── stdio JSON-RPC ──> 语言服务器进程
      │
      ├─ Agent 工具层（internal/agent/tools）
      │     ├─ 8 个 LSP 工具
      │     └─ edit / multiedit / write / view 的诊断联动
      │
      ├─ app.LSP 状态与事件（internal/app/lsp_events.go）
      │     └─ SSE `lsp_event`
      │
      └─ HTTP API（internal/server/proto.go）
            └─ /v1/workspaces/{id}/lsps...
```

桌面端和 TUI 共用同一个 Go server；LSP 客户端、状态、诊断、安装/修复都在服务端，桌面端只展示并通过 API 触发修复。

### 2.2 配置与内置目录

配置结构（`internal/config/config.go`）：

```go
type LSPConfig struct {
    Disabled    bool
    Command     string
    Args        []string
    Env         map[string]string
    FileTypes   []string   // JSON: "filetypes"
    RootMarkers []string   // JSON: "root_markers"
    InitOptions map[string]any
    Options     map[string]any
    Timeout     int
}
```

- 顶层配置键：`lsp`（`LSPs map[string]LSPConfig`）。
- 全局开关：`options.auto_lsp`（`*bool`，nil 视为 true）、`options.debug_lsp`。
- 内置目录来自 `github.com/charmbracelet/x/powernap v0.1.6` 的 `lsps.json`，共 365 个条目。
- `config.applyLSPDefaults()` 会按名称（或 command）把 powernap 的 `command/args/env/filetypes/root_markers/init_options/options` 补进用户配置，用户只写差异即可。
- `lsp.NewManager` 加载 powernap 默认目录，移除 `defaultLSPBlacklist`，再把用户 `lsp` 配置 `AddServer` 合并进去；`disabled: true` 的项直接移除。
- `defaultLSPBlacklist` 当前包含：`copilot`、`snyk_ls`、`tabby_ml`、`lsp_ai`、`vectorcode_server`、`contextive`、`kakehashi`、`custom_elements_ls`、`termux_language_server`。

### 2.3 启动流程

`Manager.Start(ctx, path)`：

1. 路径必须在 workspace 内（`fsext.HasPrefix`），否则直接返回。
2. 并发遍历 powernap 目录中的全部 server，对每个调用 `startServer`。
3. `startServer` 的判断顺序：
   - 用户显式配置的 server 不受自动启动白名单限制；
   - 非用户配置且 `options.auto_lsp=false` → 跳过；
   - `disabled` → 跳过；
   - 已有 `StateReady/StateStarting/StateDisabled` 客户端 → 复用并回调；
   - 用户配置：检查 `handles`（filetypes + root markers）；
   - 非用户配置：`canAutoStart`：
     1. 必须在 `autoStartAllowlist`（18 个）；
     2. command 不能是 `skipAutoStartCommands` 里的通用命令（`npx`、`node`、`python`、`python3`、`dart`、`dotnet`、`java` 等）；
     3. `handles` 通过（filetypes 命中 + root marker 存在）；
     4. 不在 `unavailable` 冷却窗口（30s）；
     5. `exec.LookPath(command)` 能找到。
   - `autoStartAllowlist`：`rust_analyzer`、`gopls`、`vtsls`、`pyright`、`basedpyright`、`pylsp`、`bashls`、`svelte`、`vue_ls`、`intelephense`、`dockerls`、`sqlls`、`emmet_ls`、`taplo`、`texlab`、`sqls`、`cmake`、`solargraph`。
4. 新建 `lsp.Client`，用 `Initialize` 发起 LSP handshake；初始化超时取 `config.timeout`（未设置时默认 30s）。
5. `Initialize` 失败 → `probeServerFailure` 跑一次 `<command> --version`（5s 上限），把输出日志/错误；`startupFailureType` 只用 `exec.LookPath(command)` 区分：
   - 找不到 command → `not_installed`
   - 找得到但初始化失败 → `startup_failed`
   随后 `markUnavailable` 写入 30s 冷却。
6. `WaitForServerReady` 成功置 `StateReady`；失败置 `StateError` 并回调，但**不会**写入 `unavailable` 冷却（与初始化失败不同）。
7. 回调把状态写入 `app.lspStates`，发布 `LSPEvent`，SSE 推给前端。

状态枚举（`lsp.ServerState`）：

| 值 | 名称 | 前端标签 |
| --- | --- | --- |
| 0 | `StateUnstarted` | 未启动 |
| 1 | `StateStarting` | 启动中 |
| 2 | `StateReady` | 已连接 |
| 3 | `StateError` | 错误 |
| 4 | `StateStopped` | 已停止 |
| 5 | `StateDisabled` | 已禁用 |

> `state` 是 int（0-5）。`doc/server-api.md` 已按整数描述；但 `LSPClientInfo` 的字段表漏了 `error_type`（proto 里有），本次新增 `reason`/`fix` 时一并补齐。

### 2.4 Client：握手、文件同步与诊断

`internal/lsp/client.go` 包了 powernap client：

- 启动命令：`powernap.ClientConfig{Command: home.Long(command), Args, RootURI, Environment, Settings, InitOptions, WorkspaceFolders}`。
- `Initialize` 前先注册 server 请求/通知 handler：
  - `workspace/applyEdit` → `util.ApplyWorkspaceEdit`；
  - `workspace/configuration` → 返回空配置数组；
  - `client/registerCapability` → 解析 `workspace/didChangeWatchedFiles` watcher；
  - `window/workDoneProgress/create` → no-op；
  - `window/showMessage` → 仅在 debug 时记录；
  - `textDocument/publishDiagnostics` → `HandleDiagnostics`。
- `WaitForServerReady` 每 500ms 检查 `client.IsRunning()`；启动期间打开 `root_markers` 里可读的文件（如 `tsconfig.json`、`go.mod`），帮助 server 建立项目上下文。
- 文件同步：
  - `OpenFile` 发送 `didOpen`（version 1，整文件内容）；
  - `NotifyChange` 发送 `didChange`（整文件替换，version 自增）；
  - `CloseAllFiles` 发送 `didClose`；
  - `RefreshOpenFiles` 对所有已打开文件重发 `didChange`；
  - `NotifyWorkspaceChange` 向 cwd URI 发送一次 `didChangeWatchedFiles(Changed)`，触发全量重新分析。
- 诊断：
  - `HandleDiagnostics` 写入 `VersionedMap[DocumentURI]`。
  - 单次保存会产生多条 `publishDiagnostics`，`notifyDiagnosticsChanged` 用 200ms 防抖合并成一次下游事件。
  - `GetDiagnosticCounts` 按 Error/Warning/Information/Hint 统计，带版本缓存。
  - `WaitForDiagnostics`：1s 内无变化直接返回；有变化则等到 300ms 不再变化，最长由调用方超时控制。
- 请求超时：references/document symbols/definition/call hierarchy prepare 5s；rename 和 incoming/outgoing calls 10s。
- 关闭：`Close` 先 `CloseAllFiles`，再 `Shutdown`，5s 超时后 `Kill`；`Restart` 关闭 10s、重建、30s 初始化、重开文件。
- `HandlesFile` 要求路径在 `cwd` 前缀内，并按扩展名/语言判断是否由该 client 处理。
- **当前未生效的点**：`RegisterFileWatchHandler` 有定义，但全仓库没有调用方；`client/registerCapability` 解析到的 watcher 并不会真正被消费。因此文件变化主要靠 `view/edit/write/lsp_*` 主动通知，而不是文件系统监听。

### 2.5 模型工具面

只有在 `len(config.lsp) > 0` 或 `options.auto_lsp` 为 nil/true 时，`coordinator` 才注册以下 8 个工具：

| 工具 | 作用 | 关键实现 |
| --- | --- | --- |
| `lsp_diagnostics` | 文件或项目诊断 | `notifyLSPs` 后汇总所有 client 的诊断，输出 `file_diagnostics` / `project_diagnostics` / `<diagnostic_summary>` |
| `lsp_references` | 符号引用 | 先用 grep 找候选，再用 LSP `findReferences` 校验并取回跨文件引用 |
| `lsp_restart` | 重启一个/全部 LSP | `Client.Restart`，失败返回错误文本 |
| `lsp_symbols` | 文件大纲 | `DocumentSymbols`，输出 kind/name/line |
| `lsp_definition` | 定义跳转 | grep 找候选位置 → LSP `definition` → 读取定义处上下文 |
| `lsp_call_hierarchy` | 调用者/被调用者 | `PrepareCallHierarchy` + `IncomingCalls`/`OutgoingCalls` |
| `lsp_rename` | 跨文件语义改名 | `WorkspaceEdit`，权限确认、写前 history 版本、应用编辑、刷新所有 client、返回诊断 |
| `lsp_replace_symbol` | 按符号边界替换/前插/后插/删除 | `DocumentSymbols` 取 range，CRLF 归一化，权限弹窗带 diff，写前 history 版本 |

工具联动：

- `edit`、`multiedit`、`write`、`lsp_replace_symbol` 成功后调用 `notifyLSPs(file)`：`OpenFileOnDemand` + `NotifyChange` + 每个匹配 client `WaitForDiagnostics(5s)`，然后把 `getDiagnostics(file)` 拼到工具结果。
- `view` 调用 `openInLSPs` + `waitForLSPDiagnostics(300ms)`，然后拼接该文件诊断。
- `lsp_rename` 应用完成后用 `notifyLSPs(ctx, manager, "")` 刷新所有打开文件并向 workspace 发变更通知。
- 符号名解析（`resolveSymbol`）：先 `searchFiles` 用 word-boundary grep 找最多 100 个候选，再对每个候选触发 lazy start / 找 client / 调一次 `Definition`；第一个不被 LSP 判为 “no identifier found” 的候选胜出。因此重载、同名符号、同名变量可能取到第一个匹配。
- `resolveLSPPath` 拒绝 workspace 之外的路径；`lsp_symbols`、`lsp_definition`、`lsp_call_hierarchy` 都经过它。`lsp_replace_symbol` 不调用它，而是依赖 `findLSPClient`/`HandlesFile` 的 workspace 前缀检查；这是后续统一边界处理的改动点。
- `lsp_rename` / `lsp_replace_symbol` 走 `permission.Service`、`history.Service`、`filetracker.Service`，因此会弹权限、留撤销版本、记录文件访问。

工具缺陷（当前）：

- 没有任何 LSP client 时，工具仍已注册，返回 “no LSP clients available” / “no LSP client handles file”，不带安装建议。
- `lsp_diagnostics` 的“当前文件”判断用传入的 `file_path` 与 URI 解析出的绝对路径比较；传相对路径时可能全部落到 `project_diagnostics`。
- `lsp_rename` / `lsp_replace_symbol` 的符号定位基于 grep/同名符号，重载和同名成员存在歧义。

### 2.6 事件、HTTP API 与桌面 UI

- `app.App` 每个 workspace 持有：
  - `LSPManager *lsp.Manager`；
  - `lspStates *csync.Map[string, LSPClientInfo]`；
  - `lspBroker *pubsub.Broker[LSPEvent]`。
- 启动时 `app.LSPManager.SetCallback` 写入状态、注册诊断回调；`TrackConfigured` 对用户显式配置的 LSP 先回调一次（即使还没启动，面板也能看到）。
- `LSPEvent` 两种类型：`state_changed`、`diagnostics_changed`；字段含 `name`、`state`、`error`、`error_type`、`diagnostic_count`。
- HTTP API（`internal/server/proto.go`）：
  - `GET /v1/workspaces/{id}/lsps` → `map[string]LSPClientInfo`
  - `GET /v1/workspaces/{id}/lsps/{lsp}/diagnostics` → 原始诊断 map
  - `POST /v1/workspaces/{id}/lsps/start` → `{path}`，启动能处理该路径的 server
  - `POST /v1/workspaces/{id}/lsps/stop` → 停止全部
- SSE 事件类型 `lsp_event`；前端 `onToolStatusSSEEvent` 只处理 `state_changed`，`diagnostics_changed` 直接忽略（诊断计数变化太频繁，工具面板不展示）。
- 桌面「工具 → LSP」页：
  - 拉 `/lsps` 展示状态、错误、诊断数；
  - `not_installed` 的条目直接隐藏（不作为故障）；
  - `startup_failed` 且可修复 → 「修复」按钮；不可修复但有指引 → 「指引」；所有错误都提供「AI 安装」；
  - 顶部有「启动失败自动修复」开关（localStorage `agent_lsp_auto_fix`）。

> 目标形态：面板的数据全部来自 `GET /lsps` + `lsp_event`；“能不能修、怎么修”由 server 返回的 `reason`/`fix` 决定（见 5.11），桌面端不再维护本地规则。现状的桌面端安装逻辑见 2.7，属于待下线部分。

### 2.7 安装/修复链路（现状：桌面端三层，待整体下线）

> 这一层是**当前**实现，也是本方案要移除的部分：目标方案中安装/修复全部在 server，桌面端只调用 API（见 5.11）。
> 保留本节是为了记录现有行为，以及迁移时需要对齐的语义（安装目标、探测方式、AI 安装入口）。
> 迁移：桌面端 `agent_lsp_auto_fix`（localStorage）接入 API 时写入 server 的 `options.lsp_auto_repair`，避免两套开关。

`src/views/agent/lsp_fix.js`：

| 层 | 内容 |
| --- | --- |
| T1 自动安装 | Rust `agent_lsp_fix_targets` 返回白名单；`agent_lsp_fix` 执行固定安装命令；前端 `runLspFix` 安装后调用 `/lsps/start` 并轮询状态 |
| T2 安装指引 | `LSP_GUIDES` 给 `clangd`、`lua_ls`、`zls`、`dartls`、`elixirls`、`metals`、`kotlin_language_server`、`omnisharp`、`sourcekit`、`phpactor`、`nil_ls`、`lemminx` 等提供命令和链接 |
| T3 AI 安装 | `runAiInstall` 把安装任务作为 prompt 发给当前会话，让 agent 自己用 bash/网络处理 |

Rust `src-tauri/src/pages/agent.rs`：

- `LSP_FIX_TABLE`：18 个 LSP 的固定安装命令，按顺序探测 `rustup`/`go`/`npm`/`pip`/`pip3`/`cargo`/`gem`，用第一个可用的。
- 命令全部是全局安装：`npm install -g`、`pip install`、`go install ...@latest`、`rustup component add`、`cargo install`、`gem install`。
- `LSP_FIX_BINS`：安装后用于复查 PATH 的二进制名。
- `LSP_FIX_LOCK`：串行化安装，避免多个 LSP 同时装互相破坏。
- `agent_lsp_fix`：600s 超时；继承代理设置；Windows 隐藏窗口；成功后用 `which_program_on_path(bin)` 复查（只用进程 PATH），找不到就返回“装进了不在 PATH 的目录”的错误；失败返回输出尾段。
- `search_dirs()`：安装探测时补充 Homebrew、`~/.cargo/bin`、`~/go/bin`、Volta、Bun、Deno、pnpm、nvm 等目录；**只用于安装探测，不会改 sidecar 或 LSP 子进程的 PATH**。
- `LSP_PROBE_EXT`（前端）：用伪造的 `__lsp_start__.<ext>` 路径触发对应 server 启动；轮询 `/lsps` 最多 4 轮 × 6s。

### 2.8 当前实现的关键常量

| 常量 | 值 | 位置/作用 |
| --- | --- | --- |
| powernap 目录条目 | 365 | `powernap/pkg/config/lsps.json` |
| 自动启动白名单 | 18 | `autoStartAllowlist` |
| 默认黑名单 | 9 | `defaultLSPBlacklist` |
| 通用命令拒绝自动启动 | 27 | `skipAutoStartCommands` |
| 初始化超时 | `config.timeout`，默认 30s | `Manager.startServer` |
| 不可用冷却 | 30s | `unavailableRetryDelay` |
| `--version` 探测超时 | 5s | `probeServerFailure` |
| 诊断发布防抖 | 200ms | `diagNotifyDebounce` |
| 诊断稳定窗口 | 300ms | `waitForDiagnosticsToSettle` |
| 工具等待诊断上限 | 5s | `notifyLSPs` |
| 关闭优雅等待 | 5s | `closeTimeout` |
| 重启初始化 | 30s | `Client.Restart` |
| 桌面安装超时 | 600s | `agent_lsp_fix` |

### 2.9 现状问题清单

| 问题 | 影响 | 代码位置 |
| --- | --- | --- |
| 安装是全局 `npm -g` / `pip` | 装到用户级目录后 admAgent 看不到；macOS GUI PATH 更严重 | `LSP_FIX_TABLE`、`agent_lsp_fix` |
| 只按 `LookPath(command)` 分类 | `npx`/`node` 在但包没装、Node 太旧、网络失败都算 `startup_failed` | `startupFailureType` |
| `probeServerFailure` 只跑 `<command> --version` | 拿不到真实原因；`npx` 可能触发下载 | `probeServerFailure` |
| 无版本固定 | `@latest` / 无版本 pip/npm，上游更新直接破坏 | `LSP_FIX_TABLE` |
| 通用命令禁止自动启动 | `npx`/`node`/`python` 类 server 必须手写配置 | `skipAutoStartCommands` |
| 一个语言可能同时起多个 server | `.py` 同时匹配 pyright/basedpyright/pylsp；`.sql` 同时 sqlls/sqls；资源、诊断、失败提示翻倍 | `Manager.Start` + allowlist |
| 工具无 client 时仍注册 | 返回 “no LSP clients available”，没有修复建议 | `coordinator` 工具注册 |
| 安装逻辑只在桌面端 | TUI/headless 没有一键修复；Rust 表与 powernap/manifest 双份维护，容易漂移 | `src-tauri/src/pages/agent.rs` |
| 安装过程不可观测/不可取消 | 600s 内无进度，失败只能看输出尾段，无法中止 | `agent_lsp_fix` |
| watcher 注册未消费 | `workspace/didChangeWatchedFiles` 注册被解析但无 handler | `lsp/handlers.go` |
| 符号名定位基于 grep | 重载/同名符号可能歧义 | `resolveSymbol` |
| 状态只有 `error_type`（`not_installed`/`startup_failed`），没有可修复性与动作字段 | 桌面端必须靠本地 `LSP_FIX_TABLE` 判断怎么修 | `internal/lsp/manager.go`、`internal/proto/proto.go` |
| 自动修复包含商业 LSP | `LSP_FIX_TABLE` 含 `intelephense` | `src-tauri/src/pages/agent.rs` |

---

## 3. 需求与约束

1. **用户机器不可假设有 Node/Python/JVM 等全局环境**，尤其是从 Finder 启动的 macOS GUI（PATH 极简）。
2. **不能改用户全局 PATH、不能要求管理员权限**；安装必须落在用户可写目录。
3. **状态与修复只在 server**：TUI、桌面端、headless 共用同一组 API；桌面端不得再实现探测/安装/修复逻辑。
4. **确定性**：同一 ADM 版本装出同一 server 版本；升级必须显式。
5. **可恢复**：安装失败不破坏已有版本；支持重试、修复、回滚。
6. **合规**：不默认分发商业/账号/AGPL；GPL/EPL/MPL 单独处理 notices/source。
7. **跨平台**：Windows x64/arm64、macOS x64/arm64、Linux x64/arm64；签名/公证。
8. **前缀/资源成本可控**：不能因为 LSP 工具让 agent 固定前缀再膨胀。
9. **API 单一入口**：LSP 状态、诊断计数、错误分类、安装/修复/重启都通过 server API（+SSE/CLI）提供；桌面端不读本地 PATH、不执行安装命令、不 patch `admAgent.json` 的 LSP 段。
10. **不混改两端**：本方案的代码改动全部在 `admAgent/`；桌面端接入 API 是独立任务，只换调用地址与展示，不新增逻辑。

---

## 4. 方案对比与决策

| 方案 | 体积 | 更新 | 许可 | 签名/公证 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 全量单二进制（所有 server + 运行时） | 600MB-1GB+ | 随 ADM 发版，整包更新 | 混合 GPL/AGPL/传递依赖，风险最高 | 巨大产物 + 解压执行，最难 | 淘汰 |
| 语言族 pack（node/python/native） | 每包 80-300MB | pack 独立版本 | 可控 | 每包签名 | **离线选项** |
| 共享运行时 + 按 server 安装 | runtime 一次，server 几十 MB | runtime/server 独立 | 最可控 | 逐个签名 | **默认** |
| Docker lsp-toolbox | 镜像 1-2GB | 独立 | 镜像内简单 | 镜像签名 | 可选（已用 Docker 的高级用户） |
| Bun/Deno 编译 JS 单文件 | 每 server 50-150MB | 独立 | 需逐个验证 | 单文件签名 | 试点，不做默认 |

**决策：默认“共享运行时 + 按 server 安装”，离线用语言族 pack；不把全量单二进制作为产品形态。**

补充：

- 如果产品必须提供“一个文件下载”，提供一个 `lsp-offline.pack`（或 node/python/native 三个 pack），admAgent 导入后解压到托管目录；用户看到的是一个文件，但运行时仍是多个 server 子进程。
- JS/TS 子集可以试点 Bun/Deno 编译：把 vtsls、bashls 等纯 JS server 变成不依赖 Node 的单文件，但 pyright 的 Node API/动态 require、原生模块和许可证需要逐个验证。

---

## 5. 目标架构

### 5.1 托管目录

```text
<GlobalCacheDir()>/lsp/
  runtime/node/<version>/            # 可选的固定版本 Node（按平台）
  runtime/python/<version>/          # 可选的固定版本 Python / uv
  servers/<name>/<version>/          # node_modules / venv / 原生二进制；按版本隔离
  bin/<name>/<version>/              # 原生 server（也可放 servers/<name>/<version>/bin）
  packs/                             # 离线 pack 解压/安装记录
  .locks/<name>.lock                 # 跨进程安装锁
  .locks/state.lock                  # state.json 全局写锁
  state.json                         # 每个 server 的 active 版本指针、resolved command、哈希、健康状态
```

Windows：`%LOCALAPPDATA%\admAgent\cache\lsp`；macOS/Linux：`$XDG_CACHE_HOME/admAgent/lsp` 或 `~/.cache/admAgent/lsp`（与 `config.GlobalCacheDir()` 对齐）。

安装目录必须在用户可写目录，**不能写 ADM 安装目录**（Program Files 只读、签名校验也会失败）。默认路径可用 `lsp_install_dir` 覆盖；禁止指向工作区或 ADM 安装目录。目录权限 0700；`state.json` 用文件锁 + 临时文件 rename 原子写。

### 5.2 Manifest

每个 server 一条 manifest，作为唯一事实来源：

```json
{
  "name": "vtsls",
  "displayName": "TypeScript / JavaScript",
  "runtime": { "kind": "node", "minVersion": "20", "managedVersion": "22.14.0" },
  "package": { "registry": "npm", "name": "@vtsls/language-server", "version": "0.3.0", "integrity": "sha512-..." },
  "entry": "node_modules/@vtsls/language-server/bin/vtsls.js",
  "args": ["--stdio"],
  "filetypes": ["ts", "tsx", "js", "jsx"],
  "rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"],
  "license": "MIT",
  "source": "https://github.com/yioneko/vtsls",
  "sha256": "<可选，下载/安装后校验>",
  "platforms": ["windows-x64", "darwin-arm64", "linux-x64"],
  "autoInstall": true,
  "large": false,
  "priority": 10
}
```

要求：

- `license` 用 SPDX 标识；`source` 记录仓库/发行页；`sha256` 对下载包或安装产物校验。
- `runtime` 声明 `minVersion`/`maxVersion` 作为系统运行时可用区间（`maxVersion` 可省略表示不设上限）；`autoInstall`/`large` 控制默认安装与体积提示（见 5.3、第 10 节）。
- `priority`/`primary` 控制单语言候选顺序与主备；`guide` 提供不可自动修复时的安装指引（URL/命令/说明）。
- 所有版本 pin 死，禁止 `@latest`；升级是显式动作。
- manifest 随 admAgent 二进制发布（`go:embed`），不远程拉取；改 manifest 必须发版，避免未签名清单引入任意安装源。
- manifest 与 powernap 目录解耦：manifest 决定运行时、入口和安装方式；同名 server 以 manifest 为准，powernap 只补 `filetypes`/`root_markers`/`init_options` 的缺省值。
- 当前 powernap 目录缺少一些常用 web server（`yamlls`、`jsonls`、`cssls`、`html`、`eslint`、`tailwindcss`、`astro`、`typescript-language-server`、`biome`），需要在我们自己的 manifest 中补。

### 5.3 解析与健康检查

解析顺序：

1. 用户显式配置的 `lsp.<name>`（command/args/env 完整且可用）；
2. 托管安装（`state.json` 标记 healthy）；
3. 系统运行时 + 系统安装（版本满足 `minVersion`）；
4. 按需安装/下载（需用户确认或 `options.lsp_managed_runtime=auto`）；
5. 回退链中的下一个 server。

> 解析顺序里的“托管安装”指 server 包；runtime 按下面的偏好单独选择。托管 server 包优先于系统包是为了版本确定；runtime 默认系统优先是为了避免重复下载 100MB。

运行时选择（建议）：

- `options.lsp_runtime_preference=system`（默认）：优先系统 Node/Python；版本在 manifest 的 `minVersion`/`maxVersion` 区间内直接使用，否则用托管 runtime（缺失时按下载策略处理）。
- `options.lsp_runtime_preference=managed`：始终使用托管 runtime，保证可复现；适合 CI、企业统一环境。
- 实际选中的 runtime 路径/版本写入 `state.json`，并通过 `GET /lsps` 的 `runtime` 字段暴露，避免“到底用了哪个 Node”不可见。

启动前检查：

- runtime 及其包管理器（node+npm、python+pip/venv、go）是否存在、版本是否满足；
- package/entry/bin 是否存在；
- 目录是否可写；
- 必要时跑一次 `--version`（server 级，而不是只跑 runtime）；
- 通过一次 LSP `initialize`/`WaitForServerReady` 才算健康。

`state.json` 记录 active 版本、resolved command、runtime 路径/版本、安装时间、哈希、最近错误；启动时优先复用，避免每次文件事件都重新探测 PATH。文件带 `schema_version`，升级时迁移，未知/损坏版本先备份为 `.bak` 再重建，不静默丢弃。

`Manager.NewManager` 必须同时加载 curated manifest 与 `state.json` 中的托管安装（不能只依赖 `admAgent.json`）：托管 server 不写入用户配置，`filetypes`/`root_markers`/`args`/`env` 由 manifest 提供，用户 `lsp.<name>` 仍可覆盖。`TrackConfigured` 和面板也要包含托管安装项，否则安装成功但状态面板看不到。

用户 `lsp.<name>.disabled=true` 优先于托管安装：不自动启动，但保留启用/卸载入口。

### 5.4 错误分类

保留旧值 `not_installed` / `startup_failed` 作为兼容 umbrella，新增 `reason`/`fix` 字段（不要直接改前端已依赖的枚举）：

| 新 reason | 含义 | 建议 fix |
| --- | --- | --- |
| `missing_runtime` | 没有 Node/Python/Go 等，或版本低于 min | `install_runtime:node` |
| `missing_package` | runtime 在，包/入口不存在 | `install_server:vtsls` |
| `version_mismatch` | 包要求更高 runtime，或 server 版本不兼容 | `upgrade_runtime` / `upgrade_server` |
| `permission` | 目录不可写、EACCES/EPERM | `guide` / 换目录 / `retry` |
| `network` | npm/pip 下载失败、代理不可达 | `retry` / 打开代理设置 |
| `checksum_failed` | 下载包或安装产物哈希不符 | `reinstall` / `retry` |
| `install_failed` | 安装命令/构建/postinstall/venv 失败 | `retry` / `guide` |
| `unsupported_platform` | manifest 无当前 `GOOS/GOARCH` 资产 | `guide` |
| `license_blocked` | 商业/账号/AGPL 或未核实许可证 | `guide` |
| `disk_space` | 磁盘空间不足 | `guide` / `retry` |
| `startup_failed` | 以上都通过，但 handshake/crash | `open_log` / `reinstall` |
| `disabled` | 用户禁用 | `none` |

表中的 `guide` 指状态里的 `guide` 字段（安装指引），其余为 `fix.kind`。兼容映射（客户端旧枚举不改）：

- `not_installed` → `missing_runtime` / `missing_package` / `checksum_failed` / `install_failed` / `unsupported_platform` / `license_blocked`。
- `startup_failed` → `version_mismatch` / `permission` / `network` / `checksum_failed` / `disk_space` / `startup_failed`。

`probeServerFailure` 改成按 manifest 探测：先 runtime 版本，再入口存在与哈希，最后才跑 server 的 `--version`；日志里记录 resolved command、env PATH、安装目录。

### 5.5 单语言单主 server

当前 `Manager.Start` 会启动所有匹配的 server，导致 `.py` 同时起 pyright/basedpyright/pylsp。改为：

- 每个语言/文件类型一个有序候选列表；
- 自动启动只启动第一个健康的；失败才尝试下一个；
- 用户显式配置多个时尊重用户配置（`primary`/`priority` 字段决定主备）；同能力多个显式主 server 全部启动，但面板标记主/备并提示重复诊断风险；
- 辅助能力（`ruff`、`typos_lsp`、`harper_ls` 等 lint/format/spell）不受单主限制，可与主 server 并行；
- 面板显示当前实际使用的 server，其他标为「备用」。

建议优先级（第一版）：

| 语言 | 候选顺序 |
| --- | --- |
| Python | `pyright` → `basedpyright` → `pylsp`（`ty`/`pyrefly` 许可证与稳定性核实后再前插）；`ruff` 并行做 lint/format |
| TypeScript/JavaScript | `vtsls` → `typescript-language-server` → `denols`（仅 Deno 项目） |
| SQL | `sqls` → `sqlls` |
| HTML | `emmet_ls` / `emmet_language_server` |
| CSS | `stylelint_lsp` / `unocss` / `cssmodules_ls` |
| JSON/YAML | `jsonls` / `yamlls` |
| Markdown | `marksman` / `markdown_oxide` |

注意：`ruff` 只做 lint/format，不能替代类型检查；`ty`/`pyrefly` 是预览项目，先验证稳定性和许可证。`typos_lsp`/`harper_ls` 可与主 server 并行（不同能力），不受“单主”限制。

### 5.6 安装/修复/GC

- 目录布局按版本隔离：`servers/<name>/<version>/`；`state.json.active_version` 指向当前版本，回滚只切指针，不移动文件。
- Node server：`npm install --prefix <servers/<name>/<version>> <pkg>@<version> --no-audit --no-fund --omit=dev --ignore-scripts`（必须 postinstall 的包走 manifest allowlist），解析 `package.json` 的 `bin`，用绝对 `node <entry>` 启动；Windows 不走 `.cmd` shim。
- Python server：`python -m venv <servers/<name>/<version>>` + venv 内 `pip install <pkg>==<version>`（有哈希时 `--require-hashes`）；没有系统 Python 时用 `uv` 引导固定版本。
- Go/Rust/原生：`GOBIN=<bin>/<name>/<version>` / `CARGO_INSTALL_ROOT=<dir>`，或下载官方 release 到 `<bin>/<name>/<version>`。
- 安装原子化：临时目录 → 校验 → rename；失败保留旧版本；`state.json` 最后写入。Windows 目标已存在时用 `MoveFileEx(REPLACE_EXISTING)`/重试，不能假设 `os.Rename` 能覆盖目录。
- 并发：server 内 job 队列 + **跨进程文件锁**（`.locks/<name>.lock`，Unix `flock` / Windows `LockFileEx`）；`state.json` 读-改-写全程持 `.locks/state.lock`，临时文件 + rename 原子落盘。`LSP_FIX_LOCK` 随桌面端旧链路一起下线。
- 超时与清理：单步超时（下载 300s / 安装 600s / 健康检查 60s）与 job 总超时；超时/取消终止进程树并清理临时目录；server 重启时清理 stale `.tmp`/锁，未完成 job 标失败。
- GC：启动和安装成功后异步执行；只保留 active + 上一个可回滚版本，跳过 active 与运行中 client 引用的版本。
- 修复：`repair` = 重新解析 runtime → 重装同一 pin 版本 → 健康检查；不自动升级。
- 升级：显式 `upgrade`，修改 manifest 的 pin 版本，保留回滚。
- 卸载：`uninstall` 只删目标版本；active 或被运行中 client 引用的版本需先停止/切换，否则拒绝，状态可重试。
- runtime 升级：只影响新启动的 client；运行中的 client 继续使用旧 runtime，重启/健康检查通过后再切换。

### 5.7 PATH 归一化

- 服务端启动时构造一次：
  - 托管目录的 `runtime/node/<v>`、`runtime/python/<v>`、`bin/<name>/<v>`；
  - 平台补充目录（Homebrew、`~/.cargo/bin`、`~/go/bin`、Volta、Bun、Deno、pnpm、nvm）；
  - macOS/Linux 通过登录 shell 取一次 PATH（`$SHELL -lc 'printf %s "$PATH"'`），5s 超时、合并到现有 PATH 而不是替换，缓存并定期刷新；
  - Windows 补充 `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\Python\*\Scripts`、`%USERPROFILE%\.cargo\bin`、`%USERPROFILE%\go\bin`。
- 只注入 LSP 子进程与安装子进程的 env，不修改全局环境；PATH 归一化在 server 启动时完成并缓存，**不依赖桌面端注入环境变量**。
- 代理与下载：Go 侧下载复用 `internal/httpproxy`（`agent_proxy`）；npm/pip 子进程注入 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`。`doctor` 显示生效代理（URL 脱敏），日志不写密钥。
- `options.debug_lsp` 打开时把 resolved command、版本、PATH 写日志（不要写密钥）。

### 5.8 安全与合规

- 版本 pin + SHA256；下载走 HTTPS/用户代理；强制 manifest 的 registry（npm `--registry`、pip `--index-url`），不读用户 `.npmrc`/`pip.conf` 的自定义镜像，除非在 manifest 允许列表。
- npm 默认 `--ignore-scripts`，必须 postinstall 的包单独 allowlist；npm 包使用 manifest 的 `dist.integrity`/SHA256 校验，pip 使用 `--require-hashes`（或安装后校验 wheel 哈希）。
- 安装端点只接受 manifest 中存在的 `name`/`version`，拒绝任意 package、registry、args、env；`confirm=true` 才执行。这是本地高权限动作，默认仅本机访问；若 server 绑定非 loopback，必须加 token/鉴权（见 5.11）。
- 安装命令用 `exec.Command` 参数数组执行，不拼接 shell 字符串；包名/版本/路径只来自 manifest，避免命令注入。
- 托管目录 0700；`state.json` 不含密钥；下载 URL 只允许 manifest 声明的 HTTPS 源。
- Windows 对打包的可执行文件做 Authenticode；macOS codesign + notarize；下载的二进制校验官方 checksum。
- 第三方 notices 随 pack 分发；GPL/EPL/MPL 只放可选 pack，附源码获取方式；AGPL 默认不进包。
- 单二进制会把 LGPL 依赖（如 `docstring-to-markdown`）和主产物绑在一起；分文件/分进程更容易满足 LGPL 的替换/重链接要求。

### 5.9 体积影响

默认方案（共享运行时 + 按 server 安装）**不把运行时和语言服务器打进 admAgent 二进制**，所以：

| 项目 | 默认方案 | 全量内置/离线版 |
| --- | --- | --- |
| `admAgent` 二进制 | 只增加 manifest/解析/安装器代码，约几百 KB 到几 MB（未压缩）；不嵌 Node/Python/server | 按平台嵌入压缩后的 pack，增加几十 MB 到几百 MB |
| ADM 安装包 | 不变（sidecar 仍是现有 `externalBin`；LSP 资产按需下载） | 增加 pack 的压缩体积 |
| 用户缓存目录 | 按需增长：Node 约 80-110MB（解压后）、Python/uv + venv 约 100-200MB、单个 server 几 MB 到几十 MB、clangd 等原生 server 上百 MB | 同左，但首次安装不需要联网 |
| 首次下载 | 只下用户实际用到的 runtime/server | 随安装包/离线包一次性获得 |

参考：当前 `admAgent.exe` 未压缩约 57MB，发布压缩包约 18-19MB；powernap 的 365 项目录 `lsps.json` 只有约 62KB，新增的 curated manifest 也是几十 KB 量级。**新增 Go 代码和 manifest 对 sidecar 体积的影响远小于任何运行时/server；真正的体积在用户缓存目录，而不是 admAgent 二进制。**

如果要做“一个文件”的离线版，建议把 pack 作为**独立下载项**（`lsp-node.pack` 等），只有明确需要离线安装的用户才付出体积；不要默认塞进 ADM 安装包。

### 5.10 自动下载流程与触发时机

> 先明确：**当前代码没有“自动下载 LSP”机制**。现在的“自动修复”是桌面端在启动失败时调用全局 `npm -g`/`pip` 安装（`LSP_FIX_TABLE`），不是下载托管包，也没有运行时下载。下面是目标方案。

**原则**：按需、按平台、按版本；不在启动时预下载全部语言；不下载商业/账号/AGPL；下载前先检查已有 runtime/package；下载可配置、可审计、可回滚。

**触发点**：

1. 用户显式安装/修复：LSP 面板、`admAgent lsp install`、`POST /v1/lsp/install`。
2. 首次需要某语言：`Manager.Start(path)`、LSP 工具、`view/edit/write` 触发 lazy start，解析候选 server 后发现 runtime/package 缺失。
3. 启动失败分类为 `missing_runtime` / `missing_package`，且 `options.lsp_auto_repair=true`。
4. 导入离线 pack（不联网）。
5. 用户显式 `upgrade`；不自动追 latest。

**不触发**：

- `options.auto_lsp=false` 且没有显式配置；
- `options.lsp_managed_runtime=off`；
- `options.lsp_auto_repair=false` 时的非用户触发修复；
- 商业/账号/AGPL 名单；
- 已有健康的托管安装，或系统 runtime + package 满足版本；
- 同一 `(server, reason, version)` 的冷却窗口内；
- 离线/无网络：直接返回 `network`，不反复重试。

**流程**（由 Go server 执行）：

1. 文件/路径 → 语言/文件类型 → 候选 server 列表（主 + 回退）。
2. 读 manifest → 按 `GOOS/GOARCH` 选平台资产（如 `windows-x64`、`darwin-arm64`、`linux-x64`）。
3. 解析顺序：用户配置 → 托管 server 包（`state.json` healthy）→ 系统 server 包（版本满足）→ 需要下载；runtime 按 5.3 的偏好单独选择。
4. 需要下载时：
   - 运行时资产（Node/Python）：平台专属 URL + SHA256 → 临时目录 → 校验 → 原子解压到 `runtime/<kind>/<version>`；
   - server 包：Node `npm install --prefix`、Python venv/pip、原生 release 到 `bin/<name>/<version>`；全部 pin 版本；
   - 任一步失败保留旧版本，不破坏现有安装。
5. 健康检查：入口存在 → 哈希校验 → `--version` → LSP `initialize` / `WaitForServerReady`。
6. 写 `state.json` → 按请求决定是否启动 client（默认只安装不自动启动）→ 发 `lsp_event`（状态/进度）→ UI/CLI 显示结果。
7. 失败分类为 `missing_runtime` / `missing_package` / `version_mismatch` / `permission` / `network` / `checksum_failed` / `install_failed` / `unsupported_platform` / `license_blocked` / `disk_space` / `startup_failed`，写入日志和冷却，不自动循环重装。

**平台选择**：

- 只下载当前平台资产，不做跨平台 universal；manifest 的 `platforms`/`assets` 由 `GOOS/GOARCH` 决定。
- Node/Python 运行时按“平台 + 版本”只下一次，所有同 runtime 的 server 共享。
- JS/Python server 包大多平台无关，但 venv/原生依赖和 native server 必须按平台。
- 离线 pack 也按平台生成，例如 `lsp-node-windows-x64.pack`。

**策略建议**：

- 默认 `options.lsp_managed_runtime=ask`：首次下载弹确认，展示来源、大小、许可证；用户可以勾选“以后自动”。
- 已确认过的 runtime/版本，以及小体积 server 包，可切到 `auto`。
- `off`：完全禁用下载，只用用户配置/系统安装。
- 下载前检查磁盘空间和代理；失败按 `(server, reason, version)` 冷却 30 分钟或直到用户手动重试。
- `options.lsp_auto_repair`（默认 false）：开启后只自动修复已批准的 `(name, version)`；任何新 runtime/server 版本仍按 `lsp_managed_runtime` 的 `ask`/`auto` 策略。

**执行位置（已定）**：

- 统一在 Go server 的 `internal/lsp/runtime` 执行；桌面端只负责调用 API 与展示，TUI/headless 通过同一 API/CLI 获得同样能力。
- **不保留“Rust 临时执行、后续迁移”的路径**：安装/探测/修复只此一份实现，避免 `LSP_FIX_TABLE` 与 server manifest 双份维护；桌面端现有 Rust 命令不再扩展，后续单独任务下线。
- server 负责构造 PATH、选择 registry、执行安装命令、校验产物与健康检查；桌面端不参与。

### 5.11 状态与修复 API（桌面端唯一入口）

**原则**

- server 是 LSP 状态与修复动作的唯一事实来源；桌面端、TUI、headless 调同一组接口。
- 兼容优先：现有 `GET /lsps`、`GET /lsps/{lsp}/diagnostics`、`POST /lsps/start`、`POST /lsps/stop` 保留；`state` 继续是 int 0-5，`error_type` 继续保留 `not_installed`/`startup_failed` 作为 umbrella，新字段只增不改。
- 修复动作必须可预览、幂等、可重试、可观测：每次请求返回 job id，进度走 SSE，`GET /v1/lsp/jobs/{job_id}` 作为断线兜底。
- 安装是全局动作（写 `lsp_install_dir`，默认 `GlobalCacheDir()/lsp`），状态是 workspace 维度；安装器/托管目录是进程级单例，多个 workspace App 共享，job 事件按请求携带的 workspace 路由。

**状态模型（扩展 `LSPClientInfo`）**

```json
{
  "name": "vtsls",
  "state": 3,
  "error": "node: command not found",
  "error_type": "not_installed",
  "diagnostic_count": 0,
  "connected_at": "0001-01-01T00:00:00Z",
  "reason": "missing_runtime",
  "fix": {
    "kind": "install_runtime",
    "runtime": "node",
    "server": "vtsls",
    "version": "22.14.0",
    "requires_confirm": true,
    "estimated_bytes": 104857600,
    "license": "MIT",
    "source": "https://nodejs.org/"
  },
  "guide": { "url": "https://...", "note": "无法自动安装时展示" },
  "runtime": { "kind": "node", "version": "22.14.0", "source": "system", "path": "/usr/local/bin/node" },
  "server_version": "0.3.0",
  "managed": true
}
```

- `reason` 取值见 5.4；`fix.kind` 取 `install_runtime` / `install_server` / `upgrade_runtime` / `upgrade_server` / `reinstall` / `rollback` / `retry` / `open_log` / `none`。
- `fix` 只描述“可执行动作”，不带客户端本地规则：桌面端有 `fix` 就按 `kind` 展示按钮，没有就只展示 `error`。
- 后续变更（已落地）：`fix` 只在托管未安装且系统 PATH 也解析不到入口时下发（系统安装的 gopls 不再被判成 `missing_package`）；桌面端对 `state=1/2`（启动中/已连接）不再展示 `install_server`。见 [admAgent-server.md](admAgent-server.md) LSP 托管安装与 [frontend-agent-conventions.md](frontend-agent-conventions.md)。
- `guide` 是无法自动修复时的安装指引（URL/命令/说明），由 manifest 提供；桌面端不再本地维护 `LSP_GUIDES`。
- `managed` 表示 server 包是否来自托管安装；runtime 的系统/托管来源看 `runtime.source`。
- `open_log`/`none` 是 UI 动作，不产生 job；`install_*`/`upgrade_*`/`reinstall`/`rollback`/`retry` 才可提交 `/fix`；`repair` 是 `reinstall` 同一 pin 的别名。
- `not_installed` 且 `fix.kind=none` 的项（不在白名单/无 manifest）不展示安装按钮；`startup_failed` 仍可 `retry`/`open_log`。
- 「AI 安装」不是 `fix.kind`：它仍是桌面端把安装需求发给当前会话的独立入口，不参与状态与修复判定。

**端点**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/workspaces/{id}/lsps` | 状态列表（扩展字段；面板主数据源） |
| GET | `/v1/workspaces/{id}/lsps/{lsp}/diagnostics` | 诊断（不变） |
| POST | `/v1/workspaces/{id}/lsps/start` | 按路径启动（兼容保留） |
| POST | `/v1/workspaces/{id}/lsps/{lsp}/start` | 按名称启动，替代桌面端伪造 `__lsp_start__.<ext>` |
| POST | `/v1/workspaces/{id}/lsps/{lsp}/restart` | 重启单个 server |
| POST | `/v1/workspaces/{id}/lsps/stop` | 停止全部（不变） |
| GET | `/v1/lsp/catalog` | manifest 目录（版本、平台、许可证、体积、可修复动作） |
| POST | `/v1/lsp/doctor` | 环境诊断（PATH、runtime 版本、目录可写、代理） |
| POST | `/v1/lsp/install` | 安装/升级单个 server 或 runtime，返回 job 或预览计划 |
| POST | `/v1/lsp/fix` | 按 `reason`/`fix` 执行安装/升级/重装/回滚/重试（install/upgrade/reinstall/rollback/retry），返回 job 或预览计划 |
| GET | `/v1/lsp/jobs/{job_id}` | 轮询 job 状态（SSE 断线兜底） |
| GET | `/v1/lsp/jobs` | 列出当前/最近 job（重连后恢复进度） |
| POST | `/v1/lsp/jobs/{job_id}/cancel` | 取消安装/修复，终止进程树并清理临时目录 |
| POST | `/v1/lsp/uninstall` | 卸载指定 server 版本（job） |

**请求/响应**

```json
// POST /v1/lsp/install（server，可顺带装 runtime）
{ "workspace_id": "ws_...", "target": "server", "name": "vtsls", "version": "0.3.0", "install_runtime": true, "confirm": true }

// POST /v1/lsp/install（runtime）
{ "workspace_id": "ws_...", "target": "runtime", "runtime": "node", "version": "22.14.0", "confirm": true }

// POST /v1/lsp/fix（action 取 fix.kind 中可执行值；repair = reinstall 同一 pin）
{ "workspace_id": "ws_...", "name": "vtsls", "action": "repair", "version": "0.3.0", "confirm": true }

// 预览（confirm=false，无 job）
{ "plan_id": "lsp-plan-01...", "plan": { "name": "vtsls", "action": "install_server", "runtime": { "kind": "node", "version": "22.14.0" }, "version": "0.3.0", "source": "https://...", "license": "MIT", "size_bytes": 1234567, "sha256": "...", "steps": ["install_runtime", "install_server"] } }

// 执行（confirm=true，使用预览计划）
{ "workspace_id": "ws_...", "plan_id": "lsp-plan-01...", "confirm": true }

// 执行（直接确认，auto 模式）
{ "workspace_id": "ws_...", "target": "server", "name": "vtsls", "version": "0.3.0", "confirm": true }

// job 响应
{ "job_id": "lspjob_01...", "status": "queued" }

// POST /v1/lsp/uninstall
{ "name": "vtsls", "version": "0.3.0", "confirm": true }

// 错误
{ "error": "...", "reason": "missing_package", "fix": { "kind": "install_server", "server": "vtsls" }, "job_id": "..." }
```

- `confirm=false` 只返回 `plan_id` + 计划（来源、版本、大小、许可证、SHA256、命令/步骤摘要），不创建 job；桌面端弹确认后再发 `confirm=true`，对应 `options.lsp_managed_runtime=ask`。
- `plan_id` 是进程内 TTL（建议 5 分钟）；`confirm=true` 带 `plan_id` 时执行该计划，过期/丢失返回 `409 plan_expired`，计划内容变化返回 `409 plan_changed`，客户端必须重新预览。
- 不带 `plan_id` 的 `confirm=true` 仅允许在 `options.lsp_managed_runtime=auto` 下直接执行（按请求参数重新解析），`ask`/`off` 模式拒绝。
- `install.version` 可省略，缺省用 manifest 的 pin；显式传值必须落在 manifest 的允许版本内，server 拒绝任意版本。`target` 缺省 `server`；`install_runtime=false` 时不自动下载 runtime，只返回 `fix.kind=install_runtime`。
- `workspace_id` 可选，仅用于把进度事件路由到该 workspace；省略时只能轮询 `/v1/lsp/jobs/{job_id}`。
- 同一 server 同时只允许一个安装/修复 job。相同 `(action, version)` 的重复请求幂等复用现有 job（200，`deduplicated: true`）；不同版本/动作返回 `409 Conflict`，带 `existing_job_id` 与 `Retry-After`。server 按 server 名加锁（含跨进程文件锁），job 结束/失败后释放，不排队多个安装。
- workspace 关闭不取消全局安装 job；job 继续执行，事件丢弃，之后可用 `GET /v1/lsp/jobs/{job_id}` 查询结果。**job ctx 必须脱离 HTTP 请求 ctx**（`startInstallJob`/`startRollbackJob`/`startUninstallJob` 一律 `context.WithCancel(context.Background())`）：202 返回后 `r.Context()` 立即取消，若派生请求 ctx，后台安装会立刻变 `canceled`（表现为「修复失败：canceled」）；取消只走显式 `POST /v1/lsp/jobs/{job_id}/cancel`。
- job 状态：`queued` → `running` → `succeeded` / `failed` / `canceled`；`failed` 带 `reason`、`fix`、日志尾段（≤32KB，脱敏代理凭据/token）。`GET /v1/lsp/jobs/{job_id}` 返回 `job_id`、`name`、`target`、`action`、`status`、`phase`、`percent`、`message`、`started_at`、`finished_at`、`error`、`reason`、`fix`、`log_tail`。
- **镜像回退与重试**（`install.go` 的 `npmInstall`/`pipInstall`、`runtime.go` 的 `nodeDistMirrors`）：npm/pip 安装首次尊重用户自己的配置（.npmrc / pip.conf / env），失败（且非 job 被取消）后用公共镜像重试一次（npm `--registry https://registry.npmmirror.com`，pip `-i https://pypi.tuna.tsinghua.edu.cn/simple`），两次都失败返回首次错误（用户配置环境的真实报错，避免镜像域名噪音）；重试 phase=`retry` 写进 job 进度与日志。托管 Node 下载与 SHASUMS256.txt 校验和按 `nodeDistMirrors`（nodejs.org → npmmirror）顺序取包，校验和仍按官方值比对。单测锁定：`TestNpmInstallRetriesWithMirror` / `TestNpmInstallNoRetryAfterCancel` / `TestInstallJobDetachedFromRequestContext`。
- job 是 server 进程内资源，不跨重启持久化；重启时终止遗留子进程、清理 stale `.tmp`/锁，未完成 job 标失败并回滚 `state.json`，避免写入假成功。
- 可观测性：每个 job 记录 `job_id`、`name`、`action`、phase 切换、耗时、退出码、resolved command/URL（脱敏）；`options.debug_lsp` 打开时额外输出 PATH 与完整命令。
- HTTP 状态码：预览 `200`；创建 job `202 Accepted`；重复 job 复用 `200`；`400` 参数/计划非法，`404` workspace/server/job 不存在，`409` job 冲突/计划过期或变化，`422` 平台或许可证不允许安装，`429` 冷却中（带 `Retry-After`），`500` 未预期错误。

**catalog / doctor 响应**

```json
// GET /v1/lsp/catalog
{ "servers": [ { "name": "vtsls", "displayName": "TypeScript / JavaScript", "runtime": { "kind": "node", "minVersion": "20" }, "version": "0.3.0", "license": "MIT", "source": "https://...", "platforms": ["windows-x64", "darwin-arm64"], "size_bytes": 1234567, "auto_install": true, "large": false, "experimental": false, "active_version": "0.3.0", "previous_version": "0.2.0" } ] }

// POST /v1/lsp/doctor
{ "runtime": [ { "kind": "node", "path": "...", "version": "22.1.0", "source": "system", "compatible": true } ], "path": ["..."], "install_dir": { "path": "...", "writable": true, "free_bytes": 123456789 }, "proxy": { "enabled": true, "url": "http://...（脱敏）" }, "problems": [ { "reason": "network", "message": "...", "fix": { "kind": "retry" } } ] }
```

- catalog 是全局安装目录的视图；workspace 的实际状态仍以 `GET /lsps` 为准。
- manifest 字段用 camelCase（`autoInstall`/`rootMarkers`），HTTP JSON 统一 snake_case（`auto_install`/`root_markers`），转换在 server 完成。
- doctor 不修改环境；只报告 PATH、runtime、目录权限、磁盘空间、代理与 manifest 校验结果。

**SSE**

在现有 `lsp_event` 上新增子类型，不新开事件通道：

| `type` | 负载 | 用途 |
| --- | --- | --- |
| `state_changed` | `LSPEvent`（不变） | 状态/错误变化 |
| `diagnostics_changed` | `LSPEvent`（不变） | 诊断计数变化 |
| `install_progress` | `job_id`、`name`、`phase`、`percent`、`message` | 安装/修复进度 |
| `job_finished` | `job_id`、`status`、`reason`、`fix`、`error` | 安装/修复结束 |

- 进度事件按 server 节流（≥200ms），阶段文案由 server 生成（`resolve_runtime` / `download` / `install` / `verify` / `health_check`），桌面端不解析命令输出。
- 事件负载形如 `{"type":"install_progress","job_id":"...","name":"vtsls","phase":"download","percent":42,"message":"..."}`；安装是全局动作，但事件只发到请求携带的 `workspace_id`，避免多窗口重复弹进度。
- SSE 断开时桌面端用 `GET /v1/lsp/jobs/{job_id}` 或 `GET /v1/lsp/jobs` 轮询恢复；现有只处理 `state_changed` 的前端不会因新子类型报错。

**桌面端调用顺序（接入时照此实现，不含本地逻辑）**

1. 打开 LSP 面板：`GET /lsps` 取状态、`GET /v1/lsp/catalog` 取可安装项，并订阅 `lsp_event`；`GET /lsps` 只展示已跟踪/已安装项，避免 powernap 365 条 `not_installed` 噪音。
2. 点击修复/安装：`POST /v1/lsp/fix` 或 `/install`（先 `confirm=false` 取计划）→ 展示来源/版本/大小/许可证 → `confirm=true` → 按 `install_progress` 更新进度。
3. 成功后 `POST /v1/workspaces/{id}/lsps/{lsp}/start`，再 `GET /lsps` 确认 `state=2`。
4. 失败只用响应里的 `reason`/`fix`/`guide`/`error` 展示，不根据本地命令表推断；需要取消时 `POST /v1/lsp/jobs/{job_id}/cancel`。
5. 桌面端不执行 `npm/pip/go/cargo`，不读写托管目录，不改 `admAgent.json`；这些动作只在 server。

**CLI 映射**

`admAgent lsp list|doctor|install|repair|restart|uninstall|cancel` 直接调用同一组内部服务，保证 TUI/headless 与 HTTP API 结果一致；CLI 输出字段与 JSON 响应同构。

---

## 6. 默认白名单与排除清单

> 说明：以下按“常用 + 可维护 + 无商业许可/账号”筛选。powernap 365 个目录里剩余的长尾多数也是开源，但依赖特定 SDK/编辑器生态，默认不打包；进包前逐个做 SPDX + 传递依赖审计。
>
> **默认自动安装/自动启动只覆盖轻量常用集**：`vtsls`、`pyright`、`bashls`、`gopls`、`lua_ls`、`taplo`、`yamlls`、`jsonls`；`clangd`/`deno`/`rust_analyzer` 等大体积项只出现在 catalog，按需安装并确认体积。

### 6.1 Node pack（共享 Node 运行时）

| LSP | 语言 | 许可证 | 备注 |
| --- | --- | --- | --- |
| `vtsls` | TS/JS | MIT | npm 核实 |
| `typescript-language-server` | TS/JS | Apache-2.0 | 需新增目录项 |
| `pyright` | Python | MIT | npm 核实 |
| `basedpyright` | Python | MIT | npm 核实 |
| `bashls` | Bash | MIT | npm 核实 |
| `svelte` | Svelte | MIT | npm 核实 |
| `vue_ls` | Vue | MIT | npm 核实 |
| `dockerls` | Dockerfile | MIT | npm 核实 |
| `docker_compose_language_service` | Compose | MIT | `@microsoft/compose-language-service` |
| `sqlls` | SQL | MIT | npm 核实 |
| `emmet_ls` | HTML/JSX | MIT | npm 核实 |
| `graphql` | GraphQL | MIT | `graphql-language-service-cli` |
| `prismals` | Prisma | Apache-2.0 | npm 核实 |
| `yamlls` | YAML | MIT | 需新增目录项 |
| `jsonls` / `cssls` / `html` / `eslint` | JSON/CSS/HTML/JS | MIT | 需新增目录项，`vscode-langservers-extracted` |
| `stylelint_lsp` | CSS | MIT | npm 核实 |
| `unocss` | CSS | MIT | npm 核实 |
| `diagnosticls` | 通用 | MIT | `diagnostic-languageserver` |
| `vimls` | Vimscript | MIT | npm 核实 |
| `purescriptls` | PureScript | MIT | npm 核实 |
| `rescriptls` | ReScript | MIT | npm 核实 |
| `marko-js` | Marko | MIT | npm 核实 |
| `css_variables` / `cssmodules_ls` | CSS | MIT | npm 核实 |
| `astro` | Astro | MIT | 需新增目录项 |
| `tailwindcss` | Tailwind | MIT | 需新增目录项 |
| `ansiblels` | Ansible | MIT | `@ansible/ansible-language-server` |
| `shopify_theme_ls` | Liquid | MIT | `@shopify/theme-language-server-node` |
| `herb_ls` | ERB | MIT | `@herb-tools/language-server` |
| `ember` | Ember | MIT | `@ember-tooling/ember-language-server` |
| `stimulus_ls` | Stimulus | MIT | npm 核实 |

### 6.2 Native pack（无运行时）

| LSP | 语言 | 许可证 | 备注 |
| --- | --- | --- | --- |
| `gopls` | Go | BSD-3-Clause | |
| `rust_analyzer` | Rust | MIT OR Apache-2.0 | cargo 核实 |
| `clangd` | C/C++/ObjC | Apache-2.0 WITH LLVM-exception | 体积较大 |
| `lua_ls` | Lua | MIT | |
| `zls` | Zig | MIT | |
| `taplo` | TOML | MIT | cargo 核实 |
| `sqls` | SQL | MIT | |
| `marksman` | Markdown | MIT | |
| `markdown_oxide` | Markdown | MIT | |
| `harper_ls` | 英文写作 | Apache-2.0 | cargo 核实 |
| `typos_lsp` | 拼写 | MIT | cargo 核实 |
| `nil_ls` | Nix | MIT OR Apache-2.0 | cargo 核实 |
| `nixd` | Nix | MIT | |
| `nickel_ls` | Nickel | MIT | cargo 核实 |
| `helm_ls` | Helm | Apache-2.0 | |
| `dprint` | 格式化 | MIT | cargo 核实 |
| `biome` | JS/TS/JSON/CSS | MIT OR Apache-2.0 | npm 核实 |
| `denols` | Deno/TS | MIT | 体积较大 |
| `ruff` | Python lint | MIT | PyPI 核实 |
| `pylyzer` | Python | MIT OR Apache-2.0 | PyPI 核实 |
| `ast_grep` | 多语言 | MIT | cargo 核实 |
| `efm-langserver` | 通用 | MIT | |
| `vale_ls` | 英文写作 | MIT | |
| `verible` | SystemVerilog | Apache-2.0 | |
| `dhall_lsp_server` | Dhall | BSD-3-Clause | |
| `just` / `just-lsp` | Justfile | CC0-1.0 | cargo 核实 |
| `sqruff` | SQL | Apache-2.0 | cargo 核实 |
| `fortitude` | Fortran | MIT | cargo 核实 |
| `rumdl` | Markdown | MIT | cargo 核实 |

### 6.3 Python pack（共享 uv/Python）

| LSP | 语言 | 许可证 | 备注 |
| --- | --- | --- | --- |
| `pylsp` | Python | MIT | PyPI 核实 |
| `jedi_language_server` | Python | MIT | PyPI 核实；传递依赖 `docstring-to-markdown` 是 LGPL-2.1+ |
| `cmake` | CMake | MIT | PyPI 核实 |
| `esbonio` | Sphinx | MIT | PyPI 核实 |
| `fortls` | Fortran | MIT | PyPI 核实 |
| `robotframework_ls` | Robot Framework | Apache-2.0 | Python 3.13 安装测试失败，需验证 |
| `salt_ls` | Salt | Apache-2.0（待核实） | |
| `neocmake` | CMake | 待核实 | |
| `pyre` | Python | MIT（待核实） | |

`ty`、`pyrefly` 很有价值，但 PyPI 元数据没有许可证字段，进包前必须核实仓库 LICENSE；`zuban` 已确认 **AGPL-3.0-only**，默认排除。

### 6.4 排除：商业许可 / 账号 / 伴生服务

| LSP | 原因 |
| --- | --- |
| `intelephense` | 商业许可，免费版功能受限；当前 `LSP_FIX_TABLE` 仍包含，需移除 |
| `copilot` | GitHub Copilot 账号/订阅 |
| `snyk_ls` | Snyk 账号/token |
| `tabby_ml` | 需要 Tabby 服务端 |
| `lsp_ai` | 需要 LLM API key |
| `grammarly` | 商业服务 |
| `gitlab_duo` | GitLab 账号/订阅 |
| `codebook` | 商业 AI 助手 |
| `phptools` | PHP Tools 商业许可 |
| `matlab_ls` | 需要 MATLAB 商业运行时 |

### 6.5 开源但有合规义务（默认不进包）

| LSP | 许可证 | 处理 |
| --- | --- | --- |
| `texlab` | GPL-3.0 | 可选 GPL pack，附源码 |
| `quick_lint_js` | GPL-3.0-or-later | 默认不打包 |
| `zuban` | AGPL-3.0-only | 默认排除 |
| `autotools_ls` | GPL-3.0-or-later | 默认不打包 |
| `textlsp` | GPLv3 | 默认不打包 |
| `jdtls` | EPL-2.0 | 可选 JVM pack，附 notices/source |
| `lemminx` | EPL-2.0 | 同上 |
| `clojure_lsp` | EPL-1.0（待核实） | 同上 |
| `terraformls` / `terraform_lsp` / `tofu_ls` | MPL-2.0 | 可选 pack，附源码 |
| `twiggy_language_server` | MPL-2.0 | 可选 |
| `ada_ls` | GPL-3.0（待核实） | 可选/排除 |
| `coq_lsp` | LGPL-2.1（待核实） | 可选，独立进程 |
| `solc` | GPL-3.0 | 可选/排除 |

### 6.6 大型运行时/SDK（开源但默认不进包）

| 运行时 | LSP |
| --- | --- |
| JVM | `jdtls`、`java_language_server`、`kotlin_language_server`、`kotlin_lsp`、`metals`、`gradle_ls`、`groovyls`、`clojure_lsp`、`lemminx`、`ltex` |
| .NET | `omnisharp`、`roslyn_ls`、`fsautocomplete`、`fsharp_language_server`、`msbuild_project_tools_server` |
| Ruby | `solargraph`、`rubocop`、`standardrb`、`sorbet`、`syntax_tree`、`theme_check` |
| PHP | `phpactor`、`phan`、`psalm`、`laravel_ls`、`phpantom_lsp` |
| Erlang/Elixir | `elixirls`、`elp`、`expert`、`nextls` |
| Julia/R/Dart/Swift | `julials`、`r_language_server`、`dartls`、`sourcekit` |
| Haskell/OCaml/Nim/Crystal/D | `hls`、`ocamllsp`、`nimlsp`、`crystalline`、`serve_d` |
| 其他 | `vhdl_ls`、`svls`、`svlangserver`、`tclsp`、`awk_ls`、`fish_lsp`、`nushell`、`typst_lsp`、`tinymist`、`terraformls`、`solidity_ls`、`move_analyzer`、`cairo_ls`、`cue` |

`verible`、`dhall_lsp_server` 等原生项已在 6.2，不在这里重复。这些都不需要商业许可或账号，但需要各自运行时/SDK；进包前逐个核实许可证和传递依赖。

---

## 7. 分阶段实施

> 实施进度（2026-11-19）：P0、SSE 进度事件、P1 单主过滤、桌面 API 切换、Node 托管 runtime 已落地；离线 pack、API token 未做；自动修复触发已按要求移除。

**落地前置条件（已完成）**：

1. 已完成（2026-11-19）：`AGENTS.md` 硬规则 2 / `doc/conventions.md` 的“`admAgent/` 只读”已改为可修改。
2. 已完成：本文已加入 `AGENTS.md` 的「方案与实施记录」索引。

### P0：server 端统一状态与修复 API（系统运行时 + 托管安装）

目标：把现有桌面端 T1/T2 的能力整体搬到 admAgent，桌面端只消费 API；本阶段仍使用系统 Node/Python，不下载 runtime。

1. 新增 `internal/lsp/runtime` 最小版 + `internal/lsp/manifest`：最小 curated manifest（vtsls/pyright/bashls/gopls 等）、托管目录（`lsp_install_dir`，默认 `GlobalCacheDir()/lsp`）、`state.json`、跨进程文件锁、原子安装（临时目录 → 校验 → rename）、GC 接口预留。
2. 安装执行器（系统运行时，按版本隔离）：
   - Node：`npm install --prefix <servers/<name>/<version>> <pkg>@<version> --no-audit --no-fund --omit=dev --ignore-scripts`，解析 `package.json` 的 `bin`，command 写绝对 `node <entry>`；
   - Python：`python -m venv <servers/<name>/<version>>` + venv 内 `pip install <pkg>==<version>`；
   - Go/Rust/原生：`GOBIN`/`CARGO_INSTALL_ROOT` 或官方 release 落到 `<bin>/<name>/<version>`；
   - 禁止 `npm -g`/`pip --user`；不写全局 PATH；不改 `admAgent.json`（resolved command 写 `state.json`）。
3. 托管安装发现：`Manager.NewManager` 加载 curated manifest + `state.json` 中的托管安装（不能只依赖 `admAgent.json`）；托管 server 的 args/env/filetypes/root_markers 由 manifest 提供，用户 `lsp.<name>` 仍可覆盖；`TrackConfigured` 与面板包含托管项。
4. 状态与修复 API（5.11）：`GET /lsps` 扩展 `reason`/`fix`/`guide`/`runtime`/`server_version`/`managed`；新增 `GET /v1/lsp/catalog`、`POST /v1/lsp/doctor`、`POST /v1/lsp/install`、`POST /v1/lsp/fix`、`GET /v1/lsp/jobs`、`GET /v1/lsp/jobs/{job_id}`、`POST /v1/lsp/jobs/{job_id}/cancel`、`POST /v1/lsp/uninstall`、`POST /v1/workspaces/{id}/lsps/{lsp}/start|restart`；SSE 增加 `install_progress`/`job_finished`。
5. 错误分类：`probeServerFailure` 按 manifest 探测（runtime 版本 → 入口存在/哈希 → server `--version`）；`startupFailureType` 保留 umbrella，新增 `reason`；补齐 `checksum_failed`/`unsupported_platform`/`license_blocked`/`disk_space`。
6. CLI：`admAgent lsp list|doctor|install|repair|restart|uninstall|cancel`，输出与 API JSON 同构。
7. 文档同步：`doc/admAgent-server.md`、`doc/server-api.md`、`doc/agent-settings.md`、`doc/conventions.md`、`AGENTS.md`；只读约束已放开，后续只同步行为/契约变化。
8. 桌面端零改动：现有 `agent_lsp_fix` 暂留可用但不再扩展；后续单独任务切到 5.11 API（只改调用与展示）。

### P1：resolver / 单语言单主 / 回退链（仍在 admAgent）

1. 新增 `internal/lsp/resolver`（manifest 解析、绝对命令、env、候选排序、回退链）。
2. 改造 `internal/lsp/manager.go`：
   - `canAutoStart` 用 resolver，不再只 `LookPath(command)`；
   - `startServer` 用 resolved command/args/env；
   - 冷却按 `(server, reason, version)` 维度，不无脑 30s；
   - 单语言单主（5.5），主候选失败才回退。
3. 扩充 curated manifest（5.2、第 6 节），与 powernap 目录解耦，补齐缺失的常用 server；manifest 的 `priority`/`primary`/`guide` 字段完整化。
4. resolver 结果写入 `state.json`；`GET /lsps` 显示实际选中的候选，其余匹配项标为「备用」（5.5）。
5. 消费 `workspace/didChangeWatchedFiles` 注册；工具错误文本带 `reason`/`fix`/`guide`；符号解析改进，并修复 `lsp_diagnostics` 相对路径归类与 `lsp_replace_symbol` 的 workspace 边界不一致。
6. 文档同步：`doc/admAgent-server.md`、`doc/server-api.md`、`doc/agent-settings.md`、`AGENTS.md`（P1 新增字段/行为部分）。

### P2：固定运行时 / 原生优先 / 离线 pack

1. 按需下载固定版本 Node（Windows/macOS/Linux，x64/arm64），SHA256 校验，原子解压；或复用系统 Node（版本满足时）。
2. Python 用 `uv` 引导固定版本，或系统 Python 创建 venv；一个托管 Python 运行时 + 每 server 一个 venv。
3. 原生优先：`ruff`/`ty`/`pyrefly`（许可证核实后）、`biome`、`tsgo`（稳定后）、`deno`（Deno 项目），减少 Node/Python 依赖。
4. 离线 pack：`lsp-node.pack`、`lsp-python.pack`、`lsp-native.pack`；manifest + 文件 + SHA256 + 签名；导入后解压到托管目录。

### P3：实验/可选

1. Bun/Deno 编译 JS server 单文件（vtsls/bashls 等），验证兼容性、体积、许可证。
2. Docker `lsp-toolbox` 镜像（仅高级用户/隔离场景）。
3. 语言族 pack 的增量更新/差分下载。

---

## 8. 改动文件地图（初步）

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 服务端 | `admAgent/internal/lsp/manager.go` | 状态 reason/fix、resolver、错误分类、单语言单主、冷却、绝对命令 |
| 服务端 | `admAgent/internal/lsp/client.go` | 接受 resolved command/env；健康检查；日志 |
| 服务端 | `admAgent/internal/lsp/handlers.go` | 消费 watcher 注册（或明确删除未用 handler） |
| 服务端 | `admAgent/internal/lsp/runtime/*`（新增） | runtime 探测、版本、托管目录、原子安装、state、job、GC |
| 服务端 | `admAgent/internal/lsp/manifest/*`（新增） | embedded curated manifest、schema 校验、license/platform/guide 元数据 |
| 服务端 | `admAgent/internal/lsp/resolver/*`（新增） | manifest、入口解析、回退链 |
| 服务端 | `admAgent/internal/config/config.go` / `load.go` | `options.lsp_managed_runtime`、`options.lsp_runtime_preference`、`options.lsp_auto_repair`、`lsp_install_dir`、manifest 默认值 |
| 服务端 | `admAgent/internal/agent/coordinator.go` | 工具注册条件；无 client 时的错误提示 |
| 服务端 | `admAgent/internal/agent/tools/lsp_*.go` | 错误文本带 `reason`/`fix`/`guide`；符号解析/路径边界改进 |
| 服务端 | `admAgent/internal/app/lsp_events.go`、`internal/workspace/workspace.go` | 新 reason/fix/guide 字段、安装/修复进度事件、三处 LSP 类型同步 |
| 服务端 | `admAgent/internal/server/*`、`internal/proto/*` | 5.11 的状态/安装/修复/doctor/job API |
| 服务端 | `admAgent/internal/cmd/*` | `admAgent lsp ...` CLI |
| 服务端 | `admAgent/internal/lsp/*_test.go`、`internal/lsp/runtime/*_test.go`、`internal/server/*_test.go` | 解析/错误分类/单主/锁/原子安装/API 契约测试（不依赖公网） |
| 桌面端 | 不改 | 本方案不触碰 `src/`、`src-tauri/`；后续接入只调用 5.11 API（只改 `lsp_fix.js`/`tools.js` 的调用地址与展示，不新增安装逻辑） |
| 文档 | 本文 + `doc/admAgent-server.md` + `doc/server-api.md` + `doc/agent-settings.md` + `doc/conventions.md` + `AGENTS.md` | 行为/契约同步；`doc/rust-backend.md`、`doc/frontend-agent-conventions.md` 仅在桌面端后续下线旧命令时更新 |

---

## 9. 验收标准

1. 干净 Windows/macOS（只有系统 Node/Python，没有全局语言服务器）：`POST /v1/lsp/install` 先 `confirm=false` 返回计划、`confirm=true` 创建 job；安装 vtsls/pyright/bashls 后 `GET /lsps` 为 `state=2`，不修改全局 PATH，不使用 `npm -g`。
2. 完全没有 Node/Python：P2 能下载托管运行时并完成安装；离线 pack 可在无网环境导入；两者都通过同一 API 返回 job 结果。
3. macOS 从 Finder 启动、PATH 极简：server 归一化 PATH 后能发现 `~/go/bin/gopls`、nvm 下的 Node；`GET /lsps` 的 `runtime.path` 能看出实际解析结果。
4. 错误矩阵：缺少 runtime / 缺少包 / 版本不匹配 / 权限 / 网络 / handshake 失败，`reason`+`fix` 字段可区分，桌面端不需要本地表就能给出不同提示。
5. `.py` 默认只启动一个主 server；主 server 失败才回退；不出现 pyright + basedpyright + pylsp 同时抢诊断。
6. 修复/重装/重启/取消全部走 API；job 状态可查，SSE 断线可用 `GET /v1/lsp/jobs` 恢复；不会在冷却窗口内反复重试同一失败原因。
7. TUI/headless：`admAgent lsp doctor/install/repair` 与 HTTP API 结果一致；桌面端接入后读到同样的 `LSPClientInfo`。
8. 许可证闸门：默认 pack 不含商业/账号/AGPL；GPL/EPL/MPL 只在可选 pack 并附 notices/source。
9. 签名/公证：Windows/macOS 的托管二进制通过签名校验；杀软误报可控。
10. 测试：runtime 版本解析、manifest 解析、错误分类、单语言单主、PATH 注入、原子安装/回滚、跨进程锁、job 并发/幂等/取消、API/SSE 契约；`go test ./internal/...` 覆盖服务端，安装测试用本地文件 registry/fixture，不依赖公网；桌面端接入只做手动展示验收。
11. 托管安装不写 `admAgent.json`：重启 server、切换 workspace、同时开 TUI 后仍能从 `GET /lsps` 看到并启动；两个进程同时安装同一 server 只产生一个 job。
12. 安全：`/install`、`/fix` 只接受 manifest 内 name/version；`checksum_failed` 拒绝执行；server 绑定非 loopback 时安装端点要求 token；日志不出现代理密码/密钥。

---

## 10. 决策记录与待确认项

### 已定（本次审核）

1. **改动边界**：所有代码改动只在 `admAgent/`；桌面端 `src/`、`src-tauri/` 不改。
2. **状态与修复 API 化**：LSP 状态、错误分类、修复/安装/重启统一由 server API（+SSE/CLI）提供；桌面端只展示与调用。
3. **安装/修复下沉 Go server**（原第 6 问）：Rust `LSP_FIX_TABLE`/`agent_lsp_fix` 不再扩展，桌面端后续接入 API 时删除本地实现。
4. **`doc/server-api.md` 的 `state` 整数表述**（原第 10 问）：已修正；`LSPClientInfo` 字段表需补 `error_type`，本次新增 `reason`/`fix` 时一并更新。

### 待确认（附建议）

1. **是否接受“共享运行时 + 按 server 安装 + 可选离线 pack”，而不是全量单二进制？**
   建议：接受。默认就是共享运行时 + 按 server 安装；离线 pack 只作为独立下载物（按语言族），不默认塞进 ADM 安装包。全量单二进制仅在未来作为“离线聚合包”的打包形式，不作为运行时形态。
2. **运行时策略：优先系统 Node/Python，还是默认托管？**
   建议：**系统优先、托管兜底**。manifest 用 `minVersion`/`maxVersion` 声明可用区间；系统 runtime 在区间内直接用，否则用托管 runtime。实际选择写入 `state.json` 并通过 `GET /lsps` 暴露。需要完全确定性的场景用 `options.lsp_runtime_preference=managed` 强制托管；默认 `system`。
3. **自动下载是否需用户显式同意？默认 `auto` 还是 `ask`？**
   建议：默认 `ask`。首次下载 runtime 或新版本 server 时展示来源、版本、大小、许可证、SHA256；确认后按 `(name, version)` 记住，可切 `auto`，`off` 完全禁用。已批准版本的“修复/重装”可随 `options.lsp_auto_repair`（默认 false）自动执行，不重复弹窗。
4. **默认白名单是否按第 6 节执行？是否删掉 clangd/deno 这类大体积项？**
   建议：第 6 节作为 **catalog（可安装目录）**，不等于默认自动安装列表。catalog 保留 `clangd`/`deno`/`rust_analyzer`，但标 `large: true`、`autoInstall: false`，用户显式安装时确认体积；默认自动安装/自动启动只覆盖轻量常用集（`vtsls`、`pyright`、`bashls`、`gopls`、`lua_ls`、`taplo`、`yamlls`、`jsonls` 等）。`intelephense` 从默认 catalog 移除。
5. **是否移除 `LSP_FIX_TABLE` 里的 `intelephense` 一键安装？**
   建议：移除。桌面端旧表随 T1 下线；server manifest 默认不收录。用户自带商业许可证时仍可通过显式 `lsp.intelephense` 配置使用（用户显式配置优先）。
6. **单语言单主 server 是否默认开启？用户显式配置多个时是否允许并行？**
   建议：**自动启动默认单主；显式配置尊重复数**。按 `(语言, 能力)` 选主，主失败才回退；`ruff`/`typos_lsp`/`harper_ls` 等辅助能力可与主并行。新增 `primary`/`priority` 字段；用户显式配置多个同能力主 server 时全部启动，但面板标记主/备并提示重复诊断风险。
7. **`ty`/`pyrefly`/`pyre` 等许可证待核实的项是否纳入默认包？**
   建议：不纳入。许可证未确认或不在 SPDX 白名单的条目标 `experimental: true`，默认 catalog/pack 都不含，只允许显式配置；核实后逐个放开。`zuban`（AGPL-3.0-only）永久默认排除。
8. **离线 pack 首发就提供，还是 P2 再做？**
   建议：P2。首发先把在线安装 + 系统 runtime 跑通；P1 支持 `lsp_install_dir` 指向预置目录（企业可手工预置），P2 再做带签名/SHA256 的官方 pack，避免首发就背上 pack 的签名、公证、增量更新成本。
9. **修复 job 的并发语义：复用现有 job，还是 `409`？**
   建议：**相同请求幂等复用，冲突请求 `409`**。同一 server 的相同 `(action, version)` 正在运行时返回现有 `job_id`（200，`deduplicated: true`）；不同版本/动作返回 `409 Conflict`，带 `existing_job_id` 与 `Retry-After`。server 按 server 名加锁，job 结束后释放，不排队多个安装。
10. **安装端点是否需要单独鉴权？**
    建议：默认仅 loopback 时复用现有 server 访问边界，但 `/v1/lsp/install|fix|uninstall|cancel` 必须校验来源（拒绝浏览器跨站简单请求，避免任意网页触发本地安装）；一旦 server 绑定非 loopback，必须要求 token，且默认关闭该绑定。

---

## 11. 附录：现状相关文件

| 文件 | 作用 |
| --- | --- |
| `admAgent/internal/lsp/manager.go` | 目录加载、黑名单、自动启动、状态、错误分类、冷却 |
| `admAgent/internal/lsp/client.go` | powernap client 封装、文件同步、诊断缓存、请求超时、重启/关闭 |
| `admAgent/internal/lsp/handlers.go` | workspace/configuration、applyEdit、registerCapability、diagnostics |
| `admAgent/internal/lsp/util/edit.go` | WorkspaceEdit 应用、偏移编码、行尾处理 |
| `admAgent/internal/agent/tools/lsp_*.go` | 8 个 LSP 工具 |
| `admAgent/internal/agent/tools/diagnostics.go` | 诊断等待、汇总、格式化、工具联动 |
| `admAgent/internal/agent/tools/lsp_helpers.go` | 路径边界、符号 grep→LSP 解析、WorkspaceEdit 文件收集 |
| `admAgent/internal/agent/coordinator.go` | LSP 工具注册条件 |
| `admAgent/internal/app/lsp_events.go` | 状态/诊断事件、每 workspace 隔离 |
| `admAgent/internal/server/proto.go` | LSP HTTP API |
| `admAgent/internal/proto/proto.go` | `LSPEvent`、`LSPClientInfo` |
| `src-tauri/src/pages/agent.rs` | 现状：`LSP_FIX_TABLE`、安装执行、PATH 复查（本方案不改，后续下线） |
| `src/views/agent/lsp_fix.js` | 现状：T1/T2/T3 修复、自动修复、启动轮询（本方案不改，后续改为调用 API） |
| `src/views/agent/tools.js` | 现状：LSP 面板、状态、修复/指引/AI 安装（后续改为消费 API 字段） |
| `src/views/agent/sse.js` | 现状：`lsp_event` 处理、自动修复入口（后续处理 `install_progress`/`job_finished`） |
| `doc/server-api.md` | LSP HTTP API（`state` 为 int；需补 `error_type` 与新增 `reason`/`fix`） |
| `doc/admAgent-server.md` | 服务端行为/边界（实施时补 LSP 托管运行时章节） |
| `doc/rust-backend.md` | 桌面端 Rust 命令地图（本方案不改；后续下线旧安装命令时更新） |
| `doc/frontend-agent-conventions.md` | Agent 视图交互（本方案不改；后续接入 API 时补 LSP 面板状态机） |
