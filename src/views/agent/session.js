// 会话管理：列表 / 选择 / 新建 / 消息刷新 / 上下文估算
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { escapeHtml, formatTime } from "./utils.js";
import { showError, showConfirm, showInfo, reportError, exitManualScrollMode, clearErrorNotices, updateContextUsage, updateStatusBar, updateSendButton, clearSendSafetyTimer } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { renderMessages, renderTodos, roundOutlineEntries } from "./render.js";
import { resetPermissionState } from "./permission.js";
import { log } from "./log.js";
import { updateDecisionModeUI, clearDecisionMode, clearDecisionModes } from "./decision_mode.js";

// 一键清除是否进行中：期间禁用「清除全部」按钮，防重复点击后对已删会话再次 DELETE
var clearAllInFlight = false;

// 已至少完成过一次列表加载的工作区集合。切换工作目录后、列表请求返回前（含工作区
// 初始化阶段，此时还没发出 /sessions 请求），列表区显示「加载中...」，不再误报
// 「暂无会话」；请求结束（成功或最终失败）后置位，空列表才显示「暂无会话」。
var convListLoadedOnce = new Set();

function hasConvListLoaded(wsId) {
  return !!wsId && convListLoadedOnce.has(wsId);
}

// 会话列表分页大小：首次只拉一页，滚动到底部时增量加载，避免多会话工作区下
// 全量拉取 + 全量渲染越来越慢。
// 消息列表不再分页：打开/切换会话一次拉全量历史，聊天区按轮列出全部轮标题
// （每轮默认折叠，只建标题条、不建消息 DOM，整表加载的渲染代价可控）。旧实现
// 只拉最近一页 + 顶部「加载更早的消息」补拉，用户看到的是残缺的轮清单。
var CONV_PAGE_SIZE = 100;
// 会话列表「加载更多」在飞标记
var loadMoreConvsInFlight = false;

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
  var wsId = S.serverInfo.workspace_id;
  // 列表为空时先切到「加载中...」占位（切换工作目录后列表尚未返回的空白期）
  if ((S.conversations || []).length === 0) renderConversationList();

  // GET /v1/workspaces/{id}/sessions?limit=N → 返回 Session[] (直接数组，取最近一页)
  // 瞬时失败（如重新挂载时服务端正忙）重试 2 次；失败时保留旧列表不清空，并明确报错
  var resp = null, lastErr = null;
  try {
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        resp = await api("GET", "/v1/workspaces/" + wsId + "/sessions?limit=" + CONV_PAGE_SIZE);
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
      return;
    }

    var list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.sessions) ? resp.sessions : null);
    if (list === null) {
      console.error("[agent] 会话列表响应格式异常:", JSON.stringify(resp).substring(0, 200));
      list = [];
    }
    // 返回数 < 页大小 → 已到底；恰好等于页大小时可能还有更多，滚动到底再补拉
    store.setConversationsPage(wsId, list, list.length < CONV_PAGE_SIZE);
  } finally {
    // 无论成功还是最终失败都算「加载过」：之后再刷新空列表直接显示「暂无会话」，
    // 不会永远停在「加载中...」
    convListLoadedOnce.add(wsId);
    renderConversationList();
  }
  console.log("[agent] 会话列表加载完成，共", S.conversations.length, "个, currentConvId:", S.currentConvId, "restore:", !!restoreCurrent);

  // restoreCurrent：重新挂载后 currentConvId 是上次残留的模块级状态，DOM 已被重置，
  // 必须重新 selectConversation 才能渲染聊天区。列表只加载了首页，不能在本地
  // 列表上判存在性（排在第一页之外的会话会被误判为已删除）——直接选中即可，
  // 会话真被删除时 selectConversation 的 404 分支会清理
  if (restoreCurrent && S.currentConvId) {
    await selectConversation(S.currentConvId);
    return;
  }

  // 默认打开「上次会话」：列表按 updated_at DESC 排序，首项即最近会话。聊天区显示
  // 该会话的聊天记录（每轮默认折叠，只显示轮标题，点击标题再展开正文），列表里的
  // 全部会话标题照常展示，点击其它标题切换到对应会话内容。
  // 列表为空时不自动新建空会话（旧实现会自动建「新会话」，切换工作目录后凭空多出
  // 一条空对话）；发送时若仍没有当前会话，send.js 会自动新建。
  if (!S.currentConvId && S.conversations.length > 0) {
    await selectConversation(S.conversations[0].id);
  }
}

