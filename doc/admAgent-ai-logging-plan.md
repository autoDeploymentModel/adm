# admAgent / ADM 日志系统实施规格（面向 AI 开发）

> 状态：**已实施（P0/P1/P2 主链路）**。
>
> 后续实施与现行契约见 [`doc/conventions.md`](conventions.md)、[`doc/admAgent-server.md`](admAgent-server.md)、[`doc/rust-backend.md`](rust-backend.md) 与 [`doc/admAgent-log-schema.json`](admAgent-log-schema.json)；本文件保留为原始决策记录。
>
> 范围：`admAgent/`（Go server / TUI）+ ADM 桌面端（`src-tauri/` + `src/`）。
>
> 格式：**JSONL**。文件收敛为两个：`adm-desktop.jsonl` 与 `admAgent.jsonl`。

## 1. 目标与非目标

### 1.1 目标

- 双端日志统一为 JSONL，字段稳定、事件名封闭、可机器查询。
- 用 `session/run/turn/step/tool_call/req/conn/boot` 串联 UI、Rust、Go、sidecar。
- 失败、取消、panic、进程退出、慢工具都有终态；SIGKILL 后可从日志推断恢复。
- 日志跨重启保留，轮转有界，多进程写入安全。
- 默认不记录 prompt、工具入参、命令、文件内容、密钥。

### 1.2 非目标

- 不引入 OTel/Loki/ELK/远程遥测。
- 不按进程、会话、子系统拆日志文件。
- 不默认保存完整 payload。
- 不承诺跨进程全序；只做墙钟近似关联。

## 2. 已决策（实现不得偏离）

| 决策 | 最终选择 |
| --- | --- |
| D1 格式 | 所有新日志均为 JSONL；旧文本文件只读兼容 |
| D2 文件 | 桌面端只写 `adm-desktop.jsonl`；server/TUI 只写 `admAgent.jsonl` |
| D3 写入 | 跨进程文件锁 + 批量追加；轮转在锁内完成；锁文件不承载日志内容 |
| D4 恢复 | 从 `admAgent.jsonl` 的 `proc.start/exit/heartbeat`、`agent.turn.start/end`、`tool.call.start/end` 推断未闭合终态；不建额外 journal 文件 |
| D5 身份 | `proc/pid/boot/seq` 属于实际写入进程；JS 用 `origin=ui/doc/ui_seq` |
| D6 级别 | Info 记 turn/tool 起止、step 摘要与响应、终态/慢调用；Debug 记请求细节/自动权限/Hook allow/LSP RPC/UI perf；payload 默认关闭 |
| D7 隐私 | 默认 allowlist；panic/raw/payload 作为 `sensitive=true` 的 JSONL 事件写入同一文件；工作区/源码/cwd 路径默认 hash |
| D8 死亡判定 | `stop/unreachable/replaced/died` 分离；P0 仅 owned child `child_exit` 判 died，P1 才允许 token 匹配的 `pid_dead` |
| D9 保留 | 每个日志文件 20MB + 3 个备份（80MB）；两个文件合计约 160MB |
| D10 实施 | P0 → P1 → P2；契约文档与代码同阶段更新 |

## 3. 日志模型

### 3.1 单行格式

```json
{"v":1,"ts":"2026-11-27T20:15:22.123+08:00","ts_ms":1764245722123,"seq":18422,
 "lvl":"info","proc":"admAgent-server","pid":23144,"boot":"2f1c9e44-6a3e-4a4e-9f0e-7f2f6f9d1b33",
 "origin":"server","src":"internal/agent/agent_loop_llm.go:1179",
 "comp":"agent.loop","evt":"llm.step.response","msg":"Loop step response",
 "trace":{"ws":"ws_ab12","client":"desk-1","session":"s_9f3","run":"r_77","turn":"t_5","step":3},
 "dur_ms":812,"model":"gpt-5.1","finish_reason":"tool_calls",
 "input_tokens":18234,"cache_read_tokens":16000,"cache_hit_pct":87.7,
 "output_tokens":642,"text_bytes":1203,"reasoning_bytes":0,
 "tool_calls":2,"tools_called":["bash","view"]}
```

### 3.2 保留字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `v` | int | 是 | 当前 `1` |
| `ts` | string | 是 | ISO8601，本地时区带偏移，毫秒 |
| `ts_ms` | int64 | 是 | epoch 毫秒；跨进程近似排序 |
| `seq` | uint64 | 是 | 实际写入进程内单调递增 |
| `lvl` | string | 是 | `debug/info/warn/error` |
| `proc` | string | 是 | `admAgent-server/admAgent-tui/adm-desktop` |
| `pid` | int | 是 | 实际写入进程 PID |
| `boot` | UUID | 是 | 实际写入进程启动 ID |
| `origin` | string | 是 | `server/tui/desktop/ui/sidecar` |
| `doc` | UUID | `origin=ui` 必填 | WebView document ID |
| `src` | string | 否 | Go/Rust `file:line`；JS `ui:<module>` |
| `comp` | string | 是 | 组件名 |
| `evt` | string | 是 | 精确事件名，见 §6 |
| `msg` | string | 是 | 静态模板或脱敏摘要；禁止拼接用户内容 |
| `trace` | object | 业务事件必填 | 见 §3.3；无业务上下文的进程事件可省略 |
| `dur_ms` | int64 | 否 | 有始有终事件的耗时 |
| `err` | object | 否 | `code/retryable/status/provider/text` |
| `sensitive` | bool | 否 | 默认 false；panic/raw/payload 必须 true |
| `truncated` | array<string> | 否 | 被截断的字段路径；不改变字段类型 |

