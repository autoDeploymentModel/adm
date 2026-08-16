# ADM — Agent 指南

## 开发命令（始终使用 `pnpm`，不要用 `npm`/`yarn`）
- `pnpm tauri dev` — 热重载开发模式
- `pnpm tauri build` — 生产构建
- `pnpm tauri clean` — 清理构建产物
- `pnpm tauri:build:windows` / `:macos` / `:linux` — 跨平台构建
- `pnpm typecheck` — 前端类型检查（tsc --noEmit，只检查不产出，改完前端必跑）

### admAgent（Go，`admAgent/` 目录内执行）
- `go build ./...` — 编译检查
- `go test ./internal/... -count=1` — 全量单测（Windows 上 `internal/shell` 的 shebang 测试依赖 /bin/bash、`internal/server` 偶发 TempDir 文件锁抖动，属环境问题可忽略）
- `go test ./internal/agent/ -run 'TestName' -count=1` — 单个测试
- `build.ps1` — Windows 构建脚本；改完 Go 代码必须重新编译打包 sidecar 才在 ADM 里生效
- 运行时日志：`%LOCALAPPDATA%\admAgent\cache\server-tcp___127.0.0.1_<port>\admAgent.log`（每次启动一个目录，按 LastWriteTime 找最新；注意 Windows 目录列表可能显示 0 字节，直接读内容为准）。排查“对话突然中断”类问题 grep `Loop step response|ending turn|nudg`：`text_bytes=0` 但 `output_tokens` 很大 = 模型输出全部漏进 reasoning（典型为 localModel 在 40k+ 上下文下退化）

## 架构
- **Tauri 2.11.2** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口 SPA（单页应用）** + hash 路由：
  - `index.html`（外壳）含 `#view-root` 容器、底部硬件栏与导航。
  - 4 个视图（`model_list` / `model_image` / `settings` / `agent`）各自为独立 **ES 模块**（`src/views/*.js`），默认导出 `{ template, mount(root, params), unmount() }`。模型运行后「查看模型」直接用系统浏览器打开 WebUI（`window.openUrl`），不再有 chat 视图。
  - `agent` 视图已拆分：`src/views/agent.js` 为入口（init/bindEvents/生命周期），具体逻辑在 `src/views/agent/` 子模块（store/template/api/utils/ui/render/session/attach/send/sse/permission/tools/model/workspace/settings_dialog）；跨模块共享状态由 `store.js` 统一管理（`store` 为写入入口，`S` 为只读视图，workspace 字段禁止直接写 `S`）。
  - `index.html` 通过动态 `import()` 异步加载视图模块，把 `template`（含 `<style>` 的 HTML 字符串）注入 `#view-root`，调用 `mount`/`unmount` 管理生命周期。
- CSS/JS **内联**在每个视图模块的 `template` 字符串或模块函数内，保持零运行时依赖。
- **样式隔离约定**：全局 reset（`* {}`）与 `body` 样式只由 `index.html` 壳层提供，视图内不得重复定义；视图选择器带视图前缀（`agent-*` / `settings-*` 等）；视图内元素 id 不得与壳层 id（`app` / `view-root` 等）重复。
- **类型检查**：`jsconfig.json` 开启 `checkJs`，全局类型声明在 `src/types.d.ts`；历史视图暂以 `// @ts-nocheck` 豁免，新代码不得新增此标记（用 JSDoc 注解）。未配置 linter、formatter 或测试框架。

## IPC 注意事项（重要）
- SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke` / `.event.listen`，无需 `postMessage` 代理。
- `index.html` 初始化时把 `window.__adm_invoke` / `window.__adm_listen` 暴露给所有视图模块；视图模块通过这两个全局引用调用 IPC。
- **共享状态** `window.__adm_state`（systemInfo / runningModelId / modelList 等）跨视图共享，切换不丢。
- 视图 `mount` 时 `listen()` 保存 unlisten 句柄，`unmount` 时统一调用以防事件重复绑定（泄漏）。
- **Agent 页面**（`src/views/agent.js`）为独立 ESM 视图，由路由 `#/agent` 加载，不再使用 iframe / PTY 终端。
- 子页面 → 父窗口导航：使用 `location.hash = "#/list"` 等 hash 路由。

