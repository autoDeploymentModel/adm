// SSE 事件订阅 / 分发 / 断线重连
import { t as _t } from "../../i18n.js";
import { S, invoke, listen, store } from "./store.js";
import { api } from "./api.js";
import { getTextFromParts, stripSystemInfoText } from "./utils.js";
import { getErrorMessage } from "./error.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, reportError, updateContextUsage } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, refreshMessages, renderConversationList, selectConversation, syncWxFollowSession } from "./session.js";
import { handlePermissionRequest, resetPermissionState } from "./permission.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { maybeAutoContinue, resetAutoContinue } from "./autocontinue.js";
import { log } from "./log.js";

// ===== SSE 事件 =====
export async function setupSSEListener() {
  console.log("[agent] setupSSEListener() workspace:", S.serverInfo ? S.serverInfo.workspace_id : "unknown");
  if (S.sseListener) { try { S.sseListener(); } catch (_) {} S.sseListener = null; }
  if (typeof listen !== "function") { console.warn("[agent] listen 不是函数"); return; }

  // 通知后端开始订阅 SSE（必须等待完成，否则消息发出后 SSE 还没连上）
  try {
    await invoke("agent_subscribe_events", {
      workspaceId: S.serverInfo.workspace_id,
      clientId: S.clientId
    });
    console.log("[agent] agent_subscribe_events 完成");
  } catch (e) {
    console.warn("[agent] agent_subscribe_events 失败:", e);
  }

  try {
    // 必须 await：listen() 返回 Promise，不 await 会导致 sseListener 存的是 Promise，
    // 下次注销时调用失败被吞掉，旧监听器永远无法移除 → 事件重复处理
    S.sseListener = await listen("agent-sse-event", function(event) {
      var payload = event.payload;
      var eventWsId = payload && payload.workspace_id;
      var rawData0 = payload.data || payload;
      var evType0 = rawData0.type || payload.type || "";
      log.debug("SSE", "event: " + evType0 + " ws: " + eventWsId + " activeWs: " + S.activeWsId + " currentConv: " + S.currentConvId);

      // 统一走 Store：自动处理跨 workspace 一致性
      // 非当前 tab 的事件更新对应 workspace 状态池
      // 当前 tab 的事件触发 emit → handleSSEEvent
      //
      // store.handleSSEEvent 可能已执行 queued 接管（completeRun 把 activeRun
      // 切到排队运行、非接管时清空 runStats），handleSSEEvent 里的 mismatch
      // 判定、tookOverQueued 检测和 maybeAutoContinue 的 runStats 都需要用
      // store 处理前的状态，否则会误杀前序运行/拿到 null 统计
      var prevActiveRun = S.activeRun;
      var prevQueuedRun = S.queuedRun;
      var prevRunStats = S.runStats;
      store.handleSSEEvent(eventWsId, payload);

      // 后台 workspace 运行出错时通知用户（active workspace 的错误由下方 handleSSEEvent 处理）
      if (eventWsId !== S.activeWsId) {
        var bgRaw = payload.data || payload;
        var bgType = bgRaw.type || payload.type || "";
        if (bgType === "run_complete") {
          var bgInner = (bgRaw.payload || {}).payload || bgRaw.payload || {};
          if (bgInner.error) {
            // 与 active workspace 的错误处理一致：走 reportError 获得 quota 分类与空消息防护
            reportError(bgInner.error, { prefix: _t("后台工作区运行出错: ") });
          }
        }
      }

      // 当前 tab 的事件继续走原有 UI 处理逻辑
      if (eventWsId === S.activeWsId) {
        handleSSEEvent(payload, { prevActiveRun: prevActiveRun, prevQueuedRun: prevQueuedRun, prevRunStats: prevRunStats });
      }
    });

    // 监听 SSE 错误事件（断线重连）—— 用单独的变量保存 unlisten，避免重复注册
    if (S.sseErrorUnlisten) { try { S.sseErrorUnlisten(); } catch (_) {} S.sseErrorUnlisten = null; }
    S.sseErrorUnlisten = await listen("agent-sse-error", function() {
      reconnectSSE();
    });
  } catch (_) {}
}

