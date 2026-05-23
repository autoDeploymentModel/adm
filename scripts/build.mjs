import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

function main() {
  console.log(`\n========================================`);
  console.log(`开始构建...`);
  console.log(`========================================\n`);

  const cmd = `tauri build`;

  console.log(`执行命令: ${cmd}\n`);

  try {
    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit'
    });
    console.log('\n构建成功！');
  } catch (error) {
    console.error('\n构建失败！');
    process.exit(1);
  }
}

main();
