// Agent SPA 视图 — 会话列表 + 聊天界面 + 设置弹窗（HTTP API + SSE 驱动）

const invoke = window.__adm_invoke;
const listen = window.__adm_listen;

let unlisteners = [];
let clientId = null;   // UUID，客户端标识
let serverInfo = null; // { port, workspace_id }
let settings = null;   // { agent_yolo, agent_default_provider, ... }
let providers = [];    // cloud providers list
let localModels = [];  // 本地模型列表 (来自 scan_local_models)
let conversations = []; // 会话列表
let currentConvId = null;
let currentConv = null;  // 当前会话详情
let messages = [];       // 当前消息列表
let sseListener = null;
let sseReconnectTimer = null; // SSE 重连定时器
let isSending = false;
let contextUsage = { used: 0, max: 0 };
let sessionViewMode = "current"; // "current" | "all"
let workspaceInfo = null; // { id, path, name }
let agentInfo = null;    // Agent 状态信息 (当前模型等)

// ===== 模板 =====
const template = `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  .agent-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: #0d1117;
    color: #e0e0e0;
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
    background: #161b22;
    border-right: 1px solid #30363d;
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
    border-bottom: 1px solid #30363d;
    flex-shrink: 0;
  }

  .new-chat-btn {
    width: 100%;
    background: #6c63ff;
    color: #fff;
    border: none;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
    text-align: center;
  }
  .new-chat-btn:hover { background: #5a52d5; }

  /* 会话视图切换 */
  .session-toggle {
    display: flex;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  .toggle-item {
    flex: 1;
    text-align: center;
    padding: 6px 0;
    font-size: 11px;
    color: #6e7681;
    cursor: pointer;
    transition: all 0.15s;
    border-bottom: 2px solid transparent;
  }
  .toggle-item:hover { color: #b0b8c8; }
  .toggle-item.active {
    color: #e0e0e0;
    border-bottom-color: #6c63ff;
  }

  /* 会话列表 — 内部滚动 */
  .conv-list-section {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .conv-list-section::-webkit-scrollbar { width: 6px; }
  .conv-list-section::-webkit-scrollbar-track { background: #161b22; }
  .conv-list-section::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .conv-item {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
  }
  .conv-item:hover { background: #1c2331; }
  .conv-item.active {
    background: #1e2a3a;
    border-left: 3px solid #6c63ff;
    padding-left: 9px;
  }

  .conv-item-title {
    font-size: 13px;
    font-weight: 500;
    color: #e0e0e0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .conv-item-star { color: #6c63ff; font-size: 11px; }
  .conv-item-busy {
    display: inline-block;
    width: 10px; height: 10px;
    border: 2px solid #30363d;
    border-top-color: #6c63ff;
    border-radius: 50%;
    animation: agent-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .conv-item-meta {
    font-size: 11px;
    color: #8b949e;
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
    background: rgba(255,255,255,0.1);
    border: none;
    color: #b0b8c8;
    width: 22px; height: 22px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .conv-action-btn:hover { background: rgba(255,255,255,0.2); color: #fff; }
  .conv-action-btn.delete:hover { background: #3d1a1a; color: #ff6b6b; }

  /* ② tools-block: Skills/MCP/LSP (固定高度, 内部滚动) */
  .tools-section {
    border-top: 1px solid #30363d;
    flex-shrink: 0;
    height: 160px;
    display: flex;
    flex-direction: column;
  }

  .tools-header {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .tools-count {
    font-size: 10px;
    color: #6e7681;
    font-weight: 400;
  }

  .tools-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .tools-list::-webkit-scrollbar { width: 6px; }
  .tools-list::-webkit-scrollbar-track { background: #161b22; }
  .tools-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .tool-item {
    padding: 4px 12px 4px 18px;
    font-size: 12px;
    color: #b0b8c8;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .tool-item:hover { background: #1c2331; }
  .tool-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .tool-dot.green { background: #43a047; }
  .tool-dot.gray { background: #555; }
  .tool-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-type {
    font-size: 10px;
    color: #6e7681;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255,255,255,0.06);
    flex-shrink: 0;
  }

  /* ③ 底部: 工作区选择 + 设置 (不滚动) */
  .sidebar-footer {
    flex-shrink: 0;
    border-top: 1px solid #30363d;
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
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    cursor: default;
  }
  .workspace-icon { font-size: 14px; }
  .workspace-name {
    flex: 1;
    font-size: 12px;
    color: #e0e0e0;
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
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #b0b8c8;
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
    background: #161b22;
    border-bottom: 1px solid #30363d;
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
    color: #f0f0f0;
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
    color: #b0b8c8;
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

  /* 消息区 */
  .msg-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .msg-area::-webkit-scrollbar { width: 8px; }
  .msg-area::-webkit-scrollbar-track { background: #0d1117; }
  .msg-area::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }

  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg.user {
    background: #6c63ff;
    color: #fff;
    align-self: flex-end;
    border-bottom-right-radius: 2px;
  }

  .msg.assistant {
    background: #21262d;
    color: #e0e0e0;
    align-self: flex-start;
    border-bottom-left-radius: 2px;
  }

  .msg.tool-use {
    background: #1a2332;
    color: #8b949e;
    font-size: 12px;
    font-family: monospace;
    align-self: flex-start;
    border: 1px solid #30363d;
  }

  .msg.error {
    background: #3d1a1a;
    color: #ff6b6b;
    align-self: center;
    font-size: 13px;
  }

  .msg-meta {
    font-size: 11px;
    color: #6e7681;
    margin-top: 4px;
  }

  /* 输入框区域 */
  .input-area {
    flex-shrink: 0;
    background: #161b22;
    border-top: 1px solid #30363d;
    display: flex;
    flex-direction: column;
  }

  .input-textarea {
    width: 100%;
    background: transparent;
    border: none;
    color: #e0e0e0;
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
  .input-textarea::placeholder { color: #6e7681; }

  /* 底部工具栏: ⚡Agent | 模型▾ | 上下文用量 | 📎 📤发送 */
  .agent-input-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 8px;
    border-top: 1px solid #21262d;
  }

  .toolbar-mode-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: #e0e0e0;
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
  .toolbar-mode-btn.yolo { background: #e85d3a; color: #fff; }
  .toolbar-mode-btn.yolo:hover { background: #c94e30; }

  .toolbar-model-selector {
    position: relative;
  }

  .model-current {
    background: rgba(255,255,255,0.08);
    border: none;
    color: #e0e0e0;
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
  .dropdown-arrow { font-size: 10px; color: #6e7681; }

  .model-dropdown {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: #1c2331;
    border: 1px solid #30363d;
    border-radius: 8px;
    min-width: 220px;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
    z-index: 100;
    max-height: 320px;
    overflow-y: auto;
  }
  .model-dropdown.show { display: block; }
  .model-dropdown::-webkit-scrollbar { width: 6px; }
  .model-dropdown::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .model-item {
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .model-item:hover { background: #2a3344; }
  .model-item.selected::before { content: '● '; color: #6c63ff; font-weight: 600; }
  .model-item.model-add {
    border-top: 1px solid #30363d;
    color: #6c63ff;
  }
  .model-item-name { flex: 1; }
  .model-item-ctx { font-size: 11px; color: #6e7681; }

  .toolbar-context-usage {
    font-size: 12px;
    color: #8b949e;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 2px;
    font-family: monospace;
  }
  .toolbar-context-usage.warning { color: #f0ad4e; }
  .toolbar-context-usage.danger { color: #ff6b6b; }
  .usage-separator { color: #6e7681; }

  .toolbar-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar-attach-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: #b0b8c8;
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

  .toolbar-send-btn {
    background: #6c63ff;
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
  .toolbar-send-btn:hover { background: #5a52d5; }
  .toolbar-send-btn:disabled { background: #3a3a5e; cursor: not-allowed; }
  .toolbar-send-btn.cancel { background: #e85d3a; }
  .toolbar-send-btn.cancel:hover { background: #c94e30; }

  /* ===== 底部状态栏 ===== */
  .agent-status-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0;
    background: #0f3460;
    padding: 4px 16px;
    font-size: 11px;
    color: #a0a0c0;
    border-top: 1px solid #1a1a3e;
  }
  .status-item {
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-item:first-child { padding-left: 0; }
  .status-separator { color: #2a2a4e; }
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
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    width: 560px;
    max-width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .settings-modal::-webkit-scrollbar { width: 6px; }
  .settings-modal::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .settings-header {
    padding: 14px 20px;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .settings-title {
    font-size: 16px;
    font-weight: 600;
    color: #f0f0f0;
  }

  .settings-close {
    background: none;
    border: none;
    color: #8b949e;
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
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #21262d;
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
    color: #b0b8c8;
    flex-shrink: 0;
    padding-top: 4px;
  }
  .param-input {
    flex: 1;
  }
  .param-desc {
    font-size: 11px;
    color: #6e7681;
    margin-top: 2px;
  }

  .settings-input, .settings-select {
    width: 100%;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e0e0e0;
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  .settings-input:focus, .settings-select:focus {
    outline: none;
    border-color: #6c63ff;
  }

  .workdir-row {
    display: flex;
    gap: 6px;
  }
  .workdir-row .settings-input { flex: 1; }
  .browse-btn {
    background: rgba(255,255,255,0.1);
    border: 1px solid #30363d;
    color: #e0e0e0;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .browse-btn:hover { background: rgba(255,255,255,0.2); }

  .checkbox-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox-wrap input[type="checkbox"] {
    width: 16px; height: 16px;
    cursor: pointer;
    accent-color: #6c63ff;
  }

  .settings-footer {
    padding: 12px 20px;
    border-top: 1px solid #30363d;
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
  .settings-btn-primary { background: #6c63ff; color: #fff; }
  .settings-btn-primary:hover { background: #5a52d5; }
  .settings-btn-secondary { background: rgba(255,255,255,0.1); color: #e0e0e0; }
  .settings-btn-secondary:hover { background: rgba(255,255,255,0.2); }

  /* 云端模型管理 */
  .provider-list {
    margin-top: 8px;
  }

  .provider-card {
    background: #0d1117;
    border: 1px solid #30363d;
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
    color: #e0e0e0;
  }

  .provider-actions {
    display: flex;
    gap: 4px;
  }

  .provider-action-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: #b0b8c8;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }
  .provider-action-btn:hover { background: rgba(255,255,255,0.15); }
  .provider-action-btn.delete:hover { background: #3d1a1a; color: #ff6b6b; }

  .provider-detail {
    font-size: 11px;
    color: #8b949e;
  }

  .btn-add-cloud {
    background: rgba(108, 99, 255, 0.1);
    border: 1px dashed #6c63ff;
    color: #6c63ff;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    width: 100%;
    text-align: center;
  }
  .btn-add-cloud:hover { background: rgba(108, 99, 255, 0.2); }

  /* admAgent 版本 */
  .version-table {
    width: 100%;
    font-size: 12px;
  }
  .version-table td {
    padding: 4px 0;
    color: #b0b8c8;
  }
  .version-table td:first-child { width: 80px; color: #6e7681; }

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
    color: #6e7681;
  }
  .empty-state-icon { font-size: 48px; }
  .empty-state-text { font-size: 14px; }

  /* 加载状态 */
  .loading-spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid #30363d;
    border-top-color: #6c63ff;
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
    color: #8b949e;
    font-size: 13px;
    animation: indicator-fade-in 0.3s ease-out;
  }
  .working-indicator-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #6c63ff;
    animation: working-dot-pulse 1.4s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(108, 99, 255, 0.5);
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
    background: #6c63ff;
    animation: dot-bounce 1.4s ease-in-out infinite;
  }
  .working-indicator-dots span:nth-child(2) { animation-delay: 0.2s; }
  .working-indicator-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes indicator-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes working-dot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
  @keyframes dot-bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }

  /* 权限确认弹窗 */
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
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    width: 440px;
    max-width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .permission-header {
    padding: 14px 20px;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .permission-icon { font-size: 20px; }
  .permission-title { font-size: 15px; font-weight: 600; color: #f0f0f0; }
  .permission-body {
    padding: 16px 20px;
    font-size: 13px;
    color: #b0b8c8;
    line-height: 1.6;
  }
  .permission-detail-box {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px 12px;
    margin: 8px 0;
    font-family: monospace;
    font-size: 12px;
    color: #e0e0e0;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .permission-footer {
    padding: 12px 20px;
    border-top: 1px solid #30363d;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .permission-skip-row {
    padding: 0 20px 12px;
    font-size: 12px;
    color: #8b949e;
    display: flex;
    align-items: center;
    gap: 6px;
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

      <!-- ② tools-block: Skills/MCP/LSP (固定高度160px, 内部滚动) -->
      <div class="tools-section" id="agent-tools-section">
        <div class="tools-header">
          <span>工具</span>
          <span class="tools-count" id="agent-tools-count">0</span>
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
      <div class="msg-area" id="agent-msg-area">
        <div class="empty-state">
          <span class="empty-state-icon">🤖</span>
          <span class="empty-state-text">开始一个新的对话</span>
        </div>
      </div>

      <!-- 输入框区域: textarea 在上, 工具栏在下 -->
      <div class="input-area">
        <textarea class="input-textarea" id="agent-input" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1"></textarea>
        <!-- 底部工具栏: ⚡Agent | 模型▾ | 上下文用量 | 📎 📤发送 -->
        <div class="agent-input-toolbar">
          <!-- ① 工作模式切换 -->
          <button class="toolbar-mode-btn" id="agent-mode-toggle" title="点击切换 YOLO 模式（跳过权限确认）">
            <span class="mode-icon">⚡</span>
            <span class="mode-text">Agent</span>
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
          <div class="param-label">YOLO 模式</div>
          <div class="param-input">
            <div class="checkbox-wrap">
              <input type="checkbox" id="settings-yolo">
              <span>跳过所有权限确认</span>
            </div>
            <div class="param-desc">开启后 Agent 执行操作不再弹窗确认</div>
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
        <div id="add-model-msg" style="font-size:12px;min-height:18px;line-height:18px;"></div>
        <button class="settings-btn settings-btn-primary" id="add-model-submit" style="align-self:flex-start;">添加</button>
      </div>
    </div>
  </div>
</div>

<!-- 权限确认弹窗 -->
<div class="permission-overlay" id="agent-permission-overlay">
  <div class="permission-modal">
    <div class="permission-header">
      <span class="permission-icon">⚠️</span>
      <span class="permission-title">权限确认</span>
    </div>
    <div class="permission-body" id="agent-permission-body">
    </div>
    <div class="permission-skip-row">
      <input type="checkbox" id="agent-permission-skip">
      <span>本次会话不再询问此类操作</span>
    </div>
    <div class="permission-footer">
      <button class="settings-btn settings-btn-secondary" id="agent-permission-deny">拒绝</button>
      <button class="settings-btn settings-btn-secondary" id="agent-permission-allow-session">允许本次会话</button>
      <button class="settings-btn settings-btn-primary" id="agent-permission-allow">允许</button>
    </div>
  </div>
</div>
`;

