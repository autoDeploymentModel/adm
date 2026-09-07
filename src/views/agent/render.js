// 消息渲染（增量 DOM 对齐）与 Todo 列表
import { t as _t } from "../../i18n.js";
import { S, store } from "./store.js";
import { renderMarkdown, formatTime, splitSystemInfo, isFullyAtBottom } from "./utils.js";
import { updateScrollBottomBtn } from "./ui.js";
import { renderMessageOutline } from "./session.js";

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

// 该 part 是否需要渲染（finish 分隔线整体不渲染，工具调用状态已足以表达完成）
// hiddenCallIds: 因工具不可用而应隐藏的 tool_call id 集合（如工具被移除/未注册，
// 服务端返回 "Tool not found: xxx"，对应工具调用与结果成对隐藏避免噪音）
// 对应的 tool_call 与 tool_result 一并不渲染。
function isPartRenderable(part, role, hiddenCallIds) {
  if (!part || !part.type) return false;
  if (part.type === "finish") return false;
  if (hiddenCallIds && hiddenCallIds.size) {
    var d = part.data || {};
    if (part.type === "tool_call" && d.id && hiddenCallIds.has(d.id)) return false;
    if (part.type === "tool_result" && d.tool_call_id && hiddenCallIds.has(d.tool_call_id)) return false;
  }
  return true;
}

// 收集"工具不可用"的 tool_call id：模型尝试调用不存在/被禁用的工具时，
// 服务端回 "Tool not found: xxx" 让模型自我纠正，但这类失败对用户无意义，不展示。
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

// 单个 part 的内容签名（长度/状态足以覆盖流式追加场景）。
// finished_at（仅 reasoning 携带）一并纳入：流式（0）→ 完成（>0）的转换即使 thinking
// 文本长度未变化（推理内容已写完、只补一个时间戳）也要触发该消息的重新渲染，从而
// 走 buildPartElement 的"完成后折叠"逻辑；否则折叠不会发生（早返回短路了）
function partSig(part) {
  var d = (part && part.data) || {};
  return (part.type || "?") + ":" +
    ((d.text || "").length + (d.thinking || "").length + (d.input || "").length +
     String(d.content || d.data || "").length + (d.output || "").length + (d.url || "").length) +
     ":" + (d.finished === false ? "r" : "f") + (d.is_error ? "e" : "") +
     (d.finished_at ? ":" + d.finished_at : "") +
     ":" + (d.name || "") + (d.reason || "") + (d.exit_code !== undefined ? d.exit_code : "") + (d.path || "");
}

// 消息内容签名：变化才触发该消息节点的更新
function msgSignature(msg) {
  if (msg._streaming || !msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0) {
    return "c:" + (msg.content || "").length + ":" + (msg.model || "") + (msg.provider || "");
  }
  return "p:" + msg.parts.map(partSig).join(";") + "|" + (msg.model || "") + (msg.provider || "") + (msg.created_at || "");
}

