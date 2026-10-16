# ADM — Agent 指南

本文件只做**索引**：命令速查 + 代码/文档地图 + 少量硬规则。约定、踩坑记录与设计决策都在 `doc/` 下，
动手前按下面的索引打开对应文档，不要凭记忆猜。

## 开发命令（始终使用 `pnpm`，不要用 `npm`/`yarn`）

- `pnpm tauri dev` — 热重载开发模式
- `pnpm tauri build` — 生产构建
- `pnpm tauri clean` — 清理构建产物
- `pnpm tauri:build:windows` / `:macos` / `:linux` — 跨平台构建
- `pnpm typecheck` — 前端类型检查（tsc --noEmit，只检查不产出，改完前端必跑）

### admAgent（Go，`admAgent/` 目录内执行）
- `go build ./...` — 编译检查
- `go test ./internal/... -count=1` — 全量单测（Windows 上 `internal/shell` 的 shebang 测试依赖 /bin/bash、`internal/server` 与 `internal/backend`（`TestBackend_ReloadSkills`）偶发 TempDir 句柄/文件锁抖动，属环境问题可忽略——均可在未改动的 HEAD 上复现）
- `go test ./internal/agent/ -run 'TestName' -count=1` — 单个测试
- `build.ps1` — Windows 构建脚本；改完 Go 代码必须重新编译打包 sidecar 才在 ADM 里生效
- 运行时日志：`%LOCALAPPDATA%\admAgent\cache\admAgent.log`（Windows）/ `~/.cache/admAgent/admAgent.log`（macOS、Linux）。单文件、每次启动截断重写（`GlobalLogPath()`），直接读内容为准；注意 Windows 目录列表可能显示 0 字节。排查“对话突然中断”类问题 grep `Loop step response|ending turn|nudg`：`text_bytes=0` 但 `output_tokens` 很大 = 模型输出全部漏进 reasoning（典型为 localModel 在 40k+ 上下文下退化）

## 硬规则（违反会返工）

1. **先确认改动目标**：桌面端 = `src/` + `src-tauri/`，TUI / 服务端 = `admAgent/`；未经明确指示不混改两端。
2. **`admAgent/` 目录只读**：需要结论先搜源码；确认是 admAgent 的问题时，列出问题与改动点交给用户审核，不要直接改。
3. **改完 Go 代码必须重新编译并推送 sidecar**（`admAgent/build.ps1` → `pnpm agent:push`）才在 ADM 里生效。
4. 前端改动跑 `pnpm typecheck`；仓库没有 linter / formatter / 测试框架，不要新增。
5. **代码改动必须同步更新对应文档**：同一次改动里改完，映射表见 [`doc/conventions.md`](doc/conventions.md#文档同步更新强制)；行为/契约变了而文档没跟，视为改动未完成。
6. 复杂问题排查需要日志时，按 `doc/conventions.md` 的类型标记写 `adm_api_debug.log`。

## 文档索引

| 文档 | 内容（什么时候读） |
| --- | --- |
| [`doc/frontend-architecture.md`](doc/frontend-architecture.md) | SPA 视图模块结构、样式/类型约定、Tauri IPC、多 workspace 并发与 Agent server 模式 |
| [`doc/frontend-agent-conventions.md`](doc/frontend-agent-conventions.md) | Agent 视图错误处理、自动续跑、假完成检测、拖拽保护、同目录多会话并行（前台状态模型） |
| [`doc/attachments.md`](doc/attachments.md) | 剪贴板粘贴（三平台差异）与 PDF 分批转图 |
| [`doc/rust-backend.md`](doc/rust-backend.md) | Rust 命令地图、应用自升级、下载链路、VC++ / Vulkan 运行库预检、平台差异 |
| [`doc/docker-image-models.md`](doc/docker-image-models.md) | 图片生成模型的 Docker 部署链路、取消与清理、模型页加载顺序 |
| [`doc/admAgent-server.md`](doc/admAgent-server.md) | 服务端 loop 抖动恢复、压缩与事实块、归档编号、决策模式、代理链路、配置词表 |
| [`doc/agent-settings.md`](doc/agent-settings.md) | Agent 设置项、推理强度与思考开关、云端模型 `can_reason`、开关写入链路 |
| [`doc/build-and-release.md`](doc/build-and-release.md) | CI、构建与发布、内置 admAgent 分发、Linux 打包/更新链路 |
| [`doc/conventions.md`](doc/conventions.md) | 工作边界、工作目录功能归属、代码↔文档同步映射表（改动收尾必查）、调试日志格式与标记 |
| [`doc/server-api.md`](doc/server-api.md) | admAgent HTTP API（服务端权威文档） |
| `doc/llamacpp.txt` / `doc/llamacpp-macos.txt` | llama-server CLI 启动参数 |
| `doc/model_list.json` | 模型清单 |

方案与实施记录（改动相关模块前先读，避免重复踩坑）：

- [`doc/admAgent-fact-block-and-recall-refs-plan.md`](doc/admAgent-fact-block-and-recall-refs-plan.md) — 确定性事实块 + 归档编号 `#N` + `recall` 区间/展开取回
- [`doc/admAgent-parallel-sessions-file-guards.md`](doc/admAgent-parallel-sessions-file-guards.md) — 同目录多会话并行的服务端写保护
- [`doc/admAgent-patch-bash-allow-all.md`](doc/admAgent-patch-bash-allow-all.md) — `options.bash_allow_all`
- [`doc/admAgent-patch-project-memory-sync.md`](doc/admAgent-patch-project-memory-sync.md) — `options.project_memory_sync`
- [`doc/agent-decision-mode-server-plan.md`](doc/agent-decision-mode-server-plan.md) / [`doc/agent-decision-output-plan.md`](doc/agent-decision-output-plan.md) — 决策输出模式（服务端方案 / 前端 MVP 记录）

## 项目结构

- **项目结构**：
  - `admAgent/` — Go TUI（Bubbletea/lipgloss/ultraviolet）+ 共享后端服务器（Go），两个前端共用此 server
  - `src/` + `src-tauri/` — Tauri 桌面端（vanilla JS 前端 + Rust 后端）
  - `adm-binaries/` — 二进制仓库（ADM 与 admAgent 共用；本地 clone 由编译产物直写，`pnpm agent:push` 强制覆盖远端，CI 自动 checkout 到同名目录）
  - `website/` — 营销网站
  - `scripts/` — 工具脚本
