// 工作区切换 / 选择器 / 自动压缩配置
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { updateContextUsage, exitManualScrollMode, clearErrorNotices, reportError, clearSendSafetyTimer, updateStatusBar, showConfirm } from "./ui.js";
import { log } from "./log.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, renderConversationList, syncWxFollowSession } from "./session.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, refreshServerProviders, updateModelDropdown } from "./model.js";
import { resetPermissionState, syncModeToServer } from "./permission.js";

// ===== 会话上下文压缩 =====
// 全局默认开启自动压缩（Compact 模式）：上下文接近上限时服务端自动生成摘要压缩，
// 无需用户手动干预（scope=0 全局配置，幂等，每次初始化确保开启，不提供设置开关）
export async function enableAutoCompact() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/compact", {
      scope: 0,
      enabled: true
    });
    console.log("[agent] 自动压缩（Compact 模式）已开启");
  } catch (e) {
    console.warn("[agent] 开启自动压缩失败:", e);
  }
}

// ===== 工作区切换 =====
// 多 workspace 架构：切换 tab 时保存当前 workspace 状态到状态池，
// 恢复目标 workspace 状态。旧 workspace 的 agent run 在后台继续执行。
export async function switchToWorkspace(wsId, wsPath) {
  if (!wsId) return;
  log.debug("WS", "workspace.switchTo: " + wsId + " path=" + wsPath);

  // 在 setActive 之前判断是否首次访问：
  // store.setActive → registerWorkspace 会创建空快照，之后 S.workspaces[wsId] 永远 truthy
  var isFirstVisit = !store.workspaces.has(wsId);

  // 通知 Rust 后端切换激活 workspace（用于微信路由等）
  try { await invoke("switch_workspace", { workspaceId: wsId }); } catch (_) {}

  // Store 统一处理：保存旧 workspace 状态 + 切换 activeWsId + 恢复目标 workspace
  store.setActive(wsId);
  S.workspaceInfo = { id: wsId, path: wsPath || "", name: wsPath ? wsPath.split(/[\\/]/).pop() : _t("默认工作区") };

  if (!isFirstVisit) {
    // 恢复已保存的状态（store.setActive 已恢复，但 UI 需手动刷新）
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    renderConversationList();
    updateContextUsage();
    updateStatusBar(S.isSending ? "busy" : "ready", wsPath || null, S.contextUsage.used);
    // 刷新服务端数据：后台运行可能已更新会话标题、上下文用量、Agent 信息
    loadConversations();
    refreshAgentInfo();
  } else {
    // 首次进入该 workspace：初始化
    clearSendSafetyTimer();
    resetPermissionState();
    exitManualScrollMode();
    clearErrorNotices();
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");

    // 重新初始化 Agent
    try { await api("POST", "/v1/workspaces/" + wsId + "/agent/init"); } catch (_) {}
    await syncModeToServer();
    await enableAutoCompact();
    try {
      var info = await api("GET", "/v1/workspaces/" + wsId + "/agent");
      store.setAgentInfo(wsId, info);
      if (info && info.model && info.model.context_window) {
        store.setContextUsage(wsId, S.contextUsage.used, info.model.context_window, S.contextUsage.estimated);
      }
    } catch (_) {}
    // SSE 监听是全局的（后端为每个 workspace 独立转发），不需要重新订阅
    // 刷新对话列表
    await loadConversations();
    await loadTools();
    updateContextUsage();
    updateStatusBar("ready", wsPath || null, 0);
    // 首次进入后保存到状态池（store.setActive 已注册，store 方法写入时自动快照）
  }

  // 刷新云端模型列表：切换 workspace 后目标 workspace 的服务端 ConfigStore 可能过期
  // （在另一个 workspace 添加云端模型时 config/set scope:0 只触发当前 workspace 的 autoReload），
  // 需要重新加载 S.providers（全局 admAgent.json，始终最新）、触发目标 workspace 配置重载、
  // 再拉取 /providers 快照并更新模型下拉。
  await refreshProvidersOnSwitch(wsId);

  updateWorkspaceSelector();
  // 切换工作区后同步微信 follow session，防止微信消息仍用旧 workspace 的 session ID
  syncWxFollowSession();
}

