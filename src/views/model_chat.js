const template = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  #chat-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  #model-header {
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
    font-weight: 500;
    color: #ffffff;
  }

  .header-status {
    margin-left: auto;
    font-size: 12px;
    color: #4caf50;
  }

  .log-btn {
    background: #8e24aa;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    margin-left: 8px;
  }

  .log-btn:hover {
    background: #6a1b9a;
  }

  #model-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: #ffffff;
  }

  .loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #1a1a2e;
    z-index: 10;
  }

  .loading-overlay .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(108, 99, 255, 0.3);
    border-top-color: #6c63ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 16px;
  }

  .loading-overlay p {
    color: #a0a0c0;
    font-size: 14px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .log-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    z-index: 100;
    display: none;
    flex-direction: column;
  }

  .log-overlay.visible {
    display: flex;
  }

  .log-overlay-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #0f3460;
    border-bottom: 1px solid #1a1a3e;
    color: #fff;
  }

  .log-overlay-title {
    font-size: 14px;
    font-weight: 600;
  }

  .log-overlay-close {
    background: #e53935;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
  }

  .log-overlay-close:hover {
    background: #c62828;
  }

  .log-overlay-content {
    flex: 1;
    padding: 12px 16px;
    overflow-y: auto;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.6;
    color: #a0a0c0;
    background: #0d1117;
  }

  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .log-line.error { color: #ff6b6b; }
  .log-line.success { color: #69db7c; }
  .log-line.info { color: #74c0fc; }
  .log-line.warning { color: #ffd43b; }
  .log-line.stderr { color: #ff8787; }
</style>
<div id="chat-wrap">
  <div id="model-header">
    <button class="back-btn" id="back-btn">&#8592; 返回</button>
    <span id="model-name">模型交互界面</span>
    <span class="header-status" id="connection-status">连接中...</span>
    <button class="log-btn" id="log-btn">📋 日志</button>
  </div>
  <div style="position: relative; flex: 1;">
    <div class="loading-overlay" id="loading-overlay">
      <div class="spinner"></div>
      <p>正在连接模型服务...</p>
    </div>
    <iframe id="model-iframe" src="about:blank"></iframe>
    <div id="log-overlay" class="log-overlay">
      <div class="log-overlay-header">
        <div class="log-overlay-title">📋 模型运行日志 - <span id="log-model-id"></span></div>
        <button class="log-overlay-close" id="log-overlay-close">关闭</button>
      </div>
      <div id="log-overlay-content" class="log-overlay-content"></div>
    </div>
  </div>
</div>
`;

let unlisteners = [];
let retryTimer = null;
let currentModelId = '';
let logOverlayVisible = false;

const invoke = () => window.__adm_invoke;
const listen = () => window.__adm_listen;

function addLogLine(line, type = 'info') {
  const logContent = document.getElementById('log-overlay-content');
  if (!logContent) return;
  const logLine = document.createElement('div');
  logLine.className = 'log-line ' + type;
  logLine.textContent = line;
  logContent.appendChild(logLine);
  logContent.scrollTop = logContent.scrollHeight;
  saveLogToStorage(line, type);
}

function saveLogToStorage(line, type) {
  if (!currentModelId) return;
  const storageKey = 'modelLogs_' + currentModelId;
  const logs = JSON.parse(localStorage.getItem(storageKey) || '[]');
  logs.push({ line: line, type: type, timestamp: Date.now() });
  if (logs.length > 5000) logs.shift();
  localStorage.setItem(storageKey, JSON.stringify(logs));
}

function loadLogsFromStorage() {
  if (!currentModelId) return;
  const storageKey = 'modelLogs_' + currentModelId;
  const logs = JSON.parse(localStorage.getItem(storageKey) || '[]');
  const logContent = document.getElementById('log-overlay-content');
  logContent.innerHTML = '';
  logs.forEach(function(log) {
    const logLine = document.createElement('div');
    logLine.className = 'log-line ' + log.type;
    logLine.textContent = log.line;
    logContent.appendChild(logLine);
  });
  if (logContent.children.length > 0) logContent.scrollTop = logContent.scrollHeight;
}

function toggleLogOverlay() {
  const overlay = document.getElementById('log-overlay');
  logOverlayVisible = !logOverlayVisible;
  if (logOverlayVisible) {
    overlay.classList.add('visible');
    loadLogsFromStorage();
  } else {
    overlay.classList.remove('visible');
  }
}

function handleTauriEvent(type, payload) {
  switch (type) {
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
    case "model-started":
      addLogLine(`[${new Date().toLocaleTimeString()}] ✅ 模型启动成功! 端口: ${payload.port}`, 'success');
      break;
    case "model-stopped":
      addLogLine(`[${new Date().toLocaleTimeString()}] ⏹️ 模型已停止`, 'info');
      break;
    case "model-error":
      addLogLine(`[${new Date().toLocaleTimeString()}] ❌ 模型错误: ${payload.error}`, 'error');
      break;
  }
}

function goBack() {
  location.hash = "#/list";
}

function init(params) {
  currentModelId = params.model_id || "未知模型";
  const port = params.port || 5678;

  document.getElementById("model-name").textContent = currentModelId + " - 交互界面";
  document.getElementById('log-model-id').textContent = currentModelId;

  const iframe = document.getElementById("model-iframe");
  const overlay = document.getElementById("loading-overlay");
  const statusEl = document.getElementById("connection-status");
  const loadingText = overlay.querySelector("p");

  const serverUrl = "http://127.0.0.1:" + port;
  loadingText.textContent = "模型启动中，请耐心等待...";

  let retryCount = 0;
  const maxRetries = 120;

  function checkService() {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", serverUrl, true);
    xhr.timeout = 3000;
    xhr.onload = function () {
      loadingText.textContent = "正在连接模型服务...";
      iframe.onload = function () {
        overlay.style.display = "none";
        statusEl.textContent = "已连接";
        statusEl.style.color = "#4caf50";
      };
      iframe.onerror = function () {
        statusEl.textContent = "连接失败";
        statusEl.style.color = "#f44336";
      };
      iframe.src = serverUrl;
    };
    xhr.onerror = function () {
      retryCount++;
      if (retryCount < maxRetries) {
        loadingText.textContent = "模型启动中，请耐心等待...（" + Math.round(retryCount / 2) + "秒）";
        retryTimer = setTimeout(checkService, 1000);
      } else {
        loadingText.textContent = "连接超时，请检查模型是否正常启动";
        statusEl.textContent = "连接超时";
        statusEl.style.color = "#ff9800";
      }
    };
    xhr.ontimeout = function () { xhr.onerror(); };
    xhr.send();
  }

  retryTimer = setTimeout(checkService, 1000);
}

function setupListeners() {
  const L = listen();
  const events = ["model-log", "model-started", "model-stopped", "model-error"];
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
    document.getElementById('back-btn').addEventListener('click', goBack);
    document.getElementById('log-btn').addEventListener('click', toggleLogOverlay);
    document.getElementById('log-overlay-close').addEventListener('click', toggleLogOverlay);
    setupListeners();
    init(params);
  },
  unmount() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    unlisteners.forEach(function(u) { try { if (typeof u === 'function') u(); } catch (_) {} });
    unlisteners = [];
  }
};
