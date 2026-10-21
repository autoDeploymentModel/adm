# admAgent 上下文压缩（Compaction）机制与详细流程（审核稿）

> 用途：把当前**已实现**的压缩机制完整摊开，供逐条审核。
> 范围：服务端 `admAgent/internal/agent` + `admAgent/internal/context`（桌面端只负责发 `/summarize` 请求，不含压缩逻辑）。
> 代码基线：本文件中的行号对应当前工作区源码；改动后请同步更新本文与 `doc/admAgent-server.md` 第 7 节。

---

## 0. 一句话结论

压缩不是"把历史丢给模型总结一次"，而是**三层防线 + 五条 Rail**：

1. **入口压缩**（每一步的工具结果，单条过大就立刻压掉，不落历史原文）；
2. **发送前守卫**（整个请求超过上限才触发压缩，不在每轮无脑跑）；
3. **分层摘要 + 确定性记忆**（压缩时按"近轻远重"两档抽象，同时把 anchor / facts / 归档编号钉进摘要前缀，原文进 Rail 3 归档供 `recall` 取回）。

手动 `/summarize` 走同一条 `Summarize` 流水线，只是跳过冷却之外的触发判定。

---

## 1. 设计模型：五条 Rail

`internal/context/manager.go:22` 的注释定义了分工，理解压缩必须先有这个模型：

| Rail | 名称 | 载体 | 谁负责 |
| --- | --- | --- | --- |
| 0 | 受保护锚点（constraints/goals/decisions…） | 会话内 `AnchorStore`，渲染成 `## Persistent Anchors` 块钉在摘要前缀 | `context.AnchorStore` |
| 1 | 工作记忆（当前上下文） | 未被标记压缩的消息 | 调用方（`sessionAgent`） |
| 2 | 情节摘要（episodic summary） | 一条 `IsSummaryMessage` 消息，处于上下文首位 | `sessionAgent.Summarize` |
| 3 | 检索归档 | `rail3.db`（SQLite），带 `#N` 编号 | `context.Manager` + `SQLiteStore` |
| 4 | 外部化状态 | 摘要里的 anchor/facts 块、`project_memory.json` | `context` 包 |

外加两层跨会话记忆：

- **事实块 `[Session Facts]`**（`internal/context/facts.go:23`）：代码抽取，模型不参与。
- **项目记忆 `## Project Memory`**（`internal/context/project.go:11`）：只同步 durable 的 constraint/decision，每个会话每一轮都注入。

---

## 2. 参数表（全部按上下文窗口 `cw` 派生）

| 项 | 公式 / 值 | 代码位置 |
| --- | --- | --- |
| 输入上限 guard | `cw × 70%`；`cw ≤ 65536` 时 `62%` | `agent.go:568` `contextLimit` |
| 压缩阈值 | `options.max_summarize_tokens` > 0 用它；否则同 guard | `agent.go:929` `summarizeLimit` |
| 等效窗口 | 配置阈值反解成窗口（`阈值/ratio`，超过真实 `cw` 则夹到 `cw`），让所有派生量跟着阈值走 | `agent.go:943` `sizingContext` |
| 压缩落点 | `(guard − 固定开销) × 0.85` | `agent.go:184` `compactionTargetBudget` |
| 固定开销 | 工具 schema + 系统提示 + 提示前缀 + 项目记忆 | `agent.go:3339` `fixedRequestOverhead` |
| 保留尾部预算 | `min(落点 − 2×摘要上限 − 开销/20, 可用预算 − 2×摘要上限 − 保留工作窗口)`，下限 512 | `agent.go:335` `recentTailBudget` |
| 保留工作窗口 | `min(25k, 可用预算/2)` | `agent.go:361` `reservedWorkWindow` |
| 保留消息条数 | `cw/8192` 夹到 `[4,12]`，再被 `(guard−开销)/4096` 夹（下限 2）；**再**按 token 预算从新到旧截断 | `agent.go:235` / `agent.go:282` |
| 摘要输出上限 | `cw × 5%`，夹到 `[512, 3072]`；`cw ≥ 128000` 时上限 6144 | `agent.go:481` |
| 工具结果上限 | `cw × 3%`，夹到 `[512, 2000]`；`≥128k` 时 3000 | `agent.go:504` |
| 入口压缩阈值 | `cw × 6%`，夹到 `[2000, 12000]` | `agent.go:534` |
| anchor 预算 | `cw × 0.5%`，夹到 `[512, 2048]` | `agent.go:552` |
| 项目记忆预算 | 1024 token | `project.go:36` |
| 事实块长度 | 600 字符，每类 10 条，commit 8 条 | `facts.go:30-34` |
| 分层保留率 | 近档 0.4，远档 0.15 | `agent.go:75-76` |
| 压缩冷却 | 同会话 30s | `agent.go:108` |
| 连续无进展上限 | 4 次；跑满 3 步算"有进展"并重置 | `agent.go:90`、`agent.go:214` |
| 被动召回配额 | `min(阈值 − 已提交, cw × 8%)`，单条 `cw × 1.5%` | `agent_loop_llm.go:1826-1835` |
| token 估算 | 统一 `internal/tokencount`：ASCII 字节/4，非 ASCII rune 计 1 token | `internal/tokencount/tokencount.go` |
| 归档条目上限 | 单条 4000 token（超出加截断标记，全文留在 `admAgent.db`）；工具调用参数 1200 | `internal/context/archive_text.go` |
| 手动召回 | `range` 20 条/页、`expand` ≤5 条、单条上限 `recallRefEntryTokens`=1200、总预算 2000 | `recall_tool.go:20-41` |

