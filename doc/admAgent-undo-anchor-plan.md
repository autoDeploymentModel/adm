# 撤销能力：每轮撤销 / 跨轮撤销 / 非 git 目录（服务端方案，待审核）

> 状态：**P1（anchor 参数）与 P2（快照保留窗口 `options.undo_checkpoints`）已落地**，P3（非 git 目录的文件快照）按本文结论先不做。
> 当前行为以 `doc/server-api.md` §4.11 与 `doc/frontend-agent-conventions.md` 为准；本文件保留为方案记录。
> 前端实现见 `src/views/agent/undo.js`，行为约定见 `doc/frontend-agent-conventions.md`
> 的「撤销入口挂在每个对话容器上」。
> 本文件是**审核材料**：列出现状约束、需要改的点、风险与验证方式。审核通过后再动 admAgent。

---

## 1. 桌面端现状（已落地，不依赖服务端改动）

每轮 `.msg-round` 标题栏上的 `↶` 是撤销入口，语义是「撤销这一轮及其之后的所有轮次」。

跨轮撤销的现做法：`undo.js` 从末轮起**逐轮调用** `POST /v1/workspaces/{id}/agent/sessions/{sid}/undo`，
次数 = 目标轮到末尾的 user 消息条数，全部成功后重拉会话。

保留的已知边界（确认文案已如实告知用户）：

1. 服务端每个会话只保留 **3 轮**文件快照 → 回退超过 3 轮时，更早轮次只能删消息，文件改动残留；
2. 工作目录不是 git 仓库 / 没装 git → 服务端从不采集快照，只能删消息（`check_git_repo` 探测后提示）；
3. N 次整树还原不是原子操作，中途失败会停在"撤销了 k 轮"的中间态（前端提示重试）。

## 2. 服务端现状（源码定位，均已核对）

| 位置 | 现状 |
| --- | --- |
| `internal/server/proto.go` `handlePostWorkspaceAgentSessionUndo` | 请求体为空，只取 path 参数，无 anchor |
| `internal/backend` `UndoSession(ctx, wsID, sid)` | 无 anchor 参数 |
| `internal/workspace/workspace.go` 接口 `AgentUndo(ctx, sessionID)` | 无 anchor；`app_workspace.go` / `client_workspace.go` 两处实现 |
| `internal/client/proto.go` `AgentUndoSession` | POST 无 body |
| `internal/agent/coordinator.go` `Undo` | 先 `snapshotter.Latest(sessionID)`，有快照就 `Restore(rec.Anchor)` + `cleanupAfterUndo` + `Remove`；没有就走 `undoConversationOnly`（取最近一条 user 消息做 anchor） |
| `internal/undo/snapshot.go` | `Latest` / `Restore(ctx, sessionID, anchor)` / `Remove` / `lookupLocked`（未导出）；`maxCheckpointsPerSession = 3`；非 git 目录 `MaybeSnapshot` 静默跳过 |
| `internal/ui/model/ui.go` + `dialog` | TUI 的 `ctrl+b` 走同一 `AgentUndo`，只撤最后一轮 |

关键点：`Restore` 和 `cleanupAfterUndo` **本来就是按 anchor 工作的**，缺的只是"选哪一个 anchor"的入口。

## 3. 待审改动点

### P1 — undo 支持 anchor（跨轮撤销变成一次调用）

- 请求体新增可选字段 `anchor`（该轮起始 user 消息 ID）：
  `POST .../undo` body `{"anchor": "<userMessageId>"}`；缺省 = 保持"回滚最后一轮"的老行为（TUI 不改也能用）。
- 链路透传：`proto.go` 解析 body → `backend.UndoSession(ctx, wsID, sid, anchor)` →
  `workspace.AgentUndo(ctx, sessionID, anchor)`（三处实现：`app_workspace.go`、`client_workspace.go`、`workspace.go` 接口）→
  `client.AgentUndoSession(ctx, id, sid, anchor)` → `coordinator.Undo(ctx, sessionID, anchor)`。
- `coordinator.Undo` 内部分支：
  - `anchor == ""` → 现有逻辑（`Latest`）；
  - 否则 `snapshotter.Lookup(sessionID, anchor)`（把现有 `lookupLocked` 导出）拿到该轮快照 →
    `Restore` + `cleanupAfterUndo(ctx, sessionID, rec)` + 清掉**该 anchor 及其之后**的所有 checkpoint（`Remove` 逐个或新增 `RemoveFrom`）；
  - 没有该 anchor 的快照（该轮没改文件 / 快照已被 3 轮窗口淘汰）→ 用该 user 消息的 `CreatedAt` 合成 `undo.Record`，只做 `cleanupAfterUndo`
    （`cleanupAfterUndo` 已按 `AnchorCreatedAt` 删消息，天然支持"删 anchor 之后全部")。
- 权限/并发护栏不变：`ErrUndoConcurrentSession` 仍按整工作目录拒绝。

收益：N 次网络往返 + N 次整树还原 → 1 次；中途失败不再有中间态。

### P2 — 快照保留窗口（跨多轮的文件回退精度）

- 现在 `maxCheckpointsPerSession = 3`，是为控制 `.git` 体积（每轮一个整树 commit + keep-alive ref）。
  跨轮撤销一旦成为主要用法，3 轮明显不够。
- 方案 A（推荐，改动最小）：把常量提成配置项（如 `options.undo_checkpoints`，默认 10），
  并在超限淘汰时**记日志**（当前静默淘汰，用户无从知道某轮已无法回退文件）。
- 方案 B：`undo.Latest` 之外提供 `UndoTo(anchor)`，用 `git read-tree`/`commit-tree` 直接生成目标树，
  只保留每轮一个 tree（无 commit），体积约减半，复杂度更高。
- 风险：`.git` 体积增长（长会话 × 大仓库）。A 的风险可控，B 需要实测。

### P3 — 非 git 目录的文件回退（可选）

- 现状：`MaybeSnapshot` 在非 git 目录静默跳过，撤销只能删消息——桌面端已经在确认弹窗里提示（`check_git_repo`）。
- 若要让非 git 目录也能回退文件，需要一套不依赖 git 的快照：在首轮改动前把工作目录里**被工具触及的路径**
  复制到 `<data_dir>/undo/<session>/<anchor>/`（`internal/filetracker` 已有路径记录），撤销时反向复制 + 删除新增文件。
- 代价：磁盘占用与"哪些路径算改动"的判定复杂度（bash 任意副作用无法穷举）；建议**先不做**，
  只在文档与 UI 里把限制说清楚。要做也必须默认关闭。

## 4. 验证（落地 P1 时）

- `go test ./internal/agent/ -run TestUndo -count=1`：新增 `TestUndoWithAnchor`（跨轮：3 轮各改文件，undo 第 1 轮 → 只剩第 0 轮消息、文件回到第 1 轮前）。
- `go test ./internal/undo/ -count=1`：`Lookup` 命中/未命中、淘汰后未命中仍能只回滚对话。
- E2E：`internal/server` 的 undo 用例补 body 传 anchor 的分支。
- 桌面端回归：`undo.js` 改为单次调用后，把确认文案里"超过 3 轮可能无法回退"的提示同步改掉（P2 落地后按新默认值改）。

## 5. 与 TUI 的关系

TUI 的 `ctrl+b`（`keys.go`、`ui.go` 的 `ActionUndo`）走老路径（不传 anchor），P1 落地后行为完全不变；
不需要同步改 TUI。
