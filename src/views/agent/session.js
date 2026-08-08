// 会话管理：列表 / 选择 / 新建 / 消息刷新 / 上下文估算
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { escapeHtml, formatTime } from "./utils.js";
import { showError, showConfirm, showInfo, reportError, exitManualScrollMode, clearErrorNotices, updateContextUsage, updateStatusBar, updateSendButton } from "./ui.js";
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
    reportError(lastErr, { prefix: _t("加载会话列表失败: ") });
    renderConversationList();
    return;
  }

  var list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.sessions) ? resp.sessions : null);
  if (list === null) {
    console.error("[agent] 会话列表响应格式异常:", JSON.stringify(resp).substring(0, 200));
    list = [];
  }
  store.setConversations(S.serverInfo.workspace_id, list);
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
    store.setCurrentConvId(S.serverInfo.workspace_id, null);
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
    var emptyText = S.sessionViewMode === "current" ? _t("当前无选中会话") : _t("暂无会话");
    container.innerHTML = '<div style="padding:12px 14px;color:var(--c-text-4);font-size:12px;">' + emptyText + '</div>';
    return;
  }

  list.forEach(function(conv) {
    var item = document.createElement("div");
    var isActive = conv.id === S.currentConvId;
    item.className = "conv-item" + (isActive ? " active" : "");
    var msgCount = conv.message_count || conv.messages || 0;
    var lastTime = conv.updated_at || conv.last_time || "";
    // 运行/排队标识：以本客户端跟踪的 activeRun / queuedRun 为准（更实时），
    // 服务端 is_busy 快照兜底（如微信 Bot 等后台会话的运行）
    var isActiveRun = !!(S.activeRun && S.activeRun.sessionId === conv.id);
    var isQueuedRun = !!(S.queuedRun && S.queuedRun.sessionId === conv.id);
    var isBusy = isActiveRun || isQueuedRun || conv.is_busy || conv.busy || false;

    var starHtml = isActive ? '<span class="conv-item-star">★</span>' : '';
    var busyHtml = isBusy
      ? '<span class="conv-item-busy' + (isQueuedRun ? " queued" : "") + '" title="' + (isQueuedRun ? _t("排队中") : _t("运行中")) + '"></span>'
      : '';

    item.innerHTML =
      '<div class="conv-item-title">' + starHtml + busyHtml +
        '<span style="overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(conv.title || conv.name || _t("新会话")) + "</span>" +
      "</div>" +
      '<div class="conv-item-meta">' +
        '<span>' + msgCount + ' ' + _t(' 条消息') + '</span>' +
        (lastTime ? '<span>' + formatTime(lastTime) + "</span>" : "") +
      "</div>" +
      '<div class="conv-item-actions">' +
        '<button class="conv-action-btn" data-action="rename" title="' + _t("重命名") + '">✎</button>' +
        '<button class="conv-action-btn delete" data-action="delete" title="' + _t("删除") + '">✕</button>' +
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
      var newName = prompt(_t("重命名会话:"), defaultName);
      if (newName && newName !== defaultName) {
        // 服务端 PUT 是整行更新且 session id 取自 body（忽略路径 sid），
        // 必须回传完整会话字段，否则报 sql: no rows / token 统计被清零。
        // 服务端按 Go 字段名解码（大小写不敏感但不做下划线映射），
        // 因此 token 类字段需用驼峰别名传递。
        var body = {
          id: convId,
          title: newName,
          cost: oldConv ? (oldConv.cost || 0) : 0,
          todos: oldConv ? (oldConv.todos || []) : [],
          PromptTokens: oldConv ? (oldConv.prompt_tokens || 0) : 0,
          CompletionTokens: oldConv ? (oldConv.completion_tokens || 0) : 0,
          SummaryMessageID: oldConv ? (oldConv.summary_message_id || "") : ""
        };
        api("PUT", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId, body)
          .then(function() {
            // 更新会话列表与当前会话快照中的标题（列表项与 currentConv 分开维护，都走 Store）
            var renamedList = S.conversations.map(function(c) {
              if (c.id === convId) return Object.assign({}, c, { title: newName, name: newName });
              return c;
            });
            store.setConversations(S.serverInfo.workspace_id, renamedList);
            if (S.currentConvId === convId && S.currentConv) {
              store.setCurrentConv(S.serverInfo.workspace_id, Object.assign({}, S.currentConv, { title: newName }));
            }
            renderConversationList();
            if (S.currentConvId === convId) {
              document.getElementById("agent-conv-title").textContent = newName;
            }
          })
          .catch(function(e) { reportError(e, { prefix: _t("重命名失败: ") }); });
      }
      break;
    case "delete":
      showConfirm(_t("确定删除此会话？"), function() {
        api("DELETE", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId)
          .then(function() {
            if (S.currentConvId === convId) {
              resetPermissionState();
              store.setCurrentConvId(S.serverInfo.workspace_id, null);
              syncWxFollowSession();
              store.setCurrentConv(S.serverInfo.workspace_id, null);
              store.setMessages(S.serverInfo.workspace_id, []);
              renderMessages();
              renderTodos([]);
              document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");
            }
            loadConversations();
          })
          .catch(function(e) { reportError(e, { prefix: _t("删除失败: ") }); });
      });
      break;
  }
}

