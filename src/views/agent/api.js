// admAgent HTTP API 客户端
import { t as _t } from "../../i18n.js";
import { invoke } from "./state.js";

// ===== API 客户端 =====
export async function api(method, path, body) {
  console.log("[agent] API:", method, path, body ? JSON.stringify(body).substring(0, 100) : "");
  try {
    return await invoke("agent_http_request", { method, path, body: body || null });
  } catch (e) {
    // 统一记录失败的请求（含后端返回的 HTTP 状态与响应体片段），避免被调用方 catch 后静默吞掉无法定位
    console.error("[agent] API 失败:", method, path, "→", e);
    throw e;
  }
}

// 等待 server 就绪 (轮询 health)
export async function waitForServerReady() {
  var retries = 0;
  var maxRetries = 30; // 最多等待 30 次，每次 500ms = 15 秒
  while (retries < maxRetries) {
    try {
      await api("GET", "/v1/health");
      return; // server 就绪
    } catch (_) {
      retries++;
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
  }
  throw new Error(_t("等待 server 超时"));
}
