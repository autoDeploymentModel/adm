// Agent 视图模板（含 <style>，选择器统一 .agent-/agent- 前缀 + .agent-root 容器）
import { t as _t } from "../../i18n.js";
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
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .conv-item-busy.queued {
    animation: none;
    border-color: var(--c-border);
    background: var(--c-text-3);
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
  .tools-header-right { display: flex; align-items: center; gap: 8px; }
  /* MCP tab 专用：添加 MCP（其余 tab 由 renderToolsList 隐藏） */
  .tools-add-btn {
    display: none;
    background: none;
    border: 1px solid var(--c-border);
    border-radius: 4px;
    color: var(--c-text-3);
    font-size: 11px;
    line-height: 14px;
    height: 18px;
    padding: 0 8px;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tools-add-btn.show { display: inline-block; }
  .tools-add-btn:hover { color: var(--c-text); border-color: var(--c-accent); }

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
  /* 已配置 MCP 条目的「修改」提示：悬停显现 */
  .tool-edit-hint { opacity: 0; font-size: 10px; color: var(--c-text-4); flex-shrink: 0; transition: opacity 0.15s; }
  .tool-item:hover .tool-edit-hint { opacity: 1; }

  /* ③ 底部: 设置 (不滚动) */
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
    cursor: pointer;
    position: relative;
  }
  .workspace-icon { font-size: 14px; }
  .workspace-label {
    font-size: 12px;
    color: var(--c-text-2);
    flex-shrink: 0;
  }
  .workspace-name {
    flex: 1;
    font-size: 12px;
    color: var(--c-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .workdir-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 100;
    max-height: 300px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .workdir-dropdown-item {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--c-text);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .workdir-dropdown-item:hover {
    background: var(--c-bg-hover, rgba(255,255,255,0.08));
  }
  .workdir-dropdown-item.active {
    color: var(--c-accent, #3b82f6);
  }
  .workdir-dropdown-item.add {
    color: var(--c-accent, #3b82f6);
    border-top: 1px solid var(--c-border);
    margin-top: 2px;
    padding-top: 8px;
  }
  .workdir-dropdown-sep {
    height: 1px;
    background: var(--c-border);
    margin: 2px 0;
  }
  .workdir-dropdown-del {
    flex-shrink: 0;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    color: var(--c-text-2, #bbb);
    padding: 2px 5px;
    border-radius: 4px;
    transition: color 0.15s, background-color 0.15s;
  }
  .workdir-dropdown-del:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
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
    padding: 12px 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    user-select: text;
  }
  .msg-area::-webkit-scrollbar { width: 8px; }
  .msg-area::-webkit-scrollbar-track { background: var(--c-bg-deep); }
  .msg-area::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }

  /* 单轮对话容器：高度上限约一屏，内部独立滚动；多轮上下排列。
     结构：<div.msg-round><div.msg-round-header/><div.msg-round-body>…msgs…</div></div>
     运行中的轮默认展开；已结束的轮默认折叠为标题条，点击 header 切换 */
  .msg-round {
    max-height: var(--round-max-h, 100vh);
    overflow-y: auto;
    padding: 0 18px 14px;
    border: 1px solid var(--c-raise-2);
    border-radius: 8px;
    background: var(--c-panel-2, var(--c-panel));
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-right: 28px;
    flex-shrink: 0;
  }
  .msg-round:not(.msg-round-collapsed) { min-height: 200px; }
  .msg-round::-webkit-scrollbar { width: 8px; }
  .msg-round::-webkit-scrollbar-track { background: transparent; }
  .msg-round::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 4px; }
  /* 首轮无外上边距、末轮无外下边距，与 .msg-area 的 padding 形成紧凑视觉 */
  .msg-area > .msg-round:first-child { margin-top: 0; }
  .msg-area > .msg-round:last-child { margin-bottom: 0; }

  /* 轮标题条：折叠后仅显示此条；点击切换展开/折叠 */
  .msg-round-header {
    direction: ltr;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--c-panel-2, var(--c-panel));
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    margin: 0 -18px;
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
  }
  .msg-round-header:hover { background: var(--c-raise); }
  .msg-round-chevron {
    color: var(--c-text-3);
    font-size: 11px;
    flex-shrink: 0;
    transition: transform 0.15s;
  }
  .msg-round:not(.msg-round-collapsed) .msg-round-chevron { transform: rotate(90deg); }
  .msg-round-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 轮内容体：消息的挂载点 */
  .msg-round-body {
    direction: ltr;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }
  .msg-round-collapsed { min-height: 0; }
  .msg-round-collapsed .msg-round-body { display: none; }

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

  /* 悬浮「对话记录导航」按钮（聊天区右侧中部，固定可见） */
  .agent-outline-fab {
    position: absolute;
    top: 50%;
    right: 12px;
    transform: translateY(-50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--c-raise-2);
    border: 1px solid var(--c-border);
    color: var(--c-text);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    z-index: 5;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.15s;
    user-select: none;
  }
  .agent-outline-fab:hover { background: var(--c-accent); color: #fff; border-color: var(--c-accent); }
  .agent-outline-fab.active { background: var(--c-accent); color: #fff; border-color: var(--c-accent); }
  .agent-outline-fab .outline-fab-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--c-accent);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--c-panel);
    pointer-events: none;
  }

  /* 悬浮消息大纲面板（从右侧滑出，紧贴 FAB 左侧） */
  .agent-outline-panel {
    position: absolute;
    top: 16px;
    bottom: 16px;
    right: 56px;
    width: 280px;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: none;
    flex-direction: column;
    overflow: hidden;
    z-index: 6;
    animation: agent-outline-in 0.15s ease-out;
  }
  .agent-outline-panel.show { display: flex; }
  @keyframes agent-outline-in {
    from { opacity: 0; transform: translateX(8px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  .agent-outline-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-shrink: 0;
  }
  .agent-outline-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--c-text-2);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .agent-outline-count {
    font-size: 10px;
    color: var(--c-text-4);
    background: var(--c-raise);
    border-radius: 8px;
    padding: 1px 6px;
  }
  .agent-outline-close {
    background: transparent;
    border: none;
    color: var(--c-text-3);
    font-size: 14px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .agent-outline-close:hover { color: #fff; }

  .agent-outline-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
  }
  .agent-outline-list::-webkit-scrollbar { width: 6px; }
  .agent-outline-list::-webkit-scrollbar-track { background: var(--c-panel); }
  .agent-outline-list::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  /* 单条消息大纲项：左侧角色色条 + 角色图标 + 预览文本 + 时间 */
  .outline-item {
    display: flex;
    align-items: stretch;
    gap: 0;
    padding: 6px 10px 6px 0;
    cursor: pointer;
    border-bottom: 1px solid var(--c-raise-2);
    transition: background 0.12s;
  }
  .outline-item:hover { background: var(--c-raise); }
  .outline-item.active { background: var(--c-raise); }
  .outline-item-bar {
    width: 3px;
    flex-shrink: 0;
    border-radius: 0 2px 2px 0;
    margin-right: 8px;
    background: transparent;
  }
  .outline-item.user .outline-item-bar { background: var(--c-accent); }
  .outline-item.assistant .outline-item-bar { background: #6e7681; }
  .outline-item-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outline-item-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--c-text-4);
  }
  .outline-item-role {
    font-weight: 600;
    color: var(--c-text-3);
  }
  .outline-item.user .outline-item-role { color: var(--c-accent); }
  .outline-item-preview {
    font-size: 12px;
    color: var(--c-text-2);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .outline-item-preview.empty { color: var(--c-text-4); font-style: italic; }

  .agent-outline-empty {
    padding: 20px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--c-text-4);
  }
  .agent-outline-empty-icon {
    font-size: 28px;
    margin-bottom: 6px;
    opacity: 0.6;
  }

  /* 被大纲点击跳转到的消息节点闪烁高亮（短暂反馈，告知定位成功） */
  .msg.flash-highlight {
    animation: agent-flash 1.2s ease-out;
  }
  @keyframes agent-flash {
    0%   { box-shadow: 0 0 0 0 rgba(var(--c-accent-rgb), 0.6); }
    20%  { box-shadow: 0 0 0 4px rgba(var(--c-accent-rgb), 0.45); }
    100% { box-shadow: 0 0 0 0 rgba(var(--c-accent-rgb), 0); }
  }

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

  .msg.warn {
    background: #3d2e1a;
    color: #f0ad4e;
    align-self: center;
    font-size: 13px;
  }

  .msg.info {
    background: #1a2d3d;
    color: #6bb6ff;
    align-self: center;
    font-size: 13px;
  }

  .msg-meta {
    font-size: 11px;
    color: var(--c-text-4);
    margin-top: 4px;
  }

  .msg-fold-badge {
    display: inline-block;
    font-size: 10px;
    color: #f0ad4e;
    border: 1px solid rgba(240,173,78,0.4);
    border-radius: 4px;
    padding: 0 4px;
    margin-left: 6px;
    vertical-align: middle;
    line-height: 1.5;
  }

  /* Markdown 表格：溢出横向滚动，避免撑破气泡 */
  .agent-tbl-wrap {
    overflow-x: auto;
    margin: 8px 0;
    border: 1px solid var(--c-border);
    border-radius: 6px;
  }
  .agent-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: normal;
  }
  .agent-tbl th,
  .agent-tbl td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--c-border-soft);
    text-align: left;
    vertical-align: top;
  }
  .agent-tbl thead th {
    background: var(--c-raise-2);
    font-weight: 600;
    white-space: nowrap;
  }
  .agent-tbl tbody tr:last-child td { border-bottom: none; }
  .agent-tbl tbody tr:hover { background: var(--c-raise); }
  .agent-tbl code {
    background: var(--c-bg-deep);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
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

  /* 底部工具栏: 模型▾ | 上下文用量 | 📎 📤发送 */
  .agent-input-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--c-raise-2);
  }

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

  /* 手动压缩上下文按钮（技能按钮旁）：运行中禁用防止竞态 */
  .toolbar-compact-btn {
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
  .toolbar-compact-btn:hover:not(:disabled) {
    background: rgba(255,255,255,0.15);
    color: var(--c-text);
  }
  .toolbar-compact-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .toolbar-compact-btn.compacting {
    background: rgba(var(--c-accent-rgb), 0.18);
    color: var(--c-accent);
    cursor: progress;
  }
  .compact-icon { font-size: 14px; }
  .compact-text { font-size: 13px; }

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

  /* 技能选择器（与模型选择器同款按钮/下拉，但顶部带刷新+空态/标题） */
  .toolbar-skill-selector { position: relative; }
  .toolbar-skill-btn { gap: 4px; }
  .toolbar-skill-btn.has-skill {
    background: rgba(var(--c-accent-rgb), 0.18);
    color: var(--c-accent);
    border: 1px solid rgba(var(--c-accent-rgb), 0.4);
  }
  .toolbar-skill-icon { font-size: 12px; }

  .skill-dropdown-header {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c-text-3);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    background: var(--c-raise);
  }
  .skill-dropdown-refresh {
    background: transparent;
    border: none;
    color: var(--c-text-3);
    cursor: pointer;
    font-size: 13px;
    padding: 0 4px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .skill-dropdown-refresh:hover { color: var(--c-accent); background: var(--c-raise-2); }
  .skill-dropdown-refresh.loading { animation: agent-spin 0.8s linear infinite; }

  .skill-item {
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-bottom: 1px solid var(--c-raise-2);
  }
  .skill-item:last-child { border-bottom: none; }
  .skill-item:hover { background: var(--c-raise-2); }
  .skill-item.attached { background: rgba(var(--c-accent-rgb), 0.08); }
  .skill-item.attached:hover { background: rgba(var(--c-accent-rgb), 0.14); }

  .skill-item-top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .skill-item-name {
    flex: 1;
    font-weight: 500;
    color: var(--c-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .skill-item-source {
    flex-shrink: 0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--c-overlay);
    color: var(--c-text-3);
  }
  .skill-item-source.global { color: #69db7c; background: rgba(105, 219, 124, 0.1); }
  .skill-item-source.project { color: #b197fc; background: rgba(177, 151, 252, 0.1); }
  .skill-item-desc {
    font-size: 11px;
    color: var(--c-text-3);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .skill-item-status {
    font-size: 11px;
    color: var(--c-accent);
    flex-shrink: 0;
  }
  .skill-dropdown-empty {
    padding: 14px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--c-text-4);
    line-height: 1.6;
  }
  .skill-dropdown-empty-icon {
    font-size: 22px;
    opacity: 0.6;
    margin-bottom: 4px;
  }

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

  .toolbar-stop-btn {
    background: rgba(232,93,58,0.1);
    border: 1px solid rgba(232,93,58,0.45);
    color: #e85d3a;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .toolbar-stop-btn:hover { background: rgba(232,93,58,0.2); color: #fff; }

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
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  .settings-header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--c-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
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
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .settings-body::-webkit-scrollbar { width: 6px; }
  .settings-body::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

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

  /* 项目记忆（跨会话持久记忆，只读展示） */
  .memory-collapse {
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-bg-deep);
    margin-top: 8px;
  }
  .memory-collapse-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    color: var(--c-text-2);
    font-size: 13px;
  }
  .memory-collapse-header:hover { background: var(--c-raise); }
  .memory-collapse-arrow {
    transition: transform 0.15s ease;
    font-size: 10px;
    color: var(--c-text-4);
  }
  .memory-collapse.open .memory-collapse-arrow { transform: rotate(90deg); }
  .memory-count { color: var(--c-text-4); font-size: 12px; }
  .memory-collapse-body {
    display: none;
    padding: 4px 12px 10px;
    max-height: 260px;
    overflow-y: auto;
  }
  .memory-collapse.open .memory-collapse-body { display: block; }
  .memory-empty { color: var(--c-text-4); font-size: 12px; padding: 6px 0; }
  .memory-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 0;
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px dashed var(--c-border);
    color: var(--c-text-2);
  }
  .memory-item:last-child { border-bottom: none; }
  .memory-tag {
    flex-shrink: 0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    margin-top: 1px;
    color: #fff;
  }
  .memory-tag.constraint { background: #e67e22; }
  .memory-tag.decision { background: #3498db; }
  .memory-why { color: var(--c-text-4); }
  .memory-item-text { flex: 1; min-width: 0; word-break: break-word; }
  .memory-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: auto; }
  .memory-action {
    background: transparent;
    border: 1px solid var(--c-border);
    color: var(--c-text-2);
    width: 22px; height: 22px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .memory-action:hover { background: var(--c-raise); color: var(--c-text); }
  .memory-action.del:hover { color: #e74c3c; border-color: #e74c3c; }
  .memory-textarea { resize: vertical; min-height: 56px; font-family: inherit; }

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

  /* 首次进入 Agent 页时的骨架屏（侧栏会话列表 / 工具列表）
     与 conv-item / tool-item 高度对齐，闪烁动画让用户感知到「正在加载」 */
  .skeleton-line {
    height: 12px;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--c-raise) 0%, var(--c-raise-2) 50%, var(--c-raise) 100%);
    background-size: 200% 100%;
    animation: agent-skeleton 1.4s ease-in-out infinite;
  }
  @keyframes agent-skeleton {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  .skeleton-conv-item {
    padding: 10px 12px;
    border-bottom: 1px solid var(--c-raise-2);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .skeleton-conv-item .skeleton-line:first-child { width: 70%; }
  .skeleton-conv-item .skeleton-line:last-child { width: 35%; height: 10px; }
  .skeleton-tool-item {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .skeleton-tool-item .skeleton-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--c-raise-2);
    flex-shrink: 0;
  }
  .skeleton-tool-item .skeleton-line { flex: 1; }

  /* 聊天区首次进入加载态：居中 spinner + 文案，替换原本的「开始一个新的对话」空态 */
  .agent-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 12px;
    color: var(--c-text-3);
    font-size: 13px;
  }
  .agent-loading-spinner {
    display: inline-block;
    width: 28px; height: 28px;
    border: 3px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: agent-spin 0.8s linear infinite;
  }

  /* 初始化进度条：贴在底部状态栏上方，显示当前 init() 阶段。
     默认隐藏（无 .show），由 ui.js showInitProgress / hideInitProgress 切显隐。
     收起时用 height+opacity 平滑过渡，避免跳变。
     注意：padding 放在 .show 里 —— box-sizing: border-box 下 max-height:0 只能
     压到「padding+border」高度，若 padding 常驻则隐藏时仍会漏出可见空隙。 */
  .agent-init-progress {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px;
    background: var(--c-raise);
    border-top: 1px solid var(--c-border-soft);
    font-size: 11px;
    color: var(--c-text-2);
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transition: max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease;
  }
  .agent-init-progress.show {
    max-height: 28px;
    opacity: 1;
    padding: 4px 16px;
  }
  .agent-init-progress-spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--c-border);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: agent-spin 0.8s linear infinite;
    flex-shrink: 0;
  }

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
          <div class="workspace-selector" id="agent-workspace-selector">
            <span class="workspace-label">${_t("工作目录")}</span>
            <span class="workspace-icon">📁</span>
            <span class="workspace-name" id="agent-workspace-name">${_t("默认工作区")}</span>
          </div>
          <button class="new-chat-btn" id="agent-new-chat">＋ ${_t("新建会话")}</button>
        </div>
        <!-- 会话视图切换: ★当前对话 / ●全部对话 -->
        <div class="session-toggle" id="agent-session-toggle">
          <span class="toggle-item active" data-mode="current">★ ${_t("当前对话")}</span>
          <span class="toggle-item" data-mode="all">● ${_t("全部对话")}</span>
        </div>
        <!-- 会话列表 (内部滚动) -->
        <div class="conv-list-section" id="agent-conv-list">
          <!-- 首次进入时的骨架屏（init() 完成由 renderConversationList 清空重绘） -->
          <div class="skeleton-conv-item"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div class="skeleton-conv-item"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div class="skeleton-conv-item"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div class="skeleton-conv-item"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
        </div>
      </div>

      <!-- ② tools-block: Skills/MCP/LSP (固定高度, 内部滚动, tab 切换) -->
      <div class="tools-section" id="agent-tools-section">
        <div class="tools-header">
          <span>${_t("工具")}</span>
          <span class="tools-header-right">
            <span class="tools-count" id="agent-tools-count">0</span>
            <button class="tools-add-btn" id="agent-mcp-add-btn" title="${_t("添加 MCP")}">＋ ${_t("添加 MCP")}</button>
          </span>
        </div>
        <div class="tools-tabs" id="agent-tools-tabs">
          <span class="tools-tab active" data-tab="skill">Skill</span>
          <span class="tools-tab" data-tab="lsp">LSP</span>
          <span class="tools-tab" data-tab="mcp">MCP</span>
        </div>
        <div class="tools-list" id="agent-tools-list">
          <!-- 首次进入时的骨架屏（init() 完成由 renderToolsList 清空重绘） -->
          <div class="skeleton-tool-item"><span class="skeleton-dot"></span><div class="skeleton-line"></div></div>
          <div class="skeleton-tool-item"><span class="skeleton-dot"></span><div class="skeleton-line"></div></div>
          <div class="skeleton-tool-item"><span class="skeleton-dot"></span><div class="skeleton-line"></div></div>
        </div>
      </div>

      <!-- ③ 底部: 设置 (不滚动) -->
      <div class="sidebar-footer">
        <button class="settings-btn-sidebar" id="agent-settings-btn">
          <span>⚙</span>
          <span>${_t("设置")}</span>
        </button>
      </div>
    </div>

    <!-- 右侧对话工作区 -->
    <div class="agent-main">
      <!-- 会话标题栏 (状态 · 操作) -->
      <div class="chat-header">
        <span class="chat-header-status" id="agent-header-status"></span>
        <span class="chat-header-title" id="agent-conv-title">${_t("选择或创建一个会话")}</span>
        <div class="chat-header-actions">
          <button class="icon-btn" id="agent-undo-btn" title="${_t("撤销上一轮对话")}" disabled><span>↶</span><span>${_t("撤销上一轮对话")}</span></button>
        </div>
      </div>

      <!-- 消息列表 (滚动区域) -->
      <div class="msg-area-wrap">
        <div class="msg-area" id="agent-msg-area">
          <!-- 首次进入加载态：init() 完成后由 renderMessages 替换为 empty-state 或实际消息 -->
          <div class="agent-loading">
            <div class="agent-loading-spinner"></div>
            <div class="agent-loading-text">${_t("正在初始化 Agent...")}</div>
          </div>
        </div>
        <!-- 回到底部悬浮圆球 -->
        <button class="scroll-bottom-btn" id="agent-scroll-bottom-btn" title="${_t("滚动到底部")}">↓</button>
        <!-- 悬浮「对话记录导航」按钮：点击展开右侧面板，列出当前会话的所有消息，点击跳转 -->
        <button class="agent-outline-fab" id="agent-outline-fab" title="${_t("对话记录导航")}">📑<span class="outline-fab-badge" id="agent-outline-fab-badge" style="display:none;"></span></button>
        <!-- 悬浮消息大纲面板 -->
        <div class="agent-outline-panel" id="agent-outline-panel">
          <div class="agent-outline-header">
            <span class="agent-outline-title">📑 ${_t("对话记录")}<span class="agent-outline-count" id="agent-outline-count">0</span></span>
            <button class="agent-outline-close" id="agent-outline-close" title="${_t("关闭")}">✕</button>
          </div>
          <div class="agent-outline-list" id="agent-outline-list"></div>
        </div>
      </div>

      <!-- Todo 固定面板（有 todos 时显示，实时反映完成状态） -->
      <div class="todos-panel" id="agent-todos-panel" style="display:none;">
        <div class="todos-panel-header" id="agent-todos-header">
          <span>📋 ${_t("任务清单")}<span class="todos-panel-progress" id="agent-todos-progress"></span></span>
          <span class="todos-panel-toggle">▾</span>
        </div>
        <div class="todos-panel-list" id="agent-todos-list"></div>
      </div>

      <!-- 输入框区域: textarea 在上, 工具栏在下 -->
      <div class="input-area">
        <textarea class="input-textarea" id="agent-input" placeholder="${_t("输入消息... (Enter 发送, Shift+Enter 换行)")}" rows="1"></textarea>
        <!-- 附件预览区 -->
        <div class="attach-preview-area" id="agent-attach-preview"></div>
        <!-- 底部工具栏: 模型▾ | 上下文用量 | 📎 📤发送 -->
        <div class="agent-input-toolbar">
          <!-- ① 模型选择下拉 -->
          <div class="toolbar-model-selector">
            <button class="model-current" id="agent-model-btn">
              <span id="agent-model-name">Local Model</span>
              <span class="dropdown-arrow">▾</span>
            </button>
            <div class="model-dropdown" id="agent-model-dropdown">
            </div>
          </div>
          <!-- ②a 技能选择下拉（只显示用户/项目技能；选中后作为 markdown 附件随下一条消息发送） -->
          <div class="toolbar-skill-selector">
            <button class="model-current toolbar-skill-btn" id="agent-skill-btn" title="${_t("选择技能（仅显示用户与项目技能）；选中后将随下一条消息一起发送")}">
              <span class="toolbar-skill-icon">🧩</span>
              <span id="agent-skill-name">${_t("技能")}</span>
              <span class="dropdown-arrow">▾</span>
            </button>
            <div class="model-dropdown" id="agent-skill-dropdown">
            </div>
          </div>
          <!-- ②a+ 手动压缩上下文：触发服务端生成摘要并替换历史；运行中按钮禁用 -->
          <button class="toolbar-compact-btn" id="agent-compact-btn" title="${_t("手动压缩上下文：将当前会话的历史消息生成摘要以释放上下文窗口")}" disabled>
            <span class="compact-icon">🗜️</span>
            <span class="compact-text">${_t("压缩上下文")}</span>
          </button>
          <!-- ②b 微信消息开关：开 = 微信 Bot 消息进入当前打开的会话；关 = 不接收微信消息 -->
          <button class="toolbar-wx-btn" id="agent-wx-follow-btn" title="${_t("微信消息开关：开启后微信 Bot 消息进入当前打开的会话；关闭后不再接收微信消息")}">
            <span class="wx-icon">💬</span>
            <span class="wx-text">${_t("微信")}</span>
          </button>
          <!-- ③ 上下文用量 -->
          <div class="toolbar-context-usage" id="agent-context-usage">
            <span class="usage-current">0</span>
            <span class="usage-separator">/</span>
            <span class="usage-max">0</span>
          </div>
          <!-- ④ 附件与发送 -->
          <div class="toolbar-actions">
            <button class="toolbar-attach-btn" id="agent-attach-btn" title="${_t("添加附件")}">📎</button>
            <button class="toolbar-stop-btn" id="agent-stop-btn" style="display:none" title="${_t("停止当前会话的运行")}">⏹ ${_t("停止")}</button>
            <button class="toolbar-send-btn" id="agent-send-btn">📤 ${_t("发送")}</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 初始化进度条：init() 期间显示当前阶段文案，结束后收起（由 ui.js 控制） -->
  <div class="agent-init-progress" id="agent-init-progress">
    <span class="agent-init-progress-spinner"></span>
    <span id="agent-init-progress-text">${_t("正在加载...")}</span>
  </div>

  <!-- 底部状态栏: Agent 状态 · 工作区路径 · Token 统计 -->
  <div class="agent-status-bar">
    <span class="status-item" id="agent-status-state">
      <span class="status-state-dot ready"></span>${_t("就绪")}
    </span>
    <span class="status-separator">·</span>
    <span class="status-item" id="agent-status-workdir">${_t("工作区: --")}</span>
    <span class="status-separator">·</span>
    <span class="status-item" id="agent-status-tokens">Token: 0</span>
  </div>
</div>

<!-- 设置弹窗 -->
<div class="settings-overlay" id="agent-settings-overlay">
  <div class="settings-modal">
    <div class="settings-header">
      <span class="settings-title">${_t("Agent 设置")}</span>
      <button class="settings-close" id="agent-settings-close">✕</button>
    </div>
    <div class="settings-body">

      <!-- 基础设置 -->
      <div class="param-group">
        <div class="param-group-title">${_t("基础设置")}</div>
        <div class="param-row">
          <div class="param-label">${_t("调试模式")}</div>
          <div class="param-input">
            <div class="checkbox-wrap">
              <input type="checkbox" id="settings-debug-logging">
              <span>${_t("记录调试日志")}</span>
              <button type="button" class="browse-btn" id="settings-open-log-dir" style="margin-left:auto;">${_t("打开日志目录")}</button>
            </div>
            <div class="param-desc">${_t("开启后在 app 数据目录写入 adm_api_debug.log（记录与 admAgent 的关键 API/事件交互，含你发送的消息正文，供排查对话中断）；关闭或重启软件会自动清空日志")}</div>
          </div>
        </div>
      </div>

      <!-- 模型配置 -->
      <div class="param-group">
        <div class="param-group-title">${_t("模型配置")}</div>
        <div class="param-row">
          <div class="param-label">${_t("推理强度")}</div>
          <div class="param-input">
            <select class="settings-select" id="settings-reasoning-effort">
              <option value="low">low</option>
              <option value="medium" selected>medium</option>
              <option value="high">high</option>
            </select>
          </div>
        </div>
        <div class="param-row">
          <div class="param-label">${_t("采样温度")}</div>
          <div class="param-input">
            <input type="number" class="settings-input" id="settings-temperature" placeholder="${_t("留空使用默认")}" step="0.1" min="0" max="2">
          </div>
        </div>
        <div class="param-row">
          <div class="param-label">${_t("多模态模型")}</div>
          <div class="param-input">
            <select class="settings-select" id="settings-vision-model"></select>
            <div class="param-desc">${_t("用于识别会话中的图片；默认为内置 admImage-model（自动轮询可用图片后端）")}</div>
          </div>
        </div>
      </div>

      <!-- 项目记忆（跨会话持久记忆，只读展示） -->
      <div class="param-group">
        <div class="param-group-title">${_t("项目记忆")}</div>
        <div class="param-desc" style="margin-bottom:6px;">${_t("Agent 跨会话自动沉淀的持久约束与决策（保存在 workspace 的 project_memory.json，可手动新增/修改/删除；下次上下文压缩时会与 Agent 自动沉淀结果合并）")}</div>
        <div class="memory-collapse" id="agent-memory-collapse">
          <div class="memory-collapse-header" id="agent-memory-toggle">
            <span class="memory-collapse-arrow">▶</span>
            <span>${_t("查看项目记忆")}</span>
            <span class="memory-count" id="agent-memory-count"></span>
          </div>
          <div class="memory-collapse-body" id="agent-memory-body"></div>
        </div>
        <button class="btn-add-cloud" id="agent-memory-add-btn" style="margin-top:6px;">+ ${_t("添加记忆")}</button>
      </div>

      <!-- 云端模型管理 -->
      <div class="param-group">
        <div class="param-group-title">${_t("云端模型管理")}</div>
        <div class="provider-list" id="provider-list"></div>
        <button class="btn-add-cloud" id="agent-add-cloud-btn">+ ${_t("添加云端模型")}</button>
      </div>
    </div>
  </div>
</div>

<!-- 模型添加/修改弹窗（标题与提交按钮文案由 settings_dialog.js 按模式切换） -->
<div class="add-model-overlay" id="agent-add-model-overlay">
  <div class="settings-modal" style="width:440px;">
    <div class="settings-header">
      <span class="settings-title" id="add-model-title">${_t("添加云端模型")}</span>
      <button class="settings-close" id="agent-add-model-close">✕</button>
    </div>
    <div class="settings-body">
      <div class="param-row" style="flex-direction:column;gap:6px;">
        <input type="text" class="settings-input" id="add-model-modelid" placeholder="${_t("模型ID (如 Big Pickle)")}">
        <input type="text" class="settings-input" id="add-model-name" placeholder="${_t("模型名称 (可选, 默认使用模型ID)")}">
        <input type="text" class="settings-input" id="add-model-baseurl" placeholder="${_t("API Base URL (如 https://api.example.com/v1)")}">
        <input type="text" class="settings-input" id="add-model-apikey" placeholder="API Key">
        <input type="text" class="settings-input" id="add-model-ctx" placeholder="${_t("上下文大小 (如 256K, 1M)")}">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-text-2);cursor:pointer;user-select:none;">
          <input type="checkbox" id="add-model-images" style="cursor:pointer;"> ${_t("支持图片输入（视觉模型）")}
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-text-2);cursor:pointer;user-select:none;">
          <input type="checkbox" id="add-model-reasoning" style="cursor:pointer;"> ${_t("支持思考模式")}
        </label>
        <div id="add-model-msg" style="font-size:12px;min-height:18px;line-height:18px;"></div>
        <button class="settings-btn settings-btn-primary" id="add-model-submit" style="align-self:flex-start;">${_t("添加")}</button>
      </div>
    </div>
  </div>
