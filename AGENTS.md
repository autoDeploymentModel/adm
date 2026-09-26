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
- 运行时日志：`%LOCALAPPDATA%\admAgent\cache\admAgent.log`（Windows）/ `~/.cache/admAgent/admAgent.log`（macOS、Linux）。单文件、每次启动截断重写（`GlobalLogPath()`），直接读内容为准；注意 Windows 目录列表可能显示 0 字节。排查“对话突然中断”类问题 grep `Loop step response|ending turn|nudg`：`text_bytes=0` 但 `output_tokens` 很大 = 模型输出全部漏进 reasoning（典型为 localModel 在 40k+ 上下文下退化）

## 架构
- **Tauri 2.11.5** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口 SPA（单页应用）** + hash 路由：
  - `index.html`（外壳）含 `#view-root` 容器、底部硬件栏与导航。
  - 4 个视图（`model_list` / `settings` / `agent` / `skills`）各自为独立 **ES 模块**（`src/views/*.js`），默认导出 `{ template, mount(root, params), unmount() }`。模型运行后「查看模型」直接用系统浏览器打开 WebUI（`window.openUrl`），不再有 chat 视图。
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
- **模型不支持关闭思考**（`error.js` 的 `ERROR_THINKING_UNSUPPORTED`）：provider 同时拒绝 `reasoning_effort:none` 与 `thinking.disabled` 时，admAgent 返回 400，文案以 **`thinking_mode_unsupported`** 开头（前后端契约 token，`internal/llm/client.go` 产出、`client_test.go` 锁定，改文案须保留）。桌面端按该 token 分类（早于 network 匹配——被包裹的 provider 原文含 "Upstream request failed"），提示"本模型不支持关闭思考，请切回思考模式"并**中断本轮**；既不自动恢复默认档，也不静默去掉参数继续跑。
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

## PDF 附件（桌面端：分批转图片，`src/views/agent/pdf.js` + `pdf_batch.js` + `src/vendor/pdfjs`）
- **方案**：不用系统内置 PDF 查看器（WebView2/WKWebView 的 PDF 组件不可脚本化、拿不到像素），改为内置 pdf.js 按批渲染 JPEG，复用现有图片附件管线（`send.js` base64 内联 → 主模型支持图片则当轮内联，否则服务端调 vision 识别）。服务端零改动；**无页数硬上限**。
- **必须前端转换**：直接把 `application/pdf` 传给服务端会命中错误矩阵 #1"不支持"（`attachment_ingest.go` 只认 text mime 与 `image/*`）；且服务端 `view` 工具明确拒绝图片（`view.go`），模型无法自行取页 → 后续批次必须由客户端主动推送。
- **三段式流程**：① 附加时只登记（`attach.js` `addPdfPending`：解析页数，预览显示 "文件 · N 页"，不渲染）；② 发送时只转换首批并随消息发出（`send.js`，消息正文自动附分批说明，>50 页弹确认卡）；③ 每批 run_complete 后由 `pdf_batch.js` 批次泵自动转换发送下一批，直到发完。
- **批大小**：视觉主模型 `PDF_BATCH_VISION=10` 页/批；非视觉主模型 `PDF_BATCH_TEXT=5` 页/批（服务端单轮图片识别上限 `maxImagesPerTurn=5`，超出会被标注"未识别"），并扣除本轮其它图片附件数量；主模型能力取 `S.agentInfo.model.supports_images`，快照未就绪按 5 保守处理。
- **安全阀**：总页数 > `PDF_CONFIRM_PAGES=50` 时发送前弹确认卡（显示份数/批次数）；批次数 > `PDF_MAX_BATCHES=100` 直接拒绝；单页最长边 2048px / JPEG q0.85。
- **终止条件**（`sse.js` run_complete 钩子 → `pdf_batch.onRunComplete`）：本轮出错/取消/步数触顶、切换会话、点进度提示上的"停止后续批次"均终止剩余批次；`expectedRunId` 保证只在本批次 run 完成时推进（手动消息的完成事件不会误触发）。
- **目标固定与恢复**：批次发送前校验目标会话/工作区未变化（`sendMessageWithFiles(text, files, target)` → `sendText(expectedTarget)`，变则返回 `target_changed` 并终止剩余批次，防止转换期间切换会话把批次发进错误会话）；`reconcilePdfBatching()` 在视图挂载（`agent.js` init）、切回工作区（`workspace.js switchToWorkspace`）与 run_complete 兜底（`sse.js`）三处按服务端 `is_busy` 对账——仍忙等事件、已空闲续跑（页面切走/切工作区 tab 期间事件会丢）、目标会话已切换则终止。
- **pdf.js 使用要点**：worker / cmaps / standard_fonts URL 必须用 `import.meta.url` 绝对化（worker 内 fetch 以 worker 位置为基准）；`getDocument` 返回 loadingTask，销毁调用 `loadingTask.destroy()`（v6 已移除 `doc.destroy`）；加密/损坏分别抛 `PasswordException`/`InvalidPDFException`（`friendlyPdfError` 统一转提示）。批次泵的发送函数由 `agent.js` 注入（`initPdfBatching(sendMessageWithFiles)`），避免与 send.js 循环依赖。
- **升级路径**：从 https://github.com/mozilla/pdf.js/releases 取 legacy dist，用 build 下的 min 版 `pdf.min.mjs`/`pdf.worker.min.mjs`（或 npm `pdfjs-dist/legacy/build/`）+ `web/cmaps/` + `web/standard_fonts/` + LICENSE 覆盖 `src/vendor/pdfjs/`（该目录已被 `jsconfig.json` exclude，不参与类型检查）。