事件专属字段一律扁平，例如 `model/status/tool/input_bytes`。不得新增 `fields` 容器，不得覆盖保留字段。

### 3.3 trace

允许键：`ws/client/session/run/turn/attempt/parent_turn/prev_boot/server_boot/msg/step/tool_call/req/conn/permission/hook/lsp/mcp/model/job`。

- `run`：客户端一次提交；TUI/fold 可为空。
- `turn`：一次实际执行生命周期；压缩重排队、provider/内部重试保留同一 turn，只增加 `attempt`。
- fold：记 `agent.turn.fold`，不新建 turn。
- 独立排队 prompt：入队时分配 `run + turn`；取消/丢弃写 `agent.turn.end outcome=cancelled end_reason=cancelled_before_start`。
- `dur_ms` 只计执行时间；排队时间记 `queue_ms`。
- token 汇总包含 turn 内所有 attempt、被丢弃步骤与压缩调用；`input_tokens/cache_read_tokens/cache_write_tokens/output_tokens` 分列，`prompt_tokens` 优先用 provider 原值。

### 3.4 终态与恢复

- `TurnFinalizer` / `ToolCallFinalizer` 使用 CAS，保证正常返回、取消、panic、backend fallback、MCP 回调只写一条终态。
- `agent.turn.end.outcome`：`completed/cancelled/error/incomplete`。
- `agent.turn.end.end_reason`：`normal/user_cancel/shutdown/provider_error/provider_auth/provider_rate_limit/provider_timeout/provider_stream_interrupted/context_overflow/compaction_failed/reasoning_overrun/tool_loop/unavailable_tool/max_steps/empty_output/tool_panic/server_exit/cancelled_before_start/unknown`。
- `tool.call.end.terminal_reason`：`ok/not_found/invalid_input/dropped_cap/cancelled_before_start/timeout/panic/error/server_exit`。
- `terminal_source`：turn/tool 终态用 `authoritative/inferred`；桌面死亡观察事件用 `desktop_observed`。
- 有活跃 turn 时，server 每 30s 写一条 `proc.heartbeat`，字段为 `active_turns`。
- P0 启动恢复：扫描 `admAgent.jsonl` 最后 32MB，找有 `proc.start`、无 `proc.exit` 且 heartbeat 过期的旧 boot；对未匹配的 `agent.turn.start` / `tool.call.start` 补 `terminal_source=inferred/terminal_reason=server_exit`。
- P0 用 PID + heartbeat 判断旧进程死亡；P1 增加 `proc_start_token` 排除 PID 复用，`pid_dead` 仅在 token 匹配时生效。

`err.code` 封闭集合：`provider_auth/provider_rate_limit/provider_timeout/provider_unavailable/provider_invalid_request/provider_context_overflow/provider_stream_interrupted/reasoning_overrun/tool_timeout/tool_cancelled/tool_permission_denied/tool_validation/tool_not_found/tool_execution/tool_loop/max_steps/empty_output/compaction_failed/stale_read/must_read/hook_blocked/hook_error/lsp_unavailable/lsp_error/mcp_unavailable/mcp_error/sse_disconnected/server_exited/ipc_error/config_invalid/config_reload_failed/session_gone/summarize_cooldown/storage_error/log_write_failed/disk_full/panic/internal_error/unknown`。

### 3.5 时间、截断与大小

- 进程内顺序：`(boot, seq)`；跨进程按 `ts_ms` 近似合并，时钟回拨时标 `clock_uncertain`。
- JS 发送 `ts_ms/ui_seq`；Rust 派生 `ts`，缺失时用接收时间并标 `ts_source=receipt`。
- 普通事件 ≤16KB；panic/UI error ≤64KB；payload chunk ≤256KB；字符串 ≤2KB；`err.text` ≤500 字符；数组 ≤20 项。
- panic stack ≤32KB，脱敏后写 `sensitive=true` 事件；UI stack ≤32KB、脱敏后默认可见。
- payload 单块 ≤256KB，大请求分块并记 `payload_seq/total`；超预算标记 `truncated`。

## 4. 文件、写入锁、发现与轮转

### 4.1 目录

