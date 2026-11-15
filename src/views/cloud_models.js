// 云端模型管理视图（hash 路由 #/cloud，底部导航「云端模型」，位于 Agent 右侧）
// 从 Agent 设置弹窗独立成页：管理 admAgent.json 的 providers（OpenAI 兼容云端模型）。
// 与 Agent 视图解耦：只依赖 Rust 命令与 agent_http_request，不依赖 agent.js 的 init 状态；
// 增删改后会尽量把变更热同步进运行中的 admAgent 服务端（/config/* 触发配置重载）。
import { t as _t } from "../i18n.js";
import { friendlyError } from "./agent/error.js";
import { escapeHtml, parseContextSize, slugifyProviderKey, $input } from "./agent/utils.js";
import { api } from "./agent/api.js";

const invoke = window.__adm_invoke;

/**
 * @typedef {{ key: string, name: string, base_url: string, api_key: string,
 *             context_window: number, model_id: string, supports_images: boolean,
 *             can_reason: boolean }} CloudProvider
 * @typedef {{ running: boolean, host: string|null, workspace_id: string|null }} AgentServerStatus
 */

const state = {
  /** @type {CloudProvider[]} */
  providers: [],
  /** @type {AgentServerStatus|null} */
  server: null,
  /** @type {any} load_settings 结果（判断当前激活的 provider） */
  settings: null,
  /** @type {string|null} 非 null = 修改模式，值为正在编辑的 provider key */
  editingKey: null,
  /** 数据版本号：切走页面后迟到的响应直接丢弃 */
  seq: 0,
  /** 模型ID 候选请求序号（并发拉取丢弃旧响应） */
  fetchSeq: 0,
  lastFetchSig: "",
  /** @type {number|null} 保存成功后延迟关闭弹窗的定时器 */
  closeTimer: null,
  /** @type {string} 列表加载失败的错误文案（空串 = 正常）。失败时不能拿空列表冒充「暂无云端模型」 */
  loadError: "",
};

/** @type {number|null} */
let toastTimer = null;

