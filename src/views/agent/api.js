// admAgent HTTP API 客户端
import { invoke } from "./store.js";

// 敏感字段值脱敏（只处理一层对象），避免 API Key 等凭据泄露到 devtools 控制台
function maskBody(body) {
  if (!body || typeof body !== "object") return body;
  var masked = {};
  for (var k in body) {
    if (/api_key|apikey|secret|password|token/i.test(k) && typeof body[k] === "string") {
      masked[k] = "***";
    } else {
      masked[k] = body[k];
    }
  }
  return masked;
}

// ===== API 客户端 =====
export async function api(method, path, body) {
  console.log("[agent] API:", method, path, body ? JSON.stringify(maskBody(body)).substring(0, 100) : "");
  try {
    return await invoke("agent_http_request", { method, path, body: body || null });
  } catch (e) {
    // 统一记录失败的请求（含后端返回的 HTTP 状态与响应体片段），避免被调用方 catch 后静默吞掉无法定位
    console.error("[agent] API 失败:", method, path, "→", e);
    throw e;
  }
}