// 消息结构签名：part 类型序列 + 是否有元信息，结构一致才允许就地更新。
// 已合并进对应 tool_call 的 tool_result 不计入（结果可能在后续消息里，
// 若计为结构变化会导致到达时误触发全量重建）
function msgStructSig(msg, role, callResultMap) {
  if (msg._streaming || !msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0) return "plain";
  var hiddenCallIds = unavailableToolCallIds(msg.parts);
  var map = callResultMap || {};
  var types = [];
  msg.parts.forEach(function(p) {
    if (isPartRenderable(p, role, hiddenCallIds) &&
        !(p.type === "tool_result" && p.data && map[String(p.data.tool_call_id)] !== undefined)) types.push(p.type);
  });
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
      area.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🤖</span><span class="empty-state-text">' + _t("开始一个新的对话") + '</span></div>';
      if (indicator) area.appendChild(indicator); // innerHTML 会清掉旧指示器，运行中需保留
    }
    syncWorkingIndicator(area, null);
    updateScrollBottomBtn();
    // 消息清空（如切到新会话尚未加载）→ 同步刷新右侧大纲为空态
    renderMessageOutline();
    // 消息列表变化通知（空消息场景也要派发，否则手动压缩按钮无法根据 hasContent=0 切到禁用态）
    document.dispatchEvent(new CustomEvent("agent-messages-changed"));
    return;
  }
  if (area.querySelector(".empty-state")) area.innerHTML = "";

  // 会话切换时重置“保持展开”标记：回到某会话按历史处理（全部折叠）
  if (lastOpenRoundConv !== S.currentConvId) {
    lastOpenRoundConv = S.currentConvId;
    lastOpenRoundKey = "";
  }

  // 把消息按"轮"切片：每条 user 消息作为一轮起点，到下一条 user 之前为止；
  // 首条 user 之前的非 user 消息（本地错误气泡等）归入 roundKey="r:preamble" 的前导轮
  var rounds = groupMessagesByRound(S.messages);

  // 收集已有的轮节点；提示节点保留（不被本函数管理）
  var existingRounds = {};
  Array.prototype.slice.call(area.children).forEach(function(c) {
    if (c.id === "agent-working-indicator") return;
    // 错误/警告/信息提示节点保留（否则 run_complete 后的 refreshMessages 会把刚显示的提示立即清掉）；
    // 本地常驻错误气泡（data-adm-local-error）除外——它随消息列表管理，不在列表时即移除
    if (c.classList && (c.classList.contains("warn") || c.classList.contains("info") ||
        (c.classList.contains("error") && !c.hasAttribute("data-adm-local-error")))) return;
    if (c.classList && c.classList.contains("msg-round")) {
      var rk = c.getAttribute("data-roundkey");
      if (rk) existingRounds[rk] = c;
      else c.remove();
      return;
    }
    // 旧的扁平 .msg 节点（升级前残留）→ 移除，由新轮节点接管
    c.remove();
  });

  // 轮级对齐 + 轮内消息级对齐
  var pos = 0;
  rounds.forEach(function(round, roundIdx) {
    var el = existingRounds[round.roundKey];
    if (el) delete existingRounds[round.roundKey];
    if (!el) el = buildRoundNode(round);
    applyRoundState(el, round, roundIdx === rounds.length - 1);
    alignMessagesInContainer(getRoundBody(el), round.items);
    var expected = area.children[pos];
    if (expected !== el) area.insertBefore(el, expected || null);
    pos++;
  });

  // 移除已不在消息列表中的轮节点
  Object.keys(existingRounds).forEach(function(k) {
    existingRounds[k].remove();
  });

  // 「正在思考」指示器挂到末轮（运行中的轮）
  var lastRoundEl = null;
  if (area.lastElementChild && area.lastElementChild.classList && area.lastElementChild.classList.contains("msg-round")) {
    lastRoundEl = area.lastElementChild;
  }
  syncWorkingIndicator(area, lastRoundEl);

  // 手动模式：保留用户当前滚动位置；自动模式：滚到底部（area + 所有展开的轮）
  if (S.manualScrollMode) {
    S.programmaticScroll = true;
    S.lastProgrammaticScroll = Date.now();
    area.scrollTop = prevScrollTop;
    S.programmaticScroll = false;
  } else {
    scrollChatToBottom(area);
  }
  // 流式输出时内容增长不一定触发 scroll 事件，渲染后主动刷新悬浮圆球显隐
  updateScrollBottomBtn();
  // 同步刷新右侧「对话记录」大纲面板（SSE 流式期间 message 增量会持续触发）
  renderMessageOutline();
  // 消息列表变化通知（如手动压缩按钮：消息数影响按钮启用条件）
  document.dispatchEvent(new CustomEvent("agent-messages-changed"));
}

// 滚轮向上是用户浏览意图的直接信号，立即进入手动模式。
// 不能只靠 scroll 事件判定：浏览器每帧最多合并派发一次 scroll 事件，流式渲染
// 会在同帧内把 scrollTop 重新钉回底部，用户滚轮产生的中间位置被覆盖，
// 事件到达时已看不出用户滚动过（thinking 高速输出时滚轮「失灵」的另一半根因）。
// wheel 事件冒泡：轮内滚动会冒泡到 area，因此单挂在 area 上即可覆盖。
//
// 滚动判定对象：area + 所有展开的轮（每轮自身也 overflow-y:auto，是独立滚动容器）。
// 只看 area 会被「轮内向上滑」欺骗，导致圆球不显示、自动跟随误判。
// 用 isFullyAtBottom 综合判定并刷新「回到底部」圆球。

// area 滚动事件统一处理：复用于 area 自身的 scroll 与每个轮容器的 scroll。
// 关键：scroll 不冒泡，area 上的 scroll 监听无法捕获轮内滚动；故每个 .msg-round
// 各自挂一份，传当前滚动的元素（用于 programmaticScroll/时间窗判定）。滚到底部
// → 自动模式；离开底部 → 手动模式。
export function onAreaScroll(scroller) {
  var area = /** @type {HTMLElement} */ (scroller.closest(".msg-area") || scroller);
  if (S.programmaticScroll) { updateScrollBottomBtn(); return; }
  if (Date.now() - S.lastProgrammaticScroll < 100 && isFullyAtBottom(area)) {
    updateScrollBottomBtn(); return;
  }
  if (isFullyAtBottom(area)) S.manualScrollMode = false;
  else S.manualScrollMode = true;
  updateScrollBottomBtn();
}

