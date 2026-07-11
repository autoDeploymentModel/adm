# 代码审查：新增 Agent 终端功能（未提交改动）

> 审查时间：2026-07-11
> 范围：`src-tauri/**`（Rust 后端）、`src/index.html`、`src/settings.html`、`src/agent.html`（新增）、`src/vendor/**`（新增 xterm）、`doc/dev_doc.md`、`Cargo.toml/Cargo.lock`、`tauri.conf.json`、capabilities

## 一、总体结论

本次改动**新增了一个完整的 Agent 终端模块**：前端 `agent.html` 内嵌 xterm 终端，后端 `agent.rs` 通过 `portable-pty` 拉起本地 `powershell`/shell 并自动启动 `admAgent` 工具，同时接入了 admAgent 的下载 / 版本检查 / 更新流程，并新增「模型是否已启动」全局状态用于进入 Agent 前的门禁。

**编译状态：通过。** `cargo check` 干净编译，无错误、无警告。
（审查过程中我曾误判 `agent.rs` 缺 trait 导入，实际 Rust 在 `Box<dyn Trait>` 上调用 trait 方法无需把 trait 导入作用域；已还原，工作区代码与你原始提交一致，无任何被我改动的痕迹。）

## 二、需要关注的问题（按严重度）

### 🟠 中高：Windows 下 admAgent 安装目录可能不可写
- `agent.rs::adm_agent_target_dir()` 在 Windows 返回 `config::get_exe_dir()`（可执行文件所在目录）。
- 标准打包（NSIS/MSI）安装到 `C:\Program Files\...` 后，普通用户对该目录**没有写权限**，`download_adm_agent` / `download_adm_agent_update` 写入会直接抛「拒绝访问」。
- macOS 走 `get_data_dir`（可写），二者不一致。
- **建议**：Windows 也改为可写目录（如 `get_data_dir` 或 `AppData`），与模型下载目录策略保持一致。

### 🟠 中：macOS 自动更新下载地址写死成 Windows exe
- `check_adm_agent_update()` 中 `download_url` 仅在 `#[cfg(target_os = "windows")]` 下赋值为 `.../agent/win/admAgent.exe`，macOS 为 `None`。
- 即 macOS 永远走「不支持自动更新」分支；但首次安装的 `download_adm_agent()` 的 macOS URL 又是 `http://adm.tuduoduo.top/admAgent`（见下条）。两段逻辑对 macOS 不一致。
- **建议**：统一按平台返回正确的 macOS 二进制地址，避免逻辑割裂。

### 🟠 中：macOS 下载地址使用明文 http
- `adm_agent_download_url()` 的 macOS 分支返回 `http://adm.tuduoduo.top/admAgent`（明文），Windows 分支为 `https`。
- **建议**：统一改为 `https`，避免中间人风险。

### 🟠 中：窗口最小尺寸被强制放大到 1440×800
- `tauri.conf.json`：`width/height` 1280×768 → 1440×800；`minWidth/minHeight` 800×600 → 1440×800。
- 这意味着**整个应用**最小窗口就是 1440×800，小屏 / 笔记本无法缩小，且启动窗口整体变大，影响所有页面而非仅 Agent 页。
- **建议**：确认是否为刻意（为适配终端宽度）。若是，建议仅对 Agent 页做布局适配，或保留较小的全局 `minWidth`（如 1024），避免影响其它页面体验。

### ✅ 已修复：PowerShell 启动命令仅发送 `\r`
- `start_agent_terminal()` 原向 PTY 写入 `& "path"\r`（仅 CR，无 LF），在部分 conhost / Windows Terminal 配置下可能不执行命令，导致 admAgent 未被拉起。
- **已按建议修改**：四处启动命令（Windows/macOS × 有无 workdir）的行尾统一由 `\r` 改为 `\r\n`，`cargo check` 通过。
- 上线前仍建议在 Windows 实机验证 admAgent 确实随终端启动。

### 🟡 低：无 Content-Length 时进度卡在 0%
- `download_adm_agent` / `download_adm_agent_update` 在服务器不返回 `Content-Length` 时 `progress` 恒为 0，直到 `done` 跳 100%。
- 仅体验问题，非功能缺陷。

### 🟢 信息项：ctx_size 默认值抬高到 65536
- `settings.html` 将 `default` / `creative` 预设的 `ctx_size` 由 4096 / 32768 改为 `65536`，并新增 `MODE_MIN_CTX` 下限（日常/创意最低 65536，code 模式不限制）。
- admAgent.json 的 `context_window` 直接取自该值，会联动影响 Agent。
- **建议**：确认所有受支持模型都能稳定支撑 65k 上下文，否则低配模型会启动失败或效果变差。属产品决策，标注确认即可。

## 三、做得好的地方

