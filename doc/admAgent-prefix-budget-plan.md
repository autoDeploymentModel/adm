# admAgent 固定前缀瘦身与预算守卫 — 开发计划（待审核）

> 状态：**P0 + P1 已落地**（T1/T2/T3/T4/T5/T6，见文末「实施结果」）；P2 分档、P3 MCP 延迟未做，留待实测数据决定
> 范围：`admAgent/` 服务端（系统提示词 + 工具目录 + eval），不涉及桌面端 `src/`、`src-tauri/`
> 关联文档：[`admAgent-server.md`](admAgent-server.md)（系统提示词预算与提示词缓存）、[`admAgent-eval-harness-plan.md`](admAgent-eval-harness-plan.md)
> 背景：参考 Anthropic《Building agents: When to fold subagents into your main agent loop》的结论——先量化、一次只改一处、只保留站得住的改动；不要为了"架构正确"引入新机制。

## 1. 问题（已实测，不是推测）

每一次 wire 请求都携带一段**固定前缀**：系统提示词 + 工具 JSON schema。它随步数线性计费，并且直接从压缩预算里扣掉：

- 代码注释记录的现状：`internal/agent/agent.go`（常量区，`recommendedContextWindow` 上方）写明固定每请求开销 **≈23k tokens**，但目录只有 **28 个工具**；32k 窗口下压缩后没有可用工作区（`workWindowAfterCompaction` 会返回负值）。
- 实测分布（`internal/agent/testdata/TestCoderAgent/glm-5.1/ls_tool.yaml` 里的真实录制请求，11 工具版本）：工具描述合计 **8859 字符**，其中 **bash 单工具 7241 字符（82%）**。
- 当前 bash 工具描述源 `internal/agent/tools/bash.md.tpl` 共 **7913 字符**，从 `<git_message_quality>` 起到底部 **5282 字符（占 67%）** 全是提交/PR 剧本，而这部分**只在用户要求提交时才有用**。
- 该内容与内建 skill `internal/skills/builtin/git-commit/SKILL.md`（4224 字节）**大面积重复**；`<pull_requests>` 段目前没有任何 skill 覆盖。
- 另有 `internal/agent/templates/coder.md.tpl`（11918 字节）与 `internal/agent/prompt/prompt.go` 注入的 `<project_structure>`（`fsext.BuildProjectTree(dir, 4, 600)`，最多 600 个文件）在每次请求里恒定发送。

**判断**：问题不是"28 个工具太多需要延迟加载"，而是**静态前缀里塞了可以删/可以搬的文本**。删文本比藏工具简单一个数量级，且不破坏 `prefix_sha`。

## 2. 目标与非目标

### 目标（可验收）

| 指标 | 现状 | 目标 |
| --- | --- | --- |
| 固定前缀（系统提示词 + 工具 schema） | ≈23k tokens | **P0 后 ≤12k；P1 后 ≤8k** |
| 单工具描述上限 | bash 7913 字符 | **≤1500 tokens** |
| 小窗口（≤40k）可用性 | 压缩后无可工作区 | **前缀 ≤6k，压缩后工作区 ≥20k** |
| 防回退 | 无约束 | 单测 + eval 双守卫 |

### 非目标（明确不做，避免返工）

- **不做 tool search / 工具定义延迟加载（内置工具）**：收益上限就是"23k → 8k"，本计划用删/搬就能达到，且不新增"模型不调用就永远找不到工具"的失败模式，也不破坏 `prefix_sha`（`toolsDigest` 参与前缀指纹，turn 内必须字节稳定）。
- **不做 `subagent_model`**（`admAgent/docs/subagent-model.md` 设计稿）：它解决成本隔离，不解决上下文膨胀。
- **不改压缩参数**（`compactionHeadroomRatio`、`summaryMaxTokensCap*` 等）：本计划先把固定开销降下来，压缩阈值应在新基线稳定后另行评估。
- **不重构为多代理/编排器**。

## 3. 任务分解

### P0 — 搬运（纯文案，无逻辑改动；预期吃掉过半收益）

