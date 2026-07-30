// Agent 视图模板（含 <style>，选择器统一 .agent-/agent- 前缀 + .agent-root 容器）
export const template = `
<style>
  /* 全局 reset（*）由 index.html 壳层统一提供，视图内不重复定义；选择器统一 agent- 前缀 */

  .agent-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--c-bg-deep);
    color: var(--c-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
  }

  .agent-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ===== 左侧导航栏 (240px, 无整体滚动) ===== */
  .agent-sidebar {
    width: 240px;
    flex-shrink: 0;
    background: var(--c-panel);
    border-right: 1px solid var(--c-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ① session-block: 新建会话 + 会话列表 (内部滚动) */
  .session-block {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .sidebar-header {
    padding: 10px 12px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }

  .new-chat-btn {
    width: 100%;
    background: var(--c-accent);
    color: #fff;
    border: none;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
    text-align: center;
  }
  .new-chat-btn:hover { background: var(--c-accent-2); }

  /* 会话视图切换 */
  .session-toggle {
    display: flex;
    border-bottom: 1px solid var(--c-raise-2);
    flex-shrink: 0;
  }
  .toggle-item {
    flex: 1;
    text-align: center;
    padding: 6px 0;
    font-size: 11px;
    color: var(--c-text-4);
    cursor: pointer;
    transition: all 0.15s;
    border-bottom: 2px solid transparent;
  }
  .toggle-item:hover { color: var(--c-text-2); }
  .toggle-item.active {
    color: var(--c-text);
    border-bottom-color: var(--c-accent);
  }

  /* 会话列表 — 内部滚动 */
  .conv-list-section {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .conv-list-section::-webkit-scrollbar { width: 6px; }
  .conv-list-section::-webkit-scrollbar-track { background: var(--c-panel); }
  .conv-list-section::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  .conv-item {
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-raise-2);
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
  }
  .conv-item:hover { background: var(--c-raise); }
  .conv-item.active {
    background: var(--c-raise);
    border-left: 3px solid var(--c-accent);
    padding-left: 9px;
  }

  .conv-item-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .conv-item-star { color: var(--c-accent); font-size: 11px; }
  .conv-item-busy {
    display: inline-block;
    width: 10px; height: 10px;
    border: 2px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: agent-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .conv-item-meta {
    font-size: 11px;
    color: var(--c-text-3);
    display: flex;
    gap: 6px;
  }

  /* 会话项悬停操作按钮 */
  .conv-item-actions {
    display: none;
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    gap: 2px;
  }
  .conv-item:hover .conv-item-actions { display: flex; }
  .conv-action-btn {
    background: var(--c-overlay);
    border: none;
    color: var(--c-text-2);
    width: 22px; height: 22px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .conv-action-btn:hover { background: var(--c-overlay-strong); color: #fff; }
  .conv-action-btn.delete:hover { background: #3d1a1a; color: #ff6b6b; }

  /* ② tools-block: Skills/MCP/LSP (固定高度, 内部滚动) */
  .tools-section {
    border-top: 1px solid var(--c-border);
    flex-shrink: 0;
    height: 184px;
    display: flex;
    flex-direction: column;
  }

  .tools-header {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c-text-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--c-raise-2);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .tools-count {
    font-size: 10px;
    color: var(--c-text-4);
    font-weight: 400;
  }

  /* 工具 tab 切换: Skill / LSP / MCP */
  .tools-tabs {
    display: flex;
    border-bottom: 1px solid var(--c-raise-2);
    flex-shrink: 0;
  }
  .tools-tab {
    flex: 1;
    text-align: center;
    padding: 5px 0;
    font-size: 11px;
    color: var(--c-text-4);
    cursor: pointer;
    transition: all 0.15s;
    border-bottom: 2px solid transparent;
  }
  .tools-tab:hover { color: var(--c-text-2); }
  .tools-tab.active {
    color: var(--c-text);
    border-bottom-color: var(--c-accent);
  }

  .tools-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .tools-list::-webkit-scrollbar { width: 6px; }
  .tools-list::-webkit-scrollbar-track { background: var(--c-panel); }
  .tools-list::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  .tool-item {
    padding: 4px 12px 4px 18px;
    font-size: 12px;
    color: var(--c-text-2);
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .tool-item:hover { background: var(--c-raise); }
  .tool-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .tool-dot.green { background: #43a047; }
  .tool-dot.gray { background: #555; }
  .tool-dot.yellow { background: #d29922; }
  .tool-dot.red { background: #f85149; }
  .tool-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-status {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255,255,255,0.06);
    flex-shrink: 0;
  }
  .tool-status.green { color: #43a047; }
  .tool-status.gray { color: var(--c-text-4); }
  .tool-status.yellow { color: #d29922; }
  .tool-status.red { color: #f85149; }

  /* ③ 底部: 工作区选择 + 设置 (不滚动) */
  .sidebar-footer {
    flex-shrink: 0;
    border-top: 1px solid var(--c-border);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .workspace-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    user-select: none;
  }
  .workspace-icon { font-size: 14px; }
  .workspace-name {
    flex: 1;
    font-size: 12px;
    color: var(--c-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .settings-btn-sidebar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: rgba(255,255,255,0.06);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text-2);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .settings-btn-sidebar:hover { background: rgba(255,255,255,0.12); color: #fff; }

  /* ===== 右侧工作区 ===== */
  .agent-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .chat-header {
    padding: 8px 16px;
    background: var(--c-panel);
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .chat-header-status {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #43a047;
  }
  .chat-header-status.busy { background: #f0ad4e; animation: agent-pulse 1.2s ease-in-out infinite; }
  .chat-header-status.error { background: #ff6b6b; }

  .chat-header-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--c-text);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-header-actions {
    display: flex;
    gap: 4px;
  }

  .icon-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text-2);
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
  .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* 消息区（包裹层承载悬浮「回到底部」按钮的定位） */
  .msg-area-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .msg-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    user-select: text;
  }
  .msg-area::-webkit-scrollbar { width: 8px; }
  .msg-area::-webkit-scrollbar-track { background: var(--c-bg-deep); }
  .msg-area::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

  /* 回到底部悬浮圆球（未滚到底部时显示） */
  .scroll-bottom-btn {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #fff;
    color: #111;
    border: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
    z-index: 10;
    transition: background 0.15s;
  }
  .scroll-bottom-btn.show { display: flex; }
  .scroll-bottom-btn:hover { background: #e6e6e6; }

  /* Todo 固定面板（有 todos 时常驻在消息区与输入区之间，实时反映完成状态） */
  .todos-panel {
    flex-shrink: 0;
    background: var(--c-panel);
    border-top: 1px solid var(--c-border);
    font-size: 12px;
  }
  .todos-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    cursor: pointer;
    user-select: none;
    color: var(--c-text-2);
  }
  .todos-panel-header:hover { background: rgba(255,255,255,0.04); }
  .todos-panel-progress { color: var(--c-text-3); margin-left: 6px; }
  .todos-panel-toggle { color: var(--c-text-3); font-size: 10px; transition: transform 0.15s; }
  .todos-panel.collapsed .todos-panel-toggle { transform: rotate(-90deg); }
  .todos-panel-list { max-height: 150px; overflow-y: auto; padding: 0 14px 8px; }
  .todos-panel-list::-webkit-scrollbar { width: 6px; }
  .todos-panel-list::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }
  .todos-panel.collapsed .todos-panel-list { display: none; }
  .todo-item { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; line-height: 1.5; }
  .todo-item-icon { flex-shrink: 0; width: 14px; text-align: center; }
  .todo-item.completed { color: var(--c-text-4); }
  .todo-item.completed .todo-item-text { text-decoration: line-through; }
  .todo-item.completed .todo-item-icon { color: #3fb950; }
  .todo-item.in_progress { color: #e3b341; }
  .todo-item.pending { color: var(--c-text-2); }

  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  .msg.user {
    background: var(--c-accent);
    color: #fff;
    align-self: flex-end;
    border-bottom-right-radius: 2px;
  }

  .msg.assistant {
    background: var(--c-raise-2);
    color: var(--c-text);
    align-self: flex-start;
    border-bottom-left-radius: 2px;
  }

  .msg.tool-use {
    background: var(--c-raise);
    color: var(--c-text-3);
    font-size: 12px;
    font-family: monospace;
    align-self: flex-start;
    border: 1px solid var(--c-border);
  }

  .msg.error {
    background: #3d1a1a;
    color: #ff6b6b;
    align-self: center;
    font-size: 13px;
  }

  .msg-meta {
    font-size: 11px;
    color: var(--c-text-4);
    margin-top: 4px;
  }

  /* 输入框区域 */
  .input-area {
    flex-shrink: 0;
    background: var(--c-panel);
    border-top: 1px solid var(--c-border);
    display: flex;
    flex-direction: column;
  }

  .input-textarea {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--c-text);
    padding: 10px 16px;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    min-height: 36px;
    max-height: 200px;
    line-height: 1.5;
    transition: border-color 0.15s;
    outline: none;
  }
  .input-textarea::placeholder { color: var(--c-text-4); }

  /* 底部工具栏: ⚡Agent | 模型▾ | 上下文用量 | 📎 📤发送 */
  .agent-input-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--c-raise-2);
  }

  .toolbar-mode-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .toolbar-mode-btn:hover { background: rgba(255,255,255,0.15); }
  .toolbar-mode-btn.plan { background: #2b6cb0; color: #fff; }
  .toolbar-mode-btn.plan:hover { background: #245a94; }

  /* 微信消息跟随开关（模型选择旁）：开启时微信 Bot 消息注入当前打开的会话 */
  .toolbar-wx-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text-2);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .toolbar-wx-btn:hover { background: rgba(255,255,255,0.15); }
  .toolbar-wx-btn.on { background: #07c160; color: #fff; }
  .toolbar-wx-btn.on:hover { background: #06a552; }

  .toolbar-model-selector {
    position: relative;
  }

  .model-current {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .model-current:hover { background: rgba(255,255,255,0.15); }
  .dropdown-arrow { font-size: 10px; color: var(--c-text-4); }

  .model-dropdown {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: var(--c-raise);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    min-width: 220px;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
    z-index: 100;
    max-height: 320px;
    overflow-y: auto;
  }
  .model-dropdown.show { display: block; }
  .model-dropdown::-webkit-scrollbar { width: 6px; }
  .model-dropdown::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  .model-item {
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .model-item:hover { background: var(--c-raise-2); }
  .model-item.selected::before { content: '● '; color: var(--c-accent); font-weight: 600; }
  .model-item.model-add {
    border-top: 1px solid var(--c-border);
    color: var(--c-accent);
  }
  .model-item-name { flex: 1; }
  .model-item-ctx { font-size: 11px; color: var(--c-text-4); }

  .toolbar-context-usage {
    font-size: 12px;
    color: var(--c-text-3);
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 2px;
    font-family: monospace;
  }
  .toolbar-context-usage.warning { color: #f0ad4e; }
  .toolbar-context-usage.danger { color: #ff6b6b; }
  .usage-separator { color: var(--c-text-4); }

  .toolbar-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar-attach-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text-2);
    width: 30px; height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .toolbar-attach-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }

  /* ===== 附件预览区 ===== */
  .attach-preview-area {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 12px 0;
  }
  .attach-preview-area:empty { display: none; }
  .attach-preview-item {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255,255,255,0.06);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--c-text-2);
    max-width: 220px;
  }
  .attach-preview-item img {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .attach-preview-item .attach-file-icon {
    font-size: 18px;
    flex-shrink: 0;
  }
  .attach-preview-item .attach-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attach-preview-item .attach-remove {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 16px;
    height: 16px;
    background: #e85d3a;
    color: #fff;
    border: none;
    border-radius: 50%;
    font-size: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .attach-preview-item .attach-remove:hover { background: #c94e30; }
  .input-area.drag-over { background: rgba(var(--c-accent-rgb),0.08); }

  /* ===== 右键菜单 ===== */
  #agent-ctx-menu div:hover { background: var(--c-raise-2); }

  .toolbar-send-btn {
    background: var(--c-accent);
    color: #fff;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .toolbar-send-btn:hover { background: var(--c-accent-2); }
  .toolbar-send-btn:disabled { background: var(--c-border-hi); cursor: not-allowed; }
  .toolbar-send-btn.cancel { background: #e85d3a; }
  .toolbar-send-btn.cancel:hover { background: #c94e30; }

  /* ===== 底部状态栏 ===== */
  .agent-status-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--c-panel-2);
    padding: 4px 16px;
    font-size: 11px;
    color: var(--c-text-2);
    border-top: 1px solid var(--c-border-soft);
  }
  .status-item {
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-item:first-child { padding-left: 0; }
  .status-separator { color: var(--c-border); }
  .status-state-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  .status-state-dot.ready { background: #43a047; }
  .status-state-dot.busy { background: #f0ad4e; }
  .status-state-dot.error { background: #ff6b6b; }

  /* ===== 设置弹窗 ===== */
  .settings-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 9000;
    justify-content: center;
    align-items: center;
  }
  .settings-overlay.show { display: flex; }

  .settings-modal {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    width: 560px;
    max-width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .settings-modal::-webkit-scrollbar { width: 6px; }
  .settings-modal::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  .settings-header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .settings-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--c-text);
  }

  .settings-close {
    background: none;
    border: none;
    color: var(--c-text-3);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
  }
  .settings-close:hover { color: #fff; }

  .settings-body {
    padding: 16px 20px;
  }

  .param-group {
    margin-bottom: 20px;
  }
  .param-group-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--c-text-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--c-raise-2);
  }

  .param-row {
    display: flex;
    align-items: flex-start;
    margin-bottom: 12px;
    gap: 12px;
  }
  .param-label {
    width: 100px;
    font-size: 13px;
    color: var(--c-text-2);
    flex-shrink: 0;
    padding-top: 4px;
  }
  .param-input {
    flex: 1;
  }
  .param-desc {
    font-size: 11px;
    color: var(--c-text-4);
    margin-top: 2px;
  }

  .settings-input, .settings-select {
    width: 100%;
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  .settings-input:focus, .settings-select:focus {
    outline: none;
    border-color: var(--c-accent);
  }

  .workdir-row {
    display: flex;
    gap: 6px;
  }
  .workdir-row .settings-input { flex: 1; }
  .browse-btn {
    background: var(--c-overlay);
    border: 1px solid var(--c-border);
    color: var(--c-text);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .browse-btn:hover { background: var(--c-overlay-strong); }

  .checkbox-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox-wrap input[type="checkbox"] {
    width: 16px; height: 16px;
    cursor: pointer;
    accent-color: var(--c-accent);
  }

  .settings-footer {
    padding: 12px 20px;
    border-top: 1px solid var(--c-border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .settings-btn {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
  }
  .settings-btn-primary { background: var(--c-accent); color: #fff; }
  .settings-btn-primary:hover { background: var(--c-accent-2); }
  .settings-btn-secondary { background: var(--c-overlay); color: var(--c-text); }
  .settings-btn-secondary:hover { background: var(--c-overlay-strong); }

  /* 云端模型管理 */
  .provider-list {
    margin-top: 8px;
    /* 最多显示 3 个云端模型卡片（每张约 60px + 8px 间距），超出滚动 */
    max-height: 196px;
    overflow-y: auto;
  }

  .provider-card {
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }

  .provider-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .provider-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text);
  }

  .provider-actions {
    display: flex;
    gap: 4px;
  }

  .provider-action-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: var(--c-text-2);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }
  .provider-action-btn:hover { background: rgba(255,255,255,0.15); }
  .provider-action-btn.delete:hover { background: #3d1a1a; color: #ff6b6b; }

  .provider-detail {
    font-size: 11px;
    color: var(--c-text-3);
  }

  .btn-add-cloud {
    background: rgba(var(--c-accent-rgb), 0.1);
    border: 1px dashed var(--c-accent);
    color: var(--c-accent);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    width: 100%;
    text-align: center;
  }
  .btn-add-cloud:hover { background: rgba(var(--c-accent-rgb), 0.2); }

  /* admAgent 版本 */
  .version-table {
    width: 100%;
    font-size: 12px;
  }
  .version-table td {
    padding: 4px 0;
    color: var(--c-text-2);
  }
  .version-table td:first-child { width: 80px; color: var(--c-text-4); }

  /* 模型添加弹窗 */
  .add-model-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 9100;
    justify-content: center;
    align-items: center;
  }
  .add-model-overlay.show { display: flex; }

  /* 空状态 */
  .empty-state {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 8px;
    color: var(--c-text-4);
  }
  .empty-state-icon { font-size: 48px; }
  .empty-state-text { font-size: 14px; }

  /* 加载状态 */
  .loading-spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: agent-spin 0.8s linear infinite;
  }
  @keyframes agent-spin { to { transform: rotate(360deg); } }
  @keyframes agent-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* 正在工作指示器（消息区底部） */
  .working-indicator {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    color: var(--c-text-3);
    font-size: 13px;
    animation: indicator-fade-in 0.3s ease-out;
  }
  .working-indicator-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--c-accent);
    animation: working-dot-pulse 1.4s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(var(--c-accent-rgb), 0.5);
  }
  .working-indicator-text {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .working-indicator-dots span {
    display: inline-block;
    width: 4px; height: 4px;
    border-radius: 50%;
    background: var(--c-accent);
    animation: dot-bounce 1.4s ease-in-out infinite;
  }
  .working-indicator-dots span:nth-child(2) { animation-delay: 0.2s; }
  .working-indicator-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes indicator-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes working-dot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
  @keyframes dot-bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }

  /* 确认弹窗（showConfirm 复用，原权限审批弹窗样式骨架） */
  .permission-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 9200;
    justify-content: center;
    align-items: center;
  }
  .permission-overlay.show { display: flex; }

  .permission-modal {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    width: 440px;
    max-width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .permission-header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .permission-icon { font-size: 20px; }
  .permission-title { font-size: 15px; font-weight: 600; color: var(--c-text); }
  .permission-body {
    padding: 16px 20px;
    font-size: 13px;
    color: var(--c-text-2);
    line-height: 1.6;
  }
  .permission-detail-box {
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 8px 0;
    font-family: monospace;
    font-size: 12px;
    color: var(--c-text);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .permission-footer {
    padding: 12px 20px;
    border-top: 1px solid var(--c-border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>

<div class="agent-root">
  <div class="agent-body">
    <!-- 左侧导航栏 (240px, 无整体滚动) -->
    <div class="agent-sidebar">
      <!-- ① session-block: 新建会话 + 会话列表 (内部滚动) -->
      <div class="session-block">
        <div class="sidebar-header">
          <button class="new-chat-btn" id="agent-new-chat">＋ 新建会话</button>
        </div>
        <!-- 会话视图切换: ★当前对话 / ●全部对话 -->
        <div class="session-toggle" id="agent-session-toggle">
          <span class="toggle-item active" data-mode="current">★ 当前对话</span>
          <span class="toggle-item" data-mode="all">● 全部对话</span>
        </div>
        <!-- 会话列表 (内部滚动) -->
        <div class="conv-list-section" id="agent-conv-list">
        </div>
      </div>

      <!-- ② tools-block: Skills/MCP/LSP (固定高度, 内部滚动, tab 切换) -->
      <div class="tools-section" id="agent-tools-section">
        <div class="tools-header">
          <span>工具</span>
          <span class="tools-count" id="agent-tools-count">0</span>
        </div>
        <div class="tools-tabs" id="agent-tools-tabs">
          <span class="tools-tab active" data-tab="skill">Skill</span>
          <span class="tools-tab" data-tab="lsp">LSP</span>
          <span class="tools-tab" data-tab="mcp">MCP</span>
        </div>
        <div class="tools-list" id="agent-tools-list">
        </div>
      </div>

      <!-- ③ 底部: 工作区展示 + 设置 (不滚动) -->
      <div class="sidebar-footer">
        <div class="workspace-selector" id="agent-workspace-selector">
          <span class="workspace-icon">📁</span>
          <span class="workspace-name" id="agent-workspace-name">默认工作区</span>
        </div>
        <button class="settings-btn-sidebar" id="agent-settings-btn">
          <span>⚙</span>
          <span>设置</span>
        </button>
      </div>
    </div>

    <!-- 右侧对话工作区 -->
    <div class="agent-main">
      <!-- 会话标题栏 (状态 · 操作) -->
      <div class="chat-header">
        <span class="chat-header-status" id="agent-header-status"></span>
        <span class="chat-header-title" id="agent-conv-title">选择或创建一个会话</span>
        <div class="chat-header-actions">
          <button class="icon-btn" id="agent-undo-btn" title="撤销上一轮对话" disabled><span>↶</span><span>撤销上一轮对话</span></button>
        </div>
      </div>

      <!-- 消息列表 (滚动区域) -->
      <div class="msg-area-wrap">
        <div class="msg-area" id="agent-msg-area">
          <div class="empty-state">
            <span class="empty-state-icon">🤖</span>
            <span class="empty-state-text">开始一个新的对话</span>
          </div>
        </div>
        <!-- 回到底部悬浮圆球 -->
        <button class="scroll-bottom-btn" id="agent-scroll-bottom-btn" title="滚动到底部">↓</button>
      </div>

      <!-- Todo 固定面板（有 todos 时显示，实时反映完成状态） -->
      <div class="todos-panel" id="agent-todos-panel" style="display:none;">
        <div class="todos-panel-header" id="agent-todos-header">
          <span>📋 任务清单<span class="todos-panel-progress" id="agent-todos-progress"></span></span>
          <span class="todos-panel-toggle">▾</span>
        </div>
        <div class="todos-panel-list" id="agent-todos-list"></div>
      </div>

      <!-- 输入框区域: textarea 在上, 工具栏在下 -->
      <div class="input-area">
        <textarea class="input-textarea" id="agent-input" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1"></textarea>
        <!-- 附件预览区 -->
        <div class="attach-preview-area" id="agent-attach-preview"></div>
        <!-- 底部工具栏: ⚡Agent | 模型▾ | 上下文用量 | 📎 📤发送 -->
        <div class="agent-input-toolbar">
          <!-- ① 工作模式切换：执行 ↔ Plan（只读计划） -->
          <button class="toolbar-mode-btn" id="agent-mode-toggle" title="点击切换 Plan 模式（只读调研并产出计划，不修改文件）">
            <span class="mode-icon">⚡</span>
            <span class="mode-text">执行</span>
          </button>
          <!-- ② 模型选择下拉 -->
          <div class="toolbar-model-selector">
            <button class="model-current" id="agent-model-btn">
              <span id="agent-model-name">Local Model</span>
              <span class="dropdown-arrow">▾</span>
            </button>
            <div class="model-dropdown" id="agent-model-dropdown">
            </div>
          </div>
          <!-- ②b 微信消息开关：开 = 微信 Bot 消息进入当前打开的会话；关 = 不接收微信消息 -->
          <button class="toolbar-wx-btn" id="agent-wx-follow-btn" title="微信消息开关：开启后微信 Bot 消息进入当前打开的会话；关闭后不再接收微信消息">
            <span class="wx-icon">💬</span>
            <span class="wx-text">微信</span>
          </button>
          <!-- ③ 上下文用量 -->
          <div class="toolbar-context-usage" id="agent-context-usage">
            <span class="usage-current">0</span>
            <span class="usage-separator">/</span>
            <span class="usage-max">0</span>
          </div>
          <!-- ④ 附件与发送 -->
          <div class="toolbar-actions">
            <button class="toolbar-attach-btn" id="agent-attach-btn" title="添加附件">📎</button>
            <button class="toolbar-send-btn" id="agent-send-btn">📤 发送</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 底部状态栏: Agent 状态 · 工作区路径 · Token 统计 -->
  <div class="agent-status-bar">
    <span class="status-item" id="agent-status-state">
      <span class="status-state-dot ready"></span>就绪
    </span>
    <span class="status-separator">·</span>
    <span class="status-item" id="agent-status-workdir">工作区: --</span>
    <span class="status-separator">·</span>
    <span class="status-item" id="agent-status-tokens">Token: 0</span>
  </div>
</div>

<!-- 设置弹窗 -->
<div class="settings-overlay" id="agent-settings-overlay">
  <div class="settings-modal">
    <div class="settings-header">
      <span class="settings-title">Agent 设置</span>
      <button class="settings-close" id="agent-settings-close">✕</button>
    </div>
    <div class="settings-body">

      <!-- 基础设置 -->
      <div class="param-group">
        <div class="param-group-title">基础设置</div>
        <div class="param-row">
          <div class="param-label">工作目录</div>
          <div class="param-input">
            <div class="workdir-row">
              <input type="text" class="settings-input" id="settings-workdir" placeholder="选择工作目录">
              <button class="browse-btn" id="settings-browse-btn">浏览…</button>
            </div>
            <div class="param-desc">Agent 操作文件的根目录</div>
          </div>
        </div>
        <div class="param-row">
          <div class="param-label">Plan 模式</div>
          <div class="param-input">
            <div class="checkbox-wrap">
              <input type="checkbox" id="settings-plan">
              <span>只读计划模式</span>
            </div>
            <div class="param-desc">开启后 Agent 只能读取/检索代码并产出实施计划，不会修改任何文件；关闭则为执行模式（直接执行修改）</div>
          </div>
        </div>
      </div>

      <!-- 模型配置 -->
      <div class="param-group">
        <div class="param-group-title">模型配置</div>
        <div class="param-row">
          <div class="param-label">推理强度</div>
          <div class="param-input">
            <select class="settings-select" id="settings-reasoning-effort">
              <option value="">默认</option>
              <option value="auto">auto</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
        </div>
        <div class="param-row">
          <div class="param-label">采样温度</div>
          <div class="param-input">
            <input type="number" class="settings-input" id="settings-temperature" placeholder="留空使用默认" step="0.1" min="0" max="2">
          </div>
        </div>
      </div>

      <!-- 云端模型管理 -->
      <div class="param-group">
        <div class="param-group-title">云端模型管理</div>
        <div class="provider-list" id="provider-list"></div>
        <button class="btn-add-cloud" id="agent-add-cloud-btn">+ 添加云端模型</button>
      </div>

      <!-- admAgent 版本 -->
      <div class="param-group">
        <div class="param-group-title">admAgent 版本</div>
        <table class="version-table">
          <tr><td>当前版本</td><td id="agent-current-version">检测中...</td></tr>
        </table>
      </div>
    </div>
    <div class="settings-footer">
      <button class="settings-btn settings-btn-secondary" id="agent-settings-cancel">取消</button>
      <button class="settings-btn settings-btn-primary" id="agent-settings-save">保存</button>
    </div>
  </div>
</div>

<!-- 模型添加弹窗 -->
<div class="add-model-overlay" id="agent-add-model-overlay">
  <div class="settings-modal" style="width:440px;">
    <div class="settings-header">
      <span class="settings-title">添加云端模型</span>
      <button class="settings-close" id="agent-add-model-close">✕</button>
    </div>
    <div class="settings-body">
      <div class="param-row" style="flex-direction:column;gap:6px;">
        <input type="text" class="settings-input" id="add-model-modelid" placeholder="模型ID (如 Big Pickle)">
        <input type="text" class="settings-input" id="add-model-name" placeholder="模型名称 (可选, 默认使用模型ID)">
        <input type="text" class="settings-input" id="add-model-baseurl" placeholder="API Base URL (如 https://api.example.com/v1)">
        <input type="text" class="settings-input" id="add-model-apikey" placeholder="API Key">
        <input type="text" class="settings-input" id="add-model-ctx" placeholder="上下文大小 (如 256K, 1M)">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-text-2);cursor:pointer;user-select:none;">
          <input type="checkbox" id="add-model-images" style="cursor:pointer;"> 支持图片输入（视觉模型）
        </label>
        <div id="add-model-msg" style="font-size:12px;min-height:18px;line-height:18px;"></div>
        <button class="settings-btn settings-btn-primary" id="add-model-submit" style="align-self:flex-start;">添加</button>
      </div>
    </div>
  </div>
</div>
`;