- 配置写入统一走「临时文件 + rename」原子写（`save_agent_workdir`、`write_json_atomic`、`settings.rs`），避免崩溃产生半截文件。
- 终端数据走 base64 + 事件流式转发，前端 iframe 通过 `postMessage` 转发 Tauri 事件，并保留了 macOS WKWebView 的 `parent.__TAURI__` 回退，符合既有 IPC 约定。
- Windows 关闭 Agent 时用 `taskkill /PID /T /F` 杀整棵进程树，避免 admAgent 变孤儿进程残留，考虑周到。
- admAgent 版本比较采用「归一化字符串相等」而非 semver，正确处理了带 commit 短哈希的版本号。
- `Cargo.lock` 同步更新，`portable-pty = "0.8"` 版本约束合理。

## 四、建议核对清单（提交前）

- [x] Windows 安装目录可写性 —— 作者确认已编译正常安装，无问题
- [x] macOS 下载/更新地址一致性 + 统一 https —— 暂不兼容 macOS/Linux，搁置
- [x] 窗口 minWidth 刻意放大 —— 作者确认是有意设置
- [x] Windows 实机验证 admAgent 随终端自动启动 —— 已将 `\r` 改为 `\r\n`，`cargo check` 通过（实机验证待作者进行）
- [ ] `doc/dev_doc.md` 的新增章节（agent 命令、端口 1010、admAgent.json 路径）与实现一致
- [x] ctx_size 65536 下限对既有模型是否兼容 —— 作者确认撑得住
- [x] Agent 页首次进入终端宽度不适配 —— 已修复（`agent.html`）：根因为首次进入时后端 `agent-terminal-ready` 事件早于本页注册 `message` 监听而丢失，原 rAF fit 在布局未稳时算错列数。改用 `ResizeObserver` 兜底（observe 即回调真实尺寸，窗口缩放也自动适配）+ 在 `startAgentTerminal` 的 `invoke` 成功（PTY 已建）后主动 `fit` 并 `resize` 同步后端，不再依赖一次性事件。

---

## 五、二次复查：剩余 bug 与已知限制（2026-07-11）

全量复盘后，`cargo check` 通过，未再发现会导致编译失败或终端无法使用的严重 bug。新发现并修复 1 个真实 UI bug，另有若干中低优先级已知限制：

### ✅ 新发现并已修复：首次安装下载失败时弹窗卡死
- `index.html` 的 `goAgent`：首次进入时若 `download_adm_agent` 抛异常，外层 `catch` 只弹"操作失败"提示，但 `showAgentDownloadDialog()` 已显示的下载进度弹窗没有被隐藏，用户会卡在下载弹窗。
- 已在 `goAgent` 的 `catch` 中补 `hideAgentDownloadDialog()`。

### ✅ 已修复：进入 Agent 页按需 (重)启动 admAgent（**以"模型是否重启"为准**，不再比较上下文）
- **需求变更**：作者明确——重启判据**统一改为"模型是否重启"**：
  - 模型被重启过（代次变化）→ 再次进入 Agent 页必须重启 admAgent；
  - **即使上下文配置变了，只要模型没重启，Agent 页也不重启**（保留原终端）；
  - 旧的"上下文变化即重启"逻辑**移除**，不再使用。
  - （进程崩溃/退出的恢复仍保留：进程已退出则重新进入即拉起。）
- **根因（上一版）**：旧逻辑把"上下文变化"也当作重启触发，与作者新口径冲突；且用会过期的 `terminalStarted` 前端标记代替"进程是否真活着"，无法感知进程崩溃或模型重启。
- **修复（以"后端权威状态"为准）**：
  1. 后端 `agent.rs` 新增命令 `get_agent_status`：用 `try_wait()` 查 PTY 子进程是否存活（`running`），并返回 `model_generation`（模型启动代次）。`lib.rs` 注册。
  2. `app_state.rs` 新增 `model_generation: Mutex<u64>`；`model_list.rs` 的 `start_model` 成功时 `bump_model_generation()`（+1）。
  3. 前端 `agent.html` 移除 `currentCtxSize` 状态与 `get_agent_ctx_size` 调用；重写 `handleEnterAgent()`：每次进入页面（`agent-resize`）仅拉取 `get_agent_status`，**仅当「进程已退出」或「模型代次变化」时**才重新启动（`start_agent_terminal` 内部先清理旧会话再拉起新 admAgent）；进程存活且代次未变（哪怕仅切页面、哪怕只改了上下文配置但没重启模型）→ 保持原状，不重启。
  4. 后端移除已无用的 `get_agent_ctx_size` 命令（及 `lib.rs` 注册）。
  5. 每次 (重)启动前 `term.reset()` 清空终端旧内容（含"进程已退出"提示）。
