// Agent SPA 视图入口 —— 会话列表 + 聊天界面 + 设置弹窗（HTTP API + SSE 驱动）
// 模板 / 共享状态 / 各功能逻辑拆分在 ./agent/ 子模块（原生 ESM，无编译步骤）

import { template } from "./agent/template.js";
import { S, invoke, listen } from "./agent/state.js";
import { api } from "./agent/api.js";
import { generateUUID, isMsgAreaAtBottom, autoResize, $input } from "./agent/utils.js";
import { updateStatusBar, updateContextUsage, updateModeToggle, updateSendButton, exitManualScrollMode, startSendSafetyTimer, clearSendSafetyTimer, showError, showConfirm, showCopyPasteMenu, updateScrollBottomBtn } from "./agent/ui.js";
import { loadConversations, renderConversationList, selectConversation, newConversation } from "./agent/session.js";
import { syncWorkingIndicator } from "./agent/render.js";
import { sendMessage } from "./agent/send.js";
import { setupSSEListener } from "./agent/sse.js";
import { syncModeToServer } from "./agent/permission.js";
import { loadTools, renderToolsList } from "./agent/tools.js";
import { switchModel, refreshServerProviders, resolveAgentModel, updateModelDropdown, updateModelBtn } from "./agent/model.js";
import { enableAutoCompact, updateWorkspaceSelector } from "./agent/workspace.js";
import { showSettings, hideSettings, updateSettingsUI, saveSettings, showAddModelDialog, hideAddModelDialog, addModel } from "./agent/settings_dialog.js";
import { addPendingFiles } from "./agent/attach.js";