const template = `
<style>
  #cloud-models-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
  }

  .cloud-models-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
    padding: 0 20px;
  }

  .cloud-models-header {
    flex-shrink: 0;
    padding: 20px 0 12px;
  }

  .cloud-models-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--c-text-hi);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cloud-models-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 18px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  .cloud-models-desc {
    margin-top: 8px;
    font-size: 12px;
    color: var(--c-text-3);
    line-height: 1.6;
  }

  .cloud-provider-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-bottom: 12px;
    padding-right: 2px;
  }

  .cloud-provider-empty {
    color: var(--c-text-4);
    font-size: 13px;
    padding: 16px 0;
  }

  .cloud-provider-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 16px;
    border: 1px solid rgba(239, 68, 68, 0.35);
    background: rgba(239, 68, 68, 0.08);
    border-radius: 10px;
    margin-bottom: 10px;
  }

  .cloud-provider-error-text {
    font-size: 13px;
    color: #ff6b6b;
    line-height: 1.6;
    word-break: break-all;
  }

  .cloud-provider-card {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 10px;
    transition: border-color 0.15s;
  }

  .cloud-provider-card:hover { border-color: var(--c-border-hi); }

  .cloud-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .cloud-card-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--c-text-hi);
    display: flex;
    align-items: center;
    gap: 8px;
    word-break: break-all;
  }

  .cloud-card-badge {
    flex-shrink: 0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(var(--c-accent-rgb), 0.18);
    color: var(--c-accent);
  }

  .cloud-card-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .cloud-action-btn {
    background: var(--c-overlay);
    border: none;
    color: var(--c-text-2);
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }

  .cloud-action-btn:hover { background: var(--c-overlay-strong); color: var(--c-text); }
  .cloud-action-btn.danger:hover { background: #3d1a1a; color: #ff6b6b; }

  .cloud-card-detail {
    font-size: 12px;
    color: var(--c-text-3);
    line-height: 1.6;
    word-break: break-all;
  }

  .cloud-card-warn { color: #f59e0b; }

  .cloud-add-btn {
    flex-shrink: 0;
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 16px;
    border-radius: 8px;
    border: 1px dashed var(--c-accent);
    background: rgba(var(--c-accent-rgb), 0.08);
    color: var(--c-accent);
    font-size: 13px;
    cursor: pointer;
  }

  .cloud-add-btn:hover { background: rgba(var(--c-accent-rgb), 0.16); }

  .cloud-dialog-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9100;
    justify-content: center;
    align-items: center;
  }

  .cloud-dialog-overlay.show { display: flex; }

  .cloud-dialog {
    width: 460px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  .cloud-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--c-border);
  }

  .cloud-dialog-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--c-text-hi);
  }

  .cloud-dialog-close {
    background: transparent;
    border: none;
    color: var(--c-text-3);
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .cloud-dialog-close:hover { background: var(--c-overlay); color: var(--c-text); }

  .cloud-dialog-body {
    padding: 14px 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cloud-input {
    width: 100%;
    background: var(--c-bg-deep);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }

  .cloud-input:focus { outline: none; border-color: var(--c-accent); }

  .cloud-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--c-text-2);
    cursor: pointer;
    user-select: none;
  }

  .cloud-checkbox input { cursor: pointer; }

  .cloud-note {
    font-size: 12px;
    color: var(--c-text-4);
    line-height: 1.5;
  }

  .cloud-hint {
    font-size: 12px;
    color: var(--c-text-2);
    line-height: 1.5;
    min-height: 16px;
  }

  .cloud-msg {
    font-size: 12px;
    min-height: 18px;
    line-height: 1.5;
    word-break: break-all;
  }

  .cloud-dialog-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }

  .cloud-btn {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: none;
    transition: background 0.15s, color 0.15s;
  }

  .cloud-btn-primary { background: var(--c-accent); color: #fff; }
  .cloud-btn-primary:hover { background: var(--c-accent-2); }
  .cloud-btn-secondary { background: var(--c-overlay); color: var(--c-text); }
  .cloud-btn-secondary:hover { background: var(--c-overlay-strong); }
  .cloud-btn-danger { background: #b33a3a; color: #fff; }
  .cloud-btn-danger:hover { background: #c94a4a; }

  .cloud-toast {
    position: fixed;
    left: 50%;
    bottom: 72px;
    transform: translateX(-50%);
    max-width: 70vw;
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid var(--c-border);
    background: var(--c-raise);
    color: var(--c-text);
    font-size: 13px;
    text-align: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
    z-index: 9200;
  }

  .cloud-toast.show { opacity: 1; }
</style>

<div id="cloud-models-root">
  <div class="cloud-models-page">
    <div class="cloud-models-header">
      <div class="cloud-models-title">${_t("云端模型管理")}</div>
      <div class="cloud-models-desc">${_t("管理 OpenAI 兼容接口的云端模型（写入 admAgent.json 的 providers）；添加后可在 Agent 对话页的模型下拉中切换使用。")}</div>
    </div>
    <div class="cloud-provider-list" id="cloud-provider-list"></div>
    <button class="cloud-add-btn" id="cloud-add-btn">+ ${_t("添加云端模型")}</button>
  </div>

  <!-- 添加/修改弹窗（标题与提交按钮文案按模式切换） -->
  <div class="cloud-dialog-overlay" id="cloud-model-overlay">
    <div class="cloud-dialog">
      <div class="cloud-dialog-header">
        <span class="cloud-dialog-title" id="cloud-model-title">${_t("添加云端模型")}</span>
        <button class="cloud-dialog-close" id="cloud-model-close" title="${_t("关闭")}">✕</button>
      </div>
      <div class="cloud-dialog-body">
        <input type="text" class="cloud-input" id="cloud-model-baseurl" placeholder="${_t("API Base URL (如 https://api.example.com/v1)")}">
        <input type="text" class="cloud-input" id="cloud-model-apikey" placeholder="API Key">
        <input type="text" class="cloud-input" id="cloud-model-modelid" list="cloud-model-modelid-options" placeholder="${_t("模型ID (如 Big Pickle, 可下拉选择或手动填写)")}">
        <datalist id="cloud-model-modelid-options"></datalist>
        <div id="cloud-model-fetch-msg" class="cloud-hint"></div>
        <input type="text" class="cloud-input" id="cloud-model-name" placeholder="${_t("模型名称 (可选, 默认使用模型ID)")}">
        <div id="cloud-model-key-hint" class="cloud-hint"></div>
        <input type="text" class="cloud-input" id="cloud-model-ctx" placeholder="${_t("上下文大小 (如 256K, 1M)")}">
        <label class="cloud-checkbox">
          <input type="checkbox" id="cloud-model-images"> ${_t("多模态模型（支持图片识别）")}
        </label>
        <div class="cloud-note">${_t("云端模型一律按支持思考写入；如需关闭，请在工具栏把推理强度设为「关闭」")}</div>
        <div id="cloud-model-msg" class="cloud-msg"></div>
        <div class="cloud-dialog-actions">
          <button class="cloud-btn cloud-btn-primary" id="cloud-model-submit">${_t("添加")}</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 删除确认弹窗（Tauri WebView 中原生 confirm() 不可用） -->
  <div class="cloud-dialog-overlay" id="cloud-confirm-overlay">
    <div class="cloud-dialog" style="width:400px;">
      <div class="cloud-dialog-header">
        <span class="cloud-dialog-title">${_t("确认操作")}</span>
        <button class="cloud-dialog-close" id="cloud-confirm-close" title="${_t("关闭")}">✕</button>
      </div>
      <div class="cloud-dialog-body">
        <div class="cloud-msg" id="cloud-confirm-text" style="min-height:0;"></div>
        <div class="cloud-dialog-actions">
          <button class="cloud-btn cloud-btn-secondary" id="cloud-confirm-cancel">${_t("取消")}</button>
          <button class="cloud-btn cloud-btn-danger" id="cloud-confirm-ok">${_t("删除")}</button>
        </div>
      </div>
    </div>
  </div>

  <div class="cloud-toast" id="cloud-toast"></div>
</div>
`;

