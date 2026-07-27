// 模型切换与 provider 列表
import { S, invoke } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, formatTokens, slugifyModelId } from "./utils.js";
import { showError, updateContextUsage } from "./ui.js";

// ===== 模型切换 =====
// 切换模型：保存设置 → 通知服务端重新加载 → 刷新 agentInfo → 更新 UI
export async function switchModel(providerKey, displayName, ctxLen) {
  console.log("[agent] 切换模型:", providerKey, displayName);
  S.settings.agent_default_provider = providerKey;
  if (ctxLen) S.contextUsage.max = ctxLen;

  var dropdown = document.getElementById("agent-model-dropdown");
  if (dropdown) dropdown.classList.remove("show");

  // 立即更新按钮文字（用户选择的名称）
  var nameEl = document.getElementById("agent-model-name");
  if (nameEl) nameEl.textContent = displayName;
  updateContextUsage();

  // 轻量级保存：只写 agent_default_provider 等字段到 config.json，不依赖设置弹窗 DOM
  try {
    var s = await invoke("load_settings");
    s.agent_default_provider = S.settings.agent_default_provider || "local";
    s.agent_yolo = !!S.settings.agent_yolo;
    s.agent_reasoning_effort = S.settings.agent_reasoning_effort || "";
    s.agent_temperature = S.settings.agent_temperature || null;
    await invoke("save_settings", { settings: s });
  } catch (e) {
    showError("保存设置失败: " + e);
  }

  // 通知服务端 Agent 切换模型并重新加载配置（关键！）
  // 必须先调 /config/model 把首选模型写进 admAgent 的配置（agent_default_provider
  // 只存在 ADM 自己的 config.json 里，admAgent 服务端不读它），再调 /agent/update 重载，
  // 否则服务端会一直用 admAgent.json 里旧的 model 字段。
  if (S.serverInfo && S.serverInfo.workspace_id) {
    try {
      var target = resolveAgentModel(providerKey);
      var modelCfg = { provider: target.provider, model: target.model };
      if (S.settings.agent_reasoning_effort) modelCfg.reasoning_effort = S.settings.agent_reasoning_effort;
      if (typeof S.settings.agent_temperature === "number") modelCfg.temperature = S.settings.agent_temperature;
      await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/model", {
        scope: 0,
        model: modelCfg
      });
      try {
        await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/update");
        S.pendingModelReload = false;
        // 刷新 agentInfo 以获取服务端确认后的实际模型（updateModelBtn 优先显示 agentInfo.model.id）
        await refreshAgentInfo();
      } catch (updErr) {
        // 会话繁忙等原因 reload 失败：config/model 已写入，挂起到 run_complete / 下次发消息前重试，
        // 否则服务端会继续用旧模型（表现为对话中途切换模型不生效）
        S.pendingModelReload = true;
        console.warn("[agent] /agent/update 失败，挂起待重试:", updErr);
      }
    } catch (e) {
      showError("通知 Agent 切换模型失败: " + e);
    }
  }
}

// 刷新 agentInfo（带序号竞态保护：并发请求只应用最后一次发起的结果，
// 避免 run_complete 的旧响应把切换模型后的 agentInfo 覆盖回旧模型）
export async function refreshAgentInfo() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return null;
  var seq = ++S.agentInfoSeq;
  try {
    var info = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent");
    if (seq !== S.agentInfoSeq) return null; // 已有更新的请求，丢弃旧响应
    S.agentInfo = info;
    if (info && info.model && info.model.context_window) {
      S.contextUsage.max = info.model.context_window;
      updateContextUsage();
    }
    updateModelBtn();
    return info;
  } catch (_) { return null; }
}

// 从 admAgent 服务端拉取完整 provider 列表（含编译内置的 provider，
// admAgent.json 里没有、仅 CLI 能看到的内置模型也在其中）
export async function refreshServerProviders() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    var list = await api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/providers");
    if (Array.isArray(list)) S.serverProviders = list;
  } catch (_) { /* 拉取失败时保留旧数据，下拉回退 admAgent.json 列表 */ }
}

// 把前端 providerKey（"local" / "local:xxx" / "provider/model" / 云端 provider key）解析成
// admAgent /config/model 接口需要的 { provider, model }
export function resolveAgentModel(providerKey) {
  if (providerKey === "local" || providerKey.startsWith("local:")) {
    // 本地模型统一走 admAgent.json 里自动维护的 local provider（唯一 model id 为 localModel）
    return { provider: "local", model: "localModel" };
  }
  // "provider/model" 复合 key（服务端 provider 列表条目，含内置模型）
  var slash = providerKey.indexOf("/");
  if (slash > 0) {
    return { provider: providerKey.slice(0, slash), model: providerKey.slice(slash + 1) };
  }
  var p = S.providers.find(function(x) { return x.key === providerKey; });
  if (p && p.model_id) return { provider: providerKey, model: p.model_id };
  // 回退：与后端 slugify_model_id 一致的派生规则
  return { provider: providerKey, model: slugifyModelId(p ? p.name : providerKey) };
}