</div>

<!-- 项目记忆 添加/修改弹窗（标题/提交文案由 settings_dialog.js 按模式切换） -->
<div class="add-model-overlay" id="agent-memory-overlay">
  <div class="settings-modal" style="width:440px;">
    <div class="settings-header">
      <span class="settings-title" id="memory-dialog-title">${_t("添加记忆")}</span>
      <button class="settings-close" id="agent-memory-dialog-close">✕</button>
    </div>
    <div class="settings-body">
      <div class="param-row" style="flex-direction:column;gap:6px;">
        <div class="param-label" style="margin-bottom:2px;">${_t("类型")}</div>
        <select class="settings-select" id="memory-dialog-kind">
          <option value="constraint">${_t("约束")}</option>
          <option value="decision">${_t("决策")}</option>
        </select>
        <div class="param-label">${_t("内容")}</div>
        <textarea class="settings-input memory-textarea" id="memory-dialog-value" rows="3"></textarea>
        <div class="param-label">${_t("原因/备注 (可选)")}</div>
        <input type="text" class="settings-input" id="memory-dialog-why">
        <div id="memory-dialog-msg" style="font-size:12px;min-height:18px;line-height:18px;"></div>
        <button class="settings-btn settings-btn-primary" id="memory-dialog-submit" style="align-self:flex-start;">${_t("添加")}</button>
      </div>
    </div>
  </div>