> 落点 0.85 与"尾部预算自己也要留工作窗口"是两处刻意错位的保险：压缩完必须落在 guard 之下**足够远**，否则每一步都重新撞线（本地模型实测每次压缩 15–70s）。

---

## 3. 三条触发路径

### 3.1 入口压缩（每一步、每个工具结果）

`agent_loop_llm.go:1411-1441`：

1. 工具返回后估算 `approxTokenCount(resp.Content)`（`(len+3)/4`，中文会高估，方向安全）。
2. 超过入口阈值（6%，上限 12k）→ `compressToolResult`（`agent.go:2625`）：
   - 结构切分：头 25 行、尾 25 行、最多 50 行含 error/warning/stack 关键字的"信号行"**原样保留**；
   - 只有中段送给 LLM 做抽象摘要（`MaxTokens` = 工具结果上限），带 `[compressed tool output, ~a→b tokens]` 标记。
3. 摘要失败（provider 错误、取消）→ `truncateToolOutputDeterministically`（`agent.go:425`）确定性截断，**绝不**让原始大输出进历史；再兜不住就 `clipMiddleToTokens` 保留首尾各半。
4. 压缩后的文本才 `messages.Create` 落库并进入下一步的 wire 请求。

### 3.2 发送前守卫（主循环每一步）

`agent_loop_llm.go:561-643`：

1. 组装 `committedTokens`：提示前缀 + 系统提示 + 项目记忆 + 全部历史消息 + nudges + **工具 schema** + 本步召回块。
2. 用上一步 provider 返回的真实 `anchoredInput` 做锚定：`anchoredInput + 增量 + nudges 增量 + 召回增量`，取 `max(重算值, 锚定值)`——锚定只能抬高估计，不会被 char/4 的低估骗出"虚假余量"。
3. 若 `committedTokens > summarizeLimit(cw)`：
   - `shouldSummarize = true`；
   - `noteGuardTrip(sessionID, stepIdx+1)` 记录"撞线前跑了几步"；
   - **break 出主循环**，本步不发请求，也不创建 assistant 消息。

### 3.3 手动 / API

`POST /v1/workspaces/{id}/agent/sessions/{sid}/summarize`（`server.go:199`）→ `Backend.SummarizeSession`（`backend/agent.go:184`）→ `coordinator.Summarize`（`coordinator.go:985`）→ `sessionAgent.Summarize`。与自动路径共用同一实现，只是没有 `shouldSummarize` 上下文与重排队。

---

## 4. `Summarize` 详细流程（`agent.go:1956-2429`）

按执行顺序逐步列出，括号内为关键判据。

### 步骤 1：互斥与冷却
- `IsSessionBusy(sessionID)` → 返回 `ErrSessionBusy`（`agent.go:1957`）。
- 读 `lastSummarizeAt[sessionID]`，距上次 < 30s 直接 `return errSummarizeSkipped`（不是 `nil`）：自动路径据此**等完剩余冷却**再重排队（不占 resume 配额），手动 `/summarize` 在 coordinator 层把它当成成功 no-op。
- **先打时间戳再干活**（`agent.go:1988-1993`），失败路径同样受冷却保护，避免失败自旋。

### 步骤 2：取会话与消息
- `sessions.Get` 拿 `currentSession`（含 `SummaryMessageID`、token 计数）。
- `getSessionMessagesWithIndex`（`agent.go:3035`）返回两份东西：
  - **工作上下文**：过滤掉 `IsCompressed` 的消息；若存在 `SummaryMessageID`，把摘要消息**移到 index 0** 并把 Role 改成 `User`（`agent.go:3073-3100`）；
  - **全量有序列表**的消息 id → 会话全局序号 map（`#N` 的编号空间）。
- 同时在这一步从摘要文本里 **回解析** anchor 块与 facts 块（`agent.go:3098-3099`，幂等）。

### 步骤 3：决定"保留"与"压缩"
- `firstUserIdx` = 第一条 user 消息（原始任务目标），**永远保留**（`agent.go:2024-2030`）。
- `recentCount = deriveKeepRecentCount(...)`：先按窗口算条数，再用尾部 token 预算从新到旧走一遍，最少保留 2 条（保证正在进行的工具轮不丢）；预算决定时打 `kept tail truncated to the token budget` 警告。
- 压缩区间：`startCompress = firstUserIdx+1`，`endCompress = len(msgs) − recentCount`，`oldMsgs = msgs[start:end]`。
- `oldMsgs` 为空 → `summarize skipped, nothing older to compress`，直接返回（只有目标和近尾时不压缩）。

### 步骤 4：Rail 0 / Rail 3 / Facts / 项目记忆（`ctxMgr.CompactWithBudget`）

