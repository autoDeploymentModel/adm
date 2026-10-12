// WorkspaceStateStore — 统一 Agent 状态管理
// 所有状态写入走 Store 细粒度方法；S 为只读视图（active workspace 快照），
// 仅用于读取，禁止写入。invoke / listen 从这里导出供其他模块使用。
//
// 重要：本 store 无事件通知机制（不 emit / 不 subscribe），
// 写入方必须在写入后自行刷新对应 UI（renderMessages / renderConversationList /
// updateContextUsage / updateStatusBar 等），切勿以为写 store 会自动刷界面。
//
// 快照语义：conversations / messages / currentConv / agentInfo / contextUsage 等
// 对外只读字段一律以「浅拷贝 + Object.freeze」发布（ES 模块严格模式下，外部
// 原地修改会直接抛 TypeError 而非静默污染）。runStats / activeRun / queuedRun
// 例外：collectRunStats 需要原地累计 runStats，ui.js 用 === 比较 activeRun 的
// 对象同一性，这三个字段保持内部引用共享，仅 store 内部与 sse.js 可操作。
//
// 运行态按会话登记（同目录多会话并行）：runs 为「正在运行的会话」、queued 为
// 「同一会话已发出但服务端尚未开始执行的轮次」。activeRun / queuedRun 是
// currentConvId 对应的派生视图（沿用旧语义：都指"当前打开会话的运行"），
// isSending 表示「本工作区有任一运行在飞」，runs 列表供会话列表/状态栏标识用。

// 临时消息内容匹配工具（utils.js 无任何导入，不存在循环依赖）
import { stripSystemInfoText, getTextFromParts } from "./utils.js";

export const invoke = window.__adm_invoke;
export const listen = window.__adm_listen;

// store.js 不能直接 import log.js（log.js 用 window.__adm_invoke 不依赖 store，
// 但为避免未来循环依赖风险，直接内联写日志）
function _log(level, cat, msg) {
  try { invoke("agent_debug_log", { line: "[" + cat + "][" + level + "] " + msg }).catch(function() {}); } catch (_) {}
  console.log("[agent][" + cat + "] " + msg);
}

// 快照冻结辅助：浅拷贝（数组 slice / 对象 assign）后冻结，外部只能读不能改
function _frozen(arr) { return Object.freeze(arr.slice()); }
function _frozenObj(obj) { return Object.freeze(Object.assign({}, obj)); }

// ===== 每个 workspace 的独立状态 =====
class WorkspaceState {
  constructor() {
    this.conversations = [];
    this.currentConvId = null;
    this.currentConv = null;
    this.messages = [];
    this.isSending = false;
    this.activeRun = null;
    this.queuedRun = null;
    this.runStats = null;
    // 运行登记表：runs = 正在运行的会话（sessionId → run）；
    // queued = 同一会话已发出、服务端按会话 FIFO 排队中的轮次（sessionId → run[]，先进先出）
    this.runs = new Map();
    this.queued = new Map();
    // 每会话的本轮统计（假完成检测/决策轮校验用），S.runStats 暴露当前会话那份
    this.runStatsBySession = new Map();
    this.contextUsage = { used: 0, max: 0, estimated: false };
    this.agentInfo = null;
  }

  // 派生视图同步：activeRun / queuedRun / runStats / isSending 一律由登记表算出，
  // 切换会话（currentConvId 变化）与登记/注销运行时都必须调用
  syncDerived() {
    this.activeRun = this.currentConvId ? (this.runs.get(this.currentConvId) || null) : null;
    var q = this.currentConvId ? this.queued.get(this.currentConvId) : null;
    this.queuedRun = (q && q.length > 0) ? q[0] : null;
    this.runStats = this.currentConvId ? (this.runStatsBySession.get(this.currentConvId) || null) : null;
    // 「有运行在飞」含排队轮次：排队消息已发出，界面仍须保持工作态
    this.isSending = this.runs.size > 0 || this.queued.size > 0;
  }

