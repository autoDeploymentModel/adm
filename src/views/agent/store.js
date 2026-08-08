// WorkspaceStateStore — 统一 Agent 状态管理
// S 是一个 Proxy：对 workspace 字段的赋值自动同步到 active workspace，
// 消除手动 syncWsFromS 调用。全局状态字段直接存储在 _rawS 上。
// invoke / listen 从这里导出供其他模块使用。

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

// ===== Proxy: S 的 workspace 字段赋值自动同步到 active workspace =====

// workspace 状态字段集合 — 对这些字段的赋值会自动同步到 active workspace
const WS_FIELDS = new Set([
  "conversations", "currentConvId", "currentConv", "messages",
  "isSending", "activeRun", "queuedRun", "runStats",
  "contextUsage", "agentInfo",
]);

// forward reference — Proxy 闭包中使用，store 创建后赋值
let _store = null;
// bindToS / restore 期间抑制自动同步（批量赋值由方法内部自行处理快照）
let _suppressSync = false;

// 原始数据对象
const _rawS = {
  // workspace 状态（bindToS 时更新为 active workspace 的引用）
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
  // 全局状态
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
  // 多 workspace 状态池（快照）
  workspaces: {},
  activeWsId: null,
};

// S = Proxy：拦截 workspace 字段的 set，自动同步到 active workspace
const S = new Proxy(_rawS, {
  set(target, prop, value) {
    target[prop] = value;
    // workspace 字段且非批量同步期间：自动同步到 active workspace
    if (!_suppressSync && _store && WS_FIELDS.has(prop) && _store.activeWsId) {
      var ws = _store.workspaces.get(_store.activeWsId);
      if (ws) {
        ws[prop] = value;
        _store.workspacesObj[_store.activeWsId] = ws.snapshot();
      }
    }
    return true;
  },
});

// ===== Store =====
class Store {
  constructor() {
    this.workspaces = new Map();
    this.activeWsId = null;
    this.workspacesObj = {};
    this._listeners = null;
  }

  subscribe(fn) { this._listeners = this._listeners || new Set(); this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit(type, wsId, payload) { if (!this._listeners) return; for (const fn of this._listeners) fn({ type, wsId, payload }); }

  registerWorkspace(wsId) {
    if (!this.workspaces.has(wsId)) {
      var ws = new WorkspaceState();
      this.workspaces.set(wsId, ws);
      this.workspacesObj[wsId] = ws.snapshot();
    }
  }

  getActiveWs() {
    return this.workspaces.get(this.activeWsId);
  }

  // 绑定 S 的 workspace 字段到 active workspace 的真实引用
  // 使用 _suppressSync 避免批量赋值时逐字段触发快照
  bindToS(ws) {
    _suppressSync = true;
    _rawS.conversations = ws.conversations;
    _rawS.currentConvId = ws.currentConvId;
    _rawS.currentConv = ws.currentConv;
    _rawS.messages = ws.messages;
    _rawS.isSending = ws.isSending;
    _rawS.activeRun = ws.activeRun;
    _rawS.queuedRun = ws.queuedRun;
    _rawS.runStats = ws.runStats;
    _rawS.contextUsage = ws.contextUsage;
    _rawS.agentInfo = ws.agentInfo;
    _rawS.workspaces = this.workspacesObj;
    _rawS.activeWsId = this.activeWsId;
    _suppressSync = false;
    // 批量绑定后统一更新快照
    if (this.activeWsId) {
      this.workspacesObj[this.activeWsId] = ws.snapshot();
    }
  }

  // S 写入后同步回 workspace — Proxy 自动同步后此方法为冗余安全网
  syncWsFromS(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.conversations = _rawS.conversations;
    ws.currentConvId = _rawS.currentConvId;
    ws.currentConv = _rawS.currentConv;
    ws.messages = _rawS.messages;
    ws.isSending = _rawS.isSending;
    ws.activeRun = _rawS.activeRun;
    ws.queuedRun = _rawS.queuedRun;
    ws.runStats = _rawS.runStats;
    ws.contextUsage = _rawS.contextUsage;
    ws.agentInfo = _rawS.agentInfo;
    this.workspacesObj[wsId] = ws.snapshot();
  }

  setActive(wsId) {
    console.log("[STORE] store.setActive: old=" + this.activeWsId + " new=" + wsId);
    // 保存当前 workspace 状态到快照
    if (this.activeWsId) {
      this.syncWsFromS(this.activeWsId);
    }
    this.activeWsId = wsId;
    if (_rawS.serverInfo) _rawS.serverInfo.workspace_id = wsId;
    this.registerWorkspace(wsId);
    var target = this.workspaces.get(wsId);
    var saved = this.workspacesObj[wsId];
    if (saved && target) {
      target.restore(saved);
      console.log("[STORE] store.setActive: restored ws=" + wsId + " isSending=" + target.isSending + " msgs=" + target.messages.length + " convId=" + target.currentConvId);
    }
    // 绑定 S 到 active workspace 的真实引用
    this.bindToS(target);
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
    if (wsId === this.activeWsId) this.bindToS(ws);
    this.emit("sessionChange", wsId, ws);
  }

  appendMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    if (!ws.messages.some(m => m.id === msg.id)) {
      ws.messages.push(msg);
      this.workspacesObj[wsId] = ws.snapshot();
    }
  }

