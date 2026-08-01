// 消息渲染（增量 DOM 对齐）与 Todo 列表
import { S } from "./state.js";
import { renderMarkdown, formatTime } from "./utils.js";
import { updateScrollBottomBtn } from "./ui.js";

// ===== 消息渲染 =====
// Message 结构: { id, role, session_id, parts: ContentPart[], model, provider, created_at, updated_at }
// ContentPart 联合类型通过 type 字段区分:
//   text / reasoning / image_url / binary / tool_call / tool_result / finish / shell_command
//
// 增量渲染：流式输出时 SSE 每秒触发多次渲染，若整体重建 DOM，
// 「正在思考」指示器会不断重建导致动画闪烁，且推理过程 <summary> 在 mousedown 与
// mouseup 之间被销毁，点击永远无法命中（表现为无法展开思考过程）。
// 因此按 data-msgid 逐条对齐：内容未变的消息节点原样保留；结构未变的就地更新文本
// （保住 <details> 元素身份，流式期间可点开/收起）；结构变化才重建该消息节点。

// 该 part 是否需要渲染（用户消息不显示 finish 标记）
// hiddenCallIds: 因工具不可用（如 Plan 模式下 edit/write）而应隐藏的 tool_call id 集合，
// 对应的 tool_call 与 tool_result 一并不渲染。
function isPartRenderable(part, role, hiddenCallIds) {
  if (!part || !part.type) return false;
  if (part.type === "finish" && role === "user") return false;
  if (hiddenCallIds && hiddenCallIds.size) {
    var d = part.data || {};
    if (part.type === "tool_call" && d.id && hiddenCallIds.has(d.id)) return false;
    if (part.type === "tool_result" && d.tool_call_id && hiddenCallIds.has(d.tool_call_id)) return false;
  }
  return true;
}

// 收集"工具不可用"的 tool_call id：Plan 模式下模型仍会尝试 edit/write 等被移除的工具，
// 服务端必须回 "Tool not found: xxx" 让模型自我纠正，但这类失败对用户无意义，不展示。
// 返回需隐藏的 tool_call id 集合（tool_call 与其 tool_result 成对隐藏）。
function unavailableToolCallIds(parts) {
  var ids = new Set();
  if (!Array.isArray(parts)) return ids;
  parts.forEach(function(p) {
    if (!p || p.type !== "tool_result") return;
    var d = p.data || {};
    if (d.is_error && d.tool_call_id && /^Tool not found:/.test(String(d.content || ""))) {
      ids.add(d.tool_call_id);
    }
  });
  return ids;
}

// 单个 part 的内容签名（长度/状态足以覆盖流式追加场景）
function partSig(part) {
  var d = (part && part.data) || {};
  return (part.type || "?") + ":" +
    ((d.text || "").length + (d.thinking || "").length + (d.input || "").length +
     String(d.content || d.data || "").length + (d.output || "").length + (d.url || "").length) +
    ":" + (d.finished === false ? "r" : "f") + (d.is_error ? "e" : "") +
    ":" + (d.name || "") + (d.reason || "") + (d.exit_code !== undefined ? d.exit_code : "") + (d.path || "");
}

// 消息内容签名：变化才触发该消息节点的更新
function msgSignature(msg) {
  if (msg._streaming || !msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0) {
    return "c:" + (msg.content || "").length + ":" + (msg.model || "") + (msg.provider || "");
  }
  return "p:" + msg.parts.map(partSig).join(";") + "|" + (msg.model || "") + (msg.provider || "") + (msg.created_at || "");
}

// 消息结构签名：part 类型序列 + 是否有元信息，结构一致才允许就地更新
function msgStructSig(msg, role) {
  if (msg._streaming || !msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0) return "plain";
  var hiddenCallIds = unavailableToolCallIds(msg.parts);
  var types = [];
  msg.parts.forEach(function(p) { if (isPartRenderable(p, role, hiddenCallIds)) types.push(p.type); });
  return types.join(",") + ((msg.model || msg.provider) ? "|meta" : "");
}