// ===== 初始化 =====
async function init() {
  var seq = ++S.initSeq;
  console.log("[agent] init() 开始, seq:", seq);
  // 生成 clientId (UUID)
  S.clientId = crypto.randomUUID ? crypto.randomUUID() : generateUUID();

  // 加载设置
  try {
    S.settings = await invoke("load_settings");
  } catch (_) {
    S.settings = {};
  }

  // 更新状态栏
  updateStatusBar("ready", null, 0);

  // 检查 admAgent 是否存在（安装包内置 sidecar，缺失属于安装损坏，无运行时下载兜底）
  try {
    var agentCheck = await invoke("check_adm_agent");
    if (!agentCheck || !agentCheck.exists) {
      showError("未找到 admAgent 组件（应随安装包内置），请重新安装 ADM");
      updateStatusBar("error", null, 0);
      return;
    }
  } catch (e) {
    showError("检查 admAgent 失败: " + e);
    updateStatusBar("error", null, 0);
    return;
  }

  // 检查 admAgent server 状态
  try {
    const status = await invoke("get_agent_server_status");
    if (status.running && status.port) {
      S.serverInfo = { port: status.port, workspace_id: status.workspace_id || "" };
    } else {
      // 启动 server
      try {
        S.serverInfo = await invoke("start_agent_server");
      console.log("[agent] Agent 服务已启动, port:", S.serverInfo?.port);
      } catch (e) {
        console.error("[agent] 启动 Agent 服务失败:", e);
        showError("启动 Agent 服务失败: " + e);
        updateStatusBar("error", null, 0);
        return;
      }
    }
  } catch (e) {
    showError("检查 Agent 服务状态失败: " + e);
    updateStatusBar("error", null, 0);
    return;
  }
  if (seq !== S.initSeq) return; // 页面已切走/重新挂载，终止过期 init

  // 加载工作区信息 (获取或创建工作区)
  try {
    var workdir = await invoke("get_agent_workdir");
    if (workdir) {
      // 尝试获取或创建工作区
      try {
        const workspaces = await api("GET", "/v1/workspaces");
        if (Array.isArray(workspaces) && workspaces.length > 0) {
          // 查找匹配的工作区
          const matched = workspaces.find(function(w) { return w.path === workdir; });
          if (matched) {
            S.workspaceInfo = { id: matched.id, path: matched.path, name: matched.path.split(/[\\/]/).pop() };
          }
        }
        // 如果没有匹配的工作区，创建新的
        if (!S.workspaceInfo) {
          const newWs = await api("POST", "/v1/workspaces", {
            path: workdir,
            yolo: true, // 审批模式已移除：权限请求直通，Plan 模式靠服务端只读工具集约束
            client_id: S.clientId
          });
          S.workspaceInfo = { id: newWs.id, path: newWs.path, name: newWs.path.split(/[\\/]/).pop() };
        }
        // 更新 serverInfo 的 workspace_id
        if (S.workspaceInfo && S.workspaceInfo.id) {
          S.serverInfo.workspace_id = S.workspaceInfo.id;
        }
      } catch (_) {
        S.workspaceInfo = { path: workdir, name: workdir.split(/[\\/]/).pop() };
      }
    } else {
      S.workspaceInfo = { path: "默认", name: "默认工作区" };
    }
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, 0);
  } catch (_) {
    S.workspaceInfo = { path: "默认", name: "默认工作区" };
  }
  if (seq !== S.initSeq) return;

  // 加载 provider 列表
  try {
    S.providers = await invoke("list_cloud_providers");
  } catch (_) {
    S.providers = [];
  }

  // 加载服务端 provider 列表（含 admAgent 内置模型）
  await refreshServerProviders();

  // 加载本地模型列表
  try {
    S.localModels = await invoke("scan_local_models");
    if (!Array.isArray(S.localModels)) S.localModels = [];
  } catch (_) {
    S.localModels = [];
  }

  // 初始化 Agent (调用 /agent/init)
  if (S.serverInfo.workspace_id) {
    try {
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/init");
    } catch (_) {
      // 初始化失败不阻塞，可能已经初始化过
    }

    // 获取 Agent 信息 (当前模型等)
    try {
      S.agentInfo = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent");
      // 更新 contextUsage.max
      if (S.agentInfo && S.agentInfo.model && S.agentInfo.model.context_window) {
        S.contextUsage.max = S.agentInfo.model.context_window;
      }
      updateContextUsage();
    } catch (e) {
      console.warn("[agent] 获取 agentInfo 失败:", e);
    }

    // 把本地模式（skip 直通 + Plan 开关）同步到服务端（复用已有工作区时服务端保留的是旧状态，可能与本地不一致）
    await syncModeToServer();

    // 全局默认开启自动压缩（Compact 模式）
    await enableAutoCompact();
  }
  if (seq !== S.initSeq) return;

  // 加载会话列表（restoreCurrent=true：重新挂载时 DOM 已重置，即使 currentConvId 仍有值也必须重新 selectConversation 渲染聊天区）
  await loadConversations(true);

  // 加载工具列表（重新挂载时模板默认 Skill tab 高亮，同步重置状态）
  S.toolsTab = "skill";
  await loadTools();

  // 工具 tab 切换（Skill / LSP / MCP）
  var toolsTabs = document.getElementById("agent-tools-tabs");
  if (toolsTabs) {
    toolsTabs.addEventListener("click", function(e) {
      var tab = /** @type {HTMLElement} */ (e.target).closest(".tools-tab");
      if (!tab) return;
      var mode = /** @type {"skill" | "lsp" | "mcp"} */ (tab.getAttribute("data-tab"));
      if (!mode || mode === S.toolsTab) return;
      S.toolsTab = mode;
      toolsTabs.querySelectorAll(".tools-tab").forEach(function(t) {
        t.classList.toggle("active", t === tab);
      });
      renderToolsList();
    });
  }

  // 更新 UI
  updateModelDropdown();
  updateModeToggle();
  updateSettingsUI();

  if (seq !== S.initSeq) return;
  // 监听 SSE 事件
  await setupSSEListener();

  // 发送态对账：S 是模块级状态，isSending/activeRun 跨挂载周期残留；
  // unmount 期间 SSE 监听器已解绑，run_complete 在页面切走时到达会永久丢失，
  // 重新挂载后必须以服务端 is_busy 为准校准，否则「正在思考」永远卡住
  await reconcileSendingState();

  // SSE 连接建立后重新加载工具列表，确保 skills_event 等发现事件不遗漏
  await loadTools();

  // 工作区选择器为纯展示，不支持点击切换（切换工作目录请去设置弹窗）

  // 检查项目初始化引导
  checkProjectInit();
}