// ===== API 客户端 =====
async function api(method, path, body) {
  console.log("[agent] API:", method, path, body ? JSON.stringify(body).substring(0, 100) : "");
  return invoke("agent_http_request", { method, path, body: body || null });
}

// ===== 初始化 =====
async function init() {
  console.log("[agent] init() 开始");
  // 生成 clientId (UUID)
  clientId = crypto.randomUUID ? crypto.randomUUID() : generateUUID();

  // 加载设置
  try {
    settings = await invoke("load_settings");
  } catch (_) {
    settings = {};
  }

  // 更新状态栏
  updateStatusBar("ready", null, 0);

  // 检查 admAgent 是否已下载
  try {
    var agentInfo = await invoke("check_adm_agent");
    if (!agentInfo || !agentInfo.exists) {
      showError("未找到 admAgent 工具，请先下载");
      updateStatusBar("error", null, 0);
      // 显示下载引导
      showDownloadGuide();
      return;
    }
  } catch (e) {
    showError("检查 admAgent 失败: " + e);
    updateStatusBar("error", null, 0);
    return;
  }

  // 检查 admAgent server 状态
  try {
    const status = await invoke("get_agent_server_status");
    if (status.running && status.port) {
      serverInfo = { port: status.port, workspace_id: status.workspace_id || "" };
    } else {
      // 启动 server
      try {
        serverInfo = await invoke("start_agent_server");
      console.log("[agent] Agent 服务已启动, port:", serverInfo?.port);
      } catch (e) {
        console.error("[agent] 启动 Agent 服务失败:", e);
        showError("启动 Agent 服务失败: " + e);
        updateStatusBar("error", null, 0);
        return;
      }
    }
  } catch (e) {
    showError("检查 Agent 服务状态失败: " + e);
    updateStatusBar("error", null, 0);
    return;
  }

  // 加载工作区信息 (获取或创建工作区)
  try {
    var workdir = await invoke("get_agent_workdir");
    if (workdir) {
      // 尝试获取或创建工作区
      try {
        const workspaces = await api("GET", "/v1/workspaces");
        if (Array.isArray(workspaces) && workspaces.length > 0) {
          // 查找匹配的工作区
          const matched = workspaces.find(function(w) { return w.path === workdir; });
          if (matched) {
            workspaceInfo = { id: matched.id, path: matched.path, name: matched.path.split(/[\\/]/).pop() };
          }
        }
        // 如果没有匹配的工作区，创建新的
        if (!workspaceInfo) {
          const newWs = await api("POST", "/v1/workspaces", {
            path: workdir,
            yolo: settings.agent_yolo || false,
            client_id: clientId
          });
          workspaceInfo = { id: newWs.id, path: newWs.path, name: newWs.path.split(/[\\/]/).pop() };
        }
        // 更新 serverInfo 的 workspace_id
        if (workspaceInfo && workspaceInfo.id) {
          serverInfo.workspace_id = workspaceInfo.id;
        }
      } catch (_) {
        workspaceInfo = { path: workdir, name: workdir.split(/[\\/]/).pop() };
      }
    } else {
      workspaceInfo = { path: "默认", name: "默认工作区" };
    }
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, 0);
  } catch (_) {
    workspaceInfo = { path: "默认", name: "默认工作区" };
  }

  // 加载 provider 列表
  try {
    providers = await invoke("list_cloud_providers");
  } catch (_) {
    providers = [];
  }

  // 加载本地模型列表
  try {
    localModels = await invoke("scan_local_models");
    if (!Array.isArray(localModels)) localModels = [];
  } catch (_) {
    localModels = [];
  }

  // 初始化 Agent (调用 /agent/init)
  if (serverInfo.workspace_id) {
    try {
      await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/init");
    } catch (_) {
      // 初始化失败不阻塞，可能已经初始化过
    }

    // 获取 Agent 信息 (当前模型等)
    try {
      agentInfo = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/agent");
      // 更新 contextUsage.max
      if (agentInfo && agentInfo.model && agentInfo.model.context_window) {
        contextUsage.max = agentInfo.model.context_window;
      }
      updateContextUsage();
    } catch (_) {}
  }

  // 加载会话列表
  await loadConversations();

  // 加载工具列表
  await loadTools();

  // 检查 admAgent 版本
  checkAgentVersion();

  // 更新 UI
  updateModelDropdown();
  updateModeToggle();
  updateSettingsUI();

  // 监听 SSE 事件
  setupSSEListener();

  // 检查项目初始化引导
  checkProjectInit();
}

