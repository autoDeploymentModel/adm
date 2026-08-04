// @ts-nocheck -- 历史视图暂未类型化（jsconfig checkJs 全局开启，新代码请勿加此标记）
import { t as _t } from "../i18n.js";
const template = `
<style>
  /* 全局 reset（*）由 index.html 壳层统一提供，视图内不重复定义；选择器尽量限定在本视图容器内 */

  .page-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--c-text-hi);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding: 20px 20px 16px;
  }

  .page-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 18px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  #model-list-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .filter-bar {
    flex-shrink: 0;
  }

  main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
    margin: 12px 20px 20px;
  }

  .model-card {
    position: relative;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
    transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
  }

  .model-card:hover {
    border-color: var(--c-accent);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }

  .model-card.card-running {
    border-color: rgba(33, 150, 243, 0.5);
    box-shadow: inset 3px 0 0 #2196f3;
  }

  .model-card.card-running:hover {
    box-shadow: inset 3px 0 0 #2196f3, 0 6px 20px rgba(0, 0, 0, 0.3);
  }

  .model-card.card-unavailable {
    opacity: 0.6;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .card-header .status-badge {
    flex-shrink: 0;
  }

  .model-name {
    font-weight: 600;
    font-size: 15px;
    color: var(--c-text-hi);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .card-meta {
    font-size: 13px;
    color: var(--c-text-2);
  }

  .card-features {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .card-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    border-top: 1px solid var(--c-border-soft);
    padding-top: 12px;
    margin-top: auto;
  }

  .card-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(var(--c-accent-rgb), 0.15);
  }

  .card-progress-fill {
    height: 100%;
    width: 0;
    background: var(--c-accent);
    transition: width 0.3s ease;
  }

  .grid-message {
    grid-column: 1 / -1;
    text-align: center;
    padding: 40px;
    color: var(--c-text-2);
  }

  .feature-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
  }

  .feature-supported {
    background: rgba(76, 175, 80, 0.15);
    color: #4caf50;
    border: 1px solid rgba(76, 175, 80, 0.3);
  }

  .status-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
  }

  .status-available {
    background: rgba(76, 175, 80, 0.15);
    color: #4caf50;
    border: 1px solid rgba(76, 175, 80, 0.3);
  }

  .status-unavailable {
    background: rgba(244, 67, 54, 0.15);
    color: #f44336;
    border: 1px solid rgba(244, 67, 54, 0.3);
  }

  .status-running {
    background: rgba(33, 150, 243, 0.15);
    color: #2196f3;
    border: 1px solid rgba(33, 150, 243, 0.3);
  }

  .btn {
    display: inline-block;
    padding: 5px 14px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-download {
    background: var(--c-accent);
    color: #fff;
  }

  .btn-download:hover:not(:disabled) {
    background: var(--c-accent-2);
  }

  .btn-download.downloaded {
    background: #2e7d32;
    cursor: default;
  }

  .btn-start {
    background: #1e88e5;
    color: #fff;
  }

  .btn-start:hover:not(:disabled) {
    background: #1565c0;
  }

  .btn-view {
    background: #00897b;
    color: #fff;
  }

  .btn-view:hover:not(:disabled) {
    background: #00695c;
  }

  .btn-stop {
    background: #e53935;
    color: #fff;
  }

  .btn-stop:hover:not(:disabled) {
    background: #c62828;
  }

  .btn-delete {
    background: transparent;
    color: #ef5350;
    border: 1px solid #ef5350;
  }

  .btn-delete:hover:not(:disabled) {
    background: #ef5350;
    color: #fff;
  }

  .modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-box {
    background: var(--c-panel);
    border-radius: 12px;
    padding: 24px;
    min-width: 360px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }

  .modal-box h3 {
    color: #fff;
    font-size: 16px;
    margin-bottom: 12px;
  }

  .modal-box p {
    color: var(--c-text-2);
    font-size: 14px;
    margin-bottom: 20px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-actions .btn {
    padding: 8px 20px;
    font-size: 13px;
  }

  .btn-cancel {
    background: var(--c-border);
    color: var(--c-text);
  }

  .btn-cancel:hover {
    background: var(--c-border-hi);
  }

  .btn-confirm-delete {
    background: #ef5350;
    color: #fff;
  }

  .btn-confirm-delete:hover {
    background: #d32f2f;
  }

  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 60px 20px;
    color: var(--c-text-4);
  }

  .empty-state p {
    font-size: 14px;
  }

  .loading-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(var(--c-accent-rgb), 0.3);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-toast {
    position: fixed;
    top: 20px;
    right: 20px;
    background: #c62828;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
    max-width: 400px;
  }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .log-line.error {
    color: #ff6b6b;
  }

  .log-line.success {
    color: #69db7c;
  }

  .log-line.info {
    color: #74c0fc;
  }

  .log-line.warning {
    color: #ffd43b;
  }

  .log-line.stderr {
    color: #ff8787;
  }

  .filter-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 20px 12px;
    flex-shrink: 0;
  }

  .filter-bar label {
    font-size: 13px;
    color: var(--c-text-2);
    white-space: nowrap;
  }

  .filter-bar select {
    background: var(--c-panel);
    color: var(--c-text);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    outline: none;
    cursor: pointer;
    min-width: 160px;
  }

  .filter-bar select:focus {
    border-color: var(--c-accent);
  }

  .filter-bar .model-desc-text {
    font-size: 13px;
    color: var(--c-text-3);
    padding: 6px 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
<div id="model-list-root">
<div class="page-title">${_t("模型列表")}</div>
<div class="filter-bar">
  <label for="model-type-select">${_t("模型类型")}</label>
  <select id="model-type-select"></select>
  <span class="model-desc-text" id="model-desc-text"></span>
</div>
<main>
  <div class="card-grid" id="model-grid">
    <div class="grid-message">
      <span class="loading-spinner"></span>${_t("正在加载模型列表...")}
    </div>
  </div>
</main>
<div id="delete-modal" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <h3>${_t("确认删除")}</h3>
    <p id="delete-modal-msg">${_t("确定要删除此模型吗？删除后无法恢复。")}</p>
    <div class="modal-actions">
      <button class="btn btn-cancel" id="delete-modal-cancel">${_t("取消")}</button>
      <button class="btn btn-confirm-delete" id="delete-modal-confirm">${_t("确认删除")}</button>
    </div>
  </div>
</div>
</div>
`;

