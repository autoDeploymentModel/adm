// 设置弹窗 / admAgent 版本显示
// 云端模型的增删改已移到独立页面 src/views/cloud_models.js（底部导航「云端模型」），
// 这里只保留 Agent 设置项与「多模态模型」下拉（下拉仍复用服务端 provider 快照）。
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { $input, normalizeReasoningEffort } from "./utils.js";
import { reportError } from "./ui.js";
import { updateWorkspaceSelector } from "./workspace.js";

// 内置多模态模型（图片识别）在服务端的显示名：admAgent 的图片后端池只暴露 adm-models。
// 旧版本使用 admImage-model（服务端两者等价），这里统一归一化，避免下拉出现重复项。
export const BUILTIN_VISION_KEY = "admAgent/adm-models";
const LEGACY_BUILTIN_VISION_KEY = "admAgent/admImage-model";

function normalizeVisionKey(value) {
  return value === LEGACY_BUILTIN_VISION_KEY ? BUILTIN_VISION_KEY : value;
}

// ===== 设置弹窗 =====
export function showSettings() {
  updateSettingsUI();
  document.getElementById("agent-settings-overlay").classList.add("show");
}

export function hideSettings() {
  document.getElementById("agent-settings-overlay").classList.remove("show");
}

export function updateSettingsUI() {
  var tempInput = $input("settings-temperature");

  // 调试模式（持久化到 config.json 的 debug_logging，由后端开关控制）
  $input("settings-debug-logging").checked = !!S.settings.debug_logging;

  // 开启所有工具调用（关闭 admAgent 内置 bash 命令黑名单）
  $input("settings-allow-all-tools").checked = !!S.settings.agent_allow_all_tools;

  // 同目录多会话并行（默认关：开启后才允许同一工作目录内多会话并行）
  $input("settings-concurrent-sessions").checked = S.settings.agent_concurrent_sessions === true;

  // 温度
  tempInput.value = S.settings.agent_temperature || "";

  // 多模态模型（图片识别）：默认内置 adm-models，自动轮询远程图片后端
  // 迁移：旧版内置名 admImage-model 归一化为 adm-models；仅在服务端快照就绪时校验当前值并
  // 重置为内置默认值，快照未就绪时保留原值，交给下方 renderVisionModelSelect 的保留逻辑
  // 兜底（避免离线时把 local/localModel 等有效配置误重置 —— S.providers 来自
  // list_cloud_providers，不含 local 条目）
  if (S.settings.agent_vision_model) {
    S.settings.agent_vision_model = normalizeVisionKey(S.settings.agent_vision_model);
  }
  if (S.serverProvidersLoaded && S.settings.agent_vision_model) {
    var visionValid = S.serverProviders.some(function(sp) {
      return Array.isArray(sp.models) && sp.models.some(function(m) {
        return m.supports_images === true && S.settings.agent_vision_model === sp.id + "/" + m.id;
      });
    });
    if (!visionValid) {
      S.settings.agent_vision_model = BUILTIN_VISION_KEY;
    }
  }
  renderVisionModelSelect();
}

// 渲染「多模态模型」下拉：固定首项内置 adm-models（默认）+ 所有 supports_images=true
// 的已配置模型（云端 provider + 本地多模态，复用服务端 /providers 快照；离线回退磁盘列表）
export function renderVisionModelSelect() {
  var sel = $input("settings-vision-model");
  if (!sel) return;
  var current = normalizeVisionKey(S.settings.agent_vision_model || BUILTIN_VISION_KEY);
  sel.innerHTML = "";
  var first = document.createElement("option");
  first.value = BUILTIN_VISION_KEY;
  first.textContent = _t("adm-models（内置 · 自动轮询）");
  sel.appendChild(first);
  var seen = {};
  seen[BUILTIN_VISION_KEY] = true;
  var entries = [];
  if (S.serverProvidersLoaded) {
    S.serverProviders.forEach(function(sp) {
      if (!sp || !Array.isArray(sp.models)) return;
      // 内置 admAgent provider 已由首项覆盖，不再按服务端模型名重复列出
      if (sp.id === "admAgent") return;
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
  } else if (!S.serverProvidersLoaded && current !== BUILTIN_VISION_KEY) {
    // 快照未就绪时列表可能不完整：保留当前已配置值作为选项，避免保存时被静默重置为默认
    var keep = document.createElement("option");
    keep.value = current;
    keep.textContent = current;
    sel.appendChild(keep);
    sel.value = current;
  } else {
    sel.value = BUILTIN_VISION_KEY;
    S.settings.agent_vision_model = BUILTIN_VISION_KEY;
  }
}

export async function saveSettings() {
  console.log("[agent] 保存设置");
  try {
    // 保存 agent 设置到 config
    var s = await invoke("load_settings");
    s.agent_default_provider = S.settings.agent_default_provider || "local";
    s.agent_thinking_enabled = S.settings.agent_thinking_enabled !== false;
    s.agent_reasoning_effort = normalizeReasoningEffort(S.settings.agent_reasoning_effort);
    s.agent_temperature = S.settings.agent_temperature || null;
    s.debug_logging = S.settings.debug_logging || false;
    s.agent_vision_model = normalizeVisionKey(S.settings.agent_vision_model) || BUILTIN_VISION_KEY;
    s.agent_allow_all_tools = S.settings.agent_allow_all_tools === true;
    s.agent_concurrent_sessions = S.settings.agent_concurrent_sessions === true;
    // 压缩时自动提取记忆规则（默认开：只有显式 false 才关闭），
    // 后端 save_settings 会同步进 admAgent.json 的 options.project_memory_sync
    s.agent_project_memory_sync = S.settings.agent_project_memory_sync !== false;
    await invoke("save_settings", { settings: s });
    updateWorkspaceSelector();
  } catch (e) {
    reportError(e, { prefix: _t("保存设置失败: ") });
  }
}
