// 统一错误提取、分类与友好提示（纯函数，无 DOM / 共享状态依赖）
// 服务端错误可能以多种形态到达前端：
//   - 字符串（如 Rust 侧 bail 的 "HTTP 401 POST /path: <body片段>"、"HTTP 请求失败: ..."）
//   - Error 对象（invoke 抛出的异常）
//   - 结构化对象（如 SSE 事件里的 {"error":{"message":"...","type":"..."}}）
// 这里统一提取为可读文本并分类（getErrorMessage / classifyError），
// 再由 friendlyError 按当前 UI 语言生成友好提示：
//   - 中文界面：输出全中文（原始英文错误按模式翻译，翻译后仍有英文残留则
//     只显示分类友好文案，绝不让英文报错直接出现在中文界面）
//   - 英文界面：英文友好提示 + 原始错误细节（便于排查）
import { getLanguage, t } from "../../i18n.js";

/** 错误分类常量 */
export var ERROR_QUOTA = "quota";            // 余额不足 / 401 / API 密钥无效
export var ERROR_USAGE_LIMIT = "usage_limit"; // 月度使用配额限制（如 OpenCode/Go GoUsageLimitError），区别于余额不足
export var ERROR_RATE_LIMIT = "rate_limit";   // 速率限制（rpm/tpm exceeded）
export var ERROR_TIMEOUT = "timeout";        // 请求超时
export var ERROR_NETWORK = "network";        // 连接失败 / server 未运行 / 断线
export var ERROR_NOT_FOUND = "not_found";    // 资源不存在
export var ERROR_CONTEXT_OVERFLOW = "context_overflow"; // 上下文超出模型支持的长度
export var ERROR_CANCEL = "cancel";          // 已取消
export var ERROR_STEP_CAP = "step_cap";      // 步数触顶（模型仍在干活但本轮预算耗尽，非故障）
export var ERROR_UNKNOWN = "unknown";        // 其它

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

/**
 * 从任意错误值提取 ProviderError / 结构化错误对象的 type 字段。
 * LLM Provider（OpenAI/Anthropic/fantasy/OpenCode Go 等）会在错误里塞 type/code
 * 字段（如 "GoUsageLimitError"、"RateLimitError"、"InsufficientQuotaError"），
 * 这是比 message 文本更稳定的分类依据——文本可能含 "available balance" 等无关词
 * 干扰关键词匹配，而 type 名由 Provider 强制保证语义。
 * @param {*} err
 * @returns {string} type 字段，没有则返回 ""
 */
export function getErrorType(err) {
  if (err == null || typeof err !== "object") return "";
  var inner = (err.error && typeof err.error === "object") ? err.error : err;
  return typeof inner.type === "string" ? inner.type : "";
}

// 已知 ProviderError type → 错误分类的精确映射。
// 仅映射语义明确、跨 Provider 公认的类型；未命中走正则兜底，避免过度耦合。
// Provider type 名参考 OpenAI / Anthropic / charm.land/fantasy / OpenCode Go 的实际错误名。
var TYPE_TO_CLASS = {};
// 月度/订阅使用配额限制（OpenCode Go GoUsageLimitError 等）——区别于余额不足
TYPE_TO_CLASS["GoUsageLimitError"] = ERROR_USAGE_LIMIT;
TYPE_TO_CLASS["MonthlyUsageLimitError"] = ERROR_USAGE_LIMIT;
TYPE_TO_CLASS["SubscriptionLimitError"] = ERROR_USAGE_LIMIT;
// 速率限制（rpm/tpm exceeded）——区别于余额不足
TYPE_TO_CLASS["RateLimitError"] = ERROR_RATE_LIMIT;
TYPE_TO_CLASS["RateLimitReachedError"] = ERROR_RATE_LIMIT;
TYPE_TO_CLASS["TooManyRequestsError"] = ERROR_RATE_LIMIT;
TYPE_TO_CLASS["rate_limit_error"] = ERROR_RATE_LIMIT; // OpenAI snake_case 变体
// 余额不足 / 授权失败
TYPE_TO_CLASS["InsufficientQuotaError"] = ERROR_QUOTA;
TYPE_TO_CLASS["QuotaExceededError"] = ERROR_QUOTA;
TYPE_TO_CLASS["AuthenticationError"] = ERROR_QUOTA;
TYPE_TO_CLASS["InvalidAPIKeyError"] = ERROR_QUOTA;
TYPE_TO_CLASS["InvalidApiKeyError"] = ERROR_QUOTA;
TYPE_TO_CLASS["UnauthorizedError"] = ERROR_QUOTA;
// Provider 服务端错误 / 上游不可用（Anthropic api_error/overloaded_error、OpenAI server_error 等）
TYPE_TO_CLASS["server_error"] = ERROR_NETWORK;
TYPE_TO_CLASS["api_error"] = ERROR_NETWORK;
TYPE_TO_CLASS["overloaded_error"] = ERROR_NETWORK;
// 上下文超限
TYPE_TO_CLASS["ContextLengthExceededError"] = ERROR_CONTEXT_OVERFLOW;