let unlisteners = [];

const invoke = () => window.__adm_invoke;
const listen = () => window.__adm_listen;
const S = () => window.__adm_state;

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

function getUrlFilename(url) {
  return url ? url.split('/').pop() : null;
}

// HTML 转义：远端 model.json 内容会拼进 innerHTML / 属性，必须真实转义防注入
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isModelAvailable(needRam) {
  const systemInfo = S().systemInfo;
  if (!systemInfo) return false;
  let totalMemory;
  if (systemInfo.total_vram === systemInfo.total_ram) {
    totalMemory = systemInfo.total_ram;
  } else {
    totalMemory = systemInfo.total_ram + systemInfo.total_vram;
  }
  const ramc = totalMemory / (1024 * 1024 * 1024);
  return ramc >= parseInt(needRam);
}

function isModelDownloaded(modelId) {
  const local = S().localModels.find(m => m.model_id === modelId);
  if (!local) return false;
  const model = S().modelList.find(m => m.model_id === modelId);
  if (model && model.model_type === "文本生成图片") {
    const mainFile = getUrlFilename(model.model_url);
    if (mainFile && !local.files.includes(mainFile)) return false;
    if (model.model_diffusion) {
      const diffusionFile = getUrlFilename(model.model_diffusion);
      if (diffusionFile && !local.files.includes(diffusionFile)) return false;
    }
    if (model.model_vae) {
      const vaeFile = getUrlFilename(model.model_vae);
      if (vaeFile && !local.files.includes(vaeFile)) return false;
    }
    return true;
  }
  if (model && model.model_type === "视觉多模态理解") {
    return local.files.some(f => f.startsWith("mmproj"));
  }
  return true;
}

