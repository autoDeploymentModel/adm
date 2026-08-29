// SSE 事件订阅 / 分发 / 断线重连
import { t as _t } from "../../i18n.js";
import { S, invoke, listen, store } from "./store.js";
import { api } from "./api.js";
import { getErrorMessage, classifyError, ERROR_QUOTA, ERROR_STEP_CAP } from "./error.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, showWarning, showInfo, showChoice, reportError, updateContextUsage } from "./ui.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, refreshMessages, renderConversationList, selectConversation, syncWxFollowSession } from "./session.js";
import { handlePermissionRequest, resetPermissionState } from "./permission.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { maybeAutoContinue, resetAutoContinue, continueAfterStepCap } from "./autocontinue.js";
import { log } from "./log.js";

// ===== SSE 事件 =====

// 流式 message updated 增量是调试日志的噪音大户（每条 delta 连打 3 行 debug，
// 一轮长输出可产生上万行）：聚合降频，每条消息第 1 次与此后每 50 次 updated
// 才写日志；created/deleted/DROPPED 告警不受影响，仍全量记录。
var MSG_DELTA_LOG_EVERY = 50;
var msgDeltaCounts = {};
function tickMessageDelta(msgId) {
  if (Object.keys(msgDeltaCounts).length > 500) msgDeltaCounts = {}; // 防长期运行无限增长
  var n = (msgDeltaCounts[msgId] = (msgDeltaCounts[msgId] || 0) + 1);
  return n === 1 || n % MSG_DELTA_LOG_EVERY === 0;
}
// 当前这条增量事件是否应写日志（由外层监听器 tick 一次，内层 handler 只读）
var curDeltaLogged = true;
var lastLspEventLogTs = 0;

// 工具状态事件（lsp/mcp/skills）合并刷新：1s 窗口内最多执行一次 loadTools，
// 窗口结束时有新事件则补执行一次（尾随），连续事件流下既不超频也不漏掉最后一次。
// 诊断事件是编辑文件期间的噪音大户（每次保存一次），而工具面板不显示诊断计数，
// diagnostics_changed 在 case 分支里直接忽略，只有 state_changed 才需要刷新。
var TOOLS_REFRESH_THROTTLE_MS = 1000;
var toolsRefreshLast = 0;
var toolsRefreshPending = false;
var toolsRefreshTimer = null;

function scheduleLoadTools() {
  var now = Date.now();
  if (now - toolsRefreshLast >= TOOLS_REFRESH_THROTTLE_MS) {
    toolsRefreshLast = now;
    toolsRefreshPending = false;
    clearTimeout(toolsRefreshTimer);
    toolsRefreshTimer = null;
    loadTools();
  } else {
    toolsRefreshPending = true;
    if (!toolsRefreshTimer) {
      toolsRefreshTimer = setTimeout(function() {
        toolsRefreshTimer = null;
        if (toolsRefreshPending) {
          toolsRefreshPending = false;
          toolsRefreshLast = Date.now();
          loadTools();
        }
      }, TOOLS_REFRESH_THROTTLE_MS - (now - toolsRefreshLast));
    }
  }
}