  updateMessage(wsId, msg) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    var idx = ws.messages.findIndex(m => m.id === msg.id);
    if (idx >= 0) ws.messages[idx] = msg;
    else ws.messages.push(msg);
    this.workspacesObj[wsId] = ws.snapshot();
  }

  // ===== 运行状态 =====
  startRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) { console.log("[STORE] store.startRun: ws not found " + wsId); return; }
    ws.isSending = true;
    ws.activeRun = { workspaceId: wsId, sessionId, runId };
    ws.queuedRun = null;
    console.log("[STORE] store.startRun: ws=" + wsId + " session=" + sessionId + " runId=" + runId);
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS(ws);
    this.emit("runStart", wsId, ws);
  }

  // 设置排队运行（workspace 忙时新消息入队）
  setQueuedRun(wsId, sessionId, runId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.queuedRun = { workspaceId: wsId, sessionId, runId };
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS(ws);
  }

  completeRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) { console.log("[STORE] store.completeRun: ws not found " + wsId); return; }
    if (ws.queuedRun) {
      ws.activeRun = ws.queuedRun;
      ws.queuedRun = null;
      // 接管：runStats 属于排队中的会话（发送时已初始化），保留给其实际执行轮使用
      console.log("[STORE] store.completeRun: queued takeover ws=" + wsId + " new active=" + ws.activeRun.sessionId);
    } else {
      ws.isSending = false;
      ws.activeRun = null;
      // 非接管：清理 runStats。active ws 的 maybeAutoContinue 用的是
      // sse.js listener 在处理前快照的 prevRunStats，不受此处清空影响；
      // 后台 ws 没有 sse.js 清理逻辑，必须在此清理避免残留
      ws.runStats = null;
      console.log("[STORE] store.completeRun: idle ws=" + wsId);
    }
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS(ws);
    this.emit("runComplete", wsId, ws);
  }

  cancelRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) { console.log("[STORE] store.cancelRun: ws not found " + wsId); return; }
    ws.isSending = false;
    ws.activeRun = null;
    ws.queuedRun = null;
    ws.runStats = null;
    console.log("[STORE] store.cancelRun: ws=" + wsId);
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS(ws);
    this.emit("runCancel", wsId, ws);
  }

  // 清除排队运行（排队发送失败时调用，不影响 activeRun）
  clearQueuedRun(wsId) {
    var ws = this.workspaces.get(wsId);
    if (!ws) return;
    ws.queuedRun = null;
    this.workspacesObj[wsId] = ws.snapshot();
    if (wsId === this.activeWsId) this.bindToS(ws);
  }

  isBusy(wsId) {
    var ws = this.workspaces.get(wsId);
    return ws ? ws.isSending : false;
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

    console.log("[STORE] store.handleSSE: " + eventType + "/" + innerType + " ws=" + wsId + " active=" + isActive + " activeWs=" + this.activeWsId +
      (eventType === "message" ? " role=" + actualData.role + " id=" + actualData.id + " session=" + actualData.session_id + " currentConv=" + (this.getActiveWs() ? this.getActiveWs().currentConvId : "null") : "") +
      (eventType === "run_complete" ? " run_id=" + actualData.run_id + " session=" + actualData.session_id : ""));

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
      this.emit("sseEvent", wsId, { eventType, innerType, actualData });
    }
  }
}

// 单例
export const store = new Store();
_store = store; // 连接 Proxy forward reference
export { S };
