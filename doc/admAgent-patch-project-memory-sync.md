# admAgent 改动：options.project_memory_sync —— 压缩时是否自动提取记忆规则

> 已按审核意见落盘（`admAgent/` 已有改动，4 个文件）。`go build ./...`、
> `go test ./internal/context/... ./internal/config/... ./internal/agent/... -count=1` 均通过；
> `admAgent/build.ps1` 已重新打包并写入 `adm-binaries/`。本文件保留为设计记录。

桌面端「项目记忆」弹窗里的「压缩时自动提取记忆规则」开关会往 `admAgent.json` 写：

```json
{ "options": { "project_memory_sync": false } }
```

并依次 POST `/v1/workspaces/{id}/config/set`（磁盘全量重载）与 `/v1/workspaces/{id}/agent/update`
（`UpdateModels` → 重建 agent/context manager），与 `options.bash_allow_all` 完全同一套流程
（见 `src-tauri/src/pages/agent.rs` 的 `sync_agent_project_memory` / `write_agent_option_bool`）。
开关默认开启：桌面端字段 `agent_project_memory_sync` 是 `Option<bool>`，**None = 未设置 = 开**
（`skip_serializing_if` 使其不落盘），只有用户显式关过才写 `false`；admAgent 侧同理，
`options.project_memory_sync` 缺失即开启（`*bool`）。

## 背景 / 问题

每次上下文压缩（手动 `/summarize` 或自动触发）都会：

1. `RuleExtractor` 从被压缩的消息里启发式抽取 anchors（`internal/context/manager.go:197-199`）；
2. 把 durable anchors（constraint / decision）**无条件**同步进跨会话项目记忆
   `internal/context/manager.go:203-207`：

```go
	// Cross-session tier: sync durable anchors (constraints/decisions) into
	// the project memory BEFORE budget trimming, ...
	_ = m.Project.Sync(anchors.All())
```

3. `ProjectStore.Sync` 合并进内存副本并原子写 `<workspace data_dir>/project_memory.json`。

用户希望「这次压缩不要自动沉淀记忆规则」时（例如在探索性会话里，不想让临时结论污染跨会话记忆），
当前**没有任何开关**：只能压缩完再手工删除条目 —— 而 admAgent 进程内仍持有同一份内存副本，
下一次压缩会把删掉的条目合并回写文件（见 `src/views/agent/memory.js` 文件头注释），所以手工清理基本无效。

## 改动清单（3 个源文件 + 1 个测试文件）

### 1. `admAgent/internal/config/config.go` — Options 新增字段

`Options` 结构体末尾（`FactBlock` / `FactBlockRead` 之后，`MaxSummarizeTokens` 之前）：

```go
	// ProjectMemorySync controls whether each compaction syncs its durable
	// anchors (constraints/decisions) into the cross-session project memory.
	// On by default: the tier is the whole point of surviving session
	// boundaries. Turning it off keeps existing entries injected but stops
	// a compaction from adding new ones.
	ProjectMemorySync *bool `json:"project_memory_sync,omitempty" jsonschema:"description=Sync durable constraints and decisions into the cross-session project memory during compaction. Existing entries stay injected when disabled. Default true,default=true"`
```

用 `*bool` 与 `FactBlock` 一致：nil = 开启（老配置不变行为）。

### 2. `admAgent/internal/context/manager.go` — Manager 增加开关并据此跳过 Sync

Manager 结构体（`FactBlock bool` 之后，第 61 行附近）：

```go
	// ProjectMemorySync reports whether a compaction may merge durable
	// constraints/decisions into the cross-session project store. Nil means
	// enabled; a callback (not a bool) because the manager outlives config
	// changes — see「热生效」note below.
	ProjectMemorySync func() bool
```

`NewManagerWithStore` 无需赋值（nil = 开启），只保留 `FactBlock: true`。

`CompactWithBudget` 里的无条件同步（第 203-207 行）改为：

```diff
-	_ = m.Project.Sync(anchors.All())
+	// Evaluated here, not at construction, so flipping the switch applies to
+	// the next compaction even though the agent (and this manager) is cached.
+	if m.ProjectMemorySync == nil || m.ProjectMemorySync() {
+		_ = m.Project.Sync(anchors.All())
+	}
```

