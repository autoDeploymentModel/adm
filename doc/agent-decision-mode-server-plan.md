# 决策模式上移到服务端（admAgent）方案

> 状态：**P0–P3 已实施**（服务端旁路决策轮 + 客户端传 `decision` 字段 + 专用 `decision` part + `json_schema` 强制）
> 实施范围：admAgent（`internal/decision`、`internal/agent/decision_turn.go`、`internal/message` 新 part、`internal/llm` response_format）+ 桌面端（`src/views/agent/send.js`、`decision_mode.js`、`render.js`）+ 文档；TUI 不感知（opt-in）
> 关联文档：`doc/agent-decision-output-plan.md`（前端注入式 MVP，已由本方案取代）、`doc/server-api.md`（`decision` 请求字段）

## 0. 实施现状（本轮已落地）

| 计划项 | 状态 | 落点 |
|---|---|---|
| P0 旁路决策轮 | ✅ | 新文件 `admAgent/internal/agent/decision_turn.go`（单次请求 + 校验 + 一次定向重试）；分派点 `internal/agent/agent.go:1090`（`call.Decision != nil`，4 行）；主循环 `agent_loop_llm.go` **零改动** |
| P0 请求字段 | ✅ | `internal/proto/proto.go`（`DecisionSpec` + `AgentMessage.Decision`）、`internal/agent/agent.go`（`SessionAgentCall.Decision` + `ValidateCall` 校验）、`internal/backend/agent.go`（API 边界同步 400 + context 下传）、`internal/agent/decision_ctx.go`（spec 传递，Run/RunAccepted 签名不变） |
| P1 服务端输出契约 | ✅ | 新包 `admAgent/internal/decision`（`Spec`/`Validate`/`SystemPrompt`/`Parse`/`RetryPrompt`）：契约拼进**本轮系统提示词**（`agent.go` 的 `systemPrompt` 局部追加，不改共享值），不再进用户消息 |
| P1 结果校验与失败报错 | ✅ | 校验失败 → 一次定向重试（带上具体违规原因 + 模型上次原文，wire-only 不落库）；两次仍失败 → 本轮以 `invalid decision output after 2 attempts: …` 结束，`run_complete.error` 带出 |
| P1 桌面端切换 | ✅ | `send.js` 不再拼控制块，改为请求体带 `decision` 字段；`decision_mode.js` 的 `buildDecisionConstraint` 换成 `decisionRequestPayload` |
| P1 折叠插入例外 | ✅ | 决策模式强制走排队（不折叠进运行中的普通轮）：`send.js` 的 `foldIn` 只对 `text` 模式成立 |
| P1 版本下限（不做客户端回退） | ✅ | 桌面端不再自带契约：混用旧服务端时决策轮不会触发（内置 sidecar 与新桌面端同版本发布，见 §6） |
| P2 专用 `decision` part | ✅ | `internal/message`（`DecisionContent` + `decisionType` 序列化/反序列化 + `SetDecisionResult`）；决策轮把结果写成 part 并把正文里的 JSON 剔除；桌面端优先读 part 画卡片（`render.js` 的 `case "decision"`），未知 kind 折叠展示 `raw` |

> ⚠️ **新增 part 类型必须同时登记三处**（漏一处会表现成"服务端成功、前端拿不到 part"→ 误报"未返回有效决策结果"）：
> ① `internal/message`（存储层 `partType`/`isPart`）；② `internal/proto/message.go`（wire 白名单：`partType` 常量 + `MarshalParts`/`UnmarshalParts`）；③ `internal/server/events.go` 的 `messageToProto`（message → wire 转换，SSE 事件与 `/messages` 三个端点共用）。回归用例：`internal/server/events_test.go` 的 `TestMessageToProtoDecision`。
| P3 `json_schema` 强制 | ✅ | `internal/llm`（`Request.ResponseFormat` + `wireRequest` 透传 + `JSONSchemaResponseFormat`）；探针失败自动不带 response_format 重试一次并按 `baseURL+model` 缓存（`structuredOutputCache`，与 thinking 同一套机制）；`decision.JSONSchema(spec)` 按 mode 生成 schema；桌面端可传 `structured_output=off` 关闭 |
| P3 服务端强制关思考 | ✅ | 决策轮在 `decision_turn.go` 固定 `reasoning_effort: none`（不再读 model 配置里的 thinking 开关，也不带 `Thinking` 对象）；provider 把两种写法都拒时（`llm.ThinkingModeUnsupported`）去掉参数重试同一请求，契约提示词仍约束只输出一个 JSON 块；桌面端据此移除了「决策模式 ↔ 推理强度」的全局联动（设置面板已把思考开关与推理强度合并为单个下拉），用户切换会话/模式不再改写全局设置 |