// 会话列表分页：滚动到底部 / 点击哨兵时补拉下一页（updated_at DESC 偏移分页，
// 新建会话插到顶部会使偏移漂移，appendConversations 按 id 去重兜底）
export async function loadMoreConversations() {
  if (loadMoreConvsInFlight || !S.serverInfo || !S.serverInfo.workspace_id) return;
  if (S.convsComplete || (S.conversations || []).length === 0) return;
  loadMoreConvsInFlight = true;
  // 补拉期间哨兵文案切换为「加载中...」（不整表重绘，避免列表滚动位置被重置）
  var sentinel = document.getElementById("agent-conv-load-more");
  var sentinelText = sentinel ? sentinel.textContent : "";
  if (sentinel) sentinel.textContent = _t("加载中...");
  try {
    var resp = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions?limit=" + CONV_PAGE_SIZE + "&offset=" + S.conversations.length);
    var list = Array.isArray(resp) ? resp : [];
    store.appendConversations(S.serverInfo.workspace_id, list, list.length < CONV_PAGE_SIZE);
    renderConversationList();
  } catch (e) {
    console.error("[agent] 加载更多会话失败:", e);
    if (sentinel && sentinel.parentNode) sentinel.textContent = sentinelText || _t("加载更多会话…");
  } finally {
    loadMoreConvsInFlight = false;
  }
}

// 定向刷新单条会话元数据（run_complete 收尾用）：只 GET 该会话并就地更新
// 列表项 + 当前会话快照，替代整表重拉，避免长列表下每轮收尾全量拉取
export async function refreshConversationMeta(convId) {
  if (!convId || !S.serverInfo || !S.serverInfo.workspace_id) return;
  var wsId = S.serverInfo.workspace_id;
  try {
    var conv = await api("GET", "/v1/workspaces/" + wsId + "/sessions/" + convId);
    var wsState = store.workspaces.get(wsId);
    if (!wsState) return;
    var idx = wsState.conversations.findIndex(function(c) { return c.id === convId; });
    var newList = wsState.conversations.slice();
    if (idx === -1) {
      // 不在已加载列表（后台会话 / 超出首页）：刚更新过，插到顶部
      newList.unshift(conv);
    } else {
      newList[idx] = Object.assign({}, newList[idx], conv);
      // updated_at 变化后按更新时间重排（刚完成的会话浮到顶部，与服务端排序一致）
      newList.sort(function(a, b) { return (b.updated_at || 0) - (a.updated_at || 0); });
    }
    store.setConversations(wsId, newList);
    if (wsState.currentConvId === convId) store.setCurrentConv(wsId, conv);
    if (wsId === S.activeWsId) renderConversationList();
  } catch (_) {}
}

// 消息分页已移除：消息一次全量加载，默认只渲染每轮标题（折叠态），
// 展开某轮时才渲染该轮正文（见 render.js 的轮渲染逻辑）。

