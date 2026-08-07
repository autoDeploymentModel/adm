// 通用 UI：状态栏 / 上下文用量 / 错误与确认弹窗 / 滚动模式 / 安全超时 / 右键菜单
import { t as _t } from "../../i18n.js";
import { S } from "./state.js";
import { api } from "./api.js";
import { formatTokens, isMsgAreaAtBottom } from "./utils.js";
import { getErrorMessage, classifyError, ERROR_QUOTA } from "./error.js";

// 退出手动滚动模式（切换会话/工作区时调用，避免把旧会话的滚动位置带到新会话）
export function exitManualScrollMode() {
  if (S.manualModeExitTimer) { clearTimeout(S.manualModeExitTimer); S.manualModeExitTimer = null; }
  S.manualScrollMode = false;
}

// 更新「回到底部」悬浮圆球的显隐：未滚到底部时显示，到底/无滚动条时隐藏
export function updateScrollBottomBtn() {
  var btn = document.getElementById("agent-scroll-bottom-btn");
  var area = document.getElementById("agent-msg-area");
  if (!btn || !area) return;
  if (area.scrollHeight <= area.clientHeight || isMsgAreaAtBottom(area)) {
    btn.classList.remove("show");
  } else {
    btn.classList.add("show");
  }
}

// ===== isSending 安全超时 =====
// 计时器仅在收到 message 事件时刷新；本地模型处理大上下文时 prompt 阶段可能
// 数分钟不产出任何 token（无 message 事件），不能仅凭超时就重置状态，
// 需先向服务端确认会话是否仍在运行（is_busy），仍忙则续期计时器
export function startSendSafetyTimer() {
  clearSendSafetyTimer();
  var activeRun = S.activeRun;
  if (!activeRun) return;
  S.sendSafetyTimer = setTimeout(async function() {
    // 只允许为同一运行创建的计时器改变状态；旧计时器不得干扰后续运行
    if (!S.isSending || S.activeRun !== activeRun) return;
    try {
      var sess = await api("GET", "/v1/workspaces/" + activeRun.workspaceId + "/sessions/" + activeRun.sessionId);
      if (S.isSending && S.activeRun === activeRun && sess && sess.is_busy) {
        console.log("[agent] 安全超时检查：运行会话仍在执行，续期计时器");
        startSendSafetyTimer();
        return;
      }
      // 排队场景：activeRun 会话自身不忙（is_busy=false）但工作区其它会话仍在执行，
      // 本会话的 prompt 正排队等待，不能误判为超时；以工作区级 is_busy 为准续期
      var agentInfo = await api("GET", "/v1/workspaces/" + activeRun.workspaceId + "/agent");
      if (S.isSending && S.activeRun === activeRun && agentInfo && agentInfo.is_busy) {
        console.log("[agent] 安全超时检查：工作区忙碌（本会话 prompt 排队中），续期计时器");
        startSendSafetyTimer();
        return;
      }
    } catch (_) {}
    if (!S.isSending || S.activeRun !== activeRun) return; // 查询期间可能已正常收尾或开始下一轮
    console.warn("[agent] isSending 安全超时 (3min) 且运行会话已不在执行，自动重置");
    S.isSending = false;
    S.activeRun = null;
    S.queuedRun = null;
    updateSendButton();
    updateStatusBar("ready", null, S.contextUsage.used);
    showError(_t("运行超时，已自动重置状态"));
  }, 180000);
}

export function clearSendSafetyTimer() {
  if (S.sendSafetyTimer) {
    clearTimeout(S.sendSafetyTimer);
    S.sendSafetyTimer = null;
  }
}

