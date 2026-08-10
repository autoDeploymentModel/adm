// 技能管理视图（hash 路由 #/skills）
// 两个 Tab：技能商店（远程 skills.json）/ 我的技能（agent server / 本地扫描兜底）
// 安装流程：卡片「安装」→ 弹窗选择位置（全局/当前项目）→ Rust 下载 zip → 校验 → 解压 → 删 zip
// 本地上传：文件选择器 → Rust 先校验（target=null）→ 通过后弹位置选择 → 正式安装
import { t as _t } from "../i18n.js";

/** @type {(...args: any[]) => Promise<any>} */
const invoke = window.__adm_invoke;

const STORE_INSTALLED_PREFIX = "skills_installed_";
/** 商店显示名 → zip 包内真实目录名（中文显示名无法作为目录名，安装后记录映射用于卸载时反向清理） */
const REALNAME_PREFIX = "skills_realname_";

// ===== 统一状态管理 =====
// 单一数据源 state.installed（磁盘扫描结果），所有 UI 从它派生「是否已安装」。
// 安装/卸载后统一走 refreshData() 刷新该数据源并重绘两个 tab，避免各自刷新导致的
// 不同步、或卸载后卡片不消失（历史问题：已装技能仍显示「安装」、卸载后页面不刷新）。
const state = {
  /** @type {any[]} 商店技能列表 */
  storeList: [],
  /** @type {string} 当前搜索词 */
  storeQuery: "",
  /** @type {Record<string, {sources:string[], storeName:string|null}>} 已安装唯一真相源：磁盘真实目录名 → 安装位置数组与店名 */
  installed: {},
  /** @type {Record<string,string>} 商店显示名 → 真实目录名（中文显示名与 ascii 目录名映射，卸载反向清理用） */
  displayToReal: {},
  /** @type {any[]} 我的技能列表（agent server + 本地扫描合并，含 source） */
  mineList: [],
  /** @type {string} agent server 工作区 id（读技能/刷新用） */
  mineWsId: "",
  /** @type {boolean} 我的技能数据是否来自 agent server */
  mineViaServer: false,
  /** @type {string} 当前安装位置（弹窗选择） */
  pendingTarget: "global",
};

