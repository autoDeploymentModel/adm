// 统一错误提取与分类（纯函数，无 DOM / 共享状态依赖）
// 服务端错误可能以多种形态到达前端：
//   - 字符串（如 Rust 侧 bail 的 "HTTP 401 POST /path: <body片段>"、"HTTP 请求失败: ..."）
//   - Error 对象（invoke 抛出的异常）
//   - 结构化对象（如 SSE 事件里的 {"error":{"message":"...","type":"..."}}）
// 这里统一提取为可读文本，并给出分类，供 UI 层统一展示。

/** 错误分类常量 */
export var ERROR_QUOTA = "quota";       // 余额不足 / 401 / 授权失败
export var ERROR_TIMEOUT = "timeout";   // 请求超时
export var ERROR_NETWORK = "network";   // 连接失败 / server 未运行 / 断线
export var ERROR_NOT_FOUND = "not_found"; // 资源不存在
export var ERROR_CANCEL = "cancel";     // 已取消
export var ERROR_UNKNOWN = "unknown";   // 其它

/**
 * 从任意错误值提取用户可读文本。
 * 兼容：string、Error、{"error":{"message","type"}}、{"message"}、其它对象（JSON 兜底）。
 * @param {*} err
 * @returns {string}
 */
export function getErrorMessage(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object") {
    var inner = (err.error && typeof err.error === "object") ? err.error : err;
    if (typeof inner.message === "string" && inner.message) {
      return inner.message + (inner.type ? " (" + inner.type + ")" : "");
    }
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }
  return String(err);
}

// 分类关键词（大小写不敏感）。注意：不包含裸 "quota"（rpm exhausted 属速率限制而非余额不足，避免误报）。
var QUOTA_RE = /401|unauthorized|insufficient|balance|billing|payment|credits|余额|欠费|没有费用|no funds/i;
var TIMEOUT_RE = /timeout|timed out|超时/i;
var NETWORK_RE = /请求失败|连接失败|connect|refused|ECONN|未运行|断线|重连|network|socket/i;
var NOT_FOUND_RE = /404|不存在|not found/i;
var CANCEL_RE = /canceled|cancelled|已取消/i;

/**
 * 错误分类：优先匹配更具体的类别，未命中返回 unknown。
 * @param {*} err
 * @returns {string} 见 ERROR_* 常量
 */
export function classifyError(err) {
  var text = getErrorMessage(err);
  if (QUOTA_RE.test(text)) return ERROR_QUOTA;
  if (TIMEOUT_RE.test(text)) return ERROR_TIMEOUT;
  if (NETWORK_RE.test(text)) return ERROR_NETWORK;
  if (NOT_FOUND_RE.test(text)) return ERROR_NOT_FOUND;
  if (CANCEL_RE.test(text)) return ERROR_CANCEL;
  return ERROR_UNKNOWN;
}