// ===== 页面级提示 =====
/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function showToast(text, isError) {
  var el = document.getElementById("cloud-toast");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ff6b6b" : "var(--c-text)";
  el.classList.add("show");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    el.classList.remove("show");
    toastTimer = null;
  }, 3000);
}

// ===== 数据加载 =====
async function load() {
  var seq = ++state.seq;
  var res = await Promise.allSettled([
    invoke("list_cloud_providers"),
    invoke("get_agent_server_status"),
    invoke("load_settings"),
  ]);
  if (seq !== state.seq) return;
  if (res[0].status === "fulfilled" && Array.isArray(res[0].value)) {
    state.providers = res[0].value;
    state.loadError = "";
  } else {
    // 读取失败时清空列表并登记错误态：若沿用上一次（或空的）列表，页面会显示
    // 「暂无云端模型」与真实状态不符，用户可能重复添加、同名 slug 直接覆盖已有 provider
    state.providers = [];
    state.loadError = res[0].status === "rejected"
      ? friendlyError(res[0].reason, { prefix: "加载云端模型失败: " })
      : _t("加载云端模型失败: ") + _t("未知原因");
  }
  state.server = (res[1].status === "fulfilled" && res[1].value) ? res[1].value : null;
  state.settings = (res[2].status === "fulfilled" && res[2].value) ? res[2].value : null;
  renderList();
  // 从模型下拉带 ?add=1 直接打开弹窗时，列表晚于弹窗返回：补一次键冲突提示
  var overlay = document.getElementById("cloud-model-overlay");
  if (overlay && overlay.classList.contains("show")) updateKeyHint();
}

async function refreshProviders() {
  try {
    state.providers = await invoke("list_cloud_providers");
    // 增删改后的刷新成功即视为数据可用：清掉之前的加载失败态，避免错误横幅盖住新列表
    state.loadError = "";
  } catch (e) {
    console.warn("[cloud] 刷新云端模型列表失败:", e);
  }
  renderList();
}