/**
 * 按错误对象的 type 字段精确分类。未命中已知类型返回 ""（让调用方走正则兜底）。
 * @param {*} err
 * @returns {string} 见 ERROR_* 常量，未命中返回 ""
 */
export function classifyByErrorType(err) {
  var type = getErrorType(err);
  if (!type) return "";
  return TYPE_TO_CLASS[type] || "";
}

// 分类关键词（大小写不敏感）。
// 注意：不再包含裸 "balance" / "credits" / "insufficient" 这种泛词——它们会误命中
// OpenCode/Go "available balance"、LSP "insufficient memory" 等无关错误。真正的"余额不足"
// 由 classifyByErrorType（InsufficientQuotaError 等 ProviderError.type）精确分类，
// 兜底正则只保留紧贴的词组匹配。
// 同时不包含裸 "quota"（rpm exhausted 属速率限制而非余额不足，避免误报）。
var QUOTA_RE = /\binsufficient[_-]?(?:quota|balance|credits)\b|\bquota[_-]?exceeded\b|\bbilling\b|\bpayment[_-]?required\b|\bunauthorized\b|\bno[_-]?funds\b|\bnot[_-]?enough[_-]?credit\b|余额不足|欠费|没有费用/i;
var RATE_LIMIT_RE = /\brate[_-]?limit[_-]?(?:exceeded|error)\b|\brpm[_-]?exceeded\b|\btpm[_-]?exceeded\b|\btoo[_-]?many[_-]?requests\b/i;
var USAGE_LIMIT_RE = /\bmonthly[_\s-]?usage[_\s-]?limit\b|\busage[_\s-]?limit[_\s-]?reached\b|\bsubscription[_\s-]?limit\b/i;
var TIMEOUT_RE = /timeout|timed out|超时/i;
var NETWORK_RE = /请求失败|连接失败|connect|refused|ECONN|未运行|断线|重连|network|socket|upstream request failed|endpoint is unavailable|api_error|server_error|overloaded_error|upstream|unavailable|endpoint/i;
var NOT_FOUND_RE = /404|不存在|not found/i;
var CONTEXT_OVERFLOW_RE = /maximum context length exceeded|context length exceeded|maximum context length|exceed_context_size|exceeds the available context size|context window overflow|上下文超限/i;
var CANCEL_RE = /canceled|cancelled|已取消/i;
// 步数触顶哨兵：服务端 errStepCap 文案固定含 "max_steps_reached"（有单测锁定），
// 是前后端契约，改服务端文案必须保留该 token。
var STEP_CAP_RE = /max_steps_reached/i;

/**
 * 错误分类：优先按 ProviderError.type 精确分类（最稳），未命中再走关键词正则兜底。
 * @param {*} err
 * @returns {string} 见 ERROR_* 常量
 */
export function classifyError(err) {
  // 1) 最优先：按错误对象的 type 字段精确分类（ProviderError type 名稳定，
  //    不受 message 文本干扰，能可靠区分"月度配额" vs "余额不足" vs "速率限制"）
  var byType = classifyByErrorType(err);
  if (byType) return byType;
  // 2) 兜底：按 message 文本关键词匹配（兼容老错误/无 type 字段的情况）
  var text = getErrorMessage(err);
  if (STEP_CAP_RE.test(text)) return ERROR_STEP_CAP;
  if (USAGE_LIMIT_RE.test(text)) return ERROR_USAGE_LIMIT;
  if (RATE_LIMIT_RE.test(text)) return ERROR_RATE_LIMIT;
  if (QUOTA_RE.test(text)) return ERROR_QUOTA;
  if (CONTEXT_OVERFLOW_RE.test(text)) return ERROR_CONTEXT_OVERFLOW;
  if (TIMEOUT_RE.test(text)) return ERROR_TIMEOUT;
  if (NETWORK_RE.test(text)) return ERROR_NETWORK;
  if (NOT_FOUND_RE.test(text)) return ERROR_NOT_FOUND;
  if (CANCEL_RE.test(text)) return ERROR_CANCEL;
  return ERROR_UNKNOWN;
}

