// WorkspaceStateStore — 统一 Agent 状态管理
// 所有状态写入走 Store 细粒度方法；S 为只读视图（active workspace 快照），
// 仅用于读取，禁止写入。invoke / listen 从这里导出供其他模块使用。

export const invoke = window.__adm_invoke;
export const listen = window.__adm_listen;

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
      conversations: this.conversations,
      currentConvId: this.currentConvId,
      currentConv: this.currentConv,
      messages: this.messages,
      isSending: this.isSending,
      activeRun: this.activeRun,
      queuedRun: this.queuedRun,
      runStats: this.runStats,
      contextUsage: { ...this.contextUsage },
      agentInfo: this.agentInfo,
    };
  }

  restore(snap) {
    if (!snap) return;
    this.conversations = snap.conversations || [];
    this.currentConvId = snap.currentConvId || null;
    this.currentConv = snap.currentConv || null;
    this.messages = snap.messages || [];
    this.isSending = snap.isSending || false;
    this.activeRun = snap.activeRun || null;
    this.queuedRun = snap.queuedRun || null;
    this.runStats = snap.runStats || null;
    this.contextUsage = snap.contextUsage || { used: 0, max: 0, estimated: false };
    this.agentInfo = snap.agentInfo || null;
  }
}

// ===== Store =====
class Store {
  constructor() {
    this.workspaces = new Map();
    this.activeWsId = null;
    this.workspacesObj = {};
    this._listeners = new Set();
  }

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit(type, wsId, payload) { for (const fn of this._listeners) fn({ type, wsId, payload }); }

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
    S.conversations = ws.conversations;
    S.currentConvId = ws.currentConvId;
    S.currentConv = ws.currentConv;
    S.messages = ws.messages;
    S.isSending = ws.isSending;
    S.activeRun = ws.activeRun;
    S.queuedRun = ws.queuedRun;
    S.runStats = ws.runStats;
    S.contextUsage = ws.contextUsage;
    S.agentInfo = ws.agentInfo;
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
    this.emit("activeChange", wsId, {});
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
    this.emit("sessionChange", wsId, ws);
  }

  setConversations(wsId, list) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.conversations = list;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
    this.emit("conversationsChange", wsId, ws);
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

  appendMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (!ws.messages.some(function(m) { return m.id === msg.id; })) {
      ws.messages.push(msg);
      this.workspacesObj[wsId] = ws.snapshot();
    }
  }

  updateMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var idx = ws.messages.findIndex(function(m) { return m.id === msg.id; });
    if (idx >= 0) ws.messages[idx] = msg;
    else ws.messages.push(msg);
    this.workspacesObj[wsId] = ws.snapshot();
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
    ws.isSending = true;
    ws.activeRun = { workspaceId: wsId, sessionId: sessionId, runId: runId };
    ws.queuedRun = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
    this.emit("runStart", wsId, ws);
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
      ws.activeRun = ws.queuedRun;
      ws.queuedRun = null;
    } else {
      ws.isSending = false;
      ws.activeRun = null;
      // 非接管：清理 runStats。active ws 的 maybeAutoContinue 用的是
      // sse.js listener 在处理前快照的 prevRunStats，不受此处清空影响；
      // 后台 ws 没有 sse.js 清理逻辑，必须在此清理避免残留
      ws.runStats = null;
    }
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
    this.emit("runComplete", wsId, ws);
  }

  cancelRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.isSending = false;
    ws.activeRun = null;
    ws.queuedRun = null;
    ws.runStats = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS();
    this.emit("runCancel", wsId, ws);
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

  // ===== SSE 事件统一入口 =====
  handleSSEEvent(wsId, eventPayload) {
    var rawData = eventPayload.data || eventPayload;
    var eventType = rawData.type || eventPayload.type || "";
    var eventPayloadInner = rawData.payload || {};
    var innerType = eventPayloadInner.type || "";
    var actualData = eventPayloadInner.payload || eventPayloadInner || {};

    this.registerWorkspace(wsId);
    var isActive = wsId === this.activeWsId;

    switch (eventType) {
      case "message":
        if (innerType === "created") this.appendMessage(wsId, actualData);
        else if (innerType === "updated") this.updateMessage(wsId, actualData);
        break;
      case "run_complete":
        this.completeRun(wsId);
        break;
    }

    if (isActive) {
      this.emit("sseEvent", wsId, { eventType: eventType, innerType: innerType, actualData: actualData });
    }
  }
}

// 单例
export const store = new Store();

// S — 只读视图：始终反映 active workspace 的状态快照
export const S = {
  // workspace 状态（由 bindToS 从 active workspace 同步）
  conversations: [],
  currentConvId: null,
  currentConv: null,
  messages: [],
  isSending: false,
  activeRun: null,
  queuedRun: null,
  runStats: null,
  contextUsage: { used: 0, max: 0, estimated: false },
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
  manualModeExitTimer: null,
  programmaticScroll: false,
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
};