## 前端错误处理（Agent 视图，`src/views/agent/`）
- **统一提取**：所有服务端错误（API invoke 抛错、SSE 事件内嵌 error）先用 `error.js` 的 `getErrorMessage()` 提取可读文本（兼容 string / Error / `{"error":{"message","type"}}` / 其它对象），再用 `classifyError()` 分类（quota/timeout/network/not_found/cancel/unknown）。
- **统一展示入口**：错误统一走 `ui.js` 的 `reportError(err, { prefix, hint })`，内部自动提取+分类：quota（401/余额/授权）类直接显示"余额不足，任务中断"，其余显示原始错误；三档 UI 为 `showNotice(msg, level)`（error 红 / warn 黄 / info 灰），消息区节点 3s 自动消失，`showError/showWarning/showInfo` 是薄封装。
- **禁止** `showError("前缀: " + e)` 直接拼接错误对象（对象会显示 `[object Object]`）；应把**原始错误**传给 `reportError(e, { prefix })`。本地状态提示（无服务端错误对象，如"文件过大"、轮数上限）才直接用 `showError/showWarning` 字符串。
- **SSE 错误路径**：`run_complete` / `agent_event` 内嵌 error 均走 `reportError`，不要在 sse.js 里自行实现 formatRunError/isQuotaError（已在统一模块）。
- **假完成/静默停止检测**（`sse.js` `detectFakeCompletion`）：本轮有 edit/write/multiedit/bash/lsp 等副作用工具调用、但工具调用总数 ≤4、且 prompt 含操作动词（部署/修复/重构…）时，`showWarning` 提示"任务可能未完整执行"（服务端重试耗尽后 run_complete 无 error 静默结束的兜底）。
- **自动续跑进度判定**（`autocontinue.js` `maybeAutoContinue(data, runStats)`）：本轮有 edit/write/bash 等实质副作用工具**成功落地**（`runStats.sideEffectSuccess > 0`）视为有进展、不计无进展，避免"模型在干活但没标 todos"被误熔断。

## 附件粘贴（跨平台差异，`agent.js` paste 事件 + `agent.rs` read_clipboard_files）
- **根源是 WebView 内核与剪贴板格式不同**，必须两端各留一条"读系统剪贴板"的兜底，否则该平台粘贴文件失效：
  - **Windows（WebView2/Chromium）**：复制文件时剪贴板为 `CF_HDROP`（无文本），但 Chromium 会把文件暴露成 DataTransfer 的非图片 file 项 → 前端 `hasFileItem` 命中即同步 `preventDefault`，再由 Rust 读 `CF_HDROP`（`windows` crate）。
  - **macOS（WKWebView）**：Finder 复制文件时剪贴板只有 `public.file-url` / `NSFilenamesPboardType`（**无 text/plain 路径**，实测 `pbpaste` 为空），且 WKWebView **不**把文件暴露给 DataTransfer（items/files 全空、无 uri-list）→ 前端靠 `clipItems.length === 0` 兜底触发 `read_clipboard_files`；Rust 侧用 `objc2-app-kit` 的 `NSPasteboard`：先读 `NSFilenamesPboardType`（路径数组），兜底逐条读 `public.file-url` 剥掉 `file://` 前缀（多选文件时每个文件一个 item）。依赖挂在 `[target.'cfg(target_os = "macos")'.dependencies]`。
  - **Linux**：`read_clipboard_files` 返回空数组（未实现）。
- **前端兜底链顺序**（`src/views/agent.js` 粘贴处理）：①剪贴板图片直读 blob → ②`text/uri-list` 路径（`parseUriListPaths`）→ ③`text/plain` 且 `looksLikeFilePath` 才当路径（**普通文本粘贴禁止误判**，多行需每行都像路径）→ ④`cd.files` 带 `.path`（WebView2 注入）→ ⑤`read_clipboard_files`（触发条件 `hasFileItem` **或** `clipItems.length === 0`；macOS 无内容可插入故无需 preventDefault，Windows 需同步拦截防路径文本残留）。
- **macOS 新增后端逻辑时注意**：NSPasteboard 的 extern 静态（`NSFilenamesPboardType`/`NSPasteboardTypeFileURL`）访问需 `unsafe` 块；`NSFilenamesPboardType` 已废弃（`#[allow(deprecated)]`）但仍是多文件权威来源；`DowncastTarget` 不支持泛型 `NSArray<NSString>`，需 downcast 成 `NSArray` 再逐元素 `downcast_ref::<NSString>`。
- **验证方法**：`osascript -e 'tell application "Finder" to set the clipboard to (POSIX file "/tmp/x")'` 模拟复制文件，`pbpaste` 应输出空（证明无文本类型），Swift 小程序列 `NSPasteboard` 类型确认；Rust 侧可直接给 `read_clipboard_files` 写临时 `#[cfg(test)]` 单测验证（验证后删除，勿污染 CI）。

