# ADM 项目长期记忆

## 前端 / xterm.js（Agent 终端）
- agent.html 用 vendored xterm.js 5.x（压缩版，含 CompositionHelper）。输入路径：
  `term.onData` → `invoke("agent_terminal_input", {data: base64})` → 后端 PTY writer.write_all。
- **xterm IME 偶发重复输入陷阱**：xterm 在 IME 合成结束时有两条可能同时触发的发送路径——
  (A) compositionend → `_finalizeComposition` 的 `setTimeout(0)` 异步 triggerDataEvent；
  (B) 紧跟 compositionend 的 `input(insertText)`，`_inputEvent` 在 `_keyDownSeen=false`（纯 IME 选词）
  时绕过保护同步 triggerDataEvent。两条发同一段文本 → onData 触发两次 → 中文偶发重复（"你好"→"你好你好"）。
  - ❌ 废弃方案：document 捕获阶段拦 input 事件——依赖捕获时序/target 判断，某些 IME/调度下拦不住，
    且若某次只有一条路径会丢字。
  - ✅ 当前方案（与内部路径无关，2026-07-18）：`term.onData` 出口做「合成去重」。
    `trackImeComposition` 用 document 捕获监听 compositionstart/update/end（仅 .xterm-helper-textarea）
    记录 `_imeLastActivity`；onData 中若 `data===_lastSentData` 且距上次发送 <60ms 且距 IME 活动 <350ms
    则判为重复丢弃。60ms/350ms 双门槛：不误伤真实重复短语、英文连打、长按；绝不丢唯一发送。
    见 src/agent.html `trackImeComposition` + onData 去重。
- 粘贴：agent.html 覆写了 `term.paste`，把换行替换为空格，避免多行粘贴被当 Enter 提前提交。
- Ctrl+C 有选区复制、无选区放行(发 SIGINT)；Ctrl+V 走父窗口代理读剪贴板（iframe 受限回退）。
- **TUI 右边栏错位/重复**：根因是 agent-frame 初始 `display:none`，agent.html 在 iframe 仍隐藏时启动 xterm/PTY，
  fitAddon 取不到真实尺寸，admAgent 按错误列数布局右侧上下文栏。修复要点：
  1. `index.html` 在显示 agent-frame 后再设置 `src`，首次加载用 `onload` 后发送 `agent-resize`。
  2. `agent.html` 增加 `isTerminalWrapVisible` / `maybeStartTerminal`，尺寸为 0 时不启动；由 `ResizeObserver`
     和 `agent-resize` 在 iframe 真正可见后触发启动；并加 `startRequested` 互斥防止重复启动。

## 架构要点
- Tauri 2.11.2，单窗口 iframe 路由：index.html 外壳内嵌 model_list/settings/model_chat/model_image/agent。
- agent-frame 懒加载且常驻（agentFrameLoaded 守卫，只设一次 src）。
- macOS WKWebView 不把 Tauri IPC 注入 iframe，子页面走 `window.parent.__TAURI__?.core?.invoke` 回退或
  postMessage `__invoke__` 代理。Windows WebView2 上 iframe 可直接拿到 __TAURI__。

## 后端 IPC
- `agent_terminal_input`(src-tauri/src/pages/agent.rs): 解码 base64 → PTY writer.write_all + flush，单次写入无重复。
- 详见 AGENTS.md 各模块命令表。