// 把对话区域真正滚到底：area 滚到底，且所有展开的轮容器也滚到底。
// 用于「回到底部」圆球点击 + 自动跟随推流。
export function scrollChatToBottom(area) {
  if (!area) return;
  S.programmaticScroll = true;
  S.lastProgrammaticScroll = Date.now();
  area.scrollTop = area.scrollHeight;
  // 展开的轮（特别是流式推送中的活跃轮）也要滚到底，否则 area 滚到底
  // 看不到轮内新增内容
  var rounds = area.querySelectorAll(".msg-round:not(.msg-round-collapsed)");
  for (var i = 0; i < rounds.length; i++) rounds[i].scrollTop = rounds[i].scrollHeight;
  S.programmaticScroll = false;
  updateScrollBottomBtn();
}

// 「正在思考」指示器同步：运行中确保持久节点存在并置于当前活跃轮（末轮）末尾；结束则移除。
// area 用于空消息兜底；lastRoundEl 为当前活跃轮（运行中的轮），指示器挂到这里。
// 独立成函数，供 renderMessages（含空消息分支）与重新挂载对账复用，
// 避免依赖消息列表是否为空而漏建（切到首页再切回时图标消失的根因）。
export function syncWorkingIndicator(area, lastRoundEl) {
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
        '<span class="working-indicator-text">' + _t("正在工作") +
          '<span class="working-indicator-dots"><span></span><span></span><span></span>' +
        '</span></span>';
    }
    // 排队中（本会话消息已入队、尚未开始执行）时文案改为「排队中」，避免误读为正在产出
    if (S.queuedRun && S.queuedRun.sessionId === S.currentConvId) {
      var textEl = indicator.querySelector(".working-indicator-text");
      if (textEl && textEl.firstChild && textEl.firstChild.nodeValue !== _t("排队中")) {
        textEl.firstChild.nodeValue = _t("排队中");
      }
    } else {
      var textEl2 = indicator.querySelector(".working-indicator-text");
      if (textEl2 && textEl2.firstChild && textEl2.firstChild.nodeValue !== _t("正在工作")) {
        textEl2.firstChild.nodeValue = _t("正在工作");
      }
    }
    // 挂到末轮的 body（消息挂载点）；无轮时退化到 area（空消息分支已设兜底）
    var parent = (lastRoundEl ? getRoundBody(lastRoundEl) : area) || area;
    if (parent.lastElementChild !== indicator) parent.appendChild(indicator);
  } else if (indicator) {
    indicator.remove();
  }
}

// 构建轮级 tool_call id → tool_result part 映射：工具结果通常在下一条 assistant 消息里
// （消息 A: [tool_call, finish(tool_use)]；消息 B: [tool_result, finish(end_turn)]），
// 因此配对范围是整个轮（所有消息的 parts），而不是单条消息。
// 仅收录“本轮存在对应 tool_call”的结果——孤儿 tool_result（找不到调用方）不入映射，
// 仍按独立块渲染兜底。
function buildCallResultMap(items) {
  var map = {};
  var callIds = {};
  if (!Array.isArray(items)) return map;
  for (var i = 0; i < items.length; i++) {
    var m = items[i];
    if (!m || !Array.isArray(m.parts)) continue;
    for (var j = 0; j < m.parts.length; j++) {
      var p = m.parts[j];
      if (p && p.type === "tool_call" && p.data && p.data.id) callIds[String(p.data.id)] = true;
    }
  }
  for (var i2 = 0; i2 < items.length; i2++) {
    var m2 = items[i2];
    if (!m2 || !Array.isArray(m2.parts)) continue;
    for (var j2 = 0; j2 < m2.parts.length; j2++) {
      var p2 = m2.parts[j2];
      if (p2 && p2.type === "tool_result" && p2.data && p2.data.tool_call_id && callIds[String(p2.data.tool_call_id)]) {
        map[String(p2.data.tool_call_id)] = p2;
      }
    }
  }
  return map;
}

// 构建合并进 tool_call 折叠块的结果内容区（供全量渲染与就地更新共用）
function buildToolResultSection(d) {
  var div = document.createElement("div");
  div.className = "msg-tool-result-content";
  div.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:var(--c-text-2);white-space:pre-wrap;background:var(--c-bg-deep);border-radius:4px;margin-top:4px;max-height:300px;overflow-y:auto;" + (d.is_error ? "color:#ff6b6b;" : "");
  div.textContent = d.content || d.data || "";
  return div;
}

// 按 user 消息把消息列表切成"轮"。每条 user 消息作为一轮起点；
// 首条 user 之前的非 user 消息（本地常驻错误气泡等）归入 r:preamble 前导轮；
// 空消息列表返回空数组（调用方负责显示空态）。
function groupMessagesByRound(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  var rounds = [];
  var current = null;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m && m.role === "user") {
      if (current) rounds.push(current);
      var uid = m.id != null ? String(m.id) : ("u" + i);
      current = { roundKey: "r:" + uid, firstUserMsg: m, items: [m] };
    } else {
      if (!current) {
        current = { roundKey: "r:preamble", firstUserMsg: null, items: [] };
      }
      current.items.push(m);
    }
  }
  if (current) rounds.push(current);
  return rounds;
}