**T1 把 bash 描述里的 git 剧本搬进 skill**
- 改动：`internal/agent/tools/bash.md.tpl` 删除 `<git_message_quality>`、`<commit_messages>`、`<git_commits>`、`<pull_requests>` 四段（5282 字符）；bash 描述保留一句指针："提交 / PR 流程见 `git-commit` skill"。
- 目标承载方：`internal/skills/builtin/git-commit/SKILL.md`。**迁移前必须逐条比对**，当前 skill 是中文流程 + 列表报告，bash 段里还有 skill 未覆盖的细节：
  - `git commit -m "$(cat <<'EOF' … EOF)"` 的 HEREDOC 写法与署名块
  - 失败处理：pre-commit 失败重试一次 → 仍失败则说明 hook 阻塞；成功但文件被改动则必须 `--amend`
  - 收尾：`git show --stat --oneline HEAD` + 以 Markdown 列表逐文件报告
  - **禁止项**：不改 config、不 push、不加 `-i`、不空提交、rebase 一律 `-m`
- `<pull_requests>` 段：并入同一 skill 的「PR」小节（不新建 skill，避免 skill sprawl）。
- 触发保障：skill description 已含 "commit/提交"；`coder.md.tpl` 的 `<critical_rules>` 第 12 条（LOAD MATCHING SKILLS）为兜底。
- 验收：`go test ./internal/skills/... ./internal/agent/... -count=1`；人工跑一次 `git-commit` skill 触发（提交到临时分支验证格式与署名行仍在）。

**T2 压缩工具描述里重复的长段落**
- 改动：`internal/agent/tools/view.go` / `edit.go` / `multiedit.go` 里重复出现的 `<whitespace_and_exact_matching>` 一类长说明 → 保留 3-4 行硬规则，"失败后怎么排查"这类细则移入对应 skill 或只留一句指针。
- **执行前先核查**：确认这段文本在三个工具里的重复份数（`grep -n "whitespace_and_exact_matching" internal/agent/tools/`），按份数决定是抽公共常量还是各自精简。
- 验收：`go test ./internal/agent/tools/ -count=1`；edit/multiedit 的「old_string not found」类失败率看 eval 是否翻转。

**T3 收紧 `<project_structure>` 文件树**
- 改动：`internal/agent/prompt/prompt.go` 中 `fsext.BuildProjectTree(workingDir, 4, 600)` → 深度 2、文件数 200（或做成 `options.project_tree_depth` 配置，默认 2）。
- 理由：模型有 `ls` / `glob` / `grep` 兜底；这段是每请求恒定成本且随仓库增长而膨胀。
- 风险：深层目录任务可能多花 1-2 步搜索 → 用 eval 的 `longctx-runbook` 与 `search-*` 任务判定。
- 验收：`go test ./internal/agent -run TestCoderPromptContainsProjectTree -count=1`（该测试断言树被注入，需同步调整断言阈值）。

### P1 — 预算守卫（让膨胀进不了主干）

**T4 前缀预算单测（核心交付物）**
- 新增 `internal/agent/prefix_budget_test.go`：
  - 用现有测试脚手架（`testEnv(t)` / `config.Init` 或 `internal/agent/agenttest.NewCoordinator`）构造**真实 coder 工具集** → `buildLLMTools` → `toolSchemaTokens`；
  - 用 `coderPrompt(...).Build(...)` 取真实系统提示词 → `approxTokenCount`；
  - 断言：`toolsTokens + sysTokens ≤ prefixBudgetTokens`（新常量，与 `recommendedContextWindow` 同放常量区，初值 **8000**）；
  - 断言：任一单工具的 `description + schema` ≤ 1500 tokens（防 bash 类回归）；
  - 断言：工具数 ≤ 32（超出必须先在计划里说明理由）。
- 说明：这是**确定性单测**，不烧模型调用，比加 eval grader 更可靠；eval 只承担行为回归。

**T5 运行时可见性**
- `internal/agent/agent_loop_llm.go` 的 `Loop step request` 日志补 `tool_tokens` / `sys_tokens` 两个字段（`toolSchemaTokens` 已在用，`approxTokenCount` 已在用），使"前缀涨了"能在一条日志里看出。
- 构建期（`coordinator.buildAgent` 的 `readyWg` 分支）在超预算时 `slog.Warn("prefix over budget", ...)`，不阻塞。

**T6 eval 增两个指标**
- `internal/eval/runner.go` 的 `RunResult` 增加 `prefix_tokens`、`tool_count`；`report.go` 输出到表格与 JSON 基线。不改判分逻辑（grader 类型不变）。

### P2 — 按窗口分档（可选，P0/P1 之后按数据决定）