</div>

<!-- MCP 添加/修改弹窗（配置写入 admAgent.json 顶层 mcp；保存后需重启 Agent 服务生效） -->
<div class="add-model-overlay" id="agent-mcp-overlay">
  <div class="settings-modal" style="width:480px;">
    <div class="settings-header">
      <span class="settings-title" id="mcp-dialog-title">${_t("添加 MCP")}</span>
      <button class="settings-close" id="agent-mcp-dialog-close">✕</button>
    </div>
    <div class="settings-body">
      <div class="param-row" style="flex-direction:column;gap:6px;">
        <input type="text" class="settings-input" id="mcp-dialog-name" placeholder="${_t("名称（唯一标识，如 filesystem）")}">
        <select class="settings-select" id="mcp-dialog-type">
          <option value="stdio">${_t("stdio（本地进程）")}</option>
          <option value="http">${_t("http（远程服务）")}</option>
          <option value="sse">sse</option>
        </select>
        <div id="mcp-dialog-stdio-fields" style="display:flex;flex-direction:column;gap:6px;">
          <input type="text" class="settings-input" id="mcp-dialog-command" placeholder="${_t("命令（如 npx）")}">
          <textarea class="settings-input memory-textarea" id="mcp-dialog-args" rows="2" placeholder="${_t("参数（每行一个）")}"></textarea>
          <textarea class="settings-input memory-textarea" id="mcp-dialog-env" rows="2" placeholder="${_t("环境变量（每行 KEY=VALUE）")}"></textarea>
        </div>
        <div id="mcp-dialog-net-fields" style="display:none;flex-direction:column;gap:6px;">
          <input type="text" class="settings-input" id="mcp-dialog-url" placeholder="${_t("URL（如 http://localhost:3000/mcp）")}">
          <textarea class="settings-input memory-textarea" id="mcp-dialog-headers" rows="2" placeholder="${_t("请求头（每行 KEY=VALUE）")}"></textarea>
        </div>
        <input type="text" class="settings-input" id="mcp-dialog-timeout" placeholder="${_t("超时秒数（可选，默认 10）")}">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-text-2);cursor:pointer;user-select:none;">
          <input type="checkbox" id="mcp-dialog-disabled" style="cursor:pointer;"> ${_t("禁用此 MCP")}
        </label>
        <div id="mcp-dialog-msg" style="font-size:12px;min-height:18px;line-height:18px;"></div>
        <div style="display:flex;gap:8px;">
          <button class="settings-btn settings-btn-primary" id="mcp-dialog-submit">${_t("添加")}</button>
          <button class="settings-btn settings-btn-secondary" id="mcp-dialog-delete" style="display:none;">${_t("删除")}</button>
        </div>
      </div>
    </div>
  </div>
</div>
`;