// ===== 列表渲染 =====
function renderList() {
  var container = document.getElementById("cloud-provider-list");
  if (!container) return;
  container.innerHTML = "";

  if (state.loadError) {
    renderLoadError(container);
    return;
  }

  if (state.providers.length === 0) {
    container.innerHTML = '<div class="cloud-provider-empty">' + _t("暂无云端模型") + '</div>';
    return;
  }

  var active = (state.settings && state.settings.agent_default_provider) || "local";

  state.providers.forEach(function(p) {
    var isActive = active === p.key || active.indexOf(p.key + "/") === 0;
    var detail = escapeHtml(p.base_url || "") +
      (p.model_id ? " · " + _t("模型ID: ") + escapeHtml(p.model_id) : "") +
      " · " + _t("上下文: ") + (p.context_window || _t("默认")) +
      (p.supports_images ? " · " + _t("支持图片") : "") +
      (p.can_reason ? " · " + _t("思考模式") : "");
    if (!p.api_key) {
      detail += ' · <span class="cloud-card-warn">' + _t("缺少 API Key") + "</span>";
    }

    var card = document.createElement("div");
    card.className = "cloud-provider-card";
    card.innerHTML =
      '<div class="cloud-card-header">' +
        '<span class="cloud-card-name">' + escapeHtml(p.name || p.key) +
          (isActive ? '<span class="cloud-card-badge">' + _t("当前使用") + "</span>" : "") +
        "</span>" +
        '<span class="cloud-card-actions">' +
          '<button class="cloud-action-btn" data-act="edit">' + _t("修改") + "</button>" +
          '<button class="cloud-action-btn danger" data-act="delete">' + _t("删除") + "</button>" +
        "</span>" +
      "</div>" +
      '<div class="cloud-card-detail">' + detail + "</div>";

    card.querySelector('[data-act="edit"]').addEventListener("click", function() {
      openEditDialog(p);
    });
    card.querySelector('[data-act="delete"]').addEventListener("click", function() {
      askDelete(p);
    });
    container.appendChild(card);
  });
}

// 加载失败态：显示真实错误 + 重试入口（用 DOM 构建，错误文案走 textContent 防注入）
/**
 * @param {HTMLElement} container
 */
function renderLoadError(container) {
  var box = document.createElement("div");
  box.className = "cloud-provider-error";
  var msg = document.createElement("div");
  msg.className = "cloud-provider-error-text";
  msg.textContent = state.loadError;
  var retry = document.createElement("button");
  retry.className = "cloud-btn cloud-btn-secondary";
  retry.textContent = _t("重试");
  retry.addEventListener("click", function() {
    retry.disabled = true;
    retry.textContent = _t("加载中…");
    load();
  });
  box.appendChild(msg);
  box.appendChild(retry);
  container.appendChild(box);
}

// ===== 服务端热同步 =====
// 运行中的 admAgent 只在启动时读 admAgent.json；新增/修改后必须主动同步，
// 否则选中新模型会报 "active model provider not configured"。
// 注意只写标量 api_key、不写完整 provider 对象：/config/set 落盘到服务端数据配置
// 与 Rust 写入的 admAgent.json 是两个文件，完整 provider（含 models 数组）写两处
// 会让同一模型在服务端合并配置后出现两次；写标量即可触发配置重载。
/**
 * @param {string} key
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
async function syncProviderKeyToServer(key, apiKey) {
  var path = wsPath("/config/set");
  if (!path) return false;
  try {
    await api("POST", path, { scope: 0, key: "providers." + key + ".api_key", value: apiKey });
    return true;
  } catch (e) {
    console.warn("[cloud] 同步 provider 到服务端失败（重启 Agent 后生效）:", e);
    return false;
  }
}

/**
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function removeProviderFromServer(key) {
  var path = wsPath("/config/remove");
  if (!path) return false;
  try {
    await api("POST", path, { scope: 0, key: "providers." + key });
    return true;
  } catch (e) {
    console.warn("[cloud] 从服务端移除 provider 失败（重启 Agent 后生效）:", e);
    return false;
  }
}

// 服务端 /providers 快照是否已确认该 provider（只有确认后模型下拉才可选）
/**
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function serverHasProvider(key) {
  var path = wsPath("/providers");
  if (!path) return false;
  try {
    var list = await api("GET", path);
    return Array.isArray(list) && list.some(function(sp) { return sp && sp.id === key; });
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} suffix
 * @returns {string|null} 服务端未运行时返回 null
 */
