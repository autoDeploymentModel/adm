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
    this.contextUsage = { used: 0, max: 0, estimated: false };
    this.agentInfo = null;
  }

  snapshot() {
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
    this.contextUsage = snap.contextUsage ? Object.assign({}, snap.contextUsage) : { used: 0, max: 0, estimated: false };
    this.agentInfo = snap.agentInfo ? Object.assign({}, snap.agentInfo) : null;
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
    S.contextUsage = _frozenObj(ws.contextUsage);
    S.agentInfo = ws.agentInfo ? _frozenObj(ws.agentInfo) : null;
    S.workspaces = this.workspacesObj;
    S.activeWsId = this.activeWsId;
    if (S.serverInfo) S.serverInfo.workspace_id = this.activeWsId;
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

  // 服务端消息覆盖 + 保留折叠插入的待落库气泡（_fold）：
  // 折叠插入的消息在服务端下一步边界才会创建，切会话/切页面/刷新时若直接覆盖
  // 会被抹掉；这里把本地仍在等待落库、且属于 convId 会话的 _fold 用户气泡按内容
  // 去重后合并追加到末尾。仅保留 _fold（不复活普通发送/排队发送的 _temp 临时气泡），
  // 且限定会话归属（防止把上一会话的待插入气泡串进当前会话列表）
  setMessagesKeepPending(wsId, serverMsgs, convId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var merged = (serverMsgs || []).slice();
    var pendingFolds = [];
    ws.messages.forEach(function(m) {
      if (!m._temp || !m._fold || m.role !== "user") return;
      if (convId && m._sessionId && m._sessionId !== convId) return;
      var onServer = merged.some(function(sm) {
        if (sm.role !== "user") return false;
        var sText = (sm.content || getTextFromParts(sm.parts)) || "";
        return m.content === stripSystemInfoText(sText);
      });
      if (!onServer) pendingFolds.push(m);
    });
    if (pendingFolds.length > 0) merged = merged.concat(pendingFolds);
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

  // ===== 运行状态 =====
  startRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    _log("debug", "STORE", "startRun ws=" + wsId.slice(0, 8) + " session=" + (sessionId || "").slice(0, 8) + " run=" + runId);
    ws.isSending = true;
    ws.activeRun = { workspaceId: wsId, sessionId: sessionId, runId: runId };
    ws.queuedRun = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  setQueuedRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.queuedRun = { workspaceId: wsId, sessionId: sessionId, runId: runId };
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  // 排队运行接管：取消当前运行后排队中的运行立即开始
  promoteQueuedRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws || !ws.queuedRun) return;
    ws.activeRun = ws.queuedRun;
    ws.queuedRun = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  completeRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (ws.queuedRun) {
      _log("debug", "STORE", "completeRun ws=" + wsId.slice(0, 8) + " → 排队运行接管");
      ws.activeRun = ws.queuedRun;
      ws.queuedRun = null;
    } else {
      _log("debug", "STORE", "completeRun ws=" + wsId.slice(0, 8) + " → isSending=false");
      ws.isSending = false;
      ws.activeRun = null;
      // 非接管：清理 runStats。active ws 的 maybeAutoContinue 用的是
      // sse.js listener 在处理前快照的 prevRunStats，不受此处清空影响；
      // 后台 ws 没有 sse.js 清理逻辑，必须在此清理避免残留
      ws.runStats = null;
    }
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  cancelRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    _log("warn", "STORE", "cancelRun ws=" + wsId.slice(0, 8));
    ws.isSending = false;
    ws.activeRun = null;
    ws.queuedRun = null;
    ws.runStats = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  clearQueuedRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.queuedRun = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  isBusy(wsId) {
    var ws = this.workspaces.get(wsId);
    return ws ? ws.isSending : false;
  }

  setRunStats(wsId, stats) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.runStats = stats;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
  }

  // ===== Session 事件（后台 workspace 也需要更新状态池） =====
  handleSessionEvent(wsId, action, sessData) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
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
      if (innerType === "created") this.upsertCreatedMessage(wsId, actualData);
      else if (innerType === "updated") this.updateMessage(wsId, actualData);
      else if (innerType === "deleted") this.deleteMessage(wsId, (actualData && actualData.id) || "");
      break;
      case "session":
        this.handleSessionEvent(wsId, innerType, actualData);
        break;
      case "run_complete":
        // 子 Agent（agent 工具嵌套调用）的 run_complete 携带复合 session_id
        //（格式 `{parentMsgId}$$call_{toolCallId}`）且 run_id 为空，
        // 绝不能让它误触发父运行的 completeRun（会清空 isSending/activeRun）。
        var rcSession = actualData.session_id || "";
        if (typeof rcSession === "string" && rcSession.indexOf("$$call_") !== -1) {
          _log("debug", "STORE", "handleSSEEvent 跳过子 Agent run_complete session=" + rcSession.slice(0, 20) + "...");
          break;
        }
        this.completeRun(wsId);
        break;
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
  sessionViewMode: "current",
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
  autoContinue: { armedSession: null, rounds: 0, lastIncomplete: -1, noProgress: 0 },
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