// SSE 断线重连
function reconnectSSE() {
  if (S.sseReconnectTimer) return;
  // SSE 短暂断线不代表运行已结束；保留 activeRun，重连后继续按原运行会话检查
  clearSendSafetyTimer();
  updateStatusBar("error", null, S.contextUsage.used);
  showError(_t("SSE 连接断开，3 秒后重连..."));
  S.sseReconnectTimer = setTimeout(async function() {
    S.sseReconnectTimer = null;
    try {
      // 重连前必须确保 server/workspace 身份仍有效（断线期间 server 状态可能丢失），
      // 否则后续直接用 S.serverInfo.workspace_id 拼 URL 会抛错被吞、重连假死
      if (!S.serverInfo || !S.serverInfo.workspace_id) {
        console.warn("[agent] 重连中止：serverInfo/workspace_id 缺失，状态退回就绪");
        store.cancelRun(store.activeWsId);
        clearSendSafetyTimer();
        updateStatusBar("ready", null, S.contextUsage.used);
        return;
      }
      // 重新订阅 SSE
      await setupSSEListener();
      // 刷新会话列表
      await loadConversations();
      // 刷新当前会话消息
      if (S.currentConvId) {
        await refreshMessages();
        // 刷新会话信息
        var reconnectedConv = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + S.currentConvId);
        store.setCurrentConv(store.activeWsId, reconnectedConv);
        renderTodos(S.currentConv.todos);
      }
      if (S.isSending && S.activeRun) startSendSafetyTimer();
      updateStatusBar(S.isSending ? "busy" : "ready", null, S.contextUsage.used);
    } catch (e) {
      reportError(e, { prefix: _t("重连失败: ") });
    }
  }, 3000);
}

// 错误格式化 / 分类统一收口到 error.js（getErrorMessage / classifyError），
// 展示统一走 ui.js 的 reportError（quota 类错误自动提示"余额不足，任务中断"）。