`manager.go:189-319`，顺序很关键：

1. 遍历 `oldMsgs`：
   - 摘要消息 → `ParseAnchorsFromText` + `MergeFromText` 把上一版块合并回 store，然后 `StripAnchorBlock` + `StripFactBlock` 得到"干净文本"；
   - 普通消息 → 进入 `regular` 列表。
2. `Extractor.Extract(regular)` 抽出新锚点（约束/目标/决策/事实…）合并进会话 `AnchorStore`。
3. `FactBlock` 开启时抽取事实：`Summarize` 先调 `Manager.MergeFacts(sessionID, msgs)` 扫描**整个工作上下文**（含保留尾部与即将被 clamp 丢弃的消息），`CompactWithBudget` 内部再对 `regular` 抽一遍（幂等）。从 `edit/multiedit/lsp_replace_symbol` 的 `file_path` 得 Modified，`write` 得 Created，`bash` 的 `git commit -m` + 紧随 tool_result 的短 hash 得 Commits。
4. 项目记忆同步（**在预算裁剪之前**，保证被裁掉的约束仍进项目层）：`m.Project.Sync(anchors.All())`，只保留 constraint/decision；`options.project_memory_sync=false` 时跳过新增（已有条目继续渲染）。
5. `anchors.CompactToBudget(budget)` 裁到 anchor 预算；被裁掉的锚点**降级写入 Rail 3**（`Turn = -1`，渲染成 `- [kind] value` 文本）。
6. 逐条归档 `msgs` 的干净文本：
   - 编号：`indexByMessageID[msg.ID]` → `claimTurn`（被占用则顺延 `max+1`）；会话视图里找不到 → `-1`（不可寻址）；
   - 同时写入 n-gram 索引、实体索引、`rail3.db`；无 store 时进内存 `memEntries`；
   - 记录本次归档的 `#N` 区间。
7. `facts.NoteArchived(min, max)`：归档区间**单调扩张**，早先归档的条目仍可达。
8. 返回 `CompactResult{Anchors, Facts}` 两段待钉入摘要的块。

补充：Read 类别只有 `options.fact_block_read=true` 时才由 `listReadFiles`（filetracker，内存态 10 分钟 TTL）注入，默认关。
`BackfillTurns`（`manager.go:354`）在本次压缩前对"历史遗留的 slice-local 编号"做一次回填，避免旧摘要里的 `#N` 指到错误条目。

### 步骤 5：切分"上一版摘要"与"可压缩原文"
- `prevSummaries`：旧摘要消息——**不再送 LLM**，直接原文搬运（防止 summary-of-summary 逐轮失真）。
- `compressibles`：其余历史。

### 步骤 6：建摘要消息并搬运旧摘要
- `messages.Create(Role: Assistant, IsSummaryMessage: true)`（`agent.go:2158`）。
- `carryForwardSummaries`（`agent.go:2785`）把旧摘要（剥掉 anchor/facts 块后）按新→旧拼起来，超预算从**最旧**开始裁（旧的已被压过最多次，且仍可在 Rail 3 取回）。预算 = `min(摘要上限, 尾部预算)`，下限 `摘要上限/2`。
- 有旧摘要时先 Append + `Update`，并在其后加 `---` 分隔。

### 步骤 7：两档抽象压缩（`summarizeInto`，`agent.go:2504`）
- 把 `compressibles` 对半切：`ancientMsgs`（较老）+ `midMsgs`（较新）。
- 两档提示词都基于 `templates/summary.md`（要求 Current State / Files & Changes / Technical Context / Strategy / Exact Next Steps），再追加档位指令：
  - 远档："Compress aggressively: keep only durable facts…"（保留率 0.15）
  - 近档："Compress lightly: preserve exact paths, identifiers, pending steps…"（保留率 0.4）
- 每档 `summaryTarget = subsetTokens × ratio`，被摘要上限夹住，下限 512，作为 `MaxTokens`。
- 请求结构：`[system: 提示前缀 + summary.md] + 该档消息 + [user: 档位指令]`；**不带工具 schema**。流式 delta 直接 Append 到摘要消息并逐次 `Update`（中断也能留下已生成部分）。
- 取消 → 删除摘要消息后返回；其他错误 → 摘要消息 `AddFinish(Error)` 并返回错误。

### 步骤 8：摘要自身瘦身
- `dedupeSummaryDigest`（`agent.go:375`）：按行去重（保留标题/分隔符/`[` 块等结构行），解决"每轮把同样的决策和文件清单再抄一遍"。

### 步骤 9：钉入确定性前缀
- `pinnedSummaryPrefix(anchors, facts)`（`agent.go:2768`）生成：

```
---
## Persistent Anchors (protected, never compress)
- [constraint] ...
...
[Session Facts]
- Modified: ...
- Archived: entries #1201..#1240 (searchable with the recall tool: range:[1201,1240], expand:[N])
---
```

- Anchor 在前（约束/决策优先于记录），facts 在后；`PrependContent` 到摘要消息并 `Update`。

### 步骤 10：退役旧历史（不删除）
- 对 `oldMsgs` 全部 `MarkCompressed`（`agent.go:2289`）。**不是删除**：完整 transcript 留在 `admAgent.db` 供 UI 回看与统计，只是不再进入工作上下文与 token 统计。

