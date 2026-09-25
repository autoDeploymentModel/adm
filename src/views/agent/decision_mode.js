import { t as _t } from "../../i18n.js";
import { S } from "./store.js";

var STORAGE_KEY = "adm_agent_decision_modes_v1";
var memoryModes = null;
var REQUEST_RE = /<adm_decision_request>\s*([\s\S]*?)\s*<\/adm_decision_request>/i;
var RESULT_RE = /<adm_decision_result>\s*([\s\S]*?)\s*<\/adm_decision_result>/i;
var CONTRACT_RE = /(?:<adm_decision_contract>\s*)?\[ADM Decision Output Contract\][\s\S]*?(?:<\/adm_decision_contract>|(?=\n<system_info>)|$)/i;
// label 与模板下拉项文案保持一致（同一功能两处显示同一名称，便于 _t 复用）
var MODES = {
  text: { label: "普通对话", requestMode: null },
  auto: { label: "决策·自动判断", requestMode: "auto" },
  choice: { label: "决策·选项选择", requestMode: "choice" },
  bool: { label: "决策·布尔判断", requestMode: "bool" },
  score: { label: "决策·评分", requestMode: "score" },
};

function loadModes() {
  if (memoryModes) return memoryModes;
  try {
    var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    memoryModes = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    memoryModes = {};
  }
  return memoryModes;
}

function saveModes(modes) {
  memoryModes = modes;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
  } catch (e) {
    console.warn("[agent] 决策模式持久化失败，已使用内存态:", e);
  }
}

function normalizeMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, mode) ? mode : "text";
}

export function getDecisionMode(workspaceId, sessionId) {
  if (!workspaceId || !sessionId) return "text";
  var modes = loadModes();
  var workspaceModes = modes[workspaceId] || {};
  return normalizeMode(workspaceModes[sessionId]);
}

export function setDecisionMode(workspaceId, sessionId, mode) {
  if (!workspaceId || !sessionId) return;
  var modes = loadModes();
  if (!modes[workspaceId] || typeof modes[workspaceId] !== "object") modes[workspaceId] = {};
  modes[workspaceId][sessionId] = normalizeMode(mode);
  saveModes(modes);
}

function activeWorkspaceId() {
  return (S.serverInfo && S.serverInfo.workspace_id) || S.activeWsId;
}

export function clearDecisionMode(workspaceId, sessionId) {
  if (!workspaceId || !sessionId) return;
  var modes = loadModes();
  if (!modes[workspaceId] || typeof modes[workspaceId] !== "object") return;
  delete modes[workspaceId][sessionId];
  saveModes(modes);
}

export function clearDecisionModes(workspaceId, sessionIds) {
  if (!workspaceId || !Array.isArray(sessionIds)) return;
  var modes = loadModes();
  if (!modes[workspaceId] || typeof modes[workspaceId] !== "object") return;
  for (var i = 0; i < sessionIds.length; i++) delete modes[workspaceId][sessionIds[i]];
  saveModes(modes);
}

export function getActiveDecisionMode() {
  return getDecisionMode(activeWorkspaceId(), S.currentConvId);
}

export function updateDecisionModeUI() {
  var button = document.getElementById("agent-decision-mode-btn");
  var name = document.getElementById("agent-decision-mode-name");
  var dropdown = document.getElementById("agent-decision-mode-dropdown");
  if (!button || !name || !dropdown) return;
  var mode = getActiveDecisionMode();
  name.textContent = _t(MODES[mode].label);
  button.classList.toggle("on", mode !== "text");
  button.setAttribute("aria-pressed", mode !== "text" ? "true" : "false");
  if (button instanceof HTMLButtonElement) button.disabled = !S.currentConvId;
  var items = dropdown.querySelectorAll("[data-decision-mode]");
  for (var i = 0; i < items.length; i++) {
    var selected = items[i].getAttribute("data-decision-mode") === mode;
    items[i].classList.toggle("selected", selected);
    items[i].setAttribute("aria-selected", selected ? "true" : "false");
  }
  if (S.currentConvId) {
    document.dispatchEvent(new CustomEvent("agent-decision-mode-changed", { detail: { mode: mode } }));
  }
}