// 构建一个空的轮容器：header（标题条，点击切换展开/折叠）+ body（消息挂载点）。
// 展开/折叠状态由 applyRoundState 每次 render 重算：用户手动 toggle 过（_admRoundOpen）
// 则采用用户选择，否则默认“运行中的轮展开、已结束的轮折叠”。
function buildRoundNode(round) {
  var div = document.createElement("div");
  div.className = "msg-round";
  div.setAttribute("data-roundkey", round.roundKey);
  if (round.firstUserMsg && round.firstUserMsg.id != null) {
    div.setAttribute("data-user-msgid", String(round.firstUserMsg.id));
  }
  var header = document.createElement("div");
  header.className = "msg-round-header";
  var chevron = document.createElement("span");
  chevron.className = "msg-round-chevron";
  chevron.textContent = "▸";
  var title = document.createElement("span");
  title.className = "msg-round-title";
  header.appendChild(chevron);
  header.appendChild(title);
  var body = document.createElement("div");
  body.className = "msg-round-body";
  header.addEventListener("click", function() {
    // 当前折叠 → 点击后展开；当前展开 → 点击后折叠。
    // 之前把“当前状态”误存为偏好并按当前状态 toggle，导致点击无效（状态原样保持）
    var willOpen = div.classList.contains("msg-round-collapsed");
    var ref = /** @type {any} */ (div);
    ref._admRoundOpen = willOpen;
    div.classList.toggle("msg-round-collapsed", !willOpen);
  });
  // 容器内空白区域右键 → 折叠当前轮：仅命中轮容器/body 自身的空白（padding、消息间隙），
  // 右键消息气泡、header 等子元素不触发；已折叠则放行默认菜单
  div.addEventListener("contextmenu", function(e) {
    var t = e.target;
    if (t !== div && t !== body) return;
    if (div.classList.contains("msg-round-collapsed")) return;
    e.preventDefault();
    /** @type {any} */ (div)._admRoundOpen = false;
    div.classList.add("msg-round-collapsed");
  });
  // 轮内独立滚动：scroll 事件不冒泡，必须在轮本身挂监听才能识别轮内向上滑动
  // （wheel 事件会冒泡到 area，所以手动模式的进入已经在 area 的 wheel 监听里覆盖；
  // 这里只负责刷新圆球显隐 + 双向判顶/判底以纠正手动模式状态）
  div.addEventListener("scroll", function() { onAreaScroll(div); }, { passive: true });
  div.appendChild(header);
  div.appendChild(body);
  return div;
}

// 取轮容器内的消息挂载点（.msg-round-body）；容错旧结构（无 body 时返回自身）
function getRoundBody(roundEl) {
  var body = roundEl.querySelector(":scope > .msg-round-body");
  return body || roundEl;
}

// 提取轮标题文本：来自本轮首条 user 消息（content 或首个非空 text part），
// 去掉 <system_info> 附件引导块，压缩空白；无 user 消息的前导轮回退为「系统消息」
function roundTitleText(round) {
  var m = round.firstUserMsg;
  var text = "";
  if (m) {
    if (typeof m.content === "string" && m.content) text = m.content;
    else if (Array.isArray(m.parts)) {
      for (var i = 0; i < m.parts.length; i++) {
        var p = m.parts[i];
        if (p && p.type === "text" && p.data && p.data.text) { text = p.data.text; break; }
      }
    }
    var info = splitSystemInfo(text);
    if (info) text = info.text || "";
  }
  text = String(text).replace(/\s+/g, " ").trim();
  return text || (m ? "" : _t("系统消息"));
}

// 展开/折叠的“保持展开”标记：运行中把末轮 key 记入 lastOpenRoundKey；
// run 完成后 activeRun 消失，但 key 仍在 → 末轮保持展开；下一轮开始时 key
// 被更新为新轮 → 旧轮折叠。会话切换时重置（历史按默认全部折叠）。
var lastOpenRoundKey = "";
var lastOpenRoundConv = "";

// 应用轮的展开/折叠状态与标题文案。
// 默认规则：roundKey 等于 lastOpenRoundKey（最近活跃过的末轮）才展开，其余折叠；
// 用户手动 toggle 过（_admRoundOpen）则优先。
function applyRoundState(el, round, isLastRound) {
  var active = isLastRound &&
    ((S.activeRun && S.activeRun.sessionId === S.currentConvId) ||
     (S.queuedRun && S.queuedRun.sessionId === S.currentConvId));
  if (active) lastOpenRoundKey = round.roundKey;
  var ref = /** @type {any} */ (el);
  var open = (ref._admRoundOpen !== undefined) ? ref._admRoundOpen : (round.roundKey === lastOpenRoundKey);
  el.classList.toggle("msg-round-collapsed", !open);
  var header = el.querySelector(":scope > .msg-round-header");
  var titleEl = header ? header.querySelector(".msg-round-title") : null;
  if (titleEl) {
    var t = roundTitleText(round);
    if (titleEl.textContent !== t) titleEl.textContent = t;
  }
}