> ⚠️ **新增 part 类型必须同时登记四处**（漏一处会表现成"服务端成功、前端拿不到 part"→ 误报"未返回有效决策结果"）：
> ① `internal/message`（存储层 `partType`/`isPart`）；② `internal/proto/message.go`（wire 白名单：`partType` 常量 + `MarshalParts`/`UnmarshalParts`）；③ `internal/server/events.go` 的 `messageToProto`（message → wire 转换，SSE 事件与 `/messages` 三个端点共用）；④ `internal/workspace/client_workspace.go` 的 `protoToMessage`（客户端模式 proto→message，漏登记会静默丢弃，TUI 历史只剩 finish 标记）。另有 `internal/cmd/session.go` 的 `convertParts` 决定 `adm session show` 的展示（漏登记显示为 `unknown`）。回归用例：`internal/server/events_test.go` 的 `TestMessageToProtoDecision`、`internal/workspace/client_workspace_test.go` 的 `TestProtoToMessageDecision`、`internal/cmd/session_show_test.go` 的 `TestConvertPartsDecision`。

测试：`admAgent/internal/decision`（契约/解析/bare JSON/StripResult/JSONSchema）、`admAgent/internal/message`（decision part 序列化往返与正文剔除）、`admAgent/internal/llm`（response_format 发送 / 被拒后重试并缓存 / extra_body 覆盖 / `StructuredOutputRejection` 分类）、`admAgent/internal/agent`（决策轮 9 例：一次命中+part 落库、普通轮无契约、违规一次重试、持续违规报错、非法 spec 拒绝、structured_output=off 且 bare JSON 可解析、response_format 被拒时去参重试、强制 `reasoning_effort=none`、provider 拒思考参数时降级）；桌面端 `pnpm typecheck`。

## 1. 为什么要上移到服务端

当前实现是**纯前端注入**：桌面端把 `<adm_decision_request>` + 英文契约拼进本轮 `prompt` 正文（`src/views/agent/decision_mode.js:129-152` → `src/views/agent/send.js:279-280`），再在渲染层解析模型正文里的 `<adm_decision_result>` 标签画卡片。它能跑，但根因级问题都出在"服务端不知道这是决策轮"：

1. **重复输出**：服务端把"只有正文、没有工具调用"的 stop 判为叙述性停止并 nudge 重试（`admAgent/internal/agent/agent_loop_llm.go:1178-1196`，`isLikelyCodingTask(call.Prompt)` 因为契约里全是 JSON/code fence 之类关键词而误判成编码任务），模型被迫重发结果 → 同一轮出现 3 条 assistant 消息、3 份结果块。
   实测证据（`%LOCALAPPDATA%\admAgent\cache\admAgent.log`，会话 `c161fc53-…`）：
   ```
   16:12:57 step 1: finish_reason=stop text_bytes=208 tool_calls=0 → "narrative stop without tools, retrying with nudge"
   16:13:00 step 2: stop text 179 tools 0 → 再次 nudge
   16:13:04 step 3: stop text 200 tools 0 → "repeatedly returned narrative stop, ending turn"
   ```
   会话 DB 中该轮为 1 条 user + 3 条 assistant（每条 `parts=[text,finish]`，各含一个结果块，无工具调用）。
2. **契约文本落入用户消息**：控制块随 `prompt` 落库，导致 ① 会话自动标题被英文契约污染（服务端用首条 user 消息生成标题，`internal/agent/agent.go:941-945, 2414`）；② 共享同一会话的其它客户端（TUI、微信 Bot）会看到原始控制标签。
3. **模型侧不可控**：`response_format`/`json_schema` 之类强制结构化输出只能由服务端发，前端拼提示词无法做到"强制"。
4. **前端兜底很脆**：桌面端只能事后校验（`src/views/agent/sse.js:79-81` 提示"未返回有效结果"）+ 渲染层去重（`src/views/agent/render.js:257-267`、`:642-656`）；浪费的两次重复生成无法从客户端拦住。