## Rust 后端（`src-tauri/src/`）
| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`, `check_update`, `download_and_extract_llamacpp`, `reinstall_llamacpp`（设置页「重新安装」：先删 llamacpp 目录再重新下载，复用升级的下载/解压逻辑，不比较版本号） |
| `model_list.rs` | `fetch_model_list`, `scan_local_models`, `download_model`, `start_model`, `stop_model`, `get_model_status` |
| `docker_model.rs` | `check_docker_env`, `check_docker_image`, `get_docker_tasks`, `setup_docker_model`, `start_docker_model`, `stop_docker_model`, `delete_docker_image` |
| `settings.rs` | `save_settings`（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_llamacpp_version` |
| `agent.rs` | `start_agent_server`, `stop_agent_server`, `get_agent_server_status`, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `check_adm_agent`, `get_adm_agent_version`, `add/list/update/delete_cloud_provider` |

## 关键注意事项
- **MTP 自动检测**：如果模型文件名包含 "mtp"（不区分大小写），`start_model` 会自动追加 `--spec-draft-n-max 2 --spec-type draft-mtp`。设置 `params.spec_type = "none"` 可禁用。
- **VC++ 运行库检测（Windows）**：`check_vc_redist_installed`（`index.rs`）以 DLL 实检为准——`C:\Windows\System32` 或可执行文件同目录下必须同时存在 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll`。**不要改回注册表判断或只查 `vcruntime140.dll`**：旧版 2015/2017 运行库同样写 `Installed=0x1`，会把缺 `vcruntime140_1.dll` 的机器误判为已安装。调用点：启动检测（`check_update`；网络失败时前端改走独立命令 `check_vc_redist`）、点「安装完成」后的复验，以及 `start_model` / `get_llamacpp_version` 拉起进程前的预检——缺失时直接返回错误、**不 spawn**（否则 Windows 加载器会弹「找不到 VCRUNTIME140_1.dll」系统错误框并把进程卡住，`spawn()` 本身不报错）。
- **HuggingFace 镜像**：`download_model` 会自动将所有 `huggingface.co` 链接替换为 `hf-mirror.com`。
- **断点续传**：使用 `.part` 后缀 + HTTP `Range` 头；`scan_part_files` 列出未完成的下载。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。
- **更新流程**：启动后延迟 3 秒 → 应用更新 → VC++ 运行库（仅 Windows）→ llamacpp 下载。admAgent 不再运行时下载/升级，随安装包内置（见下）。
- **admAgent 内置分发**：admAgent 本地编译（`admAgent/build.ps1` / `build.sh`）产出的压缩包（`admAgent_{ver}_Windows_x86_64.zip` / `admAgent_{ver}_Darwin_arm64.tar.gz`）直接写入 `adm-binaries/`（二进制仓库，与 admAgent 共用同一本地 clone）。`beforeDevCommand`/`beforeBuildCommand` 运行 `scripts/prepare-agent-binary.mjs`：按构建目标在 `adm-binaries/` 下选版本号最大的包、解压到临时目录、把二进制放到 `src-tauri/binaries/admAgent-<target-triple>`（git 忽略），再由 `bundle.externalBin`（sidecar）打进安装包。运行时路径：Windows 为 ADM.exe 同目录的 `admAgent.exe`，macOS 为 `ADM.app/Contents/MacOS/admAgent`；macOS 启动时会清理旧版下载模式遗留在 app_data_dir 的 admAgent。`adm-binaries/` **不入库**（.gitignore）：推送用 `pnpm agent:push`（转发 `adm-binaries/push.mjs`，每次以单个提交强制覆盖远端，历史不堆积旧二进制）；CI 构建时自动 checkout 该仓库到 `adm-binaries/`。
- **窗口关闭**：`on_window_event` 通过 `taskkill /F`（Windows）或 `kill -9` 杀死 llama-server 和 admAgent server。
- **Agent server 模式**：admAgent 以子进程 `server` 命令启动（不传 `--host`，服务端绑定平台默认本地传输：macOS/Linux 为 Unix socket、Windows 为 named pipe，不占 TCP 端口）。多客户端共享：先探测默认传输地址是否已有 server 在跑，有则直接复用不 spawn。就绪检测通过轮询 `GET /v1/health`（15 秒超时），stdout/stderr 仅做日志转发。HTTP API 通过 `agent_http_request` 代理（hyper 直连 socket/pipe），SSE 事件通过 Tauri event `agent-sse-event` 转发给前端。
- **多 workspace 并发架构**：单 admAgent server 进程支持多个 workspace 同时干活。每个 workspace 有独立的 `AgentCoordinator`/SQLite DB/SSE 转发任务。Rust 后端 `AppState.agent_sessions: HashMap<String, AgentServerSession>` 按 workspace_id 索引各会话，`agent_child` 全局共享子进程，`active_workspace_id` 跟踪当前 tab。前端 `S.workspaces[wsId]` 状态池存各 workspace 的会话/消息/运行状态，切换 tab 时保存当前+恢复目标，不中断旧 workspace 的 agent run。SSE 事件携带 `workspace_id`，前端只处理当前激活 tab 的事件。微信 Bot 跟随当前激活 tab 路由消息。
- **Agent loop 抖动恢复体系**（`admAgent/internal/agent/agent_loop_llm.go`）：空 stop 重试（上限 3）、叙述性 stop 重试、推理超限（软阈值按 reasoning_effort 分档，丢弃+nudge+重试 1 次）、未完成 todos nudge（**进度感知**：连续 3 次无进展才放弃，有进展（todo 完成或 edit/write/bash 等实质副作用工具成功）即清零计数，硬熔断总上限 10 次）、假完成检测。重试耗尽后本轮**无 error 静默结束**（run_complete 不带错误），UI 侧表现为“突然停了”。
- **空正文看门狗 + empty_output**：step 流式输出只有 reasoning、无正文/工具调用时——每 60s 推一次 `agent_event type=thinking`（progress 带已思考秒数，前端 `showInfo` 提示"模型仍在思考…"）；持续满 120s 触发 `errOutputDegraded`（nudge 重试 1 次，再满 120s 结束本轮）。本轮正常结束但无任何输出（正文与工具调用皆无，或 assistant 消息被丢弃）时 `run_complete` 携带 `empty_output: true`，前端提示"模型未产生有效输出"且不自动续跑。
- **Plan 模式 = 纯规划**：工具白名单（`config.ResolvePlanModeTools`）只含只读工具，**不含 edit/write/download/todos/MCP**；bash 在工具内部按只读命令白名单校验；计划以正文文本输出，todo 追踪只属于执行模式；todo-nudge 在 todos 工具不在目录时自动跳过。
- **决策输出模式（服务端，可选）**：`POST /v1/workspaces/{id}/agent` 可带 `decision: {mode: auto|choice|bool|score, tool_policy: none, structured_output: auto|off}`（`proto.DecisionSpec` → `agent.WithDecisionSpec(ctx)` → `SessionAgentCall.Decision`）。带该字段的轮次走**独立旁路** `internal/agent/decision_turn.go`：契约系统提示词由 `internal/decision` 注入（不进用户消息/历史/标题），不注册工具、不进主循环的 nudge/看门狗，单次请求 + 失败一次定向重试；`structured_output=auto` 时附带 `response_format` json_schema（`internal/llm` 探针：被拒即不带该字段重试一次并按 `baseURL+model` 缓存）。校验通过的结果写入**专用 ContentPart** `{"type":"decision","data":{kind,mode,reason,selected,candidates,value,score,min,max,level,raw}}` 并把正文里的 JSON 剔除（`message.DecisionContent` / `SetDecisionResult`；part 插在 finish 之前）；**新增 part 类型必须同时登记四处**：`internal/message`（存储 `partType`）、`internal/proto/message.go`（wire 白名单 + MarshalParts/UnmarshalParts）、`internal/server/events.go` 的 `messageToProto`（SSE 与 `/messages` 共用）、`internal/workspace/client_workspace.go` 的 `protoToMessage`（客户端模式 proto→message，漏登记会静默丢弃）——前者漏登记表现为"服务端成功但前端拿不到 part"，另两处漏登记表现为 TUI/`adm session show` 看到空消息或 `unknown` part；`internal/cmd/session.go` 的 `convertParts` 决定终端展示；两次校验不过则 `run_complete.error = invalid decision output…`。分派点 `internal/agent/agent.go:1090` 的 4 行 if/else，`agent_loop_llm.go` **零改动**；省略字段 = 普通对话，TUI 忽略未知 part 不受影响。桌面端只发字段并优先按 part 画卡片（`src/views/agent/decision_mode.js`、`render.js`），决策轮不走折叠插入（强制排队）。决策轮**在服务端强制关闭推理**（`decision_turn.go` 固定 `reasoning_effort: none`、不带 `Thinking` 对象，不读 model 配置里的 thinking 开关；provider 两种写法都拒时 `llm.ThinkingModeUnsupported` → 去掉参数重试同一请求），因此决策模式**不改写**用户的全局推理设置——切会话/切模式都只影响那一轮。**上下文回灌**：决策结果以**不含 JSON、不含标签的自然语言脚注**写回只发模型的 wire 历史（`message.ContextText`：`Note on my earlier reply: I picked "X" out of … My reasoning at the time: … If the user follows up on that, keep answering consistently with it.`），让后续追问仍能引用上一轮决策。这一步不能省——P2 起决策正文已被剥空，`decision` part 对模型不可见，不回灌模型就失忆；但**形态本身就是历史教训**：早期写 `[decision result (kind)] {json}`，再改成"这是数据不是输出格式"的免责句，弱模型/长上下文下都照样把它当输出格式照抄进普通对话正文，前端于是冒出一段带决策标签的裸 JSON。模型会模仿它在历史里读到的形状，所以只保留散文，**任何 JSON / 标记 / 输出格式字样都不要加回来**（`decision_part_test.go` 有反向断言锁住）。桌面端不再把正文里的回灌痕迹当决策结果画卡片（`render.js` 的 `textDecisionState` 只认 `<adm_decision_result>` 协议标签与 `decision` part）；`decision_mode.js` 的 `decisionReplayFromText` 仅用于清理**旧版本已落库**的污染消息（剥掉标记与 JSON、保留前后正文），新消息不会再命中，`hasDecisionSyntax` 也不再把该标记算作决策轮（否则会让普通轮误判并隐藏中间过程输出）。方案与阶段划分见 `doc/agent-decision-mode-server-plan.md`。
- **前端自动续跑**（`src/views/agent/autocontinue.js`）：本轮正常结束但 todos 未完成时自动发“继续”开新轮（每轮重置服务端 nudge 预算）；上限 10 轮、连续 2 轮无进展自动停；仅续跑本客户端发起的任务；Plan 模式、出错、取消、切走会话均不触发；开关存 localStorage（`agent_auto_continue`，默认开）。
- **拖拽选择保护 / 主线程停顿看门狗**（桌面端）：在消息区按住左键拖拽选择文字期间，`render.js` 的 `beginSelectGuard` 暂停流式 DOM 写入与自动滚底（`renderMessages` 只置待渲染标记、`scrollChatToBottom` 直接返回），抬键（window 捕获 mouseup）/失焦/10s 超时后补渲染一次；消息区 `dragstart` 拦截“从已有文字选区发起的原生拖拽”（图片除外）。原因：WebView2/Chromium 在拖拽选择期间变更 DOM + 程序化 scrollTop 有触发输入卡死的已知回归（crbug 559347435 / 559795247 / 41327805）。`agent.js` 的看门狗每秒采样定时器漂移，>2s 记 `PERF` 调试日志：界面无响应但无停顿记录 = WebView2 输入卡死（上游问题，需更新运行时），有记录 = 前端长任务阻塞。
- **Agent 设置**：`agent_default_provider` / `agent_thinking_enabled` / `agent_reasoning_effort` / `agent_temperature` / `debug_logging` 存储在 `config.json`（Settings 结构体），前端通过 `load_settings` / `save_settings` 读写。设置面板把思考开关与推理强度**合并为一个「推理强度」下拉**（`关闭 / low / medium / high`）：选「关闭」= `agent_thinking_enabled=false` → 发 `reasoning_effort: none`（保留原档位，切回具体强度即恢复），其余档位为 `agent_thinking_enabled=true` + 对应 effort；转换在 `utils.js` 的 `reasoningSettingValue` / `applyReasoningSetting`。桌面端固定 yolo（执行）模式，不再提供 Plan 模式开关。
- **网络代理链路**（设置→网络代理，仅影响 admAgent，桌面端下载不走代理）：
  1. 前端 `settings.js` `saveProxy()` 校验（启用时 url 必填、须以 `http(s)://` 或 `socks5://` 开头）→ `save_settings` 写入 config.json 的 `agent_proxy`。
  2. Rust `settings.rs:37` 调用 `agent.rs` `sync_agent_proxy`：`write_agent_proxy`（`agent.rs:640`）把 `{enabled,url}` 写入 admAgent.json 顶层 `agent_proxy`（原子写，值未变返回 false 跳过）→ 有变更时对当前 active workspace `POST /v1/workspaces/{ws}/config/set` 触发服务端**磁盘全量重载**（10s 超时，失败仅记日志退回直连）。
  3. admAgent `ConfigStore.setConfig` 把代理同步到进程级 `httpproxy`（`internal/config/store.go:100-105`）；`httpproxy.ProxyFunc()` 作为 `Transport.Proxy` 回调**每次请求实时读取**状态，热重载即刻生效、无需重建 client/重启 server；本地/私网地址（127.0.0.1、LAN GPU 盒）自动绕过（`internal/httpproxy/proxy.go:50-81`）。
  4. **生效范围**：LLM 客户端（`llm/client.go:107`）+ Agent 网络工具 fetch/web_fetch/download/web_search/sourcegraph/agentic_fetch（全部经 `SharedHTTPTransport`，`tools/fetch_helpers.go:38-48`）；**MCP HTTP/SSE 传输不走**（`mcp/init.go:538-581` 用 `http.DefaultTransport`，只认 `HTTP_PROXY` 环境变量）。注意：面板文案"仅影响 LLM 请求"比实际范围窄，工具类请求同样走代理。
