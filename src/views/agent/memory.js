// 项目记忆（跨会话持久记忆）展示与编辑
// 数据源：workspace/project_memory.json（admAgent 每次上下文压缩时把 durable 的
// constraint/decision anchors 同步进来；本模块负责读取、渲染与手动增删改）。
// 写入路径：Rust 侧 update_project_memory 命令（原子写盘）。注意 admAgent 仍在
// 进程内持有同一份内存副本，下一次压缩会把其中条目合并回写本文件，因此手工删除
// 的条目可能被后续压缩重新沉淀。
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { escapeHtml, $input } from "./utils.js";
import { reportError, showChoice } from "./ui.js";

// Anchor JSON: { kind: "constraint"|"decision", key, value, why?, source?, salience?, updated_at? }
// 中文标签与颜色（与 template.js .memory-tag 对应；标签渲染时经 _t 翻译）
var KIND_LABEL = { constraint: _t("约束"), decision: _t("决策") };
var KIND_CLASS = { constraint: "constraint", decision: "decision" };

// 当前工作区记忆条目缓存（不依赖 S，避免与 workspace store 概念混淆）
var currentAnchors = [];
// 弹窗编辑态：null = 新增；number = 正在修改 currentAnchors[index]
var editingIndex = null;

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

// 渲染到设置弹窗内的折叠块（默认折叠；无记忆时显示空态；每条带编辑/删除按钮）
export function renderProjectMemory(anchors) {
  currentAnchors = Array.isArray(anchors) ? anchors.slice() : [];
  var body = document.getElementById("agent-memory-body");
  var count = document.getElementById("agent-memory-count");
  if (!body) return;
  var list = currentAnchors;
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
    html += '<div class="memory-item" data-idx="' + i + '">' +
      '<span class="memory-tag ' + cls + '">' + label + "</span>" +
      '<span class="memory-item-text">' + escapeHtml(a.value || "") + why + "</span>" +
      '<span class="memory-actions">' +
        '<button class="memory-action" data-act="edit" title="' + _t("修改") + '">✎</button>' +
        '<button class="memory-action del" data-act="del" title="' + _t("删除") + '">✕</button>' +
      "</span>" +
      "</div>";
  }
  body.innerHTML = html;
}

// 暴露当前缓存（克隆，避免外部 mutate）
export function getProjectMemoryAnchors() {
  return currentAnchors.slice();
}

// 把改动后的完整列表写回磁盘，再以服务端返回/本地最新状态重渲染
export async function saveProjectMemory(anchors) {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return false;
  try {
    await invoke("update_project_memory", {
      workspaceId: S.serverInfo.workspace_id,
      anchors: anchors,
    });
    renderProjectMemory(anchors);
    return true;
  } catch (e) {
    reportError(e, { prefix: _t("保存项目记忆失败: ") });
    return false;
  }
}

// ===== 弹窗：新增 / 修改 =====
// index 为 null 表示新增；否则修改 currentAnchors[index]
export function openMemoryEditor(index) {
  editingIndex = (typeof index === "number") ? index : null;
  var title = document.getElementById("memory-dialog-title");
  var submit = $input("memory-dialog-submit");
  var kindSel = /** @type {HTMLSelectElement} */ (document.getElementById("memory-dialog-kind"));
  var valEl = /** @type {HTMLTextAreaElement} */ (document.getElementById("memory-dialog-value"));
  var whyEl = $input("memory-dialog-why");
  var msg = document.getElementById("memory-dialog-msg");
  if (!title || !submit || !kindSel || !valEl || !whyEl) return;
  var editing = (editingIndex !== null) ? currentAnchors[editingIndex] : null;
  title.textContent = editing ? _t("修改项目记忆") : _t("添加项目记忆");
  submit.textContent = editing ? _t("保存") : _t("添加");
  kindSel.value = (editing && (editing.kind === "decision" || editing.kind === "constraint")) ? editing.kind : "constraint";
  valEl.value = editing ? (editing.value || "") : "";
  whyEl.value = editing && editing.why ? editing.why : "";
  if (msg) msg.textContent = "";
  document.getElementById("agent-memory-overlay").classList.add("show");
  setTimeout(function() { valEl.focus(); }, 0);
}

export function closeMemoryEditor() {
  var overlay = document.getElementById("agent-memory-overlay");
  if (overlay) overlay.classList.remove("show");
  editingIndex = null;
}

export async function submitMemoryEditor() {
  var kindSel = /** @type {HTMLSelectElement} */ (document.getElementById("memory-dialog-kind"));
  var valEl = /** @type {HTMLTextAreaElement} */ (document.getElementById("memory-dialog-value"));
  var whyEl = $input("memory-dialog-why");
  var msg = document.getElementById("memory-dialog-msg");
  if (!kindSel || !valEl) return;
  var kind = kindSel.value;
  var value = (valEl.value || "").trim();
  var why = (whyEl && whyEl.value || "").trim();
  if (value.length === 0) {
    if (msg) msg.textContent = _t("内容不能为空");
    return;
  }
  // 基于当前缓存拷贝，避免直接 mutate 后服务端写失败导致 UI 与本地不同步
  var next = currentAnchors.slice();
  var anchor = { kind: kind, value: value };
  if (why) anchor.why = why;
  // 保留原 key（去重逻辑由 Rust 侧按 kind:value 兜底；编辑时保留旧 key 以确保覆盖）
  var prev = (editingIndex !== null) ? currentAnchors[editingIndex] : null;
  if (prev && prev.key) anchor.key = prev.key;
  if (editingIndex !== null) {
    next[editingIndex] = anchor;
  } else {
    next.push(anchor);
  }
  var ok = await saveProjectMemory(next);
  if (ok) closeMemoryEditor();
}

// ===== 单条删除（行内按钮触发） =====
export async function deleteMemoryEntry(index) {
  if (index < 0 || index >= currentAnchors.length) return;
  var a = currentAnchors[index] || {};
  var label = KIND_LABEL[a.kind] || a.kind || _t("约束");
  var preview = (a.value || "").slice(0, 60);
  var proceed = false;
  showChoice({
    title: _t("删除项目记忆"),
    message: _t("确定删除这条项目记忆吗？") + "\n\n" + label + ": " + preview,
    onOk: function() { proceed = true; },
  });
  // 等待用户决策：通过轮询 .permission-overlay 是否还存在判断
  // （showChoice 不返回 Promise，自建轻量等待器，避免引入复杂状态机）
  while (document.querySelector(".permission-overlay")) {
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  if (!proceed) return;
  var next = currentAnchors.slice();
  next.splice(index, 1);
  await saveProjectMemory(next);
}

// 设置弹窗打开时调用：读取并渲染项目记忆
export async function refreshProjectMemory() {
  var anchors = await loadProjectMemory();
  renderProjectMemory(anchors);
}