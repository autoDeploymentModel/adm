const template = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  #image-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  #header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    background: #0f3460;
    border-bottom: 1px solid #1a1a3e;
    flex-shrink: 0;
    gap: 12px;
  }

  .back-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #e0e0e0;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }

  .back-btn:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  #model-name {
    font-size: 14px;
    font-weight: 600;
    color: #ffffff;
  }

  #sd-status {
    margin-left: auto;
    font-size: 12px;
    color: #8080a0;
  }

  #content {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 20px;
    overflow-y: auto;
    gap: 16px;
  }

  #download-section {
    display: none;
    background: #16213e;
    border-radius: 8px;
    padding: 24px;
    text-align: center;
  }

  #download-section.visible {
    display: block;
  }

  .download-title {
    font-size: 15px;
    color: #e0e0e0;
    margin-bottom: 8px;
  }

  .download-desc {
    font-size: 13px;
    color: #8080a0;
    margin-bottom: 16px;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: #2a2a4e;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: #6c63ff;
    border-radius: 4px;
    transition: width 0.3s ease;
    width: 0%;
  }

  .progress-text {
    font-size: 12px;
    color: #a0a0c0;
  }

  #generate-section {
    display: none;
    flex-direction: column;
    gap: 16px;
    flex-shrink: 0;
  }

  #generate-section.visible {
    display: flex;
  }

  .input-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .input-label {
    font-size: 13px;
    font-weight: 500;
    color: #a0a0c0;
  }

  #prompt-input {
    width: 100%;
    min-height: 80px;
    background: #16213e;
    border: 1px solid #2a2a4e;
    border-radius: 8px;
    padding: 12px;
    color: #e0e0e0;
    font-size: 14px;
    font-family: inherit;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s;
  }

  #prompt-input:focus { border-color: #6c63ff; }
  #prompt-input::placeholder { color: #505070; }

  .size-row { display: flex; gap: 16px; align-items: center; }
  .size-field { display: flex; align-items: center; gap: 8px; }
  .size-field label { font-size: 13px; color: #a0a0c0; white-space: nowrap; }
  .size-field input {
    width: 100px;
    background: #16213e;
    border: 1px solid #2a2a4e;
    border-radius: 6px;
    padding: 8px 12px;
    color: #e0e0e0;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
  }
  .size-field input:focus { border-color: #6c63ff; }

  .generate-btn {
    padding: 12px 32px;
    background: #6c63ff;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    align-self: flex-start;
  }
  .generate-btn:hover:not(:disabled) { background: #5a52d5; }
  .generate-btn:disabled { background: #3a3a5e; color: #8080a0; cursor: not-allowed; }

  #image-result-section { display: none; flex-direction: column; gap: 12px; }
  #image-result-section.visible { display: flex; }

  .result-header { display: flex; align-items: center; justify-content: space-between; }
  .result-label { font-size: 13px; font-weight: 500; color: #a0a0c0; }

  .save-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #e0e0e0;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.2s;
  }
  .save-btn:hover { background: rgba(255, 255, 255, 0.2); }

  #image-container {
    background: #16213e;
    border: 1px solid #2a2a4e;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
  }
  #image-container img { max-width: 100%; max-height: 500px; border-radius: 4px; }

  .image-placeholder { text-align: center; color: #505070; }
  .image-placeholder-icon { font-size: 40px; margin-bottom: 8px; }
  .image-placeholder-text { font-size: 14px; }

  #log-section { display: none; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
  #log-section.visible { display: flex; }

  .log-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  .log-label { font-size: 13px; font-weight: 500; color: #a0a0c0; }
  .log-clear-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #8080a0;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    transition: background 0.2s;
  }
  .log-clear-btn:hover { background: rgba(255, 255, 255, 0.2); }

  #log-content {
    background: #0d1117;
    border: 1px solid #2a2a4e;
    border-radius: 8px;
    padding: 12px;
    flex: 1;
    overflow-y: auto;
    font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    min-height: 80px;
  }

  .log-line { color: #a0a0c0; white-space: pre-wrap; word-break: break-all; }
  .log-line.stderr { color: #e06c75; }
  .log-line.info { color: #98c379; }

  .toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #e06c75;
    color: #fff;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 1000;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
<div id="image-wrap">
  <div id="header">
    <button class="back-btn" id="back-btn">← 返回</button>
    <span id="model-name">文生图</span>
    <span id="sd-status"></span>
  </div>

  <div id="content">
    <div id="download-section">
      <div class="download-title">正在准备 SD 推理框架...</div>
      <div class="download-desc" id="download-desc">检测到 SD 推理框架未安装，正在下载...</div>
      <div class="progress-bar"><div class="progress-fill" id="download-progress-fill"></div></div>
      <div class="progress-text" id="download-progress-text">准备中...</div>
    </div>

    <div id="generate-section">
      <div class="input-group">
        <label class="input-label" for="prompt-input">提示词</label>
        <textarea id="prompt-input" placeholder="请输入图片描述..." spellcheck="false"></textarea>
      </div>
      <div class="size-row">
        <div class="size-field"><label>宽度</label><input type="number" id="width-input" value="1080" min="64" max="4096"></div>
        <div class="size-field"><label>高度</label><input type="number" id="height-input" value="1920" min="64" max="4096"></div>
      </div>
      <button class="generate-btn" id="generate-btn">生成图片</button>
      <div id="image-result-section">
        <div class="result-header">
          <span class="result-label">生成结果</span>
          <button class="save-btn" id="save-btn" style="display:none">💾 另存为</button>
        </div>
        <div id="image-container">
          <div class="image-placeholder">
            <div class="image-placeholder-icon">🖼️</div>
            <div class="image-placeholder-text">生成的图片将显示在这里</div>
          </div>
        </div>
      </div>
    </div>

    <div id="log-section">
      <div class="log-header">
        <span class="log-label">运行日志</span>
        <button class="log-clear-btn" id="log-clear-btn">清空</button>
      </div>
      <div id="log-content"></div>
    </div>
  </div>
</div>
`;

let unlisteners = [];
let progressPollTimer = null;
let modelId = '';
let isGenerating = false;
let currentImagePath = '';

const invoke = () => window.__adm_invoke;
const listen = () => window.__adm_listen;

function showToast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function () { toast.remove(); }, 4000);
}

function addLogLine(line, source) {
  const logContent = document.getElementById('log-content');
  if (!logContent) return;
  const logLine = document.createElement('div');
  logLine.className = 'log-line ' + (source === 'stderr' ? 'stderr' : '');
  logLine.textContent = line;
  logContent.appendChild(logLine);
  logContent.scrollTop = logContent.scrollHeight;
}

function clearLogs() {
  const el = document.getElementById('log-content');
  if (el) el.innerHTML = '';
}

function showGenerateSection() {
  document.getElementById('download-section').classList.remove('visible');
  document.getElementById('generate-section').classList.add('visible');
  document.getElementById('log-section').classList.add('visible');
  document.getElementById('image-result-section').classList.add('visible');
}

function showDownloadSection() {
  document.getElementById('download-section').classList.add('visible');
  document.getElementById('generate-section').classList.remove('visible');
  document.getElementById('log-section').classList.remove('visible');
  document.getElementById('image-result-section').classList.remove('visible');
}

function updateProgressUI(progress, status) {
  const fill = document.getElementById('download-progress-fill');
  const text = document.getElementById('download-progress-text');
  const desc = document.getElementById('download-desc');

  if (status === "resuming" || status === "downloading") {
    desc.textContent = status === "resuming" ? "检测到已下载部分文件，继续下载..." : "正在下载 SD 推理框架...";
    fill.style.width = progress + "%";
    text.textContent = "下载中 " + progress + "%";
  } else if (status === "extracting") {
    desc.textContent = "正在解压安装...";
    fill.style.width = "95%";
    text.textContent = "正在解压...";
  } else if (status === "done") {
    desc.textContent = "安装完成！";
    fill.style.width = "100%";
    text.textContent = "完成";
    document.getElementById('sd-status').textContent = '✓ SD 就绪';
    stopProgressPoll();
    setTimeout(function() { showGenerateSection(); }, 500);
  }
}

function startProgressPoll() {
  if (progressPollTimer) return;
  progressPollTimer = setInterval(async function() {
    try {
      const st = await invoke()("get_sd_status");
      if (st.downloading) {
        updateProgressUI(st.progress, st.status || "downloading");
      } else if (st.exists) {
        updateProgressUI(100, "done");
      } else {
        stopProgressPoll();
        startDownload();
      }
    } catch (e) {
      console.error("轮询进度失败:", e);
    }
  }, 2000);
}

function stopProgressPoll() {
  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

async function startDownload() {
  document.getElementById('sd-status').textContent = '⏳ 下载中...';
  showDownloadSection();
  try {
    await invoke()("download_and_extract_sd");
  } catch (e) {
    if (e && e.indexOf && e.indexOf("正在下载中") !== -1) {
      document.getElementById('sd-status').textContent = '⏳ 下载中...';
      showDownloadSection();
      startProgressPoll();
      return;
    }
    document.getElementById('sd-status').textContent = '✗ 错误';
    showToast("SD 下载失败: " + e);
  }
}

async function initPage() {
  try {
    document.getElementById('sd-status').textContent = '检测中...';
    const status = await invoke()("get_sd_status");
    if (status.exists) {
      document.getElementById('sd-status').textContent = '✓ SD 就绪';
      showGenerateSection();
    } else if (status.downloading) {
      document.getElementById('sd-status').textContent = '⏳ 下载中...';
      showDownloadSection();
      updateProgressUI(status.progress, "downloading");
      startProgressPoll();
    } else {
      await startDownload();
    }
  } catch (e) {
    document.getElementById('sd-status').textContent = '✗ 错误';
    showToast("SD 初始化失败: " + e);
  }
}

async function handleGenerate() {
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) { showToast("请输入提示词"); return; }

  const width = parseInt(document.getElementById('width-input').value) || 1080;
  const height = parseInt(document.getElementById('height-input').value) || 1920;

  if (width < 64 || width > 4096 || height < 64 || height > 4096) {
    showToast("宽度和高度需在 64-4096 之间");
    return;
  }

  const btn = document.getElementById('generate-btn');
  btn.textContent = "生成中...";
  btn.disabled = true;
  isGenerating = true;

  currentImagePath = '';
  document.getElementById('save-btn').style.display = 'none';
  document.getElementById('image-container').innerHTML = '<div class="image-placeholder"><div class="image-placeholder-icon">⏳</div><div class="image-placeholder-text">正在生成...</div></div>';
  clearLogs();

  try {
    let modelUrl = '';
    let modelDiffusion = null;
    let modelVae = null;
    try {
      const modelList = await invoke()("fetch_model_list");
      const model = modelList.find(function(m) { return m.model_id === modelId; });
      if (model) {
        modelUrl = model.model_url || '';
        modelDiffusion = model.model_diffusion || null;
        modelVae = model.model_vae || null;
      }
    } catch (e) { showToast("获取模型信息失败: " + e); }

    if (!modelUrl) {
      showToast("未找到模型文件信息");
      btn.textContent = "生成图片";
      btn.disabled = false;
      isGenerating = false;
      return;
    }

    await invoke()("start_sd_generation", {
      modelId: modelId,
      prompt: prompt,
      width: width,
      height: height,
      modelUrl: modelUrl,
      modelDiffusion: modelDiffusion,
      modelVae: modelVae
    });
  } catch (e) {
    showToast("生成失败: " + e);
    btn.textContent = "生成图片";
    btn.disabled = false;
    isGenerating = false;
  }
}

async function saveAsImage() {
  if (!currentImagePath) { showToast("没有可保存的图片"); return; }
  try {
    await invoke()("save_sd_image_as", { sourcePath: currentImagePath });
  } catch (e) {
    if (e && e.indexOf && e.indexOf("用户取消了保存") !== -1) return;
    showToast("保存失败: " + e);
  }
}

function handleTauriEvent(type, payload) {
  switch (type) {
    case "sd-download-progress":
      updateProgressUI(payload.progress, payload.status);
      break;
    case "sd-log":
      if (payload.model_id === modelId) addLogLine(payload.line, payload.source);
      break;
    case "sd-started":
      if (payload.model_id === modelId) addLogLine("SD 进程已启动", "info");
      break;
    case "sd-complete":
      if (payload.model_id === modelId) {
        addLogLine("生成进程已结束", "info");
        const btn = document.getElementById('generate-btn');
        if (btn) { btn.textContent = "生成图片"; btn.disabled = false; }
        isGenerating = false;
      }
      break;
    case "sd-image-result":
      if (payload.model_id === modelId && payload.image_data) {
        const container = document.getElementById('image-container');
        if (container) container.innerHTML = '<img src="data:image/png;base64,' + payload.image_data + '" alt="生成图片">';
        currentImagePath = payload.file_path || '';
        const saveBtn = document.getElementById('save-btn');
        if (currentImagePath && saveBtn) saveBtn.style.display = '';
      }
      break;
    case "sd-error":
      showToast("生成出错: " + (payload.message || "未知错误"));
      const ebtn = document.getElementById('generate-btn');
      if (ebtn) { ebtn.textContent = "生成图片"; ebtn.disabled = false; }
      isGenerating = false;
      break;
  }
}

function goBack() {
  location.hash = "#/list";
}

function setupListeners() {
  const L = listen();
  const events = ["sd-download-progress", "sd-log", "sd-started", "sd-complete", "sd-error", "sd-image-result"];
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
  mount(root, params) {
    root.innerHTML = template;
    modelId = params.model_id || '';
    isGenerating = false;
    currentImagePath = '';
    document.getElementById('model-name').textContent = modelId ? '文生图 - ' + modelId : '文生图';

    document.getElementById('back-btn').addEventListener('click', goBack);
    document.getElementById('generate-btn').addEventListener('click', handleGenerate);
    document.getElementById('save-btn').addEventListener('click', saveAsImage);
    document.getElementById('log-clear-btn').addEventListener('click', clearLogs);

    setupListeners();
    initPage();
  },
  unmount() {
    stopProgressPoll();
    unlisteners.forEach(function(u) { try { if (typeof u === 'function') u(); } catch (_) {} });
    unlisteners = [];
  }
};
