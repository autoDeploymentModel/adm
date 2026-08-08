// admAgent HTTP API 客户端
import { invoke } from "./store.js";

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