// 合并本地模型 + 云端模型渲染下拉列表
export function updateModelDropdown() {
  var dropdown = document.getElementById("agent-model-dropdown");
  if (!dropdown) return;

  dropdown.innerHTML = "";

  var currentProvider = S.settings.agent_default_provider || "local";

  // 本地模型 - 统一显示一条入口
  var localItem = document.createElement("div");
  var isLocalSelected = currentProvider === "local" || currentProvider.startsWith("local:");
  localItem.className = "model-item" + (isLocalSelected ? " selected" : "");
  var localLabel = S.localModels.length > 0 ? S.localModels.length + " Local Models" : "Local Model";
  localItem.innerHTML = '<span class="model-item-name">🏠 ' + localLabel + '</span><span class="model-item-ctx">本地</span>';
  localItem.addEventListener("click", function() {
    switchModel("local", "Local Model", 0);
  });
  dropdown.appendChild(localItem);

  // 云端模型：优先用服务端 /providers 列表（含 admAgent 内置模型，一个 provider 可能多个 model），
  // 服务端不可用时回退 admAgent.json 里用户添加的列表
  var cloudEntries = [];
  if (Array.isArray(S.serverProviders) && S.serverProviders.length > 0) {
    S.serverProviders.forEach(function(sp) {
      if (!sp || sp.id === "local") return;
      (Array.isArray(sp.models) ? sp.models : []).forEach(function(m) {
        if (!m || !m.id) return;
        cloudEntries.push({
          key: sp.id + "/" + m.id,
          providerId: sp.id,
          name: m.name || m.id,
          context_window: m.context_window || 0,
          supports_images: m.supports_images === true,
        });
      });
    });
    // admAgent.json 里刚添加、服务端尚未重载的 provider 作补充
    S.providers.forEach(function(p) {
      var exists = S.serverProviders.some(function(sp) { return sp && sp.id === p.key; });
      if (!exists) {
        cloudEntries.push({ key: p.key, providerId: p.key, name: p.name, context_window: p.context_window || 0, supports_images: p.supports_images === true });
      }
    });
  } else {
    S.providers.forEach(function(p) {
      cloudEntries.push({ key: p.key, providerId: p.key, name: p.name, context_window: p.context_window || 0, supports_images: p.supports_images === true });
    });
  }

  // 同一 provider 下模型数（用于旧格式选中态兼容：旧设置只存 provider key）
  var providerModelCount = {};
  cloudEntries.forEach(function(c) {
    providerModelCount[c.providerId] = (providerModelCount[c.providerId] || 0) + 1;
  });

  cloudEntries.forEach(function(p) {
    var item = document.createElement("div");
    var isSelected = currentProvider === p.key ||
      (currentProvider === p.providerId && providerModelCount[p.providerId] === 1);
    item.className = "model-item" + (isSelected ? " selected" : "");
    var ctxStr = p.context_window ? formatTokens(p.context_window) : "";
    item.innerHTML = '<span class="model-item-name">☁ ' + escapeHtml(p.name) + (p.supports_images ? ' 📷' : '') + '</span>' +
      (ctxStr ? '<span class="model-item-ctx">' + ctxStr + '</span>' : '');
    item.addEventListener("click", function() {
      switchModel(p.key, p.name, p.context_window || 0);
    });
    dropdown.appendChild(item);
  });

  updateModelBtn();
}

export function updateModelBtn() {
  var nameEl = document.getElementById("agent-model-name");
  if (!nameEl) return;

  // 优先使用 agentInfo（服务端实际运行的模型），保持与消息元信息一致
  if (S.agentInfo && S.agentInfo.model && S.agentInfo.model.id) {
    nameEl.textContent = S.agentInfo.model.id;
    return;
  }

  // 回退到设置中的默认 provider（初始加载或 agentInfo 不可用时）
  var provider = S.settings.agent_default_provider || "local";

  // 检查是否是本地模型
  if (provider === "local" || provider.startsWith("local:")) {
    nameEl.textContent = "Local Model";
  } else if (provider.indexOf("/") > 0) {
    // "provider/model" 复合 key（服务端列表条目）：显示 model 部分
    nameEl.textContent = provider.slice(provider.indexOf("/") + 1);
  } else {
    var p = S.providers.find(function(x) { return x.key === provider; });
    nameEl.textContent = p ? p.name : provider;
  }
}