export function bindDecisionModeEvents() {
  var button = document.getElementById("agent-decision-mode-btn");
  var dropdown = document.getElementById("agent-decision-mode-dropdown");
  if (!button || !dropdown) return;
  button.addEventListener("click", function(e) {
    e.stopPropagation();
    var modelDropdown = document.getElementById("agent-model-dropdown");
    var skillDropdown = document.getElementById("agent-skill-dropdown");
    if (modelDropdown) modelDropdown.classList.remove("show");
    if (skillDropdown) skillDropdown.classList.remove("show");
    dropdown.classList.toggle("show");
  });
  var items = dropdown.querySelectorAll("[data-decision-mode]");
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener("click", function(e) {
      e.stopPropagation();
      var target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      var mode = target.getAttribute("data-decision-mode");
      setDecisionMode(activeWorkspaceId(), S.currentConvId, mode);
      dropdown.classList.remove("show");
      updateDecisionModeUI();
    });
  }
  updateDecisionModeUI();
}

// 决策模式的请求载荷（POST /v1/workspaces/{id}/agent 的 decision 字段）。
// 输出契约已由服务端负责（admAgent internal/decision + decision_turn.go），
// 前端不再把控制块拼进用户消息，因此控制文本不会进入会话历史、自动标题，
// 也不会出现在其它客户端（TUI / 微信）的消息里。
export function decisionRequestPayload(mode) {
  var normalized = normalizeMode(mode);
  var requestMode = MODES[normalized].requestMode;
  if (!requestMode) return null;
  return { mode: requestMode, tool_policy: "none", structured_output: "auto" };
}

function parseJsonBlock(text, regex) {
  if (!text) return null;
  var match = text.match(regex);
  if (!match) return null;
  var json = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function textValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizeCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).filter(function(item) {
    return item && typeof item === "object" && (item.value !== undefined || item.label !== undefined);
  }).map(function(item) {
    return {
      value: textValue(item.value),
      label: textValue(item.label || item.value),
      rationale: textValue(item.rationale || item.reason),
    };
  });
}