// 切换 workspace 后刷新云端模型 provider 列表。
// 1) 从 admAgent.json 重新加载 S.providers（全局文件，始终最新）
// 2) 对目标 workspace 触发一次 config/set（scope:0），强制其 ConfigStore autoReload，
//    从而拾取全局配置文件中其他 workspace 添加的云端模型
// 3) 拉取目标 workspace 的 /providers 快照并更新模型下拉
async function refreshProvidersOnSwitch(wsId) {
  try {
    S.providers = await invoke("list_cloud_providers");
  } catch (_) {
    S.providers = [];
  }

  // 目标 workspace 的 ConfigStore 可能未加载最新的全局配置（cloud providers 在
  // 其他 workspace 通过 config/set scope:0 写入全局文件时只触发了那个 workspace 的
  // autoReload）。用第一个 provider 的 api_key 做一次幂等 config/set 来触发 reload。
  if (S.providers.length > 0 && S.serverInfo) {
    var trigger = S.providers[0];
    try {
      await api("POST", "/v1/workspaces/" + wsId + "/config/set", {
        scope: 0,
        key: "providers." + trigger.key + ".api_key",
        value: trigger.api_key || ""
      });
    } catch (_) {}
  }

  // 重置服务端快照（旧快照属于上一个 workspace），重新拉取目标 workspace 的 provider 列表
  S.serverProviders = [];
  S.serverProvidersLoaded = false;
  await refreshServerProviders();
  updateModelDropdown();
}

// ===== 工作区下拉列表 =====

// 当前下拉是否展开
var dropdownOpen = false;
// 文档级关闭处理函数引用，用于在 closeWorkDirDropdown 时显式移除
var docCloseHandler = null;

// 关闭下拉（点击外部时调用）
export function closeWorkDirDropdown() {
  dropdownOpen = false;
  var dd = document.getElementById("workdir-dropdown");
  if (dd) dd.remove();
  if (docCloseHandler) {
    document.removeEventListener("click", docCloseHandler);
    docCloseHandler = null;
  }
  // 移除 scroll/resize 监听
  window.removeEventListener("scroll", closeWorkDirDropdown, true);
  window.removeEventListener("resize", closeWorkDirDropdown);
}

// 打开/关闭下拉
export async function toggleWorkDirDropdown() {
  if (dropdownOpen) {
    closeWorkDirDropdown();
    return;
  }
  dropdownOpen = true;
  await renderWorkDirDropdown();
}