## Rust 后端（`src-tauri/src/`）
| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`, `check_update`, `download_and_extract_llamacpp` |
| `model_list.rs` | `fetch_model_list`, `scan_local_models`, `download_model`, `start_model`, `stop_model`, `get_model_status` |
| `settings.rs` | `save_settings`（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_llamacpp_version` |
| `model_image.rs` | `check_sd_exists`, `download_and_extract_sd`, `start_sd_generation`, `stop_sd` |
| `agent.rs` | `start_agent_server`, `stop_agent_server`, `get_agent_server_status`, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `check_adm_agent`, `get_adm_agent_version`, `add/list/update/delete_cloud_provider` |

## 关键注意事项
- **MTP 自动检测**：如果模型文件名包含 "mtp"（不区分大小写），`start_model` 会自动追加 `--spec-draft-n-max 2 --spec-type draft-mtp`。设置 `params.spec_type = "none"` 可禁用。
- **HuggingFace 镜像**：`download_model` 会自动将所有 `huggingface.co` 链接替换为 `hf-mirror.com`。
- **断点续传**：使用 `.part` 后缀 + HTTP `Range` 头；`scan_part_files` 列出未完成的下载。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。
- **更新流程**：启动后延迟 3 秒 → 应用更新 → VC++ 运行库（仅 Windows）→ llamacpp 下载。admAgent 不再运行时下载/升级，随安装包内置（见下）。
- **admAgent 内置分发**：编译好的 admAgent 压缩包放在 `buildAgent/`（`admAgent_{ver}_Windows_x86_64.zip` / `admAgent_{ver}_Darwin_arm64.tar.gz`）。`beforeDevCommand`/`beforeBuildCommand` 运行 `scripts/prepare-agent-binary.mjs`：按构建目标自动选包、解压到临时目录、把二进制放到 `src-tauri/binaries/admAgent-<target-triple>`（git 忽略），再由 `bundle.externalBin`（sidecar）打进安装包。运行时路径：Windows 为 ADM.exe 同目录的 `admAgent.exe`，macOS 为 `ADM.app/Contents/MacOS/admAgent`；macOS 启动时会清理旧版下载模式遗留在 app_data_dir 的 admAgent。
- **窗口关闭**：`on_window_event` 通过 `taskkill /F`（Windows）或 `kill -9` 杀死 llama-server 和 admAgent server。
- **Agent server 模式**：admAgent 以子进程 `server` 命令启动（不传 `--host`，服务端绑定平台默认本地传输：macOS/Linux 为 Unix socket、Windows 为 named pipe，不占 TCP 端口）。多客户端共享：先探测默认传输地址是否已有 server 在跑，有则直接复用不 spawn。就绪检测通过轮询 `GET /v1/health`（15 秒超时），stdout/stderr 仅做日志转发。HTTP API 通过 `agent_http_request` 代理（hyper 直连 socket/pipe），SSE 事件通过 Tauri event `agent-sse-event` 转发给前端。
- **多 workspace 并发架构**：单 admAgent server 进程支持多个 workspace 同时干活。每个 workspace 有独立的 `AgentCoordinator`/SQLite DB/SSE 转发任务。Rust 后端 `AppState.agent_sessions: HashMap<String, AgentServerSession>` 按 workspace_id 索引各会话，`agent_child` 全局共享子进程，`active_workspace_id` 跟踪当前 tab。前端 `S.workspaces[wsId]` 状态池存各 workspace 的会话/消息/运行状态，切换 tab 时保存当前+恢复目标，不中断旧 workspace 的 agent run。SSE 事件携带 `workspace_id`，前端只处理当前激活 tab 的事件。微信 Bot 跟随当前激活 tab 路由消息。
- **Agent loop 抖动恢复体系**（`admAgent/internal/agent/agent_loop_llm.go`）：空 stop 重试（上限 3）、叙述性 stop 重试、推理超限（软阈值按 reasoning_effort 分档，丢弃+nudge+重试 1 次）、未完成 todos nudge（**进度感知**：连续 3 次无进展才放弃，有进展（todo 完成或 edit/write/bash 等实质副作用工具成功）即清零计数，硬熔断总上限 10 次）、假完成检测。重试耗尽后本轮**无 error 静默结束**（run_complete 不带错误），UI 侧表现为“突然停了”。
- **Plan 模式 = 纯规划**：工具白名单（`config.ResolvePlanModeTools`）只含只读工具，**不含 edit/write/download/todos/MCP**；bash 在工具内部按只读命令白名单校验；计划以正文文本输出，todo 追踪只属于执行模式；todo-nudge 在 todos 工具不在目录时自动跳过。
- **前端自动续跑**（`src/views/agent/autocontinue.js`）：本轮正常结束但 todos 未完成时自动发“继续”开新轮（每轮重置服务端 nudge 预算）；上限 10 轮、连续 2 轮无进展自动停；仅续跑本客户端发起的任务；Plan 模式、出错、取消、切走会话均不触发；开关存 localStorage（`agent_auto_continue`，默认开）。
- **Agent 设置**：`agent_plan_mode` / `agent_default_provider` / `agent_reasoning_effort` / `agent_temperature` / `debug_logging` 存储在 `config.json`（Settings 结构体），前端通过 `load_settings` / `save_settings` 读写。
- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。

