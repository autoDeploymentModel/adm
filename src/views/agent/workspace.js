// 工作区切换 / 选择器 / 自动压缩配置
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { updateContextUsage, exitManualScrollMode, clearErrorNotices, reportError, clearSendSafetyTimer, updateStatusBar, updateSendButton, showConfirm, showInitProgress, hideInitProgress } from "./ui.js";
import { log } from "./log.js";
import { modelContextWindow } from "./utils.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, renderConversationList, syncWxFollowSession } from "./session.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, refreshServerProviders, updateModelDropdown } from "./model.js";
import { resetPermissionState, syncModeToServer } from "./permission.js";
import { reconcilePdfBatching } from "./pdf_batch.js";
import { updateDecisionModeUI } from "./decision_mode.js";

// ===== 会话上下文压缩 =====
// 全局默认开启自动压缩（Compact 模式）：上下文接近上限时服务端自动生成摘要压缩，
// 无需用户手动干预（scope=0 全局配置，幂等，每次初始化确保开启，不提供设置开关）
// 已成功开启的 workspace：服务端侧 SetCompactMode 对「同值」也会跳过写盘，这里再挡一层，
// 避免每次切回都发一次无意义的请求。
var autoCompactEnabledFor = new Set();

export async function enableAutoCompact() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  var wsId = S.serverInfo.workspace_id;
  if (autoCompactEnabledFor.has(wsId)) return;
  try {
    await api("POST", "/v1/workspaces/" + wsId + "/config/compact", {
      scope: 0,
      enabled: true
    });
    autoCompactEnabledFor.add(wsId);
    console.log("[agent] 自动压缩（Compact 模式）已开启");
  } catch (e) {
    console.warn("[agent] 开启自动压缩失败:", e);
  }
}

// ===== 工作区切换 =====

// 按当前状态池的会话重算标题栏文本（会话列表比 currentConv 新时以列表为准）。
// currentConvId 为空时不动 DOM：此时 loadConversations 会自动选中/新建会话并自行写标题，
// 这里抢先写占位文案会把「新会话」冲掉。
function syncConvTitle() {
  if (!S.currentConvId) return;
  var titleEl = document.getElementById("agent-conv-title");
  if (!titleEl) return;
  var conv = null;
  var list = S.conversations || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === S.currentConvId) { conv = list[i]; break; }
  }
  if (!conv) conv = S.currentConv;
  titleEl.textContent = (conv && conv.title) ? conv.title : _t("选择或创建一个会话");
}

