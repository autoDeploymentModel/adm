// 权限确认弹窗与 YOLO 同步
import { S } from "./state.js";
import { api } from "./api.js";
import { escapeHtml } from "./utils.js";
import { showError } from "./ui.js";

// ===== 权限确认弹窗 =====
// 同类操作识别 key：工具名 + 操作类型（不含路径/参数，保证"记住"对同工具不同文件也生效）
function permissionKey(data) {
  return (data.tool_name || data.tool || "unknown") + "|" + (data.action || data.operation || "");
}

// 切换/新建会话时重置权限记忆与队列（"允许本次会话"仅对当前会话生效）
export function resetPermissionState() {
  S.permissionAutoAllow = {};
  S.pendingPermissions = [];
  S.currentPermission = null;
  var overlay = document.getElementById("agent-permission-overlay");
  if (overlay) overlay.classList.remove("show");
}

// 自动放行（已记住的同类操作，不弹窗）
function autoGrantPermission(data) {
  api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/grant", {
    permission: data, action: "allow"
  }).catch(function(e) { showError("权限自动放行失败: " + e); });
}

// 将 YOLO 状态实时同步到 admAgent 服务端（POST /permissions/skip），中途切换立即生效。
// 服务端的 yolo 只在创建工作区时传入一次，之后必须靠此接口更新，否则只改本地 config.json 不生效
export async function syncYoloToServer() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/skip", {
      skip: !!S.settings.agent_yolo
    });
  } catch (e) {
    console.warn("[agent] 同步 YOLO 状态到服务端失败:", e);
  }
  // 开启 YOLO 时，把已在等待的权限请求（当前弹窗 + 队列）全部放行并关闭弹窗，
  // 避免切换前已发出的请求继续卡住本轮对话
  if (S.settings.agent_yolo) {
    var waiting = [];
    if (S.currentPermission) { waiting.push(S.currentPermission); S.currentPermission = null; }
    waiting = waiting.concat(S.pendingPermissions);
    S.pendingPermissions = [];
    var overlay = document.getElementById("agent-permission-overlay");
    if (overlay) overlay.classList.remove("show");
    waiting.forEach(autoGrantPermission);
  }
}

export function showPermissionDialog(data) {
  // YOLO 模式下直接放行（兼容切换瞬间服务端 skip 尚未生效、仍发来请求的竞态）
  if (S.settings && S.settings.agent_yolo) { autoGrantPermission(data); return; }
  // 客户端已记住该类操作 → 直接放行，不再弹窗
  if (S.permissionAutoAllow[permissionKey(data)]) { autoGrantPermission(data); return; }
  // 去重：同一请求的重复事件忽略（SSE 重连/重复监听器可能送达多次）
  if (S.currentPermission && S.currentPermission.id && S.currentPermission.id === data.id) return;
  if (S.pendingPermissions.some(function(p) { return p.id && p.id === data.id; })) return;
  // 弹窗已打开 → 排队，避免覆盖当前请求导致前一个请求永远得不到应答
  if (S.currentPermission) { S.pendingPermissions.push(data); return; }
  renderPermissionDialog(data);
}

// 处理队列中的下一个权限请求（命中记忆的自动放行，否则弹窗）
function processNextPermission() {
  while (S.pendingPermissions.length > 0) {
    var next = S.pendingPermissions.shift();
    if (S.permissionAutoAllow[permissionKey(next)]) { autoGrantPermission(next); continue; }
    renderPermissionDialog(next);
    return;
  }
}

function renderPermissionDialog(data) {
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

  S.currentPermission = data;
  var skipEl = /** @type {HTMLInputElement} */ (document.getElementById("agent-permission-skip"));
  if (skipEl) skipEl.checked = false; // 勾选状态不跨弹窗残留
  overlay.classList.add("show");

  // 绑定按钮
  var grantPermission = async function(action) {
    var skip = skipEl ? skipEl.checked : false;
    // "允许本次会话" 或勾选"不再询问" → 客户端记住，同类请求后续自动放行
    if (action !== "deny" && (action === "allow_session" || skip)) {
      S.permissionAutoAllow[permissionKey(data)] = true;
    }
    overlay.classList.remove("show");
    S.currentPermission = null;
    try {
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/grant", {
        permission: data, action: action
      });
    } catch (e) {
      showError("权限处理失败: " + e);
    }
    processNextPermission();
  };

  document.getElementById("agent-permission-allow").onclick = function() { grantPermission("allow"); };
  document.getElementById("agent-permission-allow-session").onclick = function() { grantPermission("allow_session"); };
  document.getElementById("agent-permission-deny").onclick = function() { grantPermission("deny"); };
}
