// 工具栏「推理强度」下拉（原 Agent 设置→模型配置里的控件，移到模型选择右侧）。
// 思考开关与推理强度合并为单个下拉：选「关闭」只翻 thinking_enabled（发 reasoning_effort: none），
// 档位本身保留，切回具体强度时恢复用户原来的选择。
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { reasoningSettingValue, applyReasoningSetting } from "./utils.js";
import { saveSettings } from "./settings_dialog.js";
import { switchModel, resolveAgentModel, updateModelBtn } from "./model.js";
import { reportError } from "./ui.js";

// 打开下拉时先关掉工具栏其它下拉：各自的按钮 click 都 stopPropagation，
// 不会触发 agent.js 的全局「点击外部关闭」，因此必须在这里手动互斥。
function closeOtherToolbarDropdowns() {
  ["agent-model-dropdown", "agent-skill-dropdown", "agent-decision-mode-dropdown"].forEach(function(id) {
    var dd = document.getElementById(id);
    if (dd) dd.classList.remove("show");
  });
}

export function updateReasoningUI() {
  var button = document.getElementById("agent-reasoning-btn");
  var name = document.getElementById("agent-reasoning-name");
  var dropdown = document.getElementById("agent-reasoning-dropdown");
  // bindEvents 在 init() 之前执行，此时 S.settings 仍是 store.js 的初始值 null；
  // 必须判空，否则 mount 抛错会让整个 Agent 视图挂载失败。
  if (!S.settings || !button || !name || !dropdown) return;
  var value = reasoningSettingValue(S.settings.agent_thinking_enabled, S.settings.agent_reasoning_effort);
  name.textContent = value === "off" ? _t("关闭推理") : value;
  var items = dropdown.querySelectorAll("[data-reasoning]");
  for (var i = 0; i < items.length; i++) {
    var selected = items[i].getAttribute("data-reasoning") === value;
    items[i].classList.toggle("selected", selected);
    items[i].setAttribute("aria-selected", selected ? "true" : "false");
  }
}

// 推理强度写进 /config/model 的 reasoning_effort，服务端 /agent/update 后才生效；
// 复用 switchModel 走与切换模型相同的链路（原设置弹窗 applySettings 也是这么推送的）。
async function applyReasoningToServer() {
  updateModelBtn();
  var selectedKey = S.settings.agent_default_provider || "local";
  var resolved = resolveAgentModel(selectedKey);
  if (!resolved || !resolved.model) return;
  // 显示名沿用按钮当前文案（updateModelBtn 已按 agentInfo/设置解析好），
  // 避免 switchModel 重设名称时短暂闪成原始 provider key。
  var nameEl = document.getElementById("agent-model-name");
  var displayName = (nameEl && nameEl.textContent) || selectedKey;
  await switchModel(selectedKey, displayName, 0);
}

// 连续快速切换时，每次点击都启动一条异步链，多条链同时在途会让 /config/model
// 的完成顺序不受控（旧请求晚到会覆盖新档位）。这里用单条 Promise 链串行化，
// 并用递增序号丢弃已被更新选择取代的过期任务。
var pushSeq = 0;
var pushChain = Promise.resolve();

function enqueueReasoningPush() {
  var seq = ++pushSeq;
  pushChain = pushChain.then(async function() {
    if (seq !== pushSeq) return;
    try {
      await saveSettings();
      if (seq !== pushSeq) return;
      await applyReasoningToServer();
    } catch (err) {
      reportError(err, { prefix: _t("保存推理强度失败: ") });
    }
  });
}

export function bindReasoningSelectorEvents() {
  var button = document.getElementById("agent-reasoning-btn");
  var dropdown = document.getElementById("agent-reasoning-dropdown");
  if (!button || !dropdown) return;
  button.addEventListener("click", function(e) {
    e.stopPropagation();
    var willShow = !dropdown.classList.contains("show");
    closeOtherToolbarDropdowns();
    dropdown.classList.toggle("show", willShow);
  });
  var items = dropdown.querySelectorAll("[data-reasoning]");
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener("click", function(e) {
      e.stopPropagation();
      var target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      var value = target.getAttribute("data-reasoning") || "";
      dropdown.classList.remove("show");
      // init() 完成前不处理选择：此时 S.settings 为 null，写入会抛错并覆写配置
      if (!S.settings) return;
      var reasoning = applyReasoningSetting(value, S.settings.agent_reasoning_effort);
      S.settings.agent_thinking_enabled = reasoning.enabled;
      S.settings.agent_reasoning_effort = reasoning.effort;
      updateReasoningUI();
      enqueueReasoningPush();
    });
  }
  updateReasoningUI();
}
