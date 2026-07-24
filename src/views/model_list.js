const template = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  .page-title {
    font-size: 18px;
    font-weight: 600;
    color: #ffffff;
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
    background: #6c63ff;
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

  .table-wrapper {
    border-radius: 8px;
    overflow: visible;
    clip-path: inset(0 round 8px);
    margin: 0 20px 20px;
  }

  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    background: #16213e;
  }

  thead {
    position: sticky;
    top: 0;
    z-index: 2;
    background: #0f3460;
  }

  th {
    padding: 12px 16px;
    text-align: left;
    font-weight: 600;
    font-size: 13px;
    color: #a0a0c0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    position: sticky;
    top: 0;
    z-index: 2;
    background: #0f3460;
  }

  th:last-child {
    text-align: center;
  }

  td {
    padding: 12px 16px;
    border-top: 1px solid #1a1a3e;
    font-size: 14px;
  }

  td:last-child {
    text-align: center;
  }

  tbody tr:hover {
    background: #1a2744;
  }

  .model-name {
    font-weight: 500;
    color: #ffffff;
  }

  .model-type {
    color: #a0a0c0;
  }

  .model-size {
    color: #a0a0c0;
  }

  .ram-need {
    color: #a0a0c0;
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

  .feature-unsupported {
    background: rgba(150, 150, 150, 0.1);
    color: #808080;
    border: 1px solid rgba(150, 150, 150, 0.2);
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
    margin: 0 3px;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-download {
    background: #6c63ff;
    color: #fff;
  }

  .btn-download:hover:not(:disabled) {
    background: #5a52d5;
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


  .actions-cell {
    white-space: nowrap;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #606080;
  }

  .empty-state p {
    font-size: 14px;
  }

  .loading-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(108, 99, 255, 0.3);
    border-top-color: #6c63ff;
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
    color: #a0a0c0;
    white-space: nowrap;
  }

  .filter-bar select {
    background: #16213e;
    color: #e0e0e0;
    border: 1px solid #2a2a4e;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    outline: none;
    cursor: pointer;
    min-width: 160px;
  }

  .filter-bar select:focus {
    border-color: #6c63ff;
  }

  .filter-bar .model-desc-text {
    font-size: 13px;
    color: #8080a0;
    padding: 6px 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
<div id="model-list-root">
<div class="page-title">模型列表</div>
<div class="filter-bar">
  <label for="model-type-select">模型类型</label>
  <select id="model-type-select"></select>
  <span class="model-desc-text" id="model-desc-text"></span>
</div>
<main>
  <div class="table-wrapper"><table id="model-table">
    <thead>
      <tr>
        <th>模型名称</th>
        <th>模型类型</th>
        <th>模型大小</th>
        <th>内存需求</th>
        <th>工具调用</th>
        <th>推理</th>
        <th>图片识别</th>
        <th>状态</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody id="model-tbody">
      <tr>
        <td colspan="9" style="text-align:center; padding:40px;">
          <span class="loading-spinner"></span>正在加载模型列表...
        </td>
      </tr>
    </tbody>
  </table></div>
</main>
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
  setTimeout(() => toast.remove(), 4000);
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
    opt.textContent = item.type;
    select.appendChild(opt);
  });
  select.addEventListener("change", function() {
    S().currentTypeFilter = this.value;
    updateModelDesc();
    renderModelTable();
  });
  updateModelDesc();
}

function addLogLine(line, type = 'info') {
  // 委托给全局启动日志面板
  if (typeof window.addLaunchLog === 'function') {
    window.addLaunchLog(line, type);
  }
}