export function renderMessages() {
  const area = document.getElementById("agent-msg-area");
  if (!area) return;
  var prevScrollTop = area.scrollTop;

  if (S.messages.length === 0) {
    // 思考先于首条消息产生（如刚发送、重新挂载对账时）：空态下仍需保留「正在思考」指示器，
    // 否则运行中的指示器被抹掉（切走首页再切回时表现为图标消失）。
    // syncWorkingIndicator 会按 isSending 负责创建/移动/移除，这里只需避免重复重建空态外壳。
    if (!area.querySelector(".empty-state")) {
      var indicator = document.getElementById("agent-working-indicator");
      area.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🤖</span><span class="empty-state-text">开始一个新的对话</span></div>';
      if (indicator) area.appendChild(indicator); // innerHTML 会清掉旧指示器，运行中需保留
    }
    syncWorkingIndicator(area);
    updateScrollBottomBtn();
    return;
  }
  if (area.querySelector(".empty-state")) area.innerHTML = "";

  // 移除已不在消息列表中的节点（错误提示、被正式消息替换的临时消息等）
  var keySet = {};
  S.messages.forEach(function(m, i) { keySet[String(m.id || ("idx" + i))] = true; });
  var existing = {};
  Array.prototype.slice.call(area.children).forEach(function(c) {
    if (c.id === "agent-working-indicator") return;
    // 错误/警告/信息提示节点保留（否则 run_complete 后的 refreshMessages 会把刚显示的提示立即清掉）
    if (c.classList && (c.classList.contains("error") || c.classList.contains("warn") || c.classList.contains("info"))) return;
    var mid = c.getAttribute ? c.getAttribute("data-msgid") : null;
    if (mid && keySet[mid] && !existing[mid]) existing[mid] = c;
    else c.remove();
  });

  var pos = 0; // 期望位置游标（顺序未变时节点不移动）
  S.messages.forEach(function(msg, msgIdx) {
    var key = String(msg.id || ("idx" + msgIdx));
    var el = existing[key];
    if (el) delete existing[key]; // 防重复 id 时同一节点被两条消息复用
    var sig = msgSignature(msg);
    if (el && el._admSig === sig) {
      // 内容未变化，原样保留
    } else if (el && updateMessageNode(el, msg)) {
      el._admSig = sig; // 结构未变：已就地更新文本
    } else {
      var fresh = buildMessageNode(msg, key);
      if (!fresh) { if (el) el.remove(); return; } // 无内容消息跳过
      /** @type {any} */ (fresh)._admSig = sig;
      if (el) {
        // 重建时恢复旧节点中已展开的折叠块
        var openKeys = {};
        el.querySelectorAll("details[data-key][open]").forEach(function(d) { openKeys[d.getAttribute("data-key")] = true; });
        fresh.querySelectorAll("details[data-key]").forEach(function(d) { if (openKeys[d.getAttribute("data-key")]) /** @type {HTMLDetailsElement} */ (d).open = true; });
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    var expected = area.children[pos];
    if (expected !== el) area.insertBefore(el, expected || null);
    pos++;
  });

  // 「正在思考」指示器：持久节点，仅按需创建/移动/移除，避免每次重建导致动画闪烁
  syncWorkingIndicator(area);

  // 手动模式：保留用户当前滚动位置；自动模式：滚到底部
  if (S.manualScrollMode) {
    area.scrollTop = prevScrollTop;
  } else {
    area.scrollTop = area.scrollHeight;
  }
  // 流式输出时内容增长不一定触发 scroll 事件，渲染后主动刷新悬浮圆球显隐
  updateScrollBottomBtn();
}

// 「正在思考」指示器同步：运行中确保持久节点存在并置于消息区末尾；结束则移除。
// 独立成函数，供 renderMessages（含空消息分支）与重新挂载对账复用，
// 避免依赖消息列表是否为空而漏建（切到首页再切回时图标消失的根因）。
export function syncWorkingIndicator(area) {
  area = area || document.getElementById("agent-msg-area");
  if (!area) return;
  var indicator = document.getElementById("agent-working-indicator");
  if (S.isSending) {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "msg assistant working-indicator";
      indicator.id = "agent-working-indicator";
      indicator.innerHTML =
        '<span class="working-indicator-dot"></span>' +
        '<span class="working-indicator-text">正在工作' +
          '<span class="working-indicator-dots"><span></span><span></span><span></span>' +
        '</span></span>';
    }
    if (area.lastElementChild !== indicator) area.appendChild(indicator);
  } else if (indicator) {
    indicator.remove();
  }
}

// 构建完整消息节点
function buildMessageNode(msg, key) {
  var role = msg.role || "assistant";
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.setAttribute("data-msgid", key);

  if (msg._streaming && msg.content) {
    // 流式消息（SSE 临时构建的），直接渲染 content
    div.textContent = msg.content;
  } else if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
    renderMessageParts(div, msg.parts, role, key);
  } else if (msg.content) {
    // 兼容旧格式
    div.textContent = msg.content;
  } else {
    return null; // 无内容则跳过
  }

  // 消息元信息
  if (msg.model || msg.provider) {
    var meta = document.createElement("div");
    meta.className = "msg-meta";
    var metaParts = [];
    if (msg.model) metaParts.push(msg.model);
    if (msg.provider) metaParts.push(msg.provider);
    if (msg.created_at) metaParts.push(formatTime(msg.created_at));
    meta.textContent = metaParts.join(" · ");
    div.appendChild(meta);
  }

  /** @type {any} */ (div)._admStruct = msgStructSig(msg, role);
  return div;
}

