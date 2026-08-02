// 设置弹窗 / 云端模型添加 / admAgent 版本显示
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { parseContextSize, escapeHtml, $input, normalizeReasoningEffort } from "./utils.js";
import { showConfirm, reportError, updateStatusBar } from "./ui.js";
import { switchToWorkspace, updateWorkspaceSelector } from "./workspace.js";
import { updateModelDropdown, switchModel, refreshServerProviders } from "./model.js";
import { isAutoContinueEnabled } from "./autocontinue.js";
import { refreshProjectMemory } from "./memory.js";

// ===== 设置弹窗 =====
export function showSettings() {
  updateSettingsUI();
  document.getElementById("agent-settings-overlay").classList.add("show");
  // 打开弹窗时刷新项目记忆（读取 workspace/project_memory.json，只读展示）
  refreshProjectMemory();
}

export function hideSettings() {
  document.getElementById("agent-settings-overlay").classList.remove("show");
}

// 项目记忆折叠块交互：点击头部展开/收起（默认折叠）
export function initProjectMemoryUI() {
  var toggle = document.getElementById("agent-memory-toggle");
  var collapse = document.getElementById("agent-memory-collapse");
  if (!toggle || !collapse) return;
  toggle.addEventListener("click", function() {
    collapse.classList.toggle("open");
  });
}

export function updateSettingsUI() {
  var workdir = $input("settings-workdir");
  var planCheck = $input("settings-plan");
  var reasoningSelect = $input("settings-reasoning-effort");
  var tempInput = $input("settings-temperature");

  // 工作目录
  invoke("get_agent_workdir").then(function(dir) {
    workdir.value = dir || "";
  }).catch(function() {});

  // Plan 模式
  planCheck.checked = !!S.settings.agent_plan_mode;

  // 自动续跑（localStorage 持久化，默认开启）
  $input("settings-auto-continue").checked = isAutoContinueEnabled();

  // 调试模式（持久化到 config.json 的 debug_logging，由后端开关控制）
  $input("settings-debug-logging").checked = !!S.settings.debug_logging;

  // 推理强度（旧版存过 ""/"auto"，归一化为 medium 回显）
  reasoningSelect.value = normalizeReasoningEffort(S.settings.agent_reasoning_effort);

  // 温度
  tempInput.value = S.settings.agent_temperature || "";

  // 云端模型列表
  renderProviderList();
}

export async function saveSettings() {
  console.log("[agent] 保存设置");
  try {
    // 保存工作目录
    var workdir = $input("settings-workdir").value.trim();
    var oldWorkdir = S.workspaceInfo ? S.workspaceInfo.path : "";
    await invoke("set_agent_workdir", { workdir: workdir });

    // 保存 agent 设置到 config
    var s = await invoke("load_settings");
    s.agent_plan_mode = S.settings.agent_plan_mode || false;
    s.agent_default_provider = S.settings.agent_default_provider || "local";
    s.agent_reasoning_effort = normalizeReasoningEffort(S.settings.agent_reasoning_effort);
    s.agent_temperature = S.settings.agent_temperature || null;
    s.debug_logging = S.settings.debug_logging || false;
    await invoke("save_settings", { settings: s });

    // 如果工作目录发生了变化，切换 workspace
    if (workdir && workdir !== oldWorkdir && S.serverInfo && S.serverInfo.workspace_id) {
      try {
        // 直接 POST 创建：服务端按 path 原子去重（first-wins）并为本客户端注册创建 hold，
        // 保证新 SSE 接上前 workspace 不会被回收。
        // 不能用 GET 列表查找复用 id：列表里可能有靠残留连接"假活"的旧 workspace，
        // 复用它不产生任何引用保护，随后被服务端 teardown 就会满屏 404
        var newWs = await api("POST", "/v1/workspaces", {
          path: workdir,
          yolo: true, // 审批模式已移除：权限请求直通，Plan 模式靠服务端只读工具集约束
          client_id: S.clientId
        });
        // 切换到新 workspace
        if (newWs && newWs.id) {
          await switchToWorkspace(newWs.id, workdir);
        }
      } catch (e) {
        console.warn("[agent] 切换工作区失败:", e);
        reportError(e, { prefix: "切换工作目录失败: " });
      }
    } else {
      // 工作目录未变化，只更新 UI
      S.workspaceInfo = { path: workdir || "默认", name: workdir ? workdir.split(/[\\/]/).pop() : "默认工作区" };
    }
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, S.contextUsage.used);
  } catch (e) {
    reportError(e, { prefix: "保存设置失败: " });
  }
}

// ===== 模型添加/修改弹窗 =====
// 非 null 表示弹窗处于「修改」模式，值为正在编辑的 provider key
var editingProviderKey = null;