- **图片生成模型运行要求（硬性）**：仅 Windows + NVIDIA 显卡可运行 —— Docker Desktop 的 GPU 直通依赖 WSL2 + nvidia-container-toolkit，macOS 无法把独显直通给容器、Linux 未适配、AMD / Intel / 核显无镜像支持。判定分三层：`docker_model::requirement_reason()`（平台 + NVIDIA 显卡/驱动，看 `nvidia-smi` 能否枚举到显卡，`get_gpu_devices()` 兜底区分"无卡 / 无驱动"）、`nvidia_runtime_reason()`（引擎就绪后查 `docker info` 的 `nvidia` runtime）、`check_docker_env` 把结果作为 `supported` / `unsupported_reason` 返回。前端 `model_list.js` 据此置灰卡片（显示原因 + 禁用下载/启动按钮；环境存共享状态 `dockerEnv`，`refreshDockerEnv()` 在 init、镜像下载成功、下载/启动失败后刷新）；`setup_docker_model`（拉镜像前）与 `start_docker_model` 各再拦一次，避免白下几十 GB 镜像后只看到"容器已退出"的模糊报错。
- **图片生成模型（docker 部署）**：`model_list.json` 的 `model_images` 有值时走 docker 流程（无值则保持原有 gguf 下载/llama-server 启动流程）：
  1. `check_docker_env` 探测 docker CLI（PATH → `%ProgramFiles%\Docker\Docker\resources\bin\docker.exe` / `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`，macOS 为 `/usr/local/bin`、`/Applications/Docker.app/...`；装完 Desktop 后当前进程 PATH 不会自动刷新，必须探测路径）→ 未安装则按平台下载官方稳定版安装包（win：`desktop.docker.com/win/main/{amd64,arm64}/Docker Desktop Installer.exe`，mac：`desktop.docker.com/mac/main/{arm64,amd64}/Docker.dmg`）→ Windows 先试 `install --quiet --accept-license --user`（免 UAC），失败再退回全局安装；macOS 走 `hdiutil attach` + `cp -R` 到 `/Applications`。
  2. 启动容器前自动拉起引擎：`docker info` 探测 → 不通则启动 Docker Desktop（`Docker Desktop.exe` / `open -a Docker`）并轮询等待（180s）。
  3. 拉镜像进度：`docker manifest inspect --verbose <image>` 取各层压缩大小（层短 digest 前 12 位匹配），叠加 `docker pull` 的 "Download complete/Pull complete/Already exists" 状态行算百分比（**非 TTY 下 docker pull 不输出字节进度**，只能按层完成度估算）；镜像仓库需登录时（ACR 私有库）报错文案里给出 `docker login <registry>` 指引。
  4. 容器固定名 `adm-<model_id>`，端口 `64646:8188`（宿主 0.0.0.0:64646 → ComfyUI 8188），输出/输入/用户目录挂到 `data_dir/comfyui/{output,input,user}`；启动前已确认 `nvidia` runtime 存在（见上方运行要求），因此一律加 `--gpus all`（代码里仍保留条件判断）。
  5. **不置位 `model_running`**（那是「LLM 已就绪」的全局标志，图片模型置位会让 Agent 页误判）；运行状态记在 `running_kind=Some("docker")` + `running_container`，`get_model_status` 对 docker 类型改用 `docker inspect -f {{.State.Running}}`；「查看模型」按 `running_port=64646` 用系统浏览器打开。
  6. 进度事件 `docker-progress {model_id, stage, progress, message}`（stage: check/download-desktop/install-desktop/start-daemon/pull/start/done），`get_docker_tasks` 供视图重载后恢复按钮进度；启动/停止复用 `model-started`/`model-stopped` 事件（`model-started` 带 `port`）。
  7. **取消长任务 / 子进程生命周期**：`docker pull` 是独立子进程，不主动清理会在应用退出后继续下载。三条保障：①`AppState.docker_cancels`（model_id → `DockerCancel { token, flag }`，任务启动时注册、结束时**按 token 注销**——同一 model 上重叠任务（取消后立刻重下）的收尾不会抹掉新任务的标志；子进程记录按 pid 比对注销）供各阶段循环（安装包下载 / `wait_daemon` / `pull_image` / `wait_http_ready`）检查取消；②`AppState.docker_children` 登记长任务子进程 PID（`run_streaming` 里 `register_child`），`cancel_docker_task` 命令置标志 + `kill_process_tree` 强杀（daemon 侧连接断开后同样停止下载），退出时 `cleanup_on_exit` → `kill_all_task_children` 兜底；③Windows 上子进程额外挂 `KILL_ON_JOB_CLOSE` 的 Job Object（`platform.rs:assign_child_to_kill_job`），任务管理器强杀 / 崩溃时由系统一并终止子进程。取消统一以「已取消」错误返回（`CANCELLED_MSG`），前端 `isCancelError` 识别后按提示而非失败展示；`install-desktop` 阶段会拉起安装程序，前端不给取消按钮。Docker Desktop 安装包下载走 `download_with_resume_cancellable`（保留 `.part` 可续传）。
  8. **前端任务按钮 / 误触保护**（`model_list.js`）：任务进行中卡片只显示「进度 + 取消」——`dockerBusy`（docker 任务存在）会隐藏启动/关闭/删除按钮，启动阶段（stage `start`/`start-daemon`）状态徽章显示「启动中」而不是「可用」；「取消」按钮由 `isDockerTaskCancellable` 白名单阶段决定，完成/取消/`model-started`/`model-stopped` 都要清掉 `dockerTasks[model_id]` —— 后端 `clear_task` 不发事件，漏清会让"进度 + 取消"按钮残留在卡片上。另外下载完成会整体重渲染卡片（「下载」按钮位置变成「启动」），连击或手快的第二下会误落在新按钮上，表现为"下载完自动启动"：`isRecentDockerAction`（下载点击/完成后 1.2s 内忽略启动点击）+ `isClickThrough`（渲染后 350ms 内忽略卡片动作按钮点击，**两者都带提示**，不静默吞点击）双重保护，**启动必须是一次独立的手动点击**。
  9. **退出 / 强杀对账**：容器生命周期一律"停止即删除"（`docker stop -t 2` + `docker rm -f`），输出/输入/用户目录挂载在宿主，删除容器不丢数据，下次启动按原参数重建。点「关闭」走 `stop_docker_model`；真正退出时 `lib.rs` 的 `cleanup_processes` 调 `docker_model::cleanup_on_exit` 做同样清理（与 llama-server 一致，释放内存/显存与 64646 端口；Windows 点窗口关闭只是隐藏到托盘，容器继续跑，符合预期）。启动失败的容器（显存不足等）同样在 `start_docker_model` 里直接删除，避免 exited 容器堆积。**`prune_docker_containers` / `sync_docker_container` 在 `docker_tasks` 有进行中任务时跳过删除**：`docker run`/`docker start` 执行期间容器瞬时处于 created/exited，此刻删除会把刚创建的容器删掉（视图每次挂载都会跑 `refreshDockerRunning()`）。若进程被强杀 / 崩溃，容器会因 `--restart unless-stopped` 残留 —— 视图 `init()` 的 `refreshDockerRunning()` 先调 `prune_docker_containers` 清掉所有已停止的 `adm-*` 容器，再对每个 docker 模型调 `sync_docker_container`，把运行中的容器状态写回 `AppState` 并提示"上次未正常退出"。
- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。

## 构建与发布
- CI：`.github/workflows/build.yml` — 标签触发（`v*`），构建前从 `adm-binaries` 仓库检出内置 admAgent 二进制到 `adm-binaries/`，构建 Windows + macOS，自签名。
- 更新内置二进制：编译 admAgent（压缩包自动写入 `adm-binaries/`）→ `pnpm agent:push` 强制覆盖远端（CI 下次构建即用）。
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
  - `adm-binaries/` — 二进制仓库（ADM 与 admAgent 共用；本地 clone 由编译产物直写，`pnpm agent:push` 强制覆盖远端，CI 自动 checkout 到同名目录）
  - `website/` — 营销网站
  - `scripts/` — 工具脚本
- **工作目录切换功能仅桌面端**：TUI 只显示当前工作目录（PrettyPath），不做切换/下拉/添加/删除。所有工作目录切换 UI 在桌面端实现。
- **调试日志统一写入 `adm_api_debug.log`**：复杂问题排查需要日志时，Rust 端用 `api_debug_log!`，前端 JS 用 `invoke("agent_debug_log", { line: "..." })`，统一写入 `~/Library/Application Support/com.adm.admapp/adm_api_debug.log`（macOS）或 `%LOCALAPPDATA%\ADM\adm_api_debug.log`（Windows；`get_data_dir` 在 Windows 返回 exe 同目录，即安装目录下）。日志必须带类型标记便于过滤：
  - `UI:` 前缀 — 前端 JS 日志（SSE 事件过滤、状态变更、消息处理等）
  - `HTTP >` / `HTTP <` — HTTP 请求/响应
  - `SSE =` / `SSE !` — SSE 连接/断开
  - `< message created` / `< run_complete` / `< agent_event` — SSE 事件转发
  - `UpdateModels:` / `readyWg:` — admAgent 服务端诊断日志
  - `ilink: [阶段]` — 微信 Bot 流程（登录/工作区复用/入站消息/SSE 转发/回投），原 `ilink_flow_debug.log` 已并入本文件
  日志格式：`{epoch_ms} {HH:MM:SS.mmm 本地时间} {类型标记} {内容}`，由 Rust 端统一格式化。调试模式开关：设置→调试模式（`config.json` 的 `debug_logging` 字段）。