**T7 小窗口只给核心工具集**
- 改动点：`coordinator.buildTools(ctx, agent, isSubAgent)` 目前拿不到模型；由调用方 `buildAgent` 传入 `model.ModelInfo.ContextWindow`（`config.ModelInfo.ContextWindow`），在其中过滤：
  - `cw < 64k` → 核心集：`bash, view, edit, multiedit, write, grep, glob, ls, todos`（+ `admAgent_info` 视情况）
  - `cw ≥ 128k` → 全量（保持现状）
  - 中间档 → 全量减去 `job_*` / `admAgent_logs` / `mcp` 资源类
- 要求：纯静态映射，turn 间稳定（不破坏 `prefix_sha`）；保留 `options.tools_minimal`（`auto|off`）以一键退回全量。
- 验收：小窗口模型跑 eval 6 条任务不翻转；`Loop step request` 的 `tools=N` 符合预期。

### P3 — MCP 工具延迟加载（唯一值得做延迟的地方，可后置或不做）

**T8 未启用的 MCP server 不发 schema**
- 现状：`tools.GetMCPTools(...)` 把所有已配置 server 的工具都追加进目录（`coordinator.buildTools`）。
- 改动：只发送"已启用/已连接" server 的工具；其余通过 `list_mcp_resources` / `read_mcp_resource` 或首次失败提示引导。
- 理由：MCP 工具数量由外部决定、随时增长，是唯一工具数会失控的来源。

## 4. 度量与验证流程（照文章纪律）

1. **先存基线**：P0 动手前跑一次 `admAgent/scripts/eval.ps1`（等价 `go run . eval`），保存 `internal/eval/baseline/<model>.json`，并记录 `Loop step request` 的 `est_input_tokens` 中位数。
2. **每个任务单独一轮**：一次只改一处 → 重跑 eval → 对比。每任务默认跑 3 次（`internal/eval/runner.go` 的 `DefaultRuns = 3`）。
3. **看翻转，不看总分**：逐任务 pass/fail 对比；出现翻转先回退那一处文案，不整体回退。
4. **指标清单**：`prefix_tokens`、`tool_count`、压缩触发次数与间隔（`compaction` 相关日志）、`steps`、`tokens`、6 条任务通过率。
5. **单测**：`go test ./internal/agent/... ./internal/config/... ./internal/skills/... -count=1`；若新增配置键，重新生成 `schema.json`（`go run . schema > schema.json`）。

## 5. 文档同步（收尾必查，见 `doc/conventions.md`）

| 改动落点 | 文档 |
| --- | --- |
| 系统提示词预算、工具目录、按窗口分档、前缀预算常量（`admAgent/internal/agent/**`） | [`admAgent-server.md`](admAgent-server.md) |
| eval 新指标 / 基线字段 | [`admAgent-eval-harness-plan.md`](admAgent-eval-harness-plan.md) |
| 新增配置键（若采用 `options.project_tree_depth` / `options.tools_minimal`） | `schema.json` 重新生成 + [`server-api.md`](server-api.md)（若涉及 API 字段） |
| 新增本文档 | 根 `AGENTS.md` 的「文档索引」加一行 |

## 6. 风险与回退

- **skill 迁移后模型不读 skill 就直接提交**（本计划最大风险）：折中方案是 bash 描述保留 **5 行摘要**（"先读 `git-commit` skill；署名固定为 …"），其余仍留在 skill；用 eval 对比"摘要版 vs 全删版"再定。
- **文件树收紧后搜索类任务多 1-2 步**：`longctx-runbook` / `tool-selection-local-doc` 任务判定；不通过则回到 depth 3。
- **分档导致某本地模型任务下降**：`options.tools_minimal=off` 一键退回。
- 每项改动独立可回退（文案独立、常量独立、过滤开关独立）。

## 7. 待审核决策点

1. **PR 流程**放哪里：并入 `git-commit` skill（推荐，避免 skill sprawl）还是新建 `git-pr` skill？
2. **`<project_structure>`** 直接收到 depth 2，还是做成配置项 `options.project_tree_depth`（默认 2）？
3. **P2 分档阈值与核心集**：小窗口阈值取 64k 还是 40k？核心 9 个工具是否够（是否必须保留 `lsp_diagnostics`）？
4. **执行授权**：`admAgent/` 目录按当前约定只读；本计划确认后，是由我直接实施，还是你按文档自行改？

## 8. 工作量与顺序