- 覆盖场景：① 模型没重启 + 仅切页面（或改了上下文配置未重启模型）→ **不退出**；② 进程崩溃 → 重新进入即重启；③ 模型重启过（无论 ctx 是否变化）→ 重启；④ 从未启动 → 启动。
- `cargo check` 通过。

### ✅ 已修复：admAgent TUI（右边栏上下文实时统计）显示错位
- **现象**：嵌入终端里 admAgent 的右边栏「上下文实时统计」等 TUI 显示不正常，但在独立 powershell 里正常。
- **根因**：后端 `start_agent_terminal` 创建 PTY 时**写死 120×30 列**；admAgent 在 `& admAgent.exe` 启动时会读取 PTY 当前宽度（120）来布局 TUI，而前端 xterm 实际显示宽度是窗口真实宽度（约 180 列）。两者不匹配 → 右边栏按 120 列定位而实际显示更宽 → 错位/实时统计刷新异常。原先的 `agent_terminal_resize` 于**启动之后**才调用，admAent 已按 120 列布局完毕，于事无补。
- **修复**：
  1. `start_agent_terminal` 新增 `rows`/`cols` 参数（前端 xterm 真实尺寸），用其创建 PTY（缺失时回退 30×120）；`lib.rs` 无需改动（签名自动注册）。
  2. 前端 `agent.html` 的 `startAgentNow`：**先 `fitAddon.fit()` 拿到真实 rows/cols，再 `invoke("start_agent_terminal", {rows, cols})`** 创建 PTY，确保 admAgent 启动即按真实宽度布局；启动后仍做一次 `fit`+`agent_terminal_resize` 兜底。
  3. shell 启动命令增加 `cmd.env("TERM", "xterm-256color")`（Windows/macOS 通用），提升 admAgent 等 TUI 的终端能力识别。
- `cargo check` 通过。建议 Windows 实机验证右边栏实时统计是否正常铺满/刷新。

### 🟡 已知限制（非阻断，建议知晓）
1. **首批终端输出可能丢失**：后端 `start_agent_terminal` 启动 shell 后立即 emit `agent-terminal-data`，而首次进入时 agent.html 需解析 289KB xterm.js，加载完成晚于后端输出；Tauri 事件经父窗口 `postMessage` 转发不重放，故 agent.html 注册 `message` 监听前发出的首批数据（如 admAgent 启动横幅）会丢失。仅影响最前面少量输出，不影响宽度适配与后续输出。
2. **`startAdmAgentUpdate` 中 `local_version === "未安装"` 为死代码**：Rust 端未安装时 `local_version` 为 `None`（JSON 序列化后为 `null`），从不返回字面量 `"未安装"`；实际未安装由 `!result.local_version` 判定，逻辑正确，该分支永不命中。
3. **下载的 admAgent 二进制无完整性校验**：仅按 HTTP 状态码判断，无 sha256/签名校验，下载中途损坏不报错（低风险，资源来自自有服务器）。
4. **macOS 下载地址为明文 http**：`adm_agent_download_url` macOS 分支 `http://...`，Windows 为 https。作者已确认暂不兼容 macOS/Linux，搁置。
5. **切换预设时旧 ctx_size 会被强制抬高**：`applyCtxFloor` 在加载/切换预设时，若 ctx_size 低于当前模式下限（日常/创意 65536）会强制修正并弹 toast，属预期行为。
6. **后端 PTY 初始固定 120×30**：最终列/行由前端 `agent_terminal_resize` 同步；当前 `ResizeObserver` + `invoke` 成功后 resize 双保险已覆盖，极端时序下两者都失效时 shell 会以 120 列运行（不影响启动）。

### 上线前建议
- 执行一次 `pnpm tauri build`（release）验证完整打包（前端拷贝、权限、签名）；`cargo check` 仅验证库编译。
- 核对 `doc/dev_doc.md` 新增章节（agent 命令、端口 1010、admAgent.json 路径）与实现一致。

---

**审查结论**：功能完整、结构清晰，后端可编译。已按反馈处理：① `agent.rs` 启动命令 `\r` → `\r\n`（`cargo check` 通过）；② `agent.html` 用 `ResizeObserver` + `invoke` 成功后主动 `fit`/`resize` 修复首次进入终端宽度不适配；③ `index.html` 修复首次安装下载失败时下载弹窗卡死；④ 进入 Agent 页按需 (重)启动 admAgent：**重启判据已改为"模型是否重启"为准**（进程退出或模型代次变化才重启；仅改上下文配置但模型未重启则不重启），移除了旧的"上下文变化即重启"逻辑，并删除了无用的 `get_agent_ctx_size` 命令（`agent.html` + `agent.rs` + `app_state.rs` + `model_list.rs`，`cargo check` 通过）。其余项作者确认无需改动。提交前剩 `doc/dev_doc.md` 一致性自查与 release 打包验证。