function showToast(message) {
  const existing = document.querySelector(".error-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "error-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function updateModelDesc() {
  const descSpan = document.getElementById("model-desc-text");
  if (S().currentTypeFilter === "all") {
    descSpan.textContent = "";
    return;
  }
  const match = S().modelList.find(function(m) { return m.model_type === S().currentTypeFilter; });
  descSpan.textContent = match && match.model_description ? match.model_description : "";
}

function getFilteredModelList() {
  if (S().currentTypeFilter === "all") return S().modelList;
  return S().modelList.filter(function(m) { return m.model_type === S().currentTypeFilter; });
}

async function populateTypeFilter() {
  try {
    const resp = await fetch("model_types.json");
    S().modelTypes = await resp.json();
  } catch (e) {
    console.error("加载模型类型列表失败:", e);
    S().modelTypes = [];
  }

  var select = document.getElementById("model-type-select");
  select.innerHTML = "";
  S().modelTypes.forEach(function(item) {
    var opt = document.createElement("option");
    opt.value = item.type === "全部模型" ? "all" : item.type;
    opt.textContent = item.type === "全部模型" ? _t("全部模型") : item.type;
    select.appendChild(opt);
  });
  select.addEventListener("change", function() {
    S().currentTypeFilter = this.value;
    updateModelDesc();
    renderModelTable();
  });
  updateModelDesc();
}

function renderModelTable() {
  const grid = document.getElementById("model-grid");
  const filteredList = getFilteredModelList();
  const st = S();

  if (filteredList.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>' + _t("暂无可用模型") + '</p></div>';
    return;
  }

  grid.innerHTML = "";

  filteredList.forEach((model) => {
    const available = isModelAvailable(model.need_ram);
    const downloaded = isModelDownloaded(model.model_id);
    const isRunning = st.runningModelId === model.model_id;

    const card = document.createElement("div");
    card.className = "model-card" + (isRunning ? " card-running" : (!available ? " card-unavailable" : ""));

    let statusHtml = "";
    if (isRunning) {
      statusHtml = '<span class="status-badge status-running">' + _t("已启动") + '</span>';
    } else if (available) {
      statusHtml = '<span class="status-badge status-available">' + _t("可用") + '</span>';
    } else {
      statusHtml = '<span class="status-badge status-unavailable">' + _t("不可用") + '</span>';
    }

    const partSize = st.partFiles[model.model_id];
    const downloadingProgress = st.downloadingModels[model.model_id];
    const isDownloadingMmproj = st.downloadingMmproj[model.model_id];
    const isDownloadingDiffusion = st.downloadingDiffusion[model.model_id];
    const isDownloadingVae = st.downloadingVae[model.model_id];
    const safeModelId = escapeHtml(model.model_id);
    let downloadBtnHtml = "";
    if (downloaded) {
      downloadBtnHtml = '';
    } else if (isDownloadingMmproj) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + _t("下载 mmproj...") + '</button>';
    } else if (isDownloadingDiffusion) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + _t("下载 diffusion...") + '</button>';
    } else if (isDownloadingVae) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + _t("下载 vae...") + '</button>';
    } else if (downloadingProgress !== undefined) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + downloadingProgress + '%</button>';
    } else if (partSize && partSize > 0) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + escapeHtml(model.model_url) + '" data-model-mmproj="' + escapeHtml(model.model_mmproj || '') + '" data-model-diffusion="' + escapeHtml(model.model_diffusion || '') + '" data-model-vae="' + escapeHtml(model.model_vae || '') + '" data-model-type="' + escapeHtml(model.model_type || '') + '" id="dl-' + safeModelId + '">' + _t("继续下载") + '</button>';
    } else if (available) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + escapeHtml(model.model_url) + '" data-model-mmproj="' + escapeHtml(model.model_mmproj || '') + '" data-model-diffusion="' + escapeHtml(model.model_diffusion || '') + '" data-model-vae="' + escapeHtml(model.model_vae || '') + '" data-model-type="' + escapeHtml(model.model_type || '') + '" id="dl-' + safeModelId + '">' + _t("下载") + '</button>';
    } else {
      downloadBtnHtml = '<button class="btn btn-download" disabled>' + _t("下载") + '</button>';
    }

    let actionsHtml = "";
    if (isRunning) {
actionsHtml = '<button class="btn btn-view" id="view-' + safeModelId + '">' + _t("查看模型") + '</button>';
      actionsHtml += '<button class="btn btn-stop" data-stop-btn="' + safeModelId + '" id="stop-' + safeModelId + '">' + _t("关闭模型") + '</button>';
    } else if (model.model_type === "文本生成图片" && downloaded) {
      actionsHtml = '<button class="btn btn-start" id="img-' + safeModelId + '">' + _t("生成图片") + '</button>';
    } else if (downloaded && available) {
      actionsHtml = '<button class="btn btn-start" data-start-btn="' + safeModelId + '" id="start-' + safeModelId + '">' + _t("启动") + '</button>';
    } else if (downloaded) {
      actionsHtml = '<button class="btn btn-start" disabled>' + _t("启动") + '</button>';
    } else {
      actionsHtml = '';
    }
    if (downloaded && !isRunning) {
      actionsHtml += '<button class="btn btn-delete" data-delete-btn="' + safeModelId + '">' + _t("删除") + '</button>';
    }

    const features = [];
    if (model.support_tools) features.push('<span class="feature-badge feature-supported">' + _t("工具调用") + '</span>');
    if (model.support_reasoning) features.push('<span class="feature-badge feature-supported">' + _t("推理") + '</span>');
    if (model.support_images) features.push('<span class="feature-badge feature-supported">' + _t("图片识别") + '</span>');
    const featuresHtml = features.length > 0 ? '<div class="card-features">' + features.join('') + '</div>' : '';

    const isDownloadingPhase = isDownloadingMmproj || isDownloadingDiffusion || isDownloadingVae;
    const progressVisible = downloadingProgress !== undefined || isDownloadingPhase;
    const progressValue = downloadingProgress !== undefined ? downloadingProgress : 0;

    card.innerHTML =
      '<div class="card-header"><span class="model-name" title="' + safeModelId + '">' + escapeHtml(model.model_id) + '</span>' + statusHtml + '</div>' +
      '<div class="card-meta">' + escapeHtml(model.model_type || '-') + ' · ' + escapeHtml(model.model_size) + ' · ' + _t("需内存 ") + escapeHtml(model.need_ram) + _t(" GB") + '</div>' +
      featuresHtml +
      '<div class="card-actions">' + downloadBtnHtml + actionsHtml + '</div>' +
      '<div class="card-progress" data-progress-wrap="' + safeModelId + '" style="display:' + (progressVisible ? 'block' : 'none') + ';">' +
        '<div class="card-progress-fill" data-progress-bar="' + safeModelId + '" style="width:' + progressValue + '%;"></div>' +
      '</div>';

    grid.appendChild(card);
  });

  bindRowEvents();
}

