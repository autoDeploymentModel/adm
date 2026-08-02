// 自动续跑：本轮正常结束但 todos 未完成时，自动发送"继续"开新一轮。
// 每轮新 prompt 会重置服务端所有 nudge 重试预算，等于把"推着模型干完"的
// 预算按轮扩展；配进度守卫（连续无进展即停）与轮数上限防止无限烧 token。
import { t as _t } from "../../i18n.js";
import { S } from "./state.js";
import { api } from "./api.js";
import { generateRunId } from "./utils.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, reportError } from "./ui.js";

// 单个任务（一次手动发送）最多自动续跑轮数（硬熔断）
var MAX_AUTO_ROUNDS = 10;
// 连续多少轮 todos 完成数无增长即停（模型已推不动，续跑只会烧 token）
var MAX_NO_PROGRESS_ROUNDS = 2;
var STORAGE_KEY = "agent_auto_continue";

export function isAutoContinueEnabled() {
  // 默认开启；显式存 "0" 才关闭
  try { return localStorage.getItem(STORAGE_KEY) !== "0"; } catch (_) { return true; }
}

export function setAutoContinueEnabled(enabled) {
  try { localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch (_) {}
  if (!enabled) resetAutoContinue();
}

// 手动发送成功后调用：绑定本任务的续跑目标会话并清零计数
export function armAutoContinue(sessionId) {
  S.autoContinue = { armedSession: sessionId, rounds: 0, lastIncomplete: -1, noProgress: 0 };
}

// 手动取消 / 运行出错 / 任务完成时调用
export function resetAutoContinue() {
  S.autoContinue = { armedSession: null, rounds: 0, lastIncomplete: -1, noProgress: 0 };
}

// run_complete 正常收尾（无 error、未取消）时调用；data 为 run_complete 事件负载，
// runStats 为本轮运行统计（工具调用/副作用成功数），用于"有实质进展不算无进展"判定
export async function maybeAutoContinue(data, runStats) {
  var ac = S.autoContinue;
  var sid = data && data.session_id;
  // 只续跑本客户端自己发起的任务；后台会话（如微信 Bot）不受影响
  if (!ac || !ac.armedSession || !sid || sid !== ac.armedSession) return;
  // 用户已切走会话 → 不在其背后静默烧 token，直接解除
  if (sid !== S.currentConvId) { resetAutoContinue(); return; }
  // Plan 模式下不续跑：没有 edit/todos 工具，残留 todos 永远完不成，续跑只会空转
  // 重置 armed 状态，避免残留会话 ID 被后续外部 run_complete（如微信 Bot）误触发续跑
  if (S.settings && S.settings.agent_plan_mode) { resetAutoContinue(); return; }
  if (!isAutoContinueEnabled() || S.isSending || !S.serverInfo) return;

  // 取最新会话快照判定 todos（session SSE 可能晚于 run_complete，主动拉一次）
  var sess;
  try {
    sess = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/sessions/" + sid);
  } catch (e) {
    console.warn("[agent] 自动续跑读取会话失败:", e);
    return;
  }
  var todos = Array.isArray(sess.todos) ? sess.todos : [];
  var incomplete = todos.filter(function(t) { return t.status !== "completed"; }).length;
  if (todos.length === 0 || incomplete === 0) { resetAutoContinue(); return; }

  // 期间用户已手动发新消息 / 状态被重置
  if (S.autoContinue !== ac || ac.armedSession !== sid) return;
  // await 期间用户可能已切走会话 → 二次校验，避免在旧会话背后静默烧 token
  if (sid !== S.currentConvId) { resetAutoContinue(); return; }

  if (ac.rounds >= MAX_AUTO_ROUNDS) {
    showError(_t("自动续跑已达 ") + MAX_AUTO_ROUNDS + _t(" 轮上限，仍有 ") + incomplete + _t(" 项任务未完成，已停止。建议更换更强的模型后手动继续"));
    resetAutoContinue();
    return;
  }
  // 进度守卫：未完成数没有减少视为无进展；
  // 但本轮有实质副作用工具成功（edit/write/bash 等改动落地）说明模型在干活，不算无进展
  var hasRealProgress = !!(runStats && runStats.sideEffectSuccess > 0);
  if (ac.lastIncomplete >= 0 && incomplete >= ac.lastIncomplete && !hasRealProgress) {
    ac.noProgress++;
    if (ac.noProgress >= MAX_NO_PROGRESS_ROUNDS) {
      showError(_t("自动续跑已停止：连续 ") + MAX_NO_PROGRESS_ROUNDS + _t(" 轮无进展（剩余 ") + incomplete + _t(" 项未完成）。建议更换模型或调整任务后手动继续"));
      resetAutoContinue();
      return;
    }
  } else {
    ac.noProgress = 0;
  }
  ac.lastIncomplete = incomplete;
  ac.rounds++;
  console.log("[agent] 自动续跑 第 " + ac.rounds + " 轮, 剩余 todos: " + incomplete + ", 无进展轮数: " + ac.noProgress);
  await sendContinuePrompt(sid);
}

// 程序化发送“继续”消息（不经输入框；用户气泡由 SSE message created 事件补显）
async function sendContinuePrompt(sessionId) {
  var workspaceId = S.serverInfo.workspace_id;
  var runId = generateRunId();
  S.isSending = true;
  S.activeRun = { workspaceId: workspaceId, sessionId: sessionId, runId: runId };
  // 续跑轮也是新 run：重置运行统计，供本轮假完成检测与下一轮进度判定使用
  S.runStats = {
    sessionId: sessionId,
    prompt: _t("任务清单还有未完成项，请继续完成剩余的 todos；每完成一项立即用 todos 工具标记，全部完成后再结束。"),
    toolCalls: 0,
    sideEffectCalls: 0,
    sideEffectSuccess: 0,
    seenMsgIds: {},
    startedAt: Date.now(),
  };
  updateSendButton();
  updateStatusBar("busy", null, S.contextUsage.used);
  try {
    await api("POST", "/v1/workspaces/" + workspaceId + "/agent", {
      session_id: sessionId,
      prompt: _t("任务清单还有未完成项，请继续完成剩余的 todos；每完成一项立即用 todos 工具标记，全部完成后再结束。"),
      run_id: runId,
    });
    startSendSafetyTimer();
  } catch (e) {
    S.isSending = false;
    S.activeRun = null;
    S.queuedRun = null;
    updateSendButton();
    clearSendSafetyTimer();
    updateStatusBar("ready", null, S.contextUsage.used);
    reportError(e, { prefix: _t("自动续跑发送失败: ") });
    resetAutoContinue();
  }
}
