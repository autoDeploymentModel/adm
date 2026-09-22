// @ts-nocheck -- 历史视图暂未类型化（jsconfig checkJs 全局开启，新代码请勿加此标记）
import { t as _t } from "../i18n.js";
import { friendlyError, getErrorMessage } from "./agent/error.js";
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

  .card-desc {
    font-size: 12px;
    color: var(--c-text-3);
    line-height: 1.5;
  }

  .card-features {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* 平台/显卡不满足要求时的说明（图片生成模型仅 Windows + NVIDIA） */
  .model-card.card-unsupported {
    border-color: rgba(244, 67, 54, 0.35);
  }

  .card-hint {
    font-size: 12px;
    line-height: 1.5;
    color: #f44336;
    background: rgba(244, 67, 54, 0.08);
    border: 1px solid rgba(244, 67, 54, 0.25);
    border-radius: 6px;
    padding: 6px 10px;
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

  /* 图片生成模型：容器启动 / 镜像下载进行中 */
  .status-starting {
    background: rgba(255, 152, 0, 0.15);
    color: #ff9800;
    border: 1px solid rgba(255, 152, 0, 0.3);
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

  .model-tabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    flex-shrink: 0;
  }

  .model-tab {
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--c-text-2);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }

  .model-tab:hover {
    color: var(--c-text-hi);
  }

  .model-tab.active {
    background: var(--c-accent);
    color: #fff;
  }
</style>
<div id="model-list-root">
<div class="page-title">${_t("模型列表")}</div>
<div class="filter-bar">
  <div class="model-tabs" id="model-tabs">
    <button type="button" class="model-tab" data-tab="text">${_t("纯文本模型")}</button>
    <button type="button" class="model-tab" data-tab="vision">${_t("多模态模型")}</button>
    <button type="button" class="model-tab" data-tab="image">${_t("图片生成模型")}</button>
  </div>
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
<div id="docker-modal" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <h3 id="docker-modal-title">${_t("安装 Docker 运行环境")}</h3>
    <p id="docker-modal-msg"></p>
    <div class="modal-actions">
      <button class="btn btn-cancel" id="docker-modal-cancel">${_t("取消")}</button>
      <button class="btn btn-start" id="docker-modal-confirm">${_t("继续")}</button>
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

// 实时下载速度：>=1MB/s 显示 MB/s（如 1.2MB/s），否则显示 KB/s（如 100KB/s）
function formatSpeed(bps) {
  if (!(bps > 0)) return "";
  const mb = bps / (1024 * 1024);
  if (mb >= 1) {
    const v = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
    return v + "MB/s";
  }
  return Math.max(1, Math.round(bps / 1024)) + "KB/s";
}

// 按 模型ID:文件类型 追踪相邻两次进度事件的字节增量与时间差，算出瞬时速度（B/s）；
// 采样间隔 <500ms 时跳过，避免高频事件导致速度数字跳动
const dlSpeedTracker = {};
const dlSpeedShown = {};
function trackDownloadSpeed(key, downloaded) {
  const now = Date.now();
  const prev = dlSpeedTracker[key];
  if (prev && now - prev.time < 500) return null;
  dlSpeedTracker[key] = { bytes: downloaded, time: now };
  if (!prev) return null;
  const dt = (now - prev.time) / 1000;
  const db = downloaded - prev.bytes;
  if (dt <= 0 || db < 0) return null;
  return db / dt;
}
function clearDownloadSpeed(modelId) {
  const prefix = modelId + ":";
  Object.keys(dlSpeedTracker).forEach(function(k) {
    if (k.startsWith(prefix)) { delete dlSpeedTracker[k]; delete dlSpeedShown[k]; }
  });
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

// ===== 图片生成模型（docker 部署）=====
// model_list.json 里 model_images 有值的模型走 docker 流程：
// 检查 Docker →（未安装）下载/安装 Docker Desktop → 拉镜像 → 启动容器（64646 → 8188）

function isDockerModel(model) {
  return !!(model && model.model_images);
}

// 可取消的任务阶段：安装 Docker Desktop（install-desktop）会拉起安装程序，
// 中途强杀可能把安装装坏，因此不提供取消
const DOCKER_CANCELLABLE_STAGES = ["check", "download-desktop", "start-daemon", "pull", "start"];
function isDockerTaskCancellable(stage) {
  return DOCKER_CANCELLABLE_STAGES.indexOf(stage) >= 0;
}

// 启动阶段（等待引擎 / 创建并启动容器 / 等待 ComfyUI 就绪）
function isDockerStarting(stage) {
  return stage === "start" || stage === "start-daemon";
}

// 取消是用户主动行为，不作为失败提示
function isCancelError(e) {
  const msg = typeof e === "string" ? e : String((e && e.message) || "");
  return msg.indexOf("已取消") >= 0;
}

// 下载刚点击 / 刚完成的极短时间内忽略「启动」点击：下载完成会重渲染卡片（「下载」按钮的
// 位置变成「启动」），连击或手快的第二次点击会误落在新按钮上，表现为"下载完就自动启动"
const dockerRecentAction = { at: 0, modelId: null };
function markDockerAction(modelId) {
  dockerRecentAction.at = Date.now();
  dockerRecentAction.modelId = modelId;
}
function isRecentDockerAction(modelId) {
  return dockerRecentAction.modelId === modelId && Date.now() - dockerRecentAction.at < 1200;
}

function getDockerState() {
  const st = S();
  if (!st.dockerImages) st.dockerImages = {};
  if (!st.dockerTasks) st.dockerTasks = {};
  if (st.dockerEnv === undefined) st.dockerEnv = null;
  return st;
}

// 平台 / 显卡要求：图片生成模型目前仅 Windows + NVIDIA 可用（后端 requirement_reason 判定）。
// 结果用于卡片置灰与点击提示；探测失败按"未知"处理（不置灰），真正的拦截在后端命令里。
async function refreshDockerEnv() {
  const st = getDockerState();
  // 没有图片生成模型时不必探测（探测要跑 docker info + nvidia-smi，1~2 秒子进程开销）
  if (!(st.modelList || []).some(isDockerModel)) {
    st.dockerEnv = null;
    return null;
  }
  try {
    st.dockerEnv = await invoke()("check_docker_env");
  } catch (e) {
    console.warn("[model_list] 检查 Docker 环境失败:", e);
    st.dockerEnv = null;
  }
  return st.dockerEnv;
}

// 不支持时返回原因文本，支持/未知返回空串
function dockerBlockReason() {
  const env = S().dockerEnv;
  if (env && env.supported === false) {
    return env.unsupported_reason || _t("当前设备不支持图片生成模型");
  }
  return "";
}

async function refreshDockerImages() {
  const st = getDockerState();
  const list = (st.modelList || []).filter(isDockerModel);
  for (const m of list) {
    try {
      st.dockerImages[m.model_id] = await invoke()("check_docker_image", { image: m.model_images });
    } catch (e) {
      console.warn("[model_list] 查询本地镜像失败:", e);
      st.dockerImages[m.model_id] = false;
    }
  }
}

// 启动时对账：上次被强杀/崩溃时容器会残留（--restart unless-stopped），
// 逐个查询容器状态，仍在运行则恢复「已启动」显示；已停止的容器直接清除，
// 避免 exited 容器一直堆在 `docker ps -a` 里
async function refreshDockerRunning() {
  const st = getDockerState();
  try {
    const pruned = await invoke()("prune_docker_containers");
    if (pruned > 0) console.log("[model_list] 已清理残留容器:", pruned);
  } catch (e) { console.warn("[model_list] 清理残留容器失败:", e); }
  const list = (st.modelList || []).filter(isDockerModel);
  for (const m of list) {
    try {
      const running = await invoke()("sync_docker_container", { modelId: m.model_id });
      if (running) {
        if (st.runningModelId !== m.model_id) {
          st.runningModelId = m.model_id;
          // 端口以后端为准（sync 已写入 running_port），取不到再回退默认值
          try {
            const status = await invoke()("get_model_status");
            st.runningModelPort = (status && status.port) || 64646;
          } catch (_) {
            st.runningModelPort = 64646;
          }
          showToast(_t("检测到图片生成模型仍在运行（上次未正常退出）"));
        }
        return;
      }
    } catch (e) {
      console.warn("[model_list] 同步容器状态失败:", e);
    }
  }
}

let dockerConfirmResolve = null;
function showDockerConfirm(title, msg, confirmText) {
  return new Promise(function(resolve) {
    dockerConfirmResolve = resolve;
    document.getElementById("docker-modal-title").textContent = title;
    document.getElementById("docker-modal-msg").textContent = msg;
    document.getElementById("docker-modal-confirm").textContent = confirmText || _t("继续");
    document.getElementById("docker-modal").style.display = "flex";
  });
}
function hideDockerConfirm(ok) {
  document.getElementById("docker-modal").style.display = "none";
  const r = dockerConfirmResolve;
  dockerConfirmResolve = null;
  if (r) r(!!ok);
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
  if (model && model.model_type === "视觉多模态理解") {
    // 与 Rust start_model 一致：mmproj 文件名两种风格均生效（mmproj-*.gguf / <模型名>.mmproj-*.gguf），大小写不敏感
    return local.files.some(f => f.toLowerCase().includes("mmproj"));
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

// 首页模型类型 TAB：按远端 model_list.json 的 model_type 归类；types 内含新旧名称，
// 兼容历史数据（如「文本生成」与「纯文本模型」视为同一类）。未匹配到的类型归入
// 第一个 TAB，避免将来新增类型时模型在首页凭空消失。
const MODEL_TABS = [
  { key: "text",   types: ["文本生成", "纯文本模型", "纯文本"] },
  { key: "vision", types: ["视觉多模态理解", "多模态模型", "多模态"] },
  { key: "image",  types: ["文本生成图片", "图片生成模型", "文生图"] },
];

function getModelTab(modelType) {
  const type = (modelType || "").trim();
  const tab = MODEL_TABS.find(function(item) { return item.types.includes(type); });
  return (tab || MODEL_TABS[0]).key;
}

function getFilteredModelList() {
  return S().modelList.filter(function(m) { return getModelTab(m.model_type) === S().currentTypeFilter; });
}

function syncModelTabUI() {
  document.querySelectorAll("#model-tabs .model-tab").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.tab === S().currentTypeFilter);
  });
}

function initModelTabs() {
  const tabs = document.querySelectorAll("#model-tabs .model-tab");
  syncModelTabUI();
  tabs.forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (S().currentTypeFilter === btn.dataset.tab) return;
      S().currentTypeFilter = btn.dataset.tab;
      syncModelTabUI();
      renderModelTable();
    });
  });
}

