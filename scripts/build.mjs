import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 自动检测当前平台
function getPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'win32') {
    return { name: 'windows', config: 'tauri.conf.windows.json' };
  } else if (platform === 'darwin') {
    return { name: 'macos', config: 'tauri.conf.macos.json' };
  } else if (platform === 'linux') {
    return { name: 'linux', config: 'tauri.conf.linux.json' };
  }
  
  throw new Error(`不支持的平台: ${platform}`);
}

function main() {
  const platform = getPlatform();
  
  console.log(`\n========================================`);
  console.log(`当前平台: ${platform.name}`);
  console.log(`使用配置文件: ${platform.config}`);
  console.log(`========================================\n`);
  
  const configPath = join(rootDir, 'src-tauri', platform.config);
  const cmd = `tauri build --config "${configPath}"`;
  
  console.log(`执行命令: ${cmd}\n`);
  
  try {
    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit'
    });
    console.log('\n✅ 构建成功！');
  } catch (error) {
    console.error('\n❌ 构建失败！');
    process.exit(1);
  }
}

main();