// SSE 事件订阅 / 分发 / 断线重连
import { S, invoke, listen } from "./state.js";
import { api } from "./api.js";
import { getTextFromParts } from "./utils.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, updateContextUsage } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, refreshMessages, renderConversationList } from "./session.js";
import { showPermissionDialog, resetPermissionState } from "./permission.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";

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
  S.isSending = false;
  updateSendButton();
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
      updateStatusBar("ready", null, S.contextUsage.used);
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
      // 收到消息事件说明 Agent 仍在活动，重置安全超时计时器（避免长任务被误判超时）
      if (S.isSending) startSendSafetyTimer();
      handleMessageSSEEvent(innerType, actualData);
      break;
    case "session":
      handleSessionSSEEvent(innerType, actualData);
      break;
    case "run_complete":
      S.isSending = false;
      updateSendButton();
      clearSendSafetyTimer();
      // 本轮运行出错/被取消时明确提示（error 非空表示运行出错），
      // 否则服务端中断本轮时 UI 静默停止，表现为"会话突然中断"却无任何说明
      if (actualData && actualData.error) {
        console.warn("[agent] run_complete 携带错误:", JSON.stringify(actualData));
        var ctxHint = (S.contextUsage.max > 0 && S.contextUsage.used >= S.contextUsage.max * 0.9)
          ? "（上下文已接近上限 " + S.contextUsage.used + "/" + S.contextUsage.max + "，建议新建会话继续）" : "";
        showError("本轮对话中断: " + actualData.error + ctxHint);
        updateStatusBar("error", null, S.contextUsage.used);
      } else {
        if (actualData && actualData.cancelled) {
          showError("本轮对话已取消");
        }
        updateStatusBar("ready", null, S.contextUsage.used);
      }
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
      showPermissionDialog(actualData);
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
        var aerr = typeof actualData.error === "string" ? actualData.error : JSON.stringify(actualData.error);
        showError("Agent 错误: " + aerr);
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
      S.currentConv = null;
      S.messages = [];
      renderMessages();
      renderTodos([]);
      document.getElementById("agent-conv-title").textContent = "选择或创建一个会话";
    }
  }
}