// 重新挂载后校准残留的发送态。
//
// 难点：发送后到模型真正产出 token 之间有「启动窗口」（服务端 readyWg/UpdateModels、
// 本地模型加载，可达数秒）。旧版 admAgent 在此窗口内 is_busy=false，单次快照会把
// 「仍在启动的运行」误判为已结束、抹掉指示器（日志实测：is_busy=false 后 4s 才出首个 token）。
//
// 策略：SSE 已在此前重订，运行若仍活跃，其 run_complete 结束时必会到达并收尾发送态。
// 因此这里乐观保留发送态与指示器，只有在「服务端不忙 且 最后一条已是完成的助手轮次」
// （即运行确已在切走期间结束、run_complete 丢失）时才重置。这样无论后端新旧都正确。
async function reconcileSendingState() {
  if (!S.isSending) return;
  var run = S.activeRun;
  if (!run) {
    S.isSending = false;
    updateSendButton();
    updateStatusBar("ready", null, S.contextUsage.used);
    return;
  }

  // 先乐观恢复运行态 UI（指示器/按钮是纯 DOM，重新挂载后不会随 S 残留）
  updateSendButton();
  syncWorkingIndicator();
  startSendSafetyTimer();

  var busy = true; // 查询失败时保守当作仍在运行，交由 SSE / 安全计时器兜底
  try {
    var sess = await api("GET", "/v1/workspaces/" + run.workspaceId + "/sessions/" + run.sessionId);
    busy = !!(sess && sess.is_busy);
  } catch (_) {}
  if (S.activeRun !== run || !S.isSending) return; // 期间已被 SSE/取消收尾
  console.log("[agent] reconcile 对账: is_busy=" + busy + " lastFinished=" + lastAssistantTurnFinished());

  // 仅当服务端确认不忙、且消息区已存在完成的助手轮次时，才认定运行已结束并重置。
  // 启动窗口内（尚无助手输出）即便 is_busy=false 也保留指示器，等待 SSE 流继续。
  if (!busy && lastAssistantTurnFinished()) {
    console.warn("[agent] 挂载对账：运行会话已结束，重置发送态");
    S.isSending = false;
    S.activeRun = null;
    clearSendSafetyTimer();
    updateSendButton();
    updateStatusBar("ready", null, S.contextUsage.used);
  }
}

// 当前消息列表的最后一条是否为「已完成的助手轮次」（带 finish part）。
// 运行结束时助手消息以 finish 收尾；用于判断运行是否已在页面切走期间结束。
function lastAssistantTurnFinished() {
  var msgs = S.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return false;
  var last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant") return false;
  return Array.isArray(last.parts) && last.parts.some(function(p) { return p && p.type === "finish"; });
}

// ===== admAgent server 意外退出自愈 =====
// 后端 SSE 转发循环检测到 admAgent 进程消失时 emit "agent-server-died"，
// 这里防重入地重跑一遍 init（重启 server、恢复工作区与会话）
var serverRestarting = false;
async function handleServerDied() {
  if (serverRestarting) return;
  serverRestarting = true;
  console.warn("[agent] admAgent server 意外退出，自动重启中...");
  showError("admAgent 服务异常退出，正在自动重启...");
  S.isSending = false;
  S.activeRun = null;
  updateSendButton();
  clearSendSafetyTimer();
  updateStatusBar("error", null, S.contextUsage.used);
  try {
    await init();
  } catch (e) {
    console.error("[agent] admAgent 自动重启失败:", e);
    showError("admAgent 自动重启失败: " + e);
  } finally {
    serverRestarting = false;
  }
}