// 显示下载引导
function showDownloadGuide() {
  var area = document.getElementById("agent-msg-area");
  if (area) {
    area.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:#b0b8c8;">' +
      '<div style="font-size:48px;">📦</div>' +
      '<div style="font-size:16px;font-weight:600;">需要下载 admAgent 工具</div>' +
      '<div style="font-size:13px;color:#8b949e;text-align:center;max-width:400px;">' +
        'admAgent 是 Agent 功能的核心组件，需要下载后才能使用。<br>请点击下方按钮开始下载。' +
      '</div>' +
      '<button id="agent-download-btn" style="background:#6c63ff;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;">' +
        '下载 admAgent' +
      '</button>' +
      '</div>';

    // 绑定下载按钮事件
    setTimeout(function() {
      var btn = document.getElementById("agent-download-btn");
      if (btn) {
        btn.addEventListener("click", async function() {
          btn.disabled = true;
          btn.textContent = "下载中...";
          try {
            await invoke("download_adm_agent");
            btn.textContent = "下载完成，正在启动...";
            // 重新初始化
            setTimeout(function() { init(); }, 1000);
          } catch (e) {
            btn.textContent = "下载失败，点击重试";
            btn.disabled = false;
            showError("下载失败: " + e);
          }
        });
      }
    }, 0);
  }
}

// 等待 server 就绪 (轮询 health)
async function waitForServerReady() {
  var retries = 0;
  var maxRetries = 30; // 最多等待 30 次，每次 500ms = 15 秒
  while (retries < maxRetries) {
    try {
      await api("GET", "/v1/health");
      return; // server 就绪
    } catch (_) {
      retries++;
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
  }
  throw new Error("等待 server 超时");
}

// 生成 UUID (兼容性方案)
function generateUUID() {
  var d = Date.now();
  var d2 = (typeof performance !== "undefined" && performance.now && (performance.now() * 1000)) || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ===== 会话管理 =====
async function loadConversations() {
  console.log("[agent] 加载会话列表");
  if (!serverInfo) return;
  try {
    // GET /v1/workspaces/{id}/sessions → 返回 Session[] (直接数组)
    var resp = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions");
    conversations = Array.isArray(resp) ? resp : (resp.sessions || resp || []);
    renderConversationList();

    // 自动选中或创建会话：确保 currentConvId 始终有效，否则发送按钮无反应
    if (!currentConvId) {
      if (conversations.length > 0) {
        // 选中第一个会话
        await selectConversation(conversations[0].id);
      } else {
        // 没有会话则自动创建一个
        await newConversation();
      }
    }
  } catch (e) {
    conversations = [];
    renderConversationList();
  }
}

function renderConversationList() {
  const container = document.getElementById("agent-conv-list");
  if (!container) return;
  container.innerHTML = "";

  // 根据视图模式过滤
  var list = conversations;
  if (sessionViewMode === "current" && currentConvId) {
    list = conversations.filter(function(c) { return c.id === currentConvId; });
  }

  if (list.length === 0) {
    var emptyText = sessionViewMode === "current" ? "当前无选中会话" : "暂无会话";
    container.innerHTML = '<div style="padding:12px 14px;color:#6e7681;font-size:12px;">' + emptyText + '</div>';
    return;
  }

  list.forEach(function(conv) {
    var item = document.createElement("div");
    var isActive = conv.id === currentConvId;
    item.className = "conv-item" + (isActive ? " active" : "");
    var msgCount = conv.message_count || conv.messages || 0;
    var lastTime = conv.updated_at || conv.last_time || "";
    var isBusy = conv.is_busy || conv.busy || false;

    var starHtml = isActive ? '<span class="conv-item-star">★</span>' : '';
    var busyHtml = isBusy ? '<span class="conv-item-busy"></span>' : '';

    item.innerHTML =
      '<div class="conv-item-title">' + starHtml + busyHtml +
        '<span style="overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(conv.title || conv.name || "新会话") + "</span>" +
      "</div>" +
      '<div class="conv-item-meta">' +
        '<span>' + msgCount + ' 条消息</span>' +
        (lastTime ? '<span>' + formatTime(lastTime) + "</span>" : "") +
      "</div>" +
      '<div class="conv-item-actions">' +
        '<button class="conv-action-btn" data-action="rename" title="重命名">✎</button>' +
        '<button class="conv-action-btn delete" data-action="delete" title="删除">✕</button>' +
      "</div>";

    item.addEventListener("click", function() { selectConversation(conv.id); });

    // 悬停操作按钮
    var actions = item.querySelectorAll(".conv-action-btn");
    actions.forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var action = btn.getAttribute("data-action");
        handleConvAction(action, conv.id);
      });
    });

    // 右键菜单
    item.addEventListener("contextmenu", function(e) {
      e.preventDefault();
      showConvContextMenu(e, conv.id);
    });

    container.appendChild(item);
  });
}

function handleConvAction(action, convId) {
  switch (action) {
    case "rename":
      var oldConv = conversations.find(function(c) { return c.id === convId; });
      var defaultName = oldConv ? (oldConv.title || oldConv.name || "") : "";
      var newName = prompt("重命名会话:", defaultName);
      if (newName && newName !== defaultName) {
        api("PUT", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + convId, { title: newName })
          .then(function() {
            if (oldConv) { oldConv.title = newName; oldConv.name = newName; }
            if (currentConvId === convId && currentConv) { currentConv.title = newName; }
            renderConversationList();
            if (currentConvId === convId) {
              document.getElementById("agent-conv-title").textContent = newName;
            }
          })
          .catch(function(e) { showError("重命名失败: " + e); });
      }
      break;
    case "delete":
      showConfirm("确定删除此会话？", function() {
        api("DELETE", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + convId)
          .then(function() {
            if (currentConvId === convId) {
              currentConvId = null;
              currentConv = null;
              messages = [];
              renderMessages();
              document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
            }
            loadConversations();
          })
          .catch(function(e) { showError("删除失败: " + e); });
      });
      break;
  }
}

function showConvContextMenu(e, convId) {
  // 简易右键菜单
  var menu = document.createElement("div");
  menu.style.cssText = "position:fixed;background:#1c2331;border:1px solid #30363d;border-radius:8px;padding:4px 0;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";

  var items = [
    { label: "撤销上一轮", action: "undo" },
    { label: "取消运行", action: "cancel" },
    { label: "Shell 命令", action: "shell" },
  ];

  items.forEach(function(it) {
    var mi = document.createElement("div");
    mi.textContent = it.label;
    mi.style.cssText = "padding:6px 16px;font-size:12px;cursor:pointer;color:#b0b8c8;";
    mi.addEventListener("mouseenter", function() { mi.style.background = "#2a3344"; });
    mi.addEventListener("mouseleave", function() { mi.style.background = "transparent"; });
    mi.addEventListener("click", function() {
      document.body.removeChild(menu);
      if (it.action === "undo") {
        api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/sessions/" + convId + "/undo")
          .catch(function(e) { showError("撤销失败: " + e); });
      } else if (it.action === "cancel") {
        api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/sessions/" + convId + "/cancel")
          .catch(function(e) { showError("取消失败: " + e); });
      } else if (it.action === "shell") {
        var cmd = prompt("Shell 命令:", "");
        if (cmd) {
          api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/sessions/" + convId + "/shell", {
            session_id: convId, command: cmd
          }).catch(function(e) { showError("Shell 执行失败: " + e); });
        }
      }
    });
    menu.appendChild(mi);
  });

  document.body.appendChild(menu);
  var closeHandler = function(ev) {
    if (!menu.contains(ev.target)) {
      if (document.body.contains(menu)) document.body.removeChild(menu);
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(function() { document.addEventListener("click", closeHandler); }, 0);
}

async function selectConversation(convId) {
  currentConvId = convId;
  renderConversationList();

  try {
    // 设置当前会话
    api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/current-session?client_id=" + clientId, {
      session_id: convId
    }).catch(function() {});

    // 获取会话信息
    currentConv = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + convId);
    document.getElementById("agent-conv-title").textContent = currentConv.title || "会话";

    // 单独获取消息列表
    messages = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + convId + "/messages");
    if (!Array.isArray(messages)) messages = messages.messages || [];
    renderMessages();

    // 更新上下文用量
    contextUsage.used = currentConv.context_tokens || currentConv.prompt_tokens || 0;
    updateContextUsage();

    // 渲染 Todo 列表
    renderTodos(currentConv.todos);

    // 启用操作按钮
    document.getElementById("agent-undo-btn").disabled = false;
  } catch (e) {
    showError("加载会话失败: " + e);
  }
}

