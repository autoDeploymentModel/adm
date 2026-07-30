// 会话管理：列表 / 选择 / 新建 / 消息刷新 / 上下文估算
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, formatTime } from "./utils.js";
import { showError, showConfirm, exitManualScrollMode, clearErrorNotices, updateContextUsage } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { resetPermissionState } from "./permission.js";

// 同步当前会话 ID 给微信 Bridge（跟随模式下微信消息以此为目标会话）；fire-and-forget
export function syncWxFollowSession() {
  try {
    invoke("set_ilink_current_session", { sessionId: S.currentConvId || "" }).catch(function() {});
  } catch (_) {}
}

// ===== 会话管理 =====
export async function loadConversations(restoreCurrent) {
  console.log("[agent] 加载会话列表, workspace:", S.serverInfo ? S.serverInfo.workspace_id : "无");
  if (!S.serverInfo || !S.serverInfo.workspace_id) {
    console.error("[agent] 加载会话列表中止: serverInfo/workspace_id 缺失");
    return;
  }

  // GET /v1/workspaces/{id}/sessions → 返回 Session[] (直接数组)
  // 瞬时失败（如重新挂载时服务端正忙）重试 2 次；失败时保留旧列表不清空，并明确报错
  var resp = null, lastErr = null;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions");
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.error("[agent] 加载会话列表失败(第" + attempt + "次):", e);
      if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); });
    }
  }
  if (lastErr !== null) {
    showError("加载会话列表失败: " + lastErr);
    renderConversationList();
    return;
  }

  var list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.sessions) ? resp.sessions : null);
  if (list === null) {
    console.error("[agent] 会话列表响应格式异常:", JSON.stringify(resp).substring(0, 200));
    list = [];
  }
  S.conversations = list;
  renderConversationList();
  console.log("[agent] 会话列表加载完成，共", S.conversations.length, "个, currentConvId:", S.currentConvId, "restore:", !!restoreCurrent);

  // restoreCurrent：重新挂载后 currentConvId 是上次残留的模块级状态，DOM 已被重置，
  // 必须重新 selectConversation 才能渲染聊天区；若该会话已被删除则清空回退到默认逻辑
  if (restoreCurrent && S.currentConvId) {
    var stillExists = S.conversations.some(function(c) { return c.id === S.currentConvId; });
    if (stillExists) {
      await selectConversation(S.currentConvId);
      return;
    }
    console.warn("[agent] 残留的 currentConvId 已不存在，回退默认选择:", S.currentConvId);
    S.currentConvId = null;
  }

  // 自动选中或创建会话：确保 currentConvId 始终有效，否则发送按钮无反应
  if (!S.currentConvId) {
    if (S.conversations.length > 0) {
      // 选中第一个会话
      await selectConversation(S.conversations[0].id);
    } else {
      // 没有会话则自动创建一个
      await newConversation();
    }
  }
}

export function renderConversationList() {
  const container = document.getElementById("agent-conv-list");
  if (!container) return;
  container.innerHTML = "";

  // 根据视图模式过滤
  var list = S.conversations;
  if (S.sessionViewMode === "current" && S.currentConvId) {
    list = S.conversations.filter(function(c) { return c.id === S.currentConvId; });
  }

  if (list.length === 0) {
    var emptyText = S.sessionViewMode === "current" ? "当前无选中会话" : "暂无会话";
    container.innerHTML = '<div style="padding:12px 14px;color:#6e7681;font-size:12px;">' + emptyText + '</div>';
    return;
  }

  list.forEach(function(conv) {
    var item = document.createElement("div");
    var isActive = conv.id === S.currentConvId;
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

    container.appendChild(item);
  });
}

function handleConvAction(action, convId) {
  switch (action) {
    case "rename":
      var oldConv = S.conversations.find(function(c) { return c.id === convId; });
      var defaultName = oldConv ? (oldConv.title || oldConv.name || "") : "";
      var newName = prompt("重命名会话:", defaultName);
      if (newName && newName !== defaultName) {
        api("PUT", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId, { title: newName })
          .then(function() {
            if (oldConv) { oldConv.title = newName; oldConv.name = newName; }
            if (S.currentConvId === convId && S.currentConv) { S.currentConv.title = newName; }
            renderConversationList();
            if (S.currentConvId === convId) {
              document.getElementById("agent-conv-title").textContent = newName;
            }
          })
          .catch(function(e) { showError("重命名失败: " + e); });
      }
      break;
    case "delete":
      showConfirm("确定删除此会话？", function() {
        api("DELETE", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId)
          .then(function() {
            if (S.currentConvId === convId) {
              resetPermissionState();
              S.currentConvId = null;
              syncWxFollowSession();
              S.currentConv = null;
              S.messages = [];
              renderMessages();
              renderTodos([]);
              document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
            }
            loadConversations();
          })
          .catch(function(e) { showError("删除失败: " + e); });
      });
      break;
  }
}

