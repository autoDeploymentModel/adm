# 构建与发布

> 范围：CI、内置 admAgent 二进制的选包与推送、各平台打包与更新链路。

---

## 内置 admAgent 分发

- **admAgent 内置分发**：admAgent 本地编译（`admAgent/build.ps1` / `build.sh`）产出的压缩包（`admAgent_{ver}_Windows_x86_64.zip` / `admAgent_{ver}_Darwin_arm64.tar.gz` / `admAgent_{ver}_Linux_x86_64.tar.gz`）直接写入 `adm-binaries/`（二进制仓库，与 admAgent 共用同一本地 clone）。推送脚本 `adm-binaries/push.mjs` 的 `ARCHIVE_RE` 只决定日志输出与版本号统计（实际提交是 `git add -A`，目录内所有文件都会被推送），新增平台包名时必须同步更新该正则，否则会出现"日志只列了 N 个、远端却多出别的包"。`beforeDevCommand`/`beforeBuildCommand` 运行 `scripts/prepare-agent-binary.mjs`：按构建目标在 `adm-binaries/` 下选版本号最大的包、解压到临时目录、把二进制放到 `src-tauri/binaries/admAgent-<target-triple>`（git 忽略），再由 `bundle.externalBin`（sidecar）打进安装包。运行时路径：Windows 为 ADM.exe 同目录的 `admAgent.exe`，macOS 为 `ADM.app/Contents/MacOS/admAgent`；macOS 启动时会清理旧版下载模式遗留在 app_data_dir 的 admAgent。`adm-binaries/` **不入库**（.gitignore）：推送用 `pnpm agent:push`（转发 `adm-binaries/push.mjs`，每次以单个提交强制覆盖远端，历史不堆积旧二进制）；CI 构建时自动 checkout 该仓库到 `adm-binaries/`。

## Linux 打包与更新链路

- **Linux 打包 / 更新链路**：`tauri.conf.json` 的 `bundle.linux.deb.depends` 必须显式写（Tauri 2 不再用 dpkg-shlibdeps 自动推导依赖，留空会导致 `apt install ./adm.deb` 后缺 webkit2gtk 起不来）：`libwebkit2gtk-4.1-0`、`libgtk-3-0 | libgtk-3-0t64`（24.04 起改名为 t64，用 alternative 兼容）、`libayatana-appindicator3-1`（托盘，dlopen 加载，推导不到）。`lib.rs` 的托盘创建失败**不再阻断启动**（Linux 无 StatusNotifier 宿主时只打日志）。`types.rs` 的 `UpdateInfo` 有 `linux` 字段（`check_update` 的 linux 分支取它），update.json 需补 `"linux": {"appUrl","content"}` 才能在 Linux 上提示更新。

## 构建与发布

- CI：`.github/workflows/build.yml` — 标签触发（`v*`），构建前从 `adm-binaries` 仓库检出内置 admAgent 二进制到 `adm-binaries/`。三个平台：Windows x64（NSIS，自签名）、macOS aarch64（DMG，自签名）、Linux x86_64（`ubuntu-22.04` + deb/AppImage；用 22.04 是因为 AppImage 的 linuxdeploy 需要较老 glibc，构建前 apt 安装 webkit2gtk-4.1 等系统依赖）。
- 内置 admAgent 按平台选包（`scripts/prepare-agent-binary.mjs` 的 `platformSpec`）：Windows `_Windows_x86_64.zip`、macOS `_Darwin_arm64.tar.gz`、Linux `_Linux_x86_64.tar.gz`（仅 x86_64），新增平台需同时加匹配规则与 CI matrix。
- 更新内置二进制：编译 admAgent（压缩包自动写入 `adm-binaries/`）→ `pnpm agent:push` 强制覆盖远端（CI 下次构建即用）。
- 发布：`pnpm tauri:build:<平台>` 然后 `pnpm sign:<平台>`。
- 图标：`python scripts/generate-icons.py` 从 `src-tauri/icons/source.png` 生成。
