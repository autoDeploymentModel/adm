# admAgent 改动清单（供审核）：确定性事实块 + 归档条目标号

> 借鉴 [pi-vcc](https://github.com/sting8k/pi-vcc) 的两项：**确定性事实段**（`src/extract/*`）与
> **会话级 `#N` 标号 + 区间/展开取回**（`src/core/global-indices.ts`、`src/core/recall-run.ts`）。
>
> 范围：**仅 admAgent（服务端 Go）**，桌面端 / TUI 代码不改。按项目约定，本文件只是清单，
> admAgent 目录未做任何写入；确认后再实施，改完需 `build.ps1` 重编译并 `pnpm agent:push` 推送 sidecar 才在 ADM 生效。
>
> 文中所有行号对应当前工作区代码，实施时以实际为准。

---

## 0. 为什么是这两条

上一轮实测结论（同一语料、同一相关性标注、双侧生产代码）：

| | admAgent | pi-vcc |
|---|---|---|
| 关键字查询 recall@10 / MRR | **4.12 / 0.92** | 2.73 / 0.74 |
| 整句查询 recall@10 / MRR | **3.80 / 0.70** | 2.10 / 0.59（出厂 0.69） |
| 有 `#N` 指针时取回精度 | 无此能力（只能靠关键词碰） | **确定性定位 ≈100%** |

结论：**排序准确率 admAgent 更高，不需要动检索栈**；要借的是另外两件事——
把"事实"从 LLM 手里拿走（消除路径/commit 幻觉），以及给摘要装上指针（把"模糊检索"变成"精确取回"）。

---

## 1. 改动 A：确定性事实块（`[Session Facts]`）

### A.1 目标行为

摘要消息的最前面（现有 anchor block 同区域）多出一段**由代码生成、LLM 完全不参与**的事实块：

```
---
[Constraints & Decisions]        ← 现有 Rail 0 anchor 块，不动
...
[Session Facts]
- Modified: internal/agent/agent.go, internal/context/manager.go (+3 more)
- Created: internal/context/facts.go, internal/context/facts_test.go
- Read: internal/agent/agent.go, internal/message/content.go (+7 more)
- Commits: a1b2c3d fix: refresh token after password reset
- Archived: entries #1201–#1387 are searchable with the recall tool
---
```

只有非空段出现；每段上限 10 条 + `(+N more)`；整块字符硬上限（建议 600 字符）。

### A.2 数据来源（**重要：不要用 filetracker 的写记录**）

`filetracker` 的 writes 是**进程内存态 + 10 分钟 TTL**（`internal/filetracker/service.go:32-39, 49-65`），
只回答"刚才谁写过"，10 分钟后消失，用它做事实块必然漏项。**不要给它加 `ListWrittenFiles`。**

正确来源是本次要压缩的 `oldMsgs` 本身（`Summarize` 已经拿在手里，`internal/agent/agent.go:1499`）：

| 段 | 来源 | 规则 |
|---|---|---|
| Modified | `message.ToolCall`（`internal/message/content.go:113-119`，经 `Message.ToolCalls()` `content.go:422`） | 工具名 ∈ {`edit`, `multiedit`} 的 `file_path` |
| Created | 同上 | 工具名 = `write` 的 `file_path` |
| Read | `filetracker.ListReadFiles`（`service.go:272`，**DB 持久化**，可靠） | 取前 10 + 溢出计数 |
| Commits | bash 的 `ToolCall.Input`（JSON 字符串） | 正则 `git commit ... -m "…"`（含 heredoc `-m "$(cat <<EOF …` 首行）；hash 从紧随的 `ToolResult.Content` 抓 `\[branch ([0-9a-f]{7,12})\]` |
| Archived | 本次归档条目的编号区间，见改动 B | `#<min>–#<max>` |

路径参数：admAgent 的编辑/读取工具**统一用 `file_path`**（已核对 `tools/edit.go:27`、`write.go:28`、`multiedit.go:30`、`view.go:50`、`lsp_replace_symbol.go:21`），解析函数不需要多键名兼容；但要对 `ToolCall.Input` 的 JSON 解析失败做静默跳过（流式截断可能产生坏 JSON）。

路径裁剪：照搬 pi-vcc `extract/files.ts` 的 `longestCommonDirPrefix` —— 对所有绝对路径求最长公共目录前缀并剥掉，能省掉大量重复前缀（会话都在同一工作区）。

### A.3 结构：复用 AnchorStore 的"渲染 → 回解析 → 剥离"模式

事实块必须跨压缩**累积合并**（摘要是滚动更新的：`carryForwardSummaries` `agent.go:1608/2130`），
所以不能每次重新生成，必须像 anchor 一样：**渲染进摘要 → 下次从摘要文本里解析回来 → 合并去重 → 再从归档文本里剥掉**。

新增 `internal/context/facts.go`：

```go
// FactLedger 是单个会话的确定性事实账本（与 AnchorStore 同级、同生命周期，
// 但独立预算：不占 Rail 0 的 512–2048 token，避免文件列表把约束挤掉）。
type FactLedger struct{ mu sync.Mutex; /* … */ }

func NewFactLedger() *FactLedger
func (l *FactLedger) MergeFromMessages(msgs []message.Message)  // 抽取（A.2 表）
func (l *FactLedger) MergeFromText(text string)                 // 解析上一版摘要里的块
func (l *FactLedger) NoteArchived(minIdx, maxIdx int)           // 维护 Archived 区间
func (l *FactLedger) Render() string                            // 渲染整块（含首尾 --- 之外的内容）
func StripFactBlock(text string) string                         // 对齐 StripAnchorBlock（anchor.go:333）
```

`Manager` 侧（`internal/context/manager.go`）：

- 字段：`facts map[string]*FactLedger`（对齐 `anchors` `manager.go:27-28`，同样带 mutex）
- 方法：`FactsFor(sessionID) *FactLedger`（对齐 `AnchorsFor` `manager.go:92-104`）

### A.4 三处必须同步的接入点（漏一处就出重复/丢块）

| # | 位置 | 现状 | 改动 |
|---|---|---|---|
| 1 | `manager.go:135-142`（`CompactWithBudget` 的 `IsSummaryMessage` 分支） | `ParseAnchorsFromText` + `StripAnchorBlock` | 追加 `FactsFor(sid).MergeFromText(text)` + `StripFactBlock(text)` |
| 2 | `manager.go:186-208`（归档循环，把 `msgs` 文本写进 Rail 3） | 摘要消息已在 #1 剥离 anchor 块 | 同处剥离事实块，避免归档里多存一份 |
| 3 | `agent.go:2133`（`carryForwardSummaries`） | `StripAnchorBlock(m.Content().Text)` | 同时 `StripFactBlock(...)`，否则每轮压缩会在 carry 文本里叠一层事实块 |

加上生成侧：`manager.go:143-145` 的 anchor 抽取之后，追加
`facts.MergeFromMessages(regular)`（只对非摘要消息抽取，与 anchor 一致），
然后 `internal/agent/agent.go:1517` 与 `agent.go:1655`：

```go
// 现在
anchorBlock := a.ctxMgr.CompactWithBudget(sessionID, oldMsgs, budget)
...
summaryMessage.PrependContent("---\n" + anchorBlock + "\n---\n")

// 改为（CompactWithBudget 返回结构体，调用点只有这一处 + 测试）
res := a.ctxMgr.CompactWithBudget(sessionID, oldMsgs, budget)   // CompactResult{Anchors, Facts string}
...
summaryMessage.PrependContent("---\n" + res.Anchors + "\n\n" + res.Facts + "\n---\n")
```

顺序：anchor（约束/决策）在前，facts（客观记录）在后——约束优先级最高，读起来也符合现有习惯。

### A.5 测试与验收

- `internal/context/facts_test.go`（新增）：抽取各类工具、`git commit`（普通 + heredoc）、路径公共前缀裁剪、跨轮合并去重、每段上限与 `(+N more)`、`Render → MergeFromText` 往返幂等、`StripFactBlock`。
- `manager_test.go` 增补：连续两次 `Compact` 不产生重复条目；Rail 3 归档文本中不含事实块。
- 回归：`go test ./internal/... -count=1`（Windows 上 `internal/shell` 的既有环境性失败可忽略）。
- 人工验收：跑一个真实长会话触发压缩，摘要里事实段的路径与 `git status` 一致。

### A.6 风险 / 回滚

- 风险：事实块占用摘要注意力与 token。控制手段：整块 ≤600 字符（相对 `deriveSummaryMaxTokens` 的 512–3072 token 上限占比很小）。
- 回滚：`options.fact_block = false`（admAgent.json 顶层，走现有 config/set 热重载）；默认 `true`。
- 不影响：TUI / 桌面对摘要的展示（只是多几行结构化文本）；`session show` 不受影响。

---

## 2. 改动 B：归档条目标号 + `range` / `expand` 取回

### B.1 编号定义（**关键决策，请重点审核**）

**`#N` = 该会话在 `messages.List` 顺序（`ORDER BY created_at ASC, rowid ASC`，见 `internal/db/sql/messages.sql:6-10`）中的序号（0 基）。**

- **不变量（必须成立才有引用）**：已归档的消息只被标记 `is_compressed=1`，永不被删除（`message.go:171`）；
  会删除消息的三条路径——重试/推理超限的"丢弃半成品"（`agent_loop_llm.go:887/934/970/1110/1180`、`decision_turn.go:259`）、
  失败摘要的清理（`agent.go:1624/1639`）、撤销一轮（`coordinator.go:1060-1086` 删 `msgs[anchorIdx:]`）——
  删的都是**活动上下文里的尾部**，不触及已归档条目，因此已发出的编号不会被回收。
  这正是 pi-vcc `global-indices.ts` 的核心不变量（"任何改变索引口径的改动都必须保持编号稳定"）。
- **唯一性守卫**：归档时若该会话已有条目占用同一编号（尾部删除后位置被新消息复用），新条目取 `max(已用)+1`，
  保证 `#N → entry` 永远可解、不产生歧义（代价一行代码）。
- 取号方式：`Summarize` 里直接再调一次 `a.messages.List(ctx, sessionID)`（**未过滤**；现有 `getSessionMessages` `agent.go:2368-2386` 会剔掉已压缩消息，不能用），构造 `map[messageID]int`，一次性成本与该会话表扫描同量级。
- **复用 `Entry.Turn` 承载全局序号**：`Turn` 现语义是"归档切片内序号"，全仓库只有两个消费点——`formatRecallHeader`（`agent_loop_llm.go:1822`、`recall_tool.go:77`）和 `LoadAll` 的 `ORDER BY turn ASC`（`persist.go:126/130`）。改成全局序号后：排序仍单调正确；头部显示由"第 3 条"变成"#1253"（更有用）。
  → **不需要改 `rail3_entries` 表结构**（`persist.go:53-61` 已有的 `turn` 列直接复用）。
  - 备选：新增 `idx` 列 + `ALTER TABLE … ADD COLUMN` 幂等迁移。成本更高，收益仅是语义干净，**建议不做**。
  - 升级前的旧条目 `turn` 是局部小值：**建议做一次性回填**（`Entry.ID` 就是消息 ID，用同一份 `map[messageID]int` 重算后 `Store.Save`；映射不到的消息置 `Turn:-1`，沿用现有"无 turn"哨兵语义）。不能因为"旧摘要里没有引用"就当无事——新旧口径混用会让 `expand:[3]` 静默返回错误条目。
- 锚点降级条目保持 `Turn: -1`（`manager.go:164-177`），**不参与编号**。

### B.2 摘要里的引用（两处，都在事实块渲染通道里）

1. **Archived 行（必做）**——等价于 pi-vcc 的 RECALL_NOTE：
   `- Archived: entries #1201–#1387 are searchable with the recall tool (range:[1201, 1387], expand:[N]).`
   由 `FactLedger.NoteArchived(min, max)` 维护并随块一起被剥离/合并（不会每轮叠一行）。
2. **每文件最后引用（可选，建议 v2）**：`- Modified: internal/agent/agent.go (#1253)`，只保留该路径**最近一次**写入的编号。

> ⚠️ 形态约束（项目已有历史教训）：这段必须是**散文 + 列表**，**禁止**出现 JSON、`<tag>`、`role: xxx` 之类形状，否则弱模型会在普通对话里照抄（参见决策输出回灌的既有结论）。

### B.3 工具侧改动（`internal/agent/recall_tool.go` + `internal/context/manager.go`）

参数（`RecallToolParams` `recall_tool.go:37-41`，全部可选，一次调用只执行一个动作）：

```go
Query      string  // 现有
Range      []int   // 新增 [from, to]
Expand     []int   // 新增 [#N, …]
Page       int     // 新增
MaxResults int     // 现有
```

Manager 新增两个方法（与 `RecallRankedWithin` `manager.go:301` 同级）：

```go
func (m *Manager) RecallByRange(sessionID string, from, to, page int, tokenBudget int64) RecallResult
func (m *Manager) RecallByIndex(sessionID string, idxs []int, tokenBudget int64) RecallResult
// RecallResult{ Text string; Shown, Total, TotalPages int; Truncated bool }
```

实现要点：

- 内存索引：`Manager` 维护 `bySessionIndex map[string][]Entry`，`NewManagerWithStore`（`manager.go:63-81`）从 `store.LoadAll("")` 一次建好，`CompactWithBudget` 归档时追加，`Delete(sessionID)` / `PruneOrphans` 同步清理 → `range`/`expand` 是 O(1) 定位 + O(页大小) 取文本，**不需要新 SQL**。
- 分页：range 20 条/页（pi-vcc 取值）、expand 一次 ≤5 个编号；单条截断沿用现有 `recallMaxEntryRatio`（1.5% cw）。
- **诚实截断**（对齐 pi-vcc `capHits`）：头部 `#1201..#1240, page 1/2 (40 entries)`；超预算写 `showing 12 of 40, page:2 or refine`。
- 编号缺失：`no entry #1234 (closest range #1230..#1250)`，不返回空。
- 未用参数点名（对齐 pi-vcc `ignoredNote`）：`Ignored: page (expand runs alone).`
- 参数修复（对齐 pi-vcc `prepareArguments`，可选）：`"459"` / `"#459"` → 459；`[10,5]` → `[5,10]`；语义唯一才修，其余按原样报错。
- 结果尾附**下一步提示**：`--- Read around a hit: range:[1250,1290]; full text: expand:[1253] ---`（pi-vcc 实测这是提升"模型真的用上召回"的关键小成本项）。
- 工具描述（`recallToolDescription` `recall_tool.go:31-35`）补一段：`#N` 来自摘要里的 `(#1253)` / 事实块 / Archived 行。
- **`RecallStrict` 被动注入路径完全不动**（`manager.go:372`、`agent_loop_llm.go:1805`）：门槛常量 0.3 / ≥2 token / ≤6 条是实测调过的，只让模型主动路径获得取回能力。

### B.4 测试与验收

- 编号稳定性：同一会话连续两次压缩，同一消息的 `#N` 不变；锚点降级条目无编号。
- `RecallByRange`：分页边界、`from>to`、越界、空会话、预算截断标记。
- 工具层：动作互斥、未用参数点名、坏参数修复、`#N` 缺失提示。
- 端到端：触发一次压缩 → 摘要出现 `#a–#b` → `recall(range:[a,b], page:1)` 取回原文 → `expand:[N]` 取回完整文本（含配对 tool result 更好，v2）。
- 回归：`console` 侧无改动，但需确认 TUI 的 `session show` 对更长摘要文本渲染正常。

---

## 3. 明确不做（避免过度设计）

| 不做 | 原因 |
|---|---|
| 给 `filetracker` 写记录加持久化 / 加 `ListWrittenFiles` | 它的定位就是"进程内最近写入"（`service.go:32-39`），事实块改用消息里的 ToolCall，见 A.2 |
| 改 Rail 3 表结构（加 `idx` 列） | 复用 `turn` 列即可，见 B.1 |
| 动 `RecallStrict` 门槛 / 给被动注入加 range | 被动注入只做"相关才注入"，把归档成批拉回上下文会挤占工作上下文 |
| 引入 pi-vcc 的"整串正则优先 / 空白分词 / 相对地板 0.2" | 实测这三项都是 pi-vcc 的**短板**（整句查询 recall@10 从 2.10 掉到 0.69） |
| 把事实块写进 LLM 的 prompt（要求模型"必须照抄"） | 事实块的整个价值就是不过模型；要求照抄等于把幻觉风险请回来 |

---

## 4. 落地顺序与工作量

| 步骤 | 内容 | 涉及文件 | 预估 |
|---|---|---|---|
| A | 事实块（独立可上、可回滚） | `internal/context/facts.go`(新)、`manager.go`、`internal/agent/agent.go` | 中 |
| B1 | `#N` 编号贯通 + 旧条目回填 + Archived 行 | `manager.go`、`agent.go` | 小 |
| B2 | `range` / `expand` / 分页 / 诚实截断 / 下一步提示 | `manager.go`、`recall_tool.go`、工具描述 | 中 |
| B3 | 每文件最后引用（可选） | `facts.go` | 小 |

A 与 B1 无依赖冲突，可并行；B2 依赖 B1 的编号。

---

## 5. 决策建议（待确认）

下表是**建议值**；括号里是"不接受时的备选"。

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | `Turn` 复用 | **复用 `turn`，不加列；升级后首次压缩某会话时做一次性回填，映射不到的置 `-1`**（备选：新增 `idx` 列 + 幂等 `ALTER TABLE`） | 回填让新旧口径一致，`expand/range` 不会静默取错条目；`Entry.ID` 本来就是消息 ID，回填复用同一份 `map[messageID]int`，不需要新查询；加列则要动 `Save`/`LoadAll`/启动重水化，收益只是语义好看 |
| 2 | 事实块默认 | **默认开**（`options.fact_block=true`），但 v1 只含 `Modified / Created / Commits / Archived`；**`Read` 段默认关**（`options.fact_block_read=false`） | 无 LLM 依赖、可一键回滚、最坏情况只是"多几行"；`Read` 是 pi-vcc 事实模型里权重最低的一类（1），长会话里容易变成一长串路径白占预算。不建议按"高危会话"灰度——没有可靠信号，且这条路径零延迟零成本，风险用"每类 10 条 + 整块 600 字符上限 + 开关"控制即可 |
| 3 | `#N` 可见面 | **Archived 行显示（一行）；v1 不做折叠 UI** | 桌面端把摘要当普通 assistant 消息渲染（`src/views/agent/*` 里没有 `is_summary` 特判），TUI 只在生成动画里有 "Summarizing" 标签（`internal/ui/chat/assistant.go:521`）——多几行不会破版；折叠要双端同时改，收益低于成本。事实块用 `---` 包住，将来任一端想折叠都有现成切分标记 |
| 4 | 编号语义 | **只显示会话内序号 `#N`；UUID 不显示，仅作内部唯一键与调试日志** | 引用是给模型算的：`range:[1253,1290]` 只有短而连续的整数才可用，UUID 无法表达区间；存储层 `Entry.ID`（消息 ID）与编号天然并存，不必在文本里暴露 UUID |

补充一条实现约束（已并入 B.1）：**撤销/丢弃只删尾部，已归档条目不会被删除**，因此编号不会回收；
再加"归档时编号冲突则顺延 `max+1`"的守卫，`#N` 与条目的映射永远唯一可解。
取不到时必须明说（`no entry #1234 (closest #1230..#1250)`），**绝不静默返回邻近条目**。

---

## 6. 实施记录（已按本文档执行）

范围：**A + B1 + B2**（B3"每文件最后引用"未做，留作后续）；**只改 admAgent（服务端）**，桌面端 / TUI 无需改动。
按 §5 的建议执行：复用 `turn` + 一次性回填、事实块默认开且 Read 默认关、Archived 行显示、只显示数字编号。

### 改动文件

| 文件 | 内容 |
|---|---|
| `internal/context/facts.go`（新） | `FactLedger`：从 `ToolCall` 部件抽取 `edit/multiedit/lsp_replace_symbol`→Modified、`write`→Created（被改过则只算 Modified）、bash `git commit -m`（含 heredoc）主题 + 紧随 `ToolResult` 的短 hash 配对；路径裁最长公共目录前缀；600 字符预算 + 逐级降级丢弃（Read → Commits 截 3 → Created → Modified 截 5）；`Render` / `MergeFromText` / `StripFactBlock`；`NoteArchived` 维护可寻址区间 |
| `internal/context/facts_test.go`（新） | 抽取、裁剪、往返幂等、剥离、预算封顶、编号冲突顺延、回填、range/expand 取回（durable store 与 in-memory 两路） |
| `internal/context/manager.go` | `CompactResult{Anchors, Facts}`；`CompactWithBudget(..., indexByMessageID)`（nil 时保持切片内序号）；摘要块合并/剥离；归档编号 `claimTurn`/`markTurnLocked`/`loadTurnsLocked`；`BackfillTurns`；`RecallByRange` / `RecallByIndex` + `RecallResult`（含 `Missing`/`Truncated`）；`FactsFor` / `MergeReadFiles` |
| `internal/context/persist.go` | `EntryStore.LoadByTurns(sessionID, turns)`（SQLite 单语句 `turn IN (...)`，供 range/expand 精确定位） |
| `internal/agent/agent.go` | `getSessionMessagesWithIndex`（产出会话全局编号 map，恢复时同时解析事实块）；`Summarize` 接入 `BackfillTurns` → `MergeReadFiles` → `CompactWithBudget(..., indexByID)`；`pinnedSummaryPrefix`；`carryForwardSummaries` 同时剥离 anchor 与 fact 两个块 |
| `internal/agent/recall_tool.go` | 新增 `range` / `expand` / `page` 参数与三个动作的分派；"未用参数点名"、"越界明说页数"、"缺失编号明说"、"下一步提示"；工具描述写明 `#N` 的来源 |
| `internal/agent/recall_tool_test.go` | range / expand / 参数点名 / 无动作报错 / pinned prefix 用例 |
| `internal/agent/coordinator.go` | `FactBlock` / `ReadFiles` 选项接线（Read 仅在 `fact_block_read` 打开时接 `filetracker.ListReadFiles`） |
| `internal/config/config.go` + `load.go` | `options.fact_block`（`*bool`，`assignIfNil` 默认 true）、`options.fact_block_read`（默认 false） |
| `schema.json` | `go run . schema > schema.json` 重新生成（仅 +15 行） |

### 与文档的两处偏差（都按更安全的一侧实现）

1. **`indexByMessageID == nil` 时保留切片内序号**（不是一律 `-1`）：保持 `Compact` 的既有语义与现有测试，同时让"调用方没有会话视图"的场景不至于把所有编号废掉；真实压缩路径（`Summarize`）始终传 map。
2. **启动重水化不置 "已就绪"**：`NewManagerWithStore` 只登记已用编号，不把会话标记成已加载，否则 `BackfillTurns` 会被早退跳过（`TestBackfillTurnsRewritesLegacyIndices` 锁住这个坑）。

### 验证

- `go build ./...` 通过；对新增/改动文件按 LF 规范化后 `gofmt` 无差异（`config.go` 里有一处**既有**的 struct 对齐问题，未动以保持 diff 最小）。
- `go test ./internal/context/ ./internal/agent/ ./internal/config/ -count=1` 全绿。
- 全量 `go test ./internal/...`：仅 `internal/shell`（shebang，依赖 `/bin/bash`）、`internal/server`（TempDir 下 `rail3.db` 文件锁）与 `internal/backend`（`TestBackend_ReloadSkills`，TempDir 句柄）失败；三者都已用 `git worktree` 在**未改动的 HEAD** 上复现同样失败，确认是既有环境问题，与本次改动无关（AGENTS.md 的测试说明已同步补充）。
- **未做**：真实会话端到端验收。需按 AGENTS.md 重编译并推送 sidecar 后，在 ADM 里跑一次压缩，观察摘要是否出现 `[Session Facts]` 与 `Archived: entries #a..#b`，并试一次 `recall(range:[a,b])` / `expand:[N]`。

### 评审修复记录（8 项，全部已修）

| 级别 | 位置 | 问题 → 修复 |
|---|---|---|
| high | `facts.go` `MergeFromMessages` | 抽取循环在锁外写 `created`/`modified`（与类型"并发安全"注释冲突）→ 锁提到函数开头，删除后置重复加锁 |
| medium | `manager.go` `loadTurnsLocked`/`BackfillTurns` | `archiveMu` 持锁期间做 SQLite I/O → 新增 `ensureTurnsLoaded`（锁外 `LoadAll`），`BackfillTurns` 改为锁内收集、锁外 `Save` |
| low | `facts.go` `heredocFirstLine` | 单词主题被误判为 heredoc 终止符而丢 commit → 从 opener 解析真实分隔符，只在与它相等时终止（`isHeredocTerminator` 删除） |
| low | `facts.go` `commitHash` | 兜底正则扫整段输出可能挂错 hash → 只在输出首行匹配 |
| low | `facts.go` `sortedKeys` | 死代码 → 删除（连同 `sort` import） |
| low | `agent.go:1539` | 读取列表失败被静默 → 补 `slog.Warn` |
| low | `agent.go` `getSessionMessagesWithIndex` | 每次会话读取都构建全局索引 map → 拆出 `sessionMessages` 核心，map 仅在 `getSessionMessagesWithIndex`（Summarize 用）里构建 |
| low | `recall_tool.go` `maxInt` | 重复 Go 1.21+ 内置 `max` → 改用内置并删除 helper |

新增回归用例：单词主题 heredoc（`TestFactLedgerSingleWordHeredocSubject`）、hash 首行限定（`TestCommitHashPrefersFirstLine`）。

---

## 7. 第二轮：压缩节奏与收尾修复（本地模型实测驱动）

来源：2026-10-14 本地模型（`localModel`，cw=64000、guard 39680、固定开销 ~22.9k）实测日志。第一轮的 P0/P1 已生效（`summary_chars`/`tail_budget`/`guard_limit` 等新字段可见，无 `compaction could not bring`、无静默丢弃），但暴露出另外三个问题：

| 级别 | 问题（日志证据） | 修复 |
|---|---|---|
| P0 | 一个用户轮次内发生 **5 次成功压缩**（每次落地 ~19–20k，远低于 guard），第 5 次后 `maxSummarizeResumes=4` 触发 `exceeded max summarize resumes`，且 `run_complete` **error 为空** → 用户看到"任务做到一半突然停" | `summarizeResumes` 改为**进度感知**：主循环在 guard 触发时记录 `steps`（`noteGuardTrip`），`nextSummarizeResume` 在 `steps >= compactionProgressSteps(3)` 时把计数重置为 1（长任务连续压缩不再累积）；只有"压完立刻又撞线"（steps ≤2）才累加，超上限时返回**明确错误**（`compaction is no longer buying usable work time…`）而不是静默结束 |
| P1 | 17 分钟 6 次压缩，每次 15–70s、2 次 LLM 调用，占墙钟 ~25%；后期每 **4 步**就撞线（单步 +12k token） | ① `compactionHeadroomRatio=0.85`：压缩目标水位从"贴着 guard"降到 guard 用量的 85%（`compactionTargetBudget`，clamp 与 tail budget 同步收紧）；② 工具结果入口压缩阈值 12%→**6%**（64k 窗口 7680→3840 token，下限 1500）；③ **确定性兜底**：LLM 压缩失败/被取消时改为 `truncateToolOutputDeterministically`（保留 head/signal/tail + 中部裁剪到 cap），**不再让原始巨型输出进历史**——日志里 `Loop tool result compression failed raw_tokens=9730` 就是这一步的缺口 |
| P1 | `summary_chars` 1375→2076→1817→3646→2747→**4906** 单调增长；落地水位 17878→19766 缓升，headroom 持续缩小 | `dedupeSummaryDigest`：摘要落盘前折叠**重复行**（结构行/短行保留），减少"每轮把同样的决策与文件清单再讲一遍"造成的雪球；配合已有的 `carry_budget` 上限与"新内容优先" |

新增回归用例：`TestNextSummarizeResumeIsProgressAware`、`TestCompactionTargetLeavesAWorkWindow`、`TestDedupeSummaryDigest`、`TestTruncateToolOutputDeterministically`、`TestToolResultCompressThresholdIsEager`。

验证：`go build ./...`、`go vet`、`gofmt` 通过；`internal/agent|context|config` 全绿；全量仅剩 `internal/server`、`internal/shell`、`internal/workspace` 三个既有环境抖动包（均已在未改动的 HEAD 上复现）。

## 8. 第三轮：128K 最低线（准确率优先）

来源：用户指令「按 128K 最低线优化，保证准确率」。依据第二轮日志与上面的容量模型，把"窗口下限"从经验值变成代码里的**显式常量 + 可测判定**。

判定线（`agent.go` 注释与 AGENTS.md 同口径）：

```
可用工作窗口 = guard(cw) − 固定开销 − 2×摘要上限   ≥ minUsableWorkWindow
guard: cw ≤ 64k 用 0.62×cw，更大用 0.70×cw
固定开销实测 ≈ 22.9k = 系统提示/前缀/项目记忆 16381 + 28 工具 schema 6506（每工具 ≈232 tok）
```

| 改动 | 之前 | 之后 | 对准确率的意义 |
|---|---|---|---|
| 目标窗口 | 隐含在注释里 | 显式 `recommendedContextWindow = 128*1024` | 单一常量可引用、可测试；分档行为的唯一分界 |
| 摘要输出上限 | `5%×cw` clamp [512, **3072**] | <128k 不变；≥128k 提到 **6144** | 摘要能装下更多确定性事实（决策、未决项、精确标识符），减少"压完就丢" |
| 工具结果上限 | 同口径 clamp [512, **2000**] | <128k 不变；≥128k 提到 **3000** | 大窗口下让更多原文留在上下文里，而不是依赖模型主动 recall（排序再准也不是 100%） |
| 入口压缩阈值下限 | 6% 且下限 **1500** | 6% 且下限 **2000** | 必须**高于** `recallToolTokenBudget=2000`，否则召回结果会被再压一次（自己压自己） |
| `recall` expand 单条上限 | **600** token | **1200** token | 600 token 的"原文"实际是 stub（等于召回失败）；翻倍后才像原文 |
| 小窗口诊断 | 无 | `Summarize` 打 `context window leaves a small work window`（session/context_window/推荐下限/可用窗口/固定开销/advice） | 让"为什么一直在压缩"可见，并直接给出两个旋钮（窗口、工具目录/系统提示） |

**低于 128k 的行为逐字节不变**（caps 走 Small 分支，只有一条新警告日志），64k 用户不会被优化误伤；`recall` 的预算/条数上限（2000 tok、5–8 条、20 条/页、≤5 编号）保持不变。

### 同轮发现并修掉的一处量纲错误（本轮的诊断本体）

`workWindowAfterCompaction` 原先写成 `guard − 0.85×(guard − overlaphead)` 的形式（`guard − compactionTargetBudget`），即把 **committed 口径的 guard** 与 **history 口径的 target** 相减：结果 64k 报出 25.4k（≥25k）**恰好不报警**——而 64k 正是这条警告要提示的场景（第二轮日志：每 4 步压一次、占墙钟 ~25%）。改为与尾部预算同口径：

```go
usableRequestBudget(cw, fixedOverhead) − 2×deriveSummaryMaxTokens(cw)
```

| cw | guard | 可用工作窗口 | 判定 |
|---|---|---|---|
| 32k | 19.8k | **−6.1k**（固定开销已超 guard） | 报警：压缩永远落不了地 |
| 64k | 39.7k | ~10.6k | 报警：每几步压一次（低于 25k 线） |
| 128k | 91.8k | ~56.6k | 通过 |
| 256k | 183.5k | ~148k | 通过 |

数字与前面容量模型表格一致，仅 128k 处略有变化（摘要额度随分档从 2×3072 变为 2×6144）。副作用为零：该函数只被 `contextWindowShortfall` 使用，而后者只用于上面那条警告日志；**压缩行为本身（`compactionTargetBudget` 的 0.85 headroom）未动**。

### 用例
`TestCapsScaleAtRecommendedWindow`：64k 分档不变（3072 / 1920）、128k 与 256k 走 Large、`contextWindowShortfall` 在 128k 为 false、**64k 为 true（>0，仍能落地）**、32k 为 true 且为负数。

### 验证
`go build ./...`、`go vet`、`gofmt` 通过；`internal/agent|context|config` 全绿；全量仅剩三个既有环境抖动包。检索侧无回归：Rail 3 回放 `recall@10` 三次运行**位级一致**（2.690 / 2.923 / 3.373，与改动前同值），MRR 在同一份代码上自身波动 ±0.01（map 迭代序所致）→ 改动未影响召回质量。

生效方式：`build.ps1` + `pnpm agent:push`（sidecar）。

## 9. 第五轮：字段日志驱动的三处参数修正

来源：2026-10-15 现场日志（`admAgent.log`，128k 与 1M 窗口模型混跑）。压缩链路本身健康——4 次压缩全部落地、无 `summarize skipped` / `max summarize resumes` / `could not bring`、事实块 203–205 字符稳定、无 ERROR——但暴露三处参数问题：

| 级别 | 现象（日志证据） | 修复 |
|---|---|---|
| P1 | `tail_budget=55258` 是 `guard_limit=89600` 的 **62%**：落点上限 ≈ 固定开销 16.4k + 工具 schema 6.5k + 尾部 55.3k + 摘要 ≈ 79.6k/89.6k，工作窗口只剩 ~10k。实测保留尾部 1859→4687→7168→**16581**，落地 19480→22305→26690→**35549**，间隔 18m→14m，`tail_budget_limited` 始终 false（预算还能继续长） | `recentTailBudget` 增加工作窗口预留：`window = usable − 2×摘要上限 − reservedWorkWindow`，`reservedWorkWindow = min(minUsableWorkWindow, usable/2)`。128000 下尾部预算 55.3k→**35.9k**（落点约 62k、工作窗口约 25k ≈ 5–6 步）；64000 下 12.8k→**5.5k**（旧值本可把落点顶到 guard 之上，等于零工作窗口） |
| P1 | 分档点写成 128KiB(131072)，实测模型 cw=**128000** → 反解 tail_budget 公式得到 `2×3072`，证明 128k 模型走的是**小档 caps**，且 shortfall 警告也不触发 | `recommendedContextWindow` 改为 **128000**（厂商标称 128k 的模型配的就是 128000）；用例显式钉住 128000 走大档 |
| P2 | `deriveToolResultCompressThreshold = 6%×cw` 无上限 → 1M 窗口下 **60k** 才触发；实测一条 **25610 token** 的 fetch 结果原样进上下文，同一会话（guard=700k）涨到 251k / 204 条消息仍零压缩 | 新增 `toolResultCompressThresholdCap = 12000`（仍高于 `recallToolTokenBudget`，召回结果不会被二次压缩） |

用例：`TestCapsScaleAtRecommendedWindow`（128000 显式走大档）、`TestToolResultCompressThresholdIsEager`（1M → 12000）、`TestRecentTailBudgetLeavesRoomForTheSummary`（尾部必须留下 `reservedWorkWindow`，128000 下留满 25k）。

验证：gofmt、`go build ./...`、`go vet` 通过；`internal/agent|context|config` 全绿。
