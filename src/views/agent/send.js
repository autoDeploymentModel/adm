// 发送消息（fire-and-forget，结果经 SSE 返回）
import { S } from "./state.js";
import { api } from "./api.js";
import { autoResize, generateRunId } from "./utils.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, updateContextUsage } from "./ui.js";
import { renderMessages } from "./render.js";
import { newConversation } from "./session.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { clearPendingFiles } from "./attach.js";

// ===== 发送消息 =====
export async function sendMessage() {
  console.log("[agent] sendMessage() isSending:", S.isSending, "convId:", S.currentConvId);
  if (S.isSending) {
    // 取消运行
    if (S.currentConvId) {
      try {
        await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/sessions/" + S.currentConvId + "/cancel");
      } catch (e) {
        showError("取消失败: " + e);
      }
    }
    S.isSending = false;
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

  // 检查模型是否支持图片
  var hasImages = S.pendingFiles.some(function(f) { return f.type && f.type.indexOf("image/") === 0; });
  if (hasImages && (!S.agentInfo || !S.agentInfo.model)) {
    try {
      S.agentInfo = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent");
    } catch (_) {}
  }
  console.log("[agent] 图片检查:", { hasImages, agentInfo: S.agentInfo ? S.agentInfo.model : null, supports_images: S.agentInfo && S.agentInfo.model ? S.agentInfo.model.supports_images : "N/A" });
  if (hasImages && S.agentInfo && S.agentInfo.model && S.agentInfo.model.supports_images !== true) {
    showError("当前模型 (" + (S.agentInfo.model.id || "未知") + ") 不支持图片，请仅发送文本或切换到支持图片的模型");
    return;
  }

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

  S.isSending = true;
  updateSendButton();

  // 立即显示用户消息（使用临时 ID，以便 SSE 到来时去重替换）
  var tempId = "temp-user-" + Date.now();
  S.messages.push({ id: tempId, role: "user", content: text, _temp: true, _attachments: S.pendingFiles.length > 0 ? S.pendingFiles.map(function(f) { return f.name; }) : null });
  renderMessages();
  input.value = "";
  autoResize(input);
  var filesToSend = S.pendingFiles.slice();
  clearPendingFiles();

  // 更新状态栏
  updateStatusBar("busy", null, S.contextUsage.used);

  try {
    // POST /v1/workspaces/{id}/agent — fire-and-forget, 返回 202 Accepted (无响应体)
    // 实际结果通过 SSE 事件流获取
    var runId = generateRunId();
    var body = {
      session_id: S.currentConvId,
      prompt: text,
      run_id: runId,
    };
    if (filesToSend.length > 0) {
      body.attachments = filesToSend.map(function(f) {
        return {
          file_name: f.name,
          mime_type: f.type || "application/octet-stream",
          content: f.base64,
        };
      });
    }
    try {
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent", body);
    } catch (sendErr) {
      // coordinator 被失败的 init 置空（如曾切到服务端未加载的 provider）：
      // 重建后重试一次，避免用户卡在永久性的“agent coordinator not initialized”
      if (String(sendErr).indexOf("agent coordinator not initialized") < 0) throw sendErr;
      console.warn("[agent] coordinator 未初始化，尝试 /agent/init 后重发");
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/init");
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent", body);
    }
    console.log("[agent] 消息已发送, runId:", runId);
    startSendSafetyTimer();
    updateContextUsage();
  } catch (e) {
    S.isSending = false;
    updateSendButton();
    clearSendSafetyTimer();
    updateStatusBar("ready", null, S.contextUsage.used);
    S.messages.push({ role: "error", content: "发送失败: " + e, type: "error" });
    renderMessages();
  }
}