function bindRowEvents() {
  const st = S();
  const dlBtns = document.querySelectorAll('#model-grid .btn-download:not(.downloaded):not([disabled])');
  dlBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleDownload(btn); });
  });
  const startBtns = document.querySelectorAll('#model-grid .btn-start[data-start-btn]');
  startBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleStart(btn); });
  });
  const stopBtns = document.querySelectorAll('#model-grid .btn-stop[data-stop-btn]');
  stopBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleStop(btn); });
  });
  const viewBtns = document.querySelectorAll('#model-grid .btn-view');
  viewBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.id.replace('view-', '');
      goModel(modelId);
    });
  });
  const imgBtns = document.querySelectorAll('#model-grid .btn-start[id^="img-"]');
  imgBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.id.replace('img-', '');
      openImageGen(modelId);
    });
  });
  const deleteBtns = document.querySelectorAll('#model-grid .btn-delete[data-delete-btn]');
  deleteBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.dataset.deleteBtn;
      showDeleteConfirm(modelId);
    });
  });
}

async function handleDownload(btn) {
  const modelId = btn.dataset.modelId;
  const modelUrl = btn.dataset.modelUrl;
  console.log("[model_list] 开始下载模型:", modelId, "URL:", modelUrl);
  const modelMmproj = btn.dataset.modelMmproj || null;
  const modelDiffusion = btn.dataset.modelDiffusion || null;
  const modelVae = btn.dataset.modelVae || null;
  const modelType = btn.dataset.modelType || '';
  if (btn) {
    const hasPart = S().partFiles[modelId] && S().partFiles[modelId] > 0;
    btn.textContent = hasPart ? _t("继续下载中...") : "0%";
    btn.disabled = true;
  }

  try {
    await invoke()("download_model", { modelId: modelId, modelUrl: modelUrl, modelMmproj: modelMmproj, modelDiffusion: modelDiffusion, modelVae: modelVae, modelType: modelType });
    console.log("[model_list] 下载模型 invoke 完成:", modelId);
  } catch (e) {
    console.error("[model_list] 下载失败:", e);
    showToast(_t("下载失败: ") + e);
    if (btn) {
      btn.textContent = _t("下载");
      btn.disabled = false;
    }
  }
}

