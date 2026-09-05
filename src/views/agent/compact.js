// 手动压缩上下文：toolbar 上「🗜️」按钮，调用 /summarize 端点触发服务端摘要生成。
// 按钮可用性需在多处同步（运行态变化、会话切换、消息变化），通过 ui.js / session.js / render.js
// 派发的 CustomEvent 解耦，避免反向依赖本模块。
//
// 完成信号（重要，勿依赖 SSE type=summarize —— 服务端从不发出该事件，见下）：
// 1. HTTP 200：/summarize 是同步阻塞 API，返回时压缩已完成（或空转无历史可压缩）。
// 2. SSE session updated：压缩成功后服务端写回 summary_message_id（session.Save →
//    Publish UpdatedEvent），由 sse.js handleSessionSSEEvent updated 分支回调 onSessionUpdated。
// 3. 5 分钟兜底定时器：上述信号全部丢失时强制恢复按钮，避免永久卡死。
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";
import { showInfo, showWarning, reportError, showConfirm, showNotice } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { loadConversations, refreshMessages } from "./session.js";
import { refreshAgentInfo } from "./model.js";

// 当前压缩请求的 sessionId：防止用户连点 / 切到别的会话后按钮仍处于 compressing 态。
// 模块级状态 → unmount→remount 后会残留陈旧值，导致按钮永久卡在压缩态。
// mount 时若 compactingSessionId 不等于当前会话（即 SSE 已重订阅、旧完成事件已无法触达），
// 必须重置：成本只是可能多发一次 API，服务端对该 session 重复 summarize 是幂等或无害的。
var compactingSessionId = null;
// 压缩发起时的 summary_message_id，用于区分「真正压缩」与「空转」（无可压缩历史）
var compactingPrevSummaryId = null;
var compactTimer = null;
var COMPACT_TIMEOUT_MS = 5 * 60 * 1000;
// 各会话「上次真正压缩完成时的消息总数」（sessionId → count）：
// 压缩后该会话未产生新消息前禁用按钮，避免对同一段历史反复触发 Summarize
// 生成冗余摘要。按会话分别记录，切走再切回仍生效。
var compactedCounts = {};
// 压缩过程的持久提示节点（keep=true 不自动消失）：压缩结束前保持显示，
// 完成/失败/兜底时由 clearCompactNotice 移除，避免 3s 自动消失误导用户
var compactNoticeEl = null;

// 显示压缩过程持久提示（替换旧节点）；压缩结束前保持显示
function showCompactNotice(msg, level) {
  clearCompactNotice();
  compactNoticeEl = showNotice(msg, level, true);
}
function clearCompactNotice() {
  if (compactNoticeEl) {
    if (compactNoticeEl.parentNode) compactNoticeEl.remove();
    compactNoticeEl = null;
  }
}

function clearCompactTimer() {
  if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
}

export function bindCompactBtnEvents() {
  var btn = document.getElementById("agent-compact-btn");
  if (!btn) return;

  // 陈旧状态清理：仅在「压缩中的会话 ≠ 当前会话」时重置。若恰好相同（SSE 重订阅后同会话
  // 继续压缩）保留状态，等待完成信号（session updated / 兜底定时器）。
  if (compactingSessionId && compactingSessionId !== S.currentConvId) {
    clearCompactTimer();
    compactingSessionId = null;
    compactingPrevSummaryId = null;
  }

  btn.addEventListener("click", function() {
    // 防误点：确认后才触发压缩（压缩会改写会话历史，不可撤销）
    showConfirm(_t("确定压缩当前会话的上下文吗？旧消息将被摘要替换，无法撤销。"), function() {
      triggerManualCompact();
    });
  });

  // ui.js updateSendButton 状态变化后通过该事件通知，避免 ui.js 反向依赖本模块
  document.addEventListener("agent-toolbar-state-changed", updateCompactBtn);
  // 会话切换 / 消息变化后需刷新按钮可用性（启用条件含 S.currentConvId / S.messages.length）
  document.addEventListener("agent-conversation-changed", updateCompactBtn);
  document.addEventListener("agent-messages-changed", updateCompactBtn);

  if (S.unlisteners && S.unlisteners.push) {
    S.unlisteners.push(function() {
      document.removeEventListener("agent-toolbar-state-changed", updateCompactBtn);
      document.removeEventListener("agent-conversation-changed", updateCompactBtn);
      document.removeEventListener("agent-messages-changed", updateCompactBtn);
      // 兜底定时器刻意不清理：未完成的压缩仍需兜底恢复；unmount 后触发时
      // updateCompactBtn 的 getElementById 返回 null 会安全返回。
    });
  }

  updateCompactBtn();
}

