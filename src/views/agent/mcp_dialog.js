// MCP 服务添加 / 修改弹窗
//
// 配置持久化在 admAgent.json 顶层 `mcp` 映射（Rust 命令 list/add/update/delete_mcp_server），
// 与 Go 端 config.MCPConfig 字段对齐：stdio 用 command/args/env，http/sse 用 url/headers。
// 注意：admAgent server 只在启动时初始化 MCP 客户端，保存后须重启 Agent 服务才会
// 建立连接（/config/set 只触发配置内存重载，不会重建 MCP 会话），保存成功后询问用户
// 是否立即重启。
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { $input } from "./utils.js";
import { showChoice, showConfirm, showInfo, reportError } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { loadTools, activateToolsTab } from "./tools.js";

// 当前处于修改模式的 MCP 名称；null 表示新增
var editingMcpName = null;

// 弹窗构建/事件绑定（每次 mount 模板重建后调用，旧 DOM 一并丢弃，不会重复绑定）
export function initMcpDialogUI() {
  var overlay = document.getElementById("agent-mcp-overlay");
  if (!overlay) return;
  document.getElementById("agent-mcp-dialog-close").addEventListener("click", closeMcpDialog);
  document.getElementById("mcp-dialog-submit").addEventListener("click", submitMcpDialog);
  document.getElementById("mcp-dialog-delete").addEventListener("click", deleteMcpFromDialog);
  $input("mcp-dialog-type").addEventListener("change", toggleMcpTypeFields);
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeMcpDialog();
  });

  // MCP tab 的「添加」按钮
  var addBtn = document.getElementById("agent-mcp-add-btn");
  if (addBtn) addBtn.addEventListener("click", function() { openMcpDialog(null); });

  // 工具列表点击委托：已配置 MCP（data-mcp-name）→ 打开编辑弹窗
  var list = document.getElementById("agent-tools-list");
  if (list) {
    list.addEventListener("click", function(e) {
      var target = /** @type {Element|null} */ (e.target);
      var item = target && target.closest ? target.closest(".tool-item") : null;
      if (!item) return;
      var name = item.getAttribute("data-mcp-name");
      if (!name) return;
      openMcpDialog(findMcpView(name));
    });
  }
}

// 从工具列表缓存里取 MCP 配置视图（null 时按新增打开）
function findMcpView(name) {
  var tools = (S.toolsData && S.toolsData.mcp) || [];
  for (var i = 0; i < tools.length; i++) {
    if (tools[i] && tools[i].configed && tools[i].name === name && tools[i].view) {
      return tools[i].view;
    }
  }
  return null;
}

// 打开弹窗：server 为 null 时是新增，否则回填编辑
export function openMcpDialog(server) {
  editingMcpName = server ? server.name : null;
  var title = document.getElementById("mcp-dialog-title");
  var submit = document.getElementById("mcp-dialog-submit");
  var del = document.getElementById("mcp-dialog-delete");
  title.textContent = server ? _t("修改 MCP") : _t("添加 MCP");
  submit.textContent = server ? _t("保存") : _t("添加");
  del.style.display = server ? "inline-block" : "none";
  mcpDialogMsg("", false);

  $input("mcp-dialog-name").value = server ? server.name || "" : "";
  $input("mcp-dialog-type").value = (server && server.type) || "stdio";
  $input("mcp-dialog-command").value = (server && server.command) || "";
  $input("mcp-dialog-args").value = server && Array.isArray(server.args) ? server.args.join("\n") : "";
  $input("mcp-dialog-env").value = formatKvLines(server && server.env);
  $input("mcp-dialog-url").value = (server && server.url) || "";
  $input("mcp-dialog-headers").value = formatKvLines(server && server.headers);
  $input("mcp-dialog-timeout").value = server && server.timeout ? String(server.timeout) : "";
  $input("mcp-dialog-disabled").checked = !!(server && server.disabled);
  toggleMcpTypeFields();

  document.getElementById("agent-mcp-overlay").classList.add("show");
}

export function closeMcpDialog() {
  var overlay = document.getElementById("agent-mcp-overlay");
  if (overlay) overlay.classList.remove("show");
  editingMcpName = null;
}

// 按类型切换字段组：stdio → 命令/参数/环境变量；http、sse → URL/请求头
function toggleMcpTypeFields() {
  var isStdio = $input("mcp-dialog-type").value === "stdio";
  var stdioFields = document.getElementById("mcp-dialog-stdio-fields");
  var netFields = document.getElementById("mcp-dialog-net-fields");
  if (stdioFields) stdioFields.style.display = isStdio ? "flex" : "none";
  if (netFields) netFields.style.display = isStdio ? "none" : "flex";
}

