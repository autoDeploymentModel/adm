// 每一轮对话容器（.msg-round）上的撤销入口
//
// 服务端 `POST /v1/workspaces/{id}/agent/sessions/{sid}/undo` 接受可选 `anchor`
// （该轮起始 user 消息 ID）：传了就把「该轮及其之后的所有轮次」一次回滚（整树还原到
// 该轮开始前 + 删掉这些轮的消息与文件历史），不传则退回旧行为（只回滚最后一轮，
// TUI 的 ctrl+b 走这条）。
//
// 能回退到多早由服务端快照决定（确认文案必须如实写出来，不能让用户以为文件一定回退了）：
//   1) 每个会话只保留最近 N 轮文件快照（options.undo_checkpoints，默认 10；见
//      admAgent internal/undo 的 DefaultMaxCheckpoints），更早的轮次没有快照 →
//      只能回滚对话记录，文件改动会残留；
//   2) 工作目录不是 git 仓库（或没装 git）时服务端从不开快照 → 同样只能回滚对话记录。
// 第 2 条用 Rust 命令 check_git_repo 探测（见 doc/rust-backend.md）。
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { log } from "./log.js";
import { showConfirm, showInfo, showWarning, reportError } from "./ui.js";

// 撤销请求进行中：期间所有轮上的撤销按钮置灰（仍可点，点击被 undoBlockReason 拦下），
// 避免并发两次整树回滚互相打断
var undoInFlight = false;

// 会话刷新回调由 agent.js 注入（selectConversation）。undo.js 不直接 import session.js，
// 否则 render.js → undo.js → session.js → render.js 会形成模块循环。
var refreshConversation = null;

export function initUndo(opts) {
  if (opts && typeof opts.refreshConversation === "function") {
    refreshConversation = opts.refreshConversation;
  }
}

// 撤销入口的可用性：空串 = 可用，否则是给用户看的原因（同时作为按钮 tooltip）。
// 服务端 undo 是整仓库回滚，因此「同工作区其它会话在跑」也必须拦住：否则会连带回滚
// 别人的改动与提交（见 doc/admAgent-parallel-sessions-file-guards.md）。
function undoBlockReason() {
  if (!S.currentConvId) return _t("请先选择一个会话");
  if (undoInFlight) return _t("正在撤销，请稍候");
  if (S.activeRun || S.queuedRun) return _t("本会话正在运行，请先停止本轮后再撤销");
  var others = (S.runs || []).filter(function(r) { return r.sessionId !== S.currentConvId; });
  if (others.length > 0) return _t("同工作区其它会话正在运行，撤销会连带回滚它们的改动，请等其结束后再撤销");
  return "";
}

// 同步单个轮容器上的撤销按钮状态（render.js 每次对齐轮状态时调用）。
//
// 不可用态只加置灰类、不用 disabled：禁用态的 <button> 收不到指针事件——title 不弹、
// 点击也不触发，用户只看到一个没有任何解释的死按钮；而按钮状态只在消息渲染时重算，
// 运行态在别处变化（如同工作区其它会话结束）不会重渲染，禁用态会一直留着。
// 改成「置灰但仍可点」：点击由 undoToRound 重新判定 undoBlockReason() 并 showWarning 出原因。
export function syncRoundUndoState(roundEl) {
  if (!roundEl) return;
  var btn = /** @type {HTMLButtonElement | null} */ (roundEl.querySelector(":scope > .msg-round-header > .msg-round-undo"));
  if (!btn) return;
  var reason = undoBlockReason();
  btn.classList.toggle("msg-round-undo-blocked", reason !== "");
  var tip = reason || _t("撤销这一轮对话");
  if (btn.title !== tip) btn.title = tip;
}

// 全量同步（撤销中/结束后、运行态变化但没有重新渲染时使用）
export function syncAllRoundUndoStates() {
  var area = document.getElementById("agent-msg-area");
  if (!area) return;
  var rounds = area.querySelectorAll(":scope > .msg-round");
  for (var i = 0; i < rounds.length; i++) syncRoundUndoState(rounds[i]);
}