function handleSSEEvent(payload, ctx) {
  ctx = ctx || {};
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
      log.debug("SSE", "message: " + innerType + " role: " + actualData.role + " session: " + actualData.session_id + " currentConv: " + S.currentConvId + " match: " + (!actualData.session_id || actualData.session_id === S.currentConvId));
      // 只有实际运行会话的消息才能续期其安全计时器，其他会话事件不得干扰
      if (S.isSending && S.activeRun && (!actualData.session_id || actualData.session_id === S.activeRun.sessionId)) {
        startSendSafetyTimer();
      }
      // 排队结束信号：排队中的会话开始产出消息 → 已从「排队中」转入「运行中」，
      // 清除排队标识并接管 activeRun（前序运行的 run_complete 可能晚到，不能因此误清状态）
      if (S.queuedRun && actualData.session_id && actualData.session_id === S.queuedRun.sessionId) {
        console.log("[agent] 排队会话开始产出，接管运行:", actualData.session_id);
        store.promoteQueuedRun(S.queuedRun.workspaceId);
        renderConversationList();
      }
      // 未打开任何会话时，后台会话（如微信 Bot）来消息 → 自动打开该会话实时跟踪
      if (!S.currentConvId && actualData.session_id) {
        selectConversation(actualData.session_id);
        break; // selectConversation 会拉取全量消息，本条事件无需重复处理
      }
      // SSE 是工作区级广播：非当前打开会话的消息（如微信 Bot 会话的运行）不得进入当前消息列表，
      // 否则先被 push 显示、run_complete 后 refreshMessages 按当前会话拉取又被清掉（表现为消息闪现后消失）
      if (actualData.session_id && actualData.session_id !== S.currentConvId) {
        log.warn("SSE", "message DROPPED (session mismatch): " + actualData.session_id + " vs " + S.currentConvId);
        break;
      }
      log.debug("SSE", "message PASSED to handler: " + innerType + " role: " + actualData.role + " id: " + actualData.id);
      handleMessageSSEEvent(innerType, actualData);
      break;
    case "session":
      handleSessionSSEEvent(innerType, actualData);
      break;
    case "run_complete":
      // SSE 是 workspace 级事件流；只让当前运行自己的完成事件收尾发送态，
      // 避免同 workspace 其它会话/排队任务的 run_complete 提前结束当前运行。
      // 用 store 处理前的 activeRun 做判定：store.completeRun 可能已把
      // activeRun 切到排队运行，此时用 S.activeRun 会误判前序运行的完成事件为"非当前运行"
      var checkRun = ctx.prevActiveRun || S.activeRun;
      if (checkRun && (
        (actualData.run_id && actualData.run_id !== checkRun.runId) ||
        (!actualData.run_id && actualData.session_id && actualData.session_id !== checkRun.sessionId)
      )) {
        console.log("[agent] 忽略非当前运行的 run_complete:", actualData.run_id || actualData.session_id);
        break;
      }
      var tookOverQueued = false;
      if (ctx.prevQueuedRun) {
        // store.completeRun 已完成排队接管（activeRun 已切换、queuedRun 已清空），
        // 此处仅跟踪标志供后续 UI 逻辑使用，不重复 mutate 状态
        console.log("[agent] 前序运行完成，排队运行接管:", ctx.prevQueuedRun.sessionId);
        tookOverQueued = true;
        // 接管后运行即将开始（服务端队列 FIFO），重启安全计时器保护新运行
        startSendSafetyTimer();
      } else {
        // 非接管：状态收尾已在 store.handleSSEEvent → completeRun 完成（isSending/activeRun/runStats），
        // 此处只处理 UI 副作用
        clearSendSafetyTimer();
      }
      updateSendButton();
      console.log("[agent] run_complete 收尾发送态: run_id=" + (actualData.run_id || "") + " session=" + (actualData.session_id || "") + " error=" + getErrorMessage(actualData.error) + " cancelled=" + !!actualData.cancelled);
      // 本轮运行出错/被取消时明确提示（error 非空表示运行出错），
      // 否则服务端中断本轮时 UI 静默停止，表现为"会话突然中断"却无任何说明
      if (actualData && actualData.error) {
        console.warn("[agent] run_complete 携带错误:", JSON.stringify(actualData));
        var ctxHint = (S.contextUsage.max > 0 && S.contextUsage.used >= S.contextUsage.max * 0.9)
          ? _t("（上下文已接近上限 ") + S.contextUsage.used + "/" + S.contextUsage.max + _t("，建议新建会话继续）") : "";
        // 统一错误展示：quota（余额不足/401）类自动提示"余额不足，任务中断"，其余显示原始错误
        reportError(actualData.error, { prefix: _t("本轮对话中断: "), hint: ctxHint });
        updateStatusBar("error", null, S.contextUsage.used);
        // 运行出错时不自动续跑（避免在持续性错误上循环烧 token）
        resetAutoContinue();
      } else {
        if (actualData && actualData.cancelled) {
          showError(_t("本轮对话已取消"));
          resetAutoContinue();
        } else {
          // 正常收尾：检查 todos 未完成时自动续跑（内部自带开关/进度守卫/轮数熔断）
          // 排队接管时不续跑已结束的前序会话（用户已转向其它会话，且其 prompt 正排队）
          // runStats 用 store 处理前的快照：store.completeRun 非接管时已清空 S.runStats
          if (!tookOverQueued) maybeAutoContinue(actualData, ctx.prevRunStats || S.runStats);
        }
        // 排队接管时仍有运行在队列中，状态栏保持运行中，不切回就绪
        if (!tookOverQueued) updateStatusBar("ready", null, S.contextUsage.used);
      }
      // 本轮运行统计生命周期结束，清理避免跨轮残留；
      // 排队接管时该统计属于排队中的会话（发送时已初始化），保留给其实际执行轮使用
      if (!tookOverQueued) store.setRunStats(store.activeWsId, null);
      // 若切换模型时会话繁忙导致 /agent/update 未生效，本轮结束后立即重试重载
      if (S.pendingModelReload) {
        S.pendingModelReload = false;
        reloadAgentConfig()
          .then(function() { refreshAgentInfo(); })
          .catch(function() { S.pendingModelReload = true; });
      } else {
        // 运行完成后刷新 Agent 信息（模型可能已变更）并更新模型按钮显示（带序号防旧响应覆盖）
        refreshAgentInfo();
      }
      // 运行完成后刷新会话列表和消息
      loadConversations();
      if (S.currentConvId) {
        refreshMessages();
      }
      break;
    case "permission_request":
      // 审批弹窗已移除：skip=true 下正常不会收到，竞态到达时自动放行
      handlePermissionRequest(actualData);
      break;
    case "permission_notification":
      // 权限处理结果通知，可忽略或更新 UI
      break;
    case "config_changed":
      // 配置变更，刷新 Agent 信息
      break;
    case "agent_event":
      // Agent 事件（错误/响应/摘要）：error 可能是字符串或对象，统一展示并留完整日志便于排查
      if (actualData && actualData.error) {
        console.warn("[agent] agent_event 错误:", JSON.stringify(actualData).substring(0, 500));
        reportError(actualData.error, { prefix: _t("Agent 错误: ") });
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
  // 统计本轮工具调用（增量按消息 id + parts 数去重），供假完成检测与续跑进度判定使用
  if (action !== "deleted") collectRunStats(msgData);
  if (action === "created") {
    // 用户消息：先按内容匹配并清理临时消息（无论正式消息是否已被 store 追加）。
    // store.handleSSEEvent 先于本 handler 执行 appendMessage，正式消息可能已在列表中，
    // 若在 existing 检查之后才清理临时消息，会因 existing 命中而跳过 → 临时+正式并存（短暂重复）。
    // 注意不能用 updateMessage 替换：它按 msgData.id 查找（临时消息 id 是 temp-user-xxx），
    // 找不到会走 else push，临时消息依然残留。
    if (msgData.role === "user") {
      // 服务端用户消息附带 <system_info> 附件引导块，与临时消息（纯正文）匹配前先剥离
      var serverText = (msgData.content || getTextFromParts(msgData.parts)) || "";
      var tempIdx = S.messages.findIndex(function(m) { return m._temp && m.role === "user" && m.content === stripSystemInfoText(serverText); });
      if (tempIdx >= 0) {
        store.deleteMessage(store.activeWsId, S.messages[tempIdx].id);
      }
    }
    // 新消息创建 → 追加到消息列表（按 ID 去重）
    var existing = S.messages.find(function(m) { return m.id === msgData.id; });
    if (!existing) {
      store.appendMessage(store.activeWsId, msgData);
    }
    renderMessages();
  } else if (action === "updated") {
    // 消息更新 → 找到对应消息并替换
    var idx = S.messages.findIndex(function(m) { return m.id === msgData.id; });
    if (idx >= 0) {
      store.updateMessage(store.activeWsId, msgData);
      renderMessages();
    } else {
      // 消息不在列表中 → 追加
      store.appendMessage(store.activeWsId, msgData);
      renderMessages();
    }
  } else if (action === "deleted") {
    // 消息删除 → 从列表中移除
    store.deleteMessage(store.activeWsId, msgData.id);
    renderMessages();
  }
}

// ===== 本轮运行统计（续跑进度判定） =====
// 副作用工具：会真实修改工作区/执行命令的工具。todos 不算（进度由 incomplete 数体现）
var SIDE_EFFECT_TOOLS = ["edit", "write", "multiedit", "bash", "lsp_replace_symbol", "lsp_rename", "download", "agent"];

// 统计消息中的工具调用（tool_call / tool_result part）
function collectRunStats(msgData) {
  var rs = S.runStats;
  if (!rs || !msgData || !Array.isArray(msgData.parts)) return;
  // 只统计与本次运行同一会话的消息：排队期间 activeRun 可能是其它会话，
  // 其消息（session SSE 广播）不得计入本会话运行的统计，避免污染进度判定
  if (msgData.session_id && rs.sessionId && msgData.session_id !== rs.sessionId) return;
  var msgId = msgData.id || "";
  if (!msgId) return;
  var seenParts = rs.seenMsgIds[msgId] || 0;
  var parts = msgData.parts;
  if (parts.length <= seenParts) return; // 该消息 parts 未新增，无需重复统计
  for (var i = seenParts; i < parts.length; i++) {
    var p = parts[i];
    if (!p || !p.data) continue;
    var d = p.data;
    if (p.type === "tool_call" && typeof d.name === "string") {
      rs.toolCalls++;
      if (SIDE_EFFECT_TOOLS.indexOf(d.name) >= 0) rs.sideEffectCalls++;
    } else if (p.type === "tool_result" && typeof d.name === "string") {
      if (SIDE_EFFECT_TOOLS.indexOf(d.name) >= 0 && !d.is_error) rs.sideEffectSuccess++;
    }
  }
  rs.seenMsgIds[msgId] = parts.length;
}

// 处理会话 SSE 事件
function handleSessionSSEEvent(action, sessData) {
  var wsId = store.activeWsId;
  if (action === "created") {
    // 新会话创建
    var existing = S.conversations.find(function(c) { return c.id === sessData.id; });
    if (!existing) {
      var newList = S.conversations.slice();
      newList.unshift(sessData);
      store.setConversations(wsId, newList);
      renderConversationList();
    }
  } else if (action === "updated") {
    // 会话更新
    var idx = S.conversations.findIndex(function(c) { return c.id === sessData.id; });
    if (idx >= 0) {
      var updatedList = S.conversations.slice();
      updatedList[idx] = sessData;
      store.setConversations(wsId, updatedList);
      renderConversationList();
    }
    // 如果是当前会话，更新快照、标题、上下文和 Todo 面板
    if (S.currentConvId === sessData.id) {
      store.setCurrentConv(wsId, sessData);
      document.getElementById("agent-conv-title").textContent = sessData.title || _t("会话");
      // Session SSE 是完整快照；todos 使用 omitempty，字段缺失表示列表已清空，必须隐藏旧面板
      renderTodos(Array.isArray(sessData.todos) ? sessData.todos : []);
      // context_tokens 为 0 时（如仅改标题触发的更新）保留现有估算值，避免被清零
      if (sessData.context_tokens) {
        store.setContextUsage(wsId, sessData.context_tokens, S.contextUsage.max, false);
        updateContextUsage();
      }
    }
  } else if (action === "deleted") {
    // 会话删除
    var filtered = S.conversations.filter(function(c) { return c.id !== sessData.id; });
    store.setConversations(wsId, filtered);
    renderConversationList();
    if (S.currentConvId === sessData.id) {
      resetPermissionState();
      store.setCurrentConvId(wsId, null);
      syncWxFollowSession();
      store.setCurrentConv(wsId, null);
      store.setMessages(wsId, []);
      renderMessages();
      renderTodos([]);
      document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");
    }
  }
}
