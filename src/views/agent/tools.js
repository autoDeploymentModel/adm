// 工具面板（Skill / LSP / MCP）
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { showInfo } from "./ui.js";
import { $input } from "./utils.js";
import { ensureFixTargets, isLspFixable, fixTarget, guideFor, runLspFix, runAiInstall, isLspAutoFixEnabled, setLspAutoFixEnabled, onLspStateEvent } from "./lsp_fix.js";

// ===== 工具列表 =====
// 分别调用 /skills、/mcp/states、/lsps 三个端点，外加工作区详情获取 skill 状态快照
// 结果按 tab（skill / lsp / mcp）分类缓存到 toolsData，再渲染当前 tab
export async function loadTools() {
  if (!S.serverInfo) return;
  var wsId = S.serverInfo.workspace_id;
  await ensureFixTargets();

  // MCP/LSP 共用的 state 字符串 → 中文标签 + 颜色（显示时经 _t 翻译）
  var stateMap = {
    connected: { label: _t("已连接"), color: "green" },
    starting:  { label: _t("启动中"), color: "yellow" },
    disabled:  { label: _t("已禁用"), color: "gray" },
    error:     { label: _t("错误"),   color: "red" },
  };

  // 并行请求四个端点（工作区详情用于 skill 状态快照），外加本地磁盘扫描兜底
  // + admAgent.json 中的 MCP 配置（可编辑来源）
  var results = await Promise.allSettled([
    api("GET", "/v1/workspaces/" + wsId + "/skills"),
    api("GET", "/v1/workspaces/" + wsId + "/mcp/states"),
    api("GET", "/v1/workspaces/" + wsId + "/lsps"),
    api("GET", "/v1/workspaces/" + wsId),
    invoke("list_installed_skills"),
    invoke("list_mcp_servers"),
  ]);

  // Skill 状态快照 map: name → {state, error}（state: 0=正常 1=错误）
  var skillStates = {};
  if (results[3].status === "fulfilled" && results[3].value && Array.isArray(results[3].value.skills)) {
    results[3].value.skills.forEach(function(s) {
      if (s && s.name) skillStates[s.name] = s;
    });
  }

  // Skills
  var skillTools = [];
  if (results[0].status === "fulfilled") {
    var skills = results[0].value;
    if (Array.isArray(skills)) {
      // 直接数组格式 [SkillInfo, ...]
    } else if (skills && typeof skills === "object") {
      // 尝试多种可能的包装 key
      if (Array.isArray(skills.skills)) skills = skills.skills;
      else if (Array.isArray(skills.data)) skills = skills.data;
      else if (Array.isArray(skills.result)) skills = skills.result;
      else if (Array.isArray(skills.items)) skills = skills.items;
      else {
        // Map 格式 {"name": SkillInfo, ...}
        var mapValues = Object.values(skills).filter(function(v) { return v && typeof v === "object"; });
        if (mapValues.length > 0 && mapValues.every(function(v) { return typeof v.name === "string" || typeof v.id === "string"; })) {
          skills = mapValues;
        } else {
          skills = [];
        }
      }
    } else {
      skills = [];
    }
    skills.forEach(function(s) {
      var name = s.name || s.id || "unknown";
      // 快照里 state=1 为发现/解析错误；能出现在 /skills 列表里的默认视为已加载
      var snap = skillStates[name];
      var status = { label: _t("已加载"), color: "green", title: "" };
      if (snap && snap.state === 1) {
        status = { label: _t("错误"), color: "red", title: snap.error || "" };
      }
      skillTools.push({
        name: name,
        status: status.label,
        statusColor: status.color,
        title: status.title,
      });
    });
  }

  // 磁盘扫描兜底合并：server 的 skill 列表是 workspace 创建时的发现快照，
  // 技能管理页安装的全局/项目技能不会触发服务端重新发现，需以磁盘为准补齐，
  // 否则切回 Agent 页 Skill 栏看不到刚安装的技能。
  if (results[4].status === "fulfilled" && Array.isArray(results[4].value)) {
    var knownNames = {};
    skillTools.forEach(function (tool) { knownNames[tool.name] = true; });
    results[4].value.forEach(function (s) {
      if (!s || !s.name || knownNames[s.name]) return;
      knownNames[s.name] = true;
      skillTools.push({
        name: s.name,
        status: _t("已加载"),
        statusColor: "green",
        title: "",
      });
    });
  }

  // MCP clients：配置（admAgent.json 顶层 mcp）为可编辑来源，
  // /mcp/states 提供运行状态；两者按名称合并展示：
  // - 已配置：有点击编辑入口；有运行状态则显示状态，否则显示「待重启生效」（新增/修改需重启 server 初始化）
  // - 仅运行状态存在（配置文件里没有）：只读展示
  var runtimeStates = {};
  if (results[1].status === "fulfilled") {
    var mcpStates = results[1].value;
    if (mcpStates && typeof mcpStates === "object" && !Array.isArray(mcpStates)) {
      Object.values(mcpStates).forEach(function(m) {
        if (m && m.name) runtimeStates[m.name] = m;
      });
    }
  }
  function runtimeStatus(m) {
    var st = stateMap[m.state] || { label: m.state || _t("未知"), color: "gray" };
    return { label: st.label, color: st.color, title: m.error || "" };
  }

  var mcpTools = [];
  var configViews = [];
  if (results[5] && results[5].status === "fulfilled" && Array.isArray(results[5].value)) {
    configViews = results[5].value;
  }
  configViews.forEach(function(view) {
    var runtime = runtimeStates[view.name];
    var status = runtime ? runtimeStatus(runtime) : (view.disabled
      ? { label: _t("已禁用"), color: "gray", title: "" }
      : { label: _t("待重启生效"), color: "gray", title: _t("新增或修改的 MCP 需重启 Agent 服务后生效") });
    mcpTools.push({
      name: view.name,
      status: status.label,
      statusColor: status.color,
      title: status.title,
      configed: true,
      view: view,
    });
  });
  Object.keys(runtimeStates).forEach(function(name) {
    var exists = mcpTools.some(function(t) { return t.name === name; });
    if (exists) return;
    var status = runtimeStatus(runtimeStates[name]);
    mcpTools.push({
      name: name,
      status: status.label,
      statusColor: status.color,
      title: status.title,
      configed: false,
    });
  });

  // LSP clients（state 为整数：0=未启动 1=启动中 2=已连接 3=错误 4=已停止 5=已禁用）
  // error_type=not_installed（服务端分类）表示二进制未安装：不作为故障展示，
  // 直接隐藏——真正启动失败（startup_failed）才保留红点与修复入口。
  var lspStateMap = {
    0: { label: _t("未启动"), color: "gray" },
    1: { label: _t("启动中"), color: "yellow" },
    2: { label: _t("已连接"), color: "green" },
    3: { label: _t("错误"), color: "red" },
    4: { label: _t("已停止"), color: "gray" },
    5: { label: _t("已禁用"), color: "gray" },
  };
  var lspTools = [];
  if (results[2].status === "fulfilled") {
    var lspStates = results[2].value;
    if (lspStates && typeof lspStates === "object" && !Array.isArray(lspStates)) {
      Object.keys(lspStates).forEach(function(key) {
        var l = lspStates[key];
        var lspName = l.name || key;
        var isErr = l.state === 3;
        // 状态事件先派发（drive 自动安装开关），再决定是否展示：
        // error_type=not_installed 仅表示未安装，不作为故障展示/计数。
        if (isErr) onLspStateEvent(lspName, l.state, l.error, l.error_type);
        if (l.error_type === "not_installed") return;
        var st = lspStateMap[l.state] || { label: l.state || _t("未知"), color: "gray" };
        var fixable = isErr && isLspFixable(lspName);
        lspTools.push({
          name: lspName,
          status: st.label,
          statusColor: st.color,
          title: l.error || "",
          errorText: l.error || "",
          fixable: fixable,
          guide: isErr && !fixable ? guideFor(lspName) : null,
          aiInstall: isErr,
        });
      });
    }
  }

  S.toolsData = { skill: skillTools, lsp: lspTools, mcp: mcpTools };
  renderToolsList();
}