  // 全部运行（含排队）的只读列表，供会话列表 / 状态栏标识
  runsList() {
    var out = [];
    this.runs.forEach(function(run) { out.push({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, queued: false }); });
    this.queued.forEach(function(list) {
      (list || []).forEach(function(run) { out.push({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, queued: true }); });
    });
    return out;
  }

  // 各会话本轮统计的列表快照（切回工作区时按会话恢复，不能只剩当前会话那份）
  runStatsList() {
    var out = [];
    this.runStatsBySession.forEach(function(stats) { out.push(Object.assign({}, stats)); });
    return out;
  }

  snapshot() {
    this.syncDerived();
    return {
      // 只读字段：浅拷贝 + 冻结（外部原地修改会抛 TypeError）
      conversations: _frozen(this.conversations),
      currentConvId: this.currentConvId,
      currentConv: this.currentConv ? _frozenObj(this.currentConv) : null,
      messages: _frozen(this.messages),
      isSending: this.isSending,
      // 运行引用字段：浅拷贝隔离（不可冻结，见文件头注释）
      activeRun: this.activeRun ? Object.assign({}, this.activeRun) : null,
      queuedRun: this.queuedRun ? Object.assign({}, this.queuedRun) : null,
      runStats: this.runStats ? Object.assign({}, this.runStats) : null,
      runs: this.runsList(),
      runStatsAll: this.runStatsList(),
      contextUsage: _frozenObj(this.contextUsage),
      agentInfo: this.agentInfo ? _frozenObj(this.agentInfo) : null,
    };
  }

  restore(snap) {
    if (!snap) return;
    // 快照一律拷贝后再赋值：快照是冻结对象，直接引用会把冻结传染给内部状态
    //（内部 upsertCreatedMessage 等仍需要 splice/push 原地操作）
    this.conversations = snap.conversations ? snap.conversations.slice() : [];
    this.currentConvId = snap.currentConvId || null;
    this.currentConv = snap.currentConv ? Object.assign({}, snap.currentConv) : null;
    this.messages = snap.messages ? snap.messages.slice() : [];
    this.isSending = snap.isSending || false;
    this.activeRun = snap.activeRun ? Object.assign({}, snap.activeRun) : null;
    this.queuedRun = snap.queuedRun ? Object.assign({}, snap.queuedRun) : null;
    this.runStats = snap.runStats ? Object.assign({}, snap.runStats) : null;
    // 运行登记表按快照重建（切回工作区后运行仍在服务端继续，登记必须恢复）；
    // 排队轮次快照按顺序列出，重建时按会话维持原顺序（先进先出）
    this.runs = new Map();
    this.queued = new Map();
    (snap.runs || []).forEach(function(run) {
      if (!run || !run.sessionId) return;
      if (!run.queued) { this.runs.set(run.sessionId, Object.assign({}, run)); return; }
      var list = this.queued.get(run.sessionId) || [];
      list.push(Object.assign({}, run));
      this.queued.set(run.sessionId, list);
    }, this);
    this.runStatsBySession = new Map();
    (snap.runStatsAll || []).forEach(function(stats) {
      if (stats && stats.sessionId) this.runStatsBySession.set(stats.sessionId, Object.assign({}, stats));
    }, this);
    this.contextUsage = snap.contextUsage ? Object.assign({}, snap.contextUsage) : { used: 0, max: 0, estimated: false };
    this.agentInfo = snap.agentInfo ? Object.assign({}, snap.agentInfo) : null;
    this.syncDerived();
  }
}

// ===== Store =====
class Store {
  constructor() {
    this.workspaces = new Map();
    this.activeWsId = null;
    this.workspacesObj = {};
  }

  registerWorkspace(wsId) {
    if (!this.workspaces.has(wsId)) {
      var ws = new WorkspaceState();
      this.workspaces.set(wsId, ws);
      this.workspacesObj[wsId] = ws.snapshot();
    }
  }

  removeWorkspace(wsId) {
    this.workspaces.delete(wsId);
    delete this.workspacesObj[wsId];
  }

