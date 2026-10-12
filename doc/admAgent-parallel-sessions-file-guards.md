# admAgent 改造：同目录多会话并行的写保护（已实现）

> 桌面端「同目录多会话并行」（`src/views/agent/*`，开关 `agent_concurrent_sessions` **默认关**，
> 需在 Agent 设置→基础设置手动开启；并发上限 3）不需要
> admAgent 改动即可运行——服务端运行态本就按会话隔离（`activeRequests`/`messageQueue`/`cancelMark`/
> `sessionMu` 均以 sessionID 为键，见 `internal/agent/agent.go`，子 Agent 早已在同目录并发运行）。
>
> 本文档记录**并行带来的文件级风险**与对应的服务端防护（P0/P1/P2 均已在 admAgent 侧实现）。
> 注意：admAgent 改动后需重新编译并推送 sidecar（`admAgent/build.ps1` → `pnpm agent:push`）才会在 ADM 里生效。

## P0 — undo 并发保护（已实现）

- 问题：`coordinator.Undo` 调 `undo.Snapshotter.Restore`，实现是 `git reset --hard <PreHead>` +
  `git checkout-index -fa` + `git clean -fd`，**整棵工作树**回到本会话本轮开始前；同目录另一个会话期间
  的新建/修改文件、甚至它创建的提交都会被一起回滚。`Snapshotter.mu` 只保证快照与回滚不互相穿插，
  不感知其它会话。
- 实现：
  - `agent.SessionAgent` 新增只读查询 `ActiveSessionIDs() []string`（`internal/agent/agent.go`）：
    汇总 `activeRequests`（运行中）与 `acceptedRuns > 0`（已派发、尚未开始流式）的会话，去重；
    TUI 的占用会话列表与派发判定语义不变（`IsSessionBusy` 仍只服务派发决策）。
  - `coordinator.Undo`（`internal/agent/coordinator.go`）入口处：只要存在任何活动会话（含撤销目标自身
    ——本轮工具还在写文件时撤销本身无意义）就返回新错误 `ErrUndoConcurrentSession`，
    并在日志里记录活动会话；`currentAgent == nil`（未构建 agent 的测试/初始化失败的工作区）视为无运行。
  - 回归测试：`TestUndoRefusedWhileRunInFlight`（同目录其它会话运行 / 本会话运行均拒绝，且不删消息；
    全部结束后恢复可撤销）。

## P1 — edit/write/multiedit 的「校验 → 落盘」原子化（已实现）

- 问题：读后写守卫（`fileInfo.ModTime()` 对比本会话 `LastReadTime`）与真正写入之间没有互斥。
  A 通过校验 → B 落盘 → A 覆盖，A 的改动静默丢掉 B 的内容（TOCTOU）。
- 实现：新增 `internal/agent/tools/filelock.go`，进程级、按键的引用计数写锁
  （`lockFileWrite(path) func()`，释放后 `refs` 归零即摘除条目，长期会话不会堆积 map 条目）。
  键取自 `filetracker.ReadKey`（绝对路径 + 清理 + 大小写不敏感卷上折小写，与该守卫、写记录同一
  文件身份），避免 `C:\ws\A.go` 与 `c:\ws\a.go` 在 Windows 上拿到两把锁而重新打开竞态窗口。
  `edit` / `multiedit` / `write` 三个工具在解析出路径后立刻取锁、`defer` 释放，
  使「stat+守卫+读+写」处于同一临界区（也覆盖权限弹窗期间，避免弹窗期间被插写）。
  无竞争者时只是一次无争用 mutex，单会话行为与耗时不变。
  - 说明：锁按文件身份，跨工作区不互斥；只有工作目录互相嵌套时才共享锁（此时串行化是正确的）。
- 回归测试：`internal/agent/tools/filelock_test.go` —— 同路径 8 并发最大持有者必须为 1；
  不同路径必须能同时持有；最后一个持有者释放后注册表条目被摘除（`-race` 通过）。

## P2 — 跨会话写冲突提示（已实现）

- 实现：
  - `filetracker.Service` 新增 `RecordWrite(sessionID, path)` 与
    `LastWriteBy(path) (sessionID, at, ok)`（`internal/filetracker/service.go`）。
    写入记录只放内存（`csync.Map`，键与读记录同一身份，并导出为 `filetracker.ReadKey` 供
    P1 写锁复用）：它只回答
    「刚才是不是另一个会话动过这个文件」，只在本进程内服务这些会话时有意义。
    TTL 10 分钟（惰性清理，`LastWriteBy` 命中过期即删），`maxWriteMarks = 4096` 上限时按 TTL 修剪。
  - 工具侧 `internal/agent/tools/parallel_note.go` 的 `parallelWriteNote`：写入前查询
    「2 分钟内是否由**另一个**会话写过该文件」，命中则在工具结果里附一行提示
    （`Note: another session wrote Xs ago …`，**不报错、不阻断**）。
    `edit`/`multiedit`/`write` 在写入后调用 `RecordWrite`，写前捕获提示文本
    （否则自己的写入会覆盖标记）。
- 回归测试：`internal/filetracker/service_test.go`（写入记录/覆盖顺序/相对路径同一身份/TTL 过期/空入参）
  与 `internal/agent/tools/parallel_note_test.go`（提示命中与抑制、`write`/`edit` 工具端到端记录）。

## 明确不覆盖的部分（残余风险）

- `bash`（`sed -i` / `cat >` / `rm` / `git checkout` / 格式化工具）、`download`、MCP 工具都不登记写入，
  无法拦截同目录并发写入；只能依靠模型「先读后写」的纪律、上面的软提示，以及
  桌面端「并发上限 3 + 默认提示『多个会话改同一文件可能相互覆盖』」降低概率。
- `lsp_replace_symbol` / `lsp_rename` 通过 LSP workspace edit 写文件，同样不取 P1 的锁
  （LSP 侧自行应用编辑；同一文件的并发 LSP 编辑不在本次范围内）。

## 验证

- `go build ./...`、`go vet ./internal/agent/... ./internal/filetracker/...` 通过。
- `go test -race ./internal/agent/... ./internal/filetracker/ ./internal/undo/ -count=1` 通过。
- 全量 `go test ./internal/... -count=1` 中仅剩两个已知 Windows 环境问题
  （`internal/shell` 的 shebang 测试需要 /bin/bash；`internal/server` 的
  `TestE2E_TwoClientsReceiveSameMessage` 在 TempDir 清理时 rail3.db 被占用——已用 `git stash`
  在本机干净树复现，非本次改动引入）。
