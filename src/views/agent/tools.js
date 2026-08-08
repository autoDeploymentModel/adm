// 工具面板（Skill / LSP / MCP）
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";

// ===== 工具列表 =====
// 分别调用 /skills、/mcp/states、/lsps 三个端点，外加工作区详情获取 skill 状态快照
// 结果按 tab（skill / lsp / mcp）分类缓存到 toolsData，再渲染当前 tab
export async function loadTools() {
  if (!S.serverInfo) return;
  var wsId = S.serverInfo.workspace_id;

  // MCP/LSP 共用的 state 字符串 → 中文标签 + 颜色（显示时经 _t 翻译）
  var stateMap = {
    connected: { label: _t("已连接"), color: "green" },
    starting:  { label: _t("启动中"), color: "yellow" },
    disabled:  { label: _t("已禁用"), color: "gray" },
    error:     { label: _t("错误"),   color: "red" },
  };

  // 并行请求四个端点（工作区详情用于 skill 状态快照）
  var results = await Promise.allSettled([
    api("GET", "/v1/workspaces/" + wsId + "/skills"),
    api("GET", "/v1/workspaces/" + wsId + "/mcp/states"),
    api("GET", "/v1/workspaces/" + wsId + "/lsps"),
    api("GET", "/v1/workspaces/" + wsId),
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

  // MCP clients
  var mcpTools = [];
  if (results[1].status === "fulfilled") {
    var mcpStates = results[1].value;
    if (mcpStates && typeof mcpStates === "object" && !Array.isArray(mcpStates)) {
      Object.values(mcpStates).forEach(function(m) {
        var st = stateMap[m.state] || { label: m.state || _t("未知"), color: "gray" };
        mcpTools.push({
          name: m.name || "unknown",
          status: st.label,
          statusColor: st.color,
          title: m.error || "",
        });
      });
    }
  }

  // LSP clients
  var lspTools = [];
  if (results[2].status === "fulfilled") {
    var lspStates = results[2].value;
    if (lspStates && typeof lspStates === "object" && !Array.isArray(lspStates)) {
      Object.keys(lspStates).forEach(function(key) {
        var l = lspStates[key];
        var st = stateMap[l.state] || { label: l.state || _t("未知"), color: "gray" };
        lspTools.push({
          name: l.name || key,
          status: st.label,
          statusColor: st.color,
          title: l.error || "",
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
    var dot = document.createElement("span");
    dot.className = "tool-dot " + (tool.statusColor || "gray");
    item.appendChild(dot);
    var name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    item.appendChild(name);
    var statusLabel = document.createElement("span");
    statusLabel.className = "tool-status " + (tool.statusColor || "gray");
    statusLabel.textContent = tool.status;
    item.appendChild(statusLabel);
    container.appendChild(item);
  });
}