async function handleStart(btn) {
  const modelId = btn.dataset.startBtn;
  console.log("[model_list] 启动模型:", modelId);
  try {
    const settings = await invoke()("load_settings");
    const params = settings.launch_params || settings.launchParams;

    if (!params) {
      console.error("[DEBUG] params is undefined! settings keys:", Object.keys(settings));
    }

    const model = S().modelList.find(m => m.model_id === modelId);
    const supportImages = model ? model.support_images : false;
    const modelFilename = model ? getUrlFilename(model.model_url) : null;

    btn.textContent = _t("启动中...");
    btn.disabled = true;

    await invoke()("start_model", { modelId: modelId, params: params, supportImages: supportImages, modelFilename: modelFilename });
    console.log("[model_list] 启动模型 invoke 完成:", modelId);
  } catch (e) {
    console.error("[model_list] 启动失败:", e);
    showToast(_t("启动失败: ") + e);
    renderModelTable();
  }
}

async function handleStop(btn) {
  console.log("[model_list] 停止模型");
  try {
    await invoke()("stop_model");
    S().runningModelId = null;
    S().runningModelPort = null;
    renderModelTable();
  } catch (e) {
    showToast(_t("停止失败: ") + e);
  }
}

function openImageGen(modelId) {
  location.hash = "#/image?model_id=" + encodeURIComponent(modelId);
}

function goModel(modelId) {
  const port = S().runningModelPort || 5678;
  // 直接用系统浏览器打开模型 WebUI（壳层 openUrl 走 opener 插件）
  window.openUrl("http://127.0.0.1:" + port);
}

function showDeleteConfirm(modelId) {
  const modal = document.getElementById("delete-modal");
  document.getElementById("delete-modal-msg").textContent = _t("确定要删除模型 \"") + modelId + _t("\" 吗？删除后无法恢复。");
  modal.style.display = "flex";
  modal.dataset.modelId = modelId;
}

function hideDeleteConfirm() {
  document.getElementById("delete-modal").style.display = "none";
}

async function handleDelete(modelId) {
  try {
    await invoke()("delete_local_model", { modelId: modelId });
    const idx = S().localModels.findIndex(function(m) { return m.model_id === modelId; });
    if (idx !== -1) S().localModels.splice(idx, 1);
    delete S().partFiles[modelId];
    renderModelTable();
  } catch (e) {
    showToast(_t("删除失败: ") + e);
  }
}

function updateProgressBar(modelId, progress) {
  const wrap = document.querySelector('[data-progress-wrap="' + modelId + '"]');
  if (wrap) wrap.style.display = "block";
  const bar = document.querySelector('[data-progress-bar="' + modelId + '"]');
  if (bar) bar.style.width = progress + "%";
}

