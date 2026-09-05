// 会话管理：列表 / 选择 / 新建 / 消息刷新 / 上下文估算
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { escapeHtml, formatTime } from "./utils.js";
import { showError, showConfirm, showInfo, reportError, exitManualScrollMode, clearErrorNotices, updateContextUsage, updateStatusBar, updateSendButton } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { renderMessages, renderTodos } from "./render.js";
import { resetPermissionState } from "./permission.js";
import { log } from "./log.js";

// 自动创建会话的连续失败计数：workspace 状态异常时（activeWsId 为 null、workspace 未注册），
// store 各 setter 静默失败、currentConvId 恒为 null，loadConversations ↔ newConversation
// 会递归无限创建会话；连续失败超过上限即熔断报错，避免刷爆服务端会话表
var autoCreateStrikes = 0;

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
      if (S.currentConvId) autoCreateStrikes = 0;
    } else {
      // 没有会话则自动创建一个；创建后 currentConvId 仍为 null（store 写入静默失败）
      // 说明 workspace 状态异常，连续 3 次即熔断，防止无限创建会话
      autoCreateStrikes++;
      if (autoCreateStrikes > 3) {
        autoCreateStrikes = 0;
        console.error("[agent] 自动创建会话连续失败，中止循环: workspace 状态异常");
        showError(_t("无法创建会话：工作区状态异常，请尝试切换工作区或重启应用"));
        return;
      }
      await newConversation();
      if (S.currentConvId) autoCreateStrikes = 0;
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

  // 同步刷新侧栏列表；聊天区右侧的消息大纲（outline）由 renderMessages 负责刷新，
  // 避免在切会话时与消息列表对账时机错位（消息未加载完时显示旧数据）。
}

// 渲染聊天区右侧的悬浮「对话记录」大纲面板。
// 列出当前会话 S.messages 中有文本内容的每条消息（带角色色条 + 预览文本 + 时间），
// 点击项定位到对应消息节点并短暂闪烁高亮，方便长对话快速跳转。
// 纯工具调用 / 思考流（无文本 part）的消息直接跳过，避免大纲被噪声淹没。
export function renderMessageOutline() {
  var container = document.getElementById("agent-outline-list");
  if (!container) return;
  container.innerHTML = "";

  // 过滤：必须是带 id 的消息且能从 parts/content 抽到非空文本预览
  var messages = S.messages || [];
  var visible = messages.filter(function(m) {
    return m && m.id !== undefined && m.id !== null && getMessagePreview(m);
  });

  // 同步 header 计数
  var countEl = document.getElementById("agent-outline-count");
  if (countEl) countEl.textContent = String(visible.length);

  if (visible.length === 0) {
    container.innerHTML =
      '<div class="agent-outline-empty">' +
        '<div class="agent-outline-empty-icon">📑</div>' +
        '<div>' + _t("暂无对话记录") + '</div>' +
        '<div style="margin-top:6px;font-size:11px;">' + _t("在左侧开始对话后将自动出现") + '</div>' +
      '</div>';
    updateOutlineFabBadge();
    return;
  }

  visible.forEach(function(msg, idx) {
    var item = document.createElement("div");
    var role = msg.role || "assistant";
    var msgKey = String(msg.id != null ? msg.id : ("idx" + idx));
    item.className = "outline-item " + role;
    item.setAttribute("data-msg-key", msgKey);

    var preview = getMessagePreview(msg);
    var time = formatTime(msg.created_at || msg.updated_at || "");
    var roleLabel = role === "user" ? _t("你") : _t("Agent");
    var roleIcon = role === "user" ? "👤" : "🤖";

    item.innerHTML =
      '<span class="outline-item-bar"></span>' +
      '<div class="outline-item-body">' +
        '<div class="outline-item-meta">' +
          '<span class="outline-item-role">' + roleIcon + ' ' + roleLabel + '</span>' +
          (time ? '<span>· ' + time + '</span>' : '') +
          '<span style="margin-left:auto;color:var(--c-text-4);">#' + (idx + 1) + '</span>' +
        '</div>' +
        '<div class="outline-item-preview">' + escapeHtml(preview) + '</div>' +
      '</div>';

    item.addEventListener("click", function() {
      setOutlinePanelOpen(false);
      scrollToMessage(msgKey, item);
    });

    container.appendChild(item);
  });

  updateOutlineFabBadge();
}

// 从消息中提取前 ~50 字文本预览（按 parts 顺序查找首个 text part，回退 content）
function getMessagePreview(msg) {
  if (Array.isArray(msg.parts)) {
    for (var i = 0; i < msg.parts.length; i++) {
      var p = msg.parts[i];
      if (p && p.type === "text" && p.data && p.data.text) {
        var t = String(p.data.text).replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 60);
      }
    }
  }
  if (msg.content) {
    var c = String(msg.content).replace(/\s+/g, " ").trim();
    if (c) return c.slice(0, 60);
  }
  return "";
}

