// Agent SPA 视图入口 —— 会话列表 + 聊天界面 + 设置弹窗（HTTP API + SSE 驱动）
// 模板 / 共享状态 / 各功能逻辑拆分在 ./agent/ 子模块（原生 ESM，无编译步骤）

import { t as _t } from "../i18n.js";
import { template } from "./agent/template.js";
import { S, invoke, listen, store } from "./agent/store.js";
import { setLogEnabled } from "./agent/log.js";
import { api } from "./agent/api.js";
import { generateUUID, isMsgAreaAtBottom, autoResize, $input, normalizeReasoningEffort } from "./agent/utils.js";
import { updateStatusBar, updateContextUsage, updateModeToggle, updateSendButton, exitManualScrollMode, startSendSafetyTimer, clearSendSafetyTimer, showError, showWarning, showConfirm, showCopyPasteMenu, updateScrollBottomBtn, reportError } from "./agent/ui.js";
import { loadConversations, renderConversationList, selectConversation, newConversation } from "./agent/session.js";
import { syncWorkingIndicator } from "./agent/render.js";
import { sendMessage } from "./agent/send.js";
import { setupSSEListener } from "./agent/sse.js";
import { syncModeToServer } from "./agent/permission.js";
import { loadTools, renderToolsList } from "./agent/tools.js";
import { switchModel, refreshServerProviders, resolveAgentModel, updateModelDropdown, updateModelBtn } from "./agent/model.js";
import { enableAutoCompact, updateWorkspaceSelector, toggleWorkDirDropdown, closeWorkDirDropdown, validateWorkDirs } from "./agent/workspace.js";
import { showSettings, hideSettings, updateSettingsUI, saveSettings, showAddModelDialog, hideAddModelDialog, addModel, initProjectMemoryUI, renderVisionModelSelect } from "./agent/settings_dialog.js";
import { addPendingFiles, parseUriListPaths, addPastedPaths, looksLikeFilePath } from "./agent/attach.js";
import { setAutoContinueEnabled } from "./agent/autocontinue.js";

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

  // 根据 debug_logging 初始值设置前端日志级别
  setLogEnabled(!!S.settings.debug_logging);

  // 更新状态栏
  updateStatusBar("ready", null, 0);

  // 检查 admAgent 是否存在（安装包内置 sidecar，缺失属于安装损坏，无运行时下载兜底）
  try {
    var agentCheck = await invoke("check_adm_agent");
    if (!agentCheck || !agentCheck.exists) {
      showError(_t("未找到 admAgent 组件（应随安装包内置），请重新安装 ADM"));
      updateStatusBar("error", null, 0);
      return;
    }
  } catch (e) {
    reportError(e, { prefix: _t("检查 admAgent 失败: ") });
    updateStatusBar("error", null, 0);
    return;
  }

  // 检查 admAgent server 状态
  try {
    const status = await invoke("get_agent_server_status");
    if (status.running && status.host) {
      S.serverInfo = { host: status.host, workspace_id: status.workspace_id || "" };
      // 复用已运行的 server 时必须同步 client_id：remount 后 S.clientId 已重新生成，
      // 若不更新则 current-session 等接口会因 client_id 不匹配返回 404
      if (status.client_id) S.clientId = status.client_id;
    } else {
      // 启动 server
      try {
        S.serverInfo = await invoke("start_agent_server", { clientId: S.clientId });
      console.log("[agent] Agent 服务已启动, host:", S.serverInfo?.host);
      } catch (e) {
        console.error("[agent] 启动 Agent 服务失败:", e);
        reportError(e, { prefix: _t("启动 Agent 服务失败: ") });
        updateStatusBar("error", null, 0);
        return;
      }
    }
  } catch (e) {
    reportError(e, { prefix: _t("检查 Agent 服务状态失败: ") });
    updateStatusBar("error", null, 0);
    return;
  }
  if (seq !== S.initSeq) return; // 页面已切走/重新挂载，终止过期 init

  // 验证工作目录列表（移除不存在的路径）
  await validateWorkDirs();

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
          // 必须用 setActive 而非 registerWorkspace：setActive 会设置
          // store.activeWsId 并把 S 绑定到该 workspace（bindToS 同步 S.activeWsId）。
          // 否则 store.activeWsId 保持 null —— startRun/completeRun 的 bindToS
          // 不执行、首次切换时旧 workspace 状态不会被保存（切回即丢失）。
          store.setActive(S.workspaceInfo.id);
        }
      } catch (_) {
        S.workspaceInfo = { path: workdir, name: workdir.split(/[\\/]/).pop() };
      }
    } else {
      S.workspaceInfo = { path: "默认", name: _t("默认工作区") };
    }
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, 0);
  } catch (_) {
    S.workspaceInfo = { path: "默认", name: _t("默认工作区") };
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
    } catch (e) {
      // 不阻塞流程（可能已初始化过 / 服务端瞬时未就绪），但不再静默：
      // coordinator 构建失败会导致对话时报「agent coordinator not initialized」，
      // 提前提示让用户知道（发送消息时会自动重试 init，见 send.js）
      console.warn("[agent] /agent/init 失败:", e);
      showWarning(_t("Agent 初始化失败，对话可能暂时无法进行（发送时会自动重试）"));
    }

    // 获取 Agent 信息 (当前模型等)
    try {
      var info = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent");
      store.setAgentInfo(S.serverInfo.workspace_id, info);
      // 更新 contextUsage.max
      if (info && info.model && info.model.context_window) {
        store.setContextUsage(S.serverInfo.workspace_id, S.contextUsage.used, info.model.context_window, S.contextUsage.estimated);
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

  // 监听 SSE 事件（必须先于 loadConversations：selectConversation 会 POST /current-session
  // 上报在场会话，服务端要求该 client_id 已挂活跃 SSE 流，否则返回 404 client not attached）
  await setupSSEListener();
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
  // 发送态对账：S 是模块级状态，isSending/activeRun 跨挂载周期残留；
  // unmount 期间 SSE 监听器已解绑，run_complete 在页面切走时到达会永久丢失，
  // 重新挂载后必须以服务端 is_busy 为准校准，否则「正在思考」永远卡住
  await reconcileSendingState();

  // 工作区选择器点击切换已绑定到 bindEvents 中（下拉列表）

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
    store.cancelRun(store.activeWsId);
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
    store.cancelRun(store.activeWsId);
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
  showError(_t("admAgent 服务异常退出，正在自动重启..."));
  store.cancelRun(store.activeWsId);
  updateSendButton();
  clearSendSafetyTimer();
  updateStatusBar("error", null, S.contextUsage.used);
  try {
    await init();
  } catch (e) {
    console.error("[agent] admAgent 自动重启失败:", e);
    reportError(e, { prefix: _t("admAgent 自动重启失败: ") });
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
          showConfirm(_t("微信 Bot 服务未启动。请先到「设置 → 微信 Bot」扫码绑定并启动服务，再开启微信消息接收。"), function() {});
          return; // 不打开开关
        }
      }
      wxBtn.classList.toggle("on", turningOn);
      try {
        await invoke("set_ilink_follow", { enabled: turningOn });
      } catch (e) {
        wxBtn.classList.toggle("on", !turningOn); // 失败回滚显示
        reportError(e, { prefix: _t("切换微信消息开关失败: ") });
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
  // 项目记忆折叠块交互（默认折叠）
  initProjectMemoryUI();

  // 工作区选择器点击 → 下拉列表
  var wsSelector = document.getElementById("agent-workspace-selector");
  if (wsSelector) {
    wsSelector.style.cursor = "pointer";
    wsSelector.addEventListener("click", function(e) {
      e.stopPropagation();
      toggleWorkDirDropdown();
    });
  }

  // 设置项即时生效：任一字段变更立即应用并持久化（无保存/取消按钮）
  ["settings-plan", "settings-auto-continue", "settings-debug-logging", "settings-reasoning-effort", "settings-temperature", "settings-vision-model"].forEach(function(id) {
    $input(id).addEventListener("change", applySettings);
  });

  // 打开调试日志目录（在系统文件管理器中定位 adm_api_debug.log）
  document.getElementById("settings-open-log-dir").addEventListener("click", async function() {
    try {
      await invoke("open_debug_log_dir");
    } catch (e) {
      reportError(e, { prefix: _t("打开日志目录失败: ") });
    }
  });

  // 从所有设置弹窗字段读取并保存（即时生效，弹窗保持打开）
  async function applySettings() {
    S.settings.agent_reasoning_effort = normalizeReasoningEffort($input("settings-reasoning-effort").value);
    var tempVal = $input("settings-temperature").value;
    S.settings.agent_temperature = tempVal ? parseFloat(tempVal) : null;
    S.settings.agent_plan_mode = $input("settings-plan").checked;
    S.settings.agent_vision_model = $input("settings-vision-model").value || "admAgent/admImage-model";
    setAutoContinueEnabled($input("settings-auto-continue").checked);
    // 调试模式：先同步后端开关（实时生效 + 开启时首次截断日志），再随 settings 持久化。
    // 后端切换失败（如日志文件创建失败）时必须回滚状态，否则会把 debug_logging=true
    // 写盘，造成“勾选着、配置为开、实际没记录”的假开启态（且跨重启延续）。
    var debugLogging = $input("settings-debug-logging").checked;
    try {
      await invoke("set_debug_logging", { enabled: debugLogging });
      S.settings.debug_logging = debugLogging;
      setLogEnabled(debugLogging);
    } catch (e) {
      console.warn("[agent] 切换调试日志失败:", e);
      S.settings.debug_logging = false;
      $input("settings-debug-logging").checked = false;
      reportError(e, { prefix: _t("开启调试日志失败: ") });
    }
    await saveSettings();
    await syncModeToServer();
    updateModeToggle();
    updateModelBtn();
    var selectedKey = S.settings.agent_default_provider || "local";
    var resolved = resolveAgentModel(selectedKey);
    var displayName = selectedKey === "local" ? _t("本地模型") : (S.providers.find(function(p) { return p.key === selectedKey; }) || {}).name || selectedKey;
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
    refreshServerProviders().then(function() {
      updateModelDropdown();
      renderVisionModelSelect();
    });
    document.getElementById("agent-model-dropdown").classList.toggle("show");
  });  document.addEventListener("click", function() {
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
    // 仅支持图片 + 文本类附件（与 attach.js 白名单一致）；其余格式由 addPendingFiles 提示"暂不支持"
    input.accept = "image/*,.txt,.log,.md,.markdown,.json,.csv,.xml,.yaml,.yml,.ini,.conf,.env,.sql,.js,.mjs,.ts,.py,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sh,.bat,.ps1,.html,.css,.scss";
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

  // Ctrl+V 粘贴：图片直读剪贴板 blob；文本等文件（剪贴板只带 file:// 路径）走 Tauri 读取
  var inputEl = document.getElementById("agent-input");
  inputEl.addEventListener("paste", function(e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var clipItems = cd.items;
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
      return;
    }
    // 无图片：尝试读取文件路径（复制文件时剪贴板提供 text/uri-list 或 text/plain 路径）
    // text/uri-list 格式：每行是一个 URI（file:// 或 http(s)），parseUriListPaths 负责解析
    var uriList = cd.getData("text/uri-list");
    var paths = parseUriListPaths(uriList);
    if (paths.length === 0) {
      // 兜底1：text/plain 里可能是文件路径（Windows 资源管理器复制文件常见）。
      // 注意：不能用 parseUriListPaths 解析普通文本 —— 该函数会把任意非空行都当路径，
      // 导致正常文本粘贴被误拦截。必须用 looksLikeFilePath 逐行/整体校验。
      var plain = (cd.getData("text/plain") || "").trim();
      if (plain && looksLikeFilePath(plain)) {
        // 多行且每行都像路径 → 拆成多行各自作为路径
        if (plain.indexOf("\n") >= 0 || plain.indexOf("\r") >= 0) {
          var lines = plain.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
          // 二次校验：只保留真正像路径的行（looksLikeFilePath 对多行返回 true 仅表示每行都像，
          // 但为安全起见再加一次过滤）
          paths = lines.filter(function(l) { return looksLikeFilePath(l); });
          if (paths.length === 0) paths = [];
        } else {
          paths = [plain];
        }
      }
    }
    if (paths.length === 0 && cd.files && cd.files.length > 0) {
      // 兜底2：File 对象（WebView2 可能暴露 .path）
      for (var fi = 0; fi < cd.files.length; fi++) {
        var pf = cd.files[fi];
        if (pf && typeof pf["path"] === "string" && pf["path"]) paths.push(pf["path"]);
      }
    }
    if (paths.length > 0) {
      e.preventDefault();
      addPastedPaths(paths);
      return;
    }
    // 兜底3：WebView2 / WKWebView 不把"复制文件"的文件项暴露给 DataTransfer，
    // 由 Rust 侧直读系统剪贴板（Windows CF_HDROP / macOS NSPasteboard）。
    // 触发条件：DataTransfer 出现非图片 file 项（Windows），或 items 完全为空
    // （macOS WKWebView 对 Finder 复制的文件不暴露任何项、也无 text/uri-list/text/plain，
    // 剪贴板里只有 public.file-url / NSFilenamesPboardType）。复制文本时 items 恒有
    // string 项且剪贴板无文件类型，不会走到这里，无副作用。
    try {
      var hasFileItem = false;
      for (var fi2 = 0; fi2 < clipItems.length; fi2++) {
        if (clipItems[fi2].kind === "file" && clipItems[fi2].type.indexOf("image/") !== 0) {
          hasFileItem = true;
          break;
        }
      }
      if (hasFileItem) {
        e.preventDefault();
        invoke("read_clipboard_files").then(function(files) {
          if (files && files.length > 0) addPastedPaths(files);
        }).catch(function() {});
      } else if (clipItems.length === 0) {
        // macOS WKWebView：默认粘贴本就无内容可插入，无需 preventDefault
        invoke("read_clipboard_files").then(function(files) {
          if (files && files.length > 0) addPastedPaths(files);
        }).catch(function() {});
      }
    } catch (_) {}
  });

  // 标题栏操作按钮
  document.getElementById("agent-undo-btn").addEventListener("click", function() {
    if (!S.currentConvId) return;
    showConfirm(_t("确定撤销上一轮对话？此操作会回退上一轮产生的消息与文件修改。"), function() {
      api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/sessions/" + S.currentConvId + "/undo")
        .then(function() { selectConversation(S.currentConvId); })
        .catch(function(e) { reportError(e, { prefix: _t("撤销失败: ") }); });
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
        if (a) { S.programmaticScroll = true; a.scrollTop = a.scrollHeight; S.programmaticScroll = false; }
      }, 1000);
    });

    // 滚动到底部 → 立即进入自动浏览模式；不在底部 → 进入手动模式（暂停自动滚底）。
    // 用 programmaticScroll 标志区分代码触发的滚动与用户操作，不依赖 :hover，
    // 避免 macOS 触控板滚动时光标不在消息区内导致手动模式无法激活。
    msgArea.addEventListener("scroll", function() {
      if (S.programmaticScroll) { updateScrollBottomBtn(); return; }
      if (isMsgAreaAtBottom(msgArea)) {
        if (S.manualModeExitTimer) { clearTimeout(S.manualModeExitTimer); S.manualModeExitTimer = null; }
        S.manualScrollMode = false;
      } else {
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
        S.programmaticScroll = true;
        msgArea.scrollTop = msgArea.scrollHeight;
        S.programmaticScroll = false;
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
  initDiv.innerHTML = "<strong>⚙ " + _t("项目初始化") + "</strong><p style='margin-top:4px;font-size:12px;color:var(--c-text-2);'>" + _t("检测到项目需要初始化，建议运行初始化流程以启用完整功能。") + "</p>";
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
      reportError(e, { prefix: _t("Agent 页面初始化失败: ") });
    });
  },
  unmount() {
    console.log("[agent] unmount() isSending=" + S.isSending + " activeRun=" + JSON.stringify(S.activeRun));
    // 使在途 init() 失效，防止切走后旧 init 继续执行、或与下次 mount 的新 init 并发互踩
    S.initSeq++;
    S.pendingFiles = [];
    // 关闭工作目录下拉（清理 DOM 和文档级监听器）
    closeWorkDirDropdown();
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