// ===== 友好提示（语言感知） =====

// 各分类的友好文案（按当前 UI 语言选择，不经过 i18n 字典，集中维护）
var FRIENDLY_ZH = {
  quota: "余额不足，任务中断",
  usage_limit: "使用额度已达上限，任务中断",
  rate_limit: "请求过于频繁，任务中断",
  timeout: "请求超时，任务中断",
  network: "连接失败，任务中断",
  not_found: "资源不存在，任务中断",
  context_overflow: "上下文超出模型支持的长度，任务中断",
  cancel: "操作已取消",
  step_cap: "本轮已达步数上限，任务暂停",
  unknown: "操作失败，任务中断",
};
var FRIENDLY_EN = {
  quota: "Insufficient balance. Task interrupted.",
  usage_limit: "Usage limit reached. Task interrupted.",
  rate_limit: "Too many requests. Task interrupted.",
  timeout: "Request timed out. Task interrupted.",
  network: "Connection failed. Task interrupted.",
  not_found: "Resource not found. Task interrupted.",
  context_overflow: "Context length exceeded. Task interrupted.",
  cancel: "Operation canceled.",
  step_cap: "Step limit reached. Task paused.",
  unknown: "Operation failed. Task interrupted.",
};

// 英文错误 → 中文的模式翻译表（按优先级从具体到通用排列，逐条 replace）。
// 只匹配英文模式（不含中文关键词）：翻译结果可能再被后续规则命中的中文词
// 会造成重复替换（如先译出"超时"再被通用规则改成"请求超时"），且中文原文
// 错误无需翻译（hasEnglish 检查自然会放行）。中文界面用它把常见英文错误
// 翻译成中文；翻译后仍有英文残留时由调用方丢弃细节、只显示分类友好文案，
// 保证中文界面不出现英文报错。
/** @type {Array<[RegExp, string]>} */
var EN2ZH = [
  [/^stream interrupted: stream ended without \[DONE\] or finish_reason/i,
    "模型输出流被中断：连接在生成完成前被关闭（网络波动、代理或防火墙超时、服务端断开）"],
  [/stream idle timeout exceeded after ([^)]*)/i,
    "模型响应超时：超过 $1 未收到新输出"],
  [/stream ended prematurely with incomplete tool calls/i,
    "输出流提前中断：工具调用数据不完整"],
  [/stream interrupted/i,
    "模型输出流被中断"],
  [/request failed: (.+)/i,
    "请求失败：$1"],
  [/request failed/i,
    "请求失败"],
  [/failed to parse chunk: (.+)/i,
    "响应数据解析失败：$1"],
  [/insufficient_quota|insufficient quota|quota exceeded|balance insufficient|insufficient balance|no funds|not enough credit/i,
    "余额不足"],
  [/invalid api key|invalid_api_key|unauthorized|authentication failed/i,
    "授权失败（API 密钥无效或已过期）"],
  [/rate limit exceeded|rate limit|too many requests/i,
    "请求过于频繁，请稍后重试"],
  [/connection refused|connect refused|econnrefused|network is unreachable|host is down|failed to connect/i,
    "无法连接到服务"],
  [/connection reset|econnreset|broken pipe/i,
    "连接被重置"],
  [/request canceled by user|context canceled|canceled|cancelled/i,
    "已取消"],
  [/maximum context length exceeded|context length exceeded|maximum context length|exceed_context_size|exceeds the available context size|context window overflow/i,
    "上下文超出模型支持的长度"],
  [/permission denied|access denied|eacces/i,
    "没有权限执行此操作"],
  [/no such file or directory|no such file|no such/i,
    "文件或目录不存在"],
  [/not found|enoent|404/i,
    "资源或文件不存在"],
  [/server is shutting down|service unavailable/i,
    "服务正在关闭或暂不可用"],
  [/server busy|server not idle/i,
    "服务正忙，请稍后重试"],
  [/is not initialized|not initialized|is not configured|not configured|not ready/i,
    "服务未就绪或未正确配置"],
  [/model output degradation[^\n]*|output degradation[^\n]*/i,
    "模型输出异常（持续思考未产出有效内容）"],
  [/max_steps_reached/i,
    "本轮已达步数上限，任务暂停"],
  [/empty command|empty prompt|prompt is empty/i,
    "输入内容为空"],
  [/failed to get session[^$]*|no rows in result set/i,
    "会话不存在或已被清理"],
  [/timeout|timed out/i,
    "请求超时"],
  [/eof/i,
    "连接已关闭"],
];