function wsPath(suffix) {
  if (!state.server || !state.server.running || !state.server.workspace_id) return null;
  return "/v1/workspaces/" + state.server.workspace_id + suffix;
}

// 让服务端按指定 provider/model 重载（写 /config/model 后 /agent/update 重建 coordinator 配置）
/**
 * @param {string} provider
 * @param {string} modelId
 */
async function reloadActiveModel(provider, modelId) {
  var modelPath = wsPath("/config/model");
  if (!modelPath) return;
  try {
    await api("POST", modelPath, { scope: 0, model: { provider: provider, model: modelId } });
    await api("POST", wsPath("/agent/update"));
  } catch (e) {
    console.warn("[cloud] 通知服务端重载模型失败（重启 Agent 后生效）:", e);
  }
}

// 删除的正是当前使用的 provider：切回本地模型，避免 active model 悬空导致
// /agent/update 报 "active model provider not configured"、后续 /agent/init 失败
/**
 * @param {string} key
 */
async function deactivateIfActive(key) {
  var active = (state.settings && state.settings.agent_default_provider) || "local";
  if (!(active === key || active.indexOf(key + "/") === 0)) return;
  try {
    var s = await invoke("load_settings");
    s.agent_default_provider = "local";
    await invoke("save_settings", { settings: s });
    state.settings = s;
  } catch (e) {
    console.warn("[cloud] 删除当前使用的云端模型后写回本地模型失败:", e);
  }
  await reloadActiveModel("local", "localModel");
}

// ===== 添加/修改弹窗 =====
// 把 token 数格式化成上下文输入框接受的写法（与 parseContextSize 互逆）
/**
 * @param {number} n
 * @returns {string}
 */
function formatCtxInput(n) {
  if (!n) return "";
  if (n % 1000000 === 0) return (n / 1000000) + "M";
  if (n % 1000 === 0) return (n / 1000) + "K";
  return String(n);
}

/**
 * @param {boolean} isEdit
 */
function setDialogMode(isEdit) {
  var title = document.getElementById("cloud-model-title");
  var submit = document.getElementById("cloud-model-submit");
  if (title) title.textContent = isEdit ? _t("修改云端模型") : _t("添加云端模型");
  if (submit) submit.textContent = isEdit ? _t("保存") : _t("添加");
}

function clearForm() {
  $input("cloud-model-baseurl").value = "";
  $input("cloud-model-apikey").value = "";
  $input("cloud-model-modelid").value = "";
  $input("cloud-model-name").value = "";
  $input("cloud-model-ctx").value = "";
  $input("cloud-model-images").checked = false;
  document.getElementById("cloud-model-msg").textContent = "";
  clearModelIdOptions();
  updateKeyHint();
}

function openAddDialog() {
  // 从修改模式切回添加模式时清空回填的旧值，避免误把旧模型参数当新模型提交
  if (state.editingKey !== null) {
    state.editingKey = null;
    clearForm();
  }
  setDialogMode(false);
  document.getElementById("cloud-model-overlay").classList.add("show");
  fetchModelIds();
  updateKeyHint();
}

/**
 * @param {CloudProvider} p
 */