async function newConversation() {
  console.log("[agent] 创建新会话");
  if (!serverInfo) return;
  try {
    // POST /v1/workspaces/{id}/sessions → 返回 Session 对象
    const resp = await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions", {
      title: "新会话 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    });
    // 检查响应是否有效（避免无限递归）
    if (!resp || !resp.id) {
      showError("创建会话失败: 服务端返回无效响应");
      return;
    }
    currentConvId = resp.id;
    messages = [];
    currentConv = resp;
    await loadConversations();
    renderMessages();
    document.getElementById("agent-conv-title").textContent = resp.title || "新会话";
    updateContextUsage();

    // 启用操作按钮
    document.getElementById("agent-undo-btn").disabled = false;
  } catch (e) {
    showError("创建会话失败: " + e);
  }
}

// ===== 消息渲染 =====
// Message 结构: { id, role, session_id, parts: ContentPart[], model, provider, created_at, updated_at }
// ContentPart 联合类型通过 type 字段区分:
//   text / reasoning / image_url / binary / tool_call / tool_result / finish / shell_command
function renderMessages() {
  const area = document.getElementById("agent-msg-area");
  if (!area) return;
  area.innerHTML = "";

  if (messages.length === 0) {
    area.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🤖</span><span class="empty-state-text">开始一个新的对话</span></div>';
    return;
  }

  messages.forEach(function(msg) {
    var div = document.createElement("div");
    var role = msg.role || "assistant";
    div.className = "msg " + role;

    // 如果是流式消息（SSE 临时构建的），直接渲染 content
    if (msg._streaming && msg.content) {
      div.textContent = msg.content;
      area.appendChild(div);
      return;
    }

    // 如果有 parts 数组，按 ContentPart 类型渲染
    if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
      renderMessageParts(div, msg.parts, role);
    } else if (msg.content) {
      // 兼容旧格式
      div.textContent = msg.content;
    } else {
      // 无内容则跳过
      return;
    }

    // 消息元信息
    if (msg.model || msg.provider) {
      var meta = document.createElement("div");
      meta.className = "msg-meta";
      var metaParts = [];
      if (msg.model) metaParts.push(msg.model);
      if (msg.provider) metaParts.push(msg.provider);
      if (msg.created_at) metaParts.push(formatTime(msg.created_at));
      meta.textContent = metaParts.join(" · ");
      div.appendChild(meta);
    }

    area.appendChild(div);
  });

  // 当 Agent 正在工作中时，在消息末尾追加「正在工作」指示器
  if (isSending) {
    var indicator = document.createElement("div");
    indicator.className = "msg assistant working-indicator";
    indicator.id = "agent-working-indicator";
    indicator.innerHTML =
      '<span class="working-indicator-dot"></span>' +
      '<span class="working-indicator-text">正在思考' +
        '<span class="working-indicator-dots"><span></span><span></span><span></span>' +
      '</span></span>';
    area.appendChild(indicator);
  }

  area.scrollTop = area.scrollHeight;
}

// 渲染 ContentPart 数组
function renderMessageParts(container, parts, role) {
  parts.forEach(function(part) {
    if (!part || !part.type) return;
    var partType = part.type;
    var partData = part.data || {};

    switch (partType) {
      case "text":
        var textDiv = document.createElement("div");
        textDiv.className = "msg-text";
        // 使用 Markdown 渲染
        textDiv.innerHTML = renderMarkdown(partData.text || "");
        container.appendChild(textDiv);
        break;

      case "reasoning":
        var details = document.createElement("details");
        details.className = "msg-reasoning";
        var summary = document.createElement("summary");
        summary.textContent = "💭 推理过程";
        summary.style.cssText = "cursor:pointer;font-size:12px;color:#8b949e;";
        details.appendChild(summary);
        var reasoningContent = document.createElement("div");
        reasoningContent.style.cssText = "padding:8px;color:#8b949e;font-style:italic;font-size:12px;white-space:pre-wrap;";
        reasoningContent.textContent = partData.thinking || "";
        details.appendChild(reasoningContent);
        container.appendChild(details);
        break;

      case "tool_call":
        var toolDetails = document.createElement("details");
        toolDetails.className = "msg-tool-call";
        var toolSummary = document.createElement("summary");
        var finished = partData.finished !== false;
        toolSummary.textContent = "🔧 " + (partData.name || "tool") + (finished ? " (已完成)" : " (执行中)");
        toolSummary.style.cssText = "cursor:pointer;font-size:12px;color:#8b949e;";
        toolDetails.appendChild(toolSummary);
        var toolInput = document.createElement("div");
        toolInput.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:#b0b8c8;white-space:pre-wrap;background:#0d1117;border-radius:4px;margin-top:4px;";
        try {
          toolInput.textContent = "输入: " + JSON.stringify(JSON.parse(partData.input || "{}"), null, 2);
        } catch (_) {
          toolInput.textContent = "输入: " + (partData.input || "");
        }
        toolDetails.appendChild(toolInput);
        container.appendChild(toolDetails);
        break;

      case "tool_result":
        var resultDetails = document.createElement("details");
        resultDetails.className = "msg-tool-result";
        var resultSummary = document.createElement("summary");
        var isError = partData.is_error;
        resultSummary.textContent = (isError ? "❌ " : "✅ ") + (partData.name || "tool") + " 结果";
        resultSummary.style.cssText = "cursor:pointer;font-size:12px;color:" + (isError ? "#ff6b6b" : "#43a047") + ";";
        resultDetails.appendChild(resultSummary);
        var resultContent = document.createElement("div");
        resultContent.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:#b0b8c8;white-space:pre-wrap;background:#0d1117;border-radius:4px;margin-top:4px;max-height:300px;overflow-y:auto;";
        resultContent.textContent = partData.content || partData.data || "";
        resultDetails.appendChild(resultContent);
        container.appendChild(resultDetails);
        break;

      case "finish":
        // 用户消息不显示 finish 标记（stop/end_turn 等对用户无意义）
        if (role !== "user") {
          var finishDiv = document.createElement("div");
          finishDiv.className = "msg-finish";
          finishDiv.style.cssText = "border-top:1px solid #30363d;padding-top:4px;margin-top:4px;font-size:11px;color:#6e7681;";
          var reason = partData.reason || "完成";
          finishDiv.textContent = "── " + reason + " ──";
          container.appendChild(finishDiv);
        }
        break;

      case "shell_command":
        var shellDiv = document.createElement("div");
        shellDiv.className = "msg-shell-command";
        shellDiv.style.cssText = "font-family:monospace;font-size:11px;background:#0d1117;border-radius:4px;padding:8px;margin-top:4px;";
        var cmdDiv = document.createElement("div");
        cmdDiv.style.cssText = "color:#6c63ff;";
        cmdDiv.textContent = "$ " + (partData.command || "");
        shellDiv.appendChild(cmdDiv);
        if (partData.output) {
          var outDiv = document.createElement("div");
          outDiv.style.cssText = "color:#b0b8c8;white-space:pre-wrap;margin-top:4px;";
          outDiv.textContent = partData.output;
          shellDiv.appendChild(outDiv);
        }
        if (partData.exit_code !== undefined) {
          var exitDiv = document.createElement("div");
          exitDiv.style.cssText = "color:#6e7681;margin-top:4px;";
          exitDiv.textContent = "退出码: " + partData.exit_code;
          shellDiv.appendChild(exitDiv);
        }
        container.appendChild(shellDiv);
        break;

      case "image_url":
        var img = document.createElement("img");
        img.src = partData.url || "";
        img.style.cssText = "max-width:300px;border-radius:8px;margin-top:4px;";
        container.appendChild(img);
        break;

      case "binary":
        var binDiv = document.createElement("div");
        binDiv.style.cssText = "font-size:12px;color:#8b949e;padding:4px 0;";
        binDiv.textContent = "📎 附件: " + (partData.path || "file") + " (" + (partData.mime_type || "unknown") + ")";
        container.appendChild(binDiv);
        break;

      default:
        // 未知类型，显示原始 JSON
        var unknownDiv = document.createElement("div");
        unknownDiv.style.cssText = "font-size:11px;color:#6e7681;";
        unknownDiv.textContent = JSON.stringify(part);
        container.appendChild(unknownDiv);
    }
  });
}

