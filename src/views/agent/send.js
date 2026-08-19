// 发送消息（fire-and-forget，结果经 SSE 返回）
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { autoResize, generateRunId } from "./utils.js";
import { log } from "./log.js";
import { getErrorMessage } from "./error.js";
import { updateSendButton, updateStatusBar, startSendSafetyTimer, clearSendSafetyTimer, showError, showInfo, reportError, updateContextUsage } from "./ui.js";
import { renderMessages } from "./render.js";
import { newConversation, renderConversationList } from "./session.js";
import { refreshAgentInfo, reloadAgentConfig } from "./model.js";
import { clearPendingFiles } from "./attach.js";
import { armAutoContinue, resetAutoContinue } from "./autocontinue.js";

// ===== 发送消息 =====

// 发送前模型可用性校验（见 sendMessage 调用点）：
// - 本地模型：必须已在「模型列表」启动（runningModelId 非空），否则服务端 local
//   provider 指向 127.0.0.1:1010 无可连服务，每轮对话都会报连接失败
// - 云端模型：磁盘配置中必须已有 base_url 与 api_key；内置 provider（不在磁盘列表，
//   配置由 admAgent 内置提供）跳过校验，交给服务端处理
// 返回错误文案（null = 校验通过）
function getModelReadiness() {
  var providerKey = S.settings.agent_default_provider || "local";
  var isLocal = providerKey === "local" || providerKey.indexOf("local:") === 0;
  // 服务端实际模型为 localModel 也按本地处理（重启后 admAgent.json 恢复 local 的兜底）
  if (S.agentInfo && S.agentInfo.model && S.agentInfo.model.id === "localModel") isLocal = true;

  if (isLocal) {
    var st = window.__adm_state; // index.html 初始化即暴露（types.d.ts 已声明结构）
    if (!st || !st.runningModelId) {
      return _t("当前使用本地模型，但没有本地模型在运行。请先到「模型列表」下载并启动一个本地模型，或点击顶部模型名称切换到已配置的云端模型。");
    }
    return null;
  }

  // 云端模型：校验磁盘配置（用户添加的 provider）
  var p = S.providers.find(function(x) { return providerKey === x.key || providerKey.indexOf(x.key + "/") === 0; });
  if (!p) return null; // 内置 provider / 无法定位：交给服务端报错
  if (!p.base_url) {
    return _t("云端模型「") + (p.name || p.key) + _t("」缺少接口地址（Base URL），请到设置中修改。");
  }
  if (!p.api_key) {
    return _t("云端模型「") + (p.name || p.key) + _t("」缺少 API Key，请到设置中填写。");
  }
  return null;
}

// 停止当前会话的运行（独立「停止」按钮调用；发送按钮不再承担取消职责）
export async function cancelCurrentRun() {
  var activeRun = S.activeRun;
  if (!S.isSending || !activeRun || activeRun.sessionId !== S.currentConvId) return;
  // 用户主动取消 → 同时解除自动续跑，避免取消后又被自动拉起
  resetAutoContinue();
  try {
    await api("POST", "/v1/workspaces/" + activeRun.workspaceId + "/agent/sessions/" + activeRun.sessionId + "/cancel");
  } catch (e) {
    reportError(e, { prefix: _t("取消失败: ") });
    return;
  }
  // 取消当前运行前，先清理未落库的折叠插入临时气泡：停止后服务端会丢弃
  // 排队中的折叠消息，不再产生 message-created 去重替换，残留气泡需就地移除
  var foldTemps = S.messages.filter(function(m) { return m._fold; });
  foldTemps.forEach(function(m) { store.deleteMessage(activeRun.workspaceId, m.id); });
  if (S.queuedRun) {
    // 取消当前运行后仍有排队运行：由排队运行接管（服务端队列 FIFO，取消后即轮到它）
    log.debug("SEND", "cancelCurrentRun: 取消当前运行，排队运行接管: " + S.queuedRun.sessionId);
    store.promoteQueuedRun(activeRun.workspaceId);
    startSendSafetyTimer();
    updateSendButton();
    renderConversationList();
    // 上面已删除丢弃的折叠临时气泡，必须重渲染消息区，避免残留「插入中」气泡
    renderMessages();
    return;
  }
  store.cancelRun(activeRun.workspaceId);
  updateSendButton();
  updateStatusBar("ready", null, S.contextUsage.used);
  clearSendSafetyTimer();
  renderMessages();
}

