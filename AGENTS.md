# ADM — Agent 指南

## 开发命令（始终使用 `pnpm`，不要用 `npm`/`yarn`）
- `pnpm tauri dev` — 热重载开发模式
- `pnpm tauri build` — 生产构建
- `pnpm tauri clean` — 清理构建产物
- `pnpm tauri:build:windows` / `:macos` / `:linux` — 跨平台构建

## 架构
- **Tauri 2.11.2** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口** iframe 路由：
  - `index.html`（外壳）内嵌 `model_list.html`、`settings.html`、`model_chat.html`、`model_image.html`
- CSS/JS **内联**在每个 HTML 文件中。
- 未配置 linter、formatter、typechecker 或测试框架。

## IPC 注意事项（重要）
- `index.html` 监听 Tauri 事件，通过 `postMessage` 转发给 iframe。
- **macOS WKWebView 不会将 Tauri IPC 注入 iframe。** 子页面必须通过 `window.parent.__TAURI__?.core?.invoke` 回退。
- 子页面 → 父窗口导航：`postMessage({ type: "navigate", page: "..." }, "*")`。
- 子页面 → 父窗口 IPC 代理：`postMessage({ type: "__invoke__", cmd, args, id }, "*")`。

## Rust 后端（`src-tauri/src/`）
| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`, `check_update`, `download_and_extract_llamacpp` |
| `model_list.rs` | `fetch_model_list`, `scan_local_models`, `download_model`, `start_model`, `stop_model`, `get_model_status` |
| `settings.rs` | `save_settings`（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_llamacpp_version` |
| `model_image.rs` | `check_sd_exists`, `download_and_extract_sd`, `start_sd_generation`, `stop_sd` |
| `model_chat.rs` | **零命令** — 纯事件驱动 |

## 关键注意事项
- **MTP 自动检测**：如果模型文件名包含 "mtp"（不区分大小写），`start_model` 会自动追加 `--spec-draft-n-max 2 --spec-type draft-mtp`。设置 `params.spec_type = "none"` 可禁用。
- **HuggingFace 镜像**：`download_model` 会自动将所有 `huggingface.co` 链接替换为 `hf-mirror.com`。
- **断点续传**：使用 `.part` 后缀 + HTTP `Range` 头；`scan_part_files` 列出未完成的下载。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。
- **更新流程**：启动后延迟 3 秒 → 应用更新 → VC++ 运行库（仅 Windows）→ llamacpp 下载。
- **窗口关闭**：`on_window_event` 通过 `taskkill /F`（Windows）或 `kill -9` 杀死 llama-server。
- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。

## 构建与发布
- CI：`.github/workflows/build.yml` — 标签触发（`v*`），构建 Windows + macOS，自签名。
- 发布：`pnpm tauri:build:<平台>` 然后 `pnpm sign:<平台>`。
- 图标：`python scripts/generate-icons.py` 从 `src-tauri/icons/source.png` 生成。

## 注意事项
- 修改逻辑后记得同步更新 `doc/dev_doc.md`（详细的中文开发文档）。
