# AGENTS.md — AI 开发实施规格

> ADM = Tauri 桌面端（`src/` + `src-tauri/`）+ Go Agent 服务端 / TUI（`admAgent/`），两个前端共用同一 server。
> 本文件只写执行规格：流程、边界、验证、文档路由、诊断。细节全在 `doc/`，与代码冲突时以代码为准。

## 0. 执行流程

1. 判定改动端：桌面端或 `admAgent/`，只改一端；用户未明确要求时不跨端。
2. 按「文档路由」读对应文档与 `*-plan.md`，不凭记忆猜约定。
3. 读现有实现（grep / LSP）后做最小必要修改，沿用现有风格与依赖。
4. 跑「验证矩阵」全部命中项，失败先修绿。
5. 同一次改动内同步文档；完整映射见 [`doc/conventions.md#文档同步更新强制`](doc/conventions.md#文档同步更新强制)。

## 1. 硬边界

- 桌面端 = `src/` + `src-tauri/`；TUI / 服务端 = `admAgent/`。未经明确指示不混改两端。
- `admAgent/` 可直接改：先搜源码确认现状；行为 / 契约改动必须同步文档并跑 Go 构建与相关测试。
- 只用 `pnpm`（不用 `npm` / `yarn`）；仓库没有 linter / formatter / JS 测试框架，不要新增。
- 工作目录切换（下拉 / 添加 / 删除）仅桌面端；TUI 只显示当前目录（`PrettyPath`）。
- 新约定写进对应主题文档，不堆回本文件；本文件最多加索引行。
- 文档写清「为什么」（踩坑原因、被否方案）；引用代码用符号名 / 路径，尽量不写行号。
- 契约字符串（开关名、配置键、事件名、错误 token，如 `options.bash_allow_all`、`thinking_mode_unsupported`）必须与代码逐字一致。
- `doc/*-plan.md`、`doc/*patch-*.md` 是历史记录，不随实现改写；行为变化写主题文档，必要时在开头补「后续变更见 …」。

## 2. 验证矩阵（收尾必跑）

| 改动 | 命令 |
| --- | --- |
| 前端 `src/`、`jsconfig`、类型声明 | `pnpm typecheck` |
| `admAgent/` Go 代码 | 在 `admAgent/` 内 `go build ./...` + `go test ./internal/... -count=1`；单测用 `-run 'TestName'` |
| Go 改动要在 ADM 内生效 | `admAgent/build.ps1` → `pnpm agent:push`（重编并推送 sidecar，缺一不生效） |
| agent 行为回归 | `admAgent/scripts/eval.sh` / `eval.ps1`（手动，退出码 0 通过 / 1 回归 / 2 跳过）；判分器自测 `go test ./internal/eval/ -count=1` |
| Rust / 打包 / CI | `pnpm tauri build`；跨平台 `pnpm tauri:build:windows` / `:macos` / `:linux` |
| 手动联调 | `pnpm tauri dev`；清理产物 `pnpm tauri clean` |

环境噪声不算回归（未改动 HEAD 上同样复现）：Windows 下 `internal/shell` shebang 测试需 `/bin/bash`；`internal/server`、`internal/backend`（`TestBackend_ReloadSkills`）偶发 TempDir 句柄 / 文件锁抖动。

## 3. 文档路由（改前必读，改后同步）

| 改动落点 | 文档 |
| --- | --- |
| 外壳 / 视图 / 路由 / IPC / 类型（`src/index.html`、`src/views/*.js`、`jsconfig.json`、`src/types.d.ts`） | [`doc/frontend-architecture.md`](doc/frontend-architecture.md) |
| Agent 视图交互与状态（`src/views/agent/` 的 store / render / ui / sse / autocontinue / workspace） | [`doc/frontend-agent-conventions.md`](doc/frontend-agent-conventions.md) |
| 剪贴板粘贴、PDF 附件（`attach.js`、`pdf.js`、Rust `read_clipboard_files` / `clipboard_*`） | [`doc/attachments.md`](doc/attachments.md) |
| `src-tauri/src/**`：自升级、下载、运行库预检、平台差异 | [`doc/rust-backend.md`](doc/rust-backend.md) |
| Docker 模型链路与模型页（`docker_model.rs`、`model_list.js`） | [`doc/docker-image-models.md`](doc/docker-image-models.md) |
| Agent 设置项与开关写入（`settings.rs`、`agent.rs` 的 `sync_*`、设置 / 模型 / memory 视图） | [`doc/agent-settings.md`](doc/agent-settings.md) |
| admAgent 服务端行为与前后端契约（loop / 压缩 / 事实块 / 归档编号 / 决策模式 / 代理 / 配置词表 / part 类型） | [`doc/admAgent-server.md`](doc/admAgent-server.md) |
| 压缩机制细节（触发、Summarize、取回、熔断） | [`doc/admAgent-context-compaction-flow.md`](doc/admAgent-context-compaction-flow.md) |
| HTTP API 端点 / 字段（`admAgent/internal/server`、`internal/proto`） | [`doc/server-api.md`](doc/server-api.md) |
| CI、打包、sidecar 分发（`build.yml`、`prepare-agent-binary.mjs`、`tauri.conf.json`） | [`doc/build-and-release.md`](doc/build-and-release.md) |
| agent 行为 eval（`admAgent/internal/eval`、`internal/cmd/eval.go`、fixture / 基线） | [`doc/admAgent-eval-harness-plan.md`](doc/admAgent-eval-harness-plan.md) |
| 工作边界、调试日志标记、文档同步映射 | [`doc/conventions.md`](doc/conventions.md) |
| llama-server 启动参数 / 模型清单 | `doc/llamacpp.txt` / `doc/model_list.json` |

改相关模块前先读的设计记录，避免重复踩坑：

- [`doc/admAgent-fact-block-and-recall-refs-plan.md`](doc/admAgent-fact-block-and-recall-refs-plan.md) — 事实块 + 归档编号 `#N` + `recall` 区间 / 展开
- [`doc/admAgent-parallel-sessions-file-guards.md`](doc/admAgent-parallel-sessions-file-guards.md) — 同目录多会话并行的服务端写保护
- [`doc/admAgent-prefix-budget-plan.md`](doc/admAgent-prefix-budget-plan.md) — 固定前缀瘦身与预算守卫（git 剧本已搬入 skill）
- [`doc/admAgent-lsp-managed-runtime-plan.md`](doc/admAgent-lsp-managed-runtime-plan.md) — LSP 现行实现 + 托管 runtime（P0 / SSE 进度 / Node 托管已落地）
- [`doc/admAgent-patch-bash-allow-all.md`](doc/admAgent-patch-bash-allow-all.md) — `options.bash_allow_all`
- [`doc/admAgent-patch-project-memory-sync.md`](doc/admAgent-patch-project-memory-sync.md) — `options.project_memory_sync`
- [`doc/agent-decision-mode-server-plan.md`](doc/agent-decision-mode-server-plan.md) / [`doc/agent-decision-output-plan.md`](doc/agent-decision-output-plan.md) — 决策输出模式
- [`doc/admAgent-undo-anchor-plan.md`](doc/admAgent-undo-anchor-plan.md) — 每轮 / 跨轮撤销（**待审核，未落地**）

## 4. 代码地图

- `admAgent/` — Go TUI（Bubbletea / lipgloss / ultraviolet）+ 共享后端 server；HTTP API 见 `doc/server-api.md`
- `src/` + `src-tauri/` — Tauri 桌面端：vanilla JS 前端、Rust 后端
- `adm-binaries/` — 二进制仓库（编译产物直写；`pnpm agent:push` 覆盖远端，CI 自动 checkout）
- `website/` — 营销网站；`scripts/` — 仓库级工具脚本（Go 专用脚本在 `admAgent/scripts/`）

## 5. 运行时诊断

- admAgent 日志：`%LOCALAPPDATA%\admAgent\cache\admAgent.log`（Windows）/ `~/.cache/admAgent/admAgent.log`；单文件、每次启动截断，直接读内容（Windows 目录列表可能显示 0 字节）。
- panic 栈：同目录 `admAgent-panic.log`（追加，超 8MB 轮转 `.prev`）。排查「对话突然中断 / 服务异常退出」先看它，再看 `adm_api_debug.log` 的 `SSE !` 时间线。
- 「对话中断」grep `Loop step response|ending turn|nudg`：`text_bytes=0` 但 `output_tokens` 很大 = 输出全漏进 reasoning（典型为 localModel 在 40k+ 上下文退化）。
- 桌面端调试日志：`adm_api_debug.log`（路径与 `UI:` / `HTTP >` / `SSE =` 等类型标记见 `doc/conventions.md`）；Rust 用 `api_debug_log!`，JS 用 `invoke("agent_debug_log", ...)`。