结论：**上移到服务端是正确方向**。服务端掌握 ① 系统提示词 ② 工具面 ③ 循环终态 ④ 消息协议 ⑤ `response_format`，这五件事恰好覆盖上面 1–4。

## 2. 可行性结论

可行，且改动面可控：

| 能力 | 服务端现有落点 | 改动性质 |
|---|---|---|
| 每轮参数传递 | `proto.AgentMessage`（`internal/proto/proto.go:134`）→ `backend.SendMessage`（`internal/backend/agent.go:29,96`）→ `agent.SessionAgentCall`（`internal/agent/agent.go:219`） | 加字段（有 `ProviderOptions`/`MaxOutputTokens` 先例） |
| 决策专用系统提示词 | `sessionAgent.Run` 内 `systemPrompt := a.systemPrompt.Get()`（`internal/agent/agent.go:905-906`），可对本轮局部追加 | 新增 prompt 片段，零侵入 |
| 工具面收敛 | 首版决策轮**不注册工具**（`tool_policy=none`）；若日后开放只读/继承，复用 `config.ResolvePlanModeTools`（`internal/config/config.go:820`）与既有权限系统 | 首版零改动；开放时复用机制 |
| 循环终态 | **不改主循环**：在 `Run` 的循环调用点旁路出一个**独立决策轮**（`internal/agent/decision_turn.go`，见 3.3），`agent_loop_llm.go` 零改动 | 新增 1 个文件 + 分派点 4 行 |
| 结构化消息 part | `ContentPart` 接口 + `partWrapper` 序列化（`internal/message/content.go:44`、`internal/message/message.go:536-587`） | 新增一种 part（Phase 2） |
| 强制结构化输出 | `llm.Request` 可透传 `extra_body`；本仓已有 `buildAdaptiveBody`（`internal/llm/client.go:360+`）处理参数兼容 | 可选，按 provider 能力降级 |

风险评估（采用 3.3 的旁路管线后）：主循环 `agent_loop_llm.go` 与它那套抖动恢复体系（空 stop / 叙述性 stop / todos nudge / 输出退化看门狗）**一行都不改**，普通轮（TUI 与桌面普通对话）走的仍是原路径原代码，不存在"在主循环里加分支"带来的回归面。剩下的风险集中在**新文件的胶水是否与既有流程语义一致**（消息落库、SSE 事件、用量、压缩交接），用"事件序列等价"用例兜住（见 7.3b）。

## 3. API 设计

### 3.1 请求（`POST /v1/workspaces/{id}/agent`）

沿用现有端点（`internal/server/proto.go:785`，路由 `internal/server/server.go:193`），新增可选字段：

```jsonc
{
  "session_id": "…",
  "run_id": "…",
  "prompt": "用户问题",            // 决策轮不再携带任何控制块
  "attachments": [ … ],
  "decision": {                    // 省略 = 普通对话（完全保持现状）
    "mode": "auto",                // auto | choice | bool | score
    "tool_policy": "none",         // none | readonly | inherit（默认 none：决策轮不注册工具，见 3.3）
    "structured_output": "auto"    // auto | off（是否尝试 response_format，见 3.5）
  }
}
```

- `proto.AgentMessage` 增加 `Decision *DecisionSpec`；`agent.SessionAgentCall` 增加 `Decision *DecisionSpec`（或扁平化为 `DecisionMode string` + 两个 bool，避免 agent 包依赖 proto）。
- 校验（`agent.ValidateCall`，`internal/backend/agent.go:39` 已在此调用）：`mode` 必须属于枚举，否则 `400 invalid decision mode: …`；`structured_output`/`tool_policy` 非法值同样是 400，不做静默降级（前端拼错要能立刻发现）。`tool_policy` 非 `none` 时才需要工具面处理（首版可先只支持 `none`，其余值返回 400 “not supported yet”）。
- `GET /v1/workspaces/{id}/agent` 的回包无需变动（决策模式是**每轮参数**，不落配置、不落会话）。
- 会话级"记住模式"仍由客户端负责（桌面端已有 localStorage 实现），服务端保持无状态。
- swagger（`internal/swagger/*`）与 `doc/server-api.md` 同步更新。

