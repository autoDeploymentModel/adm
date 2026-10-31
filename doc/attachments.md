# 附件：剪贴板粘贴与 PDF 分批（桌面端）

> 范围：`src/views/agent/attach.js` / `pdf.js` / `pdf_batch.js` + `src-tauri/src/pages/agent.rs`，含三平台剪贴板差异与 pdf.js 用法。

---

## 附件粘贴（跨平台差异，`agent.js` paste 事件 + `agent.rs` read_clipboard_files）

- **根源是 WebView 内核与剪贴板格式不同**，必须两端各留一条"读系统剪贴板"的兜底，否则该平台粘贴文件失效：
  - **Windows（WebView2/Chromium）**：复制文件时剪贴板为 `CF_HDROP`（无文本），但 Chromium 会把文件暴露成 DataTransfer 的非图片 file 项 → 前端 `hasFileItem` 命中即同步 `preventDefault`，再由 Rust 读 `CF_HDROP`（`windows` crate）。
  - **macOS（WKWebView）**：Finder 复制文件时剪贴板只有 `public.file-url` / `NSFilenamesPboardType`（**无 text/plain 路径**，实测 `pbpaste` 为空），且 WKWebView **不**把文件暴露给 DataTransfer（items/files 全空、无 uri-list）→ 前端靠 `clipItems.length === 0` 兜底触发 `read_clipboard_files`；Rust 侧用 `objc2-app-kit` 的 `NSPasteboard`：先读 `NSFilenamesPboardType`（路径数组），兜底逐条读 `public.file-url` 剥掉 `file://` 前缀（多选文件时每个文件一个 item）。依赖挂在 `[target.'cfg(target_os = "macos")'.dependencies]`。
  - **Linux**：`read_clipboard_files` 返回空数组（未实现）。
- **文本复制/粘贴（右键菜单，`ui.js` 的 `clipboardWriteText`/`clipboardReadText`）**：系统右键菜单被自定义菜单屏蔽（`agent.js` 的 contextmenu），复制/粘贴必须走 `clipboardWithFallback`：先试 `navigator.clipboard`，失败/超时/不可用即回退 Rust 原生命令 `clipboard_read_text`/`clipboard_write_text`（arboard，进程级静态实例承载——Linux 剪贴板内容由持有者进程按需提供，实例析构即失效）。**Linux（WebKitGTK）下回退是必需项而非优化**：`Clipboard::readText` 需宿主发放 `WebKitClipboardPermissionRequest`（WebKitGTK 2.42 起，Tauri/wry 未处理 → 默认拒绝，Promise 以 `NotAllowedError` 收尾），同源回读还可能既不 resolve 也不 reject，故回退带 800ms 超时；arboard 开 `wayland-data-control`（Wayland 走 ext-data-control，与 GTK 同一个剪贴板；关掉只剩 X11/XWayland）。失败一律 `reportError` 提示，禁止再用空 `catch` 吞掉（旧实现即为静默失效）。复制取右键瞬间的选区快照（点击菜单项会折叠选区）。
- **前端兜底链顺序**（`src/views/agent.js` 粘贴处理）：①剪贴板图片直读 blob → ②`text/uri-list` 路径（`parseUriListPaths`）→ ③`text/plain` 且 `looksLikeFilePath` 才当路径（**普通文本粘贴禁止误判**，多行需每行都像路径）→ ④`cd.files` 带 `.path`（WebView2 注入）→ ⑤`read_clipboard_files`（触发条件 `hasFileItem` **或** `clipItems.length === 0`；macOS 无内容可插入故无需 preventDefault，Windows 需同步拦截防路径文本残留）。
- **macOS 新增后端逻辑时注意**：NSPasteboard 的 extern 静态（`NSFilenamesPboardType`/`NSPasteboardTypeFileURL`）访问需 `unsafe` 块；`NSFilenamesPboardType` 已废弃（`#[allow(deprecated)]`）但仍是多文件权威来源；`DowncastTarget` 不支持泛型 `NSArray<NSString>`，需 downcast 成 `NSArray` 再逐元素 `downcast_ref::<NSString>`。
- **验证方法**：`osascript -e 'tell application "Finder" to set the clipboard to (POSIX file "/tmp/x")'` 模拟复制文件，`pbpaste` 应输出空（证明无文本类型），Swift 小程序列 `NSPasteboard` 类型确认；Rust 侧可直接给 `read_clipboard_files` 写临时 `#[cfg(test)]` 单测验证（验证后删除，勿污染 CI）。

