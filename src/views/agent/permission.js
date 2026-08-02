// Agent 模式同步（执行/Plan）与权限请求自动处理
// 审批弹窗已移除：执行模式 = YOLO 直通（服务端 skip=true，不产生权限请求）；
// Plan 模式 = 服务端只挂载只读工具（/agent/mode plan=true），模型无法修改和写入。
import { t as _t } from "../../i18n.js";
import { S } from "./state.js";
import { api } from "./api.js";
import { reportError } from "./ui.js";

// 切换/新建会话、切换工作区时的清理钩子。
// 弹窗与排队逻辑已删除，保留空实现以兼容各调用点（session/sse/workspace）。
export function resetPermissionState() {}

// 将本地模式实时同步到 admAgent 服务端，中途切换立即生效（下一轮 run 时生效）。
// - permissions/skip 恒为 true：审批模式已移除，权限请求不再弹窗；
// - agent/mode 按 Plan 开关同步：Plan 模式下服务端只保留只读工具集。
// 服务端状态只在创建工作区时传入一次，之后必须靠这两个接口更新。
export async function syncModeToServer() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/skip", {
      skip: true
    });
  } catch (e) {
    console.warn("[agent] 同步 skip 状态到服务端失败:", e);
  }
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/agent/mode", {
      plan: !!S.settings.agent_plan_mode
    });
  } catch (e) {
    console.warn("[agent] 同步 Plan 模式到服务端失败:", e);
    reportError(e, { prefix: _t("同步 Plan 模式失败（旧版 admAgent 不支持，请更新）: ") });
  }
}

// SSE permission_request 兜底处理：正常情况下 skip=true 服务端不会发权限请求，
// 只有同步瞬间的竞态才可能到达这里 → 直接放行（执行模式本就直通；
// Plan 模式下服务端只有只读工具，放行的也只能是读操作）。
export function handlePermissionRequest(data) {
  api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/permissions/grant", {
    permission: data, action: "allow"
  }).catch(function(e) { console.warn("[agent] 权限自动放行失败:", e); });
}
