// PDF 分批发送（批次泵）
// 流程：附加时只登记 PDF（解析页数，不渲染）→ 发送时只转换首批（见 send.js）→
// 每批运行结束（run_complete）后自动转换并发送下一批，直到整个 PDF 发完。
// 说明：
// - 服务端零改动：每批就是一条带图片附件的普通用户消息（独立 run）；
// - 服务端 view 工具只读文本、不能读图片（明确拒绝），模型无法自行取页，
//   后续批次必须由客户端主动推送；
// - 非视觉主模型由服务端直调 vision 识别，单轮上限 maxImagesPerTurn=5，
//   因此批大小必须 ≤5（视觉主模型无此限制，按 token 预算取 10）；
// - 计划状态保存在本模块：出错/取消/切会话/手动停止都会终止剩余批次。
import { t as _t, tV } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";
import { showChoice, showError, showInfo, showNotice, showWarning } from "./ui.js";
import { friendlyError } from "./error.js";
import { loadPdfSourceBytes, renderPdfPageRange, friendlyPdfError } from "./pdf.js";

// 单批页数：视觉主模型 10 页/批；非视觉主模型受服务端单轮图片识别上限约束必须 ≤5
export var PDF_BATCH_VISION = 10;
export var PDF_BATCH_TEXT = 5;
// 超过该页数时发送前弹确认卡（显示份数与批次数），防止误发大文档
export var PDF_CONFIRM_PAGES = 50;
// 兜底上限：总批次数超过该值时拒绝发送（避免数百页 PDF 误确认后大量消耗 token）
export var PDF_MAX_BATCHES = 100;

/**
 * 发送函数由 agent.js 注入（send.js 的 sendMessageWithFiles）——send.js 反向
 * 依赖本模块的计划/首批逻辑，注入可避免模块循环依赖。
 * target 为目标会话/工作区：sendText 发送前校验未变化，变则返回 reason="target_changed"
 * @type {null | ((text: string, files: any[], target?: {sessionId: string, workspaceId: string}) => Promise<{ok: boolean, runId?: string|null, sessionId?: string, reason?: string}|undefined>)}
 */
var sendBatchMessage = null;

export function initPdfBatching(sendFn) {
  sendBatchMessage = sendFn;
}

var state = {
  /**
   * @type {Array<{name: string, source: {file?: File|null, path?: string|null},
   *               totalPages: number, nextPage: number, batchSize: number}>}
   */
  plans: [],
  sessionId: "",
  workspaceId: "",
  pumping: false,
  // 最近一批发送的 run_id：只在该 run 完成时推进，避免手动消息的完成事件误触发
  /** @type {string|null} */
  expectedRunId: null,
  /** @type {HTMLElement|null} */
  noticeEl: null,
};

/** 当前主模型是否支持图片（快照未就绪时保守按不支持处理，批大小落到 5） */
function modelSupportsImages() {
  var m = S.agentInfo && S.agentInfo.model;
  return !!(m && m.supports_images === true);
}

/** 本批页数（扣除本轮其它图片附件占用的单轮识别配额） */
export function getPdfBatchSize(otherImageCount) {
  var base = modelSupportsImages() ? PDF_BATCH_VISION : PDF_BATCH_TEXT;
  return Math.max(1, base - (otherImageCount || 0));
}

/** 从待发送附件中分离 PDF 项与普通附件项 */
export function splitPdfItems(items) {
  var pdfs = [];
  var others = [];
  (items || []).forEach(function(f) {
    if (f && f.pdf === true) pdfs.push(f);
    else others.push(f);
  });
  return { pdfs: pdfs, others: others };
}

/** 由待发送 PDF 项生成批次计划（不注册；发送成功后由 registerPlans 登记） */
export function buildPlans(pdfItems, otherImageCount) {
  var batchSize = getPdfBatchSize(otherImageCount);
  return (pdfItems || []).map(function(it) {
    return {
      name: it.name,
      source: it.source || { file: null, path: null },
      totalPages: it.pages || 0,
      nextPage: 1,
      batchSize: batchSize,
    };
  });
}

/** 计划总页数与总批次数 */
export function countPlans(plans) {
  var totalPages = 0;
  var batches = 0;
  (plans || []).forEach(function(p) {
    totalPages += p.totalPages || 0;
    batches += Math.max(1, Math.ceil((p.totalPages || 0) / (p.batchSize || PDF_BATCH_TEXT)));
  });
  return { totalPages: totalPages, batches: batches };
}

/**
 * 超过确认阈值时弹确认卡；返回 Promise<boolean>（false = 取消发送）。
 * 页数过多（批次数超过 PDF_MAX_BATCHES）直接拒绝并提示拆分。
 */