// ===== 事件绑定 =====
function bindEvents() {
  // 新会话
  document.getElementById("agent-new-chat").addEventListener("click", newConversation);

  // 微信消息开关（模型选择旁）：开 = 微信 Bot 消息注入当前打开的会话
  // 只有微信 Bot 服务已启动（state===running）才允许开启；未启动弹提示引导去设置页。
  (function() {
    var wxBtn = document.getElementById("agent-wx-follow-btn");
    if (!wxBtn) return;
    // 读取持久化的开关状态（仅当服务运行中时才显示为开）
    invoke("get_ilink_status").then(function(st) {
      wxBtn.classList.toggle("on", !!(st && st.follow && st.state === "running"));
    }).catch(function() {});
    wxBtn.addEventListener("click", async function() {
      var turningOn = !wxBtn.classList.contains("on");
      if (turningOn) {
        // 开启前先确认微信 Bot 服务已绑定且运行中
        var st = null;
        try { st = await invoke("get_ilink_status"); } catch (_) {}
        if (!st || !st.bound || st.state !== "running") {
          showConfirm("微信 Bot 服务未启动。请先到「设置 → 微信 Bot」扫码绑定并启动服务，再开启微信消息接收。", function() {});
          return; // 不打开开关
        }
      }
      wxBtn.classList.toggle("on", turningOn);
      try {
        await invoke("set_ilink_follow", { enabled: turningOn });
      } catch (e) {
        wxBtn.classList.toggle("on", !turningOn); // 失败回滚显示
        showError("切换微信消息开关失败: " + e);
      }
    });
  })();

  // 会话视图切换
  document.querySelectorAll(".toggle-item").forEach(function(item) {
    item.addEventListener("click", function() {
      document.querySelectorAll(".toggle-item").forEach(function(i) { i.classList.remove("active"); });
      item.classList.add("active");
      S.sessionViewMode = item.getAttribute("data-mode") === "all" ? "all" : "current";
      renderConversationList();
    });
  });

  // 设置按钮 (在侧栏底部)
  document.getElementById("agent-settings-btn").addEventListener("click", showSettings);
  document.getElementById("agent-settings-close").addEventListener("click", hideSettings);
  document.getElementById("agent-settings-cancel").addEventListener("click", hideSettings);
  document.getElementById("agent-settings-save").addEventListener("click", doSaveAndClose);

  // 浏览工作目录
  document.getElementById("settings-browse-btn").addEventListener("click", async function() {
    try {
      var dir = await invoke("pick_workdir_folder");
      if (dir) {
        $input("settings-workdir").value = dir;
        await doSaveAndClose();
      }
    } catch (_) {}
  });

  // 工作目录输入框变更时自动保存
  $input("settings-workdir").addEventListener("change", async function() {
    if ($input("settings-workdir").value.trim()) await doSaveAndClose();
  });

  // 从所有设置弹窗字段读取并保存，然后关闭
  async function doSaveAndClose() {
    S.settings.agent_reasoning_effort = $input("settings-reasoning-effort").value;
    var tempVal = $input("settings-temperature").value;
    S.settings.agent_temperature = tempVal ? parseFloat(tempVal) : null;
    S.settings.agent_plan_mode = $input("settings-plan").checked;
    await saveSettings();
    await syncModeToServer();
    hideSettings();
    updateModeToggle();
    updateModelBtn();
    var selectedKey = S.settings.agent_default_provider || "local";
    var resolved = resolveAgentModel(selectedKey);
    var displayName = selectedKey === "local" ? "本地模型" : (S.providers.find(function(p) { return p.key === selectedKey; }) || {}).name || selectedKey;
    if (resolved && resolved.model) {
      await switchModel(selectedKey, displayName, resolved.context_window || 0);
    }
  }

  // 云端模型管理
  document.getElementById("agent-add-cloud-btn").addEventListener("click", showAddModelDialog);

  // 模式切换 (工具栏)：执行 ↔ Plan（只读计划）
  document.getElementById("agent-mode-toggle").addEventListener("click", async function() {
    S.settings.agent_plan_mode = !S.settings.agent_plan_mode;
    updateModeToggle();
    await saveSettings();
    // 实时同步到服务端，对话中途切换下一轮生效
    await syncModeToServer();
  });

  // 模型下拉
  document.getElementById("agent-model-btn").addEventListener("click", function(e) {
    e.stopPropagation();
    updateModelDropdown();
    // 异步刷新服务端 provider 列表（含内置模型），完成后重渲染
    refreshServerProviders().then(function() { updateModelDropdown(); });
    document.getElementById("agent-model-dropdown").classList.toggle("show");
  });
  document.addEventListener("click", function() {
    var dd = document.getElementById("agent-model-dropdown");
    if (dd) dd.classList.remove("show");
  });

  // 模型添加
  document.getElementById("agent-add-model-close").addEventListener("click", hideAddModelDialog);
  document.getElementById("add-model-submit").addEventListener("click", addModel);

  // 附件按钮
  document.getElementById("agent-attach-btn").addEventListener("click", function() {
    var input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*";
    input.onchange = function() {
      var files = input.files;
      if (files && files.length > 0) {
        addPendingFiles(files);
      }
    };
    input.click();
  });

  // 输入区域拖放附件
  var inputArea = document.querySelector(".input-area");
  if (inputArea) {
    inputArea.addEventListener("dragover", function(e) {
      e.preventDefault();
      e.stopPropagation();
      inputArea.classList.add("drag-over");
    });
    inputArea.addEventListener("dragleave", function(e) {
      e.preventDefault();
      e.stopPropagation();
      inputArea.classList.remove("drag-over");
    });
    inputArea.addEventListener("drop", function(e) {
      e.preventDefault();
      e.stopPropagation();
      inputArea.classList.remove("drag-over");
      var dt = /** @type {DragEvent} */ (e).dataTransfer;
      var files = dt && dt.files;
      if (files && files.length > 0) {
        addPendingFiles(files);
      }
    });
  }

  // Ctrl+V 粘贴图片
  var inputEl = document.getElementById("agent-input");
  inputEl.addEventListener("paste", function(e) {
    var clipItems = e.clipboardData && e.clipboardData.items;
    if (!clipItems) return;
    var imageFiles = [];
    for (var i = 0; i < clipItems.length; i++) {
      if (clipItems[i].type.indexOf("image/") === 0) {
        var f = clipItems[i].getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addPendingFiles(imageFiles);
    }
  });

  // 标题栏操作按钮
  document.getElementById("agent-undo-btn").addEventListener("click", function() {
    if (!S.currentConvId) return;
    showConfirm("确定撤销上一轮对话？此操作会回退上一轮产生的消息与文件修改。", function() {
      api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/sessions/" + S.currentConvId + "/undo")
        .then(function() { selectConversation(S.currentConvId); })
        .catch(function(e) { showError("撤销失败: " + e); });
    });
  });

  // Todo 固定面板：点击头部折叠/展开（状态存 S，重新渲染不丢）
  document.getElementById("agent-todos-header").addEventListener("click", function() {
    S.todosCollapsed = !S.todosCollapsed;
    document.getElementById("agent-todos-panel").classList.toggle("collapsed", S.todosCollapsed);
  });

  // 输入框
  var input = document.getElementById("agent-input");
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener("input", function() { autoResize(input); });

  // 发送
  document.getElementById("agent-send-btn").addEventListener("click", sendMessage);

  // 右键菜单：消息区域 → 复制/粘贴
  var msgArea = document.getElementById("agent-msg-area");
  if (msgArea) {
    msgArea.addEventListener("contextmenu", function(e) {
      showCopyPasteMenu(e, null);
    });

    // 手动/自动滚动模式：鼠标进入消息区且不在底部 → 手动模式（暂停自动滚底，可上滑、可点开/合上推理过程）；
    // 鼠标离开 1 秒后 → 恢复自动模式并滚到底部
    msgArea.addEventListener("mouseenter", function() {
      if (S.manualModeExitTimer) { clearTimeout(S.manualModeExitTimer); S.manualModeExitTimer = null; }
      S.manualScrollMode = !isMsgAreaAtBottom(msgArea);
    });
    msgArea.addEventListener("mouseleave", function() {
      if (S.manualModeExitTimer) clearTimeout(S.manualModeExitTimer);
      S.manualModeExitTimer = setTimeout(function() {
        S.manualModeExitTimer = null;
        S.manualScrollMode = false;
        var a = document.getElementById("agent-msg-area");
        if (a) a.scrollTop = a.scrollHeight;
      }, 1000);
    });

    // 滚动到底部 → 立即进入自动浏览模式（即使鼠标还在消息区内）；鼠标在区内向上滚离底部 → 回到手动模式
    msgArea.addEventListener("scroll", function() {
      if (isMsgAreaAtBottom(msgArea)) {
        if (S.manualModeExitTimer) { clearTimeout(S.manualModeExitTimer); S.manualModeExitTimer = null; }
        S.manualScrollMode = false;
      } else if (msgArea.matches(":hover")) {
        // :hover 判断避免鼠标已离开时手动模式下的程序化滚动（恢复 prevScrollTop）误触发重新进入手动模式
        S.manualScrollMode = true;
      }
      updateScrollBottomBtn();
    });

    // 回到底部悬浮圆球：点击滚到底部并进入自动浏览模式，圆球随之隐藏
    var scrollBottomBtn = document.getElementById("agent-scroll-bottom-btn");
    if (scrollBottomBtn) {
      scrollBottomBtn.addEventListener("click", function() {
        if (S.manualModeExitTimer) { clearTimeout(S.manualModeExitTimer); S.manualModeExitTimer = null; }
        S.manualScrollMode = false;
        msgArea.scrollTop = msgArea.scrollHeight;
        updateScrollBottomBtn();
      });
    }
  }

  // 右键菜单：输入框 → 复制/粘贴
  var inputForCtx = document.getElementById("agent-input");
  if (inputForCtx) {
    inputForCtx.addEventListener("contextmenu", function(e) {
      showCopyPasteMenu(e, inputForCtx);
    });
  }

  // 禁用其它区域右键：消息区/输入框的自定义右键已 stopPropagation 不会冒泡到这里，
  // 其余冒泡到 .agent-root 的 contextmenu 一律屏蔽浏览器默认菜单
  var agentRoot = document.querySelector(".agent-root");
  if (agentRoot) {
    agentRoot.addEventListener("contextmenu", function(e) {
      e.preventDefault();
    });
  }
}

// ===== 项目初始化引导 =====
async function checkProjectInit() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    var resp = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/project/needs-init");
    if (resp && resp.needs_init) {
      showProjectInitDialog();
    }
  } catch (_) {
    // 端点不存在时忽略
  }
}