## 构建与发布
- CI：`.github/workflows/build.yml` — 标签触发（`v*`），构建 Windows + macOS，自签名。
- 发布：`pnpm tauri:build:<平台>` 然后 `pnpm sign:<平台>`。
- 图标：`python scripts/generate-icons.py` 从 `src-tauri/icons/source.png` 生成。

## 注意事项
- admAgent api文档在 `doc/server-api.md`
- llama-server cli 启动参数文档  windows在`doc/llamacpp.txt`，  macos在 `doc/llamacpp-macos.txt`
- admAgent 源码在 `admAgent` 目录下，有不清楚的地方可以直接搜索源码确定后再决定怎么改，admAgent源码目录只能读，不能有任何修改和写入动作，如果真的发现是admAgent的问题，先列出问题和需要改动的地方给我审核
- **改动必须区分桌面端和 TUI**：每次改动前必须先告知用户改动目标是桌面端（`src/` + `src-tauri/`）还是 TUI 端（`admAgent/`），未经明确指示不混改两端。
- **项目结构**：
  - `admAgent/` — Go TUI（Bubbletea/lipgloss/ultraviolet）+ 共享后端服务器（Go），两个前端共用此 server
  - `src/` + `src-tauri/` — Tauri 桌面端（vanilla JS 前端 + Rust 后端）
  - `buildAgent/` — 构建工具
  - `website/` — 营销网站
  - `scripts/` — 工具脚本
- **工作目录切换功能仅桌面端**：TUI 只显示当前工作目录（PrettyPath），不做切换/下拉/添加/删除。所有工作目录切换 UI 在桌面端实现。
- **调试日志统一写入 `adm_api_debug.log`**：复杂问题排查需要日志时，Rust 端用 `api_debug_log!`，前端 JS 用 `invoke("agent_debug_log", { line: "..." })`，统一写入 `~/Library/Application Support/com.adm.admapp/adm_api_debug.log`（macOS）或 `%LOCALAPPDATA%\com.adm.admapp\adm_api_debug.log`（Windows）。日志必须带类型标记便于过滤：
  - `UI:` 前缀 — 前端 JS 日志（SSE 事件过滤、状态变更、消息处理等）
  - `HTTP >` / `HTTP <` — HTTP 请求/响应
  - `SSE =` / `SSE !` — SSE 连接/断开
  - `< message created` / `< run_complete` / `< agent_event` — SSE 事件转发
  - `UpdateModels:` / `readyWg:` — admAgent 服务端诊断日志
  日志格式：`{epoch_ms} {HH:MM:SS.mmm 本地时间} {类型标记} {内容}`，由 Rust 端统一格式化。调试模式开关：设置→调试模式（`config.json` 的 `debug_logging` 字段）。