// 把 token 数格式化成上下文输入框接受的写法（与 parseContextSize 互逆）
function formatCtxInput(n) {
  if (!n) return "";
  if (n % 1000000 === 0) return (n / 1000000) + "M";
  if (n % 1000 === 0) return (n / 1000) + "K";
  return String(n);
}

// 切换弹窗标题/提交按钮文案（add ↔ edit）
function setAddModelDialogMode(isEdit) {
  var title = document.getElementById("add-model-title");
  var submit = document.getElementById("add-model-submit");
  if (title) title.textContent = isEdit ? "修改云端模型" : "添加云端模型";
  if (submit) submit.textContent = isEdit ? "保存" : "添加";
}

function clearAddModelForm() {
  $input("add-model-name").value = "";
  $input("add-model-baseurl").value = "";
  $input("add-model-apikey").value = "";
  $input("add-model-modelid").value = "";
  $input("add-model-ctx").value = "";
  $input("add-model-images").checked = false;
  $input("add-model-reasoning").checked = false;
  document.getElementById("add-model-msg").textContent = "";
}

export function showAddModelDialog() {
  // 从修改模式切回添加模式时清空回填的旧值，避免误把旧模型参数当新模型提交
  if (editingProviderKey !== null) {
    editingProviderKey = null;
    clearAddModelForm();
  }
  setAddModelDialogMode(false);
  document.getElementById("agent-add-model-overlay").classList.add("show");
  renderProviderList();
}

// 以「修改」模式打开弹窗，回填指定 provider 的全部参数
function showEditModelDialog(p) {
  editingProviderKey = p.key;
  $input("add-model-modelid").value = p.model_id || "";
  $input("add-model-name").value = p.name || "";
  $input("add-model-baseurl").value = p.base_url || "";
  $input("add-model-apikey").value = p.api_key || "";
  $input("add-model-ctx").value = formatCtxInput(p.context_window);
  $input("add-model-images").checked = !!p.supports_images;
  $input("add-model-reasoning").checked = !!p.can_reason;
  document.getElementById("add-model-msg").textContent = "";
  setAddModelDialogMode(true);
  document.getElementById("agent-add-model-overlay").classList.add("show");
}

export function hideAddModelDialog() {
  document.getElementById("agent-add-model-overlay").classList.remove("show");
}

function renderProviderList() {
  var container = document.getElementById("provider-list");
  if (!container) return;
  container.innerHTML = "";

  if (S.providers.length === 0) {
    container.innerHTML = '<div style="color:var(--c-text-4);font-size:12px;padding:8px 0;">暂无云端模型</div>';
    return;
  }

  S.providers.forEach(function(p) {
    var card = document.createElement("div");
    card.className = "provider-card";
    card.innerHTML =
      '<div class="provider-card-header">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="provider-action-btn edit" data-key="' + p.key + '">修改</button>' +
          '<button class="provider-action-btn delete" data-key="' + p.key + '">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-detail">' + escapeHtml(p.base_url) + ' · 上下文: ' + (p.context_window || '默认') + (p.supports_images ? ' · 支持图片' : '') + (p.can_reason ? ' · 思考模式' : '') + '</div>';
    card.querySelector(".edit").addEventListener("click", function() {
      showEditModelDialog(p);
    });
    card.querySelector(".delete").addEventListener("click", function() {
      showConfirm("确定删除云端模型「" + p.name + "」？", async function() {
        try {
          await invoke("delete_cloud_provider", { key: p.key });
          // 同步从运行中的 server 内存配置移除（否则服务端仍持有已删 provider 直到重启）
          if (S.serverInfo && S.serverInfo.workspace_id) {
            await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/remove", {
              scope: 0, key: "providers." + p.key
            }).catch(function(e) { console.warn("[agent] 同步删除 provider 到服务端失败:", e); });
          }
          // 删的正是当前激活的 provider：立即切回本地模型，避免 active model 悬空
          // 导致 /agent/update 报 "active model provider not configured"、
          // 后续 /agent/init 失败把 coordinator 置空（整个 Agent 不可用）
          var active = S.settings.agent_default_provider || "local";
          if (active === p.key || active.indexOf(p.key + "/") === 0) {
            await switchModel("local", "Local Model", 0);
          }
          S.providers = await invoke("list_cloud_providers");
          delete S.pendingProviderKeys[p.key];
          // 下拉优先使用 S.serverProviders；必须刷新服务端快照，避免已删 provider 继续显示并可被重新选中
          await refreshServerProviders();
          renderProviderList();
          updateModelDropdown();
        } catch (e) {
          reportError(e, { prefix: "删除失败: " });
        }
      });
    });
    container.appendChild(card);
  });
}