// ===== 发送消息 =====
async function sendMessage() {
  console.log("[agent] sendMessage() isSending:", isSending, "convId:", currentConvId);
  if (isSending) {
    // 取消运行
    if (currentConvId) {
      try {
        await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/sessions/" + currentConvId + "/cancel");
      } catch (e) { showError("取消失败: " + e); }
    }
    return;
  }
  if (!currentConvId) return;
  var input = document.getElementById("agent-input");
  var text = input.value.trim();
  if (!text) return;

  isSending = true;
  updateSendButton();

  // 立即显示用户消息（使用临时 ID，以便 SSE 到来时去重替换）
  var tempId = "temp-user-" + Date.now();
  messages.push({ id: tempId, role: "user", content: text, _temp: true });
  renderMessages();
  input.value = "";
  autoResize(input);

  // 更新状态栏
  updateStatusBar("busy", null, contextUsage.used);

  try {
    // POST /v1/workspaces/{id}/agent — fire-and-forget, 返回 202 Accepted (无响应体)
    // 实际结果通过 SSE 事件流获取
    var runId = generateRunId();
    var body = {
      session_id: currentConvId,
      prompt: text,
      run_id: runId,
    };
    await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent", body);
    console.log("[agent] 消息已发送, runId:", runId);
    // 不在此处添加 assistant 消息，由 SSE message 事件驱动
    // 注意：不在此处重置 isSending / 状态栏！
    // isSending 和 busy 状态由 SSE "run_complete" 事件来重置（见 handleSSEEvent）
    // 这样用户在 Agent 工作期间能看到"运行中"状态和"取消"按钮
    updateContextUsage();
  } catch (e) {
    // 仅在请求失败时重置状态（网络错误、server 未运行等）
    isSending = false;
    updateSendButton();
    updateStatusBar("ready", null, contextUsage.used);
    messages.push({ role: "error", content: "发送失败: " + e, type: "error" });
    renderMessages();
  }
}

function updateSendButton() {
  var btn = document.getElementById("agent-send-btn");
  if (!btn) return;
  if (isSending) {
    btn.textContent = "⏹ 取消";
    btn.classList.add("cancel");
  } else {
    btn.textContent = "📤 发送";
    btn.classList.remove("cancel");
  }
}

// ===== SSE 事件 =====
function setupSSEListener() {
  console.log("[agent] setupSSEListener()");
  if (sseListener) { try { sseListener(); } catch (_) {} }
  if (typeof listen !== "function") { console.warn("[agent] listen 不是函数"); return; }

  // 通知后端开始订阅 SSE
  invoke("agent_subscribe_events", {
    workspace_id: serverInfo.workspace_id,
    client_id: clientId
  }).catch(function(_) {});

  try {
    sseListener = listen("agent-sse-event", function(event) {
      handleSSEEvent(event.payload);
    });

    // 监听 SSE 错误事件（断线重连）
    listen("agent-sse-error", function() {
      reconnectSSE();
    }).then(function(u) { unlisteners.push(u); }).catch(function() {});
  } catch (_) {}
}

// SSE 断线重连
function reconnectSSE() {
  if (sseReconnectTimer) return;
  updateStatusBar("error", null, contextUsage.used);
  showError("SSE 连接断开，3 秒后重连...");
  sseReconnectTimer = setTimeout(async function() {
    sseReconnectTimer = null;
    try {
      // 重新订阅 SSE
      setupSSEListener();
      // 刷新会话列表
      await loadConversations();
      // 刷新当前会话消息
      if (currentConvId) {
        await refreshMessages();
        // 刷新会话信息
        currentConv = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + currentConvId);
        renderTodos(currentConv.todos);
      }
      updateStatusBar("ready", null, contextUsage.used);
    } catch (e) {
      showError("重连失败: " + e);
    }
  }, 3000);
}

function handleSSEEvent(payload) {
  if (!payload) return;
  console.log("[agent] SSE 事件:", payload.type || payload?.data?.type, "数据:", JSON.stringify(payload).substring(0, 150));
  // 后端 emit 格式: { "type": event_type, "data": parsed_sse_json }
  // parsed_sse_json 结构: { "type": "message"|"session"|"run_complete"|..., "payload": { "type": "created"|"updated"|"deleted", "payload": {...} } }
  var rawData = payload.data || payload;
  var eventType = rawData.type || payload.type || "";
  var eventPayload = rawData.payload || {};
  var innerType = eventPayload.type || ""; // "created" | "updated" | "deleted"
  var actualData = eventPayload.payload || eventPayload || {};

  switch (eventType) {
    case "message":
      handleMessageSSEEvent(innerType, actualData);
      break;
    case "session":
      handleSessionSSEEvent(innerType, actualData);
      break;
    case "run_complete":
      isSending = false;
      updateSendButton();
      updateStatusBar("ready", null, contextUsage.used);
      // 运行完成后刷新 Agent 信息（模型可能已变更）并更新模型按钮显示
      api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/agent").then(function(info) {
        agentInfo = info;
        if (info && info.model && info.model.context_window) {
          contextUsage.max = info.model.context_window;
          updateContextUsage();
        }
        updateModelBtn();
      }).catch(function() {});
      // 运行完成后刷新会话列表和消息
      loadConversations();
      if (currentConvId) {
        refreshMessages();
      }
      break;
    case "permission_request":
      showPermissionDialog(actualData);
      break;
    case "permission_notification":
      // 权限处理结果通知，可忽略或更新 UI
      break;
    case "config_changed":
      // 配置变更，刷新 Agent 信息
      break;
    case "agent_event":
      // Agent 事件（错误/响应/摘要）
      if (actualData.error) {
        showError("Agent 错误: " + actualData.error);
      }
      break;
    case "file":
      // 文件变更，可忽略
      break;
    case "skills_event":
    case "mcp_event":
    case "lsp_event":
      // 工具状态变更，刷新工具列表
      loadTools();
      break;
  }
}

// 处理消息 SSE 事件
function handleMessageSSEEvent(action, msgData) {
  if (action === "created") {
    // 新消息创建 → 追加到消息列表（按 ID 去重）
    var existing = messages.find(function(m) { return m.id === msgData.id; });
    if (!existing) {
      // 对于用户消息，尝试按内容匹配临时消息并替换（避免重复）
      if (msgData.role === "user") {
        var tempIdx = messages.findIndex(function(m) { return m._temp && m.role === "user" && m.content === (msgData.content || getTextFromParts(msgData.parts)); });
        if (tempIdx >= 0) {
          // 用正式消息替换临时消息
          messages[tempIdx] = msgData;
          renderMessages();
          return;
        }
      }
      messages.push(msgData);
      renderMessages();
    }
  } else if (action === "updated") {
    // 消息更新 → 找到对应消息并替换
    var idx = messages.findIndex(function(m) { return m.id === msgData.id; });
    if (idx >= 0) {
      messages[idx] = msgData;
      renderMessages();
    } else {
      // 消息不在列表中 → 追加
      messages.push(msgData);
      renderMessages();
    }
  } else if (action === "deleted") {
    // 消息删除 → 从列表中移除
    messages = messages.filter(function(m) { return m.id !== msgData.id; });
    renderMessages();
  }
}

// 从 parts 中提取文本内容（用于临时消息匹配）
function getTextFromParts(parts) {
  if (!parts || !Array.isArray(parts)) return "";
  var textParts = parts.filter(function(p) { return p.type === "text"; });
  return textParts.map(function(p) { return (p.data && p.data.text) || ""; }).join("");
}

// 处理会话 SSE 事件
function handleSessionSSEEvent(action, sessData) {
  if (action === "created") {
    // 新会话创建
    var existing = conversations.find(function(c) { return c.id === sessData.id; });
    if (!existing) {
      conversations.unshift(sessData);
      renderConversationList();
    }
  } else if (action === "updated") {
    // 会话更新
    var idx = conversations.findIndex(function(c) { return c.id === sessData.id; });
    if (idx >= 0) {
      conversations[idx] = sessData;
      renderConversationList();
    }
    // 如果是当前会话，更新标题和上下文
    if (currentConvId === sessData.id) {
      document.getElementById("agent-conv-title").textContent = sessData.title || "会话";
      contextUsage.used = sessData.context_tokens || sessData.prompt_tokens || 0;
      updateContextUsage();
    }
  } else if (action === "deleted") {
    // 会话删除
    conversations = conversations.filter(function(c) { return c.id !== sessData.id; });
    renderConversationList();
    if (currentConvId === sessData.id) {
      currentConvId = null;
      currentConv = null;
      messages = [];
      renderMessages();
      document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
    }
  }
}

// 刷新当前会话的消息列表
async function refreshMessages() {
  if (!currentConvId || !serverInfo) return;
  try {
    var msgs = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/sessions/" + currentConvId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    messages = msgs;
    renderMessages();
  } catch (_) {}
}

// ===== 权限确认弹窗 =====
function showPermissionDialog(data) {
  var overlay = document.getElementById("agent-permission-overlay");
  var body = document.getElementById("agent-permission-body");
  if (!overlay || !body) return;

  var tool = data.tool_name || data.tool || "unknown";
  var operation = data.action || data.operation || "";
  var description = data.description || "";
  var detail = "";
  if (data.params) {
    try { detail = JSON.stringify(data.params, null, 2); } catch (_) { detail = String(data.params); }
  } else if (data.path) {
    detail = "路径: " + data.path;
  }

  body.innerHTML =
    '<div style="margin-bottom:8px;"><strong>工具:</strong> ' + escapeHtml(tool) + '</div>' +
    (operation ? '<div style="margin-bottom:8px;"><strong>操作:</strong> ' + escapeHtml(operation) + '</div>' : '') +
    (description ? '<div style="margin-bottom:8px;"><strong>描述:</strong> ' + escapeHtml(description) + '</div>' : '') +
    (detail ? '<div><strong>详情:</strong><div class="permission-detail-box">' + escapeHtml(detail) + '</div></div>' : '');

  overlay.classList.add("show");

  // 绑定按钮
  var grantPermission = async function(action) {
    overlay.classList.remove("show");
    var skip = document.getElementById("agent-permission-skip").checked;
    try {
      await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/permissions/grant", {
        permission: data, action: action, skip_session: skip
      });
    } catch (e) {
      showError("权限处理失败: " + e);
    }
  };

  document.getElementById("agent-permission-allow").onclick = function() { grantPermission("allow"); };
  document.getElementById("agent-permission-allow-session").onclick = function() { grantPermission("allow_session"); };
  document.getElementById("agent-permission-deny").onclick = function() { grantPermission("deny"); };
}