// 多 workspace 架构：切换 tab 时保存当前 workspace 状态到状态池，
// 恢复目标 workspace 状态。旧 workspace 的 agent run 在后台继续执行。
//
// 性能约定（切换卡顿的根治点）：
// - 本地状态与可见文案先落地：点击后立即看到新工作目录名与已缓存会话，
//   不再等所有网络请求跑完才更新选择器（原实现最后一步才 updateWorkspaceSelector）；
// - 只有「必须先完成」的请求串行等待（首访 /agent/init，随后 /sessions），
//   其余并发或 fire-and-forget（原来首访是 8+ 次串行往返 + 3 次配置文件写入）；
// - 不再用 config/set 触发配置重载：改调只读的 /config/reload（见 refreshProvidersOnSwitch）。
export async function switchToWorkspace(wsId, wsPath) {
  if (!wsId) return;
  var switchStart = performance.now();
  log.debug("WS", "workspace.switchTo: " + wsId + " path=" + wsPath);

  // 在 setActive 之前判断是否首次访问：
  // store.setActive → registerWorkspace 会创建空快照，之后 S.workspaces[wsId] 永远 truthy
  var isFirstVisit = !store.workspaces.has(wsId);

  // Store 统一处理：保存旧 workspace 状态 + 切换 activeWsId + 恢复目标 workspace
  store.setActive(wsId);
  S.workspaceInfo = { id: wsId, path: wsPath || "", name: wsPath ? wsPath.split(/[\\/]/).pop() : _t("默认工作区") };
  // 记录 path → wsId 映射，供 remove_workdir / validate_workdirs 清理状态池使用
  if (wsPath) S.wsIdByPath[wsPath] = wsId;

  // 立刻刷新可见状态（工作目录名 / 决策模式 / 状态栏 / 发送按钮）：
  // 切换的「卡顿感」主要来自这里——旧实现把选择器更新放在最后一个 await 之后。
  updateWorkspaceSelector();
  updateDecisionModeUI();
  updateStatusBar(S.isSending ? "busy" : "ready", wsPath || null, S.contextUsage.used);
  updateSendButton();

  // 通知 Rust 后端切换激活 workspace（用于微信路由等）。纯内存操作，仍 await 以保住
  // 「先切 active、再做后续同步」的顺序；它排在可见 UI 更新之后，不拖首帧。
  try { await invoke("switch_workspace", { workspaceId: wsId }); } catch (_) {}

  if (!isFirstVisit) {
    // 恢复已保存的状态（store.setActive 已恢复，但 UI 需手动刷新）
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    renderConversationList();
    updateContextUsage();
    // 标题栏必须按恢复后的会话重算：store 只恢复数据不改 DOM，
    // 不重算会保留上一个工作区的会话标题（切回老工作区时标题栏停留旧工作区的对话记录）
    syncConvTitle();
    // 切回工作区后对账 PDF 批次（其它 tab 期间 run_complete 被按 active workspace 过滤）
    reconcilePdfBatching();
    // 同步微信 follow session，防止微信消息仍用旧 workspace 的 session ID
    syncWxFollowSession();

    // 后台刷新服务端数据（后台运行可能已更新会话标题、上下文用量、Agent 信息）：
    // 全部 fire-and-forget，切换动画和首屏渲染不等它们
    loadConversations().then(syncConvTitle).catch(function(e) {
      log.warn("WS", "切回后刷新会话列表失败: " + e);
    });
    refreshAgentInfo();
    loadTools();
    refreshProvidersOnSwitch(wsId).catch(function(e) {
      log.warn("WS", "刷新 provider 列表失败: " + e);
    });

    log.debug("WS", "workspace.switchTo(warm) done in " + Math.round(performance.now() - switchStart) + "ms");
    return;
  }

  // 首次进入该 workspace：初始化
  showInitProgress(_t("正在初始化工作目录..."));
  try {
    clearSendSafetyTimer();
    resetPermissionState();
    exitManualScrollMode();
    clearErrorNotices();
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    renderConversationList();
    document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");

    // 重新初始化 Agent：服务端创建工作区时不再自动构建 coordinator（见 backend
    // app.WithDeferredAgentInit），这里是该工作区唯一一次真实构建。
    try { await api("POST", "/v1/workspaces/" + wsId + "/agent/init"); } catch (_) {}

    // 以下三项彼此独立：并行发出，不再逐个 await（原来 3 次串行往返）
    await Promise.all([
      syncModeToServer().catch(function(e) { console.warn("[agent] 同步权限模式失败:", e); }),
      enableAutoCompact().catch(function(e) { console.warn("[agent] 开启自动压缩失败:", e); }),
      (async function() {
        var info = await api("GET", "/v1/workspaces/" + wsId + "/agent");
        store.setAgentInfo(wsId, info);
        var ctxLen = modelContextWindow(info && info.model);
        if (ctxLen) {
          store.setContextUsage(wsId, S.contextUsage.used, ctxLen, S.contextUsage.estimated);
        }
      })().catch(function(e) { console.warn("[agent] 获取 agentInfo 失败:", e); })
    ]);

    // SSE 监听是全局的（后端为每个 workspace 独立转发），不需要重新订阅
    // 会话列表是首屏主体：等它（内部会自动选中会话并加载消息）
    await loadConversations();
    updateContextUsage();
    updateStatusBar("ready", wsPath || null, 0);
    updateSendButton();
    reconcilePdfBatching();
    syncWxFollowSession();

    // 工具面板 / 云端模型列表与首屏无关：后台加载
    loadTools();
    refreshProvidersOnSwitch(wsId).catch(function(e) {
      log.warn("WS", "刷新 provider 列表失败: " + e);
    });
  } finally {
    hideInitProgress();
    log.debug("WS", "workspace.switchTo(cold) done in " + Math.round(performance.now() - switchStart) + "ms");
  }
}