// 卡片按钮点击穿透保护：renderModelTable() 会整体替换按钮（「下载」完成变成「启动」、
// 「关闭模型」后变成「启动」），连击/手快的第二下会落在新按钮上，表现为"自己又启动了"。
// 渲染后极短时间内忽略卡片上的动作按钮点击（「查看模型」无害、不拦）；
// 被拦时给提示，避免用户以为按钮坏了（llama 与 docker 卡片都适用）。
const CLICK_THROUGH_MS = 350;
let lastCardRenderAt = 0;
function isClickThrough() {
  const hit = Date.now() - lastCardRenderAt < CLICK_THROUGH_MS;
  if (hit) {
    console.log("[model_list] 忽略重渲染后的误触点击");
    showToast(_t("界面刚刷新，已忽略这次误触，请再点一次"));
  }
  return hit;
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
    const isDocker = isDockerModel(model);
    // 图片生成模型仅 Windows + NVIDIA 可用：不支持时置灰（后端命令里还会再拦一次）
    const dockerReason = isDocker ? dockerBlockReason() : "";
    const dockerBlocked = !!dockerReason;
    const available = isModelAvailable(model.need_ram) && !dockerBlocked;
    const dockerImages = st.dockerImages || {};
    const downloaded = isDocker ? !!dockerImages[model.model_id] : isModelDownloaded(model.model_id);
    const dockerTask = isDocker ? (st.dockerTasks || {})[model.model_id] : null;
    // 任务进行中（下载/启动）：只显示进度 + 取消，不显示启动/关闭/删除按钮
    const dockerBusy = isDocker && !!dockerTask;
    const isRunning = st.runningModelId === model.model_id;

    const card = document.createElement("div");
    card.className = "model-card" + (isRunning ? " card-running" : (dockerBlocked ? " card-unsupported" : (!available ? " card-unavailable" : "")));

    let statusHtml = "";
    if (dockerBusy && isDockerStarting(dockerTask.stage)) {
      // 启动进行中：状态直接显示「启动中」，不再显示启动按钮
      statusHtml = '<span class="status-badge status-starting">' + _t("启动中") + '</span>';
    } else if (isRunning) {
      statusHtml = '<span class="status-badge status-running">' + _t("已启动") + '</span>';
    } else if (available) {
      statusHtml = '<span class="status-badge status-available">' + _t("可用") + '</span>';
    } else {
      statusHtml = '<span class="status-badge status-unavailable">' + _t("不可用") + '</span>';
    }

    const partSize = st.partFiles[model.model_id];
    const downloadingProgress = st.downloadingModels[model.model_id];
    const isDownloadingMmproj = st.downloadingMmproj[model.model_id];
    const safeModelId = escapeHtml(model.model_id);
    let downloadBtnHtml = "";
    if (isDocker) {
      // 图片生成模型：downloaded = 本地已有镜像；dockerTask 存在 = 正在安装/下载
      if (dockerTask) {
        const pct = dockerTask.progress || 0;
        // 启动阶段统一显示「模型启动中」，具体阶段说明放到卡片提示行
        const label = isDockerStarting(dockerTask.stage)
          ? _t("模型启动中…")
          : (dockerTask.message || _t("处理中..."));
        downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' +
          escapeHtml(label) + ' ' + pct + '%</button>';
        if (isDockerTaskCancellable(dockerTask.stage)) {
          downloadBtnHtml += '<button class="btn btn-stop" data-docker-cancel="' + safeModelId + '" id="cancel-' + safeModelId + '">' + _t("取消") + '</button>';
        }
      } else if (downloaded) {
        downloadBtnHtml = '';
      } else if (dockerBlocked) {
        downloadBtnHtml = '<button class="btn btn-download" disabled title="' + escapeHtml(dockerReason) + '">' + _t("下载") + '</button>';
      } else if (available) {
        downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-image="' + escapeHtml(model.model_images || '') + '" data-docker="1" id="dl-' + safeModelId + '">' + _t("下载") + '</button>';
      } else {
        downloadBtnHtml = '<button class="btn btn-download" disabled>' + _t("下载") + '</button>';
      }
    } else if (downloaded) {
      downloadBtnHtml = '';
    } else if (isDownloadingMmproj) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + _t("下载 mmproj...") + '</button>';
    } else if (downloadingProgress !== undefined) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" disabled>' + downloadingProgress + '%</button>';
    } else if (partSize && partSize > 0) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + escapeHtml(model.model_url) + '" data-model-mmproj="' + escapeHtml(model.model_mmproj || '') + '" data-model-type="' + escapeHtml(model.model_type || '') + '" id="dl-' + safeModelId + '">' + _t("继续下载") + '</button>';
    } else if (available) {
      downloadBtnHtml = '<button class="btn btn-download" data-model-id="' + safeModelId + '" data-model-url="' + escapeHtml(model.model_url) + '" data-model-mmproj="' + escapeHtml(model.model_mmproj || '') + '" data-model-type="' + escapeHtml(model.model_type || '') + '" id="dl-' + safeModelId + '">' + _t("下载") + '</button>';
    } else {
      downloadBtnHtml = '<button class="btn btn-download" disabled>' + _t("下载") + '</button>';
    }

    const dockerAttr = isDocker ? ' data-model-image="' + escapeHtml(model.model_images || '') + '" data-docker="1"' : '';
    let actionsHtml = "";
    if (dockerBusy) {
      actionsHtml = '';
    } else if (isRunning) {
      actionsHtml = '<button class="btn btn-view" id="view-' + safeModelId + '">' + _t("查看模型") + '</button>';
      actionsHtml += '<button class="btn btn-stop" data-stop-btn="' + safeModelId + '"' + dockerAttr + ' id="stop-' + safeModelId + '">' + _t("关闭模型") + '</button>';
    } else if (downloaded && available) {
      actionsHtml = '<button class="btn btn-start" data-start-btn="' + safeModelId + '"' + dockerAttr + ' id="start-' + safeModelId + '">' + _t("启动") + '</button>';
    } else if (downloaded) {
      actionsHtml = dockerBlocked
        ? '<button class="btn btn-start" disabled title="' + escapeHtml(dockerReason) + '">' + _t("启动") + '</button>'
        : '<button class="btn btn-start" disabled>' + _t("启动") + '</button>';
    } else {
      actionsHtml = '';
    }
    if (downloaded && !isRunning && !dockerBusy) {
      actionsHtml += '<button class="btn btn-delete" data-delete-btn="' + safeModelId + '"' + dockerAttr + '>' + _t("删除") + '</button>';
    }

    const features = [];
    if (model.support_tools) features.push('<span class="feature-badge feature-supported">' + _t("工具调用") + '</span>');
    if (model.support_reasoning) features.push('<span class="feature-badge feature-supported">' + _t("推理") + '</span>');
    if (model.support_images) features.push('<span class="feature-badge feature-supported">' + _t("图片识别") + '</span>');
    const featuresHtml = features.length > 0 ? '<div class="card-features">' + features.join('') + '</div>' : '';
    const descHtml = model.model_description ? '<div class="card-desc">' + escapeHtml(model.model_description) + '</div>' : '';
    // 运行中说明该容器确实起来了，此时再挂"不支持"提示会自相矛盾
    let hintHtml = (dockerBlocked && !isRunning) ? '<div class="card-hint">' + escapeHtml(dockerReason) + '</div>' : '';
    // 启动阶段：进度按钮只写「模型启动中」，详细阶段说明放这里
    if (dockerBusy && isDockerStarting(dockerTask.stage) && dockerTask.message) {
      hintHtml = '<div class="card-hint" data-hint="' + safeModelId + '">' + escapeHtml(dockerTask.message) + '</div>';
    }

    const isDownloadingPhase = isDownloadingMmproj;
    const progressVisible = downloadingProgress !== undefined || isDownloadingPhase || !!dockerTask;
    const progressValue = dockerTask ? (dockerTask.progress || 0) : (downloadingProgress !== undefined ? downloadingProgress : 0);

    card.innerHTML =
      '<div class="card-header"><span class="model-name" title="' + safeModelId + '">' + escapeHtml(model.model_id) + '</span>' + statusHtml + '</div>' +
      '<div class="card-meta">' + escapeHtml(model.model_type || '-') + ' · ' + escapeHtml(model.model_size) + ' · ' + _t("需内存 ") + escapeHtml(model.need_ram) + _t(" GB") + '</div>' +
      descHtml +
      featuresHtml +
      hintHtml +
      '<div class="card-actions">' + downloadBtnHtml + actionsHtml + '</div>' +
      '<div class="card-progress" data-progress-wrap="' + safeModelId + '" style="display:' + (progressVisible ? 'block' : 'none') + ';">' +
        '<div class="card-progress-fill" data-progress-bar="' + safeModelId + '" style="width:' + progressValue + '%;"></div>' +
      '</div>';

    grid.appendChild(card);
  });

  lastCardRenderAt = Date.now();
  bindRowEvents();
}