export function renderConversationList() {
  const container = document.getElementById("agent-conv-list");
  if (!container) return;
  ensureConvListDelegation(container);

  // 单一「对话记录」列表：始终展示全部会话（当前会话以 ★ + 高亮标识）
  var list = S.conversations;

  // 无会话 / 正在清除时禁用「清除全部」，避免空点与重复点击
  var clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById("agent-conv-clear-all"));
  if (clearBtn) clearBtn.disabled = clearAllInFlight || list.length === 0;

  if (list.length === 0) {
    // 切换工作目录后列表请求尚未返回（或工作区初始化中）：显示加载态，
    // 不能报「暂无会话」——此时列表内容还不确定
    var listWsId = S.serverInfo ? S.serverInfo.workspace_id : "";
    if (listWsId && !hasConvListLoaded(listWsId)) {
      container.innerHTML = '<div class="conv-list-loading"><span class="conv-list-spinner"></span>' + _t("加载中...") + '</div>';
    } else {
      container.innerHTML = '<div style="padding:12px 14px;color:var(--c-text-4);font-size:12px;">' + _t("暂无会话") + '</div>';
    }
    return;
  }

  // 批量构建后一次性挂载（Fragment），避免逐条 append 触发多次布局
  var frag = document.createDocumentFragment();
  list.forEach(function(conv) {
    var item = document.createElement("div");
    var isActive = conv.id === S.currentConvId;
    item.className = "conv-item" + (isActive ? " active" : "");
    if (conv.id != null) item.setAttribute("data-conv-id", String(conv.id));
    var msgCount = conv.message_count || conv.messages || 0;
    var lastTime = conv.updated_at || conv.last_time || "";
    // 运行/排队标识：以本工作区的运行登记为准（更实时，支持多会话并行），
    // 服务端 is_busy 快照兜底（如微信 Bot 等后台会话的运行）
    var activeRunInfo = (S.runs || []).find(function(r) { return r.sessionId === conv.id && !r.queued; });
    var queuedRunInfo = !activeRunInfo && (S.runs || []).find(function(r) { return r.sessionId === conv.id && r.queued; });
    var isActiveRun = !!activeRunInfo;
    var isQueuedRun = !!queuedRunInfo;
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

    frag.appendChild(item);
  });
  // 分页未到底时在列表尾部挂「加载更多」哨兵（点击 / 滚动到底自动触发）
  if (!S.convsComplete) {
    var more = document.createElement("div");
    more.className = "conv-load-more";
    more.id = "agent-conv-load-more";
    more.textContent = _t("加载更多会话…");
    frag.appendChild(more);
  }
  container.innerHTML = "";
  container.appendChild(frag);

  // 同步刷新侧栏列表；聊天区右侧的消息大纲（outline）由 renderMessages 负责调度刷新，
  // 避免在切会话时与消息列表对账时机错位（消息未加载完时显示旧数据）。
}

// 会话列表事件委托：列表项随渲染整体重建，click 委托在容器上只挂一次
// （重新挂载后 DOM 换新会自动重挂）。动作按钮命中时阻止冒泡，避免误触选中会话。
function ensureConvListDelegation(container) {
  var cref = /** @type {any} */ (container);
  if (cref._admConvDelegated) return;
  cref._admConvDelegated = true;
  container.addEventListener("click", function(e) {
    var target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // 「加载更多」哨兵：点击补拉下一页
    if (target.id === "agent-conv-load-more" || (target.closest && target.closest("#agent-conv-load-more"))) {
      loadMoreConversations();
      return;
    }
    var btn = target.closest(".conv-action-btn");
    if (btn) {
      e.stopPropagation();
      var actItem = btn.closest(".conv-item");
      var action = btn.getAttribute("data-action") || "";
      var actionConvId = actItem ? actItem.getAttribute("data-conv-id") : null;
      if (actionConvId) handleConvAction(action, actionConvId);
      return;
    }
    var item = target.closest(".conv-item");
    if (item) {
      var convId = item.getAttribute("data-conv-id");
      if (convId) selectConversation(convId);
    }
  });
  // 滚动接近底部时自动补拉下一页（与点击哨兵共用在飞标记，不会重复请求）
  container.addEventListener("scroll", function() {
    if (S.convsComplete) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 60) loadMoreConversations();
  });
}