// 切换 workspace 后刷新云端模型 provider 列表。
// 1) 从 admAgent.json 重新加载 S.providers（全局文件，始终最新）
// 2) 让目标 workspace 的 ConfigStore 重新读盘（只读的 /config/reload）
// 3) 拉取目标 workspace 的 /providers 快照并更新模型下拉
async function refreshProvidersOnSwitch(wsId) {
  try {
    S.providers = await invoke("list_cloud_providers");
  } catch (_) {
    S.providers = [];
  }

  // 目标 workspace 的 ConfigStore 可能未加载最新的全局配置（cloud providers 在
  // 其他 workspace 通过 config/set scope:0 写入全局文件时只触发了那个 workspace 的
  // autoReload）。用 /config/reload 触发一次重读即可——它不写文件。
  // 旧实现回写同一个 api_key 借 config/set 的副作用强制 reload，每次切换都要付
  // 一次配置文件写 + 全量解析（Windows 上还有 flock）。
  try {
    await api("POST", "/v1/workspaces/" + wsId + "/config/reload");
  } catch (e) {
    log.warn("WS", "config/reload 失败，尝试旧版回写触发: " + e);
    // 兼容不支持 /config/reload 的旧版 sidecar：退回「回写同一 api_key」触发 autoReload
    if (S.providers.length > 0) {
      var trigger = S.providers[0];
      try {
        await api("POST", "/v1/workspaces/" + wsId + "/config/set", {
          scope: 0,
          key: "providers." + trigger.key + ".api_key",
          value: trigger.api_key || ""
        });
      } catch (_) {}
    }
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
  // 移除 resize 监听（滚动/滚轮不关闭下拉，仅点击外部关闭）
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
            // 清理该 workspace 的状态池（会话/消息/运行状态），避免残留；
            // 该路径日后重新添加时 store.workspaces.has 为 false 会走首次初始化
            var removedWsId = S.wsIdByPath[d.path];
            if (removedWsId) {
              store.removeWorkspace(removedWsId);
              delete S.wsIdByPath[d.path];
            }
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
    // 窗口 resize 时关闭下拉；滚动/滚轮不关闭（保持展开直到点击外部）
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
    // 创建工作区可能涉及配置加载 / 数据库连接 / 技能扫描，给用户一个明确的进行中提示；
    // 成功后的 switchToWorkspace 会接管（并最终收起）这条进度条。
    showInitProgress(_t("正在打开工作目录..."));
    // 通过 Rust 后端创建 workspace（启动独立 SSE 转发）
    var wsInfo = await invoke("create_workspace", { path: path, clientId: S.clientId });
    if (!wsInfo || !wsInfo.workspace_id) {
      hideInitProgress();
      reportError(new Error("server returned no workspace id"), { prefix: _t("切换工作目录失败: ") });
      return;
    }
    // 设为默认工作目录
    await invoke("set_default_workdir", { path: path });
    // 切换到新 workspace（保存旧状态，恢复新状态）
    await switchToWorkspace(wsInfo.workspace_id, path);
  } catch (e) {
    hideInitProgress();
    reportError(e, { prefix: _t("切换工作目录失败: ") });
  } finally {
    hideInitProgress();
  }
}

// 启动时验证工作目录列表（移除不存在的路径）
export async function validateWorkDirs() {
  try {
    var removed = await invoke("validate_workdirs");
    if (removed && removed.length > 0) {
      removed.forEach(function(path) {
        // 同步清理已失效目录的状态池条目
        var staleWsId = S.wsIdByPath[path];
        if (staleWsId) {
          store.removeWorkspace(staleWsId);
          delete S.wsIdByPath[path];
        }
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