// 渲染当前 tab 的工具列表（名称 + 状态），空则显示占位
export function renderToolsList() {
  var container = document.getElementById("agent-tools-list");
  var countEl = document.getElementById("agent-tools-count");
  if (!container) return;
  ensureAutoFixToggle();

  // 添加 MCP 按钮仅在 MCP tab 显示
  var addBtn = document.getElementById("agent-mcp-add-btn");
  if (addBtn) addBtn.classList.toggle("show", S.toolsTab === "mcp");

  var tools = S.toolsData[S.toolsTab] || [];
  if (countEl) countEl.textContent = String(tools.length);
  container.innerHTML = "";

  if (tools.length === 0) {
    container.innerHTML = '<div class="tool-item"><span class="tool-dot gray"></span><span class="tool-name" style="color:var(--c-text-4);">' + _t("暂无工具") + '</span></div>';
    return;
  }

  tools.forEach(function(tool) {
    var item = document.createElement("div");
    item.className = "tool-item";
    if (tool.title) item.title = tool.title;
    // 已配置的 MCP 可点击进入编辑（点击事件由 mcp_dialog.js 在列表容器上委托）
    if (tool.configed) item.setAttribute("data-mcp-name", tool.name);
    var dot = document.createElement("span");
    dot.className = "tool-dot " + (tool.statusColor || "gray");
    item.appendChild(dot);
    var name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    item.appendChild(name);
    if (tool.configed) {
      var hint = document.createElement("span");
      hint.className = "tool-edit-hint";
      hint.textContent = "✎";
      hint.title = _t("点击修改");
      item.appendChild(hint);
    }
    if (tool.fixable) {
      var fixBtn = document.createElement("button");
      fixBtn.className = "tool-fix-btn";
      fixBtn.textContent = _t("修复");
      var ft = fixTarget(tool.name);
      if (ft && ft.command) fixBtn.title = ft.command + (ft.requires ? "（需要 " + ft.requires + "）" : "");
      fixBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        fixBtn.disabled = true;
        fixBtn.textContent = _t("修复中…");
        runLspFix(tool.name).then(function() {
          fixBtn.disabled = false;
          fixBtn.textContent = _t("修复");
        });
      });
      item.appendChild(fixBtn);
    } else if (tool.guide) {
      var guideBtn = document.createElement("button");
      guideBtn.className = "tool-fix-btn";
      guideBtn.textContent = _t("指引");
      if (tool.guide.hint) guideBtn.title = tool.guide.hint;
      guideBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (tool.guide && tool.guide.url) window.openUrl(tool.guide.url);
      });
      item.appendChild(guideBtn);
    }
    if (tool.aiInstall) {
      var aiBtn = document.createElement("button");
      aiBtn.className = "tool-fix-btn";
      aiBtn.textContent = _t("AI 安装");
      aiBtn.title = _t("把安装任务发给当前会话的 AI 处理");
      aiBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        runAiInstall(tool.name, tool.errorText);
      });
      item.appendChild(aiBtn);
    }
    var statusLabel = document.createElement("span");
    statusLabel.className = "tool-status " + (tool.statusColor || "gray");
    statusLabel.textContent = tool.status;
    item.appendChild(statusLabel);
    container.appendChild(item);
  });
}

