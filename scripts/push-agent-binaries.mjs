// 将 buildAgent/ 下的 admAgent 压缩包同步到独立的 adm-binaries 仓库。
// 每次都在临时目录里全新提交后强推：adm-binaries 永远只有 1 个提交，历史不随版本膨胀。
// CI（.github/workflows/build.yml）构建时会把该仓库 checkout 到 buildAgent/ 供打包使用。
//
// 用法：pnpm agent:push（环境变量 ADM_BINARIES_REPO 可覆盖目标仓库 URL）
//
// 注意：首次使用前需在 GitHub 创建空仓库（public、不初始化 README），否则推送会报 Repository not found。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_AGENT_DIR = path.join(ROOT, "buildAgent");
const REPO_URL = process.env.ADM_BINARIES_REPO || "https://github.com/autoDeploymentModel/adm-binaries.git";
const ARCHIVE_RE = /^admAgent_(.+)_(Windows_x86_64\.zip|Darwin_arm64\.tar\.gz)$/;

function run(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function main() {
  const archives = fs.existsSync(BUILD_AGENT_DIR)
    ? fs.readdirSync(BUILD_AGENT_DIR).filter((name) => ARCHIVE_RE.test(name))
    : [];
  if (!archives.length) {
    console.error(`[agent-push] ${BUILD_AGENT_DIR} 下没有 admAgent_*.{zip,tar.gz} 压缩包`);
    process.exit(1);
  }

  const userName = run(["config", "user.name"], ROOT).trim();
  const userEmail = run(["config", "user.email"], ROOT).trim();
  const versions = [...new Set(archives.map((name) => name.match(ARCHIVE_RE)[1]))].sort();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adm-binaries-"));
  try {
    run(["init", "-q", "-b", "main"], tmpDir);
    for (const name of archives) {
      fs.copyFileSync(path.join(BUILD_AGENT_DIR, name), path.join(tmpDir, name));
      console.log(`[agent-push] 同步 ${name}`);
    }
    fs.writeFileSync(
      path.join(tmpDir, "README.md"),
      "# adm-binaries\n\nADM 桌面端内置的 admAgent 二进制，由 ADM 仓库 `pnpm agent:push` 自动生成，请勿手动修改。\n"
    );
    run(["add", "-A"], tmpDir);
    run(
      ["-c", `user.name=${userName}`, "-c", `user.email=${userEmail}`, "commit", "-q", "-m", `admAgent ${versions.join(" / ")}`],
      tmpDir
    );
    execFileSync("git", ["push", "--force", REPO_URL, "main"], { cwd: tmpDir, stdio: "inherit" });
    console.log(`[agent-push] 已推送到 ${REPO_URL}（${archives.length} 个压缩包）`);
  } catch (e) {
    console.error(`[agent-push] 同步失败：${e.message.split("\n")[0]}`);
    console.error(`[agent-push] 若仓库尚不存在，请先在 GitHub 创建空仓库：${REPO_URL.replace(/\.git$/, "")}（public，不要初始化 README）`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