### 步骤 11：超大保留消息定点截断（`truncateOversizedKeptMessages`）

重新读取工作上下文并按 `messageTokenCount`（正文 + reasoning + **全部 ToolResult 正文** + **ToolCall.Input** + 内联文本附件）累计；若仍高于落点水位：

1. 找单条超过 `outlierMessageTokens = max(落点/4, 2×工具结果上限)` 的消息（跳过 index 0 摘要、user 消息、摘要消息）；
2. 先把原文写进 Rail 3：`Manager.ArchiveOriginal`（`Turn=-1`，可 `query` 不可 `#N` 寻址）；
3. 确定性截断正文（`clipMiddleToTokens`，保留首尾）、reasoning（保头部）、工具结果（`truncateToolOutputDeterministically`）；
4. `messages.Update` 落库、重算 token，落到目标水位即停；日志 `Agent: truncated an oversized message kept verbatim instead of re-compacting`（before/after/threshold/target）。

它替代"对同一个超大输出再跑一次两档压缩"：摘要替换的是旧历史，而这条消息在保留尾部，重压一次也不会变小。

### 步骤 12：压缩后兜底裁剪（`clampContextUnderLimit`）
- 重新读取工作上下文，累计 token。
- 目标水位 = `compactionTargetBudget − max(1024, 固定开销/20)`（落点而不是 guard，留出工作窗口）。
- 仍超 → 从**最旧的可丢消息**（跳过摘要、所有 user 消息、最后一条）开始：先 `ArchiveOriginal` 归档（Rail 3，可 `query`），再 `MarkCompressed`，直到落点之下。无可用预算时退化到 `guard/4`。
- 注意：这一步丢的是"保留下来的近尾"里的旧消息，**已经被摘要覆盖**，但**未单独归档**（见 §9 风险 R3）。

### 步骤 13：重算计数 + 闭包检查
- `currentSession.ContextTokens` / `PromptTokens` 用 `estimatePostSummarizePromptTokens`（存活历史 + 工具 schema + 系统提示 + 前缀 + 项目记忆）重算——**不能**用摘要调用自身的输入量。
- 闭包检查：若 `ContextTokens > committedGuardLimit(cw)` → `markCompactionOverGuard`，记一条 error 日志（带 `next_request_tokens/limit/target/recent_kept/recent_tokens/old_compressed`）。
- `sessions.Save` 落库（含 `SummaryMessageID`、`EstimatedUsage`）。

### 步骤 14：交还控制权 / 重排队
- 释放 `activeRequests`；把 summarize 期间排队的消息取出，用 `context.WithoutCancel` 起独立 goroutine 跑 `Run`（带 panic recover），避免把跟随轮次绑死在总结请求的生命周期上。
- 自动路径：`Run` 在 `Summarize` 返回后重新 `sessions.Get` 同步已压缩的计数（`agent.go:1773`），再决定是否重排队：
  - `sig.overGuard` → 直接以"压缩无法落地"的错误结束本轮；
  - `summarizeResumes > 4` → 以"压缩不再买到可用工作窗口"的错误结束；
  - 否则把 resume 提示（**只加一次**）拼到 prompt 前，重新入队继续原任务。

---

## 5. 压缩后的上下文长什么样

```
[0] user  = "---\n## Persistent Anchors…\n\n[Session Facts]…\n---\n" + 旧摘要 + 两档新摘要
[1..n]    = 原始任务目标（首条 user）
[n+1..]   = 原样保留的最近尾部（条数/预算见 §2）
（被 MarkCompressed 的历史只在 DB 里，不进 wire）
```

wire 请求组装（`agent_loop_llm.go:561-623`）：

```
system  = 提示前缀 + 系统提示 + 项目记忆块
...历史（含摘要，作为 user）...
user    = 被动召回块（Rail 3，ephemeral，不落库）
...nudges...
```

召回块放在**末尾**而不是拼进 system，是为了只让尾部失效 prompt cache。

---

## 6. 取回通路（压缩掉的内容怎么找回来）

| 通路 | 触发 | 预算/限制 |
| --- | --- | --- |
| 主动 `recall` 工具 `query` | 模型自己调 | 排序融合（n-gram + 实体 + 可选向量 + LLM 查询改写），RRF 融合；已出现在活摘要里的条目（≥40 字符且被摘要文本包含）会被排除（`SetLiveSummary`） |
| `recall` 工具 `range:[a,b]` | 摘要里 `#N` 区间 | 20 条/页，单条上限 1200、总预算 2000；超预算会点名"哪些被截掉、用 expand 读" |
| `recall` 工具 `expand:[N]` | 摘要里的 `(#1253)` | ≤5 条，单条上限 1200（工具描述写的是 "FULL untruncated"，与实际不符，见 §10 F6） |
| 被动 `RecallStrict` | 每一步自动 | 配额 `min(阈值−已提交, 8% cw)`；阈值：相对得分 <0.3、非实体匹配要求 ≥2 个不同 token 重叠、最多 6 条；已出现在摘要首条 user 文本里的条目不重复注入 |
| 项目记忆 | 每一轮 | 跨会话 constraint/decision，1024 token |