function openEditDialog(p) {
  state.editingKey = p.key;
  $input("cloud-model-baseurl").value = p.base_url || "";
  $input("cloud-model-apikey").value = p.api_key || "";
  $input("cloud-model-modelid").value = p.model_id || "";
  $input("cloud-model-name").value = p.name || "";
  $input("cloud-model-ctx").value = formatCtxInput(p.context_window);
  $input("cloud-model-images").checked = !!p.supports_images;
  document.getElementById("cloud-model-msg").textContent = "";
  updateKeyHint();
  setDialogMode(true);
  document.getElementById("cloud-model-overlay").classList.add("show");
  fetchModelIds();
}

function closeDialog() {
  document.getElementById("cloud-model-overlay").classList.remove("show");
}

// 名称 → providers 键的实时提示。键由「模型名称」派生（留空取模型ID，与 Rust 侧
// slugify_provider_key 一致），只在添加时计算一次；slug 后相同的名称会命中同一个键、
// 后加的静默覆盖先加的，所以在输入阶段就把派生结果显示出来并在冲突时标红。
function updateKeyHint() {
  var el = document.getElementById("cloud-model-key-hint");
  if (!el) return;
  // 修改模式：键是既有的，不随名称变化（update_cloud_provider 按原键替换）
  if (state.editingKey !== null) {
    el.textContent = _t("配置键（不随名称改变）：") + state.editingKey;
    el.style.color = "";
    return;
  }
  var name = $input("cloud-model-name").value.trim() || $input("cloud-model-modelid").value.trim();
  if (!name) {
    el.textContent = "";
    return;
  }
  var key = slugifyProviderKey(name);
  var clash = state.providers.some(function(p) { return p && p.key === key; });
  if (clash) {
    el.textContent = _t("名称与已有模型重复，配置键：") + key;
    el.style.color = "#ef4444";
  } else {
    el.textContent = _t("配置键：") + key;
    el.style.color = "";
  }
}

// ===== 模型ID 候选（OpenAI 兼容 /models，走 Rust 侧请求避开 CORS） =====
function clearModelIdOptions() {
  state.fetchSeq++;
  var dl = document.getElementById("cloud-model-modelid-options");
  if (dl) dl.innerHTML = "";
  state.lastFetchSig = "";
  var msgEl = document.getElementById("cloud-model-fetch-msg");
  if (msgEl) { msgEl.textContent = ""; msgEl.style.color = ""; }
}

/**
 * @param {string} text
 * @param {string} [color]
 */