function handleTauriEvent(type, payload) {
  console.log("[model_list] 事件:", type, "payload:", JSON.stringify(payload).substring(0, 200));
  const st = S();
  const { model_id, progress, error, port } = payload || {};

  switch (type) {
    case "download-progress": {
      const t = payload.type || "model";
      if (t === "mmproj") {
        st.downloadingMmproj[model_id] = true;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = "mmproj " + progress + "%";
      } else if (t === "diffusion") {
        st.downloadingDiffusion[model_id] = progress;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = "diffusion " + progress + "%";
      } else if (t === "vae") {
        st.downloadingVae[model_id] = progress;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = "vae " + progress + "%";
      } else {
        st.downloadingModels[model_id] = progress;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = progress + "%";
      }
      updateProgressBar(model_id, progress);
      break;
    }
    case "download-complete": {
      const t = payload.type || "model";
      if (t === "mmproj") {
        delete st.downloadingMmproj[model_id];
        delete st.downloadingModels[model_id];
        const local = st.localModels.find(m => m.model_id === model_id);
        if (local) {
          if (!local.files.some(f => f.startsWith("mmproj"))) local.files.push("mmproj-downloaded.gguf");
        } else {
          st.localModels.push({ model_id: model_id, files: ["mmproj-downloaded.gguf"] });
        }
        delete st.partFiles[model_id];
        renderModelTable();
      } else if (t === "diffusion") {
        delete st.downloadingDiffusion[model_id];
        const model = st.modelList.find(m => m.model_id === model_id);
        const local = st.localModels.find(m => m.model_id === model_id);
        const filename = model ? getUrlFilename(model.model_diffusion) : null;
        if (local && filename) {
          if (!local.files.includes(filename)) local.files.push(filename);
        } else if (filename) {
          st.localModels.push({ model_id: model_id, files: [filename] });
        }
        delete st.partFiles[model_id];
        renderModelTable();
      } else if (t === "vae") {
        delete st.downloadingVae[model_id];
        const model = st.modelList.find(m => m.model_id === model_id);
        const local = st.localModels.find(m => m.model_id === model_id);
        const filename = model ? getUrlFilename(model.model_vae) : null;
        if (local && filename) {
          if (!local.files.includes(filename)) local.files.push(filename);
        } else if (filename) {
          st.localModels.push({ model_id: model_id, files: [filename] });
        }
        delete st.partFiles[model_id];
        renderModelTable();
      } else {
        delete st.downloadingModels[model_id];
        const model = st.modelList.find(m => m.model_id === model_id);
        const local = st.localModels.find(m => m.model_id === model_id);
        const mainFile = model ? getUrlFilename(model.model_url) : null;
        if (model && model.model_type === "视觉多模态理解" && model.model_mmproj) {
          if (local && mainFile) {
            if (!local.files.includes(mainFile)) local.files.push(mainFile);
          } else if (mainFile) {
            st.localModels.push({ model_id: model_id, files: [mainFile] });
          }
          st.downloadingMmproj[model_id] = true;
          const btn = document.querySelector('[data-model-id="' + model_id + '"]');
          if (btn) { btn.textContent = _t("下载 mmproj..."); btn.disabled = true; }
          updateProgressBar(model_id, 0);
        } else if (model && model.model_type === "文本生成图片") {
          if (local && mainFile) {
            if (!local.files.includes(mainFile)) local.files.push(mainFile);
          } else if (mainFile) {
            st.localModels.push({ model_id: model_id, files: [mainFile] });
          }
          delete st.partFiles[model_id];
          const btn = document.querySelector('[data-model-id="' + model_id + '"]');
          if (btn) { btn.textContent = _t("下载 diffusion..."); btn.disabled = true; }
          updateProgressBar(model_id, 0);
        } else {
          if (local && mainFile) {
            if (!local.files.includes(mainFile)) local.files.push(mainFile);
          } else if (mainFile) {
            st.localModels.push({ model_id: model_id, files: [mainFile] });
          }
          delete st.partFiles[model_id];
          renderModelTable();
        }
      }
      break;
    }
    case "download-error": {
      delete st.downloadingModels[model_id];
      showToast(_t("下载失败 [") + model_id + _t("]: ") + error);
      renderModelTable();
      break;
    }
    case "model-log": {
      break;
    }
case "model-started": {
      st.runningModelId = model_id;
      st.runningModelPort = port;
      renderModelTable();
      break;
    }
    case "model-stopped": {
      st.runningModelId = null;
      st.runningModelPort = null;
      renderModelTable();
      break;
    }
    case "model-error": {
      showToast(_t("模型错误 [") + model_id + _t("]: ") + error);
      break;
    }
  }
}