// 在指定容器（轮节点）内做消息级增量对齐：
// 按 data-msgid 复用旧节点；sig 变化就更新/重建；结构未变就地更新文本；
// 不在 messages 中的节点移除（本地错误气泡随消息列表生命周期管理）。
function alignMessagesInContainer(container, items) {
  // 轮级 tool_call → tool_result 映射（结果可能在下一条 assistant 消息里），
  // 供合并渲染与就位同步使用
  var callResultMap = buildCallResultMap(items);
  var keySet = {};
  items.forEach(function(m, i) { keySet[String(m.id || ("idx" + i))] = true; });

  var existing = {};
  Array.prototype.slice.call(container.children).forEach(function(c) {
    // 「正在思考」指示器由 syncWorkingIndicator 管理，此处必须跳过，
    // 否则流式期间每次渲染都重建导致动画闪烁
    if (c.id === "agent-working-indicator") return;
    if (c.classList && (c.classList.contains("warn") || c.classList.contains("info") ||
        (c.classList.contains("error") && !c.hasAttribute("data-adm-local-error")))) return;
    var mid = c.getAttribute ? c.getAttribute("data-msgid") : null;
    if (mid && keySet[mid] && !existing[mid]) existing[mid] = c;
    else c.remove();
  });

  var pos = 0;
  items.forEach(function(msg, msgIdx) {
    var key = String(msg.id || ("idx" + msgIdx));
    var el = existing[key];
    if (el) delete existing[key]; // 防重复 id 时同一节点被重用
    var sig = msgSignature(msg);
    if (el && el._admSig === sig) {
      // 内容未变化，原样保留
    } else if (el && updateMessageNode(el, msg, callResultMap)) {
      el._admSig = sig; // 结构未变：已就地更新文本
    } else {
      var fresh = buildMessageNode(msg, key, callResultMap);
      if (!fresh) { if (el) el.remove(); return; } // 无内容消息跳过
      /** @type {any} */ (fresh)._admSig = sig;
      if (el) {
        // 重建时恢复旧节点中已展开的折叠块（msg-reasoning 由自身 _admDetailsState + toggle
        // 监听在 msg 级别维护，此处跳过，避免"流式展开 → 完成后又被强制展开"）
        var openKeys = {};
        el.querySelectorAll("details[data-key][open]").forEach(function(d) {
          if (!d.classList.contains("msg-reasoning")) {
            openKeys[d.getAttribute("data-key")] = true;
          }
        });
        // 移交用户手动 toggle 状态，并按其同步 reasoning 的 open（否则新元素上状态丢失，退回默认值）
        /** @type {any} */ (fresh)._admDetailsState = /** @type {any} */ (el)._admDetailsState;
        if (/** @type {any} */ (el)._admDetailsState) {
          fresh.querySelectorAll("details.msg-reasoning[data-key]").forEach(function(d) {
            var us = /** @type {any} */ (el)._admDetailsState[d.getAttribute("data-key")];
            if (us !== undefined) /** @type {HTMLDetailsElement} */ (d).open = us;
          });
        }
        fresh.querySelectorAll("details[data-key]").forEach(function(d) { if (openKeys[d.getAttribute("data-key")]) /** @type {HTMLDetailsElement} */ (d).open = true; });
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    var expected = container.children[pos];
    if (expected !== el) container.insertBefore(el, expected || null);
    pos++;
  });

  // 跨消息合并同步：结果在后续消息到达时，其 tool_call 所在消息可能 sig 未变被跳过，
  // 此处统一把结果区补进/更新/移除对应的 tool_call 折叠块（含出错摘要标红）
  container.querySelectorAll("details.msg-tool-call[data-call-id]").forEach(function(det) {
    var rp = callResultMap[det.getAttribute("data-call-id")] || null;
    var sec = det.querySelector(":scope > .msg-tool-result-content");
    var summary = det.firstElementChild;
    if (rp && rp.data) {
      var rTxt = rp.data.content || rp.data.data || "";
      if (!sec) det.appendChild(buildToolResultSection(rp.data));
      else if (sec.textContent !== rTxt) sec.textContent = rTxt;
      if (summary && rp.data.is_error) summary.style.color = "#ff6b6b";
    } else {
      if (sec) sec.remove();
      if (summary && summary.style && summary.style.color === "rgb(255, 107, 107)") summary.style.color = "";
    }
  });
}

// 消息级“仍在思考”判定（对齐 Go 端 proto/message.go:318 的 IsThinking 语义）：
// 还在思考 = 有 thinking 内容、还没有非空正文、且消息还没有 finish part。
// 注意：不能用 reasoning part 自身的 finished_at 判定 —— FinishThinking() 只在错误
// 清理路径（agent.go:1115）被调用，正常流式路径 AppendReasoningContent 从不设置它，
// 所以历史消息的 reasoning part 永远没有 finished_at 字段，按 part 级判定会把历史误判为流式中。
function msgThinkingOpen(parts) {
  if (!Array.isArray(parts)) return false;
  var hasThinking = false, hasText = false, hasFinish = false;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p || !p.type) continue;
    if (p.type === "reasoning") hasThinking = true;
    else if (p.type === "text" && ((p.data && (p.data.text || "")) || "") !== "") hasText = true;
    else if (p.type === "finish") hasFinish = true;
  }
  return hasThinking && !hasText && !hasFinish;
}