const template = `
<style>
  /* 样式隔离：全部选择器带 skills- 前缀；全局 reset 由 index.html 壳层提供 */
  #skills-app {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
  }

  .skills-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
    padding: 20px 20px 16px;
  }

  .skills-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--c-text-hi);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .skills-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 18px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  .skills-tabs {
    display: flex;
    background: var(--c-overlay);
    border-radius: 8px;
    padding: 3px;
    gap: 2px;
  }
  .skills-tab {
    padding: 6px 18px;
    font-size: 13px;
    color: var(--c-text-2);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .skills-tab:hover { color: var(--c-text); }
  .skills-tab.active {
    background: var(--c-accent);
    color: #fff;
    font-weight: 500;
  }

  .skills-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 20px 20px;
  }
  .skills-body::-webkit-scrollbar { width: 6px; }
  .skills-body::-webkit-scrollbar-track { background: transparent; }
  .skills-body::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }

  .skills-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    margin-bottom: 14px;
  }
  .skills-search {
    flex: 1;
    max-width: 320px;
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    color: var(--c-text);
    font-size: 13px;
    padding: 8px 12px;
    outline: none;
  }
  .skills-search:focus { border-color: var(--c-accent); }
  .skills-upload-btn {
    margin-left: auto;
    background: var(--c-overlay);
    color: var(--c-text);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .skills-upload-btn:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }

  .skills-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  #skills-mine-grid { margin-top: 10px; }

  .skill-card {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
  }
  .skill-card:hover {
    border-color: var(--c-accent);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }

  .skill-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .skill-card-icon { font-size: 20px; flex-shrink: 0; }
  .skill-card-name {
    font-weight: 600;
    font-size: 15px;
    color: var(--c-text-hi);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .skill-badge {
    flex-shrink: 0;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--c-overlay);
    color: var(--c-text-2);
    border: 1px solid var(--c-border);
  }
  .skill-badge.type { color: var(--c-accent); border-color: rgba(var(--c-accent-rgb), 0.4); }
  .skill-badge.system { color: #4dabf7; border-color: rgba(77, 171, 247, 0.4); }
  .skill-badge.user { color: #69db7c; border-color: rgba(105, 219, 124, 0.4); }
  .skill-badge.project { color: #b197fc; border-color: rgba(177, 151, 252, 0.4); }

  .skill-card-desc {
    font-size: 12px;
    color: var(--c-text-2);
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 38px;
  }

  .skill-card-divider { border-top: 1px solid var(--c-border-soft); margin: 2px 0; }

  .skill-card-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .skill-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
  }
  .skill-status-dot.green { background: #69db7c; }
  .skill-status {
    font-size: 12px;
    color: var(--c-text-2);
    margin-right: auto;
    display: flex;
    align-items: center;
  }
  .skill-btn {
    border: none;
    border-radius: 7px;
    padding: 6px 16px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .skill-btn.primary { background: var(--c-accent); color: #fff; font-weight: 500; }
  .skill-btn.primary:hover { filter: brightness(1.1); }
  .skill-btn.primary:disabled { background: var(--c-border); color: var(--c-text-4); cursor: default; filter: none; }
  .skill-btn.ghost {
    background: var(--c-overlay);
    color: var(--c-text);
    border: 1px solid var(--c-border);
  }
  .skill-btn.ghost:hover { border-color: var(--c-accent); color: var(--c-accent); }
  .skill-btn.danger { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }
  .skill-btn.danger:hover { background: rgba(255, 107, 107, 0.22); }

  .skills-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 60px 20px;
    color: var(--c-text-3);
    font-size: 14px;
  }
  .skills-empty .skills-empty-btn {
    margin-top: 16px;
  }
  .skills-loading {
    grid-column: 1 / -1;
    text-align: center;
    padding: 50px 20px;
    color: var(--c-text-3);
    font-size: 13px;
  }

  /* 弹窗 */
  .skills-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9999;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .skills-dialog {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    padding: 24px 28px;
    max-width: 440px;
    width: 90%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }
  .skills-dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--c-text-hi);
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .skills-dialog-body { font-size: 13px; color: var(--c-text); line-height: 1.7; }
  .skills-location-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .skills-location-row:hover { border-color: var(--c-accent); }
  .skills-location-row.selected { border-color: var(--c-accent); background: rgba(var(--c-accent-rgb), 0.06); }
  .skills-location-row input { accent-color: var(--c-accent); cursor: pointer; }
  .skills-location-label { font-size: 13px; color: var(--c-text-hi); }
  .skills-location-desc { font-size: 11px; color: var(--c-text-3); word-break: break-all; }
  .skills-dialog-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  .skills-dialog-btn {
    border: none;
    border-radius: 8px;
    padding: 9px 24px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .skills-dialog-btn.cancel { background: var(--c-overlay); color: var(--c-text); }
  .skills-dialog-btn.ok { background: var(--c-accent); color: #fff; font-weight: 500; }
  .skills-dialog-btn.ok:disabled { opacity: 0.6; cursor: default; }
  .skills-dialog-btn.cancel:hover { filter: brightness(1.1); }
  .skills-dialog-btn.ok:hover { filter: brightness(1.1); }

  .skills-detail-body {
    max-height: 60vh;
    overflow: auto;
    background: var(--c-overlay);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 14px;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--c-text);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* toast（模板 style 注入后全局生效） */
  .skills-toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-left: 3px solid var(--c-accent);
    color: var(--c-text);
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 10000;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    max-width: 80vw;
  }
  .skills-toast.error { border-left-color: #ff6b6b; }
</style>

<div id="skills-app">
  <div class="skills-header">
    <div class="skills-title">🧩 ${_t("技能管理")}</div>
    <div class="skills-tabs">
      <div class="skills-tab active" data-tab="store">${_t("技能商店")}</div>
      <div class="skills-tab" data-tab="mine">${_t("我的技能")}</div>
    </div>
  </div>
  <div class="skills-body">
    <div class="skills-panel" data-panel="store">
      <div class="skills-toolbar">
        <input class="skills-search" id="skills-search" placeholder="${_t("搜索技能...")}">
        <button class="skills-upload-btn" id="skills-upload-btn">📦 ${_t("上传技能包")}</button>
      </div>
      <div class="skills-card-grid" id="skills-store-grid"></div>
    </div>
    <div class="skills-panel" data-panel="mine" style="display:none;">
      <div class="skills-card-grid" id="skills-mine-grid"></div>
    </div>
  </div>
</div>
`;

// ===== 通用 UI =====

/** 调试日志（走 Rust 端 agent_debug_log → adm_api_debug.log，自动加 UI: 前缀与时间戳） */
function apiLog(level, msg) {
  console.log("[skills][" + level + "] " + msg);
  if (invoke) invoke("agent_debug_log", { line: "[skills][" + level + "] " + msg }).catch(function () {});
}

/** 轻提示（3s 自动消失） */
function showToast(message, isError) {
  document.querySelectorAll(".skills-toast").forEach(function (el) { el.remove(); });
  const toast = document.createElement("div");
  toast.className = "skills-toast" + (isError ? " error" : "");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function () { toast.remove(); }, 3000);
}

