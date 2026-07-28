// 工作区切换 / 选择器 / 自动压缩配置
import { S } from "./state.js";
import { api } from "./api.js";
import { updateContextUsage, exitManualScrollMode, clearErrorNotices } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations } from "./session.js";
import { loadTools } from "./tools.js";
import { setupSSEListener } from "./sse.js";
import { resetPermissionState, syncYoloToServer } from "./permission.js";

// ===== 会话上下文压缩 =====
// 全局默认开启自动压缩（Compact 模式）：上下文接近上限时服务端自动生成摘要压缩，
// 无需用户手动干预（scope=0 全局配置，幂等，每次初始化确保开启，不提供设置开关）
export async function enableAutoCompact() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/compact", {
      scope: 0,
      enabled: true
    });
    console.log("[agent] 自动压缩（Compact 模式）已开启");
  } catch (e) {
    console.warn("[agent] 开启自动压缩失败:", e);
  }
}

// ===== 工作区切换 =====
export async function switchToWorkspace(wsId, wsPath) {
  if (!wsId) return;
  console.log("[agent] 切换到工作区:", wsId, wsPath);
  S.serverInfo.workspace_id = wsId;
  S.workspaceInfo = { id: wsId, path: wsPath || "", name: wsPath ? wsPath.split(/[\\/]/).pop() : "默认工作区" };

  // 重新初始化 Agent
  try { await api("POST", "/v1/workspaces/" + wsId + "/agent/init"); } catch (_) {}
  // 同步 YOLO 状态到新工作区（各工作区的 skip 状态独立，保留的可能是旧值）
  await syncYoloToServer();
  // 确保新工作区也开启自动压缩（全局配置，幂等调用仅作兑底）
  await enableAutoCompact();
  // 刷新 agentInfo
  try {
    S.agentInfo = await api("GET", "/v1/workspaces/" + wsId + "/agent");
    if (S.agentInfo && S.agentInfo.model && S.agentInfo.model.context_window) {
      S.contextUsage.max = S.agentInfo.model.context_window;
    }
  } catch (_) {}
  // 重新订阅 SSE 事件到新工作区
  await setupSSEListener();
  // 清理旧 workspace 状态（必须在 loadConversations 之前，避免被覆盖）
  resetPermissionState();
  exitManualScrollMode();
  clearErrorNotices();
  S.messages = [];
  S.currentConvId = null;
  S.currentConv = null;
  renderMessages();
  renderTodos([]);
  document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
  // 刷新对话列表（会自动选中第一个会话或创建新会话）
  await loadConversations();
  // 刷新工具列表（Skill/LSP/MCP 按工作区隔离）
  await loadTools();
  updateContextUsage();
  updateWorkspaceSelector();
}

// ===== 工作区选择器 =====
export function updateWorkspaceSelector() {
  var nameEl = document.getElementById("agent-workspace-name");
  var dropdown = document.getElementById("agent-workspace-dropdown");
  if (!nameEl || !dropdown) return;

  nameEl.textContent = S.workspaceInfo ? S.workspaceInfo.name || "默认工作区" : "默认工作区";
  nameEl.title = S.workspaceInfo ? S.workspaceInfo.path || "" : "";

  // 异步获取所有工作区并填充下拉
  api("GET", "/v1/workspaces").then(function(workspaces) {
    if (!Array.isArray(workspaces) || workspaces.length < 2) {
      dropdown.innerHTML = "";
      return;
    }
    var html = "";
    for (var i = 0; i < workspaces.length; i++) {
      var w = workspaces[i];
      var active = w.id === (S.serverInfo ? S.serverInfo.workspace_id : null) ? ' class="workspace-dropdown-item active"' : ' class="workspace-dropdown-item"';
      var name = w.path ? w.path.split(/[\\/]/).pop() : "工作区 " + (i + 1);
      var path = w.path || "";
      html += '<div' + active + ' data-wsid="' + w.id + '" data-wspath="' + path.replace(/"/g, "&quot;") + '">' +
        '<span>' + name + '</span>' +
        (path ? '<span class="workspace-dropdown-item-path">' + path + '</span>' : '') +
        '</div>';
    }
    dropdown.innerHTML = html;
  }).catch(function() {});
}
