// SSE 事件订阅 / 分发 / 断线重连
import { S, invoke, listen } from "./state.js";
import { api } from "./api.js";
import { getTextFromParts } from "./utils.js";
import { getErrorMessage } from "./error.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, showWarning, reportError, updateContextUsage } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, refreshMessages, renderConversationList, selectConversation, syncWxFollowSession } from "./session.js";
import { handlePermissionRequest, resetPermissionState } from "./permission.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { maybeAutoContinue, resetAutoContinue } from "./autocontinue.js";

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
      handleSSEEvent(event.payload);
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
  showError("SSE 连接断开，3 秒后重连...");
  S.sseReconnectTimer = setTimeout(async function() {
    S.sseReconnectTimer = null;
    try {
      // 重新订阅 SSE
      await setupSSEListener();
      // 刷新会话列表
      await loadConversations();
      // 刷新当前会话消息
      if (S.currentConvId) {
        await refreshMessages();
        // 刷新会话信息
        S.currentConv = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + S.currentConvId);
        renderTodos(S.currentConv.todos);
      }
      if (S.isSending && S.activeRun) startSendSafetyTimer();
      updateStatusBar(S.isSending ? "busy" : "ready", null, S.contextUsage.used);
    } catch (e) {
      reportError(e, { prefix: "重连失败: " });
    }
  }, 3000);
}

// 错误格式化 / 分类统一收口到 error.js（getErrorMessage / classifyError），
// 展示统一走 ui.js 的 reportError（quota 类错误自动提示"余额不足，任务中断"）。

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
      // 只有实际运行会话的消息才能续期其安全计时器，其他会话事件不得干扰
      if (S.isSending && S.activeRun && (!actualData.session_id || actualData.session_id === S.activeRun.sessionId)) {
        startSendSafetyTimer();
      }
      // 排队结束信号：排队中的会话开始产出消息 → 已从「排队中」转入「运行中」，
      // 清除排队标识并接管 activeRun（前序运行的 run_complete 可能晚到，不能因此误清状态）
      if (S.queuedRun && actualData.session_id && actualData.session_id === S.queuedRun.sessionId) {
        console.log("[agent] 排队会话开始产出，接管运行:", actualData.session_id);
        S.activeRun = S.queuedRun;
        S.queuedRun = null;
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
        break;
      }
      handleMessageSSEEvent(innerType, actualData);
      break;
    case "session":
      handleSessionSSEEvent(innerType, actualData);
      break;
    case "run_complete":
      // SSE 是 workspace 级事件流；只让当前运行自己的完成事件收尾发送态，
      // 避免同 workspace 其它会话/排队任务的 run_complete 提前结束当前运行。
      if (S.activeRun && (
        (actualData.run_id && actualData.run_id !== S.activeRun.runId) ||
        (!actualData.run_id && actualData.session_id && actualData.session_id !== S.activeRun.sessionId)
      )) {
        console.log("[agent] 忽略非当前运行的 run_complete:", actualData.run_id || actualData.session_id);
        break;
      }
      var tookOverQueued = false;
      if (S.queuedRun) {
        // 前序运行完成，排队运行接管：activeRun 切到排队运行，保持运行态连续
        console.log("[agent] 前序运行完成，排队运行接管:", S.queuedRun.sessionId);
        S.activeRun = S.queuedRun;
        S.queuedRun = null;
        tookOverQueued = true;
        // 接管后运行即将开始（服务端队列 FIFO），重启安全计时器保护新运行
        startSendSafetyTimer();
      } else {
        S.isSending = false;
        S.activeRun = null;
        clearSendSafetyTimer();
      }
      updateSendButton();
      console.log("[agent] run_complete 收尾发送态: run_id=" + (actualData.run_id || "") + " session=" + (actualData.session_id || "") + " error=" + getErrorMessage(actualData.error) + " cancelled=" + !!actualData.cancelled);
      // 本轮运行出错/被取消时明确提示（error 非空表示运行出错），
      // 否则服务端中断本轮时 UI 静默停止，表现为"会话突然中断"却无任何说明
      if (actualData && actualData.error) {
        console.warn("[agent] run_complete 携带错误:", JSON.stringify(actualData));
        var ctxHint = (S.contextUsage.max > 0 && S.contextUsage.used >= S.contextUsage.max * 0.9)
          ? "（上下文已接近上限 " + S.contextUsage.used + "/" + S.contextUsage.max + "，建议新建会话继续）" : "";
        // 统一错误展示：quota（余额不足/401）类自动提示"余额不足，任务中断"，其余显示原始错误
        reportError(actualData.error, { prefix: "本轮对话中断: ", hint: ctxHint });
        updateStatusBar("error", null, S.contextUsage.used);
        // 运行出错时不自动续跑（避免在持续性错误上循环烧 token）
        resetAutoContinue();
      } else {
        if (actualData && actualData.cancelled) {
          showError("本轮对话已取消");
          resetAutoContinue();
        } else {
          // 正常收尾：先做假完成检测（无 error 静默结束时的兜底提示），
          // 再检查 todos 未完成时自动续跑（内部自带开关/进度守卫/轮数熔断）
          detectFakeCompletion();
          // 排队接管时不续跑已结束的前序会话（用户已转向其它会话，且其 prompt 正排队）
          if (!tookOverQueued) maybeAutoContinue(actualData, S.runStats);
        }
        // 排队接管时仍有运行在队列中，状态栏保持运行中，不切回就绪
        if (!tookOverQueued) updateStatusBar("ready", null, S.contextUsage.used);
      }
      // 本轮运行统计生命周期结束，清理避免跨轮残留；
      // 排队接管时该统计属于排队中的会话（发送时已初始化），保留给其实际执行轮使用
      if (!tookOverQueued) S.runStats = null;
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
        reportError(actualData.error, { prefix: "Agent 错误: " });
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
    // 新消息创建 → 追加到消息列表（按 ID 去重）
    var existing = S.messages.find(function(m) { return m.id === msgData.id; });
    if (!existing) {
      // 对于用户消息，尝试按内容匹配临时消息并替换（避免重复）
      if (msgData.role === "user") {
        var tempIdx = S.messages.findIndex(function(m) { return m._temp && m.role === "user" && m.content === (msgData.content || getTextFromParts(msgData.parts)); });
        if (tempIdx >= 0) {
          // 用正式消息替换临时消息
          S.messages[tempIdx] = msgData;
          renderMessages();
          return;
        }
      }
      S.messages.push(msgData);
      renderMessages();
    }
  } else if (action === "updated") {
    // 消息更新 → 找到对应消息并替换
    var idx = S.messages.findIndex(function(m) { return m.id === msgData.id; });
    if (idx >= 0) {
      S.messages[idx] = msgData;
      renderMessages();
    } else {
      // 消息不在列表中 → 追加
      S.messages.push(msgData);
      renderMessages();
    }
  } else if (action === "deleted") {
    // 消息删除 → 从列表中移除
    S.messages = S.messages.filter(function(m) { return m.id !== msgData.id; });
    renderMessages();
  }
}