function renderModelTable() {
  const tbody = document.getElementById("model-tbody");
  const filteredList = getFilteredModelList();
  const st = S();

  if (filteredList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><p>暂无可用模型</p></td></tr>';
    return;
  }

  tbody.innerHTML = "";

  filteredList.forEach((model) => {
    const available = isModelAvailable(model.need_ram);
    const downloaded = isModelDownloaded(model.model_id);
    const isRunning = st.runningModelId === model.model_id;

    const tr = document.createElement("tr");

    let statusHtml = "";
    if (isRunning) {
      statusHtml = '<span class="status-badge status-running">已启动</span>';
    } else if (available) {
      statusHtml = '<span class="status-badge status-available">可用</span>';
    } else {
      statusHtml = '<span class="status-badge status-unavailable">不可用</span>';
    }

    const partSize = st.partFiles[model.model_id];
    const downloadingProgress = st.downloadingModels[model.model_id];
    const isDownloadingMmproj = st.downloadingMmproj[model.model_id];
    const isDownloadingDiffusion = st.downloadingDiffusion[model.model_id];
    const isDownloadingVae = st.downloadingVae[model.model_id];
    const safeModelId = model.model_id.replace(/"/g, '"');
    let downloadBtnHtml = "";
    if (downloaded) {
      downloadBtnHtml = '<button class="btn btn-download downloaded" disabled>已下载</button>';
    } else if (isDownloadingMmproj) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>下载 mmproj...</button>';
    } else if (isDownloadingDiffusion) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>下载 diffusion...</button>';
    } else if (isDownloadingVae) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>下载 vae...</button>';
    } else if (downloadingProgress !== undefined) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + downloadingProgress + '%</button>';
    } else if (partSize && partSize > 0) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + model.model_url.replace(/"/g, '"') + '" data-model-mmproj="' + (model.model_mmproj || '').replace(/"/g, '"') + '" data-model-diffusion="' + (model.model_diffusion || '').replace(/"/g, '"') + '" data-model-vae="' + (model.model_vae || '').replace(/"/g, '"') + '" data-model-type="' + (model.model_type || '').replace(/"/g, '"') + '" id="dl-' + safeModelId + '">继续下载</button>';
    } else if (available) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + model.model_url.replace(/"/g, '"') + '" data-model-mmproj="' + (model.model_mmproj || '').replace(/"/g, '"') + '" data-model-diffusion="' + (model.model_diffusion || '').replace(/"/g, '"') + '" data-model-vae="' + (model.model_vae || '').replace(/"/g, '"') + '" data-model-type="' + (model.model_type || '').replace(/"/g, '"') + '" id="dl-' + safeModelId + '">下载</button>';
    } else {
      downloadBtnHtml = '<button class="btn btn-download" disabled>下载</button>';
    }

    let actionsHtml = "";
    if (isRunning) {
actionsHtml = '<button class="btn btn-view" id="view-' + safeModelId + '">查看模型</button>';
      actionsHtml += '<button class="btn btn-stop" data-stop-btn="' + safeModelId + '" id="stop-' + safeModelId + '">关闭模型</button>';
    } else if (model.model_type === "文本生成图片" && downloaded) {
      actionsHtml = '<button class="btn btn-start" id="img-' + safeModelId + '">生成图片</button>';
    } else if (downloaded && available) {
      actionsHtml = '<button class="btn btn-start" data-start-btn="' + safeModelId + '" id="start-' + safeModelId + '">启动</button>';
    } else if (downloaded) {
      actionsHtml = '<button class="btn btn-start" disabled>启动</button>';
    } else {
      actionsHtml = '';
    }

    const toolsBadge = model.support_tools
      ? '<span class="feature-badge feature-supported">支持</span>'
      : '<span class="feature-badge feature-unsupported">不支持</span>';

    const reasoningBadge = model.support_reasoning
      ? '<span class="feature-badge feature-supported">支持</span>'
      : '<span class="feature-badge feature-unsupported">不支持</span>';

    const imagesBadge = model.support_images
      ? '<span class="feature-badge feature-supported">支持</span>'
      : '<span class="feature-badge feature-unsupported">不支持</span>';

    tr.innerHTML =
      '<td class="model-name">' + model.model_id + '</td>' +
      '<td class="model-type">' + (model.model_type || '-') + '</td>' +
      '<td class="model-size">' + model.model_size + '</td>' +
      '<td class="ram-need">' + model.need_ram + ' GB</td>' +
      '<td>' + toolsBadge + '</td>' +
      '<td>' + reasoningBadge + '</td>' +
      '<td>' + imagesBadge + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td class="actions-cell">' + downloadBtnHtml + ' ' + actionsHtml + '</td>';

    tbody.appendChild(tr);
  });

  bindRowEvents();
}

function bindRowEvents() {
  const st = S();
  const dlBtns = document.querySelectorAll('#model-tbody .btn-download:not(.downloaded):not([disabled])');
  dlBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleDownload(btn); });
  });
  const startBtns = document.querySelectorAll('#model-tbody .btn-start[data-start-btn]');
  startBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleStart(btn); });
  });
  const stopBtns = document.querySelectorAll('#model-tbody .btn-stop[data-stop-btn]');
  stopBtns.forEach(function(btn) {
    btn.addEventListener('click', function() { handleStop(btn); });
  });
  const viewBtns = document.querySelectorAll('#model-tbody .btn-view');
  viewBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.id.replace('view-', '');
      goModel(modelId);
    });
  });
  const imgBtns = document.querySelectorAll('#model-tbody .btn-start[id^="img-"]');
  imgBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.id.replace('img-', '');
      openImageGen(modelId);
    });
  });
}