### 3.2 系统提示词（服务端定义）

在 `sessionAgent.Run` 组装系统提示词处（`internal/agent/agent.go:905-906`）对本轮**局部**追加（不改 `a.systemPrompt` 共享值，避免污染后续轮次）：

```go
systemPrompt := a.systemPrompt.Get()
if call.Decision != nil {
    systemPrompt += "\n\n" + decision.SystemPrompt(call.Decision)   // 新包 internal/agent/decision 或 prompt 子包
}
```

`decision.SystemPrompt` 按 mode 生成，内容要点（与现有前端契约等价，但服务端权威）：

- 输出格式硬约束：整条回复**只有**一个 `<adm_decision_result>` 块 + 单个 JSON 对象，无正文、无 markdown、无代码围栏；**每个问题只输出一次**，不得在后续步骤/重试中重复。
- 类型集合 `auto|choice|bool|score` 与各自 JSON 形状（键名固定）。
- 禁止编造概率/百分比/置信度（本版不支持）。
- 决策结果只是建议，**不得**因此自动执行任何修改类操作；权限规则照旧。
- 缺关键事实时仍落到最接近的类型，把缺口写进 `reason`，不得退回散文。

好处：契约不再进用户消息 → 标题不再被污染、TUI/微信看不到控制块；提示词可随服务端版本演进，前端不用跟着改文案。

### 3.3 独立决策轮（旁路管线，主循环零改动）

决策做成与主循环**并列**的一条执行路径，而不是塞进主循环的条件分支：

- **新文件**：`internal/agent/decision_turn.go`，实现

  ```go
  func (a *sessionAgent) runDecisionTurn(
      genCtx context.Context, call SessionAgentCall, largeModel Model,
      systemPrompt, promptPrefix string, history []fantasy.Message, files []fantasy.FilePart,
      currentAssistant **message.Message, currentSession *session.Session,
  ) (result *fantasy.AgentResult, shouldSummarize bool, retErr error)
  ```

  签名/返回值与 `runMainLoopWithLLM`（`internal/agent/agent_loop_llm.go:312-324`，返回 `(*fantasy.AgentResult, bool, error)`）**对齐**，因此可以直接替换调用点。

- **唯一分派点**（`internal/agent/agent.go:1077-1081`，4 行）：

  ```go
  if largeModel.Client != nil {
      var ss bool
      if call.Decision != nil {
          result, ss, err = a.runDecisionTurn(genCtx, call, largeModel, systemPrompt, promptPrefix, history, files, &currentAssistant, &currentSession)
      } else {
          result, ss, err = a.runMainLoopWithLLM(genCtx, call, largeModel, systemPrompt, promptPrefix, agentTools, history, files, maxOutputTokens, &currentAssistant, &currentSession)
      }
      shouldSummarize = ss
  }
  ```

  分派点以下的代码（错误/取消收尾、`currentAssistant` 状态落库、`empty_output` 判定、`publishRunComplete`、标题生成、摘要交接）**全部复用**，因为它只依赖 `(result, shouldSummarize, err)` 与 `currentAssistant/currentSession` 两个指针约定。

- **决策轮复用的既有件**（只读调用，不修改）：
  - 运行前准备：`a.preparePrompt`、`a.buildCurrentUserMessage`、`fantasyMessagesToLLM`（`agent.go:1062-1066`、`agent_loop_llm.go:333-334`）；
  - **消息落库 + SSE 广播**：`a.messages.Create/Update` —— 事件由消息存储在内部发布（`internal/message/message.go:210,395-397`），决策轮**不需要自己发事件**，前端看到的 `message created/updated` 序列与普通轮一致；
  - 终端事件：`a.publishRunComplete`（`agent.go:1059`）；
  - 上下文守卫：`contextLimit` + `approxTokenCount` + `a.estimatePostSummarizePromptTokens`（`agent_loop_llm.go:609-618`、`agent.go:2562-2589`）——发请求前做同一套 70% 守卫，命中即返回 `shouldSummarize=true`，由上层按普通轮同样流程触发压缩。