// ===== 一键清除所有对话（当前工作区） =====
// 服务端无批量删除接口，逐个 DELETE（服务端会先取消该会话内正在运行的 run）；
// 删除期间用户可能切换工作区/会话，因此状态池按启动时的 wsId 更新，DOM 仅在
// 仍处于该工作区时更新，避免误清新工作区的界面。
export function clearAllConversations() {
  if (clearAllInFlight || !S.serverInfo || !S.serverInfo.workspace_id) return;
  var wsId = S.serverInfo.workspace_id;
  if ((S.conversations || []).length === 0 && S.convsComplete) {
    showInfo(_t("当前没有可清除的对话"));
    return;
  }
  showConfirm(_t("确定清除全部对话？删除后不可恢复"), function() {
    doClearAllConversations(wsId);
  });
}

async function doClearAllConversations(wsId) {
  log.debug("SESSION", "clearAllConversations ws=" + wsId.slice(0, 8));
  clearAllInFlight = true;
  renderConversationList();
  var wsState = store.workspaces.get(wsId);
  if (!wsState) { clearAllInFlight = false; return; }
  // 分页加载下本地列表可能只是前几页：先逐页补拉到底，拿到完整 id 清单再删
  if (!wsState.convsComplete) {
    try {
      var complete = false;
      while (!complete) {
        var offset = wsState.conversations.length;
        var page = await api("GET", "/v1/workspaces/" + wsId + "/sessions?limit=" + CONV_PAGE_SIZE + "&offset=" + offset);
        if (!Array.isArray(page)) page = [];
        var prevLen = wsState.conversations.length;
        if (page.length > 0) store.appendConversations(wsId, page, page.length < CONV_PAGE_SIZE);
        // 本页无新增（旧版服务端忽略 limit/offset，或并发增删导致分页漂移）：
        // 无法继续前进，按已加载清单收尾，避免同一请求无限重发
        complete = page.length < CONV_PAGE_SIZE || wsState.conversations.length === prevLen;
      }
    } catch (e) {
      console.error("[agent] 补拉会话列表失败，按已加载清单清除:", e);
    }
  }
  var ids = (wsState.conversations || [])
    .map(function(c) { return c.id; })
    .filter(function(id) { return id !== undefined && id !== null && id !== ""; });
  if (ids.length === 0) {
    clearAllInFlight = false;
    showInfo(_t("当前没有可清除的对话"));
    return;
  }
  var deleted = {};
  var failed = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await api("DELETE", "/v1/workspaces/" + wsId + "/sessions/" + ids[i]);
      deleted[ids[i]] = true;
    } catch (e) {
      failed++;
      console.error("[agent] 清除会话失败:", ids[i], e);
    }
  }
  clearAllInFlight = false;
  clearDecisionModes(wsId, Object.keys(deleted));

  // 本地状态收尾：列表按实际删除结果过滤；被删的当前会话清空消息；被删会话内
  // 的 run 服务端已取消，本地同步解除发送态（否则界面一直显示运行中）
  var wsState = store.workspaces.get(wsId);
  var runCleared = false;
  if (wsState) {
    store.setConversations(wsId, wsState.conversations.filter(function(c) { return !deleted[c.id]; }));
    if (wsState.currentConvId && deleted[wsState.currentConvId]) {
      store.setCurrentConvId(wsId, null);
      updateDecisionModeUI();
      store.setCurrentConv(wsId, null);
      store.setMessages(wsId, []);
    }
    // 被删会话内的 run 服务端已取消，本地按会话注销其登记（其它并行会话不受影响）
    var deletedIds = Object.keys(deleted);
    runCleared = deletedIds.some(function(id) { return store.hasRun(wsId, id) || store.isQueued(wsId, id); });
    if (runCleared) {
      deletedIds.forEach(function(id) { store.cancelRun(wsId, id); });
      // 安全计时器只服务当前激活工作区的运行，清空其它工作区时不得误清
      if (wsId === S.activeWsId && !S.isSending) clearSendSafetyTimer();
    }
  }

  // 仅当仍停留在该工作区时更新界面
  if (S.serverInfo && S.serverInfo.workspace_id === wsId) {
    renderConversationList();
    // 本工作区已无运行在飞才切回就绪（同工作区其它会话可能仍在并行运行）
    if (runCleared && !S.isSending) updateStatusBar("ready", null, S.contextUsage.used);
    if (!S.currentConvId) {
      resetPermissionState();
      syncWxFollowSession();
      clearErrorNotices();
      store.setContextUsage(wsId, 0, S.contextUsage.max, false);
      document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");
      renderMessages();
      renderTodos([]);
      updateContextUsage();
      updateSendButton();
    }
  }

  if (failed > 0) {
    showError(_t("部分对话清除失败（") + failed + _t(" 个），请重试"));
    loadConversations();
    return;
  }
  showInfo(_t("已清除全部对话"));
}