`#N` 的三条不变量（`manager.go:403-460`、`manager.go:348`）：
1. 编号 = 会话内消息序号（`messages.List` 的顺序）；
2. 归档条目永不被删除，编号被占用则顺延 `max+1`（undo 删尾后不会串号）；
3. 每个会话每进程首次压缩前 `BackfillTurns` 回填旧编号，映射不到的置 `-1`。

---

## 7. 失败与熔断

| 场景 | 行为 |
| --- | --- |
| 30s 内重复触发 | 跳过（`summarize skipped, a compaction just ran`） |
| 摘要 LLM 报错 | 摘要消息标 `FinishReasonError`，本轮以该错误结束 |
| 摘要中用户取消 | 删除半成品摘要消息 |
| 压缩后仍在 guard 之上 | `overGuard` → 本轮明确报错："kept verbatim 的消息本身就超预算" |
| 连续 4 次无进展压缩 | 明确报错："压缩不再买到可用工作窗口，请减小单条工具输出或新开会话" |
| 工作窗口过小 | `context window leaves a small work window` 警告，附 `work_window_tokens/fixed_overhead/advice` |
| 尾部被 token 预算截断 | `kept tail truncated to the token budget` 警告（说明历史里有一条超大消息） |
| Rail 3 落盘失败 | 记录警告，不影响压缩（best-effort） |
| 事实块抽取失败 / Read 列表失败 | 记录警告，不失败压缩 |

---

## 8. 观测点（排查时先看这些日志）

`Agent: layered summarize complete` 一行带全部关键量：
`recent_kept / old_compressed / prev_summaries_carried / ancient_tier / mid_tier / recent_tokens / post_history_tokens / schema_tokens / fixed_overhead / summary_chars / anchors_chars / facts_chars / carry_budget / tail_budget / tail_budget_limited / guard_limit / context_tokens`（`agent.go:2350`）。

其他：
- `Loop guard summarize trigger`（step / committed / limit / cw）
- `Agent: compaction could not bring the context under the guard…`
- `Loop tool result`（`tool_result_tokens`、`compressed`、`raw_tokens`）
- `summary digest deduplicated`（dropped_lines）

---

## 9. 审核关注点（我读代码时认为值得确认/有风险）

按严重度排序，均为**当前实现的事实**，不是推测：

- **R1 冷却与失败耦合**：时间戳在干活前写入（`agent.go:1988`）。一次因超大单条消息失败的压缩，会让该会话 30s 内无法再次压缩；叠加 `overGuard` 直接结束本轮，用户体验是"报错后必须等/重开"。是否有意为之？
- **R2 两档压缩是两次独立 LLM 调用**（远档 + 近档），串行、各自带完整 system prompt。大历史下压缩墙钟 ≈ 2 次调用（本地模型 15–70s/次）。可否合并为一次多段提示？
- **R3 clamp 丢弃不归档**（已修归档部分）：`clampContextUnderLimit` 现在先 `ArchiveOriginal` 再 `MarkCompressed`。归档条目 `Turn=-1`，只能 `query`、不能 `expand`，所以这里丢掉的内容仍不可按 `#N` 精确定位；它只应命中"被摘要覆盖的尾部"，尾部预算算错时仍可能丢掉未总结的内容。
- ~~R4 摘要逐 delta 落盘~~ **已核实为非问题**：`message.service.Update` 对非终态更新走 debounce（`message.go:233-289`），流式 delta 只在内存合并，终态才同步落盘，`FlushAll` 收尾。
- **R5 `carryBudget` 下限可能高于尾部预算**：`carryBudget` 先取 `min(摘要上限, 尾部预算)`，再抬高到 `摘要上限/2`（`agent.go:2190-2196`）。小窗口下可能出现"搬运的旧摘要比尾部预算还大"，把落点顶高。
- **R6 事实块 `Read` 依赖内存态 filetracker（10 分钟 TTL）**：跨会话重启后 Read 类别会缺失；默认关，但开启后的事实块不是完全确定的。
- **R7 `#N` 编号空间包含被压缩消息**：编号是会话全局消息下标，因此摘要里出现大号 `#N` 属正常；但 undo 后编号顺延会造成"区间不连续"，`range` 会返回稀疏集合（已按 `Total/First/Last/Dropped` 如实报告，不是 bug，但需要用户侧文案配合）。
- **R8 项目记忆只写不删**：`project_memory.json` 只有 salience 裁剪与 upsert，没有"决策被推翻"的显式删除通道；错误决策会一直注入到被更低 salience 顶掉为止。
- **R9 被动召回与守卫共享限额**：召回块计入 `committedTokens`，大召回可能自己把请求推过 guard，从而触发一次压缩（而不是降低召回）。当前配额 8% 通常安全，但与"入口压缩阈值下限 2000 / 单条 600 token"这几个常数强耦合。
- **R10 `summary.md` 要求"Err on the side of too much detail"**，与 3072/6144 的输出上限、`dedupeSummaryDigest` 的降重是相反的力；实测是否经常撞上限值得确认。

---

## 10. 二次审核：新增确认的缺陷（按严重度）