function addModelMsg(text, isError) {
  var el = document.getElementById("add-model-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "#22c55e";
}

export async function addModel() {
  var modelId = $input("add-model-modelid").value.trim();
  var name = $input("add-model-name").value.trim() || modelId;
  var baseUrl = $input("add-model-baseurl").value.trim();
  var apiKey = $input("add-model-apikey").value.trim();
  var ctx = parseContextSize($input("add-model-ctx").value) || 256000;
  var supportsImages = $input("add-model-images").checked;
  var canReason = $input("add-model-reasoning").checked;

  if (!modelId || !baseUrl || !apiKey) {
    addModelMsg("请填写模型ID、API地址和密钥", true);
    return;
  }

  // 修改模式：按原 key 替换全部参数（key 不变，不产生孤儿条目）
  if (editingProviderKey) {
    var key = editingProviderKey;
    try {
      await invoke("update_cloud_provider", {
        key: key,
        input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: canReason }
      });
      // 同步运行中的 server：与添加路径同理，只写标量 api_key 触发服务端落盘+从磁盘全量重载，
      // 让刚写入 admAgent.json 的新参数（base_url / model id / 上下文等）立即生效
      if (S.serverInfo && S.serverInfo.workspace_id) {
        try {
          await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/set", {
            scope: 0,
            key: "providers." + key + ".api_key",
            value: apiKey
          });
          delete S.pendingProviderKeys[key];
        } catch (e) {
          S.pendingProviderKeys[key] = true;
          console.warn("[agent] 同步修改后的 provider 到服务端失败（重启后生效）:", e);
        }
      }
      S.providers = await invoke("list_cloud_providers");
      await refreshServerProviders();
      renderProviderList();
      updateModelDropdown();
      // 改的正是当前激活的 provider：重新切换一次，让新 model id / 上下文窗口立即应用到 agent
      var active = S.settings.agent_default_provider || "local";
      if (active === key || active.indexOf(key + "/") === 0) {
        await switchModel(key, name, ctx);
      }
      addModelMsg("修改成功", false);
      setTimeout(function() {
        hideAddModelDialog();
        editingProviderKey = null;
        clearAddModelForm();
      }, 1000);
    } catch (e) {
      addModelMsg("修改失败: " + e, true);
    }
    return;
  }

  try {
    var addResp = await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: canReason }
    });
    // 关键：把新 provider 同步进运行中的 server（/config/set 会写盘并自动重载内存）。
    // 否则 server 只在启动时读 admAgent.json，选中新模型会报
    // "active model provider not configured"，且后续 /agent/init 失败会把 coordinator 置空。
    // 注意只写标量 api_key、不写完整 provider 对象：/config/set 落盘到服务端数据配置
    // （Windows 为 %LOCALAPPDATA%/admAgent/admAgent.json），与 add_cloud_provider 写入的
    // ~/.config/admAgent/admAgent.json 是两个文件，服务端加载时用 go-jsons 合并且
    // 数组按「拼接」处理——完整 provider（含 models 数组）写两处会让同一模型在
    // 下拉列表出现两次；写标量即可触发 SetConfigField 的自动重载，让服务端从磁盘
    // 合并进 Rust 侧刚写入的完整 provider。
    var runtimeSynced = false;
    var syncError = null;
    if (addResp && addResp.key && S.serverInfo && S.serverInfo.workspace_id) {
      try {
        await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/set", {
          scope: 0,
          key: "providers." + addResp.key + ".api_key",
          value: apiKey
        });
        runtimeSynced = true;
        delete S.pendingProviderKeys[addResp.key];
      } catch (e) {
        syncError = e;
        S.pendingProviderKeys[addResp.key] = true;
        console.warn("[agent] 同步新 provider 到服务端失败（重启后生效）:", e);
      }
    } else if (addResp && addResp.key) {
      S.pendingProviderKeys[addResp.key] = true;
    }
    S.providers = await invoke("list_cloud_providers");
    // 只有 /config/set 成功且 /providers 快照确实包含该 key，才算运行时可用。
    var snapshotLoaded = await refreshServerProviders();
    var runtimeConfirmed = runtimeSynced && snapshotLoaded && S.serverProviders.some(function(sp) {
      return sp && sp.id === addResp.key;
    });
    if (!runtimeConfirmed && addResp && addResp.key) S.pendingProviderKeys[addResp.key] = true;
    renderProviderList();
    updateModelDropdown();
    if (runtimeConfirmed) {
      addModelMsg("添加成功", false);
    } else {
      addModelMsg("配置已保存，但当前服务未加载该模型；重启 Agent 后生效" + (syncError ? ": " + syncError : ""), true);
      return;
    }
    setTimeout(function() {
      hideAddModelDialog();
      clearAddModelForm();
    }, 1000);
  } catch (e) {
    addModelMsg("添加失败: " + e, true);
  }
}
