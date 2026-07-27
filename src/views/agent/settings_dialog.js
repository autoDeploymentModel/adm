// 设置弹窗 / 云端模型添加 / admAgent 版本显示
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { parseContextSize, escapeHtml, $input } from "./utils.js";
import { showError, showConfirm, updateStatusBar } from "./ui.js";
import { switchToWorkspace, updateWorkspaceSelector } from "./workspace.js";
import { updateModelDropdown } from "./model.js";

// ===== 设置弹窗 =====
export function showSettings() {
  updateSettingsUI();
  document.getElementById("agent-settings-overlay").classList.add("show");
}

export function hideSettings() {
  document.getElementById("agent-settings-overlay").classList.remove("show");
}

export function updateSettingsUI() {
  var workdir = $input("settings-workdir");
  var yoloCheck = $input("settings-yolo");
  var reasoningSelect = $input("settings-reasoning-effort");
  var tempInput = $input("settings-temperature");

  // 工作目录
  invoke("get_agent_workdir").then(function(dir) {
    workdir.value = dir || "";
  }).catch(function() {});

  // YOLO
  yoloCheck.checked = !!S.settings.agent_yolo;

  // 推理强度
  reasoningSelect.value = S.settings.agent_reasoning_effort || "";

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
    s.agent_yolo = S.settings.agent_yolo || false;
    s.agent_default_provider = S.settings.agent_default_provider || "local";
    s.agent_reasoning_effort = S.settings.agent_reasoning_effort || "";
    s.agent_temperature = S.settings.agent_temperature || null;
    await invoke("save_settings", { settings: s });

    // 如果工作目录发生了变化，切换 workspace
    if (workdir && workdir !== oldWorkdir && S.serverInfo && S.serverInfo.workspace_id) {
      try {
        // 查找匹配的工作区
        var newWsId = null;
        var workspaces = await api("GET", "/v1/workspaces");
        if (Array.isArray(workspaces)) {
          var matched = workspaces.find(function(w) { return w.path === workdir; });
          if (matched) newWsId = matched.id;
        }
        // 没有则创建
        if (!newWsId) {
          var newWs = await api("POST", "/v1/workspaces", {
            path: workdir,
            yolo: S.settings.agent_yolo || false,
            client_id: S.clientId
          });
          newWsId = newWs.id;
        }
        // 切换到新 workspace
        if (newWsId) {
          await switchToWorkspace(newWsId, workdir);
        }
      } catch (e) {
        console.warn("[agent] 切换工作区失败:", e);
        showError("切换工作目录失败: " + e);
      }
    } else {
      // 工作目录未变化，只更新 UI
      S.workspaceInfo = { path: workdir || "默认", name: workdir ? workdir.split(/[\\/]/).pop() : "默认工作区" };
    }
    updateWorkspaceSelector();
    updateStatusBar("ready", workdir, S.contextUsage.used);
  } catch (e) {
    showError("保存设置失败: " + e);
  }
}

// ===== admAgent 版本检查 =====
export async function checkAgentVersion() {
  var el = document.getElementById("agent-current-version");
  try {
    var ver = await invoke("get_adm_agent_version");
    if (el) el.textContent = ver || "未知";
  } catch (_) {
    if (el) el.textContent = "未知";
  }
}

// ===== 模型添加弹窗 =====
export function showAddModelDialog() {
  document.getElementById("agent-add-model-overlay").classList.add("show");
  renderProviderList();
}

export function hideAddModelDialog() {
  document.getElementById("agent-add-model-overlay").classList.remove("show");
}

function renderProviderList() {
  var container = document.getElementById("provider-list");
  if (!container) return;
  container.innerHTML = "";

  if (S.providers.length === 0) {
    container.innerHTML = '<div style="color:#6e7681;font-size:12px;padding:8px 0;">暂无云端模型</div>';
    return;
  }

  S.providers.forEach(function(p) {
    var card = document.createElement("div");
    card.className = "provider-card";
    card.innerHTML =
      '<div class="provider-card-header">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="provider-action-btn delete" data-key="' + p.key + '">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-detail">' + escapeHtml(p.base_url) + ' · 上下文: ' + (p.context_window || '默认') + (p.supports_images ? ' · 支持图片' : '') + '</div>';
    card.querySelector(".delete").addEventListener("click", function() {
      showConfirm("确定删除云端模型「" + p.name + "」？", async function() {
        try {
          await invoke("delete_cloud_provider", { key: p.key });
          S.providers = await invoke("list_cloud_providers");
          renderProviderList();
          updateModelDropdown();
        } catch (e) {
          showError("删除失败: " + e);
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

  if (!modelId || !baseUrl || !apiKey) {
    addModelMsg("请填写模型ID、API地址和密钥", true);
    return;
  }

  try {
    await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId || null, supports_images: supportsImages }
    });
    S.providers = await invoke("list_cloud_providers");
    renderProviderList();
    updateModelDropdown();
    addModelMsg("添加成功", false);
    setTimeout(function() {
      hideAddModelDialog();
      $input("add-model-name").value = "";
      $input("add-model-baseurl").value = "";
      $input("add-model-apikey").value = "";
      $input("add-model-modelid").value = "";
      $input("add-model-ctx").value = "";
      $input("add-model-images").checked = false;
      document.getElementById("add-model-msg").textContent = "";
    }, 1000);
  } catch (e) {
    addModelMsg("添加失败: " + e, true);
  }
}