function bindRowEvents() {
  const st = S();
  const dlBtns = document.querySelectorAll('#model-grid .btn-download:not(.downloaded):not([disabled])');
  dlBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (isClickThrough()) return;
      if (btn.dataset.docker === '1') handleDockerDownload(btn);
      else handleDownload(btn);
    });
  });
  const startBtns = document.querySelectorAll('#model-grid .btn-start[data-start-btn]');
  startBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (isClickThrough()) return;
      if (btn.dataset.docker === '1') handleDockerStart(btn);
      else handleStart(btn);
    });
  });
  const stopBtns = document.querySelectorAll('#model-grid .btn-stop[data-stop-btn]');
  stopBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (isClickThrough()) return;
      if (btn.dataset.docker === '1') handleDockerStop(btn);
      else handleStop(btn);
    });
  });
  const cancelBtns = document.querySelectorAll('#model-grid .btn-stop[data-docker-cancel]');
  cancelBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      // 取消按钮由阶段切换的重渲染刚刚插入，不做穿透保护，保证能立刻点
      handleDockerCancel(btn);
    });
  });
  const viewBtns = document.querySelectorAll('#model-grid .btn-view');
  viewBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.id.replace('view-', '');
      goModel(modelId);
    });
  });
  const deleteBtns = document.querySelectorAll('#model-grid .btn-delete[data-delete-btn]');
  deleteBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const modelId = btn.dataset.deleteBtn;
      if (btn.dataset.docker === '1') showDeleteConfirm(modelId, { docker: true, image: btn.dataset.modelImage });
      else showDeleteConfirm(modelId);
    });
  });
}