// ===== 工具列表 =====
// 分别调用 /skills、/mcp/states、/lsps 三个端点
async function loadTools() {
  if (!serverInfo) return;
  var container = document.getElementById("agent-tools-list");
  var countEl = document.getElementById("agent-tools-count");
  if (!container) return;

  var allTools = [];
  var wsId = serverInfo.workspace_id;

  // 并行请求三个端点
  var results = await Promise.allSettled([
    api("GET", "/v1/workspaces/" + wsId + "/skills"),
    api("GET", "/v1/workspaces/" + wsId + "/mcp/states"),
    api("GET", "/v1/workspaces/" + wsId + "/lsps"),
  ]);

  // Skills
  if (results[0].status === "fulfilled") {
    var skills = results[0].value;
    if (!Array.isArray(skills)) skills = skills.skills || [];
    skills.forEach(function(s) {
      allTools.push({
        name: s.name || s.id || "unknown",
        type: "Skill",
        enabled: s.user_invocable !== false,
        source: s.source || "",
      });
    });
  }

  // MCP clients
  if (results[1].status === "fulfilled") {
    var mcpStates = results[1].value;
    if (mcpStates && typeof mcpStates === "object" && !Array.isArray(mcpStates)) {
      Object.values(mcpStates).forEach(function(m) {
        allTools.push({
          name: m.name || "unknown",
          type: "MCP",
          enabled: m.state === "connected",
          source: m.state || "unknown",
        });
      });
    }
  }

  // LSP clients
  if (results[2].status === "fulfilled") {
    var lspStates = results[2].value;
    if (lspStates && typeof lspStates === "object" && !Array.isArray(lspStates)) {
      Object.values(lspStates).forEach(function(l) {
        allTools.push({
          name: l.name || "unknown",
          type: "LSP",
          enabled: l.state === "connected",
          source: l.state || "unknown",
        });
      });
    }
  }

  if (countEl) countEl.textContent = allTools.length;
  container.innerHTML = "";

  if (allTools.length === 0) {
    container.innerHTML = '<div class="tool-item"><span class="tool-dot gray"></span><span class="tool-name" style="color:#6e7681;">暂无工具</span></div>';
    return;
  }

  allTools.forEach(function(tool) {
    var item = document.createElement("div");
    item.className = "tool-item";
    var dot = document.createElement("span");
    dot.className = "tool-dot " + (tool.enabled ? "green" : "gray");
    item.appendChild(dot);
    var name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    item.appendChild(name);
    var typeLabel = document.createElement("span");
    typeLabel.className = "tool-type";
    typeLabel.textContent = tool.type;
    item.appendChild(typeLabel);
    container.appendChild(item);
  });
}

// ===== 模型切换 =====
// 切换模型：保存设置 → 通知服务端重新加载 → 刷新 agentInfo → 更新 UI
async function switchModel(providerKey, displayName, ctxLen) {
  console.log("[agent] 切换模型:", providerKey, displayName);
  settings.agent_default_provider = providerKey;
  if (ctxLen) contextUsage.max = ctxLen;

  var dropdown = document.getElementById("agent-model-dropdown");
  if (dropdown) dropdown.classList.remove("show");

  // 立即更新按钮文字（用户选择的名称）
  var nameEl = document.getElementById("agent-model-name");
  if (nameEl) nameEl.textContent = displayName;
  updateContextUsage();

  // 轻量级保存：只写 agent_default_provider 等字段到 config.json，不依赖设置弹窗 DOM
  try {
    var s = await invoke("load_settings");
    s.agent_default_provider = settings.agent_default_provider || "local";
    s.agent_yolo = !!settings.agent_yolo;
    s.agent_reasoning_effort = settings.agent_reasoning_effort || "";
    s.agent_temperature = settings.agent_temperature || null;
    await invoke("save_settings", { settings: s });
  } catch (e) {
    showError("保存设置失败: " + e);
  }

  // 通知服务端 Agent 切换模型并重新加载配置（关键！）
  // 必须先调 /config/model 把首选模型写进 admAgent 的配置（agent_default_provider
  // 只存在 ADM 自己的 config.json 里，admAgent 服务端不读它），再调 /agent/update 重载，
  // 否则服务端会一直用 admAgent.json 里旧的 model 字段。
  if (serverInfo && serverInfo.workspace_id) {
    try {
      var target = resolveAgentModel(providerKey);
      var modelCfg = { provider: target.provider, model: target.model };
      if (settings.agent_reasoning_effort) modelCfg.reasoning_effort = settings.agent_reasoning_effort;
      if (typeof settings.agent_temperature === "number") modelCfg.temperature = settings.agent_temperature;
      await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/config/model", {
        scope: 0,
        model: modelCfg
      });
      await api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/update");
      // 刷新 agentInfo 以获取服务端确认后的实际模型
      try {
        agentInfo = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/agent");
        if (agentInfo && agentInfo.model && agentInfo.model.context_window) {
          contextUsage.max = agentInfo.model.context_window;
          updateContextUsage();
        }
        // 用服务端返回的实际模型名覆盖显示（可能与选择名略有差异）
        if (nameEl && agentInfo && agentInfo.model && agentInfo.model.id) {
          nameEl.textContent = agentInfo.model.id;
        }
      } catch (_) { /* agentInfo 刷新失败不影响切换 */ }
    } catch (e) {
      showError("通知 Agent 切换模型失败: " + e);
    }
  }
}

// 把前端 providerKey（"local" / "local:xxx" / 云端 provider key）解析成
// admAgent /config/model 接口需要的 { provider, model }
function resolveAgentModel(providerKey) {
  if (providerKey === "local" || providerKey.startsWith("local:")) {
    // 本地模型统一走 admAgent.json 里自动维护的 local provider（唯一 model id 为 localModel）
    return { provider: "local", model: "localModel" };
  }
  var p = providers.find(function(x) { return x.key === providerKey; });
  if (p && p.model_id) return { provider: providerKey, model: p.model_id };
  // 回退：与后端 slugify_model_id 一致的派生规则
  return { provider: providerKey, model: slugifyModelId(p ? p.name : providerKey) };
}