- **决策轮自己负责**（全部在新文件内，不外溢）：
  1. 契约系统提示词（3.2）与请求组装（可选 `response_format`）；
  2. **自有终止条件**：一次请求 → 校验 →（失败时）一次带具体校验错误的定向重试 → 结束。没有 nudge、没有 todos 追踪、没有工具循环、不触发主循环的看门狗；
  3. **自有结果校验**：`Parse(text) (Result, error)`；命中即把结果写成 assistant 消息（Phase 1 文本标签 / Phase 2 专用 part），并剥离结果块之外的正文；
  4. **失败语义**：重试用尽仍无合法结果 → 返回错误，走既有错误收尾，`run_complete` 带 `error`（前端因此能明确提示，不再靠 `sse.js` 事后兜底）。

- **代价与对策**：少量胶水（创建 assistant 消息、用量累计、`result` 形状）与主循环重复 → ① 胶水全部复用上表既有件，不重写事件与落库；② 用"同 session 跑普通轮 vs 决策轮，断言 DB 行结构 + SSE 事件类型序列 + `run_complete` 字段语义一致"的用例防漂移（7.3b）；③ 决策轮不注入工具结果，上下文增长远小于主循环，超窗只可能来自长历史，已由同一套 70% 守卫 + 摘要交接覆盖。

- **需要工具取证怎么办**（若审核选 `tool_policy=inherit`）：不要在决策轮重实现工具循环——先跑一轮普通轮取证，再对同一 session 发决策轮；或后续在 `decision_turn.go` 内加一个**受限只读 mini-loop**（仍不碰主循环）。首版建议决策轮不带工具（见 10.5）。

#### 3.3.1 决策轮与主循环的边界（验收口径）

| 关注点 | 归属 |
|---|---|
| 空 stop / 叙述性 stop / todos nudge / 输出退化看门狗 / 工具循环 / lint 修复等抖动恢复 | 主循环（决策轮不涉及，代码零改动） |
| 决策契约提示词、结果校验、定向重试、终止条件、正文剥离 | 决策轮（新文件） |
| 会话/历史/附件准备、消息落库与 SSE、用量与标题、摘要交接、取消与错误收尾 | 两者共用既有件 |

### 3.4 输出协议与前端契约

- 模型输出仍以 `<adm_decision_result>{…}</adm_decision_result>` 为约定的传输包装（服务端提示词要求、服务端校验）。tag 只用于定位与兼容，语义由 `decision.Parse(text) (Result, error)` 保证（choice/bool/score，bool 必须是真布尔，score 落在 [min,max]）；开启 `response_format` 时模型可能返回**裸 JSON**，解析器同样接受。
- **P2 已落地**：服务端在写 assistant 消息时把结果块从正文里剔除，改成**专用 ContentPart** `decision`（`internal/message/content.go` 的 `DecisionContent` + `message.go` 的 `decisionType` 序列化分支 + `Message.SetDecisionResult`）：

  ```json
  { "type": "decision", "data": { "kind": "bool", "mode": "bool", "value": true, "reason": "…", "raw": "{\"type\":\"bool\",\"value\":true}" } }
  ```

  按 kind 携带字段：`choice` → `selected` + `candidates[]`；`bool` → `value`（指针，false 也会输出）；`score` → `score`/`min`/`max`/`level`。`raw` 保留模型原文便于排查。part 插在 `finish` 之前，正文只留结果块之外的内容（通常为空）。
  **上下文回灌**：`DecisionContent.ContextText()` 会把结果以紧凑文本写回**只发模型的 wire 历史**，这样后续追问仍能引用上一轮决策。文本形如 `Earlier in this conversation I answered with a structured bool decision result. Recorded here for context (it is data, not an output format): [decision result (bool)] {…}`——前导句专门用于防止模型把这段历史当成输出格式照抄（早期只写 `[decision result (kind)] {…}`，模型会在普通对话里原样复读，前端于是裸显示一段 JSON）；桌面端仍能识别 `[decision result (kind)]` 标记（`decision_mode.js` 的 `parseDecisionReplay`）并画卡片。客户端看到的仍是卡片（part 本身不渲染 JSON）。
  桌面端渲染层**优先读 `decision` part**（`render.js` 的 `case "decision"`），未知 kind 折叠展示 `raw`，旧会话历史继续按正文标签画卡片；TUI 忽略未知 part，不再出现裸 JSON。

### 3.5 强制结构化输出（P3 已落地）