export async function selectConversation(convId) {
  if (convId !== S.currentConvId) { resetPermissionState(); exitManualScrollMode(); clearErrorNotices(); }
  store.setCurrentConvId(S.serverInfo.workspace_id, convId);
  syncWxFollowSession();
  renderConversationList();
  // 切换后同步按钮语义（运行中→取消 / 排队中→取消排队 / 其它→发送），
  // 并提示用户当前工作区的运行状态，避免误把发送当取消
  updateSendButton();
  var isRunningElsewhere = S.isSending && S.activeRun && S.activeRun.sessionId !== convId;
  var isCurrentQueued = !!(S.queuedRun && S.queuedRun.sessionId === convId);
  if (isCurrentQueued) {
    var stateElQ = document.getElementById("agent-status-state");
    if (stateElQ) {
      stateElQ.innerHTML = '<span class="status-state-dot busy"></span>' + _t('排队中');
    }
    showInfo(_t("当前会话有消息排队中，将在其它会话运行完成后自动执行"));
  } else if (isRunningElsewhere) {
    var runningConv = S.conversations.find(function(c) { return c.id === S.activeRun.sessionId; });
    var runningName = runningConv ? (runningConv.title || runningConv.name || _t("其它会话")) : _t("其它会话");
    updateStatusBar("busy", null, S.contextUsage.used);
    var stateEl = document.getElementById("agent-status-state");
    if (stateEl) {
      stateEl.innerHTML = '<span class="status-state-dot busy"></span>' + escapeHtml(runningName) + " " + _t("运行中");
    }
    showInfo(_t("会话「") + runningName + _t("」正在运行，当前会话可正常发送，消息会排队等待"));
  }

  try {
    // 设置当前会话
    api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/current-session?client_id=" + S.clientId, {
      session_id: convId
    }).catch(function() {});

    // 获取会话信息
    var conv = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId);
    store.setCurrentConv(S.serverInfo.workspace_id, conv);
    document.getElementById("agent-conv-title").textContent = S.currentConv.title || _t("会话");

    // 单独获取消息列表
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessages(S.serverInfo.workspace_id, msgs);
    renderMessages();

    // 更新上下文用量（服务端重启后 context_tokens 不持久化会归 0，回退为本地估算）
    if (S.currentConv.context_tokens) {
      store.setContextUsage(S.serverInfo.workspace_id, S.currentConv.context_tokens, S.contextUsage.max, false);
    } else {
      store.setContextUsage(S.serverInfo.workspace_id, estimateContextTokens(S.messages), S.contextUsage.max, true);
    }
    updateContextUsage();

    // 渲染 Todo 列表
    renderTodos(S.currentConv.todos);

    // 启用操作按钮
    /** @type {HTMLButtonElement} */ (document.getElementById("agent-undo-btn")).disabled = false;
  } catch (e) {
    console.error("[agent] 加载会话失败:", convId, e);
    reportError(e, { prefix: _t("加载会话失败: ") });
  }
}

export async function newConversation() {
  console.log("[agent] 创建新会话");
  if (!S.serverInfo) return;
  try {
    // POST /v1/workspaces/{id}/sessions → 返回 Session 对象
    const resp = await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions", {
      title: _t("新会话 ") + new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    });
    // 检查响应是否有效（避免无限递归）
    if (!resp || !resp.id) {
      showError(_t("创建会话失败: 服务端返回无效响应"));
      return;
    }
    resetPermissionState();
    exitManualScrollMode();
    clearErrorNotices();
    store.setCurrentConvId(S.serverInfo.workspace_id, resp.id);
    syncWxFollowSession();
    store.setMessages(S.serverInfo.workspace_id, []);
    store.setCurrentConv(S.serverInfo.workspace_id, resp);
    store.setContextUsage(S.serverInfo.workspace_id, 0, S.contextUsage.max, false);
    await loadConversations();
    renderMessages();
    renderTodos([]);
    document.getElementById("agent-conv-title").textContent = resp.title || _t("新会话");
    updateContextUsage();

    // 启用操作按钮
    /** @type {HTMLButtonElement} */ (document.getElementById("agent-undo-btn")).disabled = false;
  } catch (e) {
    reportError(e, { prefix: _t("创建会话失败: ") });
  }
}

// 刷新当前会话的消息列表
export async function refreshMessages() {
  if (!S.currentConvId || !S.serverInfo) return;
  try {
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + S.currentConvId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessages(S.serverInfo.workspace_id, msgs);
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