### F1（高，已修）Rail 3 实际从未归档工具输出与工具调用参数

证据链：

1. 归档文本只取 `msg.Content().Text`（`manager.go:195`）；
2. `Content()` 只返回第一个 `TextContent`（`message/content.go:384-391`）；
3. 工具消息的 `Parts` 只有 `ToolResult`（`agent_loop_llm.go:1361-1362`、`:1500-1501`），因此 `Content().Text == ""`，被 `if text == "" { continue }`（`manager.go:264`）整条跳过；
4. 助手消息的工具调用参数在 `ToolCall.Input`，同样不在 `TextContent` 里。

后果：

- 编码会话里最有价值的内容（`view`/`grep`/`bash` 输出、`edit` 的 old/new 字符串）压缩后**不可 recall**；
- `[Session Facts]` 的 `Archived: #a..#b` 与实际存在条目的集合是稀疏的（锚点条目还是 `Turn=-1`）——
  也就是说摘要里的 `#N` 指向的条目里，大量是"叙述文本"，工具细节从未入库；
- 被动召回（`RecallStrict`）同样只能召回叙述文本。

> 这条与 `manager.go:162-165` 的注释（"archives the full text of those messages"）不符，属实现缺口而非设计意图。

### F2（高，已修）两套 token 估算器不一致，中文最多被低估约 4 倍

| 估算器 | 公式 | 中文实际 | 使用位置 |
| --- | --- | --- | --- |
| `agent.approxTokenCount` | 字节/4（`usage_fallback.go:172`） | ≈0.75 token/字 | 守卫、尾部预算、日志、摘要/工具 caps |
| `context.approxTokens` | rune/4（`retrieval.go:336`） | ≈0.25 token/字 | recall 预算、per-entry 截断 |
| `AnchorStore.CompactToBudget` | `len(renderAnchors)/4`（`anchor.go:239`） | ≈0.75 token/字 | anchor 预算 |
| `truncateRunesToTokens` | `tokens×4` runes（`manager.go:956`） | ≈4 字/token | range/expand 单条上限 |

后果：所有"token 预算"对中文宽松 3–4 倍（摘要上限、工具结果上限、anchor 预算、recall 单条 1200、尾部预算），而守卫侧字节/4 又低估真实用量（真实 ≈1–1.5 token/字），出现"预算说没超、provider 侧却超"或"压完仍然撞线"。

参考已有的正确实现：`outputDegradationDetector.tokens`（`agent_loop_llm.go:256-258`）用 `ascii/4 + 宽字符 runes` 估算，是这里应统一的形状。

### F3（中，已修）冷却跳过把"没压缩"变成"压缩无效"并终结本轮

- `Summarize` 冷却命中直接 `return nil`（`agent.go:1979-1985`）；
- `Run` 只看到 `shouldSummarize=true`，仍会重排队（`agent.go:1782-1822`）；
- 守卫在下一轮立即再次触发 → `nextSummarizeResume` 每轮 +1 → 4 次后以
  `context compaction is no longer buying usable work time` 结束本轮。

用户看到的错误指向"压缩无效"，但实际是**一次都没压**（冷却期内的第二次请求被丢弃）。日志里只有一行 `summarize skipped, a compaction just ran`，与最终错误没有关联。

### F4（中，部分已修）clamp 丢弃的内容既没归档也没抽 facts

`clampContextUnderLimit`（`agent.go:2450-2497`）只 `MarkCompressed`，不走 `CompactWithBudget`，因此这些消息：

- 不在 `rail3.db`，不能 `expand`/`range` 取回；
- 不会被 `[Session Facts]` 抽取（F1 之外的第二处漏抽）。

### F5（中，已修）facts 只从"本次待压缩消息"抽取

`facts.MergeFromMessages(regular)`（`agent.go:211-213`）只覆盖 `oldMsgs`。近尾里的编辑/提交要等下一次压缩才进 facts；若被 clamp 或会话结束，则永久缺失。

### F6（低，已修）recall 工具描述与实现不一致

描述写 ``expand — the FULL untruncated text``（`recall_tool.go:50`），实现单条上限 `recallRefEntryTokens`=1200（`recall_tool.go:40`、`:243`），超出时还会提示 "may be partial"。模型会误以为拿到全文，进而基于片段下结论。

### F7（低，已修）上一版摘要被重复归档

上一版摘要被 `carryForwardSummaries` 原文搬运（`agent.go:2202`），同时又作为 `oldMsgs` 归档（`manager.go:262-308`）。主动 `recall` 会命中与活摘要重复的内容（严格路径有 `Exclude`，主动路径没有）。

---

## 11. 优化空间（按"收益/成本"排序，供选择）