export async function sendMessage() {
  log.debug("SEND", "sendMessage: isSending=" + S.isSending + " convId=" + S.currentConvId + " activeRun=" + (S.activeRun ? S.activeRun.sessionId : "null") + " queuedRun=" + (S.queuedRun ? S.queuedRun.sessionId : "null"));
  // 当前会话「排队中」（消息已入队、等待其它会话运行完）→ 点击发送 = 取消排队；
  // 若运行发生在其它会话（用户已切走），点击发送 = 给当前会话发新消息（服务端排队）
  var isCurrentQueued = !!(S.queuedRun && S.queuedRun.sessionId === S.currentConvId);
  if (isCurrentQueued) {
    // 取消排队：清除当前会话已入队、尚未执行的消息；正在执行的其它会话不受影响
    try {
      await api("POST", "/v1/workspaces/" + S.queuedRun.workspaceId + "/agent/sessions/" + S.queuedRun.sessionId + "/prompts/clear");
    } catch (e) {
      reportError(e, { prefix: _t("取消排队失败: ") });
      return;
    }
    var cancelWsId = S.queuedRun.workspaceId;
    store.clearQueuedRun(cancelWsId);
    // 若无其它运行则整体回到就绪态；若其它会话仍在执行则保持运行态
    if (!S.activeRun) {
      store.cancelRun(cancelWsId);
      clearSendSafetyTimer();
      updateStatusBar("ready", null, S.contextUsage.used);
    }
    updateSendButton();
    renderConversationList();
    return;
  }
  // 折叠插入（中途插入）：当前会话正在运行，再发送 = 不带 run_id 发给服务端，
  // 服务端在下一步边界把它折叠进当前轮（不是排队等本轮结束、也不取消本轮）；
  // 不重开 run、不改运行统计、不重设续跑预算，仅新增一条待插入的用户消息
  var foldIn = !!(S.isSending && S.activeRun && S.activeRun.sessionId === S.currentConvId);
  if (foldIn) log.debug("SEND", "sendMessage: 当前会话运行中 → 折叠插入（无 run_id）");
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

  // 发送前模型可用性校验：本地模型必须已启动（否则服务端 local provider 指向
  // 127.0.0.1:1010 无可连服务，每轮对话都报连接失败）；云端模型必须已配置
  // base_url / api_key。校验失败给出明确引导，而不是等模型请求才报晦涩错误。
  var readinessMsg = getModelReadiness();
  if (readinessMsg) {
    showError(readinessMsg);
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

  // 在发送前固定运行身份；后续切换会话/工作区不能改变超时检查和停止目标
  var workspaceId = S.serverInfo.workspace_id;
  var sessionId = S.currentConvId;
  // 折叠插入不带 run_id：服务端把它折叠进当前轮，不产生独立 run 生命周期
  var runId = foldIn ? null : generateRunId();
  // 此刻工作区是否已被其它会话占用（本消息将排队等待）——用于发送成功后提示；
  // 折叠插入复用当前运行的槽位，不进入排队/启动新 run
  var wasBusyOther = !foldIn && store.isBusy(workspaceId) && S.activeRun && S.activeRun.sessionId !== sessionId;
  if (wasBusyOther) {
    store.setQueuedRun(workspaceId, sessionId, runId);
  } else if (!foldIn) {
    store.startRun(workspaceId, sessionId, runId);
  }
  updateSendButton();

  // 立即显示用户消息（使用临时 ID，以便 SSE 到来时去重替换）；
  // 折叠插入的临时气泡标记 _fold + _sessionId，渲染为「插入中」，等待服务端折叠时去重/替换；
  // _sessionId 用于刷新/切会话合并且只在同一会话内保留（防止待插入气泡串进其它会话）
  var tempId = "temp-user-" + Date.now();
  store.appendMessage(workspaceId, { id: tempId, role: "user", content: text, _temp: true, _fold: foldIn || undefined, _sessionId: sessionId, _attachments: filesToSend.length > 0 ? filesToSend.map(function(f) { return f.name; }) : null });
  renderMessages();
  input.value = "";
  autoResize(input);
  clearPendingFiles();

  // 更新状态栏：折叠插入不改动运行态（当前轮仍在跑），其余场景切到忙碌
  if (!foldIn) updateStatusBar("busy", null, S.contextUsage.used);

  try {
    // POST /v1/workspaces/{id}/agent — fire-and-forget, 返回 202 Accepted (无响应体)
    // 实际结果通过 SSE 事件流获取
    // admAgent 要求 prompt 非空（纯图片附件会被 ValidateCall 拒绝："prompt is empty"），
    // 只发附件不输文字时补默认提示词（能走到这里 text 为空时 filesToSend 必非空）
    var body = {
      session_id: sessionId,
      prompt: text || _t("（用户发来附件，请查看并处理）"),
    };
    // 折叠插入不带 run_id（服务端下一步边界折叠进当前轮）；独立轮次才带 run_id 关联生命周期
    if (!foldIn) body.run_id = runId;
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
    log.debug("SEND", "sendMessage: 消息已发送, runId=" + (runId || "(fold)") + " wsId=" + workspaceId + " sessionId=" + sessionId);
    // 独立轮次才初始化本轮运行统计（假完成检测 + 自动续跑进度）并武装自动续跑；
    // 折叠插入复用当前轮的统计与续跑状态，不重开
    if (!foldIn) {
      store.setRunStats(workspaceId, {
        sessionId: sessionId,
        prompt: text || _t("（用户发来附件，请查看并处理）"),
        toolCalls: 0,
        sideEffectCalls: 0,
        sideEffectSuccess: 0,
        seenMsgIds: {},
        startedAt: Date.now(),
      });
      // 手动发送成功 → 武装自动续跑（重置轮数/进度计数，绑定本会话）
      armAutoContinue(sessionId);
    } else {
      showInfo(_t("消息已发送，将在当前对话的下一步插入并继续处理"));
    }
    // 排队场景提示：queuedRun 已在发送前设置（供指示器/按钮/列表标识用），此处仅提示与刷新
    if (wasBusyOther) {
      showInfo(_t("当前有会话正在运行，消息已排队，将在其完成后自动执行"));
      renderConversationList();
    }
    startSendSafetyTimer();
    updateContextUsage();
  } catch (e) {
    if (foldIn) {
      // 折叠插入失败：不中断正在运行的当前轮，仅移除待插入的临时气泡并提示
      store.deleteMessage(workspaceId, tempId);
      renderMessages();
      showError(_t("消息发送失败（未影响当前运行）: ") + getErrorMessage(e));
    } else if (wasBusyOther) {
      store.clearQueuedRun(workspaceId);
      updateSendButton();
      renderConversationList();
    } else {
      store.cancelRun(workspaceId);
      updateSendButton();
      clearSendSafetyTimer();
      updateStatusBar("ready", null, S.contextUsage.used);
    }
    if (!foldIn) {
      store.appendMessage(workspaceId, { role: "error", content: _t("发送失败: ") + getErrorMessage(e), type: "error" });
      renderMessages();
    }
  }
}