// 与 src-tauri agent.rs 的 slugify_model_id 保持一致：转小写，
// 空格/下划线/连字符→'-'，保留点号，其它字符忽略，去尾部 '-'/'.'
function slugifyModelId(name) {
  var out = "";
  var prevDash = false;
  for (var i = 0; i < name.length; i++) {
    var c = name[i];
    if (/[a-zA-Z0-9.]/.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (/[\s\-_]/.test(c)) {
      if (out && !prevDash) { out += "-"; prevDash = true; }
    }
  }
  out = out.replace(/[-.]+$/, "");
  return out || "model";
}

// 合并本地模型 + 云端模型渲染下拉列表
function updateModelDropdown() {
  var dropdown = document.getElementById("agent-model-dropdown");
  if (!dropdown) return;

  dropdown.innerHTML = "";

  var currentProvider = settings.agent_default_provider || "local";

  // 本地模型列表 (来自 scan_local_models)
  localModels.forEach(function(m) {
    var item = document.createElement("div");
    var modelId = "local:" + (m.id || m.filename);
    var isSelected = currentProvider === modelId;
    item.className = "model-item" + (isSelected ? " selected" : "");
    var ctxStr = m.context_length ? formatTokens(m.context_length) : "";
    var dispName = m.name || m.filename || "Local Model";
    item.innerHTML = '<span class="model-item-name">🏠 ' + escapeHtml(dispName) + '</span>' +
      (ctxStr ? '<span class="model-item-ctx">' + ctxStr + '</span>' : '');
    item.addEventListener("click", function() {
      switchModel(modelId, dispName, m.context_length || 0);
    });
    dropdown.appendChild(item);
  });

  // 如果没有本地模型，显示默认本地项
  if (localModels.length === 0) {
    var localItem = document.createElement("div");
    var isLocalSelected = currentProvider === "local";
    localItem.className = "model-item" + (isLocalSelected ? " selected" : "");
    localItem.innerHTML = '<span class="model-item-name">🏠 Local Model</span><span class="model-item-ctx">本地</span>';
    localItem.addEventListener("click", function() {
      switchModel("local", "Local Model", 0);
    });
    dropdown.appendChild(localItem);
  }

  // 云端模型
  providers.forEach(function(p) {
    var item = document.createElement("div");
    var isSelected = settings.agent_default_provider === p.key;
    item.className = "model-item" + (isSelected ? " selected" : "");
    var ctxStr = p.context_window ? formatTokens(p.context_window) : "";
    item.innerHTML = '<span class="model-item-name">☁ ' + escapeHtml(p.name) + '</span>' +
      (ctxStr ? '<span class="model-item-ctx">' + ctxStr + '</span>' : '');
    item.addEventListener("click", function() {
      switchModel(p.key, p.name, p.context_window || 0);
    });
    dropdown.appendChild(item);
  });

  // 添加模型按钮
  var addBtn = document.createElement("div");
  addBtn.className = "model-item model-add";
  addBtn.innerHTML = "＋ 添加模型...";
  addBtn.addEventListener("click", function() {
    dropdown.classList.remove("show");
    showAddModelDialog();
  });
  dropdown.appendChild(addBtn);

  updateModelBtn();
}

function updateModelBtn() {
  var nameEl = document.getElementById("agent-model-name");
  if (!nameEl) return;

  // 优先使用 agentInfo（服务端实际运行的模型），保持与消息元信息一致
  if (agentInfo && agentInfo.model && agentInfo.model.id) {
    nameEl.textContent = agentInfo.model.id;
    return;
  }

  // 回退到设置中的默认 provider（初始加载或 agentInfo 不可用时）
  var provider = settings.agent_default_provider || "local";

  // 检查是否是本地模型
  if (provider.startsWith("local:")) {
    var modelId = provider.substring(6);
    var m = localModels.find(function(x) { return (x.id || x.filename) === modelId; });
    nameEl.textContent = m ? (m.name || m.filename) : "Local Model";
  } else if (provider === "local") {
    nameEl.textContent = "Local Model";
  } else {
    var p = providers.find(function(x) { return x.key === provider; });
    nameEl.textContent = p ? p.name : provider;
  }
}

// ===== 模式切换 =====
function updateModeToggle() {
  var btn = document.getElementById("agent-mode-toggle");
  if (!btn) return;
  var modeText = btn.querySelector(".mode-text");
  if (settings.agent_yolo) {
    if (modeText) modeText.textContent = "YOLO";
    btn.classList.add("yolo");
    btn.title = "当前为 YOLO 模式（跳过权限确认），点击切换为常规模式";
  } else {
    if (modeText) modeText.textContent = "Agent";
    btn.classList.remove("yolo");
    btn.title = "当前为常规模式，点击切换 YOLO 模式（跳过权限确认）";
  }
}

// ===== 上下文用量 =====
function updateContextUsage() {
  var el = document.getElementById("agent-context-usage");
  if (!el) return;
  var currentEl = el.querySelector(".usage-current");
  var maxEl = el.querySelector(".usage-max");

  var used = contextUsage.used || 0;
  var max = contextUsage.max || 0;

  if (max > 0) {
    var usedStr = formatTokens(used);
    var maxStr = formatTokens(max);
    if (currentEl) currentEl.textContent = usedStr;
    if (maxEl) maxEl.textContent = maxStr;

    // 警告颜色
    var pct = used / max;
    el.classList.remove("warning", "danger");
    if (pct >= 0.95) {
      el.classList.add("danger");
    } else if (pct >= 0.8) {
      el.classList.add("warning");
    }
  } else {
    if (currentEl) currentEl.textContent = "0";
    if (maxEl) maxEl.textContent = "0";
  }

  // 更新状态栏 Token
  var tokenEl = document.getElementById("agent-status-tokens");
  if (tokenEl) {
    tokenEl.textContent = "Token: " + formatTokens(used) + (max > 0 ? " / " + formatTokens(max) : "");
  }
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n || 0);
}

function parseContextSize(s) {
  s = s.trim().toUpperCase();
  if (!s) return 0;
  if (s.endsWith("M")) return Math.round(parseFloat(s) * 1000000);
  if (s.endsWith("K")) return Math.round(parseFloat(s) * 1000);
  return parseInt(s) || 0;
}

// ===== 工作区选择器 =====
function updateWorkspaceSelector() {
  var nameEl = document.getElementById("agent-workspace-name");
  if (!nameEl || !workspaceInfo) return;
  nameEl.textContent = workspaceInfo.name || "默认工作区";
  nameEl.title = workspaceInfo.path || "";
}

// ===== 底部状态栏 =====
function updateStatusBar(state, workdir, tokens) {
  var stateEl = document.getElementById("agent-status-state");
  var workdirEl = document.getElementById("agent-status-workdir");
  var tokenEl = document.getElementById("agent-status-tokens");

  if (stateEl) {
    var dotClass = "ready";
    var stateText = "就绪";
    if (state === "busy") { dotClass = "busy"; stateText = "运行中"; }
    else if (state === "error") { dotClass = "error"; stateText = "错误"; }
    stateEl.innerHTML = '<span class="status-state-dot ' + dotClass + '"></span>' + stateText;
  }

  if (workdir !== null && workdirEl) {
    workdirEl.textContent = "工作区: " + (workdir || "默认");
    workdirEl.title = workdir || "";
  }

  if (tokenEl && tokens !== null) {
    tokenEl.textContent = "Token: " + formatTokens(tokens);
  }

  // 更新标题栏状态指示器
  var headerStatus = document.getElementById("agent-header-status");
  if (headerStatus) {
    headerStatus.className = "chat-header-status " + (state === "busy" ? "busy" : state === "error" ? "error" : "");
  }
}

// ===== 设置弹窗 =====
function showSettings() {
  updateSettingsUI();
  document.getElementById("agent-settings-overlay").classList.add("show");
}

function hideSettings() {
  document.getElementById("agent-settings-overlay").classList.remove("show");
}

function updateSettingsUI() {
  var workdir = document.getElementById("settings-workdir");
  var yoloCheck = document.getElementById("settings-yolo");
  var reasoningSelect = document.getElementById("settings-reasoning-effort");
  var tempInput = document.getElementById("settings-temperature");

  // 工作目录
  invoke("get_agent_workdir").then(function(dir) {
    workdir.value = dir || "";
  }).catch(function() {});

  // YOLO
  yoloCheck.checked = !!settings.agent_yolo;

  // 推理强度
  reasoningSelect.value = settings.agent_reasoning_effort || "";

  // 温度
  tempInput.value = settings.agent_temperature || "";

  // 云端模型列表
  renderProviderList();
}

async function saveSettings() {
  console.log("[agent] 保存设置");
  try {
    // 保存工作目录
    var workdir = document.getElementById("settings-workdir").value.trim();
    await invoke("set_agent_workdir", { workdir: workdir });

    // 保存 agent 设置到 config
    var s = await invoke("load_settings");
    s.agent_yolo = settings.agent_yolo || false;
    s.agent_default_provider = settings.agent_default_provider || "local";
    s.agent_reasoning_effort = settings.agent_reasoning_effort || "";
    s.agent_temperature = settings.agent_temperature || null;
    await invoke("save_settings", { settings: s });

    // 更新工作区信息
    workspaceInfo = { path: workdir || "默认", name: workdir ? workdir.split(/[\\/]/).pop() : "默认工作区" };
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, contextUsage.used);
  } catch (e) {
    showError("保存设置失败: " + e);
  }
}

// ===== admAgent 版本检查 =====
async function checkAgentVersion() {
  var el = document.getElementById("agent-current-version");
  try {
    var ver = await invoke("get_adm_agent_version");
    if (el) el.textContent = ver || "未知";
  } catch (_) {
    if (el) el.textContent = "未知";
  }
}

// ===== 模型添加弹窗 =====
function showAddModelDialog() {
  document.getElementById("agent-add-model-overlay").classList.add("show");
  renderProviderList();
}

function hideAddModelDialog() {
  document.getElementById("agent-add-model-overlay").classList.remove("show");
}

function renderProviderList() {
  var container = document.getElementById("provider-list");
  if (!container) return;
  container.innerHTML = "";

  if (providers.length === 0) {
    container.innerHTML = '<div style="color:#6e7681;font-size:12px;padding:8px 0;">暂无云端模型</div>';
    return;
  }

  providers.forEach(function(p) {
    var card = document.createElement("div");
    card.className = "provider-card";
    card.innerHTML =
      '<div class="provider-card-header">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="provider-action-btn delete" data-key="' + p.key + '">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-detail">' + escapeHtml(p.base_url) + ' · 上下文: ' + (p.context_window || '默认') + '</div>';
    card.querySelector(".delete").addEventListener("click", function() {
      showConfirm("确定删除云端模型「" + p.name + "」？", async function() {
        try {
          await invoke("delete_cloud_provider", { key: p.key });
          providers = await invoke("list_cloud_providers");
          renderProviderList();
          updateModelDropdown();
        } catch (e) {
          showError("删除失败: " + e);
        }
      });
    });
    container.appendChild(card);
  });
}

function addModelMsg(text, isError) {
  var el = document.getElementById("add-model-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "#22c55e";
}

async function addModel() {
  var modelId = document.getElementById("add-model-modelid").value.trim();
  var name = document.getElementById("add-model-name").value.trim() || modelId;
  var baseUrl = document.getElementById("add-model-baseurl").value.trim();
  var apiKey = document.getElementById("add-model-apikey").value.trim();
  var ctx = parseContextSize(document.getElementById("add-model-ctx").value) || 256000;

  if (!modelId || !baseUrl || !apiKey) {
    addModelMsg("请填写模型ID、API地址和密钥", true);
    return;
  }

  try {
    await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId || null }
    });
    providers = await invoke("list_cloud_providers");
    renderProviderList();
    updateModelDropdown();
    addModelMsg("添加成功", false);
    setTimeout(function() {
      hideAddModelDialog();
      document.getElementById("add-model-name").value = "";
      document.getElementById("add-model-baseurl").value = "";
      document.getElementById("add-model-apikey").value = "";
      document.getElementById("add-model-modelid").value = "";
      document.getElementById("add-model-ctx").value = "";
      document.getElementById("add-model-msg").textContent = "";
    }, 1000);
  } catch (e) {
    addModelMsg("添加失败: " + e, true);
  }
}

