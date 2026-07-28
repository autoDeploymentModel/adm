// Agent 视图共享状态 —— 各子模块通过 S 对象读写（单一数据源）。
// 拆分自原 agent.js 的模块级变量；ESM 导入绑定不可被导入方重新赋值，故统一挂在 S 上。

export const invoke = window.__adm_invoke;
export const listen = window.__adm_listen;

/**
 * @typedef {Object} AgentState
 * @property {Array<() => void>} unlisteners
 * @property {string | null} clientId UUID，客户端标识
 * @property {{ port?: number, workspace_id: string } | null} serverInfo
 * @property {any} settings { agent_yolo, agent_default_provider, ... }
 * @property {any[]} providers cloud providers list
 * @property {any[]} serverProviders admAgent 服务端 /providers 完整列表（含内置模型）
 * @property {boolean} serverProvidersLoaded 是否已成功取得服务端 provider 快照
 * @property {Object<string, boolean>} pendingProviderKeys 已写盘但尚未被服务端确认的 provider
 * @property {any[]} localModels 本地模型列表 (来自 scan_local_models)
 * @property {any[]} conversations 会话列表
 * @property {string | null} currentConvId
 * @property {any} currentConv 当前会话详情
 * @property {any} messages 当前消息列表（正常为数组，接口异常时可能是包装对象）
 * @property {(() => void) | null} sseListener
 * @property {(() => void) | null} sseErrorUnlisten
 * @property {any} sseReconnectTimer
 * @property {boolean} isSending
 * @property {{ workspaceId: string, sessionId: string, runId: string } | null} activeRun 实际运行身份，不随 UI 会话切换
 * @property {{ used: number, max: number, estimated: boolean }} contextUsage
 * @property {"current" | "all"} sessionViewMode
 * @property {{ id?: string, path: string, name: string } | null} workspaceInfo
 * @property {any} agentInfo Agent 状态信息 (当前模型等)
 * @property {any[]} pendingFiles 待发送附件 [{name, type, size, base64, dataUrl}]
 * @property {any} sendSafetyTimer
 * @property {Object<string, boolean>} permissionAutoAllow
 * @property {any[]} pendingPermissions
 * @property {any} currentPermission
 * @property {boolean} manualScrollMode
 * @property {any} manualModeExitTimer
 * @property {boolean} pendingModelReload
 * @property {number} agentInfoSeq
 * @property {"skill" | "lsp" | "mcp"} toolsTab
 * @property {{ skill: any[], lsp: any[], mcp: any[] }} toolsData
 * @property {boolean} todosCollapsed
 * @property {number} initSeq
 */

/** @type {AgentState} */
export const S = {
  unlisteners: [],
  clientId: null,   // UUID，客户端标识
  serverInfo: null, // { port, workspace_id }
  settings: null,   // { agent_yolo, agent_default_provider, ... }
  providers: [],    // cloud providers list
  serverProviders: [], // admAgent 服务端 /providers 返回的完整 provider 列表（含内置模型）
  serverProvidersLoaded: false, // 成功取得服务端快照后为 true；空数组也代表有效快照
  pendingProviderKeys: {}, // 已写盘但运行时同步失败的 provider，不进入模型下拉
  localModels: [],  // 本地模型列表 (来自 scan_local_models)
  conversations: [], // 会话列表
  currentConvId: null,
  currentConv: null,  // 当前会话详情
  messages: [],       // 当前消息列表
  sseListener: null,
  sseErrorUnlisten: null, // SSE 错误事件 unlisten（避免重复注册）
  sseReconnectTimer: null, // SSE 重连定时器
  isSending: false,
  activeRun: null, // { workspaceId, sessionId, runId }，计时器/取消/完成都绑定该运行
  contextUsage: { used: 0, max: 0, estimated: false },
  sessionViewMode: "current", // "current" | "all"
  workspaceInfo: null, // { id, path, name }
  agentInfo: null,    // Agent 状态信息 (当前模型等)
  pendingFiles: [],   // 待发送附件列表 [{name, type, size, base64, dataUrl}]
  sendSafetyTimer: null, // isSending 安全超时定时器（3分钟无任何 SSE 活动则自动重置，收到消息事件会续期）
  permissionAutoAllow: {}, // 客户端"本次会话记住"缓存 key: tool|action → true（服务端 allow_session 按 工具+操作+路径 匹配，路径变化仍会弹窗，客户端兜底）
  pendingPermissions: [],  // 弹窗打开期间到达的后续权限请求队列（避免覆盖当前请求导致其永远得不到应答）
  currentPermission: null, // 当前弹窗正在处理的权限请求
  manualScrollMode: false,   // 手动模式：鼠标在消息区内，暂停自动滚底，保留滚动位置与折叠块展开状态
  manualModeExitTimer: null, // 鼠标离开消息区 1 秒后恢复自动模式的定时器
  pendingModelReload: false, // 切换模型时 /agent/update 失败（如会话繁忙）→ 挂起，run_complete/下次发送前重试
  agentInfoSeq: 0,           // agentInfo 刷新序号：只应用最新一次请求的结果，防止旧响应把切换后的模型覆盖回旧值
  toolsTab: "skill",         // 工具面板当前 tab: "skill" | "lsp" | "mcp"
  toolsData: { skill: [], lsp: [], mcp: [] }, // 各 tab 工具缓存 [{name, status, statusColor, title}]
  todosCollapsed: false,     // Todo 固定面板折叠状态（仅影响展示，不影响数据更新）
  initSeq: 0,                // init() 版本号：unmount/重新 mount 时递增，旧的在途 init 检测到过期后立即终止，防止并发 init 互相踩踏
};
