# 步数触顶「UI 决策卡」实施计划（终稿待确认）

> 方案已按用户决策收敛为最简形式：**达到最大步数 → 弹决策卡，用户选择"继续干活"或"终止查原因"**。
> 不做进度熔断、不做 token 预算、不做上下文治理改造（Backlog 见文末）。

## 交互（文案定稿）

步数耗尽（模型仍在正常发工具调用被硬上限掐断）时，不弹红色错误气泡，弹决策模态卡（复用 permission-modal 样式）：

- 标题：**大模型已经推理很久啦**
- 正文：**还是没有解决您的问题吗？您是否要大模型继续干活不解决不罢休，还是终止本次交互，查看下原因先？后续您还可以给我说“继续”来完成本次任务。**
- 主按钮 `[继续干活，不解决不罢休]` → 程序化发送通用续跑 prompt（等同用户输入"继续"），重新 arm 自动续跑守卫；再次触顶会再次弹卡（每轮显式决策，不静默连环续跑）
- 次按钮 `[终止，查看原因]` → 关闭卡片，状态栏保持"就绪"；后续手动发"继续"即可恢复（常规会话用法，零额外代码）

## A. admAgent 服务端（2 个文件点，批准后实施）

### A1. `internal/agent/agent_loop_llm.go`

1. 上限提高：`const maxAgentSteps = 64` → `128`（line 27；保持原注释语义）
2. 哨兵错误（放 errStepCap 变量区，注释注明 `max_steps_reached` 为前端分类依赖的稳定 token，改文案不得删除）：

```go
var errStepCap = fmt.Errorf(
    "max_steps_reached: the agent used its entire %d-step budget for this turn "+
        "while still working; the task is likely incomplete; send \"继续\" to resume", maxAgentSteps)
```

3. 触顶判定：把 `stepIdx` 声明提到 `for` 外，循环自然耗尽后（line 1421 `}` 之后、组装 result 之前）：

```go
// 仅"自然耗尽"才判触顶：endTurn/stopTurn/硬失败/重复环/summarize 均显式 break 到此判定之外。
// genCtx 已取消（收尾恰在第 128 步的竞态）不设 step_cap，由 Run defer 标 cancelled。
if stepIdx >= maxAgentSteps && loopErr == nil && !shouldSummarize && genCtx.Err() == nil {
    loopErr = errStepCap
    slog.Warn("Agent loop: reached max step cap, ending turn with visible error",
        "steps", stepIdx, "model", modelID)
}
```

4. 触顶判定抽成纯函数 `stepCapError(stepIdx int, loopErr error, summarize bool, ctxErr error) error` 便于单测。

错误传播零改动：`agent.go:1000-1001` 现有 defer 把 retErr 写入 `complete.Error` → proto → SSE run_complete。
TUI 端（共享 server）触顶将显示该错误文本——行为从"静默结束"变"可见中断"，符合预期。

### A2. 编译与打包

- `go build ./...` + `go test ./internal/agent/ -count=1`
- `build.ps1` 重编 → 更新 `buildAgent/admAgent_{ver}_Windows_x86_64.zip`（桌面端 sidecar 内置分发，不重打包不生效）

## B. 桌面端前端（`src/views/agent/`）

### B1. `error.js` — 新增分类（置于所有正则之前，防被泛化规则截获）

```js
export var ERROR_STEP_CAP = "step_cap";
var STEP_CAP_RE = /max_steps_reached/i;
// classifyError(): if (STEP_CAP_RE.test(text)) return ERROR_STEP_CAP;
```

### B2. `ui.js` — 泛化弹窗

- `showConfirm(message, onOk)` → 抽出 `showChoice({ title, message, okText, cancelText, onOk, onCancel })`（permission-overlay 同机制、挂 `.agent-root`、随 unmount 销毁）
- `showConfirm` 保留为薄封装（现有调用点行为不变，实施前 grep 确认调用点）

### B3. `autocontinue.js` — 续跑复用

- `sendContinuePrompt(sessionId)` 现有 todos 专用文案参数化：`sendContinuePrompt(sessionId, promptText)`，旧调用方传原文案
- 新增导出 `continueAfterStepCap(sessionId)`：`armAutoContinue(sessionId)`（复用 MAX_AUTO_ROUNDS=10 / 连续 2 轮无进展熔断守卫）+ 发送通用文案：
  "继续完成刚才的任务。若有未完成的步骤，请继续使用工具推进，直到任务完成后给出总结。"

### B4. `sse.js` — run_complete error 分支（line ~309-318）

```js
if (actualData && actualData.error) {
  if (classifyError(actualData.error) === ERROR_STEP_CAP) {
    resetAutoContinue();                       // 本轮收尾
    updateStatusBar("ready", null, S.contextUsage.used);  // 非 error 红态
    showStepCapDialog(actualData.session_id);  // 决策卡（不弹错误气泡）
    break;
  }
  ...现有 appendErrorBubble 逻辑不变...
}
```

- 卡内主按钮回调 = `continueAfterStepCap(sid)`；次按钮 = 关闭 + `showInfo(_t("可随时发送"继续"恢复本次任务"))`
- 后台 workspace 的 run_complete（line ~125-130 分支）维持现状（错误气泡），**不弹卡**——多 tab 同时弹窗会互相遮挡
- 新文案全部 `_t()` 包裹

### B5. 文档

- `doc/server-api.md`：run_complete `error` 说明补一句"含 `max_steps_reached` 标记 = 步数触顶"

## 测试与验收

| 项 | 方法 | 预期 |
|---|---|---|
| Go 单测 | stepCapError 表驱动：耗尽→errStepCap；endTurn break→nil；取消竞态→nil；summarize→nil | 全绿 |
| 前端类型 | `pnpm typecheck` | 0 错误 |
| 决策卡 | devtools 注入含哨兵 error 的 run_complete | 弹卡、双按钮、无红色气泡、状态栏就绪 |
| 继续干活 | 点主按钮 | 新 run 启动、用户气泡出现、续跑守卫重新生效 |
| 端到端 | 新 sidecar + >64 步真实大任务 | 不再 64 步静默；128 步弹卡；续跑后接着干 |
| 回归 | 正常完成/手动取消/quota/empty_output/后台 workspace 触顶 | 各分支行为不变 |

## 工作量

- admAgent：~0.5h 编码 + 0.5h 测试 + 重打包
- 桌面端：~1.5h（含文案、弹窗泛化、手工验证）
- 总计 ~3h

## 风险（已知可接受）

1. 旧桌面端 + 新 server：触顶显示红色"本轮对话中断: max_steps_reached…"气泡——可见但样式普通
2. 哨兵是文本约定：server 改文案必须保留 `max_steps_reached`（注释 + 单测锁 token）
3. 128 上限使最坏单轮耗时/成本约翻倍：由用户点"继续干活"知情消费

---

## Backlog（本轮不做，调研结论存档）

- **通用进度熔断**：todo-nudge（`agent_loop_llm.go:1130-1166`）只护"提前停"，无 todos 的"原地转"不设防；可基于 `isMutatingToolName`/loose 签名做 no-progress nudge + 熔断
- **上下文治理**：70% guard 在 `cw==0` 时整体跳过（`agent_loop_llm.go:532`），实测 222k 无护栏；工具输出 cap `cw*0.03` 无绝对封顶（`agent.go:146/162`）
- **其余静默 break 显式化**：工具硬失败（:1390）、重复环（:1414）同样静默，可仿照本方案加各自哨兵