export async function selectConversation(convId) {
  if (convId !== S.currentConvId) { resetPermissionState(); exitManualScrollMode(); clearErrorNotices(); }
  S.currentConvId = convId;
  syncWxFollowSession();
  renderConversationList();

  try {
    // 设置当前会话
    api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/current-session?client_id=" + S.clientId, {
      session_id: convId
    }).catch(function() {});

    // 获取会话信息
    S.currentConv = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId);
    document.getElementById("agent-conv-title").textContent = S.currentConv.title || "会话";

    // 单独获取消息列表
    S.messages = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId + "/messages");
    if (!Array.isArray(S.messages)) S.messages = S.messages.messages || [];
    renderMessages();

    // 更新上下文用量（服务端重启后 context_tokens 不持久化会归 0，回退为本地估算）
    if (S.currentConv.context_tokens) {
      S.contextUsage.used = S.currentConv.context_tokens;
      S.contextUsage.estimated = false;
    } else {
      S.contextUsage.used = estimateContextTokens(S.messages);
      S.contextUsage.estimated = true;
    }
    updateContextUsage();

    // 渲染 Todo 列表
    renderTodos(S.currentConv.todos);

    // 启用操作按钮
    /** @type {HTMLButtonElement} */ (document.getElementById("agent-undo-btn")).disabled = false;
  } catch (e) {
    console.error("[agent] 加载会话失败:", convId, e);
    showError("加载会话失败: " + e);
  }
}

export async function newConversation() {
  console.log("[agent] 创建新会话");
  if (!S.serverInfo) return;
  try {
    // POST /v1/workspaces/{id}/sessions → 返回 Session 对象
    const resp = await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions", {
      title: "新会话 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    });
    // 检查响应是否有效（避免无限递归）
    if (!resp || !resp.id) {
      showError("创建会话失败: 服务端返回无效响应");
      return;
    }
    resetPermissionState();
    exitManualScrollMode();
    clearErrorNotices();
    S.currentConvId = resp.id;
    syncWxFollowSession();
    S.messages = [];
    S.currentConv = resp;
    S.contextUsage.used = 0;
    S.contextUsage.estimated = false;
    await loadConversations();
    renderMessages();
    renderTodos([]);
    document.getElementById("agent-conv-title").textContent = resp.title || "新会话";
    updateContextUsage();

    // 启用操作按钮
    /** @type {HTMLButtonElement} */ (document.getElementById("agent-undo-btn")).disabled = false;
  } catch (e) {
    showError("创建会话失败: " + e);
  }
}

// 刷新当前会话的消息列表
export async function refreshMessages() {
  if (!S.currentConvId || !S.serverInfo) return;
  try {
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + S.currentConvId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    S.messages = msgs;
    renderMessages();
  } catch (_) {}
}

// 本地估算历史消息占用的上下文 token 数。
// 服务端的 context_tokens 仅存内存，重启后加载历史会话会返回 0，此时用字符数估算：
// CJK 字符 ≈ 1 token/字，其他字符 ≈ 4 字符/token，另加每条消息固定开销。
function estimateContextTokens(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return 0;

  // 已压缩会话：只统计摘要消息（含）之后的消息
  var start = 0;
  if (S.currentConv && S.currentConv.summary_message_id) {
    var idx = msgs.findIndex(function(m) { return m.id === S.currentConv.summary_message_id; });
    if (idx >= 0) start = idx;
  }

  var cjkRe = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
  function countText(text) {
    if (!text) return 0;
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      if (cjkRe.test(text[i])) cjk++; else other++;
    }
    return cjk + Math.ceil(other / 4);
  }

  var total = 0;
  for (var m = start; m < msgs.length; m++) {
    var msg = msgs[m];
    total += 4; // 每条消息的角色/分隔符开销
    if (msg.content) total += countText(msg.content);
    if (!msg.parts || !Array.isArray(msg.parts)) continue;
    msg.parts.forEach(function(p) {
      if (!p || !p.data) return;
      switch (p.type) {
        case "text": total += countText(p.data.text); break;
        case "tool_call": total += countText(p.data.name) + countText(p.data.input); break;
        case "tool_result": total += countText(p.data.content); break;
        case "shell_command": total += countText(p.data.command) + countText(p.data.output); break;
        // reasoning 一般不回传上下文，finish/image/binary 忽略
      }
    });
  }
  return total;
}