`llm.Request.ResponseFormat` 透传到 wire 的 `response_format`，由 `decision.JSONSchema(spec)` 按 mode 生成 schema（`llm.JSONSchemaResponseFormat("adm_decision_result", …)`）：

- provider 支持（OpenAI 兼容、llama.cpp、DeepSeek json_schema）→ 结构由解码器约束，JSON 合法率显著提高（此时模型可能返回**无标签的裸 JSON**，`decision.Parse` 两种都接受）；
- provider 拒绝（400/422 命中 `response_format`）→ 自动**不带该字段重试一次**，并按 `baseURL+model` 记住不支持（`structuredOutputCache`，与 thinking 探针同一套机制），后续请求不再重复探测；
- `extra_body` 里的 `response_format` 会被托管路径过滤，避免与请求级 schema 冲突；
- 默认 `structured_output=auto`，可用 `off` 关闭（`off` 时完全依赖提示词契约）。

### 3.6 阶段划分

| 阶段 | 内容 | 收益 |
|---|---|---|
| P0 | 新增旁路决策轮 `internal/agent/decision_turn.go`（单次请求 + 校验 + 一次定向重试）+ `agent.go:1077` 的 4 行分派 + `decision` 请求字段接线（**主循环零改动**） | 立刻消除重复输出（3 份结果 / 3 张卡）与多余的上游调用 |
| P1 | `decision` 请求字段 + 服务端系统提示词 + 结果校验 + 失败显式报错 | 前端不再注入契约；标题/TUI 干净；错误可读 |
| P2 | `decision` ContentPart + SSE 增量 + 历史读取 | 消息协议干净；多客户端一致；卡片数据强类型 |
| P3 | `json_schema` 强制输出 + 按 provider 记忆回退 | JSON 合法率与稳定性 |

## 4. 桌面端改造（P1 之后）

- `src/views/agent/send.js:279-280`：删除 `buildDecisionConstraint(decisionMode)` 注入，改为请求体带 `decision`：
  ```js
  var body = { session_id: sessionId, prompt: text, decision: { mode: requestMode, tool_policy: "none", structured_output: "auto" } };
  ```
- `src/views/agent/decision_mode.js`：`buildDecisionConstraint` 废弃（保留 `parseDecisionResult`/卡片渲染/本地模式存储）；新增 `decisionRequestPayload(mode)`（`text` → 不传字段）。
- `src/views/agent/render.js`：判据从"轮内出现标签"扩展为"轮内有 `decision` part 或标签"；运行中隐藏（哨兵）、只保留最后一张卡片、失败回落展示等现有行为保持不变。
- `src/views/agent/sse.js:79-81`：`verifyDecisionRun` 的"未返回有效结果"兜底可由服务端 `run_complete.error` 取代（保留一版兼容旧服务端）。
- `src/views/agent/send.js:202-205`：PDF + 决策的互斥提示保留。

## 5. TUI / 其它客户端影响

- 决策模式是**每轮 opt-in**，TUI 不传 `decision` → 行为与现在完全一致（不注入提示词、不收敛工具面、不豁免 nudge）。
- 反向收益：桌面端决策轮的控制块不再进用户消息，TUI/微信不再看到英文契约；P2 后也不再看到裸结果 JSON。
- 需在 `doc/server-api.md` 中标注"`decision` 仅桌面端使用，TUI 可忽略"。

## 6. 兼容与迁移

- **无 DB 迁移**：P1 不加字段、不改存储结构；P2 的新 part 类型对旧客户端表现为未知类型（桌面端 `render.js` 的 `default` 分支会重建该 part，需在 P2 同时加渲染分支）。
- **旧会话历史**：文本标签仍可解析 → 卡片照常渲染。
- **旧服务端 + 新桌面端**：桌面端保留"服务端不认 `decision` 字段"的降级路径（400/忽略时回落到现有提示词注入），或直接要求版本下限（内置 sidecar 与桌面端同版本发布，实际不存在混用；建议直接要求下限，简单）。
- **发布顺序**：服务端先行（P0/P1）→ 桌面端切换注入方式 → 移除旧代码路径。

## 7. 测试清单（服务端）