function normalizeDecision(value) {
  if (!value || typeof value !== "object") return null;
  var type = String(value.type || "").toLowerCase();
  if (type === "choice") {
    var selected = textValue(value.selected);
    if (!selected) return null;
    return {
      type: type,
      selected: selected,
      reason: textValue(value.reason),
      candidates: normalizeCandidates(value.candidates),
    };
  }
  if (type === "bool") {
    var raw = value.value;
    if (typeof raw === "string") raw = raw.toLowerCase() === "true" ? true : raw.toLowerCase() === "false" ? false : null;
    if (typeof raw !== "boolean") return null;
    return { type: type, value: raw, reason: textValue(value.reason) };
  }
  if (type === "score") {
    var score = Number(value.score);
    var min = Number.isFinite(Number(value.min)) ? Number(value.min) : 0;
    var max = Number.isFinite(Number(value.max)) ? Number(value.max) : 10;
    if (!Number.isFinite(score) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    var normalizedScore = Math.max(min, Math.min(max, score));
    return {
      type: type,
      score: normalizedScore,
      min: min,
      max: max,
      level: textValue(value.level),
      reason: textValue(value.reason),
      normalized: (normalizedScore - min) / (max - min),
    };
  }
  return null;
}

export function parseDecisionResult(text) {
  return normalizeDecision(parseJsonBlock(text, RESULT_RE));
}

export function hasDecisionSyntax(text) {
  return Boolean(text && (/<adm_decision_request>/i.test(text) || /<adm_decision_result>/i.test(text)));
}

function stripDecisionRequestAndContract(text) {
  if (!text) return "";
  var clean = text;
  if (/<adm_decision_request>/i.test(text) || /<\/adm_decision_contract>/i.test(text)) {
    clean = clean.replace(CONTRACT_RE, "");
  }
  return clean.replace(REQUEST_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripDecisionRequestText(text) {
  return stripDecisionRequestAndContract(text);
}

export function stripDecisionControlText(text) {
  if (!text) return "";
  var clean = stripDecisionRequestAndContract(text);
  clean = clean.replace(RESULT_RE, "");
  return clean.replace(/\n{3,}/g, "\n\n").trim();
}

function addTextRow(container, label, value) {
  var row = document.createElement("div");
  row.className = "decision-row";
  var key = document.createElement("span");
  key.className = "decision-label";
  key.textContent = label;
  var val = document.createElement("span");
  val.className = "decision-value";
  val.textContent = value;
  row.appendChild(key);
  row.appendChild(val);
  container.appendChild(row);
}

function addList(container, title, values) {
  if (!values.length) return;
  var heading = document.createElement("div");
  heading.className = "decision-subtitle";
  heading.textContent = title;
  container.appendChild(heading);
  var list = document.createElement("ul");
  for (var i = 0; i < values.length; i++) {
    var item = document.createElement("li");
    item.textContent = values[i];
    list.appendChild(item);
  }
  container.appendChild(list);
}

function buildDecisionCard(decision) {
  var card = document.createElement("section");
  card.className = "decision-card decision-card-" + decision.type +
    (decision.type === "bool" ? (decision.value ? " decision-card-bool-true" : " decision-card-bool-false") : "");
  var header = document.createElement("div");
  header.className = "decision-card-header";
  var title = document.createElement("span");
  title.textContent = decision.type === "choice" ? "◇ Choice"
    : decision.type === "bool" ? "⇄ Bool" : "↗ Score";
  var badge = document.createElement("span");
  badge.className = "decision-badge";
  badge.textContent = decision.type === "bool" ? (decision.value ? _t("成立") : _t("不成立")) : _t("决策建议");
  header.appendChild(title);
  header.appendChild(badge);
  card.appendChild(header);
  var body = document.createElement("div");
  body.className = "decision-card-body";
  if (decision.type === "choice") {
    addTextRow(body, _t("结论"), decision.selected);
    if (decision.reason) addTextRow(body, _t("依据"), decision.reason);
    addList(body, _t("候选方案"), decision.candidates.map(function(candidate) {
      return candidate.label + (candidate.rationale ? " — " + candidate.rationale : "");
    }));
  } else if (decision.type === "bool") {
    addTextRow(body, _t("结论"), decision.value ? _t("成立") : _t("不成立"));
    if (decision.reason) addTextRow(body, _t("依据"), decision.reason);
  } else {
    addTextRow(body, _t("评分"), decision.score + " / " + decision.max);
    addTextRow(body, _t("归一化值"), decision.normalized.toFixed(3));
    if (decision.level) addTextRow(body, _t("等级"), decision.level);
    if (decision.reason) addTextRow(body, _t("依据"), decision.reason);
  }
  // 统一声明：不提供概率，且结果不会被自动执行（模型自报数值不作为置信度使用）
  body.appendChild(Object.assign(document.createElement("div"), {
    className: "decision-note",
    textContent: _t("当前模式不提供概率；此结果不会自动执行任何操作。"),
  }));
  card.appendChild(body);
  return card;
}

export function appendDecisionResult(container, text) {
  var decision = parseDecisionResult(text);
  if (decision) container.appendChild(buildDecisionCard(decision));
}

// 服务端 P2 起结果作为专用 `decision` part 下发/落库（不再依赖正文标签）。
// 把 part 数据还原成与 parseDecisionResult 相同的归一化结构，复用同一套卡片渲染。
export function decisionFromPart(data) {
  if (!data || typeof data !== "object") return null;
  var kind = String(data.kind || data.type || "").toLowerCase();
  if (kind === "choice") {
    var selected = textValue(data.selected);
    if (!selected) return null;
    return {
      type: "choice",
      selected: selected,
      reason: textValue(data.reason),
      candidates: normalizeCandidates(data.candidates),
    };
  }
  if (kind === "bool") {
    if (typeof data.value !== "boolean") return null;
    return { type: "bool", value: data.value, reason: textValue(data.reason) };
  }
  if (kind === "score") {
    var score = Number(data.score);
    var min = Number.isFinite(Number(data.min)) ? Number(data.min) : 0;
    var max = Number.isFinite(Number(data.max)) ? Number(data.max) : 10;
    if (!Number.isFinite(score) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    var normalizedScore = Math.max(min, Math.min(max, score));
    return {
      type: "score",
      score: normalizedScore,
      min: min,
      max: max,
      level: textValue(data.level),
      reason: textValue(data.reason),
      normalized: (normalizedScore - min) / (max - min),
    };
  }
  return null;
}

// 渲染一张决策卡片（part 优先，回落到正文标签）
export function appendDecisionCard(container, decision) {
  if (!decision) return false;
  container.appendChild(buildDecisionCard(decision));
  return true;
}