| 阶段 | 任务 | 预估 | 依赖 |
| --- | --- | --- | --- |
| P0 | T1 bash→skill 迁移 + 比对补齐 | 2-3h | 无 |
| P0 | T2 长描述压缩 | 1-2h | 先核查重复份数 |
| P0 | T3 文件树收紧 | 1h | 无 |
| P1 | T4 预算单测 | 2h | P0（预算常量按 P0 后实测定） |
| P1 | T5 日志/告警 + T6 eval 指标 | 2h | T4 |
| P2 | T7 按窗口分档 | 3-4h | P1 数据支撑 |
| P3 | T8 MCP 延迟 | 3-4h | 可选，单独评估 |

**若只允许做一件事**：T1 + T4（搬走 bash 里 67% 的剧本，并把 8k 前缀预算写进单测）——一天内可完成，收益最大且可验证。

## 9. 实施结果（后续补记，不改上文方案）

**实测（默认配置、27 工具、`TestPrefixBudget` 输出）**：系统提示 3202 tok + 工具 schema 5704 tok = **8906 tok**，最大单工具 bash 892 tok；改造前同一测量口径下 bash 描述渲染约 8.8k 字符、整包 ≈14.1k tok（见 `doc/admAgent-server.md` 的固定开销小节）。预算常量按此定为 `prefixBudgetTokens = 9200` / `maxToolPrefixTokens = 1500` / `maxToolCatalogueSize = 32`——留少量余量，但"再塞回一段剧本"（≈1.3k tok）一定爆。

| 任务 | 结果 |
| --- | --- |
| T1 | 四段 git/PR 剧本（5,282 字符）搬进 `git-commit` skill：提交信息规范、HEREDOC、hook 失败处理、`git show --stat` 验证、列表报告、PR 全流程全部并入；bash 描述只留 `<git>` 指针 + 硬禁区 + **动态署名 trailer**（`attribution` 由模板渲染，静态 skill 做不到）；`coder.md.tpl` 第 5 条改成指针 |
| T2 | **原假设不成立**：`whitespace_and_exact_matching` 在工具描述里出现 0 次，view/edit/multiedit 描述分别只有 389/996/190 字节，没有可删的重复长段。实际可压的是 bash 的 `<background_execution>`（15 行 → 4 行，与 job_output/job_kill 描述重复）、grep/glob 的「何时用/何时别用」缩成段落、todos 的 CRITICAL 四条 → 一段。合计 −564 tok |
| T3 | `options.project_tree_depth`（默认 2、夹 1–8）+ 文件数 200；`TestCoderPromptContainsProjectTree` 拆成「默认深度看不到深层文件」「显式 depth 4 能看到」两条 |
| T4 | `internal/agent/prefix_budget_test.go`：走生产 `coordinator.buildTools` + `prompt.Build`，断言总前缀 ≤ 预算、单工具 ≤ 1500 tok、工具数 ≤ 32 |
| T5 | `Loop step request` 增 `tool_tokens` / `sys_tokens`（复用已算出的两个量，不再重复计算 schema）；`coordinator.run` 在 `readyWg.Wait()` 后超预算 `slog.Warn`（`prefixWarnOnce` 每次构建只打一次） |
| T6 | `eval.RunResult` 增 `prefix_tokens` / `tool_count`；来源是可选接口 `eval.PrefixReporter`（`workspace.AppWorkspace.PrefixStats` → `coordinator.PrefixStats` → `sessionAgent.PrefixStats`）。**没有**把它们加进 `agent.Coordinator` / `workspace.Workspace` 接口：那会逼 6 个测试 stub 各写一份实现；报告与基线都记录这两个字段，但**不参与判定** |
| P2/P3 | 未做。前缀已降到 8.9k，按窗口分档（T7）和 MCP 延迟（T8）都应该先有 eval 数据再决定 |

**待审核决策点的选择**：① PR 流程并入 `git-commit` skill（不新建 skill）；② `<project_structure>` 做成配置项 `options.project_tree_depth`（默认 2），保留回退手段；③ P2 阈值与核心集未定（未做）；④ 本轮直接实施。

**已知风险**：`internal/agent/testdata/TestCoderAgent/**` 是逐字节匹配请求体的 vcr 录制（`charm.land/x/vcr` 的 customMatcher），任何提示词/工具描述改动都会让它在**非 Windows** 上失配——本次改动前后都会（基线本就落后于 bash.md.tpl 的多轮修改），录新 cassette 需要真实密钥，因此按"已有历史偏差"处理，未重新录制。