| 平台 | 桌面端日志目录 | server/TUI 规范日志目录 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\ADM\logs` | `%LOCALAPPDATA%\admAgent\log` |
| macOS | `~/Library/Application Support/com.adm.admapp/logs` | `~/.cache/admAgent` |
| Linux | `~/.local/share/com.adm.admapp/logs` | `~/.cache/admAgent` |

环境变量：`ADMAGENT_LOG_DIR`（Go）、`ADM_LOG_DIR`（桌面）、`ADM_DESKTOP_LOG`（桌面日志绝对路径，传给 server）、`ADM_LOG_PATHS=1`（允许工作区/源码/cwd 绝对路径）。Windows 的 `admAgent\cache` 仍用于其他缓存，日志单独放 `admAgent\log`。

### 4.2 文件（只有两个日志文件）

| 文件 | 内容 |
| --- | --- |
| `adm-desktop.jsonl` | Rust、JS、sidecar stdout/stderr、Rust panic、UI error、可选 payload |
| `admAgent.jsonl` | Go server/TUI 全部事件、Go panic、可选 payload |
| `adm-desktop.jsonl.lock`、`admAgent.jsonl.lock` | 跨进程写入/轮转锁；不承载日志内容 |
| `adm-desktop.jsonl.1..3`、`admAgent.jsonl.1..3` | 轮转备份，属于同一文件族 |

旧文件 `adm_api_debug.log`、`admAgent-panic.log` 只读保留并纳入发现，不删除、不继续写；Windows 旧路径 `%LOCALAPPDATA%\admAgent\cache\admAgent.log` 也纳入只读发现。不得再创建 per-process、per-session、per-subsystem、manifest、open-turn、stdout、panic、error、payload 文件。

### 4.3 写入与轮转

- Go 复用 `internal/lock.File/TryFile`；Rust 复用 `pages/agent.rs` 现有 `LockFileEx/flock` 模式，迁入 `common/logging.rs`。
- 每个进程批量缓冲 100ms 或 50 条；WARN/ERROR、`proc.start/exit`、`agent.turn.start/end`、`tool.call.start/end` 立即 flush。
- 每批在锁内 open → append → close；不长期持有日志文件句柄，避免轮转后写入旧 inode。
- Go 不再用 lumberjack 直接写共享文件；轮转由锁内共享 writer 完成。达到 20MB 时 `.3→.4` 删除、`.2→.3`、`.1→.2`、当前→`.1`，再创建新文件。
- 锁等待有上限；超时/磁盘满记 `log.writer.error` + 内存 `writer_health` + stderr，并统计 dropped。
- 锁文件不轮转、不删除；进程崩溃后由 OS 释放锁。
- Tauri 已启用 `tauri-plugin-single-instance`；桌面锁仍保留，防止旧实例/工具进程并发。
- Go `debug.SetCrashOutput` 与 Rust panic hook 都把崩溃栈包装为 `proc.panic` JSONL 写入同一文件；锁不可用时直接 O_APPEND，避免 panic-in-lock 死锁。
- 不截断启动日志；关闭详细模式只提高级别，不删除文件。

### 4.4 发现与双端关联

发现顺序：

1. 显式 `--log-dir/--file`。
2. `ADMAGENT_LOG_DIR/ADM_LOG_DIR/ADM_DESKTOP_LOG`。
3. 平台规范路径 `adm-desktop.jsonl` / `admAgent.jsonl`。
4. 本地/授权 health 返回的 `log_file/desktop_log`。
5. 旧文件路径。

- 桌面 spawn sidecar 时只传 `ADM_DESKTOP_LOG=<adm-desktop.jsonl 绝对路径>`；`admAgent.jsonl` 始终使用 server/TUI 规范目录，`ADMAGENT_LOG_DIR` 仅作显式覆盖。
- 复用共享 server 时，桌面调用 `POST /v1/log/source` 注册 `desktop_log`；server 校验路径后保存在内存，health 返回该路径。
- `admAgent logs --source auto` 读取两个规范文件；`admAgent_logs` 工具读取 `admAgent.jsonl` + 已注册 `desktop_log`。

### 4.5 预算

- 每个文件活动 20MB + 3 个备份 = 80MB；两个文件合计约 160MB。
- 启动时和每小时在锁内清理超限备份；活动文件跳过。
- Windows 轮转前 close；rename/delete 失败 best-effort 写 `log.writer.error`，不能静默。

## 5. 级别与隐私

### 5.1 级别

| 级别 | 事件 | 默认 |
| --- | --- | --- |
| `error` | 失败终态、panic、进程死亡、用户可见错误 | 始终 |
| `warn` | 重试、降级、guard、SSE 断开、慢工具、unreachable | 始终 |
| `info` | turn/tool 起止、step 请求摘要与响应、压缩摘要、SSE attach/detach、交互权限、进程生命周期 | 始终 |
| `debug` | llm request 细节、自动权限 check、Hook allow、LSP RPC、UI perf | 仅详细模式 |
| payload | 完整 messages/tools/body | 默认关闭；显式开启后仍写同一文件 |

优先级：`--debug` > `ADMAGENT_LOG_LEVEL` > `options.log_level` > Info。桌面 `Settings.debug_logging` 控制 Info/Debug；WARN/ERROR 始终写。

`/v1/log/level` 为进程级全局操作，记录 `log.level.change`，仅本地/授权访问。

### 5.2 隐私

默认允许：ID、模型/provider host、工具名、错误码、HTTP 状态、耗时、token/字节计数、路径哈希、配置键名、稳定错误分类。

默认禁止：`prompt/messages/content/tool_input/command/stdout/stderr/body/raw/config_value`。

同一 JSONL 内的敏感例外：

- `proc.panic` / `http.panic`：可有 `stack`，脱敏、≤32KB、`sensitive=true`。
- `ui.error`：message 默认可见；stack 脱敏、≤32KB，默认可见，不因含 stack 整条隐藏。
- `raw.line`：可有 `excerpt`，脱敏、≤500 字符、`sensitive=true`；完整原文仅 `raw.payload` 且 payload 模式开启。
- `llm.payload`：可有分块 `payload`，`sensitive=true`，默认关闭。

其他规则：

- `err.text` 只保留脱敏稳定摘要；不记录 provider 原始 body、hook stderr、LSP log tail、panic value。
- 权限命令只记 `command_hash/executable/arg_count/cwd_hash`；`known_flags` 只记 flag 名，不记值。
- iLink 只记 hash/bytes；工作区/源码/cwd 绝对路径默认不记。
- Go/Rust 最终写入前递归脱敏 `msg`、字符串、嵌套 map/array、`slog.Any`；JS IPC 前做基础脱敏。
- `admAgent_logs` 默认排除 raw/payload；`proc.panic` 只返回摘要，不返回 stack；`diagnose` 默认排除 `sensitive=true`，用户同意后加入。
- Unix 目录 `0700`、文件 `0600`；Windows P1 增加当前用户 ACL 加固。

## 6. 事件规格

同一行列出精确事件名；业务事件必须带适用 trace。

### 6.1 日志写入器 / 进程

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `log.writer.start` | info | `log_dir/file/level/payload_enabled/schema` |
| `log.writer.rotate` | info | `from/to/bytes/reason` |
| `log.writer.error` | error | `operation/err/file/dropped` |
| `log.level.change` | info | `from/to/source` |
| `log.payload.enabled`、`log.payload.disabled` | info | `source/reason` |
| `proc.start` | info | `version/commit/arg_count/known_flags/argv_hash/cwd_hash/config_path/os/arch/runtime`；P1 加 `proc_start_token` |
| `proc.heartbeat` | info | `active_turns`；仅有活跃 turn 时每 30s 写 |
| `proc.exit` | info | `reason/uptime_ms/active_turns`；best-effort |
| `proc.panic` | error | `component/stack/stack_sha/panic_kind/sensitive=true` |
| `desktop.app.start`、`desktop.app.exit` | info | `version/os/log_dir/config_path` |
| `desktop.log.migrated` | info | `legacy_file/new_dir/action` |

### 6.2 服务端 / 配置 / HTTP / SSE

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `server.workspace.create.start` | info | `ws/path_hash`；绝对路径仅 opt-in |
| `server.workspace.create.end` | info | `ws/dur_ms/ok/err` |
| `server.workspace.retire` | info | `ws/reason/remaining` |
| `server.client.attach`、`server.client.detach` | info | `ws/client/streams/reason` |
| `server.shutdown.start`、`server.shutdown.end` | info | `reason/workspaces/pending/dur_ms` |
| `config.load` | info | `config_path/fingerprint/ok` |
| `config.change` | info | `keys/source/fingerprint`；不记 value |
| `config.reload` | info | `keys/ok/agent_rebuilt/dur_ms` |
| `config.error` | error | `stage/err` |
| `agent.models.update` | debug | `models/tools/dur_ms/changed` |
| `http.request` | info（非 GET）/debug（GET） | `req/method/route/path_hash/bytes/client` |
| `http.response` | info（非 GET）/debug（GET） | `req/status/dur_ms/bytes` |
| `http.decode_error` | warn | `req/route/content_type/bytes/err` |
| `http.panic` | error | `req/route/stack/sensitive=true` |
| `sse.stream.attach` | info | `ws/client/conn/streams` |
| `sse.stream.detach` | info | `ws/client/conn/reason/dur_ms/events/bytes` |
| `sse.stream.write_error` | warn | `ws/client/conn/err/events_sent` |
| `sse.event.slow` | debug | `conn/type/dur_ms/bytes` |
| `desktop.http.request`、`desktop.http.response` | info/debug | `req/method/path_hash/status/dur_ms/bytes` |
| `desktop.sse.connect` | info | `ws/client/conn/attempt` |
| `desktop.sse.disconnect` | warn | `ws/client/conn/reason/status/dur_ms/events/reconnect_in_ms` |
| `desktop.sse.reconnect` | info | `ws/client/conn/attempt/delay_ms` |
| `desktop.ipc.error` | warn | `command/err` |

HTTP 必须生成/校验 `x-adm-req-id` 并回传；route 用 `r.Pattern`；response wrapper 保留 `Flusher/Hijacker/ReaderFrom/ResponseController`；SSE detach reason 覆盖 `client_closed/server_shutdown/write_error/deadline/stream_eof/unknown`；shutdown 先取消 SSE。

### 6.3 Agent / LLM

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `agent.turn.start` | info | `session/run/turn/model/provider/mode/message_count/est_input_tokens/queue_ms` |
| `agent.turn.end` | info | `outcome/end_reason/terminal_source/steps/dur_ms/queue_ms/token 扁平字段/text_bytes/tool_calls/err` |
| `agent.turn.cancel` | info | `initiator/stage/turn` |
| `agent.turn.requeue` | info | `reason/remaining_ms/from_turn/to_turn` |
| `agent.turn.fold` | info | `run/into_turn/prompt_bytes` |
| `agent.queue.enqueue`、`agent.queue.dequeue` | info | `session/run/turn/queued` |
| `agent.queue.drop` | warn | `session/run/turn/reason` |
| `agent.run.publish_failure` | error | `session/run/turn/err` |
| `agent.title.generate` | debug | `dur_ms/model/outcome` |
| `llm.step.request` | info | `step/model/est_input_tokens/message_count/tool_count/prefix_sha/max_output_tokens` |
| `llm.request` | debug | `model/provider/host/bytes/parameters`；不含正文 |
| `llm.step.response` | info | `step/model/finish_reason/token 扁平字段/cache_hit_pct/text_bytes/reasoning_bytes/tool_calls/dur_ms` |
| `llm.retry` | warn | `attempt/model/provider/host/status/err/delay_ms` |
| `llm.stream.interrupted` | warn | `attempt/step/model/err` |
| `llm.reasoning_fallback` | info | `requested/mapped/reason` |
| `llm.http.error` | warn | `status/provider_code/err`；默认无 body excerpt |
| `llm.output.degraded` | warn | `attempt/budget_tokens/est_output_tokens/output_bytes/text_bytes` |
| `llm.usage.estimated` | debug | `estimated/actual/scale` |
| `llm.payload` | 同一文件 | `payload/payload_seq/payload_total/sensitive=true`；显式开启 |

`llm.step.response` 只由 agent loop 写；`llm/client.go` 不得写同名事件。

### 6.4 工具 / 权限 / Hook / 上下文

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `tool.call.start` | info | `tool_call/tool/step/input_bytes/source`；必须落盘，供 SIGKILL 恢复 |
| `tool.call.slow` | warn | `tool_call/tool/elapsed_ms/threshold_ms` |
| `tool.call.end` | info | `tool_call/tool/dur_ms/result_tokens/compressed/terminal_reason/err` |
| `permission.check` | debug | `tool/decision/source` |
| `permission.request` | info | `permission/tool/command_hash/executable/arg_count/cwd_hash` |
| `permission.resolve` | info | `permission/decision/persistent/source/reason` |
| `hook.run` | info（阻断/修改）/debug（allow） | `hook/event/decision/dur_ms` |
| `hook.error` | warn | `hook/exit_code/err`；无 stderr 原文 |
| `context.compact.start` | info | `reason/context_tokens/limit/cooldown_remaining_ms` |
| `context.compact.summarize` | info | `tier/model/dur_ms/input_tokens/output_tokens/chars` |
| `context.compact.end` | info | `tokens_before/tokens_after/tiers/recent_kept/old_compressed/summary_chars/anchors_chars/facts_chars/estimate_scale` |
| `context.compact.skip` | info | `reason/remaining_ms` |
| `context.guard.trip` | warn | `committed/limit/step` |
| `context.recall` | debug | `query_tokens/results/ranges` |
| `context.truncate` | warn | `message/tokens/reason` |

工具接受时写 `tool.call.start`；not-found、参数错误、cap 丢弃、执行前取消、超时、panic 都必须写 end。MCP/LSP 子系统不得重复写 canonical `tool.call.*`。

### 6.5 LSP / MCP / Skills / Job

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `lsp.server.start`、`lsp.server.ready`、`lsp.server.stop`、`lsp.server.restart` | info | `lsp/child_pid/root_hash/dur_ms/managed` |
| `lsp.server.error` | error | `lsp/err`；诊断时按需读取 LSP 自身日志 |
| `lsp.rpc.error` | warn | `lsp/method/code/dur_ms` |
| `lsp.diagnostics` | debug | `lsp/file_hash/error_count/warn_count/info_count` |
| `mcp.server.connect`、`mcp.server.disconnect` | info | `mcp/transport/tools/dur_ms` |
| `mcp.tool.error` | warn | `mcp/tool_call/err` |
| `skills.discover` | info（变更）/debug（未变） | `count/dur_ms/paths_hash` |
| `skills.load` | info | `name/source/bytes` |
| `job.start`、`job.end`、`job.cancel` | info | `job/kind/dur_ms/outcome/err` |

### 6.6 桌面端 / 模型 / iLink / UI

| evt | 级别 | 必需字段 |
| --- | --- | --- |
| `desktop.server.spawn` | info | `binary_path/arg_count/known_flags/args_hash/child_pid/server_boot/log_dir`；P1 加 `proc_start_token` |
| `desktop.server.reuse` | info | `transport/server_version/server_boot/capabilities`；P1 加 token |
| `desktop.server.health` | debug | `ok/dur_ms/status/server_boot`；P1 加 token |
| `desktop.server.unreachable` | warn | `transport/status/err/dur_ms/last_health_boot`；不判死亡 |
| `desktop.server.stop` | info | `child_pid/server_boot/reason/dur_ms`；正常停止不记 died |
| `desktop.server.replaced` | warn | `old_boot/new_boot/evidence`；P1 加旧/新 token |
| `desktop.server.died` | error | `child_pid/server_boot/exit_code/uptime_ms/restart_attempt/evidence`；P0 仅 `child_exit`，P1 可加 token 匹配的 `pid_dead` |
| `desktop.sidecar.capture` | info | `stream/sidecar_pid/server_boot` |
| `raw.line` | warn/info | `stream/bytes/line_hash/excerpt/sensitive=true`；sidecar 每行直接写 JSONL |
| `raw.payload` | 同一文件 | `stream/line/line_seq/line_total/sensitive=true`；仅 payload 模式，超长分块 |
| `model.start`、`model.ready` | info | `model/model_pid/port/dur_ms` |
| `model.exit`、`model.crash`、`model.restart` | warn/error | `model/model_pid/exit_code/reason_code/auto_restart` |
| `ilink.inbound` | info | `message_hash/bytes/chat_hash` |
| `ilink.forward` | info | `run/prompt_bytes/attachments` |
| `ilink.reply` | info | `run/reply_bytes/ok` |
| `ilink.error` | error | `stage/err` |
| `ui.error` | error | `source/component/message/message_hash/stack/stack_sha`；message/stack 脱敏后默认可见 |
| `ui.route.change` | debug | `from/to/busy` |
| `ui.send` | info | `session/run/attachments/prompt_bytes` |
| `ui.send.timeout` | warn | `run/elapsed_ms/stage` |
| `ui.run_complete` | info | `session/run/ok/error_code/incomplete_todos` |
| `ui.run_complete.fallback` | warn | `session/run/reason` |
| `ui.sse.event` | debug | `conn/type/bytes`；仅关键事件/采样 |
| `ui.perf.render_slow` | debug | `ms/messages/count`；10s 聚合 |
| `ui.perf.long_task` | warn | `ms/sample_hash` |
| `ui.attach` | info | `count/kinds/bytes` |
| `ui.settings.change` | info | `keys`；不记值 |
| `ui.skills.load`、`ui.skills.error` | info/warn | `name/source/err` |

### 6.7 枚举约束

- `permission.check.source`：`allowlist/yolo/hook/sandbox/session/persistent`。
- `permission.resolve.reason`：`granted/denied/cancelled/timeout/session_gone`。
- `hook.run.decision`：`allow/deny/modify`；`tool.call.start.source`：`model/hook/subagent`。
- `config.error.stage`：`read/write/reload/rebuild`；`log.level.change.source`：`flag/env/config/runtime`。
- `desktop.server.stop.reason`：`app_exit/user_stop/restart`；`desktop.server.died.evidence`：`child_exit/pid_dead`。
- `ui.error.source`：`window/unhandledrejection/reportError`。

## 7. 代码改造点

### 7.1 Go

| 位置 | 必须实现 |
| --- | --- |
| `internal/log/log.go` | 自定义 handler；`slog.LevelVar`；共享 `admAgent.jsonl`；跨进程锁；批量 append；轮转；`writer_health`；`debug.SetCrashOutput` JSONL crash writer |
| 新增 `internal/log/trace.go` | trace carrier；detached ctx 复制；turn/attempt 生成 |
| 新增 `internal/log/event.go` | `Event/Error` facade；扁平字段；截断元数据 |
| 新增 `internal/log/redact.go` | 最终 handler 递归脱敏 + allowlist 校验 |
| 新增 `internal/log/recovery.go` | 扫描最后 32MB JSONL；heartbeat/PID/token 判定；inferred turn/tool 终态 |
| `internal/config/load.go` | 新增 `GlobalLogDir`；Windows 返回 `%LOCALAPPDATA%\admAgent\log`，`GlobalLogPath` 改为 `Join(GlobalLogDir, "admAgent.jsonl")`；`ADMAGENT_LOG_DIR` 优先，其他缓存仍走 `GlobalCacheDir` |
| `internal/log/http.go` | 删除（无生产调用） |
| `internal/server/logging.go` | request id、`r.Pattern`、字节统计、状态/耗时、接口保留 |
| `internal/server/proto.go` | SSE conn/attach/detach/计数；shutdown 先取消流 |
| `internal/server/server.go` | ctx-aware log helper；`/v1/health` capability；`POST /v1/log/source` 注册桌面日志路径 |
| `internal/backend/backend.go` | workspace/client/shutdown 事件 |
| `internal/backend/agent.go` | 复制请求 trace 到 detached ctx；TurnFinalizer；失败/panic 终态 |
| `internal/agent/agent.go` | turn 状态机；proc.heartbeat；所有 return/cancel/requeue/fold 终态；压缩事件 |
| `internal/agent/agent_loop_llm.go` | step request/response；tool start/slow/end 全路径；ToolCallFinalizer；重试/guard |
| `internal/agent/coordinator.go` | `UpdateModels` 降噪；401 attempt；subagent trace |
| `internal/agent/decision_turn.go` | 事件名/trace 对齐 |
| `internal/llm/client.go` | 删除重复 `logLLMResponse`；request 摘要；typed retry/stream error；payload 写同一文件 |
| `internal/permission/permission.go` | interactive request/resolve；自动 check；取消/超时终态 |
| `internal/hooks/runner.go` | API 增加 tool_call；hook.run/error |
| `internal/agent/tools/**` | 错误码/terminal reason；重写 `admAgent_logs`；不重复工具生命周期 |
| `internal/lsp/*`、`internal/agent/tools/mcp/*` | 生命周期/内部错误；canonical tool 事件不重复 |
| `internal/cmd/logs.go` | 双文件读取、双 schema、过滤、follow、legacy raw 包装 |
| 新增 `internal/cmd/diagnose.go` | 诊断包 CLI |
| `internal/cmd/root.go`、`server.go` | 级别优先级、payload/env、proc.start/heartbeat/exit |

### 7.2 Rust

| 位置 | 必须实现 |
| --- | --- |
| 新增 `src/common/logging.rs` | 共享 `adm-desktop.jsonl` JSONL writer、UUID boot、seq、跨进程锁、批量 append、轮转、最终脱敏、panic hook |
| writer 队列 | 有界 channel + 写线程；WARN/ERROR 高优先级；drop/error 计数；flush 命令；磁盘满 emergency fallback |
| panic hook | 独立 emergency append，不拿普通 mutex；直接写 `proc.panic` JSONL |
| `src/pages/agent.rs` | HTTP/SSE 结构化；spawn 注入 `ADM_DESKTOP_LOG`（不默认覆盖 `ADMAGENT_LOG_DIR`）；sidecar 每行写 `raw.line` JSONL；child-exit/stop/unreachable/replaced/died 分类；复用 server 时调用 `/v1/log/source` |
| `src/pages/ilink.rs` | `ilink.*`；raw 正文只记 hash/bytes |
| `src/pages/skills.rs` | `ui.skills.*` |
| `src/pages/model_list.rs` | `model.*` 崩溃/重启 |
| `src/lib.rs` | 读取设置前无条件初始化 logger；注册 structured/batch/flush/export 命令 |
| `src/common/agent_http.rs` | `x-adm-req-id`；health capability；传输失败不判死亡 |

### 7.3 JS / Tauri 命令

| 位置 | 必须实现 |
| --- | --- |
| `src/views/agent/log.js` | `log.debug/info/warn/error(comp, evt, msg, attrs, trace)`；自动 `ts_ms/ui_seq/doc/origin=ui`；100ms/50 条批量；WARN/ERROR 立即发送 |
| 新 Tauri 命令 | `agent_debug_log_structured(entry)`、`agent_debug_log_batch(entries)`、`agent_debug_log_flush()`；旧 `agent_debug_log(line)` 保持不变 |
| `src/types.d.ts` | 增加新命令类型 |
| `src/views/agent/sse.js` | 关键事件/汇总；conn/trace；重连/fallback |
| `src/views/agent/store.js` | 删除内联 `_log`，统一 log.js |
| `send.js/session.js/workspace.js` | 用户动作带 trace；失败 `log.error` |
| `ui.js` | `reportError` 写 `ui.error`；stack 脱敏后进入同一 JSONL |
| `src/index.html`、`agent.js` | `window.onerror`、`unhandledrejection`；`visibilitychange/pagehide` best-effort flush；路由事件 |

## 8. 查询与诊断接口

### 8.1 `admAgent logs`

```
admAgent logs [--tail 1000] [--follow]
              [--source auto|server|desktop|sidecar|panic|payload|all]
              [--log-dir DIR] [--file PATH]
              [--since 30m|RFC3339] [--until ...]
              [--level debug|info|warn|error]
              [--evt exact.name|glob.*] [--session S] [--run R] [--turn T]
              [--boot B] [--req R] [--grep PATTERN]
              [--json] [--summary] [--trace] [--all]
```

- `auto` 读取 `admAgent.jsonl` + `adm-desktop.jsonl`，按 `ts_ms` 合并；默认排除 raw/payload，panic 保留摘要；`sidecar/panic/payload` 通过 `evt/sensitive` 过滤，不依赖额外文件。
- 双 schema 读取：旧 Go JSON、旧桌面文本、新 JSONL；旧 raw 文本包装为 `raw.line`。
- 过滤在扫描期执行；限制最大扫描字节与内存。
- `--follow` 保存 offset，处理轮转、partial line、重开、去重；P0 单文件，P1 多文件。
- 输出报告 `scanned/skipped/missing_sources/clock_uncertain`。

### 8.2 `admAgent_logs` 工具

```json
{"lines":50,"since":"30m","level":"warn","evt":["llm.retry","tool.call.end"],
 "session":"s_9f3","run":"r_77","source":"auto","format":"compact"}
```

- 默认 scope 当前 workspace/session；跨 session 显式参数并审计。
- 读取 `admAgent.jsonl` + server 已注册的 `desktop_log`；路径校验，拒绝 symlink escape。
- 默认排除 raw/payload；`proc.panic` 只返回摘要；最多 100 条/64KB。
- 返回 `missing_sources/legacy_lines/truncated`；证据不足时明确返回「不足以判断」。

### 8.3 `admAgent diagnose`

```
admAgent diagnose [--since 30m] [--session S] [--out adm-diagnose.zip]
```

- 桌面端优先调用 sidecar CLI；旧/死 server 用 Rust fallback，共用同一收集规范。
- 打包：`report.md/logs/config-summary.json/env-summary.json/manifest.json`。
- 默认排除 `sensitive=true`；导出前预览数据类别与脱敏结果，用户同意后加入。
- 路径校验、symlink 拒绝、zip 权限、临时文件清理。

### 8.4 HTTP 契约

- `POST /v1/log/source`：请求 `{"desktop_log":"<绝对路径>","boot":"<UUID>","schema":1}`；server 校验后保存内存注册，返回 `{"ok":true}`。
- `GET /v1/health`：返回 `schema_version/boot/pid/role/log_file/desktop_log`；P1 加 `proc_start_token`，P2 加 `log_level/payload_enabled/writer_health`。
- 路径字段仅本地/授权调用方可见；TCP 对外不返回路径。

## 9. 实施顺序

### P0：双文件、锁、终态、可查询

- [ ] schema v1 + `doc/admAgent-log-schema.json`。
- [ ] Go `internal/log`：handler/trace/finalizer/recovery/共享文件/跨进程锁/批量 append/轮转/基础脱敏。
- [ ] Go 核心事件：turn/tool start+end/step/tool slow/permission interactive/retry/SSE conn+bytes/process+heartbeat/panic；工具终态覆盖全部原因。
- [ ] `/v1/health` 基础 capability + `POST /v1/log/source`。
- [ ] Rust `common/logging.rs`：共享文件、跨进程锁、批量 append、轮转、panic hook、writer queue、基础脱敏。
- [ ] 桌面 child-exit 与 stop/unreachable/replaced/died 分类；P0 只依赖 `child_exit`。
- [ ] JS structured/batch/flush、全局错误捕获、pagehide flush。
- [ ] `admAgent logs` v2 双文件 + 双 schema + 基础过滤；`admAgent_logs` scope/filter。
- [ ] P0 故障测试：finalizer 去重、SIGKILL JSONL 恢复、32MB 扫描上限、心跳租约、并发写/轮转、锁竞争、旧 schema、网络失败只记 unreachable、正常 stop 不记 died。
- [ ] 同阶段文档与 `AGENTS.md` 更新。

P0 验收：A1、A2、A5、A6、A8、A10。

### P1：补全、隐私、性能

- [ ] provider/tool/permission/hook 错误码分类与错误文本治理。
- [ ] config/model/iLink/LSP/MCP/job 事件补齐。
- [ ] HTTP/SSE 细节：route/query 脱敏、ResponseController、shutdown 顺序。
- [ ] `proc_start_token` 与 PID 复用安全判定。
- [ ] payload/raw/panic 同文件敏感事件治理、隐私语料扩充、Windows ACL。
- [ ] 多文件 follow、gzip/legacy raw 读取、磁盘满/panic-in-lock/Windows 轮转测试。
- [ ] 日志开销 benchmark 与噪音聚合。

P1 验收：A3、A4、A7、A9。

### P2：诊断交付与运行时控制

- [ ] `admAgent diagnose` + 桌面导出 + 同意/预览。
- [ ] `/v1/log/level` 进程级审计；health 增加级别/payload/writer_health。
- [ ] eval 日志断言、9 类故障 fixture、文档 schema/配方。
- [ ] 可选 `log-diagnosis` skill。

P2 验收：诊断包可用；运行时改级可审计；9 类 fixture 纳入 eval 回归。

## 10. 验证

### 10.1 命令

| 改动 | 命令 |
| --- | --- |
| Go 构建 | `cd admAgent && go build ./...` |
| Go 全量单测 | `go test ./internal/... -count=1` |
| 日志/读取器单测 | `go test ./internal/log/... ./internal/cmd/... -run 'TestLog|TestRedact|TestRecovery|TestFilter|TestTurnFinalizer|TestToolCallFinalizer' -count=1` |
| 前端类型 | `pnpm typecheck` |
| Rust | `pnpm tauri build`（或 `cargo check --manifest-path src-tauri/Cargo.toml`） |
| agent 行为回归 | `admAgent/scripts/eval.ps1` / `eval.sh` |

### 10.2 必须测试

- schema golden：扁平字段、保留字段冲突、`truncated` 类型、`sensitive` 约束。
- trace：detached context、并行工具隔离、hook/permission tool_call。
- finalizer：正常/取消/panic/backend fallback 去重；requeue/retry 保留 turn。
- SIGKILL：heartbeat、32MB 扫描、inferred turn/tool 终态、重复恢复抑制。
- 并发写入：多进程同时 append、锁竞争、批量 flush、轮转后无旧句柄写入。
- 读取器：旧 Go JSON、旧桌面文本、新 JSONL、malformed、gzip、legacy raw、partial line。
- 隐私：provider key/JWT/cookie/密码入命令/prompt 含密钥/provider 回显/签名 URL/stack/raw/payload。
- 轮转：Windows rename、磁盘满、panic during write、pagehide flush。
- 性能：p50/p95/p99 日志开销、锁等待、典型 turn Info 行数、正常负载 queue drop=0。

### 10.3 手动故障演练

1. 杀 owned server：died + SSE detach + inferred terminal；断网只记 unreachable；正常 stop 只记 stop。
2. provider 401/429：typed retry + turn end error code。
3. 工具超时/权限拒绝：tool end + permission resolve/check。
4. reasoning 退化：reasoning_bytes + output.degraded。
5. 压缩：tier token 前后对比。
6. 退出再启动：旧 boot 日志可查，新 boot 区分。
7. 两会话并行：trace 不污染。
8. 关闭详细模式后报错：WARN/ERROR 仍落盘。
9. Windows `Program Files` 安装：日志写用户目录。
10. 共享 server：桌面/TUI 合并、死亡判定不误报、TCP 不泄露路径。

## 11. 验收标准

| # | 标准 |
| --- | --- |
| A1 | 可恢复 turn 恰好一条权威 end；SIGKILL 后从 JSONL 补一条 inferred end，带 `prev_boot` |
| A2 | 每个接受工具恰好一条 end；SIGKILL 后补 inferred end；终态原因覆盖完整枚举 |
| A3 | 交互权限 request/resolve 配对；自动决策有 check；取消/超时有终态 |
| A4 | provider retry/stream interrupt 有 typed event，带 model/provider/host/attempt；HTTP 失败有 status/code |
| A5 | SSE 有 conn + attach/detach + 计数；owned child 死亡有 died；传输失败/正常 stop 不误报 |
| A6 | `admAgent logs --session` 合并 `admAgent.jsonl` + `adm-desktop.jsonl`；缺失来源明确报告 |
| A7 | 默认禁止 raw content；敏感例外均为 `sensitive=true`；隐私语料通过；payload 默认关闭 |
| A8 | 两个日志文件并发写入/轮转安全；强制轮转后合计 ≤160MB |
| A9 | 9 类故障 fixture 有预期事件链；查询可返回「证据不足」 |
| A10 | `admAgent_logs` 默认按当前 workspace/session 返回双文件有界时间线，并标注缺失/旧 schema |

## 12. 兼容与文档同步

- 旧 `agent_debug_log(line)` 保持不变；新增 structured/batch/flush 命令。
- 桌面 logger 在读取 `debug_logging` 前无条件初始化。
- 读取器同时支持旧 `time/level/source` 与新 `ts/lvl/src`；旧文件只读保留。
- 新 schema 对原始日志消费者是破坏性变更；仓库内读取器与文档必须同阶段更新。
- 环境优先级：`ADMAGENT_LOG_DIR` > `ADMAGENT_CACHE_DIR` > XDG/平台默认；`ADM_LOG_DIR/ADM_DESKTOP_LOG` 为桌面覆盖。
- 桌面检查 health capability；旧 server 走兼容路径并记录 warning；验收仅在双端升级后进行。
- 同阶段更新：`doc/conventions.md`、`doc/admAgent-server.md`、`doc/rust-backend.md`、`doc/frontend-agent-conventions.md`、`doc/server-api.md`、`AGENTS.md`。

## 13. 完成定义（DoD）

- [ ] P0/P1/P2 对应验收项全部通过。
- [ ] 9 类故障均可通过固定查询得到证据链或明确「证据不足」。
- [ ] 默认日志不含 prompt、工具入参、命令、密钥、原始 stderr/body；敏感例外均为 `sensitive=true`。
- [ ] 最终只有 `adm-desktop.jsonl` 与 `admAgent.jsonl` 两个日志文件（锁文件与轮转备份不计为独立日志）。
- [ ] 多进程并发写入/轮转、跨重启恢复、Windows ACL 通过测试。
- [ ] `admAgent logs`、`admAgent_logs`、`admAgent diagnose` 行为与本规格一致。
- [ ] 所有契约文档与 `AGENTS.md` 已同步，无待决问题。