// 渲染下拉列表
async function renderWorkDirDropdown() {
  var selector = document.getElementById("agent-workspace-selector");
  if (!selector) return;

  // 移除旧的下拉
  var old = document.getElementById("workdir-dropdown");
  if (old) old.remove();

  var dirs = [];
  try {
    dirs = await invoke("get_workdirs");
  } catch (e) {
    console.warn("[agent] 加载工作目录列表失败:", e);
  }

  var dd = document.createElement("div");
  dd.id = "workdir-dropdown";
  dd.className = "workdir-dropdown";

  // 工作目录列表项
  dirs.forEach(function(d) {
    var item = document.createElement("div");
    item.className = "workdir-dropdown-item" + (d.is_default ? " active" : "");
    var marker = d.is_default ? "▸ " : "  ";
    var label = document.createElement("span");
    label.className = "workdir-dropdown-label";
    label.textContent = marker + d.path;
    label.title = d.path;
    label.style.flex = "1";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    item.appendChild(label);
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "4px";

    // 删除按钮（当前默认目录不可删除）
    if (!d.is_default) {
      var delBtn = document.createElement("span");
      delBtn.textContent = "✕";
      delBtn.className = "workdir-dropdown-del";
      delBtn.title = _t("移除");
      delBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        // 移除前确认，避免误删工作目录
        showConfirm(_t("确定要移除工作目录「") + d.path + _t("」吗？"), async function() {
          try {
            await invoke("remove_workdir", { path: d.path });
            closeWorkDirDropdown();
          } catch (err) {
            reportError(err, { prefix: _t("移除工作目录失败: ") });
          }
        });
      });
      item.appendChild(delBtn);
    }

    // 点击整行切换（用 classList 判断删除按钮，避免 delBtn 闭包未定义问题）
    item.addEventListener("click", async function(e) {
      if (e.target instanceof Element && e.target.classList.contains("workdir-dropdown-del")) return;
      e.stopPropagation();
      closeWorkDirDropdown();
      if (!d.is_default) {
        await doSwitchWorkDir(d.path);
      }
    });
    dd.appendChild(item);
  });

  // 分隔线（如果列表非空）
  if (dirs.length > 0) {
    var sep = document.createElement("div");
    sep.className = "workdir-dropdown-sep";
    dd.appendChild(sep);
  }

  // 添加工作目录
  var addBtn = document.createElement("div");
  addBtn.className = "workdir-dropdown-item add";
  addBtn.textContent = "＋ " + _t("添加工作目录");
  addBtn.addEventListener("click", async function(e) {
    e.stopPropagation();
    closeWorkDirDropdown();
    try {
      var dir = await invoke("pick_workdir_folder");
      if (dir) {
        await invoke("add_workdir", { path: dir });
        await doSwitchWorkDir(dir);
      }
    } catch (err) {
      reportError(err, { prefix: _t("添加工作目录失败: ") });
    }
  });
  dd.appendChild(addBtn);

  selector.appendChild(dd);

  // 点击外部关闭（存储引用以便 closeWorkDirDropdown 显式移除）
  docCloseHandler = function() { closeWorkDirDropdown(); };
  setTimeout(function() {
    document.addEventListener("click", docCloseHandler);
    // scroll/resize 时也关闭下拉（position:absolute 不跟随页面滚动）
    window.addEventListener("scroll", closeWorkDirDropdown, true);
    window.addEventListener("resize", closeWorkDirDropdown);
  }, 0);
}

// 执行工作目录切换：在已运行的 server 上创建新 workspace，成功后切换 tab
async function doSwitchWorkDir(path) {
  try {
    if (!S.serverInfo || !S.serverInfo.workspace_id) {
      reportError(new Error("server not ready"), { prefix: _t("切换工作目录失败: ") });
      return;
    }
    // 通过 Rust 后端创建 workspace（启动独立 SSE 转发）
    var wsInfo = await invoke("create_workspace", { path: path, clientId: S.clientId });
    if (!wsInfo || !wsInfo.workspace_id) {
      reportError(new Error("server returned no workspace id"), { prefix: _t("切换工作目录失败: ") });
      return;
    }
    // 设为默认工作目录
    await invoke("set_default_workdir", { path: path });
    // 切换到新 workspace（保存旧状态，恢复新状态）
    await switchToWorkspace(wsInfo.workspace_id, path);
  } catch (e) {
    reportError(e, { prefix: _t("切换工作目录失败: ") });
  }
}

// 启动时验证工作目录列表（移除不存在的路径）
export async function validateWorkDirs() {
  try {
    var removed = await invoke("validate_workdirs");
    if (removed && removed.length > 0) {
      removed.forEach(function(path) {
        console.warn("[agent] 工作目录不存在，已从配置移除:", path);
      });
    }
  } catch (e) {
    console.warn("[agent] 验证工作目录失败:", e);
  }
}

// ===== 工作区展示（可点击切换） =====
export function updateWorkspaceSelector() {
  var nameEl = document.getElementById("agent-workspace-name");
  if (!nameEl) return;

  var name = S.workspaceInfo ? S.workspaceInfo.name || _t("默认工作区") : _t("默认工作区");
  nameEl.textContent = name + " ▾";
  nameEl.title = S.workspaceInfo ? S.workspaceInfo.path || "" : "";
}