// 构建完整消息节点
function buildMessageNode(msg, key, callResultMap) {
  var role = msg.role || "assistant";
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.setAttribute("data-msgid", key);

  if (msg._streaming && msg.content) {
    // 流式消息（SSE 临时构建的），直接渲染 content
    div.textContent = msg.content;
  } else if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
    renderMessageParts(div, msg.parts, role, key, div, callResultMap);
  } else if (msg.content) {
    // 兼容旧格式
    div.textContent = msg.content;
  } else {
    return null; // 无内容则跳过
  }

  // 所有 part 均不可渲染（如仅 finish 标记的结束消息）→ 不渲染空消息节点
  if (div.childNodes.length === 0) return null;

  // 折叠插入的消息：本地临时气泡在真正插入当前轮之前标注「插入中」，便于用户确认已发出
  if (msg._fold) {
    var foldBadge = document.createElement("span");
    foldBadge.className = "msg-fold-badge";
    foldBadge.textContent = _t("插入中");
    div.appendChild(foldBadge);
  }

  // 本地常驻错误气泡（不落库、不进 LLM 上下文）：加标记与弹窗提示节点区分，
  // 供 renderMessages 按消息列表生命周期管理（切会话/刷新时随列表移除）
  if (msg._error) div.setAttribute("data-adm-local-error", "1");

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

  /** @type {any} */ (div)._admStruct = msgStructSig(msg, role, callResultMap);
  return div;
}

