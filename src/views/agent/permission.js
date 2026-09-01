// Agent 权限模式同步：审批模式已移除，执行模式 = YOLO 直通（服务端 skip=true，不产生权限请求）
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";

// 切换/新建会话、切换工作区时的清理钩子。
// 弹窗与排队逻辑已删除，保留空实现以兼容各调用点（session/sse/workspace）。
export function resetPermissionState() {}

// 将本地权限模式实时同步到 admAgent 服务端（中途切换下一轮 run 时生效）。
// 服务端状态只在创建工作区时传入一次，之后必须靠这个接口更新。
export async function syncModeToServer() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/skip", {
      skip: true
    });
  } catch (e) {
    console.warn("[agent] 同步 skip 状态到服务端失败:", e);
  }
}

// SSE permission_request 兜底处理：正常情况下 skip=true 服务端不会发权限请求，
// 只有同步瞬间的竞态才可能到达这里 → 直接放行（执行模式本就直通）。
export function handlePermissionRequest(data) {
  api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/grant", {
    permission: data, action: "allow"
  }).catch(function(e) { console.warn("[agent] 权限自动放行失败:", e); });
}