  getActiveWs() {
    return this.workspaces.get(this.activeWsId);
  }

  bindToS() {
    var ws = this.getActiveWs();
    if (!ws) return;
    // activeRun / queuedRun / runStats 由 currentConvId 派生，切会话后必须重算
    ws.syncDerived();
    // 只读字段：浅拷贝 + 冻结（外部原地修改会抛 TypeError）
    S.conversations = _frozen(ws.conversations);
    S.currentConvId = ws.currentConvId;
    S.currentConv = ws.currentConv ? _frozenObj(ws.currentConv) : null;
    S.messages = _frozen(ws.messages);
    S.isSending = ws.isSending;
    // 运行引用字段：保持内部引用共享（collectRunStats 原地累计、ui.js === 同一性比较）
    S.activeRun = ws.activeRun;
    S.queuedRun = ws.queuedRun;
    S.runStats = ws.runStats;
    S.runs = _frozen(ws.runsList());
    S.contextUsage = _frozenObj(ws.contextUsage);
    S.agentInfo = ws.agentInfo ? _frozenObj(ws.agentInfo) : null;
    S.workspaces = this.workspacesObj;
    S.activeWsId = this.activeWsId;
    if (S.serverInfo) S.serverInfo.workspace_id = this.activeWsId;
    this.syncAgentBusy();
  }

  // 运行态变更后的统一发布：重算派生视图 + 快照 + 全局忙碌位 + 绑定只读视图
  _publishRuns(wsId, ws) {
    ws.syncDerived();
    this.workspacesObj[wsId] = ws.snapshot();
    this.syncAgentBusy();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setActive(wsId) {
    if (this.activeWsId) {
      var prev = this.workspaces.get(this.activeWsId);
      if (prev) this.workspacesObj[this.activeWsId] = prev.snapshot();
    }
    this.activeWsId = wsId;
    this.registerWorkspace(wsId);
    var target = this.workspaces.get(wsId);
    var saved = this.workspacesObj[wsId];
    if (saved && target) target.restore(saved);
    this.bindToS();
  }

  // ===== 会话状态 =====
  setSession(wsId, patch) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (patch.currentConvId !== undefined) ws.currentConvId = patch.currentConvId;
    if (patch.currentConv !== undefined) ws.currentConv = patch.currentConv;
    if (patch.conversations !== undefined) ws.conversations = patch.conversations;
    if (patch.messages !== undefined) ws.messages = patch.messages;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setConversations(wsId, list) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.conversations = list;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setCurrentConvId(wsId, id) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.currentConvId = id;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setCurrentConv(wsId, conv) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.currentConv = conv;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setMessages(wsId, arr) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.messages = arr;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  // 服务端消息覆盖 + 保留折叠插入的待落库气泡（_fold）与本地错误气泡（_error）：
  // 折叠插入的消息在服务端下一步边界才会创建，切会话/切页面/刷新时若直接覆盖
  // 会被抹掉；错误气泡为本地常驻提示（不落库、不进 LLM 上下文），同样需要跨
  // refreshMessages 保留。这里把本地仍在等待落库、且属于 convId 会话的气泡按
  // 内容去重后合并追加到末尾。仅保留 _fold/_error（不复活普通发送/排队发送的
  // _temp 临时气泡），且限定会话归属（防止把上一会话的待插入气泡串进当前会话列表）
  setMessagesKeepPending(wsId, serverMsgs, convId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var merged = (serverMsgs || []).slice();
    var pendingLocal = [];
    ws.messages.forEach(function(m) {
      if (!m._temp) return;
      if (m._error) {
        // 本地错误气泡：服务端不会有同名消息，直接保留（_error 气泡已带唯一 id）
        if (convId && m._sessionId && m._sessionId !== convId) return;
        pendingLocal.push(m);
        return;
      }
      if (!m._fold || m.role !== "user") return;
      if (convId && m._sessionId && m._sessionId !== convId) return;
      var onServer = merged.some(function(sm) {
        if (sm.role !== "user") return false;
        var sText = (sm.content || getTextFromParts(sm.parts)) || "";
        return m.content === stripSystemInfoText(sText);
      });
      if (!onServer) pendingLocal.push(m);
    });
    if (pendingLocal.length > 0) merged = merged.concat(pendingLocal);
    ws.messages = merged;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  // 消息创建（SSE message-created）统一入口：
  // 对用户消息先移除内容匹配的临时气泡（_temp/_fold），再追加正式消息。
  // 前台/后台 workspace 的清理统一在此完成（sse.js 不再重复处理），
  // 避免「插入中」气泡与落库正式消息并存
  upsertCreatedMessage(wsId, msgData) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (msgData && msgData.role === "user") {
      var serverText = (msgData.content || getTextFromParts(msgData.parts)) || "";
      var stripped = stripSystemInfoText(serverText);
      var tempIdx = ws.messages.findIndex(function(m) { return m._temp && m.role === "user" && m.content === stripped; });
      if (tempIdx >= 0) {
        ws.messages.splice(tempIdx, 1);
      }
    }
    if (!ws.messages.some(function(m) { return m.id === msgData.id; })) {
      ws.messages.push(msgData);
    }
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  appendMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (!ws.messages.some(function(m) { return m.id === msg.id; })) {
      ws.messages.push(msg);
      this.workspacesObj[wsId] = ws.snapshot();
      // 必须 bindToS：S.messages 是冻结拷贝，不与内部共享，不同步则 UI 读旧数组
      if (wsId === this.activeWsId) this.bindToS();
    }
  }

  updateMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var idx = ws.messages.findIndex(function(m) { return m.id === msg.id; });
    if (idx >= 0) ws.messages[idx] = msg;
    else ws.messages.push(msg);
    this.workspacesObj[wsId] = ws.snapshot();
    // 必须 bindToS：S.messages 是冻结拷贝，不同步则流式 updated 事件 UI 不更新
    if (wsId === this.activeWsId) this.bindToS();
  }