async function handleDownload(btn) {
  const modelId = btn.dataset.modelId;
  const modelUrl = btn.dataset.modelUrl;
  const modelMmproj = btn.dataset.modelMmproj || null;
  const modelDiffusion = btn.dataset.modelDiffusion || null;
  const modelVae = btn.dataset.modelVae || null;
  const modelType = btn.dataset.modelType || '';
  if (btn) {
    const hasPart = S().partFiles[modelId] && S().partFiles[modelId] > 0;
    btn.textContent = hasPart ? "继续下载中..." : "0%";
    btn.disabled = true;
  }

  try {
    await invoke()("download_model", { modelId: modelId, modelUrl: modelUrl, modelMmproj: modelMmproj, modelDiffusion: modelDiffusion, modelVae: modelVae, modelType: modelType });
  } catch (e) {
    showToast("下载失败: " + e);
    if (btn) {
      btn.textContent = "下载";
      btn.disabled = false;
    }
  }
}

async function handleStart(btn) {
  const modelId = btn.dataset.startBtn;
  try {
    const settings = await invoke()("load_settings");
    const params = settings.launch_params || settings.launchParams;

    if (!params) {
      console.error("[DEBUG] params is undefined! settings keys:", Object.keys(settings));
    }

    const model = S().modelList.find(m => m.model_id === modelId);
    const supportImages = model ? model.support_images : false;
    const modelFilename = model ? getUrlFilename(model.model_url) : null;

    btn.textContent = "启动中...";
    btn.disabled = true;

    await invoke()("start_model", { modelId: modelId, params: params, supportImages: supportImages, modelFilename: modelFilename });
  } catch (e) {
    showToast("启动失败: " + e);
    renderModelTable();
  }
}

async function handleStop(btn) {
  try {
    await invoke()("stop_model");
    S().runningModelId = null;
    S().runningModelPort = null;
    renderModelTable();
  } catch (e) {
    showToast("停止失败: " + e);
  }
}

function openImageGen(modelId) {
  location.hash = "#/image?model_id=" + encodeURIComponent(modelId);
}

function goModel(modelId) {
  const port = S().runningModelPort || 5678;
  location.hash = "#/chat?model_id=" + encodeURIComponent(modelId) + "&port=" + port;
}

function handleTauriEvent(type, payload) {
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
          if (btn) { btn.textContent = "下载 mmproj..."; btn.disabled = true; }
        } else if (model && model.model_type === "文本生成图片") {
          if (local && mainFile) {
            if (!local.files.includes(mainFile)) local.files.push(mainFile);
          } else if (mainFile) {
            st.localModels.push({ model_id: model_id, files: [mainFile] });
          }
          delete st.partFiles[model_id];
          const btn = document.querySelector('[data-model-id="' + model_id + '"]');
          if (btn) { btn.textContent = "下载 diffusion..."; btn.disabled = true; }
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
      showToast("下载失败 [" + model_id + "]: " + error);
      renderModelTable();
      break;
    }
    case "model-log": {
      const logLine = payload?.line;
      const source = payload?.source || 'stdout';
      if (logLine) {
        let logType = 'info';
        if (source === 'stderr') logType = 'stderr';
        else if (logLine.includes('error') || logLine.includes('Error') || logLine.includes('ERROR')) logType = 'error';
        else if (logLine.includes('warning') || logLine.includes('Warning') || logLine.includes('WARN')) logType = 'warning';
        else if (logLine.includes('success') || logLine.includes('Success') || logLine.includes('SUCCESS') || logLine.includes('listening') || logLine.includes('started')) logType = 'success';
        addLogLine(`[${new Date().toLocaleTimeString()}] ${logLine}`, logType);
      }
      break;
    }
case "model-started": {
      st.runningModelId = model_id;
      st.runningModelPort = port;
      renderModelTable();
      // 日志面板默认不自动弹出，用户可点击底部栏「启动日志」按钮查看
      addLogLine(`[${new Date().toLocaleTimeString()}] ✅ 模型启动成功! 端口: ${port}`, 'success');
      break;
    }
    case "model-stopped": {
      st.runningModelId = null;
      st.runningModelPort = null;
      renderModelTable();
      addLogLine(`[${new Date().toLocaleTimeString()}] ⏹️ 模型已停止`, 'info');
      break;
    }
    case "model-error": {
      showToast("模型错误 [" + model_id + "]: " + error);
      addLogLine(`[${new Date().toLocaleTimeString()}] ❌ 模型错误: ${error}`, 'error');
      break;
    }
  }
}

async function init() {
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
    showToast("获取模型列表失败: " + e);
  }

  await populateTypeFilter();
  renderModelTable();
}

function setupListeners() {
  const L = listen();
  const events = ["download-progress", "download-complete", "download-error", "model-log", "model-started", "model-stopped", "model-error"];
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
    root.innerHTML = template;
S().currentTypeFilter = "all";
  S().currentLogModelId = null;

  setupListeners();
    init();
  },
  unmount() {
    unlisteners.forEach(function(u) { try { if (typeof u === 'function') u(); } catch (_) {} });
    unlisteners = [];
  }
};