// ===== 本轮运行统计（假完成检测 / 续跑进度判定） =====
// 副作用工具：会真实修改工作区/执行命令的工具。todos 不算（进度由 incomplete 数体现）
var SIDE_EFFECT_TOOLS = ["edit", "write", "multiedit", "bash", "lsp_replace_symbol", "lsp_rename", "download", "agent"];
// 触发"可能未完成"提示的工具调用次数上限（本轮工具调用 ≤ 该值且含副作用工具才提示）
var FAKE_COMPLETE_TOOL_LIMIT = 4;
// 操作型动词：prompt 命中这些词说明用户期望实际改动/部署/修复，而非纯问答
var ACTION_VERB_RE = /部署|发布|修复|重构|改造|优化|统一|整理|处理|执行|修改|新建|迁移|实现|添加|删除|调整|合并|拆分|解决|完成|继续|开发|构建|设计|验证|测试|修复|安装|配置|清理/;

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

// 假完成/静默停止检测：本轮有副作用工具调用、但工具调用总数过少、且任务含操作型动词，
// 说明模型可能草草收尾（未真正完成改动）。给出提示而非完全静默。
function detectFakeCompletion() {
  var rs = S.runStats;
  if (!rs || rs.toolCalls === 0) return;        // 纯问答（无工具）不检测
  if (rs.sideEffectCalls === 0) return;         // 只读/无副作用任务不检测
  if (rs.toolCalls > FAKE_COMPLETE_TOOL_LIMIT) return; // 工具调用足够多，任务正常推进
  if (!ACTION_VERB_RE.test(rs.prompt || "")) return;   // 非操作型动词（如"帮我看看"）不提示
  showWarning("本轮对话已结束，但工具调用较少（" + rs.toolCalls + " 次），任务可能未完整执行。请确认结果，如有遗漏请补充说明继续。");
}

// 处理会话 SSE 事件
function handleSessionSSEEvent(action, sessData) {
  if (action === "created") {
    // 新会话创建
    var existing = S.conversations.find(function(c) { return c.id === sessData.id; });
    if (!existing) {
      S.conversations.unshift(sessData);
      renderConversationList();
    }
  } else if (action === "updated") {
    // 会话更新
    var idx = S.conversations.findIndex(function(c) { return c.id === sessData.id; });
    if (idx >= 0) {
      S.conversations[idx] = sessData;
      renderConversationList();
    }
    // 如果是当前会话，更新快照、标题、上下文和 Todo 面板
    if (S.currentConvId === sessData.id) {
      S.currentConv = sessData;
      document.getElementById("agent-conv-title").textContent = sessData.title || "会话";
      // Session SSE 是完整快照；todos 使用 omitempty，字段缺失表示列表已清空，必须隐藏旧面板
      renderTodos(Array.isArray(sessData.todos) ? sessData.todos : []);
      // context_tokens 为 0 时（如仅改标题触发的更新）保留现有估算值，避免被清零
      if (sessData.context_tokens) {
        S.contextUsage.used = sessData.context_tokens;
        S.contextUsage.estimated = false;
        updateContextUsage();
      }
    }
  } else if (action === "deleted") {
    // 会话删除
    S.conversations = S.conversations.filter(function(c) { return c.id !== sessData.id; });
    renderConversationList();
    if (S.currentConvId === sessData.id) {
      resetPermissionState();
      S.currentConvId = null;
      syncWxFollowSession();
      S.currentConv = null;
      S.messages = [];
      renderMessages();
      renderTodos([]);
      document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
    }
  }
}
