// 构建/开发前置钩子：把 buildAgent/ 下的 admAgent 压缩包解压到临时目录，
// 取出二进制放到 src-tauri/binaries/admAgent-<target-triple>[.exe]，
// 供 tauri.conf.json 的 bundle.externalBin（sidecar）机制按平台自动打包进安装包。
//
// 平台选择：优先读 Tauri 2 传入的 TAURI_ENV_TARGET_TRIPLE（--target 交叉构建也正确），
// 否则按宿主平台推断。压缩包按 admAgent_*_<平台>.{zip|tar.gz} glob，不硬编码版本号。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_AGENT_DIR = path.join(ROOT, "buildAgent");
const BINARIES_DIR = path.join(ROOT, "src-tauri", "binaries");

/** 确定目标 triple：优先 Tauri 注入的环境变量，回退宿主平台推断 */
function resolveTargetTriple() {
  const envTriple = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (envTriple) return envTriple;
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
}

/** triple → 压缩包文件名匹配规则 + 二进制文件名 */
function platformSpec(triple) {
  if (triple.includes("windows")) {
    return { pattern: /^admAgent_(.+)_Windows_x86_64\.zip$/, binName: "admAgent.exe", ext: ".exe" };
  }
  if (triple === "aarch64-apple-darwin") {
    return { pattern: /^admAgent_(.+)_Darwin_arm64\.tar\.gz$/, binName: "admAgent", ext: "" };
  }
  return null;
}

/** 版本号比较（"0.1.10" > "0.1.9"），非数字段按字符串比较兜底 */
function compareVersion(a, b) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 在 buildAgent/ 下找当前平台的压缩包，多个时取版本号最大的 */
function findArchive(spec) {
  if (!fs.existsSync(BUILD_AGENT_DIR)) return null;
  const candidates = fs
    .readdirSync(BUILD_AGENT_DIR)
    .map((name) => {
      const m = name.match(spec.pattern);
      return m ? { name, version: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareVersion(a.version, b.version));
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** 递归找解压产物里的目标二进制（不依赖压缩包内目录层级） */
function findBinary(dir, binName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinary(p, binName);
      if (found) return found;
    } else if (entry.name === binName) {
      return p;
    }
  }
  return null;
}

function main() {
  const triple = resolveTargetTriple();
  const spec = platformSpec(triple);
  if (!spec) {
    console.error(`[prepare-agent] 不支持的构建目标: ${triple}（buildAgent/ 下无对应 admAgent 压缩包）`);
    process.exit(1);
  }

  const archive = findArchive(spec);
  if (!archive) {
    console.error(`[prepare-agent] buildAgent/ 下未找到匹配 ${spec.pattern} 的压缩包，无法打包 admAgent`);
    process.exit(1);
  }
  const archivePath = path.join(BUILD_AGENT_DIR, archive.name);
  const destPath = path.join(BINARIES_DIR, `admAgent-${triple}${spec.ext}`);

  // 增量跳过：目标文件已存在且比压缩包新则不再解压（tauri dev 每次启动都会跑本脚本）
  if (fs.existsSync(destPath)) {
    const destStat = fs.statSync(destPath);
    const archiveStat = fs.statSync(archivePath);
    if (destStat.mtimeMs >= archiveStat.mtimeMs) {
      console.log(`[prepare-agent] ${path.relative(ROOT, destPath)} 已是最新（${archive.name}），跳过`);
      return;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adm-agent-"));
  try {
    // Windows 10+ 自带 bsdtar，zip / tar.gz 均可解；macOS 系统 tar 解 tar.gz 天然保留执行位
    execFileSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "inherit" });

    const binPath = findBinary(tmpDir, spec.binName);
    if (!binPath) {
      console.error(`[prepare-agent] 压缩包 ${archive.name} 中未找到 ${spec.binName}`);
      process.exit(1);
    }

    fs.mkdirSync(BINARIES_DIR, { recursive: true });
    fs.copyFileSync(binPath, destPath);
    // Windows 的 copyFileSync 会保留源文件（压缩包内旧构建时间）的 mtime，
    // 导致增量跳过判断永远失败，这里显式刷新为当前时间
    const now = new Date();
    fs.utimesSync(destPath, now, now);
    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755); // 执行位兜底（tar 已保留，双保险）
    }
    console.log(`[prepare-agent] ${archive.name} -> ${path.relative(ROOT, destPath)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