/** 自绘确认弹窗（Promise<boolean>） */
function showConfirm(title, message, okText) {
  return new Promise(function (resolve) {
    const overlay = document.createElement("div");
    overlay.className = "skills-overlay";
    overlay.innerHTML =
      '<div class="skills-dialog">' +
        '<div class="skills-dialog-title">⚠️ ' + escHtml(title) + '</div>' +
        '<div class="skills-dialog-body" style="white-space:pre-line;"></div>' +
        '<div class="skills-dialog-actions">' +
          '<button class="skills-dialog-btn cancel" data-act="cancel">' + _t("取消") + '</button>' +
          '<button class="skills-dialog-btn ok" data-act="ok">' + (okText || _t("确定")) + '</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector(".skills-dialog-body").textContent = message;
    function close(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", function () { close(false); });
    overlay.querySelector('[data-act="ok"]').addEventListener("click", function () { close(true); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
  });
}

/** 安装位置选择弹窗（Promise<string | null>：global / project / null=取消） */
function showLocationDialog(skillDisplayName) {
  state.pendingTarget = "global"; // 每次打开弹窗重置默认位置
  return new Promise(function (resolve) {
    const overlay = document.createElement("div");
    overlay.className = "skills-overlay";
    overlay.innerHTML =
      '<div class="skills-dialog">' +
        '<div class="skills-dialog-title">📦 ' + _t("安装技能「") + escHtml(skillDisplayName) + '」</div>' +
        '<div class="skills-dialog-body">' + _t("选择安装位置") + '：</div>' +
        '<div style="margin-top:12px;">' +
          '<div class="skills-location-row" data-loc="global">' +
            '<input type="radio" name="skills-loc" value="global" checked>' +
            '<div><div class="skills-location-label">' + _t("全局（所有项目可用）") + '</div></div>' +
          '</div>' +
          '<div class="skills-location-row" data-loc="project">' +
            '<input type="radio" name="skills-loc" value="project">' +
            '<div style="min-width:0;"><div class="skills-location-label">' + _t("当前项目") + '</div>' +
            '<div class="skills-location-desc" id="skills-loc-project-desc"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="skills-dialog-actions">' +
          '<button class="skills-dialog-btn cancel" data-act="cancel">' + _t("取消") + '</button>' +
          '<button class="skills-dialog-btn ok" data-act="ok">' + _t("确认安装") + '</button>' +
        '</div>' +
      '</div>';

    const radios = /** @type {NodeListOf<HTMLInputElement>} */ (overlay.querySelectorAll('input[name="skills-loc"]'));
    function selectLocationRow(row) {
      const input = /** @type {HTMLInputElement} */ (row.querySelector("input"));
      if (!input || input.disabled) return;
      input.checked = true;
      state.pendingTarget = input.value;
      overlay.querySelectorAll(".skills-location-row").forEach(function (r) {
        r.classList.toggle("selected", r === row);
      });
    }
    overlay.querySelectorAll(".skills-location-row").forEach(function (row) {
      row.addEventListener("click", function () { selectLocationRow(row); });
    });

    // 显示当前项目路径；未配置工作目录时禁用「当前项目」
    const projectRow = /** @type {HTMLElement} */ (overlay.querySelector('[data-loc="project"]'));
    invoke("get_agent_workdir").then(function (workdir) {
      if (workdir) {
        overlay.querySelector("#skills-loc-project-desc").textContent = workdir;
      } else {
        projectRow.style.opacity = "0.45";
        const inputEl = /** @type {HTMLInputElement} */ (projectRow.querySelector("input"));
        inputEl.disabled = true;
      }
    }).catch(function () { projectRow.style.opacity = "0.45"; });

    function close(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", function () { close(null); });
    overlay.querySelector('[data-act="ok"]').addEventListener("click", function () {
      close(state.pendingTarget);
    });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });
}

/** 内容查看弹窗（SKILL.md 全文） */
function showDetailDialog(title, content) {
  const overlay = document.createElement("div");
  overlay.className = "skills-overlay";
  overlay.innerHTML =
    '<div class="skills-dialog" style="max-width:640px;">' +
      '<div class="skills-dialog-title">📄 ' + escHtml(title) + '</div>' +
      '<div class="skills-detail-body"></div>' +
      '<div class="skills-dialog-actions">' +
        '<button class="skills-dialog-btn ok" data-act="close">' + _t("关闭") + '</button>' +
      '</div>' +
    '</div>';
  overlay.querySelector(".skills-detail-body").textContent = content;
  overlay.querySelector('[data-act="close"]').addEventListener("click", function () { overlay.remove(); });
  overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * 解析后端技能错误前缀（[skill:<code>] <msg>），返回 {kind, message}。
 * kind: "exists" | "invalid" | "" — 前端按 kind 分支（覆盖确认 / 校验失败 / 其它失败），
 * 不再依赖中文文案匹配；message 为剥离前缀后的可读文本，直接展示。
 * @param {*} err
 * @returns {{kind: string, message: string}}
 */
function parseSkillError(err) {
  const msg = String(err);
  const m = msg.match(/^\[skill:(exists|invalid)\]\s?([\s\S]*)$/);
  if (m) return { kind: m[1], message: m[2] };
  return { kind: "", message: msg };
}

/** admAgent HTTP API 客户端（与 agent/api.js 同构，独立实现避免跨视图耦合） */
async function api(method, path, body) {
  return await invoke("agent_http_request", { method, path, body: body || null });
}

// ===== 已安装状态统一读写（state.installed 为唯一真相源） =====

/** 商店/展示名 → 磁盘真实目录名（fallback 自身）。中文显示名靠 displayToReal 映射 */
function realNameOf(name) {
  return state.displayToReal[name] || name;
}

/** name（可能为显示名）是否已在磁盘安装 */
function isInstalledName(name) {
  const rec = state.installed[realNameOf(name)];
  return !!(rec && rec.sources.length);
}

/** 取已安装技能的所有安装位置（["user","project"] 子集），未安装返回 [] */
function installedSourcesOf(name) {
  const rec = state.installed[realNameOf(name)];
  return rec ? rec.sources.slice() : [];
}

/** 记录一次安装：写入 state.installed 与 localStorage（持久化，用于跨会话反向映射） */
function recordInstalled(realName, source, displayName) {
  const display = displayName || realName;
  const rec = state.installed[realName];
  if (rec) {
    if (rec.sources.indexOf(source) < 0) rec.sources.push(source);
  } else {
    state.installed[realName] = { sources: [source], storeName: displayName || null };
  }
  if (display !== realName) state.displayToReal[display] = realName;
  try {
    localStorage[STORE_INSTALLED_PREFIX + realName] = source;
    if (display !== realName) {
      localStorage[STORE_INSTALLED_PREFIX + display] = source;
      localStorage[REALNAME_PREFIX + display] = realName;
    }
  } catch (_) {}
}

/** 记录一次卸载：从 state.installed 与 localStorage 移除真实目录及反向映射 */
function dropInstalled(realName) {
  delete state.installed[realName];
  try {
    for (const k of Object.keys(state.displayToReal)) {
      if (state.displayToReal[k] === realName) {
        delete state.displayToReal[k];
        delete localStorage[STORE_INSTALLED_PREFIX + k];
        delete localStorage[REALNAME_PREFIX + k];
      }
    }
  } catch (_) {}
  try { delete localStorage[STORE_INSTALLED_PREFIX + realName]; } catch (_) {}
}

/** 从 localStorage 恢复 displayToReal（历史安装记录 → 目录名映射），供 mount 时调用 */
function loadStoreMappings() {
  state.displayToReal = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(REALNAME_PREFIX) === 0) {
        state.displayToReal[k.substring(REALNAME_PREFIX.length)] = localStorage[k];
      }
    }
  } catch (_) {}
}

// ===== 技能商店 Tab =====

async function loadStore() {
  const grid = document.getElementById("skills-store-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="skills-loading">' + _t("加载中...") + '</div>';
  try {
    const items = await invoke("fetch_skill_store");
    state.storeList = Array.isArray(items) ? items : [];
    apiLog("info", "商店加载成功 count=" + state.storeList.length);
  } catch (e) {
    state.storeList = [];
    apiLog("warn", "商店加载失败: " + e);
    grid.innerHTML =
      '<div class="skills-empty">' + _t("加载技能商店失败: ") + escHtml(String(e)) +
      '<div><button class="skills-btn ghost skills-empty-btn" id="skills-store-retry">' + _t("重试") + '</button></div></div>';
    const retry = document.getElementById("skills-store-retry");
    if (retry) retry.addEventListener("click", loadStore);
    return;
  }
  renderStore();
}

function renderStore() {
  const grid = document.getElementById("skills-store-grid");
  if (!grid) return;
  const q = state.storeQuery.trim().toLowerCase();
  const list = state.storeList.filter(function (item) {
    if (!q) return true;
    return (item.skill_name || "").toLowerCase().indexOf(q) >= 0
      || (item.skill_type || "").toLowerCase().indexOf(q) >= 0
      || (item.skill_info || "").toLowerCase().indexOf(q) >= 0;
  });

  if (list.length === 0) {
    grid.innerHTML = '<div class="skills-empty">' + (q ? _t("暂无搜索结果") : _t("技能商店暂无可用技能")) + '</div>';
    return;
  }

  grid.innerHTML = "";
  list.forEach(function (item) {
    const name = item.skill_name || "unknown";
    // 已安装判断以磁盘扫描为准（zip 包真实目录名），附安装位置标签
    const sources = installedSourcesOf(name);
    const card = document.createElement("div");
    card.className = "skill-card";

    const header = document.createElement("div");
    header.className = "skill-card-header";
    header.innerHTML =
      '<span class="skill-card-icon">🧩</span>' +
      '<span class="skill-card-name">' + escHtml(name) + '</span>' +
      (item.skill_type ? '<span class="skill-badge type">' + escHtml(item.skill_type) + '</span>' : "");
    card.appendChild(header);

    const desc = document.createElement("div");
    desc.className = "skill-card-desc";
    desc.textContent = item.skill_info || "";
    // 描述 2 行截断，悬停显示完整内容
    if (item.skill_info) desc.title = item.skill_info;
    card.appendChild(desc);

    const divider = document.createElement("div");
    divider.className = "skill-card-divider";
    card.appendChild(divider);

    const actions = document.createElement("div");
    actions.className = "skill-card-actions";
    const btn = document.createElement("button");
    btn.className = "skill-btn primary";
    if (sources.length > 0) {
      btn.textContent = "✓ " + _t("已安装");
      btn.disabled = true;
      // 安装位置标签：可能同时安装在全局和项目，都显示
      sources.forEach(function (src) {
        const locBadge = document.createElement("span");
        locBadge.className = "skill-badge " + (src === "project" ? "project" : "user");
        locBadge.textContent = src === "project" ? _t("项目") : _t("全局");
        actions.appendChild(locBadge);
      });
    } else {
      btn.textContent = _t("安装");
      btn.addEventListener("click", function () { installStoreItem(item, btn); });
    }
    actions.appendChild(btn);
    card.appendChild(actions);

    grid.appendChild(card);
  });
}

async function installStoreItem(item, btn) {
  const name = item.skill_name || "unknown";
  // 重复安装确认（localStorage 记录或磁盘已存在）
  const target = await showLocationDialog(name);
  if (!target) return;
  apiLog("info", "安装「" + name + "」 target=" + target);

  btn.textContent = _t("安装中...");
  btn.disabled = true;
  try {
    const res = await invoke("install_skill", {
      skillUrl: item.skill_url,
      skillName: name,
      target: target,
      overwrite: false,
    });
    recordInstalled((res && res.name) || name, target, name);
    apiLog("info", "安装成功「" + name + "」 dir=" + ((res && res.dir) || "") + " realName=" + ((res && res.name) || ""));
    showToast(_t("安装成功"));
    refreshData();
  } catch (e) {
    const { kind, message } = parseSkillError(e);
    apiLog("warn", "安装「" + name + "」失败: " + message + " kind=" + kind);
    if (kind === "exists") {
      const ok = await showConfirm(_t("安装技能「") + name + "」", message, _t("覆盖"));
      if (ok) {
        apiLog("info", "覆盖安装「" + name + "」 target=" + target);
        try {
          const res2 = await invoke("install_skill", {
            skillUrl: item.skill_url,
            skillName: name,
            target: target,
            overwrite: true,
          });
          recordInstalled((res2 && res2.name) || name, target, name);
          apiLog("info", "覆盖安装成功「" + name + "」 dir=" + ((res2 && res2.dir) || ""));
          showToast(_t("安装成功"));
          refreshData();
        } catch (e2) {
          const e2p = parseSkillError(e2);
          apiLog("error", "覆盖安装「" + name + "」失败: " + e2p.message);
          showToast(_t("安装失败: ") + e2p.message, true);
        }
      }
    } else {
      showToast((kind === "invalid" ? _t("技能包格式不正确") + ": " : _t("安装失败: ")) + message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = _t("安装");
  }
}

// ===== 本地上传 =====

async function uploadSkillPack() {
  let path = null;
  try {
    path = await invoke("plugin:dialog|open", {
      options: { filters: [{ name: "zip", extensions: ["zip"] }], title: _t("选择技能包") },
    });
  } catch (e) {
    showToast(_t("打开文件选择器失败: ") + String(e), true);
    return;
  }
  if (!path) return; // 用户取消

  if (!String(path).toLowerCase().endsWith(".zip")) {
    showToast(_t("请选择 .zip 格式的技能包"), true);
    return;
  }

  // 第一步：仅校验（target=null），失败直接提示具体规则
  let name = "";
  try {
    const res = await invoke("install_skill_from_zip", { zipPath: path, target: null });
    name = (res && res.name) || "";
    apiLog("info", "上传包校验通过 zip=" + path + " name=" + name);
  } catch (e) {
    const { kind, message } = parseSkillError(e);
    apiLog("warn", "上传包校验失败 zip=" + path + " err=" + message + " kind=" + kind);
    showToast((kind === "invalid" ? _t("技能包格式不正确") + ": " : _t("校验失败") + ": ") + message, true);
    return;
  }

  // 第二步：校验通过，选择安装位置
  const target = await showLocationDialog(name || _t("技能包"));
  if (!target) return;

  try {
    await invoke("install_skill_from_zip", { zipPath: path, target: target, overwrite: false });
    if (name) recordInstalled(name, target);
    apiLog("info", "上传安装成功「" + name + "」 target=" + target);
    showToast(_t("安装成功"));
    refreshData();
  } catch (e) {
    const { kind, message } = parseSkillError(e);
    apiLog("warn", "上传安装「" + name + "」失败: " + message + " kind=" + kind);
    if (kind === "exists") {
      const ok = await showConfirm(_t("安装技能「") + name + "」", message, _t("覆盖"));
      if (ok) {
        apiLog("info", "上传覆盖安装「" + name + "」 target=" + target);
        try {
          await invoke("install_skill_from_zip", { zipPath: path, target: target, overwrite: true });
          if (name) recordInstalled(name, target);
          apiLog("info", "上传覆盖安装成功「" + name + "」");
          showToast(_t("安装成功"));
          refreshData();
        } catch (e2) {
          const e2p = parseSkillError(e2);
          apiLog("error", "上传覆盖安装「" + name + "」失败: " + e2p.message);
          showToast(_t("安装失败: ") + e2p.message, true);
        }
      }
    } else {
      showToast((kind === "invalid" ? _t("技能包格式不正确") + ": " : _t("安装失败: ") + message), true);
    }
  }
}

// ===== 我的技能 Tab =====

/** 归一化 /skills 接口返回（兼容数组/包装 key/Map 格式），source 统一为 system/user/project */
function normalizeSkillList(skills) {
  let arr = skills;
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === "object") {
      if (Array.isArray(arr.skills)) arr = arr.skills;
      else if (Array.isArray(arr.data)) arr = arr.data;
      else if (Array.isArray(arr.result)) arr = arr.result;
      else if (Array.isArray(arr.items)) arr = arr.items;
      else {
        const vals = Object.values(arr).filter(function (v) { return v && typeof v === "object"; });
        arr = vals.length > 0 && vals.every(function (v) { return typeof v.name === "string" || typeof v.id === "string"; })
          ? vals : [];
      }
    } else {
      arr = [];
    }
  }
  return arr.map(function (s) {
    const source = s.source === "builtin" ? "system" : (s.source || "user");
    return {
      id: s.id || s.name || "",
      name: s.name || s.id || "unknown",
      description: s.description || "",
      label: s.label || source + ":" + (s.name || ""),
      source: source,
      user_invocable: s.user_invocable !== false,
    };
  });
}

/**
 * 统一刷新入口：磁盘扫描 → 重建 state.installed（唯一真相源）→ 拉取 agent server
 * 「我的技能」并按磁盘过滤（内置保留）→ 清理失效 localStorage 记录 → 重绘两个 tab。
 * 安装/卸载/切 tab 都走这里，保证状态一致、避免不同步与不刷新。
 */
async function refreshData() {
  const grid = document.getElementById("skills-mine-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="skills-loading">' + _t("加载中...") + '</div>';

  // 1. 磁盘扫描 → 重建 state.installed（唯一真相源），同时获得 onDisk 映射
  //    onDisk: name → sources[]（同一技能可同时安装到全局和项目）
  const onDisk = {};
  try {
    const local = await invoke("list_installed_skills");
    (Array.isArray(local) ? local : []).forEach(function (s) {
      const src = s.source || "user";
      if (!onDisk[s.name]) onDisk[s.name] = [];
      if (onDisk[s.name].indexOf(src) < 0) onDisk[s.name].push(src);
    });
  } catch (e) {
    apiLog("warn", "扫描已安装技能失败: " + e);
  }
  state.installed = {};
  Object.keys(onDisk).forEach(function (dir) {
    state.installed[dir] = { sources: onDisk[dir], storeName: state.displayToReal[dir] || null };
  });
  apiLog("info", "磁盘扫描已安装技能 count=" + Object.keys(state.installed).length);

  // 2. agent server 列表（含 builtin 技能；可能是工作区创建时的快照，需以磁盘为准过滤）
  state.mineList = [];
  state.mineViaServer = false;
  state.mineWsId = "";
  try {
    const status = await invoke("get_agent_server_status");
    if (status && status.running) {
      let wsId = status.workspace_id || "";
      if (!wsId) {
        const workdir = await invoke("get_agent_workdir");
        const workspaces = await api("GET", "/v1/workspaces");
        const arr = Array.isArray(workspaces) ? workspaces : [];
        const matched = arr.find(function (w) { return w.path === workdir; });
        wsId = matched ? matched.id : "";
        if (!wsId && workdir) {
          const nw = await api("POST", "/v1/workspaces", { path: workdir, yolo: true });
          wsId = nw && nw.id ? nw.id : "";
        }
      }
      if (wsId) {
        state.mineWsId = wsId;
        const list = await api("GET", "/v1/workspaces/" + wsId + "/skills");
        state.mineList = normalizeSkillList(list);
        state.mineViaServer = true;
        apiLog("info", "我的技能(server) 拉取成功 count=" + state.mineList.length + " ws=" + wsId);
      }
    }
  } catch (e) {
    apiLog("warn", "agent server 拉取技能失败，降级本地扫描: " + e);
  }

  // 3. 本地扫描合并补充：磁盘有但 server 快照没有的（如刚安装的技能）
  //    同一技能名可能有多处安装（全局+项目），server 只返回一条，需合并 sources
  const seen = new Set(state.mineList.map(function (s) { return s.name; }));
  Object.keys(onDisk).forEach(function (dir) {
    if (seen.has(dir)) {
      // server 已有此技能 → 合并磁盘上的所有 sources
      const existing = state.mineList.find(function (s) { return s.name === dir; });
      if (existing && existing.source !== "system") {
        existing.sources = onDisk[dir].slice();
      }
      return;
    }
    seen.add(dir);
    state.mineList.push({
      id: dir,
      name: dir,
      description: "",
      label: onDisk[dir].join(",") + ":" + dir,
      source: onDisk[dir][0],
      sources: onDisk[dir].slice(),
      user_invocable: true,
    });
  });

  // 4. 以磁盘为准过滤「我的技能」：user/project 项若磁盘已不存在（如 server 快照残留/已卸载）
  //    则确定性移除，保证卸载后卡片立即消失；system 内置技能不在磁盘扫描目录，保留
  state.mineList = state.mineList.filter(function (s) {
    if (s.source === "system") return true;
    return onDisk[realNameOf(s.name)] && onDisk[realNameOf(s.name)].length > 0;
  });

  // 5. 清理 localStorage 中随卸载失效的安装记录，保持长期一致
  //    STORE_INSTALLED_* 键可能是真实目录名或商店显示名，分别判断
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(STORE_INSTALLED_PREFIX) !== 0) continue;
      const name = k.substring(STORE_INSTALLED_PREFIX.length);
      const real = state.displayToReal[name];
      if (real) {
        // 显示名记录：其真实目录仍存在 → 保留，否则删除该记录与映射
        if (onDisk[real] && onDisk[real].length) continue;
        delete state.displayToReal[name];
        delete localStorage[REALNAME_PREFIX + name];
        delete localStorage[k];
      } else {
        // 真实目录名记录：目录仍存在 → 保留
        if (onDisk[name] && onDisk[name].length) continue;
        delete localStorage[k];
      }
    }
  } catch (_) {}

  // 6. 重绘两个 tab（商店卡片需按最新 installed 刷新，修复「已装仍显示安装」）
  renderMine();
  renderStore();
}

function renderMine() {
  const grid = document.getElementById("skills-mine-grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (state.mineList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "skills-empty";
    empty.innerHTML = _t("还没有安装任何技能，去技能商店看看吧") +
      '<div><button class="skills-btn ghost skills-empty-btn" id="skills-go-store">' + _t("去商店看看") + '</button></div>';
    grid.appendChild(empty);
    const go = document.getElementById("skills-go-store");
    if (go) go.addEventListener("click", function () { switchTab("store"); });
    return;
  }

  state.mineList.forEach(function (s) {
    const card = document.createElement("div");
    card.className = "skill-card";

    // 合并 sources（兼容 server 只返回单个 source 的旧格式）
    const sources = s.sources || (s.source ? [s.source] : ["user"]);

    const header = document.createElement("div");
    header.className = "skill-card-header";
    let badgeHtml = '<span class="skill-card-icon">🧩</span>' +
      '<span class="skill-card-name">' + escHtml(s.name) + '</span>';
    // 同一技能可能同时安装在全局和项目，都显示对应标签
    sources.forEach(function (src) {
      badgeHtml += '<span class="skill-badge ' + escHtml(src) + '">' +
        (src === "system" ? _t("内置") : src === "project" ? _t("项目") : _t("全局")) +
      '</span>';
    });
    header.innerHTML = badgeHtml;
    card.appendChild(header);

    const desc = document.createElement("div");
    desc.className = "skill-card-desc";
    desc.textContent = s.description || s.label || "";
    // 描述 2 行截断，悬停显示完整内容
    if (s.description || s.label) desc.title = s.description || s.label;
    card.appendChild(desc);

    const divider = document.createElement("div");
    divider.className = "skill-card-divider";
    card.appendChild(divider);

    const actions = document.createElement("div");
    actions.className = "skill-card-actions";
    const status = document.createElement("span");
    status.className = "skill-status";
    status.innerHTML = '<span class="skill-status-dot green"></span>' + _t("已加载");
    actions.appendChild(status);

    // 查看：仅 agent server 数据源可读（本地扫描兜底无内容接口）
    if (state.mineViaServer && s.id) {
      const viewBtn = document.createElement("button");
      viewBtn.className = "skill-btn ghost";
      viewBtn.textContent = _t("查看");
      viewBtn.addEventListener("click", function () { viewSkillContent(s); });
      actions.appendChild(viewBtn);
    }

    // 卸载：system 内置技能不提供
    if (sources.indexOf("system") < 0) {
      const unBtn = document.createElement("button");
      unBtn.className = "skill-btn danger";
      unBtn.textContent = _t("卸载");
      unBtn.addEventListener("click", function () { uninstallSkillItem(s, unBtn); });
      actions.appendChild(unBtn);
    }
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

async function viewSkillContent(s) {
  try {
    const res = await api("POST", "/v1/workspaces/" + state.mineWsId + "/skills/read", {
      skill_id: s.id,
    });
    const b64 = (res && res.content) || "";
    // content 为 base64 编码的 SKILL.md；SKILL.md 是 UTF-8 字节，atob 只还原成
    // Latin1 二进制串，需再经 TextDecoder('utf-8') 才能正确显示中文（否则乱码）
    let content = "";
    if (b64) {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        content = new TextDecoder("utf-8").decode(bytes);
      } catch (_) {
        content = b64; // 回退原始内容（万一非 base64）
      }
    }
    apiLog("info", "查看技能内容「" + s.name + "」 length=" + content.length);
    showDetailDialog(s.name, content || "(empty)");
  } catch (e) {
    apiLog("warn", "读取技能内容「" + s.name + "」失败: " + e);
    showToast(_t("读取技能内容失败: ") + String(e), true);
  }
}

/** 多位置安装时选择卸载哪个位置（Promise<string | null>：user/project/null=取消） */
function showUninstallLocationDialog(skillName, sources) {
  return new Promise(function (resolve) {
    const overlay = document.createElement("div");
    overlay.className = "skills-overlay";
    let rowsHtml = "";
    sources.forEach(function (src) {
      const label = src === "project" ? _t("当前项目") : _t("全局");
      rowsHtml +=
        '<div class="skills-location-row" data-loc="' + escHtml(src) + '">' +
          '<input type="radio" name="skills-uninstall-loc" value="' + escHtml(src) + '">' +
          '<div class="skills-location-label">' + label + '</div>' +
        '</div>';
    });
    // 「全部卸载」选项
    rowsHtml +=
      '<div class="skills-location-row" data-loc="all">' +
        '<input type="radio" name="skills-uninstall-loc" value="all">' +
        '<div class="skills-location-label">' + _t("全部卸载") + '</div>' +
      '</div>';
    overlay.innerHTML =
      '<div class="skills-dialog">' +
        '<div class="skills-dialog-title">🗑️ ' + _t("卸载技能「") + escHtml(skillName) + '」</div>' +
        '<div class="skills-dialog-body">' + _t("此技能安装在多个位置，选择要卸载的位置") + '：</div>' +
        '<div style="margin-top:12px;">' + rowsHtml + '</div>' +
        '<div class="skills-dialog-actions">' +
          '<button class="skills-dialog-btn cancel" data-act="cancel">' + _t("取消") + '</button>' +
          '<button class="skills-dialog-btn ok" data-act="ok">' + _t("卸载") + '</button>' +
        '</div>' +
      '</div>';

    let selected = null;
    function selectUninstallRow(row) {
      const input = /** @type {HTMLInputElement} */ (row.querySelector("input"));
      if (!input || input.disabled) return;
      input.checked = true;
      selected = input.value;
      overlay.querySelectorAll(".skills-location-row").forEach(function (r) {
        r.classList.toggle("selected", r === row);
      });
      /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-act="ok"]')).disabled = false;
    }
    overlay.querySelectorAll(".skills-location-row").forEach(function (row) {
      row.addEventListener("click", function () { selectUninstallRow(row); });
    });
    // 默认禁用确认按钮直到用户选择
    /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-act="ok"]')).disabled = true;

    function close(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", function () { close(null); });
    overlay.querySelector('[data-act="ok"]').addEventListener("click", function () { close(selected); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });
}

async function uninstallSkillItem(s, btn) {
  // 合并 sources（兼容 server 只返回单个 source 的旧格式）
  const sources = s.sources || (s.source ? [s.source] : ["user"]);
  const isMulti = sources.length > 1;

  // 多位置安装时让用户选择卸载哪个位置（全局/项目），单一安装直接确认
  let targets = sources.slice();
  if (isMulti) {
    const choice = await showUninstallLocationDialog(s.name, sources);
    if (!choice) return; // 用户取消
    targets = choice === "all" ? sources.slice() : [choice];
  } else {
    const ok = await showConfirm(_t("卸载技能「") + s.name + "」", _t("确定要卸载此技能吗？"), _t("卸载"));
    if (!ok) return;
  }

  btn.disabled = true;
  try {
    // 逐个卸载选中的 target
    for (const tgt of targets) {
      await invoke("uninstall_skill", {
        skillName: s.name,
        target: tgt === "project" ? "project" : "global",
      });
      apiLog("info", "卸载成功「" + s.name + "」 target=" + tgt);
    }
    dropInstalled(s.name);
    showToast(_t("卸载成功"));
    // 确定性移除当前卡片，避免 server 快照残留导致卸载后卡片不消失
    state.mineList = state.mineList.filter(function (x) { return x.name !== s.name; });
    renderMine();
    // 刷新真相源并重绘两个 tab（商店恢复「安装」按钮）
    refreshData();
  } catch (e) {
    apiLog("warn", "卸载「" + s.name + "」失败: " + e);
    showToast(_t("卸载失败: ") + String(e), true);
    btn.disabled = false;
  }
}

// ===== Tab 切换 =====

function switchTab(tab) {
  const tabs = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".skills-tab"));
  tabs.forEach(function (el) {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  const panels = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".skills-panel"));
  panels.forEach(function (el) {
    el.style.display = el.dataset.panel === tab ? "" : "none";
  });
  if (tab === "store") {
    renderStore();
  } else {
    refreshData();
  }
}

// ===== 生命周期 =====

export default {
  template,
  mount(root) {
    apiLog("info", "mount()");
    root.innerHTML = template;
    // 先恢复 displayToReal 映射，确保 isInstalledName 判断可用
    loadStoreMappings();

    // 禁用页面右键（屏蔽浏览器默认菜单）
    const app = document.getElementById("skills-app");
    if (app) app.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    const tabs = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".skills-tab"));
    tabs.forEach(function (el) {
      el.addEventListener("click", function () { switchTab(el.dataset.tab); });
    });

    const search = document.getElementById("skills-search");
    if (search) {
      search.addEventListener("input", function () {
        state.storeQuery = /** @type {HTMLInputElement} */ (search).value;
        renderStore();
      });
    }

    const uploadBtn = document.getElementById("skills-upload-btn");
    if (uploadBtn) uploadBtn.addEventListener("click", uploadSkillPack);

    // 拉数据：商店列表 + 统一刷新（含磁盘扫描、我的技能、重绘）
    loadStore();
    refreshData();
  },
  unmount() {
    apiLog("info", "unmount()");
    // 清理 body 级弹窗/toast：视图卸载后残留的 fixed 遮罩会挡住新视图交互
    document.querySelectorAll(".skills-overlay, .skills-toast").forEach(function (el) { el.remove(); });
  },
};