## PDF 附件（桌面端：分批转图片，`src/views/agent/pdf.js` + `pdf_batch.js` + `src/vendor/pdfjs`）

- **方案**：不用系统内置 PDF 查看器（WebView2/WKWebView 的 PDF 组件不可脚本化、拿不到像素），改为内置 pdf.js 按批渲染 JPEG，复用现有图片附件管线（`send.js` base64 内联 → 主模型支持图片则当轮内联，否则服务端调 vision 识别）。服务端零改动；**无页数硬上限**。
- **必须前端转换**：直接把 `application/pdf` 传给服务端会命中错误矩阵 #1"不支持"（`attachment_ingest.go` 只认 text mime 与 `image/*`）；且服务端的 `view` 工具只能读图片文件本身、不能把 PDF 当图片读（`view.go`，PDF 会落到非 UTF-8 分支），模型无法自行取页 → 后续批次必须由客户端主动推送。
- **三段式流程**：① 附加时只登记（`attach.js` `addPdfPending`：解析页数，预览显示 "文件 · N 页"，不渲染）；② 发送时只转换首批并随消息发出（`send.js`，消息正文自动附分批说明，>50 页弹确认卡）；③ 每批 run_complete 后由 `pdf_batch.js` 批次泵自动转换发送下一批，直到发完。
- **批大小**：视觉主模型 `PDF_BATCH_VISION=10` 页/批；非视觉主模型 `PDF_BATCH_TEXT=5` 页/批（服务端单轮图片识别上限 `maxImagesPerTurn=5`，超出会被标注"未识别"），并扣除本轮其它图片附件数量；主模型能力取 `S.agentInfo.model.supports_images`，快照未就绪按 5 保守处理。
- **安全阀**：总页数 > `PDF_CONFIRM_PAGES=50` 时发送前弹确认卡（显示份数/批次数）；批次数 > `PDF_MAX_BATCHES=100` 直接拒绝；单页最长边 2048px / JPEG q0.85。
- **终止条件**（`sse.js` run_complete 钩子 → `pdf_batch.onRunComplete`）：本轮出错/取消/步数触顶、切换会话、点进度提示上的"停止后续批次"均终止剩余批次；`expectedRunId` 保证只在本批次 run 完成时推进（手动消息的完成事件不会误触发）。
- **目标固定与恢复**：批次发送前校验目标会话/工作区未变化（`sendMessageWithFiles(text, files, target)` → `sendText(expectedTarget)`，变则返回 `target_changed` 并终止剩余批次，防止转换期间切换会话把批次发进错误会话）；`reconcilePdfBatching()` 在视图挂载（`agent.js` init）、切回工作区（`workspace.js switchToWorkspace`）与 run_complete 兜底（`sse.js`）三处按服务端 `is_busy` 对账——仍忙等事件、已空闲续跑（页面切走/切工作区 tab 期间事件会丢）、目标会话已切换则终止。
- **pdf.js 使用要点**：worker / cmaps / standard_fonts URL 必须用 `import.meta.url` 绝对化（worker 内 fetch 以 worker 位置为基准）；`getDocument` 返回 loadingTask，销毁调用 `loadingTask.destroy()`（v6 已移除 `doc.destroy`）；加密/损坏分别抛 `PasswordException`/`InvalidPDFException`（`friendlyPdfError` 统一转提示）。批次泵的发送函数由 `agent.js` 注入（`initPdfBatching(sendMessageWithFiles)`），避免与 send.js 循环依赖。
- **升级路径**：从 https://github.com/mozilla/pdf.js/releases 取 legacy dist，用 build 下的 min 版 `pdf.min.mjs`/`pdf.worker.min.mjs`（或 npm `pdfjs-dist/legacy/build/`）+ `web/cmaps/` + `web/standard_fonts/` + LICENSE 覆盖 `src/vendor/pdfjs/`（该目录已被 `jsconfig.json` exclude，不参与类型检查）。
