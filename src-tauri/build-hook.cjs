#!/usr/bin/env node
/**
 * 平台特定资源处理脚本
 * Windows: 创建 terminal-resources 软链接/副本供打包
 * macOS/Linux: 确保不存在 terminal-resources
 */

const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';
const srcTauriDir = __dirname;
const projectRoot = path.resolve(srcTauriDir, '..');
const terminalDir = path.join(projectRoot, 'terminal');
const terminalResourcesDir = path.join(srcTauriDir, 'terminal-resources');

console.log(`[tauri-build-hook] 平台: ${process.platform}`);

if (isWindows) {
  // Windows: 确保 terminal-resources 存在
  if (fs.existsSync(terminalResourcesDir)) {
    // 删除旧的（可能是软链接或目录）
    fs.rmSync(terminalResourcesDir, { recursive: true, force: true });
  }
  
  // 创建 junction（Windows）或符号链接（其他，但这里只在 Windows 执行）
  try {
    // 使用 junction，不需要管理员权限
    fs.symlinkSync(terminalDir, terminalResourcesDir, 'junction');
    console.log('[tauri-build-hook] ✅ 已创建 terminal-resources -> ../terminal 的符号链接');
  } catch (e) {
    // 如果符号链接失败，直接复制（较慢但可靠）
    console.warn('[tauri-build-hook] 符号链接失败，回退到复制:', e.message);
    copyDir(terminalDir, terminalResourcesDir);
    console.log('[tauri-build-hook] ✅ 已复制 terminal -> terminal-resources');
  }
} else {
  // macOS/Linux: 清理 terminal-resources
  if (fs.existsSync(terminalResourcesDir)) {
    fs.rmSync(terminalResourcesDir, { recursive: true, force: true });
    console.log('[tauri-build-hook] ✅ 已清理 terminal-resources（非 Windows 平台）');
  } else {
    console.log('[tauri-build-hook] �️ 无需清理（terminal-resources 不存在）');
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