  deleteMessage(wsId, msgId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.messages = ws.messages.filter(function(m) { return m.id !== msgId; });
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setContextUsage(wsId, used, max, estimated) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.contextUsage = { used: used || 0, max: max || 0, estimated: !!estimated };
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setAgentInfo(wsId, info) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.agentInfo = info;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  // ===== 运行状态（按会话登记） =====
  // 同步「agent 是否正在工作」到共享状态，供壳层（index.html）导航拦截使用。
  // 语义：任一 workspace 正在运行即视为工作中——sse.js 对后台 workspace 事件也
  // 会调 completeRun/startRun，若只按单个 ws 判断，后台 run 结束会错误清除
  // agentBusy，导致激活 workspace 还在跑时导航拦截失效。
  syncAgentBusy() {
    try {
      var busy = false;
      this.workspaces.forEach(function(ws) {
        if (ws && ws.isSending) busy = true;
      });
      window.__adm_state.agentBusy = busy;
    } catch (_) {}
  }

  // 登记会话运行开始（同目录多会话并行：允许同一工作区多个会话各有一条活动运行）
  startRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    _log("debug", "STORE", "startRun ws=" + wsId.slice(0, 8) + " session=" + (sessionId || "").slice(0, 8) + " run=" + runId);
    ws.queued.delete(sessionId);
    ws.runs.set(sessionId, { workspaceId: wsId, sessionId: sessionId, runId: runId });
    // 新一轮 run 开始 → 清掉当前会话上一轮的本地错误气泡（_error），让错误信息
    // 只挂在"出错的轮次"，新轮次干净，避免同会话内历史错误持续挂载让人误以为"还在报"。
    // 折叠插入不走 startRun、不进此分支，不影响；多 tab 场景按 _sessionId 限定只清当前会话
    var prevCount = ws.messages.length;
    ws.messages = ws.messages.filter(function(m) {
      if (!m._error) return true;
      // 防御：sessionId 或 m._sessionId 缺失时不清（避免误删其他会话的 _error 气泡）
      if (!sessionId || !m._sessionId) return true;
      return m._sessionId !== sessionId;
    });
    var removed = prevCount - ws.messages.length;
    if (removed > 0) {
      _log("debug", "STORE", "startRun 清掉 " + removed + " 条旧错误气泡 session=" + (sessionId || "").slice(0, 8));
    }
    // 本轮统计由调用方紧随其后 setRunStats 覆盖，这里先清掉该会话的上一轮
    ws.runStatsBySession.delete(sessionId);
    this._publishRuns(wsId, ws);
  }