// 就地更新消息节点（结构未变时只更新文本，保住 <details> 身份使流式期间可点开/收起）
function updateMessageNode(el, msg) {
  var role = msg.role || "assistant";
  var struct = msgStructSig(msg, role);
  if (struct === "plain" || el._admStruct !== struct) return false;
  var partEls = el.querySelectorAll(":scope > [data-pk]");
  var hiddenCallIds = unavailableToolCallIds(msg.parts);
  var pi = 0;
  for (var i = 0; i < msg.parts.length; i++) {
    var part = msg.parts[i];
    if (!isPartRenderable(part, role, hiddenCallIds)) continue;
    var pe = partEls[pi++];
    if (!pe || pe.getAttribute("data-ptype") !== part.type) return false;
    var d = part.data || {};
    switch (part.type) {
      case "text":
        pe.innerHTML = renderMarkdown(d.text || "");
        break;
      case "reasoning":
        if (pe.lastElementChild && pe.lastElementChild.tagName !== "SUMMARY") {
          pe.lastElementChild.textContent = d.thinking || "";
        }
        break;
      case "tool_call":
        var ts = pe.firstElementChild; // summary
        if (ts) ts.textContent = "🔧 " + (d.name || "tool") + (d.finished !== false ? " (已完成)" : " (执行中)");
        var ti = pe.lastElementChild;
        if (ti && ti.tagName !== "SUMMARY") {
          try { ti.textContent = "输入: " + JSON.stringify(JSON.parse(d.input || "{}"), null, 2); }
          catch (_) { ti.textContent = "输入: " + (d.input || ""); }
        }
        break;
      case "tool_result":
        var rs = pe.firstElementChild; // summary
        if (rs) {
          rs.textContent = (d.is_error ? "❌ " : "✅ ") + (d.name || "tool") + " 结果";
          rs.style.color = d.is_error ? "#ff6b6b" : "#43a047";
        }
        var rc = pe.lastElementChild;
        if (rc && rc.tagName !== "SUMMARY") rc.textContent = d.content || d.data || "";
        break;
      case "finish":
        pe.textContent = "── " + (d.reason || "完成") + " ──";
        break;
      case "image_url":
        if (pe.getAttribute("src") !== (d.url || "")) pe.setAttribute("src", d.url || "");
        break;
      case "binary":
        pe.textContent = "📎 附件: " + (d.path || d.Path || "file") + " (" + (d.mime_type || d.MIMEType || "unknown") + ")";
        break;
      default:
        // shell_command / 未知类型：内部结构随数据变化，仅重建该 part 元素（无 details，不影响点击）
        var np = buildPartElement(part, i, role, el.getAttribute("data-msgid"));
        if (!np) return false;
        np.setAttribute("data-pk", String(i));
        np.setAttribute("data-ptype", part.type);
        pe.replaceWith(np);
    }
  }
  return true;
}