// "KEY=VALUE" 行文本 → 对象（忽略空行与无等号行）
function parseKvLines(text) {
  var out = {};
  String(text || "").split("\n").forEach(function(line) {
    var t = line.trim();
    if (!t) return;
    var idx = t.indexOf("=");
    if (idx <= 0) return;
    var key = t.slice(0, idx).trim();
    if (key) out[key] = t.slice(idx + 1).trim();
  });
  return out;
}

// 对象 → "KEY=VALUE" 行文本
function formatKvLines(map) {
  if (!map || typeof map !== "object") return "";
  return Object.keys(map).map(function(k) { return k + "=" + map[k]; }).join("\n");
}

function mcpDialogMsg(text, isError) {
  var el = document.getElementById("mcp-dialog-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "#22c55e";
}

// 读取表单为提交结构（字段名与 Rust McpServerView / admAgent.json 对齐）
function readMcpForm() {
  var args = $input("mcp-dialog-args").value.split("\n").map(function(s) { return s.trim(); })
    .filter(function(s) { return s !== ""; });
  var timeoutRaw = $input("mcp-dialog-timeout").value.trim();
  var timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 0;
  if (isNaN(timeout) || timeout < 0) timeout = 0;
  return {
    name: $input("mcp-dialog-name").value.trim(),
    type: $input("mcp-dialog-type").value,
    command: $input("mcp-dialog-command").value.trim(),
    args: args,
    env: parseKvLines($input("mcp-dialog-env").value),
    url: $input("mcp-dialog-url").value.trim(),
    headers: parseKvLines($input("mcp-dialog-headers").value),
    timeout: timeout,
    disabled: $input("mcp-dialog-disabled").checked,
  };
}

// 保存后同步运行中的 server：写标量触发 /config/set 的全量重载，让服务端内存配置
// 立即包含最新 mcp 条目（MCP 会话仍需重启才重建）。失败静默，重启后必然生效。
async function syncMcpToServer() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/set", {
      scope: 0, key: "providers.local.name", value: "Local",
    });
  } catch (e) {
    console.warn("[agent] 同步 MCP 配置到服务端失败（重启后生效）:", e);
  }
}

// 保存/删除成功后的统一收尾：刷新列表 → 关闭弹窗 → 询问是否重启 Agent 服务
async function finishMcpChange() {
  await syncMcpToServer();
  await loadTools();
  closeMcpDialog();
  promptMcpRestart();
}

// 询问并重启 Agent 服务（重启走 agent.js 的 init()，恢复工作区与会话）
function promptMcpRestart() {
  showChoice({
    title: _t("MCP 配置已保存"),
    message: _t("新增或修改的 MCP 需要重启 Agent 服务后才会生效，是否立即重启？（正在进行的任务会被中断）"),
    okText: _t("立即重启"),
    cancelText: _t("稍后"),
    onOk: restartForMcp,
    onCancel: function() { showInfo(_t("配置已保存，重启 Agent 服务后生效")); },
  });
}

async function restartForMcp() {
  try {
    // 动态导入：避免与 agent.js（顶部静态导入 tools.js）形成循环依赖
    var agentMod = await import("../agent.js");
    await agentMod.restartAgentService();
    activateToolsTab("mcp");
  } catch (e) {
    reportError(e, { prefix: _t("重启 Agent 服务失败: ") });
  }
}

export async function submitMcpDialog() {
  var input = readMcpForm();
  if (!input.name) { mcpDialogMsg(_t("请填写名称"), true); return; }
  if (input.type === "stdio" && !input.command) { mcpDialogMsg(_t("请填写命令"), true); return; }
  if (input.type !== "stdio" && !input.url) { mcpDialogMsg(_t("请填写 URL"), true); return; }
  try {
    if (editingMcpName) {
      await invoke("update_mcp_server", { originalName: editingMcpName, input: input });
    } else {
      await invoke("add_mcp_server", { input: input });
    }
    await finishMcpChange();
  } catch (e) {
    mcpDialogMsg(getErrorMessage(e), true);
  }
}

export async function deleteMcpFromDialog() {
  if (!editingMcpName) return;
  var name = editingMcpName;
  showConfirm(_t("确定删除 MCP「") + name + _t("」？"), async function() {
    try {
      await invoke("delete_mcp_server", { name: name });
      await finishMcpChange();
    } catch (e) {
      mcpDialogMsg(getErrorMessage(e), true);
    }
  });
}
