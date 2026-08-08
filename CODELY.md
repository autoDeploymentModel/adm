

## Codely Structured Memories

### User

### Feedback
- [2026-08-08 10:06:37] User decided to scope the work directory switching feature to the Tauri desktop app only. The TUI (admAgent/) should NOT have work directory switching — it only displays the current working directory via PrettyPath in the sidebar. All switching/dropdown/add/remove UI is desktop-only (src/ + src-tauri/). - Before making any code changes, always tell the user whether the change targets the desktop app (src/ + src-tauri/) or the TUI (admAgent/). Never mix the two without explicit instruction.
- [2026-08-08 17:37:12] AGENTS.md 必须与代码保持同步。任何架构/流程变动后，都要及时更新 AGENTS.md 中对应描述，避免文档与实际代码脱节。复杂问题排查需要日志时，统一写入 adm_api_debug.log，前端用 log.js 的 log.debug(category, msg)（category: STORE/SSE/SEND/WS），Rust 端用 api_debug_log!，格式 [CATEGORY][level] message。log.js 默认静默（currentLevel=99），由 agent.js init 中 setLogEnabled(!!S.settings.debug_logging) 开启；log.js 直接用 window.__adm_invoke 不依赖 store.js（避免循环依赖）。



### Project
- [2026-08-08 10:06:41] Project structure: admAgent/ = Go TUI (Bubbletea/lipgloss) AND the shared backend server (Go). src/ + src-tauri/ = Tauri desktop app (vanilla JS frontend, Rust backend). The Go server in admAgent/ is shared by both frontends. buildAgent/ = build tools, website/ = marketing site, scripts/ = utility scripts.
- [2026-08-08 10:52:11] WeChat Bot should follow the current active workspace tab. When user switches tabs, WeChat messages route to the new active workspace's agent. Old workspace continues running independently in background.
- [2026-08-08 16:10:31] admAgent server "卡住"已修复：根因是桌面端多 workspace SSE 管理问题（agent_subscribe_events 无条件 abort 活任务导致 server 自杀循环、client_id 不匹配导致 current-session 404、create_workspace 不复用活 SSE 任务导致僵尸任务重复投递事件、run_complete 被非当前 tab 过滤丢弃导致 isSending 永不清除、S.activeWsId init 时未设置导致状态池 S.workspaces[wsId] 始终 undefined 后台事件无法更新）。加诊断日志后实测 readyWg.Wait 0.4ms、UpdateModels 2-4ms，确认 admAgent 服务端无性能瓶颈。admAgent coordinator.go 中加的诊断日志（UpdateModels/readyWg/buildTools/agentTool 耗时）目前保留待定。
- [2026-08-08 17:37:17] - [2026-08-08 17:36:00] 多 workspace 前端状态管理重构完成：state.js 已废弃（所有导入迁移到 store.js），store.js 中 S 改为 Proxy — 对 workspace 字段（conversations/currentConvId/currentConv/messages/isSending/activeRun/queuedRun/runStats/contextUsage/agentInfo）的赋值自动同步到 active workspace + 快照，消除手动 syncWsFromS 遗漏风险。bindToS 期间用 _suppressSync 抑制逐字段触发。workspace.js switchToWorkspace 中需在 store.setActive 之前用 store.workspaces.has(wsId) 判断首次访问（setActive→registerWorkspace 会创建空快照导致 S.workspaces[wsId] 永远 truthy）。

### Reference

