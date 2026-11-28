# 工作边界、文档同步与调试日志

> 范围：改动范围约定（桌面端 / TUI / 服务端）、admAgent 可修改边界、工作目录功能归属、**代码 ↔ 文档同步更新映射表**，以及统一调试日志的写入方式与类型标记。

---

- admAgent api文档在 `doc/server-api.md`
- llama-server cli 启动参数文档  windows在`doc/llamacpp.txt`，  macos在 `doc/llamacpp-macos.txt`
- admAgent 源码在 `admAgent` 目录下，可直接搜索和修改；改前先确认现状，行为/契约改动同步文档并跑 Go 构建/相关测试；大型改动按对应 `doc/*-plan.md` 执行。
- **改动必须区分桌面端和 TUI / 服务端**：每次改动前必须先告知用户改动目标是桌面端（`src/` + `src-tauri/`）还是 TUI / 服务端（`admAgent/`），未经明确指示不混改两端。
- **工作目录切换功能仅桌面端**：TUI 只显示当前工作目录（PrettyPath），不做切换/下拉/添加/删除。所有工作目录切换 UI 在桌面端实现。

## 文档同步更新（强制）

**代码改动与对应文档必须在同一次改动里一起更新**，不留 TODO、不留到「下次」。`AGENTS.md` 只是索引，正文全在 `doc/`；文档与代码冲突时以代码为准，但责任在改动方——发现描述过期要顺手修正。

映射表（按改动落点找文档，一次改动可能同时命中多行）：

| 改动落点 | 必须同步更新 |
| --- | --- |
| 外壳 / 视图模块 / 路由 / IPC 调用方式（`src/index.html`、`src/views/*.js`、`jsconfig.json`、`src/types.d.ts`） | [frontend-architecture.md](frontend-architecture.md) |
| Agent 视图交互与状态（`src/views/agent/` 的 store / render / ui / sse / autocontinue / workspace 等） | [frontend-agent-conventions.md](frontend-agent-conventions.md) |
| 剪贴板粘贴、PDF 附件（`attach.js`、`pdf.js`、`pdf_batch.js`、`src/vendor/pdfjs`、Rust 侧 `read_clipboard_files` / `clipboard_*`） | [attachments.md](attachments.md) |
| `src-tauri/src/**`（除 docker 与构建链路：自升级、下载、运行库预检、平台差异） | [rust-backend.md](rust-backend.md) |
| Docker 部署的模型（图片生成 / 文本生成语音）链路与模型页卡片流程（`docker_model.rs`、`model_list.js`） | [docker-image-models.md](docker-image-models.md) |
| Agent 设置项与开关写入链路（`settings.rs` / `agent.rs` 的 `sync_*`、`settings_dialog.js`、`cloud_models.js`、`memory.js`、模型下拉） | [agent-settings.md](agent-settings.md) |
| admAgent 服务端行为与前后端契约（loop / 压缩 / 事实块 / 归档编号 / 决策模式 / 代理 / 配置词表 / 新增 part 类型） | [admAgent-server.md](admAgent-server.md) |
| CI、打包、sidecar 分发与更新链路（`build.yml`、`prepare-agent-binary.mjs`、`tauri.conf.json` 打包项） | [build-and-release.md](build-and-release.md) |
| 调试日志标记、工作边界与流程约定 | 本文件 |
| HTTP API 端点 / 字段（`admAgent/internal/server`、`internal/proto`） | [server-api.md](server-api.md) |
| agent 行为 eval（`admAgent/internal/eval`、`internal/cmd/eval.go`、`admAgent/scripts/eval.*`、fixture / 任务 JSON / 基线） | [admAgent-eval-harness-plan.md](admAgent-eval-harness-plan.md) |
| 新增 / 删除 / 改名文档，或模块归属变化 | `AGENTS.md` 的「文档索引」「项目结构」 |

规则：

- **新增约定写进对应主题文档**，不要堆回 `AGENTS.md`；索引里最多加一行。
- **写清「为什么」**（踩坑原因、被否掉的做法），不要只写「已实现 X」，否则下次会把同一个坑再踩一遍。
- 引用代码优先写符号名 / 文件路径，**尽量不写行号**（会过期）；确有必要写行号时，改到该处就同步更新。
- 契约字符串（开关名、配置键、事件名、错误 token，如 `thinking_mode_unsupported`、`options.bash_allow_all`）必须与代码逐字一致，改契约就改文档。
- 方案 / 实施记录（`doc/*-plan.md`、`doc/*patch-*.md`）是历史记录，**不随实现演进改写**；行为变化写进主题文档，必要时在记录开头补一行「后续变更见 …」。
- 收尾自检：本次每个改动落点都能在上表命中，且对应文档已更新。

## JSONL 日志（`adm-desktop.jsonl` / `admAgent.jsonl`）

- 新日志统一为 schema v1 JSONL，契约见 [`admAgent-log-schema.json`](admAgent-log-schema.json) 与 [`admAgent-ai-logging-plan.md`](admAgent-ai-logging-plan.md)。桌面端只写 `adm-desktop.jsonl`，Go server/TUI 只写 `admAgent.jsonl`；旧 `adm_api_debug.log`、`admAgent.log`、`admAgent-panic.log` 只读发现，不再创建或续写。
- 写入必须经共享 writer：跨进程锁、100ms/50 条批量、20MB + 3 备份、锁内轮转。WARN/ERROR 与 turn/tool 终态立即 flush。不要恢复启动截断或长期持有日志句柄，否则会丢跨重启证据并写入已轮转 inode。
- `session/run/turn/step/tool_call/req/conn/boot` 是关联键；`run` 对应客户端提交，`turn` 对应实际执行生命周期。压缩重排队和 provider 重试保留 turn，独立排队 prompt 才新建 turn。
- `agent.turn.end` / `tool.call.end` 必须经 CAS finalizer，正常、取消、panic、fallback 只写一条权威终态。SIGKILL 后由 `admAgent.jsonl` 的 `proc.start/exit/heartbeat` 与未闭合 start 补 `terminal_source=inferred` 的终态。
- 默认 allowlist：ID、模型、工具名、错误码、状态、耗时、token/字节、路径 hash。prompt、工具入参、命令、stdout/stderr、body、配置值不得进入普通事件；panic/raw/payload 是 `sensitive=true` 的同文件例外，payload 默认关闭。
- 路径默认 hash；`ADM_LOG_PATHS=1` 才记录绝对路径。payload 默认关闭，`ADMAGENT_LOG_PAYLOAD=1`（Go）/ `ADM_LOG_PAYLOAD=1`（桌面）才写 `llm.payload` / `raw.payload`，且必须 `sensitive=true`。`ADMAGENT_LOG_DIR`、`ADM_LOG_DIR`、`ADM_DESKTOP_LOG` 只覆盖日志目录，不改变其他缓存目录。
- 查询用 `admAgent logs`，诊断用 `admAgent diagnose`；默认排除 raw/payload，panic 只返回摘要。`admAgent_logs` 默认限定当前 workspace/session 并返回缺失来源与旧 schema 信息。
- 桌面 `Settings.debug_logging` 控制 Info/Debug；关闭后 WARN/ERROR 仍落盘。旧 `agent_debug_log(line)` 保留兼容，但内部也转 JSONL；新代码使用 structured/batch/flush 命令。
