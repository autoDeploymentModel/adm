// 设置弹窗 / 云端模型添加 / admAgent 版本显示
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { parseContextSize, escapeHtml, $input, normalizeReasoningEffort } from "./utils.js";
import { showConfirm, reportError } from "./ui.js";
import { updateWorkspaceSelector } from "./workspace.js";
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
  var planCheck = $input("settings-plan");
  var reasoningSelect = $input("settings-reasoning-effort");
  var tempInput = $input("settings-temperature");

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

  // 多模态模型（图片识别）：默认内置 admImage-model，自动轮询远程图片后端
  renderVisionModelSelect();

  // 云端模型列表
  renderProviderList();
}

// 渲染「多模态模型」下拉：固定首项内置 admImage-model（默认）+ 所有 supports_images=true
// 的已配置模型（云端 provider + 本地多模态，复用服务端 /providers 快照；离线回退磁盘列表）
export function renderVisionModelSelect() {
  var sel = $input("settings-vision-model");
  if (!sel) return;
  var current = S.settings.agent_vision_model || "admAgent/admImage-model";
  sel.innerHTML = "";
  var first = document.createElement("option");
  first.value = "admAgent/admImage-model";
  first.textContent = _t("admImage-model（内置 · 自动轮询）");
  sel.appendChild(first);
  var seen = { "admAgent/admImage-model": true };
  var entries = [];
  if (S.serverProvidersLoaded) {
    S.serverProviders.forEach(function(sp) {
      if (!sp || !Array.isArray(sp.models)) return;
      sp.models.forEach(function(m) {
        if (!m || m.supports_images !== true) return;
        entries.push({ key: sp.id + "/" + m.id, name: m.name || m.id });
      });
    });
  } else {
    // 快照未就绪（服务未运行或 provider 快照尚未拉取完成）：回退磁盘配置
    // （仅列出已确认的云端 provider），保证下拉始终有可用选项
    S.providers.forEach(function(p) {
      if (S.pendingProviderKeys[p.key]) return;
      if (p.supports_images === true && p.model_id) {
        entries.push({ key: p.key + "/" + p.model_id, name: p.name || p.model_id });
      }
    });
  }
  entries.forEach(function(e) {
    if (seen[e.key]) return;
    seen[e.key] = true;
    var opt = document.createElement("option");
    opt.value = e.key;
    opt.textContent = e.name;
    sel.appendChild(opt);
  });
  if (seen[current]) {
    sel.value = current;
  } else if (!S.serverProvidersLoaded && current !== "admAgent/admImage-model") {
    // 快照未就绪时列表可能不完整：保留当前已配置值作为选项，避免保存时被静默重置为默认
    var keep = document.createElement("option");
    keep.value = current;
    keep.textContent = current;
    sel.appendChild(keep);
    sel.value = current;
  } else {
    sel.value = "admAgent/admImage-model";
  }
}

export async function saveSettings() {
  console.log("[agent] 保存设置");
  try {
    // 保存 agent 设置到 config
    var s = await invoke("load_settings");
    s.agent_plan_mode = S.settings.agent_plan_mode || false;
    s.agent_default_provider = S.settings.agent_default_provider || "local";
    s.agent_reasoning_effort = normalizeReasoningEffort(S.settings.agent_reasoning_effort);
    s.agent_temperature = S.settings.agent_temperature || null;
    s.debug_logging = S.settings.debug_logging || false;
    s.agent_vision_model = S.settings.agent_vision_model || "admAgent/admImage-model";
    await invoke("save_settings", { settings: s });
    updateWorkspaceSelector();
  } catch (e) {
    reportError(e, { prefix: _t("保存设置失败: ") });
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
  if (title) title.textContent = isEdit ? _t("修改云端模型") : _t("添加云端模型");
  if (submit) submit.textContent = isEdit ? _t("保存") : _t("添加");
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
    container.innerHTML = '<div style="color:var(--c-text-4);font-size:12px;padding:8px 0;">' + _t("暂无云端模型") + '</div>';
    return;
  }

  S.providers.forEach(function(p) {
    var card = document.createElement("div");
    card.className = "provider-card";
    card.innerHTML =
      '<div class="provider-card-header">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="provider-action-btn edit" data-key="' + p.key + '">' + _t("修改") + '</button>' +
          '<button class="provider-action-btn delete" data-key="' + p.key + '">' + _t("删除") + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-detail">' + escapeHtml(p.base_url) + ' · ' + _t("上下文: ") + (p.context_window || _t('默认')) + (p.supports_images ? ' · ' + _t("支持图片") : '') + (p.can_reason ? ' · ' + _t("思考模式") : '') + '</div>';
    card.querySelector(".edit").addEventListener("click", function() {
      showEditModelDialog(p);
    });
    card.querySelector(".delete").addEventListener("click", function() {
      showConfirm(_t("确定删除云端模型「") + p.name + _t("」？"), async function() {
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
          renderVisionModelSelect();
          renderProviderList();
          updateModelDropdown();
        } catch (e) {
          reportError(e, { prefix: _t("删除失败: ") });
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
    addModelMsg(_t("请填写模型ID、API地址和密钥"), true);
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
      renderVisionModelSelect();
      renderProviderList();
      updateModelDropdown();
      // 改的正是当前激活的 provider：重新切换一次，让新 model id / 上下文窗口立即应用到 agent
      var active = S.settings.agent_default_provider || "local";
      if (active === key || active.indexOf(key + "/") === 0) {
        await switchModel(key, name, ctx);
      }
      addModelMsg(_t("修改成功"), false);
      setTimeout(function() {
        hideAddModelDialog();
        editingProviderKey = null;
        clearAddModelForm();
      }, 1000);
    } catch (e) {
      addModelMsg(_t("修改失败: ") + e, true);
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
    renderVisionModelSelect();
    var runtimeConfirmed = runtimeSynced && snapshotLoaded && S.serverProviders.some(function(sp) {
      return sp && sp.id === addResp.key;
    });
    if (!runtimeConfirmed && addResp && addResp.key) S.pendingProviderKeys[addResp.key] = true;
    renderProviderList();
    updateModelDropdown();
    if (runtimeConfirmed) {
      addModelMsg(_t("添加成功"), false);
    } else {
      addModelMsg(_t("配置已保存，但当前服务未加载该模型；重启 Agent 后生效") + (syncError ? ": " + syncError : ""), true);
      return;
    }
    setTimeout(function() {
      hideAddModelDialog();
      clearAddModelForm();
    }, 1000);
  } catch (e) {
    addModelMsg(_t("添加失败: ") + e, true);
  }
}
