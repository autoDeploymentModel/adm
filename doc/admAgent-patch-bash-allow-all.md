# admAgent 改动：options.bash_allow_all —— 关闭 bash 命令黑名单

> 已按审核意见落盘（`admAgent/` 已有改动，6 个文件）。`go build ./...`、
> `go test ./internal/agent/... ./internal/config/... -count=1` 均通过。
> 本文件保留为设计记录与 Linux 使用前置条件说明。

## 背景 / 问题

桌面端「Agent 设置 → 开启所有工具调用」会往 `admAgent.json` 写：

```json
{ "options": { "bash_allow_all": true } }
```

并依次 POST `/v1/workspaces/{id}/config/set`（磁盘全量重载）与 `/v1/workspaces/{id}/agent/update`
（`UpdateModels` → `buildTools` 重建工具集）。

当前 admAgent 侧：

- 黑名单是**硬编码**的 `bannedCommands`（`internal/agent/tools/bash.go:75-146`），在
  `blockFuncs()`（`bash.go:165`）里生效，作用于前台 bash（`bash.go:254`）、后台 bash（`bash.go:309`），
  并经 `shell/dispatch.go:70` 递归作用于无 shebang 的脚本；`Options` 原先没有任何开关能关掉它。
- 现已在 `Options` 增加 `bash_allow_all`（默认 false）；未支持该字段的旧版本会静默忽略
  （确认过 `internal/config` 没有 `DisallowUnknownFields`），开关表现为空转 —— 不报错但也不生效。

## 改动清单（4 个源文件 + 2 个测试文件）

### 1. `admAgent/internal/config/config.go` — Options 新增字段

`Options` 结构体末尾（`DisabledSkills` 之后，第 279 行附近）：

```go
	DisabledSkills          []string     `json:"disabled_skills,omitempty" jsonschema:"description=List of skill names to disable and hide from the agent,example=admAgent-config"`
	// BashAllowAll disables the bash command deny-list (sudo, apt, systemctl,
	// curl, ...), so the agent can run privileged / package-manager commands.
	// Off by default: the deny-list is the only guard rail against a model
	// running privileged or destructive commands unattended.
	BashAllowAll bool `json:"bash_allow_all,omitempty" jsonschema:"description=Disable the bash command deny-list so privileged and package-manager commands (sudo, apt, systemctl, curl, ...) can be executed. Only enable this on machines you trust.,default=false"`
```

### 2. `admAgent/internal/agent/tools/bash.go`

```diff
-func bashDescription(attribution *config.Attribution, modelID string) string {
-	bannedCommandsStr := strings.Join(bannedCommands, ", ")
+func bashDescription(attribution *config.Attribution, modelID string, allowAll bool) string {
+	bannedCommandsStr := strings.Join(bannedCommands, ", ")
+	if allowAll {
+		// options.bash_allow_all：黑名单整体失效，描述里也不再列禁用命令
+		bannedCommandsStr = ""
+	}
 	var out bytes.Buffer
```

```diff
-func blockFuncs() []shell.BlockFunc {
+func blockFuncs(allowAll bool) []shell.BlockFunc {
+	if allowAll {
+		// options.bash_allow_all：显式返回 nil。shell 侧 nil/空切片即不启用拦截
+		// （internal/shell/run.go:23、:330），脚本递归分支同样不再拦截。
+		return nil
+	}
 	return []shell.BlockFunc{
 		shell.CommandsBlocker(bannedCommands),
```

```diff
-func NewBashTool(permissions permission.Service, workingDir string, attribution *config.Attribution, modelID string) fantasy.AgentTool {
+func NewBashTool(permissions permission.Service, workingDir string, attribution *config.Attribution, modelID string, allowAll bool) fantasy.AgentTool {
 	return fantasy.NewAgentTool(
 		BashToolName,
-		string(bashDescription(attribution, modelID)),
+		string(bashDescription(attribution, modelID, allowAll)),
```

同文件两个调用点（第 254、309 行）：