// ===== 右键菜单（仅复制/粘贴） =====
export function showCopyPasteMenu(e, targetInput) {
  e.preventDefault();
  e.stopPropagation();
  var old = document.getElementById("agent-ctx-menu");
  if (old) old.remove();
  var menu = document.createElement("div");
  menu.id = "agent-ctx-menu";
  menu.style.cssText = "position:fixed;background:var(--c-raise);border:1px solid var(--c-border);border-radius:8px;padding:4px 0;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);min-width:100px;";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";

  var hasSelection = false;
  try { hasSelection = window.getSelection().toString().length > 0; } catch (_) {}

  var items = [];
  if (hasSelection) {
    items.push({ label: _t("复制"), action: function() {
      var sel = window.getSelection();
      if (sel && sel.toString()) {
        navigator.clipboard.writeText(sel.toString()).catch(function() {
          document.execCommand("copy");
        });
      }
    }});
  }
  if (targetInput) {
    items.push({ label: _t("粘贴"), action: function() {
      navigator.clipboard.readText().then(function(text) {
        if (text) {
          var start = targetInput.selectionStart;
          var end = targetInput.selectionEnd;
          var val = targetInput.value;
          targetInput.value = val.substring(0, start) + text + val.substring(end);
          targetInput.selectionStart = targetInput.selectionEnd = start + text.length;
          targetInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }).catch(function() {});
    }});
  }

  if (items.length === 0) return;

  items.forEach(function(it) {
    var mi = document.createElement("div");
    mi.textContent = it.label;
    mi.style.cssText = "padding:6px 16px;font-size:12px;cursor:pointer;color:var(--c-text-2);";
    mi.addEventListener("mouseenter", function() { mi.style.background = "var(--c-raise-2)"; });
    mi.addEventListener("mouseleave", function() { mi.style.background = "transparent"; });
    mi.addEventListener("click", function() {
      menu.remove();
      it.action();
    });
    menu.appendChild(mi);
  });

  document.body.appendChild(menu);
  setTimeout(function() {
    document.addEventListener("mousedown", function closeHandler(ev) {
      if (!menu.contains(/** @type {Node} */ (ev.target))) {
        menu.remove();
        document.removeEventListener("mousedown", closeHandler);
      }
    });
  }, 0);
}

export function updateSendButton() {
  var btn = document.getElementById("agent-send-btn");
  if (!btn) return;
  // 按钮语义按会话归属：仅当「当前 UI 会话就是正在运行的会话」时显示取消，
  // 运行在别的会话（用户切走）时按钮恢复为发送，避免误把发送当取消；
  // 当前会话处于「排队中」（消息已入队等待执行）时显示取消排队
  var isCurrentRun = S.isSending && S.activeRun && S.activeRun.sessionId === S.currentConvId;
  var isCurrentQueued = !!(S.queuedRun && S.queuedRun.sessionId === S.currentConvId);
  if (isCurrentRun) {
    btn.textContent = _t("⏹ 取消");
    btn.classList.add("cancel");
    btn.title = _t("停止当前会话的运行");
  } else if (isCurrentQueued) {
    btn.textContent = _t("⏹ 取消排队");
    btn.classList.add("cancel");
    btn.title = _t("取消当前会话已排队、尚未开始的消息");
  } else {
    btn.textContent = _t("📤 发送");
    btn.classList.remove("cancel");
    btn.title = S.isSending
      ? _t("当前会话未在运行，消息将发送到当前会话（若工作区忙碌会排队等待）")
      : "";
    // 「正在思考」指示器只在 renderMessages 内按 isSending 创建/移除；
    // 超时/取消/断线等路径重置 isSending 后不会触发重渲染，需在此同步移除，
    // 否则出现「指示器还在转但按钮已变回发送」的错位状态
    var indicator = document.getElementById("agent-working-indicator");
    if (indicator) indicator.remove();
  }
}

// ===== 模式切换 =====
export function updateModeToggle() {
  var btn = document.getElementById("agent-mode-toggle");
  if (!btn) return;
  var modeText = btn.querySelector(".mode-text");
  var modeIcon = btn.querySelector(".mode-icon");
  if (S.settings.agent_plan_mode) {
    if (modeText) modeText.textContent = "Plan";
    if (modeIcon) modeIcon.textContent = "📋";
    btn.classList.add("plan");
    btn.title = _t("当前为 Plan 模式（只读调研并产出计划，不修改任何文件），点击切换为执行模式");
  } else {
    if (modeText) modeText.textContent = _t("执行");
    if (modeIcon) modeIcon.textContent = "⚡";
    btn.classList.remove("plan");
    btn.title = _t("当前为执行模式（直接执行修改），点击切换 Plan 模式（只读计划）");
  }
}

// ===== 上下文用量 =====
export function updateContextUsage() {
  var el = document.getElementById("agent-context-usage");
  if (!el) return;
  var currentEl = el.querySelector(".usage-current");
  var maxEl = el.querySelector(".usage-max");

  var used = S.contextUsage.used || 0;
  var max = S.contextUsage.max || 0;

  if (max > 0) {
    var usedStr = (S.contextUsage.estimated && used > 0 ? "~" : "") + formatTokens(used);
    var maxStr = formatTokens(max);
    if (currentEl) currentEl.textContent = usedStr;
    if (maxEl) maxEl.textContent = maxStr;

    // 警告颜色
    var pct = used / max;
    el.classList.remove("warning", "danger");
    if (pct >= 0.95) {
      el.classList.add("danger");
    } else if (pct >= 0.8) {
      el.classList.add("warning");
    }
  } else {
    if (currentEl) currentEl.textContent = "0";
    if (maxEl) maxEl.textContent = "0";
  }

  // 更新状态栏 Token
  var tokenEl = document.getElementById("agent-status-tokens");
  if (tokenEl) {
    tokenEl.textContent = "Token: " + (S.contextUsage.estimated && used > 0 ? "~" : "") + formatTokens(used) + (max > 0 ? " / " + formatTokens(max) : "");
  }
}

// ===== 底部状态栏 =====
export function updateStatusBar(state, workdir, tokens) {
  var stateEl = document.getElementById("agent-status-state");
  var workdirEl = document.getElementById("agent-status-workdir");
  var tokenEl = document.getElementById("agent-status-tokens");

  if (stateEl) {
    var dotClass = "ready";
    var stateText = _t("就绪");
    if (state === "busy") { dotClass = "busy"; stateText = _t("运行中"); }
    else if (state === "error") { dotClass = "error"; stateText = _t("错误"); }
    stateEl.innerHTML = '<span class="status-state-dot ' + dotClass + '"></span>' + stateText;
  }

  if (workdir !== null && workdirEl) {
    workdirEl.textContent = _t("工作区: ") + (workdir || _t("默认"));
    workdirEl.title = workdir || "";
  }

  if (tokenEl && tokens !== null) {
    tokenEl.textContent = "Token: " + formatTokens(tokens);
  }

  // 更新标题栏状态指示器
  var headerStatus = document.getElementById("agent-header-status");
  if (headerStatus) {
    headerStatus.className = "chat-header-status " + (state === "busy" ? "busy" : state === "error" ? "error" : "");
  }
}

// ===== 统一错误/提示展示 =====
// 所有提示（错误/警告/信息）统一走 showNotice 渲染为消息区节点：
//   error 红 / warn 黄 / info 灰，3 秒后自动消失；render.js 增量渲染时保留 error/warn/info 节点。
/**
 * 统一提示入口。
 * @param {string} msg 提示文本
 * @param {"error"|"warn"|"info"} [level] 级别，默认 error
 */
export function showNotice(msg, level) {
  var area = document.getElementById("agent-msg-area");
  if (!area || !msg) return;
  var cls = level === "warn" ? "warn" : level === "info" ? "info" : "error";
  var div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = msg;
  area.appendChild(div);
  S.programmaticScroll = true;
  if (!S.manualScrollMode) area.scrollTop = area.scrollHeight;
  S.programmaticScroll = false;
  updateScrollBottomBtn();
  // 3 秒后自动消失（增量渲染会保留提示节点，需自行清理避免堆积）
  setTimeout(function() { if (div.parentNode) div.remove(); }, 3000);
}

// 统一错误展示入口：传入原始错误（字符串 / Error / 结构化对象均可），
// 内部统一提取文本并分类；quota（余额不足/401）类错误直接显示"余额不足，任务中断"。
/**
 * @param {*} err 原始错误
 * @param {{ prefix?: string, hint?: string, level?: "error"|"warn"|"info" }} [opts] prefix 前缀（如"保存设置失败："），hint 补充提示
 */
export function reportError(err, opts) {
  opts = opts || {};
  var msg = getErrorMessage(err);
  if (!msg) return;
  if (classifyError(err) === ERROR_QUOTA) {
    showNotice(_t("余额不足，任务中断"), "error");
    return;
  }
  showNotice((opts.prefix || "") + msg + (opts.hint || ""), opts.level || "error");
}

export function showError(msg) {
  showNotice(msg, "error");
}

// 非致命提醒（如"本轮已结束但任务可能未完成"）：样式区别于错误，避免用户误判为故障
export function showWarning(msg) {
  showNotice(msg, "warn");
}

// 普通信息提示（如运行完成）
export function showInfo(msg) {
  showNotice(msg, "info");
}

// 清除消息区内的提示（切换/新建会话、切换工作区时调用，避免旧会话提示残留）
export function clearErrorNotices() {
  var area = document.getElementById("agent-msg-area");
  if (!area) return;
  area.querySelectorAll(".msg.error, .msg.warn, .msg.info").forEach(function(e) { e.remove(); });
}

// 应用内确认弹窗（Tauri WebView 中原生 confirm() 非阻塞，不可用）
export function showConfirm(message, onOk) {
  var overlay = document.createElement("div");
  overlay.className = "permission-overlay show";
  overlay.innerHTML =
    '<div class="permission-modal">' +
      '<div class="permission-header">' +
        '<span class="permission-icon">⚠️</span>' +
        '<span class="permission-title">' + _t("确认操作") + '</span>' +
      '</div>' +
      '<div class="permission-body"></div>' +
      '<div class="permission-footer">' +
        '<button class="settings-btn settings-btn-secondary" data-act="cancel">' + _t("取消") + '</button>' +
        '<button class="settings-btn settings-btn-primary" data-act="ok">' + _t("确定") + '</button>' +
      '</div>' +
    '</div>';
  overlay.querySelector(".permission-body").textContent = message;
  function close() { overlay.remove(); }
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-act="ok"]').addEventListener("click", function() {
    close();
    onOk();
  });
  overlay.addEventListener("click", function(e) { if (e.target === overlay) close(); });
  // 挂到视图根节点下，随视图 unmount 一起销毁
  (document.querySelector(".agent-root") || document.body).appendChild(overlay);
}