// 就地更新消息节点（结构未变时只更新文本，保住 <details> 身份使流式期间可点开/收起）
function updateMessageNode(el, msg, callResultMap) {
  var role = msg.role || "assistant";
  var struct = msgStructSig(msg, role, callResultMap);
  if (struct === "plain" || el._admStruct !== struct) return false;
  var partEls = el.querySelectorAll(":scope > [data-pk]");
  var hiddenCallIds = unavailableToolCallIds(msg.parts);
  var map = callResultMap || {};
  var pi = 0;
  for (var i = 0; i < msg.parts.length; i++) {
    var part = msg.parts[i];
    if (!isPartRenderable(part, role, hiddenCallIds)) continue;
    // 已合并进对应 tool_call 块（结果在本轮任意消息中配到对）→ 无独立元素
    if (part.type === "tool_result" && part.data && map[String(part.data.tool_call_id)] !== undefined) continue;
    var pe = partEls[pi++];
    if (!pe || pe.getAttribute("data-ptype") !== part.type) return false;
    var d = part.data || {};
    switch (part.type) {
      case "text":
        if (role === "user" && splitSystemInfo(d.text || "")) {
          // 含 <system_info> 引导块：结构特殊（正文 + 折叠附件信息），整体重建该 part；
          // 重建前记录已展开的折叠块并在重建后恢复
          var wasOpen = pe.querySelector("details[data-key][open]");
          var np = buildPartElement(part, i, role, el.getAttribute("data-msgid"), el, msgThinkingOpen(msg.parts));
          if (!np) return false;
          np.setAttribute("data-pk", String(i));
          np.setAttribute("data-ptype", part.type);
          pe.replaceWith(np);
          if (wasOpen) {
            var nd = np.querySelector("details[data-key]");
            if (nd) /** @type {HTMLDetailsElement} */ (nd).open = true;
          }
          break;
        }
        pe.innerHTML = renderMarkdown(d.text || "");
        break;
      case "reasoning":
        if (pe.lastElementChild && pe.lastElementChild.tagName !== "SUMMARY") {
          pe.lastElementChild.textContent = d.thinking || "";
        }
        // 结构未变的就地更新不会触发全量重建，思考状态转换时在此同步折叠/展开；
        // 用户已有手动选择（msg 级状态表）则不覆盖
        var rKey = el.getAttribute("data-msgid") + ":" + i;
        var rState = el._admDetailsState ? el._admDetailsState[rKey] : undefined;
        if (rState === undefined) pe.open = msgThinkingOpen(msg.parts);
        break;
      case "tool_call":
        var ts = pe.firstElementChild; // summary
        if (ts) {
          ts.textContent = "🔧 " + (d.name || "tool") + (d.finished !== false ? _t(" (已完成)") : _t(" (执行中)"));
          var rp = map[String(d.id)] || null;
          if (rp && rp.data && rp.data.is_error) ts.style.color = "#ff6b6b";
        }
        // 输入区按 class 查找（后面可能还有合并的结果区，不能用 lastElementChild）
        var ti = pe.querySelector(":scope > .msg-tool-input");
        if (ti) {
          try { ti.textContent = _t("输入: ") + JSON.stringify(JSON.parse(d.input || "{}"), null, 2); }
          catch (_) { ti.textContent = _t("输入: ") + (d.input || ""); }
        }
        // 同步合并的结果区：到达则创建/更新，消失则移除
        var sec = pe.querySelector(":scope > .msg-tool-result-content");
        if (rp && rp.data) {
          var rTxt = rp.data.content || rp.data.data || "";
          if (!sec) {
            pe.appendChild(buildToolResultSection(rp.data));
          } else if (sec.textContent !== rTxt) {
            sec.textContent = rTxt;
          }
        } else if (sec) {
          sec.remove();
        }
        break;
      case "tool_result":
        var rs = pe.firstElementChild; // summary
        if (rs) {
          rs.textContent = (d.is_error ? "❌ " : "✅ ") + (d.name || "tool") + " " + _t("结果");
          rs.style.color = d.is_error ? "#ff6b6b" : "#43a047";
        }
        var rc = pe.lastElementChild;
        if (rc && rc.tagName !== "SUMMARY") rc.textContent = d.content || d.data || "";
        break;
      case "finish":
        pe.textContent = "── " + (d.reason || _t("完成")) + " ──";
        break;
      case "image_url":
        if (pe.getAttribute("src") !== (d.url || "")) pe.setAttribute("src", d.url || "");
        break;
      case "binary":
        pe.textContent = "📎 " + _t("附件: ") + (d.path || d.Path || "file") + " (" + (d.mime_type || d.MIMEType || "unknown") + ")";
        break;
      default:
        // shell_command / 未知类型：内部结构随数据变化，仅重建该 part 元素（无 details，不影响点击）
        var np = buildPartElement(part, i, role, el.getAttribute("data-msgid"), el, msgThinkingOpen(msg.parts));
        if (!np) return false;
        np.setAttribute("data-pk", String(i));
        np.setAttribute("data-ptype", part.type);
        pe.replaceWith(np);
    }
  }
  return true;
}

// 渲染 ContentPart 数组（msgKey 用于给折叠块生成稳定 data-key，重渲染时恢复展开状态；
// msgEl 用于 reasoning 部分在 msg 级别持久化用户手动折叠状态，跨重建保留）
function renderMessageParts(container, parts, role, msgKey, msgEl, callResultMap) {
  var hiddenCallIds = unavailableToolCallIds(parts);
  var thinkingOpen = msgThinkingOpen(parts);
  var map = callResultMap || {};
  parts.forEach(function(part, partIdx) {
    if (!isPartRenderable(part, role, hiddenCallIds)) return;
    // 已合并进对应 tool_call 块（结果在本轮任意消息中配到对）→ 不单独渲染
    if (part.type === "tool_result" && part.data && map[String(part.data.tool_call_id)] !== undefined) return;
    var resultPart = null;
    if (part.type === "tool_call" && part.data && part.data.id) {
      resultPart = map[String(part.data.id)] || null;
    }
    var el = buildPartElement(part, partIdx, role, msgKey, msgEl, thinkingOpen, resultPart);
    if (!el) return;
    el.setAttribute("data-pk", String(partIdx));
    el.setAttribute("data-ptype", part.type);
    container.appendChild(el);
  });
}

// 用户消息中的 <system_info> 附件引导块 → 可折叠附件信息块（默认收起，展开可见完整引导文本）
function buildSystemInfoEl(info, partKey) {
  var details = document.createElement("details");
  details.className = "msg-attach-info";
  details.setAttribute("data-key", partKey);
  var summary = document.createElement("summary");
  summary.textContent = "📎 " + _t("附件: ") + (info.names.length > 0 ? info.names.join(", ") : "?");
  summary.style.cssText = "cursor:pointer;font-size:12px;color:var(--c-text-3);";
  details.appendChild(summary);
  var body = document.createElement("div");
  body.style.cssText = "padding:8px;font-size:12px;color:var(--c-text-2);white-space:pre-wrap;background:var(--c-bg-deep);border-radius:4px;margin-top:4px;";
  body.textContent = info.hints.join("\n");
  details.appendChild(body);
  return details;
}