async function init() {
  console.log("[model_list] init() 开始");
  const st = S();
  if (!st.systemInfo) {
    try {
      st.systemInfo = await invoke()("get_system_info");
      try {
        const gpuInfo = await invoke()("plugin:hwinfo|get_gpu_info");
        if (gpuInfo && gpuInfo.vramMb) {
          st.systemInfo.total_vram = gpuInfo.vramMb * 1024 * 1024;
          st.systemInfo.has_gpu = true;
        }
      } catch (_) {}
      try {
        const ramInfo = await invoke()("plugin:hwinfo|get_ram_info");
        if (ramInfo && ramInfo.sizeMb) {
          st.systemInfo.total_ram = ramInfo.sizeMb * 1024 * 1024;
        }
      } catch (_) {}
    } catch (e) {
      console.error("获取系统信息失败:", e);
    }
  }

  try { st.localModels = await invoke()("scan_local_models"); } catch (e) { console.error("扫描本地模型失败:", e); }

  try {
    const parts = await invoke()("scan_part_files");
    st.partFiles = {};
    for (const p of parts) st.partFiles[p.model_id] = p.existing_size;
  } catch (e) { console.error("扫描未完成下载失败:", e); }

  try { st.downloadingModels = await invoke()("get_downloading_models"); } catch (e) { console.error("获取正在下载的模型失败:", e); }

  try {
    const phases = await invoke()("get_downloading_phases");
    for (const [modelId, phase] of Object.entries(phases)) {
      if (phase === "mmproj") st.downloadingMmproj[modelId] = true;
      else if (phase === "diffusion") st.downloadingDiffusion[modelId] = true;
      else if (phase === "vae") st.downloadingVae[modelId] = true;
    }
  } catch (e) { console.error("获取下载阶段信息失败:", e); }

  try {
    const status = await invoke()("get_model_status");
if (status.running) {
  st.runningModelId = status.model_id;
  st.runningModelPort = status.port;
}
  } catch (e) { console.error("获取模型状态失败:", e); }

  try {
    st.modelList = await invoke()("fetch_model_list");
  } catch (e) {
    showToast(_t("获取模型列表失败: ") + e);
  }

  await populateTypeFilter();
  renderModelTable();
  console.log("[model_list] init() 完成, 模型数量:", st.modelList.length);
}

function setupListeners() {
  const L = listen();
  const events = ["download-progress", "download-complete", "download-error", "model-started", "model-stopped", "model-error"];
  events.forEach(function(ev) {
    try {
      L(ev, function(event) { handleTauriEvent(ev, event.payload); })
        .then(function(u) { unlisteners.push(u); })
        .catch(function() {});
    } catch (_) {}
  });
}

export default {
  template,
  mount(root) {
    console.log("[model_list] mount()");
    root.innerHTML = template;
S().currentTypeFilter = "all";

    // 禁用页面右键（屏蔽浏览器默认菜单，删除弹窗在根容器内一并覆盖）
    var listRoot = document.getElementById("model-list-root");
    if (listRoot) listRoot.addEventListener("contextmenu", function(e) { e.preventDefault(); });

  setupListeners();
    init();

    document.getElementById("delete-modal-cancel").addEventListener("click", hideDeleteConfirm);
    document.getElementById("delete-modal-confirm").addEventListener("click", async function() {
      const modal = document.getElementById("delete-modal");
      const modelId = modal.dataset.modelId;
      hideDeleteConfirm();
      if (modelId) await handleDelete(modelId);
    });
    document.getElementById("delete-modal").addEventListener("click", function(e) {
      if (e.target === this) hideDeleteConfirm();
    });
  },
  unmount() {
    console.log("[model_list] unmount()");
    unlisteners.forEach(function(u) { try { if (typeof u === 'function') u(); } catch (_) {} });
    unlisteners = [];
  }
};