// 渲染 ContentPart 数组（msgKey 用于给折叠块生成稳定 data-key，重渲染时恢复展开状态）
function renderMessageParts(container, parts, role, msgKey) {
  var hiddenCallIds = unavailableToolCallIds(parts);
  parts.forEach(function(part, partIdx) {
    if (!isPartRenderable(part, role, hiddenCallIds)) return;
    var el = buildPartElement(part, partIdx, role, msgKey);
    if (!el) return;
    el.setAttribute("data-pk", String(partIdx));
    el.setAttribute("data-ptype", part.type);
    container.appendChild(el);
  });
}

// 构建单个 part 的根元素（供全量渲染与就地更新时局部重建共用）
function buildPartElement(part, partIdx, role, msgKey) {
  var partType = part.type;
  var partData = part.data || {};
  var partKey = (msgKey || "") + ":" + partIdx;

  switch (partType) {
    case "text":
      var textDiv = document.createElement("div");
      textDiv.className = "msg-text";
      // 使用 Markdown 渲染
      textDiv.innerHTML = renderMarkdown(partData.text || "");
      return textDiv;

    case "reasoning":
      var details = document.createElement("details");
      details.className = "msg-reasoning";
      details.setAttribute("data-key", partKey);
      var summary = document.createElement("summary");
      summary.textContent = "💭 推理过程";
      summary.style.cssText = "cursor:pointer;font-size:12px;color:var(--c-text-3);";
      details.appendChild(summary);
      var reasoningContent = document.createElement("div");
      reasoningContent.style.cssText = "padding:8px;color:var(--c-text-3);font-style:italic;font-size:12px;white-space:pre-wrap;";
      reasoningContent.textContent = partData.thinking || "";
      details.appendChild(reasoningContent);
      return details;

    case "tool_call":
      var toolDetails = document.createElement("details");
      toolDetails.className = "msg-tool-call";
      toolDetails.setAttribute("data-key", partKey);
      var toolSummary = document.createElement("summary");
      var finished = partData.finished !== false;
      toolSummary.textContent = "🔧 " + (partData.name || "tool") + (finished ? " (已完成)" : " (执行中)");
      toolSummary.style.cssText = "cursor:pointer;font-size:12px;color:var(--c-text-3);";
      toolDetails.appendChild(toolSummary);
      var toolInput = document.createElement("div");
      toolInput.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:var(--c-text-2);white-space:pre-wrap;background:var(--c-bg-deep);border-radius:4px;margin-top:4px;";
      try {
        toolInput.textContent = "输入: " + JSON.stringify(JSON.parse(partData.input || "{}"), null, 2);
      } catch (_) {
        toolInput.textContent = "输入: " + (partData.input || "");
      }
      toolDetails.appendChild(toolInput);
      return toolDetails;

    case "tool_result":
      var resultDetails = document.createElement("details");
      resultDetails.className = "msg-tool-result";
      resultDetails.setAttribute("data-key", partKey);
      var resultSummary = document.createElement("summary");
      var isError = partData.is_error;
      resultSummary.textContent = (isError ? "❌ " : "✅ ") + (partData.name || "tool") + " 结果";
      resultSummary.style.cssText = "cursor:pointer;font-size:12px;color:" + (isError ? "#ff6b6b" : "#43a047") + ";";
      resultDetails.appendChild(resultSummary);
      var resultContent = document.createElement("div");
      resultContent.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:var(--c-text-2);white-space:pre-wrap;background:var(--c-bg-deep);border-radius:4px;margin-top:4px;max-height:300px;overflow-y:auto;";
      resultContent.textContent = partData.content || partData.data || "";
      resultDetails.appendChild(resultContent);
      return resultDetails;

    case "finish":
      // 用户消息的 finish 已在 isPartRenderable 中过滤
      var finishDiv = document.createElement("div");
      finishDiv.className = "msg-finish";
      finishDiv.style.cssText = "border-top:1px solid var(--c-border);padding-top:4px;margin-top:4px;font-size:11px;color:var(--c-text-4);";
      var reason = partData.reason || "完成";
      finishDiv.textContent = "── " + reason + " ──";
      return finishDiv;

    case "shell_command":
      var shellDiv = document.createElement("div");
      shellDiv.className = "msg-shell-command";
      shellDiv.style.cssText = "font-family:monospace;font-size:11px;background:var(--c-bg-deep);border-radius:4px;padding:8px;margin-top:4px;";
      var cmdDiv = document.createElement("div");
      cmdDiv.style.cssText = "color:var(--c-accent);";
      cmdDiv.textContent = "$ " + (partData.command || "");
      shellDiv.appendChild(cmdDiv);
      if (partData.output) {
        var outDiv = document.createElement("div");
        outDiv.style.cssText = "color:var(--c-text-2);white-space:pre-wrap;margin-top:4px;";
        outDiv.textContent = partData.output;
        shellDiv.appendChild(outDiv);
      }
      if (partData.exit_code !== undefined) {
        var exitDiv = document.createElement("div");
        exitDiv.style.cssText = "color:var(--c-text-4);margin-top:4px;";
        exitDiv.textContent = "退出码: " + partData.exit_code;
        shellDiv.appendChild(exitDiv);
      }
      return shellDiv;

    case "image_url":
      var img = document.createElement("img");
      img.src = partData.url || "";
      img.style.cssText = "max-width:300px;border-radius:8px;margin-top:4px;";
      return img;

    case "binary":
      var binDiv = document.createElement("div");
      binDiv.style.cssText = "font-size:12px;color:var(--c-text-3);padding:4px 0;";
      binDiv.textContent = "📎 附件: " + (partData.path || partData.Path || "file") + " (" + (partData.mime_type || partData.MIMEType || "unknown") + ")";
      return binDiv;

    default:
      // 未知类型，显示原始 JSON
      var unknownDiv = document.createElement("div");
      unknownDiv.style.cssText = "font-size:11px;color:var(--c-text-4);";
      unknownDiv.textContent = JSON.stringify(part);
      return unknownDiv;
  }
}

