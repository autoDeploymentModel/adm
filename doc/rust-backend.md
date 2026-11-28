# Rust 后端（桌面端，`src-tauri/src/`）

> 范围：Rust 侧命令地图、应用自升级、下载链路、运行库预检与平台差异。构建/发布流程见 `doc/build-and-release.md`。

---

## JSONL 日志与 sidecar 生命周期

- `common/logging.rs` 在读取 `debug_logging` 前无条件初始化，只写平台规范目录的 `adm-desktop.jsonl`。writer 使用有界 channel + 独立线程、100ms/50 条批量、跨进程 `LockFileEx/flock`、20MB+3 轮转；WARN/ERROR 与生命周期事件立即 flush。
- `agent_debug_log_structured/batch/flush` 是新的 Tauri 命令；旧 `agent_debug_log(line)` 保留并转 `raw.line`。JS 的 `origin=ui` 必须带 `doc/ui_seq/ts_ms`，Rust 补实际进程 `proc/pid/boot/seq` 并派生 `ts`。
- panic hook 走独立 emergency append，不拿普通 writer mutex，避免 panic-in-lock 死锁；stack 脱敏后写 `sensitive=true` 的 `proc.panic`。
- sidecar spawn 只注入 `ADM_DESKTOP_LOG`，不覆盖 `ADMAGENT_LOG_DIR`；stdout/stderr 每行转 `raw.line`。复用 server 时 best-effort 调 `POST /v1/log/source`，旧 server 自动降级。
- 死亡判定必须区分：owned child 的 `try_wait` 实际退出才写 `desktop.server.died evidence=child_exit`；网络失败只写 `desktop.server.unreachable`，共享 server 无 child 时保持 unknown；正常 stop 写 `desktop.server.stop`，不得写 died。
- HTTP 代理记录 method/path hash/bytes/status/dur_ms 与 `x-adm-req-id`，不记录请求/响应正文。SSE 记录 conn/attach 对应桌面 connect/disconnect/reconnect 与原因。

## 模块与关键命令

| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`, `check_update`, `download_and_extract_llamacpp`, `reinstall_llamacpp`（设置页「重新安装」：先删 llamacpp 目录再重新下载，复用升级的下载/解压逻辑，不比较版本号） |
| `model_list.rs` | `fetch_model_list`（远程清单 + 本地缓存 + 内容哈希比对，见下）, `get_cached_model_list`（只读磁盘缓存，首页冷启动秒开）, `scan_local_models`, `download_model`, `start_model`, `stop_model`, `get_model_status` |
| `docker_model.rs` | `check_docker_env`, `check_docker_image`, `get_docker_tasks`, `setup_docker_model`, `start_docker_model`, `stop_docker_model`, `delete_docker_image` |
| `settings.rs` | `save_settings`（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_llamacpp_version` |
| `agent.rs` | `start_agent_server`, `stop_agent_server`, `get_agent_server_status`, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `check_adm_agent`, `get_adm_agent_version`, `add/list/update/delete_cloud_provider`, `probe_models_endpoint`（请求云端模型的 OpenAI 兼容 `{base}/models`，10s 超时，返回模型 ID 列表；走 Rust 是为了绕开 WebView 的 CORS，同 `fetch_skill_store`）、`check_git_repo`（撤销能力探测，见下）、`export_diagnostics`（调用 sidecar `admAgent diagnose` 生成脱敏 zip；`include_sensitive` 必须用户显式确认） |

`agent_http_request` 的状态码处理：200 解析 JSON（空 body 回 `{}`）；**202 有 body 就解析返回、空/解析失败回 `{}`**（`/v1/lsp/fix|install|uninstall` 返回 202 + job JSON，前端靠 `job_id` 轮询进度——此前 202 一律丢 body 返回 `{}`，LSP 安装永远报 "missing job_id"；`/agent` 发消息的 202 无 body，行为不变）；204 回 `{}`；其余 4xx/5xx 抛 `HTTP {status} {method} {path}: {body片段}`。