async function handleDownload(btn) {
  const modelId = btn.dataset.modelId;
  const modelUrl = btn.dataset.modelUrl;
  console.log("[model_list] 开始下载模型:", modelId, "URL:", modelUrl);
  const modelMmproj = btn.dataset.modelMmproj || null;
  const modelType = btn.dataset.modelType || '';
  if (btn) {
    const hasPart = S().partFiles[modelId] && S().partFiles[modelId] > 0;
    btn.textContent = hasPart ? _t("继续下载中...") : "0%";
    btn.disabled = true;
  }

  try {
    await invoke()("download_model", { modelId: modelId, modelUrl: modelUrl, modelMmproj: modelMmproj, modelType: modelType });
    console.log("[model_list] 下载模型 invoke 完成:", modelId);
  } catch (e) {
    console.error("[model_list] 下载失败:", e);
    showToast(friendlyError(e, { prefix: "下载失败: " }));
    clearDownloadSpeed(modelId);
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
    // VC++ 运行库缺失时后端会直接拒绝启动（避免弹「找不到 VCRUNTIME140_1.dll」系统错误框），
    // 这里接着引导去安装，而不是只给一条错误提示
    const raw = getErrorMessage(e);
    // 后端报错文本已点明缺运行库时直接引导安装（后端用的是同源检测，比再查一次更可信）
    let vcMissing = /vcruntime|visual c\+\+/i.test(raw);
    if (!vcMissing) {
      try { vcMissing = (await invoke()("check_vc_redist")) === false; } catch (vcErr) { console.warn("[model_list] VC++ 运行库检测失败:", vcErr); }
    }
    if (vcMissing && window.ADM && window.ADM.showVcRedistInstallDialog) {
      window.ADM.showVcRedistInstallDialog();
    } else if (/llama|llamacpp/i.test(raw)) {
      // llama-server 拉起失败（可执行文件缺失/损坏等）属推理引擎问题：保留原始错误文本
      // （含具体路径/命令），只在后面追加可操作提示
      showToast(friendlyError(e, { prefix: "启动失败: " }) + _t("，请到设置检查推理引擎"));
    } else {
      showToast(friendlyError(e, { prefix: "启动失败: " }));
    }
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
    showToast(friendlyError(e, { prefix: "停止失败: " }));
  }
}

