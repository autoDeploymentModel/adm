// 项目记忆（跨会话持久记忆）只读展示
// 数据源：admAgent 自动维护的 workspace/project_memory.json（约束/决策 anchors，
// 随上下文压缩自动同步）。本模块负责读取并渲染为默认折叠的展示块。
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { escapeHtml } from "./utils.js";

// Anchor JSON: { kind: "constraint"|"decision", key, value, why?, salience?, updated_at? }
// 中文标签与颜色（与 template.js .memory-tag 对应；标签渲染时经 _t 翻译）
var KIND_LABEL = { constraint: _t("约束"), decision: _t("决策") };
var KIND_CLASS = { constraint: "constraint", decision: "decision" };

// 读取项目记忆（Rust 侧 read_project_memory 返回 Anchor 数组或 []）
export async function loadProjectMemory() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return [];
  try {
    var data = await invoke("read_project_memory", { workspaceId: S.serverInfo.workspace_id });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("[agent] 读取项目记忆失败:", e);
    return [];
  }
}

// 渲染到设置弹窗内的折叠块（默认折叠；无记忆时显示空态）
export function renderProjectMemory(anchors) {
  var body = document.getElementById("agent-memory-body");
  var count = document.getElementById("agent-memory-count");
  if (!body) return;
  var list = Array.isArray(anchors) ? anchors : [];
  if (count) count.textContent = list.length > 0 ? "（" + list.length + " " + _t("条") + "）" : "";
  if (list.length === 0) {
    body.innerHTML = '<div class="memory-empty">' + _t("暂无项目记忆（进行上下文压缩后会自动沉淀约束与决策）") + '</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    var kind = a.kind || "constraint";
    var label = KIND_LABEL[kind] || kind;
    var cls = KIND_CLASS[kind] || "constraint";
    var why = a.why ? '<span class="memory-why"> — ' + escapeHtml(a.why) + "</span>" : "";
    html += '<div class="memory-item"><span class="memory-tag ' + cls + '">' + label + "</span><span>" +
      escapeHtml(a.value || "") + why + "</span></div>";
  }
  body.innerHTML = html;
}

// 设置弹窗打开时调用：读取并渲染项目记忆
export async function refreshProjectMemory() {
  var anchors = await loadProjectMemory();
  renderProjectMemory(anchors);
}