// 视图卸载时取消挂起的工具列表刷新（agent.js unmount 调用）
export function cancelScheduledLoadTools() {
  if (toolsRefreshTimer) { clearTimeout(toolsRefreshTimer); toolsRefreshTimer = null; }
  toolsRefreshPending = false;
}

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
      var isDelta = evType0 === "message" && rawData0.payload && rawData0.payload.type === "updated";
      var skipLog = false;
      if (isDelta) {
        curDeltaLogged = tickMessageDelta(((rawData0.payload || {}).payload || {}).id || "");
        skipLog = !curDeltaLogged;
      } else if (evType0 === "lsp_event") {
        // LSP 诊断事件常成串爆发（编辑文件期间每秒多条），同样节流：5 秒最多 1 条
        skipLog = Date.now() - lastLspEventLogTs < 5000;
        if (!skipLog) lastLspEventLogTs = Date.now();
      }
      if (!skipLog) {
        log.debug("SSE", "event: " + evType0 + " ws: " + eventWsId + " activeWs: " + S.activeWsId + " currentConv: " + S.currentConvId);
      }

      // 统一走 Store：自动处理跨 workspace 一致性
      // 非当前 tab 的事件更新对应 workspace 状态池
      // 当前 tab 的事件数据已在 store 更新，下方 handleSSEEvent 只做 UI 副作用
      //
      // store.handleSSEEvent 可能已执行 queued 接管（completeRun 把 activeRun
      // 切到排队运行、非接管时清空 runStats），handleSSEEvent 里的 mismatch
      // 判定、tookOverQueued 检测和 maybeAutoContinue 的 runStats 都需要用
      // store 处理前的状态，否则会误杀前序运行/拿到 null 统计
      var prevActiveRun = S.activeRun;
      var prevQueuedRun = S.queuedRun;
      var prevRunStats = S.runStats;
      var prevCurrentConvId = S.currentConvId;
      store.handleSSEEvent(eventWsId, payload);

      // 后台 workspace 运行出错时通知用户（active workspace 的错误由下方 handleSSEEvent 处理）
      if (eventWsId !== S.activeWsId) {
        var bgRaw = payload.data || payload;
        var bgType = bgRaw.type || payload.type || "";
        if (bgType === "run_complete") {
          var bgInner = (bgRaw.payload || {}).payload || bgRaw.payload || {};
          if (bgInner.error) {
            // 与 active workspace 的错误展示一致：气泡写进该后台 workspace 的消息池，
            // 切回时可见，不打扰当前 tab。触顶非故障，用独立文案避免误导为"运行出错"。
            if (classifyError(bgInner.error) === ERROR_STEP_CAP) {
              appendErrorBubble(bgInner.error, { prefix: _t("后台工作区步数触顶: "), wsId: eventWsId, sessionId: bgInner.session_id });
            } else {
              appendErrorBubble(bgInner.error, { prefix: _t("后台工作区运行出错: "), wsId: eventWsId, sessionId: bgInner.session_id });
            }
          }
        }
      }

      // 当前 tab 的事件继续走原有 UI 处理逻辑
      if (eventWsId === S.activeWsId) {
        handleSSEEvent(payload, { prevActiveRun: prevActiveRun, prevQueuedRun: prevQueuedRun, prevRunStats: prevRunStats, prevCurrentConvId: prevCurrentConvId });
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

// 常驻错误气泡：错误以本地消息形式追加进聊天列表（不落库 → 下次请求不会
// 跟随上下文提交给 LLM），替代 3s 自动消失的弹窗；切会话/刷新页面后随会话
// 状态清理。quota 类错误沿用"余额不足"文案；同一会话 3 秒内相同文本去重
//（输出退化场景服务端会同时发 agent_event error + run_complete error）。
var lastErrorBubble = null;
function appendErrorBubble(err, opts) {
  opts = opts || {};
  var wsId = opts.wsId || S.serverInfo.workspace_id;
  var sid = opts.sessionId || S.currentConvId;
  var base = getErrorMessage(err);
  if (!base) return;
  var text;
  if (classifyError(err) === ERROR_QUOTA) {
    text = _t("余额不足，任务中断");
  } else {
    text = (opts.prefix || "") + base + (opts.hint || "");
  }
  var now = Date.now();
  // 同一会话 3s 内相同核心错误只显示一次（agent_event 与 run_complete 的
  // prefix 不同，用 base 而非最终文本比较，避免同一次失败双气泡）
  if (lastErrorBubble && lastErrorBubble.wsId === wsId && lastErrorBubble.sid === sid && lastErrorBubble.base === base && now - lastErrorBubble.ts < 3000) return;
  lastErrorBubble = { wsId: wsId, sid: sid, base: base, ts: now };
  store.appendMessage(wsId, {
    id: "local-error-" + now,
    role: "error",
    content: text,
    _temp: true,
    _error: true,
    _sessionId: sid,
  });
  // 仅当前 tab 需要 DOM 渲染；后台 workspace 的气泡在切回时由 renderMessages 呈现
  if (wsId === S.activeWsId) renderMessages();
}

// 步数触顶决策卡：模型用完了本轮 64 步预算但仍在干活，由用户显式决定去留。
// 只针对激活 tab 的当前运行（run_complete 的 activeRun 匹配过滤在上游已完成），
// 后台 workspace 触顶仍走错误气泡，避免多 tab 弹窗互相遮挡。
function showStepCapDialog(sessionId) {
  if (!sessionId) return;
  showChoice({
    title: _t("大模型已经推理很久啦"),
    message: _t("还是没有解决您的问题吗？您是否要大模型继续干活不解决不罢休，还是终止本次交互，查看下原因先？后续您还可以给我说“继续”来完成本次任务。"),
    okText: _t("继续干活，不解决不罢休"),
    cancelText: _t("终止，查看原因"),
    onOk: function() {
      continueAfterStepCap(sessionId).catch(function(e) {
        log.debug("AUTOC", "step_cap 续跑发送失败: " + getErrorMessage(e));
      });
    },
    onCancel: function() {
      showInfo(_t("可随时发送“继续”恢复本次任务"));
    },
  });
}

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
      if (innerType !== "updated" || curDeltaLogged) {
        log.debug("SSE", "message: " + innerType + " role: " + actualData.role + " session: " + actualData.session_id + " currentConv: " + S.currentConvId + " match: " + (!actualData.session_id || actualData.session_id === S.currentConvId));
      }
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
      if (innerType !== "updated" || curDeltaLogged) {
        log.debug("SSE", "message PASSED to handler: " + innerType + " role: " + actualData.role + " id: " + actualData.id);
      }
      handleMessageSSEEvent(innerType, actualData);
      break;
    case "session":
      handleSessionSSEEvent(innerType, actualData, ctx);
      break;
    case "run_complete":
      // 防御：子 Agent（agent 工具嵌套调用）的 run_complete 携带复合 session_id
      //（格式 `{parentMsgId}$$call_{toolCallId}`）且 run_id 为空，
      // 绝不能让它误触发父运行的收尾逻辑。
      if (typeof actualData.session_id === "string" && actualData.session_id.indexOf("$$call_") !== -1) {
        console.log("[agent] 忽略子 Agent 的 run_complete:", actualData.session_id);
        break;
      }
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
        if (classifyError(actualData.error) === ERROR_STEP_CAP) {
          // 步数触顶：模型仍在干活但本轮 64 步预算耗尽，不是故障。
          // 弹决策卡让用户选"继续干活"（人工确认，绝不静默连跑）或"终止查原因"。
          resetAutoContinue();
          updateStatusBar("ready", null, S.contextUsage.used);
          showStepCapDialog(actualData.session_id);
        } else {
          var ctxHint = (S.contextUsage.max > 0 && S.contextUsage.used >= S.contextUsage.max * 0.9)
            ? _t("（上下文已接近上限 ") + S.contextUsage.used + "/" + S.contextUsage.max + _t("，建议新建会话继续）") : "";
          // 统一错误展示：quota（余额不足/401）类自动提示"余额不足，任务中断"，其余显示原始错误
          // 常驻错误气泡写进聊天列表（不弹窗、不进 LLM 上下文）
          appendErrorBubble(actualData.error, { prefix: _t("本轮对话中断: "), hint: ctxHint });
          updateStatusBar("error", null, S.contextUsage.used);
          // 运行出错时不自动续跑（避免在持续性错误上循环烧 token）
          resetAutoContinue();
        }
      } else {
        if (actualData && actualData.empty_output) {
          // 服务端标记：本轮正常结束但没有任何实际输出（正文/工具调用全无，
          // 典型为模型把输出全部消耗在 reasoning 上）→ 明确提示而非静默消失
          console.warn("[agent] run_complete empty_output:", JSON.stringify(actualData));
          showWarning(_t("模型未产生有效输出（输出全部消耗在思考中），本轮已结束"));
          updateStatusBar("error", null, S.contextUsage.used);
          // 未产生任何输出时不自动续跑（避免继续空转烧 token）
          resetAutoContinue();
        } else if (actualData && actualData.cancelled) {
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
      // Agent 事件（错误/响应/摘要/思考中）：error 可能是字符串或对象，统一展示并留完整日志便于排查
      if (actualData && actualData.error) {
        if (classifyError(actualData.error) === ERROR_STEP_CAP) {
          // 步数触顶：服务端会同时发 agent_event error + run_complete error（与输出退化
          // 场景同机制），提示统一由 run_complete 分支的决策卡呈现，这里不弹错误气泡
          break;
        }
        console.warn("[agent] agent_event 错误:", JSON.stringify(actualData).substring(0, 500));
        appendErrorBubble(actualData.error, { prefix: _t("Agent 错误: ") });
      } else if (actualData && actualData.type === "thinking" && actualData.progress) {
        // 模型长时间思考仍未产出可见内容：仅提示当前正在查看的会话，避免其它会话打扰
        if (!actualData.session_id || actualData.session_id === S.currentConvId) {
          log.debug("SSE", "agent_event thinking: " + actualData.progress);
          showInfo(actualData.progress);
        }
      }
      break;
    case "file":
      // 文件变更，可忽略
      break;
    case "skills_event":
    case "mcp_event":
    case "lsp_event":
      // 工具状态变更，节流合并刷新工具列表（1s 窗口）；
      // lsp 诊断计数变化（每次编辑/保存触发）对工具面板无意义，直接忽略
      if (eventType === "lsp_event" && actualData.type === "diagnostics_changed") break;
      scheduleLoadTools();
      break;
  }
}