// 滚动消息区到指定 msgKey 对应消息，并短暂闪烁高亮（用户感知「已跳转」）
function scrollToMessage(msgKey, sourceItem) {
  var area = document.getElementById("agent-msg-area");
  if (!area) return;
  var target = area.querySelector('[data-msgid="' + cssEscape(msgKey) + '"]');
  if (!target) {
    showError(_t("未找到对应消息（可能已被折叠或删除）"));
    return;
  }
  // 退出手动滚动模式 + 跳到底部命令互斥状态，确保后续 scroll 事件判定为程序触发
  S.programmaticScroll = true;
  S.lastProgrammaticScroll = Date.now();
  S.manualScrollMode = false;
  try {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (_) {
    target.scrollIntoView();
  }
  // 闪烁高亮：复用模板内 .msg.flash-highlight 动画
  target.classList.remove("flash-highlight");
  // 强制重排，确保重新触发动画
  /** @type {any} */ (target).offsetWidth;
  target.classList.add("flash-highlight");
  setTimeout(function() { try { target.classList.remove("flash-highlight"); } catch (_) {} }, 1300);
  // 大纲面板里临时高亮当前项
  if (sourceItem) {
    var prev = sourceItem.parentNode && sourceItem.parentNode.querySelector(".outline-item.active");
    if (prev && prev !== sourceItem) prev.classList.remove("active");
    sourceItem.classList.add("active");
  }
  // 调用 ui.js 的同步刷新让悬浮回到底部圆球的显隐与新滚动位置一致
  try {
    // 通过动态 import 避免 session.js 与 ui.js 形成新循环依赖（store.js 已经引用过 utils.js）
    import("./ui.js").then(function(ui) { ui.updateScrollBottomBtn(); }).catch(function() {});
  } catch (_) {}
}

// 简单的 CSS.escape 兼容（旧 WebView 可能没有 CSS.escape）
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    try { return CSS.escape(String(s)); } catch (_) {}
  }
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, function(c) { return "\\" + c; });
}

// 同步 FAB 角标：与面板里展示的大纲项数一致（即只计有文本内容的消息），
// 否则用户看到角标是「总消息数」、打开后却少几条，体感不一致。
function updateOutlineFabBadge() {
  var badge = document.getElementById("agent-outline-fab-badge");
  if (!badge) return;
  var msgs = S.messages || [];
  var total = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m && m.id !== undefined && m.id !== null && getMessagePreview(m)) total++;
  }
  if (total > 0) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

// 切换 / 设置大纲面板的展开状态
export function setOutlinePanelOpen(open) {
  var panel = document.getElementById("agent-outline-panel");
  var fab = document.getElementById("agent-outline-fab");
  if (!panel || !fab) return;
  if (open) {
    panel.classList.add("show");
    fab.classList.add("active");
  } else {
    panel.classList.remove("show");
    fab.classList.remove("active");
  }
}

export function isOutlinePanelOpen() {
  var panel = document.getElementById("agent-outline-panel");
  return !!(panel && panel.classList.contains("show"));
}

export function toggleOutlinePanel() {
  setOutlinePanelOpen(!isOutlinePanelOpen());
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
  log.debug("SESSION", "selectConversation convId=" + (convId || "").slice(0, 8));
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

    // 单独获取消息列表（合并保留折叠插入的 _fold 等待气泡：消息在服务端尚未
    // 创建，直接覆盖会被抹掉；setMessagesKeepPending 按内容去重后合并回来）
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessagesKeepPending(S.serverInfo.workspace_id, msgs, convId);
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

    // 通知手动压缩按钮刷新可用性（消息数 / 当前会话已变化）
    document.dispatchEvent(new CustomEvent("agent-conversation-changed"));
    document.dispatchEvent(new CustomEvent("agent-messages-changed"));

    // 启用操作按钮
    /** @type {HTMLButtonElement} */ (document.getElementById("agent-undo-btn")).disabled = false;
  } catch (e) {
    console.error("[agent] 加载会话失败:", convId, e);
    reportError(e, { prefix: _t("加载会话失败: ") });
    // 会话在服务端已不存在（数据库被清理 / 跨 workspace 残留 ID）时，
    // 立即清理无效 currentConvId 并从本地列表移除，否则后续发送消息
    // 全部报 "failed to get session: sql: no rows in result set"
    var errText = getErrorMessage(e);
    var isGone = errText.indexOf("no rows") !== -1 || errText.indexOf("404") !== -1
      || (e && (e.status === 404 || e.code === 404));
    if (isGone) {
      if (S.currentConvId === convId) {
        store.setCurrentConvId(S.serverInfo.workspace_id, null);
        store.setCurrentConv(S.serverInfo.workspace_id, null);
        store.setMessages(S.serverInfo.workspace_id, []);
        syncWxFollowSession();
      }
      var filtered = S.conversations.filter(function(c) { return c.id !== convId; });
      store.setConversations(S.serverInfo.workspace_id, filtered);
      renderConversationList();
      if (filtered.length > 0) {
        await selectConversation(filtered[0].id);
      } else {
        document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");
        renderMessages();
        renderTodos([]);
        updateSendButton();
      }
    }
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

// 刷新当前会话的消息列表（合并保留本地待落库的临时气泡，见 selectConversation 说明）
export async function refreshMessages() {
  if (!S.currentConvId || !S.serverInfo) return;
  try {
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + S.currentConvId + "/messages");
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessagesKeepPending(S.serverInfo.workspace_id, msgs, S.currentConvId);
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