function fetchModelsMsg(text, color) {
  var el = document.getElementById("cloud-model-fetch-msg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = color || "";
}

// 请求 {base}/models 并返回模型 ID 数组。走 Rust（`probe_models_endpoint`，10s 超时）：
// WebView 页面源是 http://tauri.localhost，服务商普遍不返回 CORS 头，前端直连会被拦。
/**
 * @param {string} base
 * @param {string} key
 * @returns {Promise<string[]>}
 */
function probeModels(base, key) {
  return invoke("probe_models_endpoint", { baseUrl: base, apiKey: key || "" });
}

async function fetchModelIds() {
  var base = $input("cloud-model-baseurl").value.trim().replace(/\/+$/, "");
  var key = $input("cloud-model-apikey").value.trim();
  var dl = document.getElementById("cloud-model-modelid-options");
  if (!dl) return;
  if (!base) { clearModelIdOptions(); return; }
  var sig = base + "|" + key;
  if (sig === state.lastFetchSig) return;
  state.lastFetchSig = sig;
  var seq = ++state.fetchSeq;
  fetchModelsMsg(_t("正在获取模型列表…"), "var(--c-text-2)");
  try {
    var ids = await probeModels(base, key);
    if (seq !== state.fetchSeq) return; // 已有更新的请求，丢弃旧响应
    dl.innerHTML = "";
    (ids || []).forEach(function(id) {
      if (!id) return;
      var o = document.createElement("option");
      o.value = String(id);
      dl.appendChild(o);
    });
    if (dl.children.length > 0) {
      fetchModelsMsg(_t("已获取 ") + dl.children.length + _t(" 个候选模型，点击模型ID输入框可下拉选择"), "var(--c-text-2)");
    } else {
      fetchModelsMsg(_t("接口返回成功但没有解析到模型，可能不是 OpenAI 兼容格式，请手动填写"), "#f59e0b");
    }
  } catch (e) {
    if (seq !== state.fetchSeq) return;
    dl.innerHTML = "";
    state.lastFetchSig = "";
    fetchModelsMsg(_t("获取模型列表失败 ") + e + _t("，请检查 Base URL / Key，仍可手动填写模型ID"), "#ef4444");
  }
}

/**
 * @param {string} text
 * @param {boolean} isError
 */
function addModelMsg(text, isError) {
  var el = document.getElementById("cloud-model-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "#22c55e";
}

function scheduleDialogClose() {
  if (state.closeTimer !== null) clearTimeout(state.closeTimer);
  state.closeTimer = setTimeout(function() {
    state.closeTimer = null;
    closeDialog();
    clearForm();
    state.editingKey = null;
  }, 1000);
}

async function submitModel() {
  var modelId = $input("cloud-model-modelid").value.trim();
  var name = $input("cloud-model-name").value.trim() || modelId;
  var baseUrl = $input("cloud-model-baseurl").value.trim();
  var apiKey = $input("cloud-model-apikey").value.trim();
  var ctx = parseContextSize($input("cloud-model-ctx").value) || 256000;
  var supportsImages = $input("cloud-model-images").checked;
  // 思考模式不再单独勾选：云端模型一律按支持思考写入（can_reason=true）

  if (!modelId || !baseUrl || !apiKey) {
    addModelMsg(_t("请填写模型ID、API地址和密钥"), true);
    return;
  }

  // 提交前校验 API 地址与密钥：请求 {base}/models，不通过则阻止写入（新增/修改均校验）。
  // 走 Rust 侧（`probe_models_endpoint`，10s 超时）：前端直连会被 CORS 拦成假报错。
  var probeBase = baseUrl.replace(/\/+$/, "");
  addModelMsg(_t("正在校验 API 地址与密钥…"), false);
  try {
    await probeModels(probeBase, apiKey);
  } catch (verifyErr) {
    addModelMsg(_t("校验失败，API 地址或密钥不正确：") + verifyErr, true);
    return;
  }
  addModelMsg(_t("校验通过，正在保存…"), false);

  var editingKey = state.editingKey;

  // 新增时先查键冲突：providers 是对象，slug 后同名的两个名称会指向同一个键，
  // 后加的会静默覆盖先加的（Rust 侧 add_cloud_provider 直接 providers[key] = ...），
  // 表现为「加完发现没保存成功」。此处拦下并提示改名或先删除已有条目；
  // 修改模式按原键替换、不会碰其它条目，无需校验。
  if (editingKey === null) {
    var derivedKey = slugifyProviderKey(name);
    var clash = state.providers.some(function(p) { return p && p.key === derivedKey; });
    if (clash) {
      addModelMsg(_t("名称与已有模型重复，配置键：") + derivedKey +
        _t("（同名会被覆盖），请改用其它名称或先删除已有条目"), true);
      return;
    }
  }

  // 修改模式：按原 key 替换全部参数（key 不变，不产生孤儿条目）
  if (editingKey) {
    try {
      await invoke("update_cloud_provider", {
        key: editingKey,
        input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: true }
      });
      // 同步运行中的 server：只写标量 api_key 触发服务端落盘+从磁盘全量重载，
      // 让刚写入 admAgent.json 的新参数（base_url / model id / 上下文等）立即生效
      await syncProviderKeyToServer(editingKey, apiKey);
      await refreshProviders();
      // 改的正是当前激活的 provider：让服务端按新 model id 重载一次
      var active = (state.settings && state.settings.agent_default_provider) || "local";
      if (active === editingKey || active.indexOf(editingKey + "/") === 0) {
        await reloadActiveModel(editingKey, modelId);
      }
      addModelMsg(_t("修改成功"), false);
      scheduleDialogClose();
    } catch (e) {
      addModelMsg(_t("修改失败: ") + e, true);
    }
    return;
  }

  try {
    var addResp = await invoke("add_cloud_provider", {
      input: { name: name, base_url: baseUrl, api_key: apiKey, context_window: ctx, model_id: modelId, supports_images: supportsImages, can_reason: true }
    });
    var addKey = addResp && addResp.key;
    var runtimeSynced = addKey ? await syncProviderKeyToServer(addKey, apiKey) : false;
    await refreshProviders();
    // 只有 /config/set 成功且 /providers 快照确实包含该 key，才算运行时可用
    var runtimeConfirmed = runtimeSynced && addKey ? await serverHasProvider(addKey) : false;
    if (runtimeConfirmed) {
      addModelMsg(_t("添加成功"), false);
      scheduleDialogClose();
    } else {
      addModelMsg(_t("配置已保存，但当前服务未加载该模型；重启 Agent 后生效"), true);
    }
  } catch (e) {
    addModelMsg(_t("添加失败: ") + e, true);
  }
}

// ===== 删除 =====
/** @type {CloudProvider|null} */
let pendingDelete = null;

/**
 * @param {CloudProvider} p
 */
function askDelete(p) {
  pendingDelete = p;
  var text = document.getElementById("cloud-confirm-text");
  if (text) text.textContent = _t("确定删除云端模型「") + (p.name || p.key) + _t("」？");
  document.getElementById("cloud-confirm-overlay").classList.add("show");
}

function closeConfirm() {
  pendingDelete = null;
  document.getElementById("cloud-confirm-overlay").classList.remove("show");
}

async function doDelete() {
  var p = pendingDelete;
  pendingDelete = null;
  document.getElementById("cloud-confirm-overlay").classList.remove("show");
  if (!p) return;
  try {
    await invoke("delete_cloud_provider", { key: p.key });
    // 同步从运行中的 server 内存配置移除（否则服务端仍持有已删 provider 直到重启）
    await removeProviderFromServer(p.key);
    await deactivateIfActive(p.key);
    await refreshProviders();
    showToast(_t("已删除云端模型: ") + (p.name || p.key), false);
  } catch (e) {
    showToast(friendlyError(e, { prefix: "删除失败: " }), true);
  }
}

// ===== 生命周期 =====
function bindEvents() {
  document.getElementById("cloud-add-btn").addEventListener("click", openAddDialog);
  document.getElementById("cloud-model-close").addEventListener("click", closeDialog);
  document.getElementById("cloud-model-submit").addEventListener("click", submitModel);
  document.getElementById("cloud-model-overlay").addEventListener("click", function(e) {
    if (e.target === document.getElementById("cloud-model-overlay")) closeDialog();
  });
  // 名称/模型ID 输入时同步展示派生出的 providers 键（同名冲突标红，避免静默覆盖）
  ["cloud-model-name", "cloud-model-modelid"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", updateKeyHint);
  });
  // baseurl/apikey 变化时拉取 /models 候选列表（datalist）
  ["cloud-model-baseurl", "cloud-model-apikey"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", fetchModelIds);
  });
  document.getElementById("cloud-confirm-close").addEventListener("click", closeConfirm);
  document.getElementById("cloud-confirm-cancel").addEventListener("click", closeConfirm);
  document.getElementById("cloud-confirm-ok").addEventListener("click", doDelete);
}

export default {
  template,
  /**
   * @param {HTMLElement} root
   * @param {Record<string, string>} [params]
   */
  mount(root, params) {
    root.innerHTML = template;
    state.editingKey = null;
    bindEvents();
    load();
    // Agent 模型下拉的「+ 添加云端模型」入口带 ?add=1 跳转过来：自动打开添加弹窗
    if (params && params.add === "1") openAddDialog();
  },
  unmount() {
    // 作废在途请求与定时器，避免响应回来后操作已销毁的 DOM
    state.seq++;
    state.fetchSeq++;
    if (state.closeTimer !== null) { clearTimeout(state.closeTimer); state.closeTimer = null; }
    if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
  },
};