## 关键注意事项（自升级 / 下载 / 检测）

- **软件自升级（桌面端，静默下载 → 提示升级）**：启动 3 秒后的更新检查发现新版本时**不再弹窗**，改为后台静默下载安装包到 `app_data_dir/updates`（文件名 `ADM-<版本>-<URL 文件名>`；**必须带版本号**，否则下载地址不带版本号时同名文件会被断点续传逻辑当成"已下载完成"，用户升到的还是旧版本），下载完成后才弹窗询问是否立即升级。前端状态机在 `index.html`（`appUpdate{status: downloading|ready|error}`；统一入口 `window.ADM.startAppUpdate(result,{manual})`，settings 页「检查新版本」复用同一入口并在 manual 时展示下载进度）：选「稍后再说」保留安装包，重启后同名文件存在即秒回已就绪并再次提示；选「跳过此版本」写 localStorage `adm_skip_update_version`，静默检查不再打扰、手动检查仍提示。升级提示（下载进度 / 已就绪 / 无安装包地址三个变体）都带「查看更新内容」按钮，链接取 `check_update` 返回的 `changelog_url`（update.json 各平台 `content` 字段，仅 http(s) 才渲染），经 `openUrl` 用系统浏览器打开。Rust 端两个命令（`pages/index.rs`，已在 `lib.rs` 注册）：`download_app_update(version,url)`（发 `app-update-progress` 事件、下载前清理其它版本残留包）、`install_app_update(path)`（只允许运行 updates 目录内的文件 → 拉起/执行安装 → `cleanup_processes` + `app.exit(0)`；安装包 Windows 用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 并尝试脱离 Job，macOS 走 `open <dmg>`，Linux 按扩展名分流——**deb 必须走包管理器，直接 exec 会 ENOEXEC**：`pkexec --disable-internal-agent env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends <deb>`，输出重定向到 `<包名>.install.log` 且必须等退出码（失败/授权取消时保持应用运行，弹窗展示 `sudo apt install` 指引与 apt 输出尾段；`--disable-internal-agent` 防止 pkexec 内部文本代理从 null stdin 读密码把弹窗挂到超时），AppImage 则在 `$APPIMAGE` 存在时用临时文件 + rename 覆盖当前 AppImage 后再启动，否则只补可执行位拉起）。该命令为 async + `spawn_blocking`：Linux 等待安装可能耗时数十秒，不能占住 async 运行时。前端失败标题按 `appUpdate.phase`（download/install）区分，安装阶段失败用 `getErrorMessage` 原样展示后端中文指引（**不能走 friendlyError**——指引里含 `sudo`/路径等英文会被整段丢弃，只剩"操作失败，任务中断"，这正是 0.7.4→0.7.5 Linux 升级报错的成因）。安装包目录用 `app_data_dir` 而非 exe 目录（Program Files 下不可写）。升级提示会等 VC++/llamacpp 引导弹窗关闭后再弹（`updateDialogOwner !== "app-update"` 时挂起），避免互相覆盖。
- **MTP 自动检测**：如果模型文件名包含 "mtp"（不区分大小写），`start_model` 会自动追加 `--spec-draft-n-max 2 --spec-type draft-mtp`。设置 `params.spec_type = "none"` 可禁用。
- **llama-server 运行期崩溃：收尾 / 提示 / 受控自动重启**（`model_list.rs`、`app_state.rs`、`src/index.html`）：监控线程把退出分成两类——`startup_failed`（`READY_PROBE_SECS` 内未就绪退出 → 原有 `model-error`）与 `runtime_crash`（曾就绪或已过启动窗口 → 新事件 `model-crashed`，payload `model_id/exit_code/reason/auto_restart`，同时写 JSONL 的 `model.crash` / `model.exit` / `model.restart`）。要点：① `model_stop_intent` 只消费一次，用户主动停止/应用退出都不上报崩溃；② 清理 `AppState` 与发 `model-stopped` 前先校验 `running_process == pid`——「停止后立刻重启」时旧进程的迟到收尾不得抹掉新进程状态（原实现无条件清理，会把新进程运行态清空）；③ `AppState.last_model_launch` 记录本次启动参数，运行期崩溃后延迟 2s 用 `start_model_inner` 复用正常启动链路自动拉起一次（会重新走模型能力同步与 `model-started`），`AppState.last_auto_restart` 做 10 分钟节流：窗口内再次崩溃只提示不拉起，避免 Vulkan DeviceLost 这类驱动级故障形成「崩溃→重启→再崩溃」循环；`start_model_inner` 全程持有 `AppState.model_start_lock`，命令入口与自动重启因此串行（两边同时通过「已有模型在运行」检查会各 spawn 一个引擎，后写状态者抢端口失败退出还会把状态清成已停止）；`cleanup_processes` 最先置位 `AppState.app_exiting`，延迟中的自动重启与退出过程中的手动启动据此放弃拉起，避免应用退出后遗留孤儿 llama-server；④ `reason` 取 stdout/stderr 最后一行（llama.cpp 的致命错误只走 stderr）；⑤ 壳层 `index.html` 的 `initModelLifecycleNotices()` 常驻监听 `model-started/stopped/crashed`，同步 `window.__adm_state.runningModelId/Port` 并弹全局 toast——视图级监听只在模型页挂载期间有效，用户在 Agent 页时推理引擎崩溃会让运行标识停在旧值，下一次发送直接打到已死端口（2026-11 日志实测 DeviceLost 崩溃后两次「继续」都是 connection refused）。Agent 侧对应的错误分类见 [`frontend-agent-conventions.md`](frontend-agent-conventions.md)。
- **VC++ 运行库检测（Windows）**：`check_vc_redist_installed`（`index.rs`）以 DLL 实检为准——`C:\Windows\System32` 或可执行文件同目录下必须同时存在 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll`。**不要改回注册表判断或只查 `vcruntime140.dll`**：旧版 2015/2017 运行库同样写 `Installed=0x1`，会把缺 `vcruntime140_1.dll` 的机器误判为已安装。调用点：启动检测（`check_update`；网络失败时前端改走独立命令 `check_vc_redist`）、点「安装完成」后的复验，以及 `start_model` / `get_llamacpp_version` 拉起进程前的预检——缺失时直接返回错误、**不 spawn**（否则 Windows 加载器会弹「找不到 VCRUNTIME140_1.dll」系统错误框并把进程卡住，`spawn()` 本身不报错）。
- **HuggingFace 镜像**：`download_model` 会自动将所有 `huggingface.co` 链接替换为 `hf-mirror.com`。
- **撤销能力探测（`check_git_repo`）**：Agent 的「撤销」靠 admAgent 每轮开始前的 git 工作树快照回退文件改动，非 git 仓库（或机器没装 git）时服务端只能删消息、文件改动留在原地。`check_git_repo(path)` 在目标目录跑 `git rev-parse --is-inside-work-tree`，返回 `{git_installed, is_repo}`——两个字段必须分开：spawn 的 `NotFound` = 没装 git，装了但不是仓库 = 另一条提示语。**不要改成只看 `.git` 目录**：工作目录可能是仓库子目录，`.git` 也可能是文件（worktree / submodule）。前端 `undo.js` 按工作目录缓存结果，只在确认弹窗里加提示、不禁用撤销入口（对话记录仍能回滚）。
- **远程模型清单的本地缓存**（`model_list.rs`）：`fetch_model_list` **每次都整包拉取**远程 `model.json`，对响应原文算哈希（标准库 `DefaultHasher`，`content_hash`）与缓存里的 `hash` 比对：一致 → 不碰磁盘；不一致 → 返回新列表并刷新数据目录下的 `model_list_cache.json`（`fetched_at` + `hash` + 解析后的 `models`）。**故意不用 `ETag`/`Last-Modified` 条件请求**：静态服务器的校验头是秒级 + 尺寸粒度，原地改文件若落在同一秒且字节数不变（改个模型名、调换行），服务端照样回 304，条件请求会永远看不到这次变更，补 TTL 强制重拉又等于把逻辑绕回来。用内容哈希则判定只看真实内容，一层就够。注意哈希算的是**原文**，纯格式调整（缩进/换行/键顺序）也会算一次更新并重写缓存——只多一次磁盘写，无副作用。两条兜底必须保留：远端解析出**空列表**时按异常处理、退回已有缓存（否则一次误发布的 `[]` 会把 last-known-good 冲掉，之后断网连兜底都没了），写入用进程内 `Mutex` 串行化（切页重挂载会让两个 `fetch_model_list` 并发收尾，`fs::write` 先截断再写、并发会互相截断成半截 JSON；不用 `.tmp`+`rename` 是因为 macOS 上 rename 在沙箱/权限场景会失败）。本模块的缓存日志统一走 `api_debug_log`（`dbg_log!` 在 release 包被编译掉，线上无法判断是刷新还是退回旧缓存）。联网失败 / 非 2xx / 解析失败时**有缓存就退回缓存**（静默，不弹错），无缓存才报错；有缓存时 HTTP 超时收到 10s（无缓存 30s），避免离线/弱网下首页白等。前端 `model_list.js` 先用 `get_cached_model_list` 画一版卡片，再等 `fetch_model_list` 的校验结果覆盖——不要把它合回单次 `fetch_model_list`，否则断网时首屏要等满超时才有内容。若远端前面挂了长缓存的 CDN，需要给 URL 加时间戳参数（`?_n=<ts>`）打穿缓存，否则拿到的是 CDN 的旧副本。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。
- **更新流程**：启动后延迟 3 秒 → 应用更新 → VC++ 运行库（仅 Windows）→ llamacpp 下载。admAgent 不再运行时下载/升级，随安装包内置（见下）。

## 平台差异与运行库预检

- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。
- **Linux**：数据目录（config.json / models / llamacpp / agent 数据）与 macOS 一致走用户数据目录（`config.rs` 的 `get_data_dir` / `get_base_dir` → `~/.local/share/com.adm.admapp`）——deb 装在 `/usr/bin`、AppImage 是只读挂载点，写 exe 同目录必然失败；内置 admAgent sidecar 与主程序同目录（`/usr/bin`，`agent.rs` 的 `adm_agent_target_dir`）。llama.cpp 用 `https://adm.tuduoduo.top/llamacpp/ubuntu-vulkan.tar.gz`（只发布 Vulkan 构建，NVIDIA/AMD/Intel 通用，**运行时依赖用户机器的 `libvulkan1` + 显卡 Vulkan 驱动**）；启动/取版本时设 `LD_LIBRARY_PATH`（`model_list.rs` / `settings.rs`）。
- **llama.cpp 运行库预检**：Windows 在 `start_model` / `get_llamacpp_version` / `reinstall_llamacpp` 前硬拦 VC++ 运行库缺失（缺 DLL 会弹系统错误框）。Linux 的对应依赖是 `libvulkan1` + 显卡 Vulkan 驱动（`index.rs` 的 `llamacpp_runtime_warning()`：`ldconfig -p` 找 `libvulkan.so.1` + `/usr/share/vulkan/icd.d` 找 ICD，认 `VK_ICD_FILENAMES`/`VK_DRIVER_FILES`），**只提示不阻断**（缺了仍可 CPU 推理）：装 llamacpp 的弹窗开始下载前调 `check_llamacpp_runtime` 命令把原因显示出来，`start_model` 另发一条 `[WARN]` model-log。

## 进程清理

- **窗口关闭**：`on_window_event` 通过 `taskkill /F`（Windows）或 `kill -9` 杀死 llama-server 和 admAgent server。
