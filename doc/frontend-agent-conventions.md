# Agent 视图前端约定（桌面端）

> 范围：`src/views/agent/` 的错误处理、自动续跑、假完成检测、拖拽选择保护，以及同目录多会话并行的前台状态模型。

---

## 前端错误处理（Agent 视图，`src/views/agent/`）

- **统一提取**：所有服务端错误（API invoke 抛错、SSE 事件内嵌 error）先用 `error.js` 的 `getErrorMessage()` 提取可读文本（兼容 string / Error / `{"error":{"message","type"}}` / 其它对象），再用 `classifyError()` 分类（quota/timeout/network/not_found/cancel/unknown）。
- **统一展示入口**：错误统一走 `ui.js` 的 `reportError(err, { prefix, hint })`，内部自动提取+分类：quota（401/余额/授权）类直接显示"余额不足，任务中断"，其余显示原始错误；三档 UI 为 `showNotice(msg, level)`（error 红 / warn 黄 / info 灰），消息区节点 3s 自动消失，`showError/showWarning/showInfo` 是薄封装。
- **禁止** `showError("前缀: " + e)` 直接拼接错误对象（对象会显示 `[object Object]`）；应把**原始错误**传给 `reportError(e, { prefix })`。本地状态提示（无服务端错误对象，如"文件过大"、轮数上限）才直接用 `showError/showWarning` 字符串。
- **SSE 错误路径**：`run_complete` / `agent_event` 内嵌 error 均走 `reportError`，不要在 sse.js 里自行实现 formatRunError/isQuotaError（已在统一模块）。
- **模型不支持关闭思考**（`error.js` 的 `ERROR_THINKING_UNSUPPORTED`）：provider 同时拒绝 `reasoning_effort:none` 与 `thinking.disabled` 时，admAgent 返回 400，文案以 **`thinking_mode_unsupported`** 开头（前后端契约 token，`internal/llm/client.go` 产出、`client_test.go` 锁定，改文案须保留）。桌面端按该 token 分类（早于 network 匹配——被包裹的 provider 原文含 "Upstream request failed"），提示"本模型不支持关闭思考，请切回思考模式"并**中断本轮**；既不自动恢复默认档，也不静默去掉参数继续跑。
- **假完成/静默停止检测**（`sse.js` `detectFakeCompletion`）：本轮有 edit/write/multiedit/bash/lsp 等副作用工具调用、但工具调用总数 ≤4、且 prompt 含操作动词（部署/修复/重构…）时，`showWarning` 提示"任务可能未完整执行"（服务端重试耗尽后 run_complete 无 error 静默结束的兜底）。
- **自动续跑进度判定**（`autocontinue.js` `maybeAutoContinue(data, runStats)`）：本轮有 edit/write/bash 等实质副作用工具**成功落地**（`runStats.sideEffectSuccess > 0`）视为有进展、不计无进展，避免"模型在干活但没标 todos"被误熔断。

## 运行态交互约定

- **同目录多会话并行**（桌面端，`agent_concurrent_sessions` **默认关**，需在 Agent 设置→基础设置里手动开启；并发上限 3）：服务端运行态本就按会话隔离（`activeRequests`/`messageQueue`/`cancelMark`/`sessionMu` 均以 sessionID 为键），并行无需服务端改动，由桌面端状态模型与开关控制。`store.js` 按会话登记运行：`runs`（sessionId→活动运行）、`queued`（sessionId→排队轮次数组，FIFO）；`S.activeRun`/`S.queuedRun`/`S.runStats` 是 `currentConvId` 的**派生视图**（沿用旧语义=「当前打开会话的运行」），`S.isSending`=「本工作区有任一运行在飞」，`S.runs` 供会话列表/状态栏标识（workspace 状态池快照会带上 `runs`，切回工作区即恢复）。`run_complete` 只注销发起它的会话（`store.handleSSEEvent` → `completeRun(wsId, sessionId, runId)`，run_id 不匹配= 迟到的旧事件直接丢弃，避免误清新一轮），非当前会话的完成只刷新列表（`sse.js` 用处理前快照 `ctx.prevRuns` 判定归属）。开关与上限在**附件/PDF 转换之前**判定（否则已转换的 PDF 批次会被静默丢弃）；关闭时其它会话运行期间拒绝新会话发送（旧的"跨会话排队"是客户端假象——服务端早就并发跑了）；同会话内不可折叠的轮次（决策轮/分批发送）仍登记为 `queued`。写冲突护栏：`edit`/`write` 的读后写守卫跨会话天然生效（mtime > 本会话 lastRead 即要求重读），撤销按钮在并行运行期间被前端拦下（服务端 undo 是整仓库回滚）。服务端侧防护已落地（admAgent：`SessionAgent.ActiveSessionIDs` + `coordinator.Undo` 并发拒绝、`internal/agent/tools/filelock.go` 按路径写锁、`filetracker.RecordWrite/LastWriteBy` + 写前跨会话提示），详见 `doc/admAgent-parallel-sessions-file-guards.md`；admAgent 改动需重编译推送 sidecar 才在 ADM 生效。
- **前端自动续跑**（`src/views/agent/autocontinue.js`）：本轮正常结束但 todos 未完成时自动发“继续”开新轮（每轮重置服务端 nudge 预算）；上限 10 轮、连续 2 轮无进展自动停；仅续跑本客户端发起的任务；出错、取消、切走会话均不触发；开关存 localStorage（`agent_auto_continue`，默认开）。
- **拖拽选择保护 / 主线程停顿看门狗**（桌面端）：在消息区按住左键拖拽选择文字期间，`render.js` 的 `beginSelectGuard` 暂停流式 DOM 写入与自动滚底（`renderMessages` 只置待渲染标记、`scrollChatToBottom` 直接返回），抬键（window 捕获 mouseup）/失焦/10s 超时后补渲染一次；消息区 `dragstart` 拦截“从已有文字选区发起的原生拖拽”（图片除外）。原因：WebView2/Chromium 在拖拽选择期间变更 DOM + 程序化 scrollTop 有触发输入卡死的已知回归（crbug 559347435 / 559795247 / 41327805）。`agent.js` 的看门狗每秒采样定时器漂移，>2s 记 `PERF` 调试日志：界面无响应但无停顿记录 = WebView2 输入卡死（上游问题，需更新运行时），有记录 = 前端长任务阻塞。
