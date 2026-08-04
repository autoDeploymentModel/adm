// 发送消息（fire-and-forget，结果经 SSE 返回）
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { autoResize, generateRunId } from "./utils.js";
import { getErrorMessage } from "./error.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, showInfo, reportError, updateContextUsage } from "./ui.js";
import { renderMessages } from "./render.js";
import { newConversation, renderConversationList } from "./session.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { clearPendingFiles } from "./attach.js";
import { armAutoContinue, resetAutoContinue } from "./autocontinue.js";

// ===== 发送消息 =====

export async function sendMessage() {
  console.log("[agent] sendMessage() isSending:", S.isSending, "convId:", S.currentConvId, "activeRun:", S.activeRun ? S.activeRun.sessionId : null, "queuedRun:", S.queuedRun ? S.queuedRun.sessionId : null);
  // 仅当「当前 UI 会话就是正在运行的会话」时，点击发送 = 取消该运行；
  // 若运行发生在其它会话（用户已切走），点击发送 = 给当前会话发新消息（服务端排队）
  var isCurrentRun = S.isSending && S.activeRun && S.activeRun.sessionId === S.currentConvId;
  var isCurrentQueued = !!(S.queuedRun && S.queuedRun.sessionId === S.currentConvId);
  if (isCurrentRun || isCurrentQueued) {
    if (isCurrentQueued) {
      // 取消排队：清除当前会话已入队、尚未执行的消息；正在执行的其它会话不受影响
      try {
        await api("POST", "/v1/workspaces/" + S.queuedRun.workspaceId + "/agent/sessions/" + S.queuedRun.sessionId + "/prompts/clear");
      } catch (e) {
        reportError(e, { prefix: _t("取消排队失败: ") });
        return;
      }
      S.queuedRun = null;
      // 若无其它运行则整体回到就绪态；若其它会话仍在执行则保持运行态
      if (!S.activeRun) {
        S.isSending = false;
        clearSendSafetyTimer();
        updateStatusBar("ready", null, S.contextUsage.used);
      }
      updateSendButton();
      renderConversationList();
      return;
    }
    // 取消实际运行中的会话（即当前会话）
    // 用户主动取消 → 同时解除自动续跑，避免取消后又被自动拉起
    resetAutoContinue();
    var activeRun = S.activeRun;
    if (activeRun) {
      try {
        await api("POST", "/v1/workspaces/" + activeRun.workspaceId + "/agent/sessions/" + activeRun.sessionId + "/cancel");
      } catch (e) {
        reportError(e, { prefix: _t("取消失败: ") });
        return;
      }
    }
    if (S.queuedRun) {
      // 取消当前运行后仍有排队运行：由排队运行接管（服务端队列 FIFO，取消后即轮到它）
      console.log("[agent] 取消当前运行，排队运行接管:", S.queuedRun.sessionId);
      S.activeRun = S.queuedRun;
      S.queuedRun = null;
      startSendSafetyTimer();
      updateSendButton();
      renderConversationList();
      return;
    }
    S.isSending = false;
    S.activeRun = null;
    S.queuedRun = null;
    updateSendButton();
    updateStatusBar("ready", null, S.contextUsage.used);
    clearSendSafetyTimer();
    return;
  }
  if (!S.currentConvId) {
    var input = /** @type {HTMLTextAreaElement} */ (document.getElementById("agent-input"));
    var text = (input.value || "").trim();
    if (!text && S.pendingFiles.length === 0) return;
    try { await newConversation(); } catch (_) { return; }
    if (!S.currentConvId) return;
  }
  var input = /** @type {HTMLTextAreaElement} */ (document.getElementById("agent-input"));
  var text = input.value.trim();
  if (!text && S.pendingFiles.length === 0) return;

  // 若此前切换模型时 /agent/update 未生效（会话繁忙），发送前补一次重载，确保本轮用新模型
  if (S.pendingModelReload && S.serverInfo && S.serverInfo.workspace_id) {
    try {
      await reloadAgentConfig();
      S.pendingModelReload = false;
      refreshAgentInfo();
    } catch (e) {
      console.warn("[agent] 发送前重载 Agent 配置失败:", e);
    }
  }

  // 发送前先把全部附件落盘为真实磁盘路径（统一"路径模式"，不再区分大小/类型）：
  // 内容一律不内联进 prompt（避免内联 base64 触发 70% 上下文守卫死循环），
  // 路径统一由 coordinator 收集并注入 <system_info> 读取引导（文本→view、图片→vision）。
  // 粘贴路径场景前端已持有 path；浏览器选择/拖拽的 File 无路径则先落盘到持久附件目录。
  // 落盘失败：明确报错并中止发送（不静默降级内联，避免模型看不到附件内容）。
  var filesToSend = S.pendingFiles.slice();
  var attachments = [];
  if (filesToSend.length > 0) {
    for (var i = 0; i < filesToSend.length; i++) {
      var f = filesToSend[i];
      var realPath = f.path || null;
      if (!realPath) {
        try {
          realPath = await invoke("save_attachment_file", { file_name: f.name, base64_content: f.base64 });
        } catch (e) {
          console.warn("[agent] 附件落盘失败:", e);
          showError(_t("附件保存失败，已取消发送: ") + f.name + " (" + getErrorMessage(e) + ")");
          return;
        }
      }
      attachments.push({ file_path: realPath, file_name: f.name, mime_type: f.type || "application/octet-stream", content: "" });
    }
  }

  // 在发送前固定运行身份；后续切换会话/工作区不能改变超时检查和取消目标
  var workspaceId = S.serverInfo.workspace_id;
  var sessionId = S.currentConvId;
  var runId = generateRunId();
  // 此刻工作区是否已被其它会话占用（本消息将排队等待）——用于发送成功后提示
  var wasBusyOther = S.isSending && S.activeRun && S.activeRun.sessionId !== sessionId;
  if (wasBusyOther) {
    // 工作区被其它会话占用：保留 activeRun（真正执行的运行）不变，
    // 本消息进入服务端队列，排队身份记入 queuedRun；isSending 已为 true 无需改动。
    // 提前设置 queuedRun：让临时消息渲染的「排队中」指示器与按钮文案立即生效
    S.queuedRun = { workspaceId: workspaceId, sessionId: sessionId, runId: runId };
  } else {
    S.isSending = true;
    S.activeRun = { workspaceId: workspaceId, sessionId: sessionId, runId: runId };
    S.queuedRun = null;
  }
  updateSendButton();

  // 立即显示用户消息（使用临时 ID，以便 SSE 到来时去重替换）
  var tempId = "temp-user-" + Date.now();
  S.messages.push({ id: tempId, role: "user", content: text, _temp: true, _attachments: filesToSend.length > 0 ? filesToSend.map(function(f) { return f.name; }) : null });
  renderMessages();
  input.value = "";
  autoResize(input);
  clearPendingFiles();

  // 更新状态栏
  updateStatusBar("busy", null, S.contextUsage.used);

  try {
    // POST /v1/workspaces/{id}/agent — fire-and-forget, 返回 202 Accepted (无响应体)
    // 实际结果通过 SSE 事件流获取
    // admAgent 要求 prompt 非空（纯图片附件会被 ValidateCall 拒绝："prompt is empty"），
    // 只发附件不输文字时补默认提示词（能走到这里 text 为空时 filesToSend 必非空）
    var body = {
      session_id: sessionId,
      prompt: text || _t("（用户发来附件，请查看并处理）"),
      run_id: runId,
    };
    if (attachments.length > 0) body.attachments = attachments;
    try {
      await api("POST", "/v1/workspaces/" + workspaceId + "/agent", body);
    } catch (sendErr) {
      // coordinator 被失败的 init 置空（如曾切到服务端未加载的 provider）：
      // 重建后重试一次，避免用户卡在永久性的“agent coordinator not initialized”
      if (String(sendErr).indexOf("agent coordinator not initialized") < 0) throw sendErr;
      console.warn("[agent] coordinator 未初始化，尝试 /agent/init 后重发");
      await api("POST", "/v1/workspaces/" + workspaceId + "/agent/init");
      await api("POST", "/v1/workspaces/" + workspaceId + "/agent", body);
    }
    console.log("[agent] 消息已发送, runId:", runId);
    // 初始化本轮运行统计：供假完成检测（A）与自动续跑进度判定（C）使用
    S.runStats = {
      sessionId: sessionId,
      prompt: text || _t("（用户发来附件，请查看并处理）"),
      toolCalls: 0,
      sideEffectCalls: 0,
      sideEffectSuccess: 0,
      seenMsgIds: {},
      startedAt: Date.now(),
    };
    // 手动发送成功 → 武装自动续跑（重置轮数/进度计数，绑定本会话）
    armAutoContinue(sessionId);
    // 排队场景提示：queuedRun 已在发送前设置（供指示器/按钮/列表标识用），此处仅提示与刷新
    if (wasBusyOther) {
      showInfo(_t("当前有会话正在运行，消息已排队，将在其完成后自动执行"));
      renderConversationList();
    }
    startSendSafetyTimer();
    updateContextUsage();
  } catch (e) {
    if (wasBusyOther) {
      // 排队发送失败：只清排队身份，不得触碰仍在执行的其它会话运行态
      S.queuedRun = null;
      updateSendButton();
      renderConversationList();
    } else {
      S.isSending = false;
      S.activeRun = null;
      S.queuedRun = null;
      updateSendButton();
      clearSendSafetyTimer();
      updateStatusBar("ready", null, S.contextUsage.used);
    }
    S.messages.push({ role: "error", content: _t("发送失败: ") + getErrorMessage(e), type: "error" });
    renderMessages();
  }
}