| # | 改动 | 预期收益 | 成本 / 风险 |
| --- | --- | --- | --- |
| 1 | **归档投影（role-aware）**：Tool 消息渲染成 `[tool <name>] <content>`（单条截到 e.g. 4k token，注明全文在 DB）；Assistant 渲染成正文 + `[tool call <name>] <input 摘要>`；User 原样 | 修复 F1，recall 第一次真正能取回工具细节；`#N` 覆盖率接近 100% | 中：`rail3.db` 体积上升（需 per-entry cap）；写入需批量（见 #9） |
| 2 | **统一 CJK-aware token 估算器**：`ASCII 字节/4 + 宽字符 1/rune`，替换 agent/context 的 4 处实现与所有 `truncate*` | 修复 F2；预算与守卫一致，中文摘要不再被"隐形"截断，减少"压完还超" | 低：纯函数 + 单测；会让现有中文会话的可用预算变小（行为变化，需要发版说明） |
| 3 | **超大单条消息定点处理**：压缩前先找最大消息，若单条 > 落点预算的 30%，先确定性截断（已有 `truncateToolOutputDeterministically`）或单条摘要，再判断是否需要整轮两档压缩 | 最常见的压缩触发变成一次廉价操作；避免"压完立刻再撞线"（F3 的上游成因） | 中：截断会丢细节 → 同时写入 rail3 并提示可 recall |
| 4 | **保留尾部不重放 reasoning**：`ToAIMessage` 目前把 `ReasoningPart` 送回 wire（`content.go:808-815`），尾部 4–12 条助手消息的 reasoning 往往比正文大数倍 | 同窗口多出大量工作空间，直接降低压缩频率与尾部截断概率 | 中：做成 `options.replay_reasoning`（默认保留最近 1–2 条）；对依赖 reasoning 的 provider 有兼容性风险 |
| 5 | **压缩时机前移**：turn 结束 / idle 时若用量已超落点 60%，后台预压一次 | 避免任务中途停顿 15–70s（本地模型最主要体感问题） | 中：可能做无谓压缩 → 需阈值 + 空闲判定 |
| 6 | **两档合并为一次调用**：一个请求里给 OLDEST / RECENT 两段与各自指令，一次输出 | 省一次 system prompt + 一次往返（压缩墙钟约减半） | 中：模型可能混淆两段 → 需严格标题与校验 |
| 7 | **摘要调用关闭 thinking**（`Thinking: false`） | 3072 输出上限不再被思考吃掉，摘要更完整、更快 | 低：抽象质量可能下降，可 A/B |
| 8 | **先归档再丢弃**：clamp 只允许丢弃已归档消息，并断言 `unarchived == 0` | 修复 F4，消除"不可召回的黑洞" | 低 |
| 9 | **批量持久化**：一次压缩的 N 条归档合成一个 SQLite 事务；`MarkCompressed` 批处理；`BackfillTurns` 批量重写 | 长会话压缩墙钟明显下降（当前每条一次 upsert + 一次 MarkCompressed） | 低：需要 `EntryStore` 增加 `SaveBatch` |
| 10 | **facts 增量抽取**：每轮从新增消息抽取，而不是只在压缩时抽 | 修复 F5，文件/提交清单始终完整 | 低：需要去重（已有 `addUnique`） |
| 11 | **摘要去重增强**：`dedupeSummaryDigest` 目前整行精确匹配，可对长行做归一化 token 集合 + 相似度合并 | 决策/文件清单最容易重复，能进一步压下摘要体积 | 低–中：有误删同义异义行的风险，先只作用于非 facts 长行 |
| 12 | **召回去重与降权**：主动 `recall` 也排除"已出现在活摘要里"的条目（F7） | 召回结果不重复、不浪费 token | 低：需要把首条 user 文本传给 recall 工具 |
| 13 | **观测补全**：记录 `archived_entries / evicted_anchors / skipped_reason / compaction_tokens` | 后续调参有据；F3 类"假失败"一眼可辨 | 低 |

**三个"先做"的候选**（改动小、收益确定）：#1 归档投影、#2 统一估算器、#3 超大单条定点处理；其余按产品节奏排。

### 11.1 本次实施记录（#1 / #2 / #3 / F6 已落地）

| 项 | 状态 | 代码 |
| --- | --- | --- |
| #1 归档投影 | 已实施 | `internal/context/archive_text.go`（新增）；`CompactWithBudget` 改用它；单条 4000 token 上限 |
| #2 统一估算器 | 已实施 | `internal/tokencount/`（新增）；`agent.approxTokenCount`、`context.approxTokens`、`truncateRunesToTokens`、`truncateToTokens*`、`clipMiddleToTokens`、`AnchorStore.CompactToBudget` 全部接入；新增 `messageTokenCount`（正文 + reasoning + ToolResult 正文 + ToolCall.Input + 内联文本附件）并替换尾部预算 / 压缩前后计数 / clamp 扣减 / 摘要档位比例 |
| #3 超大消息定点截断 | 已实施 | `agent.truncateOversizedKeptMessages` + `outlierMessageTokens`；原文经 `Manager.ArchiveOriginal` 进 Rail 3（`Turn=-1`） |
| F6 描述修正 | 已实施 | `recall_tool.go` 的 `expand` 描述改为 "capped at ~1200 tokens each" |
| F3 冷却跳过 | 已实施 | `errSummarizeSkipped` + `waitSummarizeCooldown`；自动路径等完冷却再重排且不占 resume 配额；手动 `/summarize` 视为成功 no-op |
| F4 clamp 丢弃未归档 | 已实施（归档部分） | `clampContextUnderLimit` 丢弃前调用 `ArchiveOriginal`；facts 抽取仍是缺口（见 F5） |
| F5 facts 抽取范围 | 已实施 | `Manager.MergeFacts` + `Summarize` 用**整个工作上下文**抽取（tail 与 clamp 待丢消息也覆盖） |
| F7 摘要重复召回 | 已实施 | `SetLiveSummary` / `inLiveSummary`：query 类召回（`Recall` / `RecallRanked`）排除已出现在活摘要里的条目；`#N` 显式取回不受影响 |