function goModel(modelId) {
  const port = S().runningModelPort || 5678;
  // 直接用系统浏览器打开模型 WebUI（壳层 openUrl 走 opener 插件）
  window.openUrl("http://127.0.0.1:" + port);
}

// ===== 图片生成模型（docker 部署）操作 =====

async function handleDockerDownload(btn) {
  const modelId = btn.dataset.modelId;
  const image = btn.dataset.modelImage;
  const st = getDockerState();
  console.log("[model_list] docker 下载模型:", modelId, "image:", image);
  markDockerAction(modelId);
  // 平台/显卡不满足时直接提示，不走安装流程（避免白下 Docker Desktop 与镜像）
  const blocked = dockerBlockReason();
  if (blocked) {
    showToast(blocked);
    return;
  }
  btn.disabled = true;
  btn.textContent = _t("检查环境中...");
  try {
    const env = await invoke()("check_docker_env");
    if (env && env.supported === false) {
      st.dockerEnv = env;
      renderModelTable();
      showToast(env.unsupported_reason || _t("当前设备不支持图片生成模型"));
      return;
    }
    st.dockerEnv = env;
    if (!env.installed) {
      const ok = await showDockerConfirm(
        _t("安装 Docker 运行环境"),
        _t("未检测到 Docker。是否自动下载并安装 Docker Desktop？（安装包约 600MB~1GB，安装时可能弹出系统授权窗口）"),
        _t("下载并安装")
      );
      if (!ok) {
        btn.disabled = false;
        btn.textContent = _t("下载");
        return;
      }
      btn.textContent = _t("准备安装 Docker...");
    }
    st.dockerTasks[modelId] = { stage: "check", progress: 0, message: _t("正在检查 Docker 环境…") };
    updateProgressBar(modelId, 0);
    await invoke()("setup_docker_model", { modelId: modelId, image: image });
    delete st.dockerTasks[modelId];
    st.dockerImages[modelId] = true;
    markDockerAction(modelId);
    // Docker 装好后才能判断 GPU 直通能力，重新取一次环境（不满足时卡片会置灰并给出原因）
    await refreshDockerEnv();
    showToast(_t("镜像下载完成"));
    renderModelTable();
  } catch (e) {
    console.error("[model_list] docker 准备失败:", e);
    delete st.dockerTasks[modelId];
    if (isCancelError(e)) {
      // 用户主动取消：不算失败，刷新镜像状态让按钮回到「下载」
      await refreshDockerImages();
      showToast(_t("已取消下载"));
      renderModelTable();
      return;
    }
    // 失败原因可能是 GPU 直通能力不足（后端在此复检），刷新环境让卡片同步置灰
    await refreshDockerEnv();
    showToast(friendlyError(e, { prefix: _t("下载失败: ") }));
    renderModelTable();
  }
}