  // 登记会话排队轮次：同一会话已有活动运行时又发出一条（如决策轮、分批发送），
  // 消息已发出、服务端按会话 FIFO 排在本轮之后；多条时构成先进先出队列
  setQueuedRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var list = ws.queued.get(sessionId) || [];
    list.push({ workspaceId: wsId, sessionId: sessionId, runId: runId });
    ws.queued.set(sessionId, list);
    this._publishRuns(wsId, ws);
  }

  // 排队轮次接管：服务端开始了该会话排队的下一轮（开始产出消息/前一轮已收尾）
  promoteQueuedRun(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return false;
    var list = ws.queued.get(sessionId);
    if (!list || list.length === 0) return false;
    var next = list.shift();
    if (list.length === 0) ws.queued.delete(sessionId);
    else ws.queued.set(sessionId, list);
    ws.runs.set(sessionId, next);
    this._publishRuns(wsId, ws);
    return true;
  }

  // 运行收尾：注销该会话的活动运行；若其排队的下一轮存在则就地接管。
  // 返回 { tookOver, ignored }：tookOver=true 表示本会话仍有轮次在飞（UI 保持工作态）；
  // ignored=true 表示该事件是「迟到的旧运行完成」（同会话已开始新一轮，run_id 不匹配），
  // 未做任何变更——调用方必须跳过界面收尾，否则会把新运行的状态一起清掉。
  // 只影响传入的会话——同工作区其它会话的并行运行不受影响。
  completeRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return { tookOver: false };
    var tookOver = false;
    if (sessionId) {
      var cur = ws.runs.get(sessionId);
      if (runId && cur && cur.runId && cur.runId !== runId) {
        _log("debug", "STORE", "completeRun 忽略迟到事件 session=" + sessionId.slice(0, 8) + " run=" + runId);
        return { tookOver: false, ignored: true };
      }
      ws.runs.delete(sessionId);
      var qlist = ws.queued.get(sessionId);
      if (qlist && qlist.length > 0) {
        _log("debug", "STORE", "completeRun ws=" + wsId.slice(0, 8) + " session=" + sessionId.slice(0, 8) + " → 排队轮次接管");
        var next = qlist.shift();
        if (qlist.length === 0) ws.queued.delete(sessionId);
        else ws.queued.set(sessionId, qlist);
        ws.runs.set(sessionId, next);
        tookOver = true;
      } else {
        _log("debug", "STORE", "completeRun ws=" + wsId.slice(0, 8) + " session=" + sessionId.slice(0, 8) + " → 该会话收尾");
        ws.runStatsBySession.delete(sessionId);
      }
    } else {
      // 老服务端事件缺 session_id：无法定位会话，整体收尾（与旧版单运行行为一致）
      _log("warn", "STORE", "completeRun ws=" + wsId.slice(0, 8) + " 缺 session_id → 整体收尾");
      ws.runs.clear();
      ws.queued.clear();
      ws.runStatsBySession.clear();
    }
    this._publishRuns(wsId, ws);
    return { tookOver: tookOver };
  }

  // 注销运行。传 sessionId = 只清该会话（停止按钮 / 安全超时，不影响并行运行的其它会话）；
  // 不传 = 清空整个工作区（断线重连、清除全部对话等整体重置场景）
  cancelRun(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    _log("warn", "STORE", "cancelRun ws=" + wsId.slice(0, 8) + (sessionId ? " session=" + sessionId.slice(0, 8) : " (全工作区)"));
    if (sessionId) {
      ws.runs.delete(sessionId);
      ws.queued.delete(sessionId);
      ws.runStatsBySession.delete(sessionId);
    } else {
      ws.runs.clear();
      ws.queued.clear();
      ws.runStatsBySession.clear();
    }
    this._publishRuns(wsId, ws);
  }

  clearQueuedRun(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (sessionId) ws.queued.delete(sessionId);
    else ws.queued.clear();
    this._publishRuns(wsId, ws);
  }

  isBusy(wsId) {
    var ws = this.workspaces.get(wsId);
    return ws ? ws.isSending : false;
  }

  // 该会话是否已有活动运行（同会话再发即为排队/折叠插入）
  hasRun(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    return !!(ws && sessionId && ws.runs.has(sessionId));
  }

  getRun(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    return (ws && sessionId) ? (ws.runs.get(sessionId) || null) : null;
  }

  // 正在运行的会话数（并发上限判定；排队轮次不计入）
  runningCount(wsId) {
    var ws = this.workspaces.get(wsId);
    return ws ? ws.runs.size : 0;
  }

  // isQueued 供渲染/状态判定：该会话是否有排队中的轮次
  isQueued(wsId, sessionId) {
    var ws = this.workspaces.get(wsId);
    var list = (ws && sessionId) ? ws.queued.get(sessionId) : null;
    return !!(list && list.length > 0);
  }

  setRunStats(wsId, stats) {
    var ws = this.workspaces.get(wsId);
    if (!ws || !stats || !stats.sessionId) return;
    ws.runStatsBySession.set(stats.sessionId, stats);
    this._publishRuns(wsId, ws);
  }

  // ===== Session 事件（后台 workspace 也需要更新状态池） =====
  handleSessionEvent(wsId, action, sessData) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    // 子 Agent（agent 工具 / agentic_fetch）的内部子会话带 parent_session_id，不属于
    // 「对话记录」列表：REST 列表接口按 `parent_session_id IS NULL` 过滤（服务端
    // sessions.sql.go），若在此按 SSE 事件插入，本轮 run_complete 重新拉取列表时又会被
    // 移掉——表现为列表里临时闪现一条对话记录。三种动作统一在此拦截。
    var parentId = sessData.parent_session_id;
    if (parentId !== undefined && parentId !== null && parentId !== "") {
      _log("debug", "STORE", "handleSessionEvent 跳过子 Agent 子会话 " + action + " session=" + String(sessData.id).slice(0, 24));
      return;
    }
    if (action === "created") {
      if (!ws.conversations.some(function(c) { return c.id === sessData.id; })) {
        var newList = ws.conversations.slice();
        newList.unshift(sessData);
        this.setConversations(wsId, newList);
      }
    } else if (action === "updated") {
      var idx = ws.conversations.findIndex(function(c) { return c.id === sessData.id; });
      if (idx >= 0) {
        var updatedList = ws.conversations.slice();
        updatedList[idx] = sessData;
        this.setConversations(wsId, updatedList);
      }
      if (ws.currentConvId === sessData.id) {
        this.setCurrentConv(wsId, sessData);
        if (sessData.context_tokens) {
          this.setContextUsage(wsId, sessData.context_tokens, ws.contextUsage.max, false);
        }
      }
    } else if (action === "deleted") {
      var filtered = ws.conversations.filter(function(c) { return c.id !== sessData.id; });
      this.setConversations(wsId, filtered);
      if (ws.currentConvId === sessData.id) {
        this.setCurrentConvId(wsId, null);
        this.setCurrentConv(wsId, null);
        // 与会话删除的 UI handler 一致：清空消息列表，避免切回时残留旧消息
        this.setMessages(wsId, []);
      }
    }
  }

  // ===== SSE 事件统一入口 =====
  handleSSEEvent(wsId, eventPayload) {
    var rawData = eventPayload.data || eventPayload;
    var eventType = rawData.type || eventPayload.type || "";
    var eventPayloadInner = rawData.payload || {};
    var innerType = eventPayloadInner.type || "";
    var actualData = eventPayloadInner.payload || eventPayloadInner || {};

    this.registerWorkspace(wsId);

    switch (eventType) {
    case "message":
      // 会话隔离：message 是 workspace 级广播，同 workspace 其它会话（并发运行、后台 Bot）
      // 的消息不得并入当前打开会话的消息池，否则任意一次渲染（发消息/切回会话/错误气泡）
      // 都会把它们闪现进当前会话，refreshMessages 后再消失。
      // session_id 或 currentConvId 缺失时不拦截（老事件 / 无会话场景保持原行为）
      var msgWs = this.workspaces.get(wsId);
      if (msgWs && actualData && actualData.session_id && msgWs.currentConvId &&
          actualData.session_id !== msgWs.currentConvId) {
        _log("debug", "STORE", "handleSSEEvent 跳过非当前会话消息 session=" + String(actualData.session_id).slice(0, 8) + " current=" + String(msgWs.currentConvId).slice(0, 8));
        break;
      }
      if (innerType === "created") this.upsertCreatedMessage(wsId, actualData);
      else if (innerType === "updated") this.updateMessage(wsId, actualData);
      else if (innerType === "deleted") this.deleteMessage(wsId, (actualData && actualData.id) || "");
      break;
      case "session":
        this.handleSessionEvent(wsId, innerType, actualData);
        break;
      case "run_complete":
        // 子 Agent（agent 工具嵌套调用）的 run_complete 携带复合 session_id
        //（格式 `{parentMsgId}$${toolCallId}`，tool call id 前缀随 provider 不同，
        // 如 OpenAI `call_`、Qwen `chatcmpl-tool-`），且 run_id 继承父运行，
        // 绝不能让它误触发父运行的 completeRun（会清空 isSending/activeRun）。
        var rcSession = actualData.session_id || "";
        if (typeof rcSession === "string" && rcSession.indexOf("$$") !== -1) {
          _log("debug", "STORE", "handleSSEEvent 跳过子 Agent run_complete session=" + rcSession.slice(0, 20) + "...");
          break;
        }
        // 只注销该会话的运行：同工作区其它会话的并行运行不受影响（见文件头运行登记说明）。
        // 传 run_id 以便识别「迟到的旧运行完成事件」，避免误清该会话的新一轮运行
        return this.completeRun(wsId, rcSession, actualData.run_id || "");
    }
  }
}