行为变化（发版需注意）：

- 中文/日文/韩文会话的预算数字会比以前"小"（实际是估算变准）：摘要上限、工具结果上限、anchor 预算、recall 单条 1200 现在按真实 token 计，之前可放入约 3–4 倍的中文文本。
- `rail3.db` 会变大：工具输出与工具调用参数开始入库（单条 4000 token 上限）。旧库不需要迁移；新压缩才开始写入。
- 压缩后若仍有单条超大消息，会看到 `Agent: truncated an oversized message kept verbatim instead of re-compacting`，并且它的原文可用 `recall` 查回（不可 `#N` 寻址）。
- 冷却期内的 `/summarize` 现在返回成功（no-op），不再报错；自动路径命中冷却会打 `waiting out the summarize cooldown` 并等待最多 30s 后重试，而不是直接以"压缩无效"结束本轮。
- `recall` 的 `query` 结果不再重复返回活摘要里已有的内容（`#N` 的 `range`/`expand` 仍然按地址精确返回）。
- `[Session Facts]` 现在覆盖**整个工作上下文**，包括从未进入压缩区间、后被 clamp 丢弃的消息。

测试：`internal/tokencount`（估算/截断）、`internal/context`（归档投影、`ArchiveOriginal`、`Compact` 归档工具消息）、`internal/agent`（`messageTokenCount`、outlier 阈值）新增单测；`go build ./...` 与 `go test ./internal/tokencount/ ./internal/context/ ./internal/agent/ -count=1` 通过。全量 `go test ./internal/...` 只剩文档已记录的 Windows 环境失败（`internal/server` 的 TempDir/rail3.db 句柄、`internal/shell` 依赖 `/bin/bash`）。

### 11.2 真实请求回归修复（2026-10-21）

用隔离 data-dir + `context_window=40000` 的真实 provider 触发一次自动压缩后定位并修复：

| 问题（实测证据） | 状态 | 代码 |
| --- | --- | --- |
| 压缩后落点估算偏低：est 19567 vs 实测 23150（+18%，落在 guard 93%，只剩 1650 token，日志却报工作窗口 6420） | 已实施 | `sessionAgent.recordEstimateScale` / `estimateScaleFor`：每步用"实测 `prompt_tokens` ÷ 未锚定估算"学习偏差（仅 >1.02 才记录、上限 1.6）；`estimatePostSummarizePromptTokens` 按会话缩放；摘要日志新增 `estimate_scale` |
| 假压缩标记：`[compressed tool output, ~3012→3012 tokens]` 没减字数仍标 compressed，还多跑一次 LLM | 已实施 | `compressionReduces` + `toolCompressionMinGainPct = 90`：抽象结果未缩到原 90% 以下即按失败返回，调用方回退确定性截断；**调用方同样做收益判定**（单行 dump 无 middle 可抽象时 `compressToolResult` 原样返回，实测由 `~3012→3012` 变为 `~3012→1207`） |
| 压缩打断本轮后模型只回 "OK" 即结束整轮（6 轮任务只做了 1 轮） | 已实施 | 恢复轮（`call.summarizeResumes > 0`）× 本轮尚未用工具 × 短文本（≤60 字符、无换行）→ `resumeContinuationNudge` 推一次继续，不再走"叙述性回答结束"分支（每轮最多一次） |
| 保留尾部可能以 assistant/tool 开头（其 user 消息已被压缩），wire 上 summary(assistant) 紧跟 assistant(tool_call) | 已实施 | `alignTailBoundary`：尾部起点回退到所属 user 消息（最多回看 `tailBoundaryScanLimit = 8` 条；不越过 `startCompress`，保证仍有可压缩区间） |

新增单测：`internal/agent/compaction_resume_test.go`（尾部边界对齐、假完成判定、估算校准与钳制、压缩收益判定）。

补充行为变化：

- 压缩后的 `context_tokens` 会按学到的估算偏差放大（最多 1.6×）：小窗口下压缩可能更早触发，但落点更接近目标，不再"压完一次就又被守卫顶到"。
- `summarize` 恢复轮若模型只回 "OK"/"完成" 这类短句，会被再推一次继续；只有真实调用工具或给出完整回答才会结束本轮。

---

## 12. 与现有文档的关系

- 行为与调优结论的**权威摘要**仍在 `doc/admAgent-server.md` 第 7 节；
- 事实块 / `#N` 编号的设计与实施记录在 `doc/admAgent-fact-block-and-recall-refs-plan.md`；
- 本文是**流程级**说明（谁在什么时机做什么、参数从哪来、失败怎么收），用于审核；三处若出现不一致，以代码为准并同步修正文档。