// 取消进行中的 docker 任务：后端置取消标志并强杀 docker pull 等子进程，
// 挂起的 setup/start 命令会以「已取消」结束（下面 catch 里按提示而非失败展示）
async function handleDockerCancel(btn) {
  const modelId = btn.dataset.dockerCancel;
  const st = getDockerState();
  const ok = await showDockerConfirm(
    _t("取消下载任务"),
    _t("确定要取消当前任务吗？已下载的内容会保留，下次可以继续。"),
    _t("确定取消")
  );
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = _t("取消中...");
  try {
    // 提示统一由挂起命令的 catch 给出（避免重复弹两次）
    await invoke()("cancel_docker_task", { modelId: modelId });
    delete st.dockerTasks[modelId];
    await refreshDockerImages();
    renderModelTable();
  } catch (e) {
    showToast(friendlyError(e, { prefix: _t("取消失败: ") }));
    renderModelTable();
  }
}

async function handleDockerStart(btn) {
  const modelId = btn.dataset.startBtn;
  const image = btn.dataset.modelImage;
  console.log("[model_list] 启动图片生成模型:", modelId);
  const blocked = dockerBlockReason();
  if (blocked) {
    showToast(blocked);
    return;
  }
  // 下载刚结束的误触保护：启动必须是一次独立的手动点击（见 markDockerAction 注释）
  if (isRecentDockerAction(modelId)) {
    console.log("[model_list] 忽略下载结束后的误触启动:", modelId);
    showToast(_t("已忽略下载结束后的误触，如需启动请再次点击「启动」"));
    return;
  }
  btn.textContent = _t("启动中...");
  btn.disabled = true;
  try {
    await invoke()("start_docker_model", { modelId: modelId, image: image });
    try {
      const status = await invoke()("get_model_status");
      if (status && status.running) {
        S().runningModelId = status.model_id;
        S().runningModelPort = status.port;
      }
    } catch (_) {}
    // 启动任务结束，清掉残留的进度/取消按钮
    delete getDockerState().dockerTasks[modelId];
    showToast(_t("已启动：请在 ComfyUI 左侧「工作流」中选择 adm-qwen-image-2.1-t2i（文生图）或 adm-qwen-image-2.1-image-edit（图生图）"));
    renderModelTable();
  } catch (e) {
    console.error("[model_list] 启动图片生成模型失败:", e);
    const dst = getDockerState();
    delete dst.dockerTasks[modelId];
    if (isCancelError(e)) {
      showToast(_t("已取消启动"));
      renderModelTable();
      return;
    }
    // 启动前后端会复检 GPU 直通能力，失败时刷新环境让卡片同步置灰
    await refreshDockerEnv();
    showToast(friendlyError(e, { prefix: _t("启动失败: ") }));
    renderModelTable();
  }
}

