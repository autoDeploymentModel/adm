// 设置弹窗 / 云端模型添加 / admAgent 版本显示
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { parseContextSize, escapeHtml, $input } from "./utils.js";
import { showError, showConfirm, updateStatusBar } from "./ui.js";
import { switchToWorkspace, updateWorkspaceSelector } from "./workspace.js";
import { updateModelDropdown, switchModel, refreshServerProviders } from "./model.js";

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
    var addResp = await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId || null, supports_images: supportsImages }
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