export function confirmLargePlans(plans) {
  var c = countPlans(plans);
  if (c.totalPages <= PDF_CONFIRM_PAGES) return Promise.resolve(true);
  if (c.batches > PDF_MAX_BATCHES) {
    showError(tV("PDF 页数过多（共 {total} 页 / {batches} 批，超过 {max} 批上限），请拆分文件后再发送", {
      total: c.totalPages, batches: c.batches, max: PDF_MAX_BATCHES,
    }));
    return Promise.resolve(false);
  }
  return new Promise(function(resolve) {
    showChoice({
      title: _t("分批发送 PDF"),
      message: tV("共 {n} 份 PDF / {total} 页，将分 {batches} 批自动发送（每批最多 {size} 页）。是否继续？", {
        n: (plans || []).length, total: c.totalPages, batches: c.batches,
        size: (plans && plans[0] && plans[0].batchSize) || PDF_BATCH_TEXT,
      }),
      okText: _t("继续发送"),
      cancelText: _t("取消"),
      onOk: function() { resolve(true); },
      onCancel: function() { resolve(false); },
    });
  });
}

/**
 * 转换计划的下一个批次并推进 nextPage（发送时/批次泵共用）。
 * @param {{name: string, source: {file?: File|null, path?: string|null}, totalPages: number, nextPage: number, batchSize: number}} plan
 */
export async function renderPlanBatch(plan) {
  var bytes = await loadPdfSourceBytes(plan.source);
  var last = plan.totalPages > 0
    ? Math.min(plan.nextPage + plan.batchSize - 1, plan.totalPages)
    : plan.nextPage + plan.batchSize - 1;
  var res = await renderPdfPageRange(plan.name, bytes, plan.nextPage, last);
  if (res.totalPages > 0) plan.totalPages = res.totalPages;
  if (res.items.length > 0) plan.nextPage = res.lastPage + 1;
  return res;
}

/**
 * 首批发送成功后登记计划并显示进度提示。
 * 同一会话已有计划时追加到队列尾部（顺序发送，不丢弃剩余页）。
 * @param {Array<any>} plans
 * @param {string} sessionId
 * @param {string} workspaceId
 * @param {string|null} firstRunId 本次消息的 run_id（折叠插入为 null）
 */
export function registerPlans(plans, sessionId, workspaceId, firstRunId) {
  if (!plans || plans.length === 0) return;
  if (state.plans.length > 0 && state.sessionId === sessionId) {
    state.plans = state.plans.concat(plans);
  } else {
    state.plans = plans.slice();
  }
  state.sessionId = sessionId;
  state.workspaceId = workspaceId;
  // 已等待某个 run 时（如前一批排在其它会话之后）不覆盖，避免推进判据被改写
  if (!state.expectedRunId) state.expectedRunId = firstRunId || null;
  renderNotice();
}

/**
 * run_complete 钩子：本会话批次运行结束后自动发送下一批。
 * @param {string} sessionId 完成运行的会话
 * @param {string} kind classifyRunComplete 的结果（ok / step_cap / cancelled / error / empty_output）
 * @param {string} runId 完成的 run_id
 * @param {boolean} tookOverQueued 是否有同会话排队运行接管（此时等它结束再推进）
 */
export function onRunComplete(sessionId, kind, runId, tookOverQueued) {
  if (state.plans.length === 0) return;
  if (!sessionId || sessionId !== state.sessionId) return;
  // 只认等待中的 run：手动消息的完成事件不得推进计划
  if (state.expectedRunId && runId && runId !== state.expectedRunId) return;
  state.expectedRunId = null;
  if (tookOverQueued) return; // 排队运行接管：等它结束后再推进
  if (kind !== "ok") {
    var why = kind === "cancelled" ? _t("本轮已取消，PDF 剩余批次已停止")
      : kind === "step_cap" ? _t("本轮步数触顶，PDF 剩余批次已停止")
        : _t("本轮出错，PDF 剩余批次已停止");
    abort(why);
    return;
  }
  if (S.currentConvId !== state.sessionId) {
    abort(_t("已切换会话，PDF 剩余批次已停止"));
    return;
  }
  pumpNext();
}

/** 还有剩余页面的计划（跳过已发完的） */
function nextPlanWithPages() {
  for (var i = 0; i < state.plans.length; i++) {
    var p = state.plans[i];
    if (!(p.totalPages > 0) || p.nextPage <= p.totalPages) return p;
  }
  return null;
}

/** 计划的目标会话仍是当前打开会话（且工作区一致）——转换耗时期间用户可能切换 */
function targetStillActive() {
  if (S.currentConvId !== state.sessionId) return false;
  if (state.workspaceId && S.serverInfo && S.serverInfo.workspace_id && S.serverInfo.workspace_id !== state.workspaceId) return false;
  return true;
}

