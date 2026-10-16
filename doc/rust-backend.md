# Rust 后端（桌面端，`src-tauri/src/`）

> 范围：Rust 侧命令地图、应用自升级、下载链路、运行库预检与平台差异。构建/发布流程见 `doc/build-and-release.md`。

---

## 模块与关键命令

| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`, `check_update`, `download_and_extract_llamacpp`, `reinstall_llamacpp`（设置页「重新安装」：先删 llamacpp 目录再重新下载，复用升级的下载/解压逻辑，不比较版本号） |
| `model_list.rs` | `fetch_model_list`, `scan_local_models`, `download_model`, `start_model`, `stop_model`, `get_model_status` |
| `docker_model.rs` | `check_docker_env`, `check_docker_image`, `get_docker_tasks`, `setup_docker_model`, `start_docker_model`, `stop_docker_model`, `delete_docker_image` |
| `settings.rs` | `save_settings`（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_llamacpp_version` |
| `agent.rs` | `start_agent_server`, `stop_agent_server`, `get_agent_server_status`, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `check_adm_agent`, `get_adm_agent_version`, `add/list/update/delete_cloud_provider` |

## 关键注意事项（自升级 / 下载 / 检测）

- **软件自升级（桌面端，静默下载 → 提示升级）**：启动 3 秒后的更新检查发现新版本时**不再弹窗**，改为后台静默下载安装包到 `app_data_dir/updates`（文件名 `ADM-<版本>-<URL 文件名>`；**必须带版本号**，否则下载地址不带版本号时同名文件会被断点续传逻辑当成"已下载完成"，用户升到的还是旧版本），下载完成后才弹窗询问是否立即升级。前端状态机在 `index.html`（`appUpdate{status: downloading|ready|error}`；统一入口 `window.ADM.startAppUpdate(result,{manual})`，settings 页「检查新版本」复用同一入口并在 manual 时展示下载进度）：选「稍后再说」保留安装包，重启后同名文件存在即秒回已就绪并再次提示；选「跳过此版本」写 localStorage `adm_skip_update_version`，静默检查不再打扰、手动检查仍提示。Rust 端两个命令（`pages/index.rs`，已在 `lib.rs` 注册）：`download_app_update(version,url)`（发 `app-update-progress` 事件、下载前清理其它版本残留包）、`install_app_update(path)`（只允许运行 updates 目录内的文件 → 拉起/执行安装 → `cleanup_processes` + `app.exit(0)`；安装包 Windows 用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 并尝试脱离 Job，macOS 走 `open <dmg>`，Linux 按扩展名分流——**deb 必须走包管理器，直接 exec 会 ENOEXEC**：`pkexec --disable-internal-agent env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends <deb>`，输出重定向到 `<包名>.install.log` 且必须等退出码（失败/授权取消时保持应用运行，弹窗展示 `sudo apt install` 指引与 apt 输出尾段；`--disable-internal-agent` 防止 pkexec 内部文本代理从 null stdin 读密码把弹窗挂到超时），AppImage 则在 `$APPIMAGE` 存在时用临时文件 + rename 覆盖当前 AppImage 后再启动，否则只补可执行位拉起）。该命令为 async + `spawn_blocking`：Linux 等待安装可能耗时数十秒，不能占住 async 运行时。前端失败标题按 `appUpdate.phase`（download/install）区分，安装阶段失败用 `getErrorMessage` 原样展示后端中文指引（**不能走 friendlyError**——指引里含 `sudo`/路径等英文会被整段丢弃，只剩"操作失败，任务中断"，这正是 0.7.4→0.7.5 Linux 升级报错的成因）。安装包目录用 `app_data_dir` 而非 exe 目录（Program Files 下不可写）。升级提示会等 VC++/llamacpp 引导弹窗关闭后再弹（`updateDialogOwner !== "app-update"` 时挂起），避免互相覆盖。
- **MTP 自动检测**：如果模型文件名包含 "mtp"（不区分大小写），`start_model` 会自动追加 `--spec-draft-n-max 2 --spec-type draft-mtp`。设置 `params.spec_type = "none"` 可禁用。
- **VC++ 运行库检测（Windows）**：`check_vc_redist_installed`（`index.rs`）以 DLL 实检为准——`C:\Windows\System32` 或可执行文件同目录下必须同时存在 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll`。**不要改回注册表判断或只查 `vcruntime140.dll`**：旧版 2015/2017 运行库同样写 `Installed=0x1`，会把缺 `vcruntime140_1.dll` 的机器误判为已安装。调用点：启动检测（`check_update`；网络失败时前端改走独立命令 `check_vc_redist`）、点「安装完成」后的复验，以及 `start_model` / `get_llamacpp_version` 拉起进程前的预检——缺失时直接返回错误、**不 spawn**（否则 Windows 加载器会弹「找不到 VCRUNTIME140_1.dll」系统错误框并把进程卡住，`spawn()` 本身不报错）。
- **HuggingFace 镜像**：`download_model` 会自动将所有 `huggingface.co` 链接替换为 `hf-mirror.com`。
- **断点续传**：使用 `.part` 后缀 + HTTP `Range` 头；`scan_part_files` 列出未完成的下载。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。
- **更新流程**：启动后延迟 3 秒 → 应用更新 → VC++ 运行库（仅 Windows）→ llamacpp 下载。admAgent 不再运行时下载/升级，随安装包内置（见下）。

## 平台差异与运行库预检

- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。
- **Linux**：数据目录（config.json / models / llamacpp / agent 数据）与 macOS 一致走用户数据目录（`config.rs` 的 `get_data_dir` / `get_base_dir` → `~/.local/share/com.adm.admapp`）——deb 装在 `/usr/bin`、AppImage 是只读挂载点，写 exe 同目录必然失败；内置 admAgent sidecar 与主程序同目录（`/usr/bin`，`agent.rs` 的 `adm_agent_target_dir`）。llama.cpp 用 `https://adm.tuduoduo.top/llamacpp/ubuntu-vulkan.tar.gz`（只发布 Vulkan 构建，NVIDIA/AMD/Intel 通用，**运行时依赖用户机器的 `libvulkan1` + 显卡 Vulkan 驱动**）；启动/取版本时设 `LD_LIBRARY_PATH`（`model_list.rs` / `settings.rs`）。
- **llama.cpp 运行库预检**：Windows 在 `start_model` / `get_llamacpp_version` / `reinstall_llamacpp` 前硬拦 VC++ 运行库缺失（缺 DLL 会弹系统错误框）。Linux 的对应依赖是 `libvulkan1` + 显卡 Vulkan 驱动（`index.rs` 的 `llamacpp_runtime_warning()`：`ldconfig -p` 找 `libvulkan.so.1` + `/usr/share/vulkan/icd.d` 找 ICD，认 `VK_ICD_FILENAMES`/`VK_DRIVER_FILES`），**只提示不阻断**（缺了仍可 CPU 推理）：装 llamacpp 的弹窗开始下载前调 `check_llamacpp_runtime` 命令把原因显示出来，`start_model` 另发一条 `[WARN]` model-log。

## 进程清理

- **窗口关闭**：`on_window_event` 通过 `taskkill /F`（Windows）或 `kill -9` 杀死 llama-server 和 admAgent server。