// ===== 辅助函数 =====
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTime(t) {
  if (!t) return "";
  try {
    // t 可能是 Unix 时间戳（数字/数字字符串）或 ISO 字符串
    var d;
    if (typeof t === "number" || /^\d+$/.test(t)) {
      d = new Date(parseInt(t, 10) * 1000);
    } else {
      d = new Date(t);
    }
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

function showError(msg) {
  var area = document.getElementById("agent-msg-area");
  if (area) {
    var div = document.createElement("div");
    div.className = "msg error";
    div.textContent = msg;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  }
}

// 应用内确认弹窗（Tauri WebView 中原生 confirm() 非阻塞，不可用）
function showConfirm(message, onOk) {
  var overlay = document.createElement("div");
  overlay.className = "permission-overlay show";
  overlay.innerHTML =
    '<div class="permission-modal">' +
      '<div class="permission-header">' +
        '<span class="permission-icon">⚠️</span>' +
        '<span class="permission-title">确认操作</span>' +
      '</div>' +
      '<div class="permission-body"></div>' +
      '<div class="permission-footer">' +
        '<button class="settings-btn settings-btn-secondary" data-act="cancel">取消</button>' +
        '<button class="settings-btn settings-btn-primary" data-act="ok">确定</button>' +
      '</div>' +
    '</div>';
  overlay.querySelector(".permission-body").textContent = message;
  function close() { overlay.remove(); }
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-act="ok"]').addEventListener("click", function() {
    close();
    onOk();
  });
  overlay.addEventListener("click", function(e) { if (e.target === overlay) close(); });
  // 挂到视图根节点下，随视图 unmount 一起销毁
  (document.querySelector(".agent-root") || document.body).appendChild(overlay);
}

function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

function generateRunId() {
  return "run-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
}

// ===== 事件绑定 =====
function bindEvents() {
  // 新会话
  document.getElementById("agent-new-chat").addEventListener("click", newConversation);

  // 会话视图切换
  document.querySelectorAll(".toggle-item").forEach(function(item) {
    item.addEventListener("click", function() {
      document.querySelectorAll(".toggle-item").forEach(function(i) { i.classList.remove("active"); });
      item.classList.add("active");
      sessionViewMode = item.getAttribute("data-mode");
      renderConversationList();
    });
  });

  // 设置按钮 (在侧栏底部)
  document.getElementById("agent-settings-btn").addEventListener("click", showSettings);
  document.getElementById("agent-settings-close").addEventListener("click", hideSettings);
  document.getElementById("agent-settings-cancel").addEventListener("click", hideSettings);
  document.getElementById("agent-settings-save").addEventListener("click", async function() {
    settings.agent_reasoning_effort = document.getElementById("settings-reasoning-effort").value;
    var tempVal = document.getElementById("settings-temperature").value;
    settings.agent_temperature = tempVal ? parseFloat(tempVal) : null;
    settings.agent_yolo = document.getElementById("settings-yolo").checked;
    await saveSettings();
    hideSettings();
    updateModeToggle();
    updateModelBtn();
    // 同步模型到 admAgent.json
    var selectedKey = settings.agent_default_provider || "local";
    var resolved = resolveAgentModel(selectedKey);
    var displayName = selectedKey === "local" ? "本地模型" : (providers.find(function(p) { return p.key === selectedKey; }) || {}).name || selectedKey;
    var ctxLen = 0;
    var mp = providers.find(function(x) { return x.key === selectedKey; });
    if (mp) ctxLen = mp.context_window || 0;
    await switchModel(selectedKey, displayName, ctxLen);
  });

  // 浏览工作目录
  document.getElementById("settings-browse-btn").addEventListener("click", async function() {
    try {
      var dir = await invoke("get_agent_workdir");
      var newDir = prompt("工作目录路径:", dir || "");
      if (newDir !== null) {
        document.getElementById("settings-workdir").value = newDir;
      }
    } catch (_) {}
  });

  // 云端模型管理
  document.getElementById("agent-add-cloud-btn").addEventListener("click", showAddModelDialog);

  // 模式切换 (工具栏)
  document.getElementById("agent-mode-toggle").addEventListener("click", async function() {
    settings.agent_yolo = !settings.agent_yolo;
    updateModeToggle();
    await saveSettings();
  });

  // 模型下拉
  document.getElementById("agent-model-btn").addEventListener("click", function(e) {
    e.stopPropagation();
    document.getElementById("agent-model-dropdown").classList.toggle("show");
  });
  document.addEventListener("click", function() {
    var dd = document.getElementById("agent-model-dropdown");
    if (dd) dd.classList.remove("show");
  });

  // 模型添加
  document.getElementById("agent-add-model-close").addEventListener("click", hideAddModelDialog);
  document.getElementById("add-model-submit").addEventListener("click", addModel);

  // 附件按钮
  document.getElementById("agent-attach-btn").addEventListener("click", function() {
    // TODO: 实现文件选择对话框
    var input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = function(e) {
      var files = e.target.files;
      if (files && files.length > 0) {
        // 暂时仅显示提示
        showError("附件功能开发中: 选择了 " + files.length + " 个文件");
      }
    };
    input.click();
  });

  // 标题栏操作按钮
  document.getElementById("agent-undo-btn").addEventListener("click", function() {
    if (!currentConvId) return;
    showConfirm("确定撤销上一轮对话？此操作会回退上一轮产生的消息与文件修改。", function() {
      api("POST", "/v1/workspaces/" + serverInfo.workspace_id + "/agent/sessions/" + currentConvId + "/undo")
        .then(function() { selectConversation(currentConvId); })
        .catch(function(e) { showError("撤销失败: " + e); });
    });
  });

  // 输入框
  var input = document.getElementById("agent-input");
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener("input", function() { autoResize(input); });

  // 发送
  document.getElementById("agent-send-btn").addEventListener("click", sendMessage);
}

// ===== Todo 列表渲染 =====
function renderTodos(todos) {
  // TODO: 在右侧消息区域上方或侧边显示 Todo 列表
  // 当前先存储到 currentConv，后续可扩展 UI
  if (currentConv && todos) {
    currentConv.todos = todos;
  }
}

// ===== 项目初始化引导 =====
async function checkProjectInit() {
  if (!serverInfo || !serverInfo.workspace_id) return;
  try {
    var resp = await api("GET", "/v1/workspaces/" + serverInfo.workspace_id + "/project/needs-init");
    if (resp && resp.needs_init) {
      showProjectInitDialog();
    }
  } catch (_) {
    // 端点不存在时忽略
  }
}

function showProjectInitDialog() {
  var overlay = document.getElementById("agent-settings-overlay");
  var body = overlay ? overlay.querySelector(".settings-body") : null;
  if (!body) return;

  // 显示初始化引导提示
  var initDiv = document.createElement("div");
  initDiv.style.cssText = "background:rgba(108,99,255,0.1);border:1px solid #6c63ff;border-radius:8px;padding:12px;margin-bottom:16px;";
  initDiv.innerHTML = "<strong>� 项目初始化</strong><p style='margin-top:4px;font-size:12px;color:#b0b8c8;'>检测到项目需要初始化，建议运行初始化流程以启用完整功能。</p>";
  body.insertBefore(initDiv, body.firstChild);
}

// ===== Markdown 简易渲染 =====
function renderMarkdown(text) {
  if (!text) return "";
  // 简易 Markdown 渲染：代码块、行内代码、粗体、斜体、标题、列表、链接
  var html = escapeHtml(text);

  // 代码块 ```language\ncode```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin:8px 0;overflow-x:auto;font-size:12px;"><code>' + code.trim() + "</code></pre>";
  });

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code style="background:#0d1117;padding:2px 6px;border-radius:3px;font-size:12px;">$1</code>');

  // 标题 ### / ## / #
  html = html.replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 6px;font-size:15px;">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="margin:14px 0 8px;font-size:17px;">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 10px;font-size:19px;">$1</h1>');

  // 粗体 **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // 斜体 *text*
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 列表项
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#6c63ff;text-decoration:none;" target="_blank">$1</a>');

  // 换行
  html = html.replace(/\n/g, "<br>");

  return html;
}

// ===== 生命周期 =====
export default {
  template,
  mount(root, params) {
    console.log("[agent] mount() params:", params);
    root.innerHTML = template;
    bindEvents();
    init();
  },
  unmount() {
    console.log("[agent] unmount()");
    // 停止 SSE 监听
    if (sseListener) { try { sseListener(); } catch (_) {} sseListener = null; }
    // 清除重连定时器
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
    // 取消订阅
    try { invoke("agent_unsubscribe_events"); } catch (_) {}
    // 清理事件监听
    unlisteners.forEach(function(u) { try { if (typeof u === "function") u(); } catch (_) {} });
    unlisteners = [];
  }
};