// ===== 右侧「对话记录」大纲面板（轮级索引） =====
// 只列「每个对话容器的标题」（一条 user 消息 = 一轮 = 一个 .msg-round 容器），
// 不再逐条列 agent 消息：一轮里动辄几十条工具/思考消息，逐条列会把面板淹掉，
// 而用户要跳转的粒度是「第几轮在聊什么」。点击项 → 定位到该轮容器并闪烁高亮。
//
// 旧实现每次全量重建（innerHTML 清空 + 逐条 innerHTML + 逐条监听），SSE 流式期间
// 每个 delta 都会触发一次，是长会话下的主要渲染开销之一。现改为：
//   1) scheduleMessageOutline 做 rAF 合并，单帧最多渲染一次；
//   2) 按 data-round-key 复用节点，仅就地更新变化的标题 / 时间 / 序号；
//   3) 容器级事件委托，替代逐条 click 监听。

var outlineRenderScheduled = false;
export function scheduleMessageOutline() {
  if (outlineRenderScheduled) return;
  outlineRenderScheduled = true;
  requestAnimationFrame(function() {
    outlineRenderScheduled = false;
    // rAF 回调不在 SSE 处理器 try/catch 内，异常需在此兜底上报（保持与同步渲染一致的错误可见性）
    try {
      renderMessageOutline();
    } catch (e) {
      reportError(e, { prefix: _t("大纲渲染失败: ") });
    }
  });
}

// 事件委托只挂一次（容器在视图生命周期内复用；重新挂载后 DOM 换新会自动重挂）
function ensureOutlineDelegation(container) {
  var cref = /** @type {any} */ (container);
  if (cref._admOutlineDelegated) return;
  cref._admOutlineDelegated = true;
  container.addEventListener("click", function(e) {
    var target = e.target instanceof Element ? e.target : null;
    var item = target ? target.closest(".outline-item") : null;
    if (!item || !container.contains(item)) return;
    setOutlinePanelOpen(false);
    scrollToRound(item.getAttribute("data-round-key") || "", item);
  });
}