// 目标轮及其之后的轮数（只用于确认文案里的「N 轮」）。轮以「一条 user 消息」为起点，
// 与服务端按 anchor 回滚的粒度一致。找不到目标消息时返回 0。
function turnsFrom(anchorId) {
  var msgs = Array.isArray(S.messages) ? S.messages : [];
  var start = -1;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m && m.role === "user" && String(m.id) === String(anchorId)) { start = i; break; }
  }
  if (start < 0) return 0;
  var count = 0;
  for (var j = start; j < msgs.length; j++) {
    if (msgs[j] && msgs[j].role === "user") count++;
  }
  return count;
}

function undoUrl(convId) {
  return "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/sessions/" + convId + "/undo";
}

// 工作目录的 git 能力（Rust 侧 check_git_repo）。按工作目录路径缓存：
// 撤销能否回退文件完全取决于它，但每次点击都跑一次 git 没必要。
var gitCapabilityCache = {};

async function undoCapability() {
  var path = (S.workspaceInfo && S.workspaceInfo.path) || "";
  if (!path) {
    try { path = (await invoke("get_agent_workdir")) || ""; } catch (_) { path = ""; }
  }
  if (!path) return null;
  if (gitCapabilityCache[path]) return gitCapabilityCache[path];
  try {
    var info = await invoke("check_git_repo", { path: path });
    if (info) {
      gitCapabilityCache[path] = info;
      return info;
    }
  } catch (e) {
    log.warn("UNDO", "git 能力检测失败: " + e);
  }
  return null;
}

// 点击某一轮容器上的撤销按钮：确认后回滚「这一轮及其之后」的所有轮次。
export function undoToRound(anchorId) {
  if (!S.serverInfo || !S.currentConvId) return;
  var blocked = undoBlockReason();
  if (blocked) {
    showWarning(blocked);
    return;
  }
  var turns = turnsFrom(anchorId);
  if (turns <= 0) {
    showWarning(_t("没有找到这一轮对话，请刷新后重试"));
    return;
  }
  var convId = S.currentConvId;
  undoCapability().then(function(cap) {
    var msg = turns === 1
      ? _t("确定撤销这一轮对话？本轮的消息会被删除，文件回退到本轮开始前。")
      : _t("确定撤销该轮及其之后的 ") + turns + _t(" 轮对话？这些消息会被删除，文件回退到该轮开始前。");
    if (turns > 1) {
      msg += "\n\n" + _t("注意：跨轮撤销的文件回退依赖服务端保留的每轮快照（默认最近 10 轮），更早轮次只能回退对话记录。");
    }
    if (cap && cap.git_installed === false) {
      msg += "\n\n" + _t("当前工作目录未安装 git：只能回退对话记录，文件修改不会被回退。");
    } else if (cap && !cap.is_repo) {
      msg += "\n\n" + _t("当前工作目录不是 git 仓库：只能回退对话记录，文件修改不会被回退。");
    }
    showConfirm(msg, function() { runUndo(convId, anchorId, turns); });
  });
}

async function runUndo(convId, anchorId, turns) {
  undoInFlight = true;
  syncAllRoundUndoStates();
  var ok = false;
  try {
    // 一次调用回滚「这一轮及其之后」：服务端按 anchor 定位该轮快照并删掉之后的全部消息。
    await api("POST", undoUrl(convId), { anchor: anchorId });
    ok = true;
  } catch (e) {
    reportError(e, { prefix: _t("撤销失败: ") });
  } finally {
    undoInFlight = false;
    // 无论成功失败都重新拉取会话：失败可能发生在服务端已还原工作树之后，
    // 界面必须与服务端保持一致。
    if (refreshConversation && convId && S.currentConvId === convId) {
      try {
        await refreshConversation(convId);
      } catch (e) {
        log.warn("UNDO", "撤销后刷新会话失败: " + e);
      }
    } else {
      syncAllRoundUndoStates();
    }
    if (ok) {
      showInfo(turns === 1 ? _t("已撤销这一轮对话") : _t("已撤销 ") + turns + _t(" 轮对话"));
    }
  }
}