// 单例
export const store = new Store();

// S — 只读视图：始终反映 active workspace 的状态快照
export const S = {
  // workspace 状态（由 bindToS 从 active workspace 同步；初始即冻结，绑定前不可写）
  conversations: Object.freeze([]),
  currentConvId: null,
  currentConv: null,
  messages: Object.freeze([]),
  isSending: false,
  activeRun: null,
  queuedRun: null,
  runStats: null,
  // 本工作区全部运行（含排队轮次）的只读快照：[{workspaceId, sessionId, runId, queued}]
  runs: Object.freeze([]),
  contextUsage: Object.freeze({ used: 0, max: 0, estimated: false }),
  agentInfo: null,
  // 全局状态（直接读写，不走 workspace 隔离）
  unlisteners: [],
  clientId: null,
  serverInfo: null,
  settings: null,
  providers: [],
  serverProviders: [],
  serverProvidersLoaded: false,
  pendingProviderKeys: {},
  localModels: [],
  workspaceInfo: null,
  pendingFiles: [],
  sendSafetyTimer: null,
  manualScrollMode: false,
  programmaticScroll: false,
  lastProgrammaticScroll: 0,
  pendingModelReload: false,
  agentInfoSeq: 0,
  toolsTab: "skill",
  toolsData: { skill: [], lsp: [], mcp: [] },
  todosCollapsed: false,
  initSeq: 0,
  sseListener: null,
  sseErrorUnlisten: null,
  sseReconnectTimer: null,
  workspaces: {},
  activeWsId: null,
  // path → wsId 映射：工作目录删除（remove_workdir / validate_workdirs）时
  // 用于清理对应 workspace 的状态池条目
  wsIdByPath: {},
};