// 处理消息 SSE 事件
function handleMessageSSEEvent(action, msgData) {
  // 统计本轮工具调用（增量按消息 id + parts 数去重），供假完成检测与续跑进度判定使用
  if (action !== "deleted") collectRunStats(msgData);
  // 数据更新统一由 store.handleSSEEvent 完成（created → upsertCreatedMessage，
  // updated → updateMessage，deleted → deleteMessage，含临时气泡清理），此处只做 UI 刷新
  renderMessages();
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
function handleSessionSSEEvent(action, sessData, ctx) {
  // 数据更新统一由 store.handleSessionEvent 完成（created 插入 / updated 替换并
  // 同步 currentConv/contextUsage / deleted 清空会话与消息），此处只保留 UI 副作用。
  // store 先于本 handler 执行（见 setupSSEListener），S 已是更新后的状态。
  // deleted 时 store 已将 currentConvId 置 null，需用 ctx.prevCurrentConvId 判断
  // 被删会话是否曾是当前会话，否则 UI 清理全部被跳过。
  if (action === "created") {
    renderConversationList();
  } else if (action === "updated") {
    renderConversationList();
    // 如果是当前会话，更新标题、上下文和 Todo 面板
    if (S.currentConvId === sessData.id) {
      document.getElementById("agent-conv-title").textContent = sessData.title || _t("会话");
      // Session SSE 是完整快照；todos 使用 omitempty，字段缺失表示列表已清空，必须隐藏旧面板
      renderTodos(Array.isArray(sessData.todos) ? sessData.todos : []);
      // context_tokens 为 0 时（如仅改标题触发的更新）保留现有估算值，避免被清零
      if (sessData.context_tokens) {
        updateContextUsage();
      }
    }
  } else if (action === "deleted") {
    renderConversationList();
    if ((ctx && ctx.prevCurrentConvId) === sessData.id) {
      resetPermissionState();
      syncWxFollowSession();
      renderMessages();
      renderTodos([]);
      document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");
    }
  }
}
