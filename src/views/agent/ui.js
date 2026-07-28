// 通用 UI：状态栏 / 上下文用量 / 错误与确认弹窗 / 滚动模式 / 安全超时 / 右键菜单
import { S } from "./state.js";
import { api } from "./api.js";
import { formatTokens, isMsgAreaAtBottom } from "./utils.js";

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
    } catch (_) {}
    if (!S.isSending || S.activeRun !== activeRun) return; // 查询期间可能已正常收尾或开始下一轮
    console.warn("[agent] isSending 安全超时 (3min) 且运行会话已不在执行，自动重置");
    S.isSending = false;
    S.activeRun = null;
    updateSendButton();
    updateStatusBar("ready", null, S.contextUsage.used);
    showError("运行超时，已自动重置状态");
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
  menu.style.cssText = "position:fixed;background:#1c2331;border:1px solid #30363d;border-radius:8px;padding:4px 0;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);min-width:100px;";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";

  var hasSelection = false;
  try { hasSelection = window.getSelection().toString().length > 0; } catch (_) {}

  var items = [];
  if (hasSelection) {
    items.push({ label: "复制", action: function() {
      var sel = window.getSelection();
      if (sel && sel.toString()) {
        navigator.clipboard.writeText(sel.toString()).catch(function() {
          document.execCommand("copy");
        });
      }
    }});
  }
  if (targetInput) {
    items.push({ label: "粘贴", action: function() {
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
    mi.style.cssText = "padding:6px 16px;font-size:12px;cursor:pointer;color:#b0b8c8;";
    mi.addEventListener("mouseenter", function() { mi.style.background = "#2a3344"; });
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
  if (S.isSending) {
    btn.textContent = "⏹ 取消";
    btn.classList.add("cancel");
  } else {
    btn.textContent = "📤 发送";
    btn.classList.remove("cancel");
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
  if (S.settings.agent_yolo) {
    if (modeText) modeText.textContent = "YOLO";
    btn.classList.add("yolo");
    btn.title = "当前为 YOLO 模式（跳过权限确认），点击切换为常规模式";
  } else {
    if (modeText) modeText.textContent = "Agent";
    btn.classList.remove("yolo");
    btn.title = "当前为常规模式，点击切换 YOLO 模式（跳过权限确认）";
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
    var stateText = "就绪";
    if (state === "busy") { dotClass = "busy"; stateText = "运行中"; }
    else if (state === "error") { dotClass = "error"; stateText = "错误"; }
    stateEl.innerHTML = '<span class="status-state-dot ' + dotClass + '"></span>' + stateText;
  }

  if (workdir !== null && workdirEl) {
    workdirEl.textContent = "工作区: " + (workdir || "默认");
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

export function showError(msg) {
  var area = document.getElementById("agent-msg-area");
  if (area) {
    var div = document.createElement("div");
    div.className = "msg error";
    div.textContent = msg;
    area.appendChild(div);
    if (!S.manualScrollMode) area.scrollTop = area.scrollHeight;
    updateScrollBottomBtn();
    // 60 秒后自动消失（增量渲染会保留错误节点，需自行清理避免堆积）
    setTimeout(function() { if (div.parentNode) div.remove(); }, 60000);
  }
}

// 清除消息区内的错误提示（切换/新建会话、切换工作区时调用，避免旧会话错误残留）
export function clearErrorNotices() {
  var area = document.getElementById("agent-msg-area");
  if (!area) return;
  area.querySelectorAll(".msg.error").forEach(function(e) { e.remove(); });
}

// 应用内确认弹窗（Tauri WebView 中原生 confirm() 非阻塞，不可用）
export function showConfirm(message, onOk) {
  var overlay = document.createElement("div");
  overlay.className = "permission-overlay show";
  overlay.innerHTML =
    '<div class="permission-modal">' +
      '<div class="permission-header">' +
        '<span class="permission-icon">⚠️</span>' +
        '<span class="permission-title">确认操作</span>' +
      '</div>' +
      '<div class="permission-body"></div>' +
      '<div class="permission-footer">' +
        '<button class="settings-btn settings-btn-secondary" data-act="cancel">取消</button>' +
        '<button class="settings-btn settings-btn-primary" data-act="ok">确定</button>' +
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