/** 转换并发送下一批（同一时刻只允许一个批次在转换/发送中） */
async function pumpNext() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    if (!targetStillActive()) {
      abort(_t("已切换会话，PDF 剩余批次已停止"));
      return;
    }
    var plan = nextPlanWithPages();
    if (!plan) {
      finish();
      return;
    }
    var res;
    try {
      res = await renderPlanBatch(plan);
    } catch (e) {
      abort(_t("PDF 批次转换失败，剩余批次已停止: ") + plan.name + " (" + friendlyPdfError(e) + ")");
      return;
    }
    if (state.plans.length === 0) return; // 转换期间被停止/终止
    // 转换耗时可达数秒：发送前必须复查目标，否则本批会被发进新切换到的会话
    if (!targetStillActive()) {
      abort(_t("已切换会话，PDF 剩余批次已停止"));
      return;
    }
    if (res.items.length === 0) {
      abort(_t("PDF 批次转换失败，剩余批次已停止: ") + plan.name);
      return;
    }
    if (res.failed > 0) {
      showWarning(tV("PDF《{name}》第 {a}-{b} 页中有 {n} 页转换失败", {
        name: plan.name, a: res.firstPage, b: res.lastPage, n: res.failed,
      }));
    }
    var note = tV("PDF《{name}》第 {a}-{b} 页（共 {total} 页），请继续处理。", {
      name: plan.name, a: res.firstPage, b: res.lastPage, total: res.totalPages,
    });
    // 目标一并传入：sendText 发送前再校验一次，覆盖校验后到发送前的极短窗口
    var r = sendBatchMessage ? await sendBatchMessage(note, res.items, { sessionId: state.sessionId, workspaceId: state.workspaceId }) : { ok: false };
    if (state.plans.length === 0) return; // 发送期间被停止/终止
    if (!r || !r.ok) {
      abort(r && r.reason === "target_changed"
        ? _t("已切换会话，PDF 剩余批次已停止")
        : _t("PDF 批次发送失败，剩余批次已停止: ") + plan.name);
      return;
    }
    state.expectedRunId = r.runId || null;
    renderNotice();
  } catch (e) {
    console.error("[agent] PDF 批次发送异常:", e);
    abort(_t("PDF 批次发送异常，剩余批次已停止: ") + friendlyError(e, { inline: true }));
  } finally {
    state.pumping = false;
  }
}

/**
 * 挂载 / 切回工作区 / run_complete 兜底时的对账（SSE 事件在页面切走、
 * 工作区切 tab 期间会丢失，批次泵不能只依赖 run_complete）：
 * - 目标会话已不是当前打开会话 → 终止剩余批次（与"切换会话即停止"约定一致）；
 * - 前端仍认为批次 run 在运行中（事件重新订阅后等它到达即可）→ 返回；
 * - 服务端仍忙（本会话或工作区其它会话）→ 等待；
 * - 服务端已空闲（批次 run 已结束但事件丢失）→ 立即推进下一批。
 */
export async function reconcilePdfBatching() {
  try {
    if (state.plans.length === 0 || state.pumping) return;
    if (S.currentConvId !== state.sessionId) {
      abort(_t("已切换会话，PDF 剩余批次已停止"));
      return;
    }
    if (state.expectedRunId && S.isSending && S.activeRun && S.activeRun.runId === state.expectedRunId) return;
    if (!state.workspaceId) {
      pumpNext();
      return;
    }
    try {
      var sess = await api("GET", "/v1/workspaces/" + state.workspaceId + "/sessions/" + state.sessionId);
      if (sess && sess.is_busy) return;
      var info = await api("GET", "/v1/workspaces/" + state.workspaceId + "/agent");
      if (info && info.is_busy) return;
    } catch (e) {
      return; // 查询失败保持现状，等下一次对账或 run_complete
    }
    if (state.plans.length === 0 || state.pumping) return; // 查询期间状态可能已变化
    pumpNext();
  } catch (e) {
    console.warn("[agent] PDF 批次对账失败:", e);
  }
}

/** 进度提示（常驻 + 停止按钮）；全部批次已发送时撤下常驻提示 */
function renderNotice() {
  removeNotice();
  var plan = nextPlanWithPages();
  if (!plan) {
    showInfo(_t("PDF 全部分批已发送完毕"));
    return;
  }
  var sent = Math.max(0, Math.min(plan.nextPage - 1, plan.totalPages));
  var el = showNotice(
    tV("PDF 分批发送中：《{name}》已发送 {sent}/{total} 页，剩余页面将自动分批发送", {
      name: plan.name, sent: sent, total: plan.totalPages,
    }),
    "info", true);
  if (!el) return;
  state.noticeEl = el;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = _t("停止后续批次");
  btn.style.cssText = "margin-left:8px;padding:1px 8px;font-size:12px;cursor:pointer;background:transparent;color:inherit;border:1px solid currentColor;border-radius:4px;opacity:.85;";
  btn.addEventListener("click", function() { abort(_t("已停止 PDF 剩余批次")); });
  el.appendChild(btn);
}

function removeNotice() {
  if (state.noticeEl && state.noticeEl.parentNode) state.noticeEl.remove();
  state.noticeEl = null;
}

/** 全部批次已发送且最后一个 run 也结束：静默清理 */
function finish() {
  removeNotice();
  clearState();
}

/** 终止剩余批次（reason 非空时以警告展示） */
export function abort(reason) {
  if (state.plans.length === 0 && !state.noticeEl) return;
  removeNotice();
  clearState();
  if (reason) showWarning(reason);
}

function clearState() {
  state.plans = [];
  state.sessionId = "";
  state.workspaceId = "";
  state.expectedRunId = null;
}