function showProjectInitDialog() {
  var overlay = document.getElementById("agent-settings-overlay");
  var body = overlay ? overlay.querySelector(".settings-body") : null;
  if (!body) return;

  // 显示初始化引导提示
  var initDiv = document.createElement("div");
  initDiv.style.cssText = "background:rgba(var(--c-accent-rgb),0.1);border:1px solid var(--c-accent);border-radius:8px;padding:12px;margin-bottom:16px;";
  initDiv.innerHTML = "<strong>� 项目初始化</strong><p style='margin-top:4px;font-size:12px;color:var(--c-text-2);'>检测到项目需要初始化，建议运行初始化流程以启用完整功能。</p>";
  body.insertBefore(initDiv, body.firstChild);
}

// ===== 生命周期 =====
export default {
  template,
  mount(root, params) {
    console.log("[agent] mount() params:", params);
    root.innerHTML = template;
    bindEvents();
    // 监听 admAgent server 意外退出（unmount 时经 S.unlisteners 统一解绑）
    if (typeof listen === "function") {
      listen("agent-server-died", handleServerDied)
        .then(function(u) { S.unlisteners.push(u); })
        .catch(function() {});
      // 微信端 /plan、/yolo 切换模式后，Rust 发此事件让 Agent 页按钮跟随（两端一致）。
      // 仅更新内存态 + 按钮：config.json 已由微信端写盘、服务端已同步，无需再 save/sync 避免回环。
      listen("agent-mode-changed", function(e) {
        if (!S.settings) return;
        S.settings.agent_plan_mode = !!(e && e.payload && e.payload.plan);
        updateModeToggle();
      })
        .then(function(u) { S.unlisteners.push(u); })
        .catch(function() {});
    }
    // init 是 fire-and-forget，必须兜底 catch，否则任何未捕获异常都是静默死亡（表现为页面空白无报错）
    init().catch(function(e) {
      console.error("[agent] init() 未捕获异常:", e);
      showError("Agent 页面初始化失败: " + e);
    });
  },
  unmount() {
    console.log("[agent] unmount() isSending=" + S.isSending + " activeRun=" + JSON.stringify(S.activeRun));
    // 使在途 init() 失效，防止切走后旧 init 继续执行、或与下次 mount 的新 init 并发互踩
    S.initSeq++;
    S.pendingFiles = [];
    // 重置手动滚动模式
    exitManualScrollMode();
    clearSendSafetyTimer();
    // 停止 SSE 监听
    if (S.sseListener) { try { S.sseListener(); } catch (_) {} S.sseListener = null; }
    if (S.sseErrorUnlisten) { try { S.sseErrorUnlisten(); } catch (_) {} S.sseErrorUnlisten = null; }
    // 清除重连定时器
    if (S.sseReconnectTimer) { clearTimeout(S.sseReconnectTimer); S.sseReconnectTimer = null; }
    // 注意：这里不调 agent_unsubscribe_events。它是异步 fire-and-forget，快速切回时可能在新页面
    // agent_subscribe_events 之后才在后端执行，把新订阅的 sse_stop 置 true → 新 SSE 静默失效。
    // setupSSEListener 订阅时后端会自动停止旧转发任务，因此无需在此主动退订；
    // 前端监听器（sseListener）已在上方解绑，后台事件不会被处理。
    // 清理事件监听
    S.unlisteners.forEach(function(u) { try { if (typeof u === "function") u(); } catch (_) {} });
    S.unlisteners = [];
  }
};

