# 前端架构与 IPC（桌面端）

> 范围：`src/` 的 SPA 结构（视图模块 / 样式隔离 / 类型检查）、Tauri IPC 约定，以及多 workspace 并发与 Agent server 模式的跨端分工。

---

## 架构

- **Tauri 2.11.5** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口 SPA（单页应用）** + hash 路由：
  - `index.html`（外壳）含 `#view-root` 容器、底部硬件栏与导航。
  - 4 个视图（`model_list` / `settings` / `agent` / `skills`）各自为独立 **ES 模块**（`src/views/*.js`），默认导出 `{ template, mount(root, params), unmount() }`。模型运行后「查看模型」直接用系统浏览器打开 WebUI（`window.openUrl`），不再有 chat 视图。
  - `agent` 视图已拆分：`src/views/agent.js` 为入口（init/bindEvents/生命周期），具体逻辑在 `src/views/agent/` 子模块（store/template/api/utils/ui/render/session/attach/send/sse/permission/tools/model/workspace/settings_dialog）；跨模块共享状态由 `store.js` 统一管理（`store` 为写入入口，`S` 为只读视图，workspace 字段禁止直接写 `S`）。
  - `index.html` 通过动态 `import()` 异步加载视图模块，把 `template`（含 `<style>` 的 HTML 字符串）注入 `#view-root`，调用 `mount`/`unmount` 管理生命周期。
- CSS/JS **内联**在每个视图模块的 `template` 字符串或模块函数内，保持零运行时依赖。
- **样式隔离约定**：全局 reset（`* {}`）与 `body` 样式只由 `index.html` 壳层提供，视图内不得重复定义；视图选择器带视图前缀（`agent-*` / `settings-*` 等）；视图内元素 id 不得与壳层 id（`app` / `view-root` 等）重复。
- **类型检查**：`jsconfig.json` 开启 `checkJs`，全局类型声明在 `src/types.d.ts`；历史视图暂以 `// @ts-nocheck` 豁免，新代码不得新增此标记（用 JSDoc 注解）。未配置 linter、formatter 或测试框架。

## IPC 注意事项（重要）

- SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke` / `.event.listen`，无需 `postMessage` 代理。
- `index.html` 初始化时把 `window.__adm_invoke` / `window.__adm_listen` 暴露给所有视图模块；视图模块通过这两个全局引用调用 IPC。
- **共享状态** `window.__adm_state`（systemInfo / runningModelId / modelList 等）跨视图共享，切换不丢。
- 视图 `mount` 时 `listen()` 保存 unlisten 句柄，`unmount` 时统一调用以防事件重复绑定（泄漏）。
- **Agent 页面**（`src/views/agent.js`）为独立 ESM 视图，由路由 `#/agent` 加载，不再使用 iframe / PTY 终端。
- 子页面 → 父窗口导航：使用 `location.hash = "#/list"` 等 hash 路由。

## Agent server 与多 workspace 并发

- **Agent server 模式**：admAgent 以子进程 `server` 命令启动（不传 `--host`，服务端绑定平台默认本地传输：macOS/Linux 为 Unix socket、Windows 为 named pipe，不占 TCP 端口）。多客户端共享：先探测默认传输地址是否已有 server 在跑，有则直接复用不 spawn。就绪检测通过轮询 `GET /v1/health`（15 秒超时），stdout/stderr 仅做日志转发。HTTP API 通过 `agent_http_request` 代理（hyper 直连 socket/pipe），SSE 事件通过 Tauri event `agent-sse-event` 转发给前端。
- **多 workspace 并发架构**：单 admAgent server 进程支持多个 workspace 同时干活。每个 workspace 有独立的 `AgentCoordinator`/SQLite DB/SSE 转发任务。Rust 后端 `AppState.agent_sessions: HashMap<String, AgentServerSession>` 按 workspace_id 索引各会话，`agent_child` 全局共享子进程，`active_workspace_id` 跟踪当前 tab。前端 `S.workspaces[wsId]` 状态池存各 workspace 的会话/消息/运行状态，切换 tab 时保存当前+恢复目标，不中断旧 workspace 的 agent run。SSE 事件携带 `workspace_id`，前端只处理当前激活 tab 的事件。微信 Bot 跟随当前激活 tab 路由消息。