```diff
-			bgShell, err := bgManager.Start(context.Background(), execWorkingDir, blockFuncs(), params.Command, params.Description)
+			bgShell, err := bgManager.Start(context.Background(), execWorkingDir, blockFuncs(allowAll), params.Command, params.Description)
```

注意：**外层 `bannedCommands` / `CommandsBlocker` / `ArgumentsBlocker` 全部保留**，只是新增开关；
`Shell.SetBlockFuncs`、`shell.CommandsBlocker` 等导出 API 不动，`internal/shell` 无需任何改动。

### 3. `admAgent/internal/agent/tools/bash.md.tpl` 第 11 行

```diff
-2. Security Check: Banned commands ({{ .BannedCommands }}) return error - explain to user. Safe read-only commands execute without prompts
+2. Security Check: {{ if .BannedCommands }}Banned commands ({{ .BannedCommands }}) return error - explain to user. {{ else }}The command deny-list is disabled (options.bash_allow_all): privileged and system commands run unchecked - be deliberate. {{ end }}Safe read-only commands execute without prompts
```

### 4. `admAgent/internal/agent/coordinator.go:678` — 传入配置

```diff
-		tools.NewBashTool(c.permissions, c.cfg.WorkingDir(), c.cfg.Config().Options.Attribution, modelID),
+		tools.NewBashTool(c.permissions, c.cfg.WorkingDir(), c.cfg.Config().Options.Attribution, modelID, c.cfg.Config().Options.BashAllowAll),
```

`c.cfg.Config()` 在 `buildTools` 时读取，而 `/agent/update` → `UpdateModels` → `buildTools`
（`coordinator.go:947`）会重建工具集，所以桌面端开关点一下即时生效，不需要重启 server。

### 5. 测试签名补齐（必改，否则编译不过）

- `admAgent/internal/agent/common_test.go:172`
- `admAgent/internal/agent/tools/bash_test.go:133`、`:142`

三处 `NewBashTool(...)` 末尾补 `, false`。

### 6. 新增回归测试（`bash_test.go`，跨平台、不依赖 sudo 是否存在）

```go
func TestBashDescription_AllowAllDropsDenyList(t *testing.T) {
	attribution := &config.Attribution{TrailerStyle: config.TrailerStyleNone}

	require.Contains(t, bashDescription(attribution, "test-model", false), "sudo")
	require.Contains(t, bashDescription(attribution, "test-model", false), "apt-get")

	allowAll := bashDescription(attribution, "test-model", true)
	require.NotContains(t, allowAll, "sudo")
	require.NotContains(t, allowAll, "apt-get")
	require.Contains(t, allowAll, "deny-list is disabled")
}
```

## 验证步骤（已执行）

```bash
cd admAgent
go build ./...                                        # BUILD_OK
go test ./internal/agent/... ./internal/config/... -count=1   # 全绿（含新增的两个回归测试）
```

1. `admAgent.json` 写 `"options": { "bash_allow_all": true }`，重启 server；
2. TUI/桌面端让模型执行 `sudo -n apt-get install -y <pkg>`，应能真正执行而不是返回
   "command is blocked"；
3. 改回 `false` 或删除该字段，同样命令应重新被拦。

## 附：Linux 上让 sudo 真正可用的前置条件（与本次改动无关，但不做则命令必然失败）

- agent 进程没有 TTY，`sudo` 无法交互输密码：需 `sudo visudo -f /etc/sudoers.d/admagent`
  写 `admin ALL=(ALL) NOPASSWD: ALL`（或按需收窄到 `/usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg`）。
- 建议在项目 `AGENTS.md` 里写明"安装依赖用 `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ...`"，
  避免 debconf 交互卡住与 apt 锁竞争。
- 黑名单取消后，`curl`/`ssh`/`systemctl`/`mount` 等同样不再拦截，桌面端权限模式为 yolo 时
  不会有确认弹窗 —— 开关只应在受信任的机器与项目上打开（设置项描述里已写明）。