export function updateCompactBtn() {
  var btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("agent-compact-btn"));
  if (!btn) return;
  if (compactingSessionId) {
    btn.classList.add("compacting");
    btn.disabled = true;
    btn.title = _t("正在压缩上下文…");
    return;
  }
  // 触发条件：有当前会话、未在运行（运行中压缩会与当前轮消息流冲突）、
  // 至少有 1 条历史消息（空会话压缩无意义）、且压缩后产生了新消息
  // （上次压缩完成时记录的会话+消息总数，无新消息则禁用，避免对同一历史
  // 反复 Summarize 生成冗余摘要）
  var hasConv = !!S.currentConvId;
  var isBusy = !!(S.isSending && S.activeRun && S.activeRun.sessionId === S.currentConvId);
  var hasContent = Array.isArray(S.messages) && S.messages.length > 0;
  var compactedCount = hasConv ? compactedCounts[S.currentConvId] : undefined;
  var hasNewSinceCompact = compactedCount === undefined
    || (Array.isArray(S.messages) && S.messages.length > compactedCount);
  var enabled = hasConv && !isBusy && hasContent && hasNewSinceCompact;
  btn.disabled = !enabled;
  btn.classList.remove("compacting");
  btn.title = enabled
    ? _t("手动压缩上下文：将当前会话的历史消息生成摘要以释放上下文窗口")
    : (isBusy
        ? _t("当前会话正在运行，无法压缩")
        : (!hasNewSinceCompact
            ? _t("压缩后暂无新内容，产生新消息后可再次压缩")
            : (hasConv ? _t("当前会话为空，无需压缩") : _t("请先选择会话"))));
}

// 触发手动压缩：调 /summarize 端点。完成信号见文件头注释。
function triggerManualCompact() {
  if (!S.serverInfo || !S.serverInfo.workspace_id || !S.currentConvId) return;
  if (compactingSessionId) return;
  if (S.isSending && S.activeRun && S.activeRun.sessionId === S.currentConvId) {
    showWarning(_t("当前会话正在运行，无法压缩"));
    return;
  }
  // 防御：压缩完成后未产生新消息时，即使按钮状态未同步（如事件丢失）也拦截，
  // 避免对同一段已压缩历史重复触发 Summarize
  var compactedCount = compactedCounts[S.currentConvId];
  if (compactedCount !== undefined
    && (!Array.isArray(S.messages) || S.messages.length <= compactedCount)) {
    showInfo(_t("压缩后暂无新内容，产生新消息后可再次压缩"));
    return;
  }
  compactingSessionId = S.currentConvId;
  compactingPrevSummaryId = (S.currentConv && S.currentConv.summary_message_id) || "";
  clearCompactTimer();
  compactTimer = setTimeout(function() {
    // 所有完成信号均丢失（罕见）时的最后防线：强制恢复按钮态
    if (!compactingSessionId) return;
    compactTimer = null;
    compactingSessionId = null;
    compactingPrevSummaryId = null;
    clearCompactNotice();
    updateCompactBtn();
    showWarning(_t("压缩状态超时未确认，已恢复；请检查会话是否已压缩"));
  }, COMPACT_TIMEOUT_MS);
  updateCompactBtn();
  // 持久提示：压缩结束前保持显示（不随 3s 自动消失），完成/失败时由收尾路径移除
  showCompactNotice(_t("正在压缩上下文…"), "info");
  api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/sessions/" + S.currentConvId + "/summarize")
    .then(function() {
      // 同步 API：200 返回时压缩已完成（或空转）。拉取会话确认 summary_message_id 是否变化：
      // 有变化 → 已压缩；无变化 → 服务端没有旧历史可压缩（空转），提示「无需压缩」。
      var sid = compactingSessionId;
      if (!sid) return; // 期间已被 onSessionUpdated 收尾（SSE 先到），无需重复处理
      api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + sid)
        .then(function(conv) {
          var changed = compactingPrevSummaryId
            ? (!!conv && conv.summary_message_id !== compactingPrevSummaryId)
            : (!!conv && !!conv.summary_message_id);
          finishCompacting(sid, changed);
        })
        .catch(function() {
          finishCompacting(sid, true); // 查询失败保守视为已压缩
        });
    })
    .catch(function(e) {
      // Rust 代理 120s 超时（agent.rs agent_http_request）：服务端压缩可能仍在进行，
      // 保留压缩态等待 session updated / 兜底定时器；明确失败（ErrSessionBusy 等）才立即恢复。
      if (/超时|timed\s*out|timeout/i.test(getErrorMessage(e))) {
        // 服务端可能仍在压缩：保留压缩态，持久提示改为「仍在进行」，等 session updated 收尾
        showCompactNotice(_t("压缩仍在进行，完成后将自动刷新…"), "warn");
        return;
      }
      clearCompactTimer();
      compactingSessionId = null;
      compactingPrevSummaryId = null;
      clearCompactNotice();
      updateCompactBtn();
      reportError(e, { prefix: _t("触发压缩失败: ") });
    });
}

