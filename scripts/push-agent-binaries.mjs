// pnpm agent:push：委托本地 adm-binaries 仓库的 push.mjs（单个提交 + 强制覆盖远端）。
// 本地 adm-binaries/ 由 admAgent 的编译脚本（build.ps1 / build.sh）直接写入压缩包。
//
// 用法：pnpm agent:push [-- --dry-run]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUSH_SCRIPT = path.join(ROOT, "adm-binaries", "push.mjs");

if (!fs.existsSync(PUSH_SCRIPT)) {
  console.error(`[agent-push] 未找到 ${PUSH_SCRIPT}`);
  console.error("[agent-push] 请先克隆二进制仓库：git clone https://github.com/autoDeploymentModel/adm-binaries.git adm-binaries");
  process.exit(1);
}

// pnpm 会把分隔符 "--" 一并透传，这里过滤掉，只转发真实参数
const args = process.argv.slice(2).filter((arg) => arg !== "--");
try {
  execFileSync(process.execPath, [PUSH_SCRIPT, ...args], { stdio: "inherit" });
} catch (e) {
  // 子进程失败时已自行输出原因，这里只透传退出码，避免打印 Node 堆栈
  if (e.status) process.exit(e.status);
  console.error(`[agent-push] 无法启动推送脚本：${e.message.split("\n")[0]}`);
  process.exit(1);
}
