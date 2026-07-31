// 纯工具函数（无共享状态依赖）

// 按 id 获取表单元素（input/textarea/select 通用，供 checkJs 类型收窄；运行时等价 getElementById）
/** @param {string} id @returns {HTMLInputElement} */
export function $input(id) {
  return /** @type {HTMLInputElement} */ (document.getElementById(id));
}

// 推理强度归一化：仅接受 low/medium/high，历史版本存过 ""（默认）和 "auto"，统一迁移为 medium
/** @param {string|undefined|null} v @returns {string} */
export function normalizeReasoningEffort(v) {
  return v === "low" || v === "medium" || v === "high" ? v : "medium";
}

// 生成 UUID (兼容性方案)
export function generateUUID() {
  var d = Date.now();
  var d2 = (typeof performance !== "undefined" && performance.now && (performance.now() * 1000)) || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// 消息区是否已滚到底部（4px 容差，避免亚像素/缩放导致判定不中）
export function isMsgAreaAtBottom(area) {
  return area.scrollHeight - area.scrollTop - area.clientHeight <= 4;
}

// 从 parts 中提取文本内容（用于临时消息匹配）
export function getTextFromParts(parts) {
  if (!parts || !Array.isArray(parts)) return "";
  var textParts = parts.filter(function(p) { return p.type === "text"; });
  return textParts.map(function(p) { return (p.data && p.data.text) || ""; }).join("");
}

// 与 src-tauri agent.rs 的 slugify_model_id 保持一致：转小写，
// 空格/下划线/连字符→'-'，保留点号，其它字符忽略，去尾部 '-'/'.'
export function slugifyModelId(name) {
  var out = "";
  var prevDash = false;
  for (var i = 0; i < name.length; i++) {
    var c = name[i];
    if (/[a-zA-Z0-9.]/.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (/[\s\-_]/.test(c)) {
      if (out && !prevDash) { out += "-"; prevDash = true; }
    }
  }
  out = out.replace(/[-.]+$/, "");
  return out || "model";
}

export function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n || 0);
}

export function parseContextSize(s) {
  s = s.trim().toUpperCase();
  if (!s) return 0;
  if (s.endsWith("M")) return Math.round(parseFloat(s) * 1000000);
  if (s.endsWith("K")) return Math.round(parseFloat(s) * 1000);
  return parseInt(s) || 0;
}

// ===== 辅助函数 =====
export function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatTime(t) {
  if (!t) return "";
  try {
    // t 可能是 Unix 时间戳（数字/数字字符串）或 ISO 字符串
    var d;
    if (typeof t === "number" || /^\d+$/.test(t)) {
      d = new Date(parseInt(t, 10) * 1000);
    } else {
      d = new Date(t);
    }
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

export function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

export function generateRunId() {
  return "run-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
}

// ===== Markdown 简易渲染 =====
export function renderMarkdown(text) {
  if (!text) return "";
  // 简易 Markdown 渲染：代码块、行内代码、粗体、斜体、标题、列表、链接
  var html = escapeHtml(text);

  // 代码块 ```language\ncode```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre style="background:var(--c-bg-deep);border:1px solid var(--c-border);border-radius:6px;padding:10px;margin:8px 0;overflow-x:auto;font-size:12px;"><code>' + code.trim() + "</code></pre>";
  });

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--c-bg-deep);padding:2px 6px;border-radius:3px;font-size:12px;">$1</code>');

  // 标题 ### / ## / #
  html = html.replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 6px;font-size:15px;">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="margin:14px 0 8px;font-size:17px;">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 10px;font-size:19px;">$1</h1>');

  // 粗体 **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // 斜体 *text*
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 列表项
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');

  // 链接 [text](url)：仅放行 http(s)，阻断 javascript:/data: 等危险协议
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, text, url) {
    var safe = /^https?:\/\//i.test(url.trim()) ? url : "#";
    return '<a href="' + safe + '" style="color:var(--c-accent);text-decoration:none;" target="_blank">' + text + '</a>';
  });

  // 换行
  html = html.replace(/\n/g, "<br>");

  return html;
}