// 统一收尾：清态 + 刷新 + 提示。
function finishCompacting(sid, changed) {
  if (!compactingSessionId) return;
  clearCompactTimer();
  compactingSessionId = null;
  compactingPrevSummaryId = null;
  // 压缩已结束：移除持久提示，完成/空转提示走正常 3s 自动消失
  clearCompactNotice();
  if (changed) {
    // 压缩成功：先保守记录「当前消息数 + 1」禁用按钮，堵住 SSE summary 消息
    // created 晚于 HTTP 200 到达导致的误启用窗口（两条通道顺序不保证）；
    // 消息列表刷新成功后以权威快照覆盖（压缩后已落库消息总数，含 summary
    // 消息）。此后该会话未产生新消息前按钮保持禁用，避免对同一段历史反复
    // Summarize 生成冗余摘要。
    compactedCounts[sid] = ((S.messages && S.messages.length) || 0) + 1;
    refreshMessages().then(function() {
      // refreshMessages 刷新的是当前会话（S.currentConvId），压缩完成瞬间若用户已
      // 切走，S.messages 已是其他会话的消息——跳过校准保持保守值（方向安全：偏大
      // 只会让按钮晚一点解锁，不会误启用导致冗余压缩）。
      if (S.currentConvId !== sid) return;
      compactedCounts[sid] = (S.messages && S.messages.length) || 0;
      updateCompactBtn();
    }).catch(function() {
      // 刷新失败时保持保守值（按钮仍禁用，直到产生新消息）
    });
  } else {
    refreshMessages().catch(function() {});
  }
  updateCompactBtn();
  if (sid === S.currentConvId) {
    refreshAgentInfo().catch(function() {});
    showInfo(changed ? _t("上下文已压缩") : _t("没有可压缩的历史"));
  }
  loadConversations();
}

// SSE 回调（sse.js handleSessionSSEEvent updated 分支调用）：
// 压缩成功的权威信号是会话快照出现/变化 summary_message_id（session.Save → UpdatedEvent）。
export function onSessionUpdated(sessData) {
  if (!compactingSessionId || !sessData || sessData.id !== compactingSessionId) return;
  if (!sessData.summary_message_id) return; // 标题等其它更新，非压缩完成
  if (sessData.summary_message_id === compactingPrevSummaryId) return; // 无变化（理论不会）
  finishCompacting(sessData.id, true);
}