export function renderMessageOutline() {
  var container = document.getElementById("agent-outline-list");
  if (!container) return;
  ensureOutlineDelegation(container);

  // 过滤：只取有 user 消息的轮（前导轮无标题可展示）
  var visible = roundOutlineEntries(S.messages);

  // 同步 header 计数
  var countEl = document.getElementById("agent-outline-count");
  if (countEl && countEl.textContent !== String(visible.length)) countEl.textContent = String(visible.length);
  updateOutlineFabBadge(visible.length);

  var cref = /** @type {any} */ (container);
  if (visible.length === 0) {
    container.querySelectorAll(".outline-item").forEach(function(el) { el.remove(); });
    cref._admNodes = {};
    if (!container.querySelector(".agent-outline-empty")) {
      container.innerHTML =
        '<div class="agent-outline-empty">' +
          '<div class="agent-outline-empty-icon">📑</div>' +
          '<div>' + _t("暂无对话记录") + '</div>' +
          '<div style="margin-top:6px;font-size:11px;">' + _t("在左侧开始对话后将自动出现") + '</div>' +
        '</div>';
    }
    return;
  }
  var emptyEl = container.querySelector(".agent-outline-empty");
  if (emptyEl) emptyEl.remove();

  var nodes = cref._admNodes || (cref._admNodes = {});
  var used = {};
  // 从后向前插入/校正顺序：node.nextSibling 即期望位置，已就位的节点零移动
  var nextRef = null;
  for (var j = visible.length - 1; j >= 0; j--) {
    var it = visible[j];
    var node = nodes[it.key];
    if (!node) {
      node = buildOutlineItem(it, j);
      nodes[it.key] = node;
    } else {
      updateOutlineItem(node, it, j);
    }
    used[it.key] = true;
    // 新建节点（尚未在容器内）或其位置不对时插入到期望位置
    if (node.parentNode !== container || node.nextSibling !== nextRef) container.insertBefore(node, nextRef);
    nextRef = node;
  }
  // 移除已不在列表中的旧节点
  Object.keys(nodes).forEach(function(k) {
    if (!used[k]) {
      var stale = nodes[k];
      if (stale && stale.parentNode) stale.remove();
      delete nodes[k];
    }
  });
}

// 构建大纲项：左侧色条 + meta（序号 · 时间）+ 轮标题（最多两行）
function buildOutlineItem(item, idx) {
  var node = document.createElement("div");
  node.className = "outline-item";
  node.setAttribute("data-round-key", item.key);
  var bar = document.createElement("span");
  bar.className = "outline-item-bar";
  var body = document.createElement("div");
  body.className = "outline-item-body";
  var meta = document.createElement("div");
  meta.className = "outline-item-meta";
  var idxEl = document.createElement("span");
  idxEl.className = "outline-item-idx";
  var timeEl = document.createElement("span");
  timeEl.style.cssText = "margin-left:auto;color:var(--c-text-4);";
  meta.appendChild(idxEl);
  meta.appendChild(timeEl);
  var titleEl = document.createElement("div");
  titleEl.className = "outline-item-title";
  body.appendChild(meta);
  body.appendChild(titleEl);
  node.appendChild(bar);
  node.appendChild(body);
  /** @type {any} */ (node)._adm = { idxEl: idxEl, timeEl: timeEl, titleEl: titleEl, rawTime: "", idx: -1, title: null };
  updateOutlineItem(node, item, idx);
  return node;
}

// 就地更新大纲项：只写变化的字段；.active 高亮类由 scrollToRound 维护，不在此清除
function updateOutlineItem(node, item, idx) {
  var st = /** @type {any} */ (node)._adm;
  if (st.idx !== idx) {
    st.idx = idx;
    st.idxEl.textContent = "#" + (idx + 1);
  }
  var rawTime = item.createdAt || "";
  if (st.rawTime !== rawTime) {
    st.rawTime = rawTime;
    var time = formatTime(rawTime);
    st.timeEl.textContent = time ? "· " + time : "";
    st.timeEl.style.display = time ? "" : "none";
  }
  if (st.title !== item.title) {
    st.title = item.title;
    st.titleEl.textContent = item.title;
  }
}