1. `proto`/`ValidateCall`：非法 `mode`/`tool_policy` → 400；缺 `decision` → 行为与旧版逐字节一致（黄金用例：同一请求的 wire body 不变）。
2. 系统提示词：决策轮 system prompt 含契约、普通轮不含；不影响 `a.systemPrompt` 共享值（并发两轮不同模式互不污染）。
3. 决策轮终态：① 一次请求即产出合法结果 → 恰 1 次上游 LLM 调用、无 nudge、`run_complete` 无 error；② 输出非法 JSON → 恰 1 次带具体校验错误的定向重试；③ 重试仍失败 → `run_complete.error` 非空；④ 模型在结果前后夹带正文 → 服务端剥离后落库，正文不进消息。
3b. **事件序列等价**（防胶水漂移）：同一 session 分别跑普通轮与决策轮，断言 DB 行结构、SSE 事件类型序列（`message created` / `updated` / `run_complete`）、`run_complete` 字段（含 `empty_output`）在两条路径上语义一致。
4. 工具面：`readonly`（若启用）时不出现 `edit`/`write` 等写入类调用；默认决策轮不带工具（`decision_turn.go` 不注册工具）。
5. 回归验收门槛：`agent_loop_llm.go` 零改动 → 既有单测（空 stop / 叙述性 stop / todos nudge / 输出退化）与 TUI e2e（`internal/server/e2e_agent_test.go` 等）**逐条原样通过**。
6. P2：`decision` part 的序列化往返、SSE 增量、历史读取、未知 part 的前向兼容。

## 8. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 主循环回归 | 不在主循环内加分支（3.3 旁路管线）→ 该风险降为"一个分派点" | `call.Decision == nil` 时调用参数与现在逐字节一致；既有单测/e2e 作为门槛 |
| 胶水与主循环语义漂移 | 决策轮自建 assistant 消息/用量/`result` 形状，可能与主循环逐渐分叉 | 复用 `a.messages.*`/`publishRunComplete`/摘要交接；用 7.3b 事件序列等价用例兼住 |
| 提示词与服务端版本耦合 | 契约随服务端演进 | 前端渲染层对未知字段宽容（已有 `normalizeDecision` 风格），只渲染认识的键 |
| 决策轮无工具 | 需要跑命令取证的决策场景取不到证据 | 首版：先跑普通轮取证再发决策轮；后续可在新文件内加受限只读 mini-loop（仍不碰主循环） |
| `json_schema` provider 差异 | 部分网关 400 或忽略 | 探测 + 一次性回退 + 按 `baseURL+model` 记忆（复用既有机制） |
| 结果 JSON 仍是"模型自报" | 不是校准概率 | 保持"不提供概率/置信度"的既定口径，卡片底部注明 |

## 9. 落地顺序

1. ✅ P0：新增 `internal/agent/decision_turn.go`（单次请求 + 校验 + 一次定向重试）+ `agent.go` 分派点 + `decision` 请求字段 → 消除重复生成与 3 张卡，**主循环零改动**。
2. ✅ P1：决策轮接管契约系统提示词 + 结果校验 + 失败报错；桌面端切换为传字段（未保留客户端回退，改为依赖同版本发布，见 §6）。
3. ✅ P2：`decision` ContentPart（结果落库为 part、正文剔除 JSON）+ 桌面渲染分支（part 优先，未知 kind 折叠 raw）。
4. ✅ P3：`json_schema` 强制 + 被拒后一次回退 + 按 `baseURL+model` 记忆（`structuredOutputCache`）。

## 10. 决策点与当前取值

1. **P0 是否先单独上**？——✅ 已按"旁路决策轮 + 请求字段接线"落地（主循环零改动）。
2. **决策轮是否带工具**？——当前取值：**不带**（`tool_policy=none`）；确需证据时先跑一轮普通轮再把结论交给决策轮；后续若要放开，只在 `decision_turn.go` 内加受限只读 mini-loop，不碰主循环。
3. **P2 专用 part**？——✅ 已做：`kind/mode/reason/selected/candidates/value/score/min/max/level/raw`，part 插在 finish 之前，正文只留结果块之外的内容。
4. **是否默认开启 `json_schema` 强制**？——✅ `auto`（能开则开，被拒即静默回退提示词模式并记住），可传 `off` 关闭。
5. **工具面**（若 2 选带工具）：只读 vs `inherit`？——仍为待定，届时复用 `config.ResolvePlanModeTools`。