// ===== Todo 列表渲染 =====
// 固定面板位于消息区与输入区之间：有 todos 时常驻显示进度与清单，无 todos 时隐藏。
// 数据源：selectConversation 的会话详情 + session SSE updated 事件（proto.Session 自带 todos）。
export function renderTodos(todos) {
  if (S.currentConv) {
    S.currentConv.todos = todos || [];
  }
  var panel = document.getElementById("agent-todos-panel");
  var listEl = document.getElementById("agent-todos-list");
  var progressEl = document.getElementById("agent-todos-progress");
  if (!panel || !listEl || !progressEl) return;

  if (!Array.isArray(todos) || todos.length === 0) {
    panel.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  var done = todos.filter(function(t) { return t.status === "completed"; }).length;
  progressEl.textContent = " " + done + "/" + todos.length;
  panel.style.display = "";
  panel.classList.toggle("collapsed", !!S.todosCollapsed);

  listEl.innerHTML = "";
  todos.forEach(function(t) {
    var status = t.status === "completed" || t.status === "in_progress" ? t.status : "pending";
    var icon = status === "completed" ? "✓" : (status === "in_progress" ? "●" : "○");
    // in_progress 优先显示进行时描述（active_form），更直观
    var text = status === "in_progress" && t.active_form ? t.active_form : (t.content || "");
    var item = document.createElement("div");
    item.className = "todo-item " + status;
    item.innerHTML = '<span class="todo-item-icon">' + icon + '</span><span class="todo-item-text"></span>';
    item.querySelector(".todo-item-text").textContent = text;
    listEl.appendChild(item);
  });
}