注意：**只跳过 Sync，不动 `ProjectRender()`**（`manager.go:637-640`）——已沉淀的条目继续注入，
与该开关的文案「已有条目保留并继续生效」一致。

### 3. `admAgent/internal/agent/agent.go` — 从配置透传到 Manager

`SessionAgentOptions`（`FactBlock bool` 之后，第 810 行附近）：

```go
	// ProjectMemorySync mirrors options.project_memory_sync: false stops each
	// compaction from adding new entries to the cross-session project
	// memory. Existing entries keep being injected. Nil means enabled.
	ProjectMemorySync func() bool
```

`buildContextManager`（第 863-864 行）：

```diff
 	mgr := newContextManager(opts.ContextDataDir, opts.ProjectStore)
 	mgr.FactBlock = opts.FactBlock
+	mgr.ProjectMemorySync = opts.ProjectMemorySync
```

### 4. `admAgent/internal/agent/coordinator.go` — 读取选项（第 572 行附近）

```diff
 		ProjectStore:              c.projectStore,
 		FactBlock:                 opts.FactBlock == nil || *opts.FactBlock,
-+		ProjectMemorySync:         opts.ProjectMemorySync == nil || *opts.ProjectMemorySync,
```

实际落地的写法是**闭包**（不是快照值）：

```go
	// Read through a callback, not a captured value: this agent is built once
	// per coordinator and reused by every run and by the manual /summarize
	// path, so a bool snapshot here would ignore the option until restart.
	projectMemorySync := func() bool {
		o := c.cfg.Config().Options
		return o.ProjectMemorySync == nil || *o.ProjectMemorySync
	}
```

### 4.1 为什么必须是回调（热生效）

`coordinator.go:209` 只在 coordinator 构造时 `buildAgent` 一次，之后 `run()` 用
`c.currentAgent.Run`、手动压缩用 `c.currentAgent.Summarize`，而 `/agent/update`
（`UpdateModels`）只做 `SetModel`/`SetTools`，**从不重建 `ctxMrg`**。所以把 bool 写进
`SessionAgentOptions` 等于在启动时把开关冻结：桌面端翻转开关后立刻点「压缩上下文」
仍会 Sync（实测：15:52:02 写入 `false` 且 `/config/set`+`/agent/update` 均 200，
15:52:07 的手动压缩仍在 11ms 后改写了 `project_memory.json`）。
改成读活配置的闭包后，`/config/set` 的 autoReload 一刷新 `c.cfg`，
**下一次压缩**（无论自动、手动 `/summarize`，还是 TUI）就按新值执行，
既不需要 `/agent/update`，也不需要重启 server。

### 5. 新增回归测试（`admAgent/internal/context/project_test.go`）

```go
// TestManagerCompactSkipsProjectMemorySync: options.project_memory_sync=false
// must leave the on-disk project memory untouched while the tier keeps
// serving existing entries.
func TestManagerCompactSkipsProjectMemorySync(t *testing.T) {
	dir := t.TempDir()
	m := &Manager{Index: NewNgramIndex(), States: NewStateStore(), Extractor: RuleExtractor{}}
	m.Project = NewProjectStore(dir)
	m.ProjectMemorySync = func() bool { return false }
	// ... compact a slice containing a constraint ...
	// require: project_memory.json 不包含该 constraint（文件不存在或条目为空）
	// 再 m.ProjectMemorySync = func() bool { return true } 压缩一次 → 条目出现
}
```

（现有 `TestManagerCompactSyncsProjectMemory` 覆盖开启路径，默认值保持 true 即不受影响。）

## 验证步骤

```bash
cd admAgent
go build ./...
go test ./internal/context/... ./internal/agent/... -count=1
```

1. `admAgent.json` 写 `"options": { "project_memory_sync": false }`（无需重启 server，
   只要 `/config/set` 触发过一次磁盘重载——桌面端点开关会发）；
2. 桌面端压缩一次会话 → `project_memory.json` 不应新增条目；
3. 改回 `true`（或删除该字段）再压缩 → 新条目重新出现；
4. 关闭状态下，已有条目仍应被注入到系统提示（`ProjectRender` 区块仍在）。