/** 是否含英文单词（≥3 个连续字母），用于判断翻译后是否仍有英文残留 */
function hasEnglish(s) {
  return /[A-Za-z]{3,}/.test(String(s));
}

/** 按模式表把常见英文错误翻译为中文（尽量全量替换，残余文本由调用方丢弃） */
function translateEn2Zh(text) {
  var out = String(text);
  // 剥离技术性模块前缀（"llm: "、"agent loop: " 等）：对用户无意义，
  // 且残留的字母会被 hasEnglish 判为英文导致有效细节被丢弃
  out = out.replace(/^(llm|agent loop|provider|server|config)\s*:\s*/i, "");
  for (var i = 0; i < EN2ZH.length; i++) {
    try { out = out.replace(EN2ZH[i][0], EN2ZH[i][1]); } catch (_) {}
  }
  // 残余英文分隔符统一为中文标点（如 "stream interrupted: xxx" → "模型输出流被中断：xxx"）
  out = out.replace(/:\s*/g, "：").trim();
  return out;
}

/**
 * 生成语言感知的友好错误文本（供 UI 统一展示）。
 * - 中文界面：分类友好文案（+ 可完整翻译的错误细节），保证输出无英文；
 * - 英文界面：英文友好提示 + 原始错误细节。
 * prefix / hint 视为中文原文 key，会按当前语言翻译（传已翻译文本也幂等）。
 * @param {*} err 原始错误（string / Error / 结构化对象均可）
 * @param {{ prefix?: string, hint?: string, inline?: boolean }} [opts] prefix 如"保存设置失败："，hint 补充提示，inline 英文界面把原始错误并到同一行（用于括号内等紧凑场景）
 * @returns {string} 最终展示文本（传空错误返回 ""）
 */
export function friendlyError(err, opts) {
  opts = opts || {};
  var raw = getErrorMessage(err);
  if (!raw) return "";
  var cls = classifyError(err);
  var prefix = opts.prefix ? t(opts.prefix) : "";
  var hint = opts.hint ? t(opts.hint) : "";
  // 配额类错误固定文案（不附加原始错误，避免把英文报错带进提示）：
  //   quota         —— 余额不足 / 授权失败
  //   usage_limit   —— 月度使用配额限制（OpenCode/Go 等订阅服务的月度额度用尽）
  //   rate_limit    —— 速率限制（rpm/tpm exceeded）
  // 这三类都属于"用户操作无关的硬性限制"，无需附加英文细节，但仍保留 prefix/hint
  // 让调用方能拼上"本轮对话中断: ..."等场景化前缀
  if (cls === ERROR_QUOTA || cls === ERROR_USAGE_LIMIT || cls === ERROR_RATE_LIMIT) {
    var clsText = getLanguage() === "zh" ? (FRIENDLY_ZH[cls] || FRIENDLY_ZH.unknown) : (FRIENDLY_EN[cls] || FRIENDLY_EN.unknown);
    return prefix + clsText + hint;
  }
  if (getLanguage() === "zh") {
    var detail = translateEn2Zh(raw);
    // 翻译后仍有英文残留（如 HTTP/路径/JSON 原文）：丢弃细节，只给分类文案
    if (hasEnglish(detail)) detail = "";
    var zh = FRIENDLY_ZH[cls] || FRIENDLY_ZH.unknown;
    // 细节与分类文案语义重复时省略（如 "not found" → "资源或文件不存在"）
    if (detail) {
      if (cls === ERROR_NOT_FOUND && detail.length <= 14) {
        // 分类文案"资源不存在"已表达同义信息，省略关键词型细节
        detail = "";
      } else {
        var dKey = detail.replace(/[：，、。.?!！\s()（）\]\[\/]/g, "");
        var bKey = zh.replace(/[：，、。.?!！\s]/g, "");
        if (bKey.indexOf(dKey) !== -1 || dKey.indexOf(bKey) !== -1) detail = "";
      }
    }
    // unknown 且有可显示的完整细节：直接展示细节（中文原文如"已存在，是否覆盖？"
    // 本身就是最准确提示，分类兜底文案只在无细节可用时出现）
    if (cls === ERROR_UNKNOWN && detail) {
      return prefix + detail + hint;
    }
    return prefix + zh + (detail ? "：" + detail : "") + hint;
  }
  var en = FRIENDLY_EN[cls] || FRIENDLY_EN.unknown;
  // inline：原始错误并到同一行（用于括号内等紧凑场景），默认换行展示细节
  return prefix + en + (raw ? (opts.inline ? " " + raw : "\n" + raw) : "") + hint;
}