async function handleDockerStop(btn) {
  const modelId = btn.dataset.stopBtn;
  btn.textContent = _t("关闭中...");
  btn.disabled = true;
  try {
    await invoke()("stop_docker_model", { modelId: modelId });
    S().runningModelId = null;
    S().runningModelPort = null;
    renderModelTable();
  } catch (e) {
    showToast(friendlyError(e, { prefix: _t("停止失败: ") }));
    renderModelTable();
  }
}

async function handleDockerDelete(modelId, image) {
  const st = getDockerState();
  try {
    await invoke()("delete_docker_image", { modelId: modelId, image: image });
    st.dockerImages[modelId] = false;
    renderModelTable();
  } catch (e) {
    showToast(friendlyError(e, { prefix: _t("删除失败: ") }));
  }
}

function showDeleteConfirm(modelId, opts) {
  const modal = document.getElementById("delete-modal");
  const docker = !!(opts && opts.docker);
  const msg = docker
    ? _t("确定要删除模型 \"") + modelId + _t("\" 的本地镜像吗？删除后再次使用需重新下载。")
    : _t("确定要删除模型 \"") + modelId + _t("\" 吗？删除后无法恢复。");
  document.getElementById("delete-modal-msg").textContent = msg;
  modal.style.display = "flex";
  modal.dataset.modelId = modelId;
  modal.dataset.docker = docker ? "1" : "";
  modal.dataset.image = (opts && opts.image) || "";
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
    showToast(friendlyError(e, { prefix: "删除失败: " }));
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
    case "docker-progress": {
      const dst = getDockerState();
      if (payload.stage === "done") {
        delete dst.dockerTasks[model_id];
        dst.dockerImages[model_id] = true;
        markDockerAction(model_id);
        updateProgressBar(model_id, 100);
        renderModelTable();
      } else if (payload.stage === "cancelled") {
        // 用户取消：任务结束，镜像未就绪，按钮回到「下载」
        delete dst.dockerTasks[model_id];
        renderModelTable();
      } else {
        dst.dockerTasks[model_id] = { stage: payload.stage, progress: payload.progress || 0, message: payload.message || "" };
        updateProgressBar(model_id, payload.progress || 0);
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) {
          // 启动阶段按钮统一显示「模型启动中」，细节放卡片提示行
          const label = isDockerStarting(payload.stage) ? _t("模型启动中…") : (payload.message || _t("处理中..."));
          btn.textContent = label + " " + (payload.progress || 0) + "%";
        }
        const hint = document.querySelector('[data-hint="' + model_id + '"]');
        if (hint && isDockerStarting(payload.stage) && payload.message) hint.textContent = payload.message;
        // 阶段切换会影响「取消」按钮是否出现（安装 Docker Desktop 阶段不可取消）
        const hasCancelBtn = !!document.querySelector('[data-docker-cancel="' + model_id + '"]');
        if (isDockerTaskCancellable(payload.stage) !== hasCancelBtn) renderModelTable();
      }
      break;
    }
    case "download-progress": {
      const t = payload.type || "model";
      const key = model_id + ":" + t;
      const spd = trackDownloadSpeed(key, payload.downloaded || 0);
      if (spd !== null) dlSpeedShown[key] = formatSpeed(spd);
      const speedText = dlSpeedShown[key] ? " · " + dlSpeedShown[key] : "";
      if (t === "mmproj") {
        st.downloadingMmproj[model_id] = true;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = "mmproj " + progress + "%" + speedText;
      } else {
        st.downloadingModels[model_id] = progress;
        const btn = document.querySelector('[data-model-id="' + model_id + '"]');
        if (btn) btn.textContent = progress + "%" + speedText;
      }
      updateProgressBar(model_id, progress);
      break;
    }
    case "download-complete": {
      const t = payload.type || "model";
      clearDownloadSpeed(model_id);
      if (t === "mmproj") {
        delete st.downloadingMmproj[model_id];
        delete st.downloadingModels[model_id];
        const mmprojModel = st.modelList.find(m => m.model_id === model_id);
        const mmprojFile = mmprojModel && mmprojModel.model_mmproj ? getUrlFilename(mmprojModel.model_mmproj) : null;
        const realName = mmprojFile || "mmproj-downloaded.gguf";
        const local = st.localModels.find(m => m.model_id === model_id);
        if (local) {
          if (!local.files.some(f => f.toLowerCase().includes("mmproj"))) local.files.push(realName);
        } else {
          st.localModels.push({ model_id: model_id, files: [realName] });
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
      clearDownloadSpeed(model_id);
      showToast(friendlyError(error, { prefix: _t("下载失败 [") + model_id + _t("]: ") }));
      renderModelTable();
      break;
    }
    case "model-log": {
      break;
    }
case "model-started": {
      st.runningModelId = model_id;
      st.runningModelPort = port;
      // 启动任务已结束：清掉残留的进度/取消按钮（后端 clear_task 不发事件）
      delete getDockerState().dockerTasks[model_id];
      renderModelTable();
      break;
    }
    case "model-stopped": {
      st.runningModelId = null;
      st.runningModelPort = null;
      delete getDockerState().dockerTasks[model_id];
      renderModelTable();
      break;
    }
    case "model-error": {
      // llamacpp 启动异常（未进入监听就退出，后端 model_list.rs 监控线程发出）
      const code = payload.exit_code;
      const codeText = (typeof code === "number" && /^-?\d+$/.test(String(code))) ? " (" + String(code) + ")" : "";
      const detail = (typeof error === "string" && error) ? _t(error) : _t("推理引擎启动异常");
      // 用后端显式标志判断端口占用：错误文案已按当前语言翻译过，不能拿中文关键字匹配
      const hint = payload.port_busy === true ? _t("，请先释放被占用的端口") : _t("，请到设置检查推理引擎");
      showToast(_t("启动失败: ") + detail + codeText + hint);
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
        // hwinfo 插件只报单张卡显存，可能低于后端逐卡枚举结果，仅在未枚举到显卡时兜底
        if (gpuInfo && gpuInfo.vramMb && !(st.systemInfo.gpus && st.systemInfo.gpus.length > 0)) {
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
    }
  } catch (e) { console.error("获取下载阶段信息失败:", e); }

  try {
    const status = await invoke()("get_model_status");
if (status.running) {
  st.runningModelId = status.model_id;
  st.runningModelPort = status.port;
} else if (st.runningModelId) {
  // 后端已无运行中的模型（如图片生成容器被外部停止）：清掉前端残留状态
  st.runningModelId = null;
  st.runningModelPort = null;
}
  } catch (e) { console.error("获取模型状态失败:", e); }

  try {
    st.modelList = await invoke()("fetch_model_list");
  } catch (e) {
    showToast(friendlyError(e, { prefix: "获取模型列表失败: " }));
  }

  // 图片生成模型（docker）：运行要求（平台/显卡）+ 进行中的任务 + 本地是否已有镜像
  try { await refreshDockerEnv(); } catch (e) { console.warn("[model_list] 检查 Docker 环境失败:", e); }
  try {
    const tasks = await invoke()("get_docker_tasks");
    getDockerState().dockerTasks = tasks || {};
  } catch (e) { console.warn("[model_list] 获取 docker 任务失败:", e); }
  try { await refreshDockerImages(); } catch (e) { console.warn("[model_list] 查询本地镜像失败:", e); }
  try { await refreshDockerRunning(); } catch (e) { console.warn("[model_list] 同步容器状态失败:", e); }

  initModelTabs();
  renderModelTable();
  console.log("[model_list] init() 完成, 模型数量:", st.modelList.length);
}

function setupListeners() {
  const L = listen();
  const events = ["docker-progress", "download-progress", "download-complete", "download-error", "model-started", "model-stopped", "model-error"];
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
    // TAB 选择跨视图保留；兼容旧值/非法值时回退到第一个 TAB
    if (!MODEL_TABS.some(function(tab) { return tab.key === S().currentTypeFilter; })) {
      S().currentTypeFilter = MODEL_TABS[0].key;
    }
    // 列表数据异步加载，先同步 TAB 高亮，避免加载期间三个 TAB 均无选中态
    syncModelTabUI();

    // 禁用页面右键（屏蔽浏览器默认菜单，删除弹窗在根容器内一并覆盖）
    var listRoot = document.getElementById("model-list-root");
    if (listRoot) listRoot.addEventListener("contextmenu", function(e) { e.preventDefault(); });

  setupListeners();
    init();

    document.getElementById("delete-modal-cancel").addEventListener("click", hideDeleteConfirm);
    document.getElementById("delete-modal-confirm").addEventListener("click", async function() {
      const modal = document.getElementById("delete-modal");
      const modelId = modal.dataset.modelId;
      const isDockerDelete = modal.dataset.docker === "1";
      const image = modal.dataset.image || "";
      hideDeleteConfirm();
      if (!modelId) return;
      if (isDockerDelete) await handleDockerDelete(modelId, image);
      else await handleDelete(modelId);
    });
    document.getElementById("delete-modal").addEventListener("click", function(e) {
      if (e.target === this) hideDeleteConfirm();
    });
    document.getElementById("docker-modal-cancel").addEventListener("click", function() { hideDockerConfirm(false); });
    document.getElementById("docker-modal-confirm").addEventListener("click", function() { hideDockerConfirm(true); });
    document.getElementById("docker-modal").addEventListener("click", function(e) {
      if (e.target === this) hideDockerConfirm(false);
    });
  },
  unmount() {
    console.log("[model_list] unmount()");
    unlisteners.forEach(function(u) { try { if (typeof u === 'function') u(); } catch (_) {} });
    unlisteners = [];
  }
};