// 滚动消息区到指定轮容器（roundKey = data-roundkey），展开并短暂闪烁高亮。
// 折叠的轮先展开：否则滚过去只看得到标题条，等于没跳转。
function scrollToRound(roundKey, sourceItem) {
  var area = document.getElementById("agent-msg-area");
  if (!area) return;
  var target = area.querySelector('.msg-round[data-roundkey="' + cssEscape(roundKey) + '"]');
  if (!target) {
    showError(_t("未找到对应轮次（可能已被删除）"));
    return;
  }
  target.classList.remove("msg-round-collapsed");
  /** @type {any} */ (target)._admRoundOpen = true;
  // 折叠轮的正文按需渲染：展开后先把本轮内容补渲染出来（节点按 roundkey 复用，
  // 渲染期间保持滚动位置），再按后续流程滚动定位
  S.manualScrollMode = true;
  renderMessages();
  target = area.querySelector('.msg-round[data-roundkey="' + cssEscape(roundKey) + '"]') || target;
  // 轮内独立滚动：回到本轮开头，让用户从这轮的提问开始读
  target.scrollTop = 0;
  // 退出手动滚动模式 + 跳到底部命令互斥状态，确保后续 scroll 事件判定为程序触发。
  // 注意：programmaticScroll 必须有界——早先在此置 true 后不复位，onAreaScroll 见到该标志
  // 会直接 return，导致跳转后用户的所有滚动都不再更新手动/自动模式（滚回底部也无法恢复
  // 自动跟随）。平滑滚动约 0.3~0.5s，动画结束后复位；若期间已有更新的程序滚动重设过
  // 时间窗（渲染钉底/提示插入等），说明标志已由它们接管，此处不再干预。
  var jumpTs = Date.now();
  S.programmaticScroll = true;
  S.lastProgrammaticScroll = jumpTs;
  S.manualScrollMode = false;
  try {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (_) {
    target.scrollIntoView();
  }
  setTimeout(function() {
    if (S.lastProgrammaticScroll === jumpTs) S.programmaticScroll = false;
  }, 500);
  // 闪烁高亮轮容器：复用模板内 .msg-round.flash-highlight 动画
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

// 同步 FAB 角标：与面板里展示的大纲项数一致（面板按轮计数，故角标也是「轮数」），
// 否则用户看到角标是「总消息数」、打开后却少很多条，体感不一致。
// total 由 renderMessageOutline 传入（同一轮已统计），避免重复扫描 S.messages。
function updateOutlineFabBadge(total) {
  var badge = document.getElementById("agent-outline-fab-badge");
  if (!badge) return;
  if (total > 0) {
    var text = total > 99 ? "99+" : String(total);
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.style.display === "none") badge.style.display = "";
  } else if (badge.style.display !== "none") {
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
            clearDecisionMode(S.serverInfo.workspace_id, convId);
            if (S.currentConvId === convId) {
              resetPermissionState();
              store.setCurrentConvId(S.serverInfo.workspace_id, null);
              updateDecisionModeUI();
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
  updateDecisionModeUI();
  syncWxFollowSession();
  renderConversationList();
  // 切换后同步按钮语义（运行中→取消 / 排队中→取消排队 / 其它→发送），
  // 并提示用户当前工作区的运行状态，避免误把发送当取消
  updateSendButton();
  var otherRuns = (S.runs || []).filter(function(r) { return r.sessionId !== convId && !r.queued; });
  var isCurrentQueued = !!(S.queuedRun && S.queuedRun.sessionId === convId);
  if (isCurrentQueued) {
    var stateElQ = document.getElementById("agent-status-state");
    if (stateElQ) {
      stateElQ.innerHTML = '<span class="status-state-dot busy"></span>' + _t('排队中');
    }
    showInfo(_t("当前会话有消息排队中，将在本轮结束后自动执行"));
  } else if (otherRuns.length > 0) {
    var otherNames = otherRuns.map(function(r) {
      var conv = S.conversations.find(function(c) { return c.id === r.sessionId; });
      return conv ? (conv.title || conv.name || _t("其它会话")) : _t("其它会话");
    });
    updateStatusBar("busy", null, S.contextUsage.used);
    var stateEl = document.getElementById("agent-status-state");
    if (stateEl) {
      stateEl.innerHTML = '<span class="status-state-dot busy"></span>' + escapeHtml(otherNames[0]) + " " + _t("运行中");
    }
    // 同目录多会话并行开关决定当前会话能否直接开跑，提示语必须区分，
    // 否则关闭开关时用户会以为消息会像以前一样排队
    showInfo(S.settings.agent_concurrent_sessions === true
      ? _t("同工作区已有会话在运行（") + otherNames.join(_t("、")) + _t("）：当前会话可正常发送并与之并行执行")
      : _t("会话「") + otherNames[0] + _t("」正在运行，且已关闭「同目录多会话并行」：当前会话需等其结束后才能发送"));
  }

  var wsId = S.serverInfo.workspace_id;
  try {
    // 设置当前会话
    api("POST", "/v1/workspaces/" + wsId + "/current-session?client_id=" + S.clientId, {
      session_id: convId
    }).catch(function() {});

    // 获取会话信息
    var conv = await api("GET", "/v1/workspaces/" + wsId + "/sessions/" + convId);
    // 会话归属守卫：await 期间用户可能已切到其它会话/工作区，迟到响应不得覆盖当前选择
    if (S.currentConvId !== convId || !S.serverInfo || S.serverInfo.workspace_id !== wsId) return;
    store.setCurrentConv(wsId, conv);
    document.getElementById("agent-conv-title").textContent = S.currentConv.title || _t("会话");

    // 单独获取消息列表（合并保留折叠插入的 _fold 等待气泡：消息在服务端尚未
    // 创建，直接覆盖会被抹掉；setMessagesKeepPending 按内容去重后合并回来）。
    // 一次拉全量历史：聊天区按轮列出全部轮标题（折叠态不建消息 DOM，
    // 不再用「加载更早的消息」分页补拉）。
    var msgs = await api("GET", "/v1/workspaces/" + wsId + "/sessions/" + convId + "/messages");
    if (S.currentConvId !== convId || !S.serverInfo || S.serverInfo.workspace_id !== wsId) return;
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessagesKeepPending(wsId, msgs, convId);
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
  } catch (e) {
    console.error("[agent] 加载会话失败:", convId, e);
    reportError(e, { prefix: _t("加载会话失败: ") });
    // 会话归属守卫：切换后旧请求的失败不得再清理/改选当前工作区的会话
    if (S.currentConvId !== convId || !S.serverInfo || S.serverInfo.workspace_id !== wsId) return;
    // 会话在服务端已不存在（数据库被清理 / 跨 workspace 残留 ID）时，
    // 立即清理无效 currentConvId 并从本地列表移除，否则后续发送消息
    // 全部报 "failed to get session: sql: no rows in result set"
    var errText = getErrorMessage(e);
    var isGone = errText.indexOf("no rows") !== -1 || errText.indexOf("404") !== -1
      || (e && (e.status === 404 || e.code === 404));
    if (isGone) {
      if (S.currentConvId === convId) {
        store.setCurrentConvId(S.serverInfo.workspace_id, null);
        updateDecisionModeUI();
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
    updateDecisionModeUI();
    syncWxFollowSession();
    store.setMessages(S.serverInfo.workspace_id, []);
    store.setCurrentConv(S.serverInfo.workspace_id, resp);
    store.setContextUsage(S.serverInfo.workspace_id, 0, S.contextUsage.max, false);
    await loadConversations();
    renderMessages();
    renderTodos([]);
    document.getElementById("agent-conv-title").textContent = resp.title || _t("新会话");
    updateContextUsage();
  } catch (e) {
    reportError(e, { prefix: _t("创建会话失败: ") });
  }
}

// 刷新当前会话的消息列表（合并保留本地待落库的临时气泡，见 selectConversation 说明）。
// 整表重拉：调用方是压缩收尾/断线重连等低频路径，需要完整历史对齐。
export async function refreshMessages() {
  if (!S.currentConvId || !S.serverInfo) return;
  var convId = S.currentConvId;
  try {
    var msgs = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + convId + "/messages");
    // 等待期间用户可能已切走：结果属于旧会话，丢弃（否则会覆盖新会话的消息列表）
    if (S.currentConvId !== convId) return;
    if (!Array.isArray(msgs)) msgs = msgs.messages || [];
    store.setMessagesKeepPending(S.serverInfo.workspace_id, msgs, convId);
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