// 构建单个 part 的根元素（供全量渲染与就地更新时局部重建共用）
// msgEl 仅 reasoning 使用：在 msg 元素上挂 _admDetailsState[partKey] 保存用户手动 toggle 的选择，
// 流式期间频繁重建时也能保留用户偏好（不展开 / 不折叠）
function buildPartElement(part, partIdx, role, msgKey, msgEl, thinkingOpen, resultPart) {
  var partType = part.type;
  var partData = part.data || {};
  var partKey = (msgKey || "") + ":" + partIdx;

  switch (partType) {
    case "text":
      var textDiv = document.createElement("div");
      textDiv.className = "msg-text";
      if (role === "user") {
        // 服务端在用户消息末尾注入 <system_info> 附件读取引导：不直接展示原始标签文本，
        // 折叠为「📎 附件: 文件名」的可展开块（展开可见完整引导，便于核对附件处理方式）。
        var info = splitSystemInfo(partData.text || "");
        if (info) {
          var mdDiv = document.createElement("div");
          mdDiv.innerHTML = renderMarkdown(info.text || "");
          textDiv.appendChild(mdDiv);
          textDiv.appendChild(buildSystemInfoEl(info, partKey + ":sys"));
          return textDiv;
        }
      }
      // 使用 Markdown 渲染
      textDiv.innerHTML = renderMarkdown(partData.text || "");
      return textDiv;

    case "reasoning":
      var details = document.createElement("details");
      details.className = "msg-reasoning";
      details.setAttribute("data-key", partKey);
      // 默认：仅当消息处于“纯思考中”状态（无正文、无 finish part）才展开，
      // 其余（思考结束开始写正文 / 已完成 / 历史）折叠；用户手动 toggle 过则采用用户选择
      var userState = msgEl && msgEl._admDetailsState ? msgEl._admDetailsState[partKey] : undefined;
      details.open = (userState !== undefined) ? userState : thinkingOpen;
      (function(d, key, mEl) {
        d.addEventListener("toggle", function() {
          if (!mEl) return;
          if (!mEl._admDetailsState) mEl._admDetailsState = {};
          mEl._admDetailsState[key] = d.open;
        });
      })(details, partKey, msgEl);
      var summary = document.createElement("summary");
      summary.textContent = "💭 " + _t("推理过程");
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
      if (partData.id) toolDetails.setAttribute("data-call-id", String(partData.id)); // 跨消息配对合并结果用
      var toolSummary = document.createElement("summary");
      var finished = partData.finished !== false;
      toolSummary.textContent = "🔧 " + (partData.name || "tool") + (finished ? _t(" (已完成)") : _t(" (执行中)"));
      toolSummary.style.cssText = "cursor:pointer;font-size:12px;color:var(--c-text-3);";
      // 结果已合并：出错时摘要标红提示，展开即见红色错误输出
      if (resultPart && resultPart.data && resultPart.data.is_error) toolSummary.style.color = "#ff6b6b";
      toolDetails.appendChild(toolSummary);
      var toolInput = document.createElement("div");
      toolInput.className = "msg-tool-input";
      toolInput.style.cssText = "padding:8px;font-family:monospace;font-size:11px;color:var(--c-text-2);white-space:pre-wrap;background:var(--c-bg-deep);border-radius:4px;margin-top:4px;";
      try {
        toolInput.textContent = _t("输入: ") + JSON.stringify(JSON.parse(partData.input || "{}"), null, 2);
      } catch (_) {
        toolInput.textContent = _t("输入: ") + (partData.input || "");
      }
      toolDetails.appendChild(toolInput);
      // 结果合并展示在对应 tool_call 块内（不再单独渲染 tool_result 折叠块）
      if (resultPart && resultPart.data) {
        toolDetails.appendChild(buildToolResultSection(resultPart.data));
      }
      return toolDetails;

    case "tool_result":
      var resultDetails = document.createElement("details");
      resultDetails.className = "msg-tool-result";
      resultDetails.setAttribute("data-key", partKey);
      var resultSummary = document.createElement("summary");
      var isError = partData.is_error;
      resultSummary.textContent = (isError ? "❌ " : "✅ ") + (partData.name || "tool") + " " + _t("结果");
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
      var reasonMap = {
        end_turn: "本轮执行完成",
        max_tokens: "达到 Token 上限",
        tool_use: "工具调用",
        canceled: "已取消",
        error: "执行出错",
        unknown: "未知状态"
      };
      var reasonKey = reasonMap[partData.reason] || "本轮执行完成";
      finishDiv.textContent = "── " + _t(reasonKey) + " ──";
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
        exitDiv.textContent = _t("退出码: ") + partData.exit_code;
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
      binDiv.textContent = "📎 " + _t("附件: ") + (partData.path || partData.Path || "file") + " (" + (partData.mime_type || partData.MIMEType || "unknown") + ")";
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
    store.setCurrentConv(store.activeWsId, Object.assign({}, S.currentConv, { todos: todos || [] }));
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