// 绑定「启动失败自动修复」开关（DOM 随视图重建，用 dataset 标记避免重复绑定）
function ensureAutoFixToggle() {
  var row = document.getElementById("agent-lsp-autofix-row");
  if (!row || row.dataset.bound) return;
  var box = $input("agent-lsp-autofix");
  if (!box) return;
  row.dataset.bound = "1";
  box.checked = isLspAutoFixEnabled();
  box.addEventListener("change", function() {
    setLspAutoFixEnabled(!!box.checked);
    showInfo(box.checked ? _t("LSP 启动失败时将自动安装修复") : _t("LSP 启动失败时仅提示，不自动安装"));
  });
  row.style.display = S.toolsTab === "lsp" ? "flex" : "none";
}

// 切换工具 tab（Skill / LSP / MCP）并重绘列表；供 tab 点击与外部流程（如保存 MCP 后）调用
export function activateToolsTab(tab) {
  S.toolsTab = tab;
  var toolsTabs = document.getElementById("agent-tools-tabs");
  if (toolsTabs) {
    toolsTabs.querySelectorAll(".tools-tab").forEach(function(t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === tab);
    });
  }
  var autoRow = document.getElementById("agent-lsp-autofix-row");
  if (autoRow) autoRow.style.display = tab === "lsp" ? "flex" : "none";
  renderToolsList();
}
