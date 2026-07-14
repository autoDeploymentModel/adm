// agent.html 对应逻辑（Agent 终端：本地 admAgent 工具检测 / 下载 / 内嵌终端）

use crate::app_state::{AppState, AgentSession};
use crate::common::config;
use crate::common::types::Settings;
use crate::common::types::AdmAgentUpdateCheck;
use crate::common::utils::platform;
use crate::common::error::AppError;
use crate::bail;
use crate::pages::index::fetch_update_info;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;

// 读取配置文件中的 agent 工作目录（默认空）
fn load_agent_workdir(app: &tauri::AppHandle) -> String {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let config_path = data_dir.join("config.json");
    if let Ok(json) = std::fs::read_to_string(&config_path) {
        if let Ok(settings) = serde_json::from_str::<Settings>(&json) {
            return settings.agent_workdir;
        }
    }
    String::new()
}

// 原子写入工作目录到配置文件
fn save_agent_workdir(app: &tauri::AppHandle, workdir: &str) -> Result<(), AppError> {
    let data_dir = config::get_data_dir(Some(app))?;
    let config_path = data_dir.join("config.json");

    let mut settings = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str::<Settings>(&json)
            .map_err(|e| format!("解析配置文件失败: {}", e))?
    } else {
        Settings::default()
    };

    settings.agent_workdir = workdir.to_string();

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    let temp_path = config_path.with_extension("tmp");
    std::fs::write(&temp_path, json).map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    std::fs::rename(&temp_path, &config_path)
        .map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

// ===== 平台相关路径与下载地址 =====

/// admAgent 默认存放目录：
/// - Windows：软件所在根目录（可执行文件所在目录）
/// - macOS：应用用户目录（app_data_dir，如 ~/Library/Application Support/com.adm.admapp）
#[allow(unused_variables)]
fn adm_agent_target_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "windows")]
    {
        config::get_exe_dir()
    }
    #[cfg(target_os = "macos")]
    {
        config::get_data_dir(Some(app))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        bail!("不支持的操作系统，当前仅支持 Windows / macOS")
    }
}

/// admAgent 文件名
fn adm_agent_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "admAgent.exe"
    } else {
        "admAgent"
    }
}

/// admAgent 下载地址
fn adm_agent_download_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://adm.tuduoduo.top/agent/win/admAgent.exe"
    } else {
        "http://adm.tuduoduo.top/admAgent"
    }
}

fn adm_agent_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(adm_agent_target_dir(app)?.join(adm_agent_file_name()))
}

// ===== admAgent.json 配置（agent 启动前生成 / 更新）=====

/// 默认上下文大小（配置文件未显式配置 ctx_size 时使用，与示例一致）
const DEFAULT_CONTEXT_WINDOW: u32 = 128000;

/// 默认端口（配置文件未显式配置 port 时使用）
const DEFAULT_PORT: u16 = 1010;

/// admAgent.json 的存放目录：`$HOME/.config/admAgent`
/// Windows 下 $HOME 即 C:\Users\{username}，最终路径为 C:\Users\{username}\.config\admAgent
fn adm_agent_config_dir() -> Result<PathBuf, AppError> {
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(p) = std::env::var("HOME") {
        PathBuf::from(p)
    } else {
        return Err(AppError::msg("无法确定用户主目录，无法创建 admAgent 配置目录"));
    };
    Ok(home.join(".config").join("admAgent"))
}

/// 从 ADM 配置文件（config.json）读取上下文大小 ctx_size。
/// 读取失败或字段缺失时返回 None，由调用方决定是否回退到默认值。
fn load_ctx_size(app: &tauri::AppHandle) -> Option<i32> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.ctx_size
}

/// 从 ADM 配置文件（config.json）读取端口 port。
/// 读取失败或字段缺失时返回 None，由调用方决定是否回退到默认值。
fn load_port(app: &tauri::AppHandle) -> Option<u16> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.port
}

/// 根据上下文大小与端口构造完整的 admAgent.json 配置结构体。
/// default_max_tokens 取 context_window 的 30%（四舍五入为整数）。
fn build_adm_agent_config(context_window: u32, port: u16) -> serde_json::Value {
    let default_max_tokens = (context_window as f64 * 0.3).round() as u32;
    serde_json::json!({
        "providers": {
            "local": {
                "type": "openai-compat",
                "name": "Local",
                "base_url": format!("http://127.0.0.1:{}/v1", port),
                "models": [
                    {
                        "id": "localModel",
                        "name": "Local Model",
                        "context_window": context_window,
                        "default_max_tokens": default_max_tokens
                    }
                ]
            }
        },
        "models": {
            "large": { "provider": "local", "model": "localModel" },
            "small": { "provider": "local", "model": "localModel" }
        }
    })
}

/// 确保 admAgent.json 存在且 context_window / default_max_tokens / base_url 与当前配置一致。
///
/// - 目录不存在则创建。
/// - 文件不存在：写入完整的默认结构（context_window、port 来自配置，default_max_tokens = 30%）。
/// - 文件已存在：原地更新 providers.local.models[0] 的 context_window 与 default_max_tokens，
///   以及 providers.local.base_url 中的端口，尽量保留文件中其它字段；
///   若结构异常无法原地更新，则回退写入完整默认结构。
fn ensure_adm_agent_config(app: &tauri::AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx_size(app)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW as i32) as u32;

    let port = load_port(app).unwrap_or(DEFAULT_PORT);

    let dir = adm_agent_config_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 admAgent 配置目录失败: {}", e))?;
    let path = dir.join("admAgent.json");

    // 文件已存在：尝试原地更新 context_window 与 default_max_tokens
    if path.exists() {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&s) {
                let default_max_tokens = (ctx as f64 * 0.3).round() as u32;
                let mut updated = false;
                if let Some(models) = v
                    .get_mut("providers")
                    .and_then(|p| p.get_mut("local"))
                    .and_then(|l| l.get_mut("models"))
                    .and_then(|m| m.as_array_mut())
                {
                    if let Some(first) = models.get_mut(0) {
                        first["context_window"] = serde_json::json!(ctx);
                        first["default_max_tokens"] = serde_json::json!(default_max_tokens);
                        updated = true;
                    }
                    // 同步更新 base_url 中的端口
                    if let Some(base_url) = v
                        .get_mut("providers")
                        .and_then(|p| p.get_mut("local"))
                        .and_then(|l| l.get_mut("base_url"))
                    {
                        *base_url = serde_json::json!(format!("http://127.0.0.1:{}/v1", port));
                        updated = true;
                    }
                }
                if updated {
                    write_json_atomic(&path, &v)?;
                    return Ok(());
                }
            }
        }
    }

    // 文件不存在，或结构异常无法原地更新：写入完整默认结构
    let config = build_adm_agent_config(ctx, port);
    write_json_atomic(&path, &config)
}

/// 原子写入 JSON：先写临时文件再 rename，避免写入中途崩溃产生半截文件。
fn write_json_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 admAgent 配置失败: {}", e))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &json)
        .map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

/// 点击 Agent 按钮时的「更早时机」调用：仅生成 / 更新 admAgent.json 配置，
/// 不依赖模型是否已启动或 admAgent 是否已下载。供前端在 goAgent() 阶段提前调用，
/// 早于真正启动终端（start_agent_terminal 内部也会再调用一次以保证最终一致）。
#[tauri::command]
pub async fn prepare_adm_agent_config(app: tauri::AppHandle) -> Result<(), AppError> {
    ensure_adm_agent_config(&app)
}

// ===== 数据结构 =====

#[derive(Serialize)]
pub struct AdmAgentInfo {
    pub exists: bool,
    pub path: String,
}

// ===== Tauri Command =====

/// 返回当前操作系统标识：windows / macos / linux 等
/// 用于进入 Agent 页前做平台判断（仅 Windows 支持）
#[tauri::command]
pub fn get_platform_os() -> String {
    std::env::consts::OS.to_string()
}

/// 检查本地是否已下载 admAgent 工具
#[tauri::command]
pub async fn check_adm_agent(app: tauri::AppHandle) -> Result<AdmAgentInfo, AppError> {
    let path = adm_agent_path(&app)?;
    let exists = path.exists();
    Ok(AdmAgentInfo {
        exists,
        path: path.to_string_lossy().to_string(),
    })
}

/// 下载 admAgent 工具（不覆盖已存在的可执行权限问题，Windows 为 exe，macOS 为二进制）
#[tauri::command]
pub async fn download_adm_agent(app: tauri::AppHandle) -> Result<(), AppError> {
    let url = adm_agent_download_url().to_string();
    let dir = adm_agent_target_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let file_name = adm_agent_file_name();
    let dest = dir.join(file_name);

    app.emit(
        "agent-download-progress",
        serde_json::json!({ "status": "downloading", "progress": 0 }),
    )
    .ok();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !response.status().is_success() {
        bail!("下载失败，HTTP 状态码: {}", response.status());
    }

    let total_size: u64 = response.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("下载数据读取失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        let progress = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(99.0) as u8
        } else {
            0
        };

        app.emit(
            "agent-download-progress",
            serde_json::json!({ "status": "downloading", "progress": progress }),
        )
        .ok();
    }

    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    // macOS 需要赋予可执行权限
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| format!("读取权限失败: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| format!("设置执行权限失败: {}", e))?;
    }

    app.emit(
        "agent-download-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}

// ===== admAgent 版本检查与更新（接入主升级流程） =====

/// 归一化 admAgent 版本号：去掉首尾空白与开头的 'v' 前缀。
/// 例如 "v0.0.1-250db9" -> "0.0.1-250db9"。
/// 注意：admAgent 版本含 commit 短哈希后缀，不能按 semver 数值比较，
/// 故采用归一化后的字符串相等性判断。
fn normalize_agent_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

/// 解析 `admAgent -v` 输出，提取版本号。
/// 输出示例：`admAgent version v0.0.1-250db9`
fn parse_adm_agent_version_output(output: &str) -> Option<String> {
    let marker = "admAgent version ";
    let text = output.trim();
    if let Some(idx) = text.find(marker) {
        let ver = text[idx + marker.len()..].trim();
        if !ver.is_empty() {
            return Some(ver.to_string());
        }
    }
    // 兜底：整行看起来像版本号（以 v 开头且含 '.'）
    if text.starts_with('v') && text.contains('.') {
        return Some(text.to_string());
    }
    None
}

/// 获取本地已安装 admAgent 的版本号（运行 `admAgent -v`）。
/// 未安装或无法解析时返回 Ok(None)。
pub fn get_adm_agent_local_version(app: &tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = adm_agent_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("admAgent 路径包含非法字符: {}", path.display()))?;

    let output = platform::create_hidden_command(path_str)
        .arg("-v")
        .output()
        .map_err(|e| format!("运行 admAgent 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    Ok(parse_adm_agent_version_output(&combined))
}

/// 下载并替换 admAgent 工具（版本更新用）。
/// 使用服务端下发的下载地址，下载到 admAgent 默认存放路径并覆盖旧版本。
#[tauri::command]
pub async fn download_adm_agent_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    if url.trim().is_empty() || !url.starts_with("http") {
        bail!(
            "下载地址无效: {}，请重新检查更新",
            if url.is_empty() { "地址为空" } else { &url }
        );
    }

    let dest = adm_agent_path(&app)?;
    let dir = dest
        .parent()
        .ok_or_else(|| "无法获取 admAgent 目录".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // 临时文件：同名 .part，下载完成后替换，避免长时间占用导致锁定问题
    let part_path = dir.join(format!("{}.part", adm_agent_file_name()));

    app.emit(
        "adm-agent-update-progress",
        serde_json::json!({ "status": "downloading", "progress": 0 }),
    )
    .ok();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client.get(&url).send().await.map_err(|e| {
        let detail = if e.is_connect() {
            format!("无法连接到服务器（{}），请检查网络连接", url)
        } else if e.is_timeout() {
            "连接超时，请检查网络或更换网络环境".to_string()
        } else {
            format!("{}", e)
        };
        format!("下载请求失败: {}", detail)
    })?;

    if !response.status().is_success() {
        bail!("下载失败，HTTP 状态码: {}", response.status());
    }

    let total_size: u64 = response.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("创建临时文件失败: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("下载数据读取失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        let progress = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(99.0) as u8
        } else {
            0
        };
        app.emit(
            "adm-agent-update-progress",
            serde_json::json!({ "status": "downloading", "progress": progress }),
        )
        .ok();
    }
    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    // 替换前先停掉正在运行的 Agent 终端，释放被 Windows 锁定的 admAgent.exe。
    // 典型场景：用户离开 Agent 页但进程未退出，再次进入触发更新时 admAgent.exe 仍在运行，
    // 不先结束进程会导致下方 rename 失败（表现即「升级失败」）。这里自动结束进程，
    // 无需用户手动去关 Agent 终端。进程被杀后，PTY 读取线程会自然收到 EOF 并推送
    // agent-terminal-exit 事件，前端会显示「进程已退出」，并在更新完成后自动重启。
    {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(mut sess) = s.take() {
            kill_agent_child_tree(&mut sess.child);
        }
    }

    // 替换旧文件：先尝试删除旧文件（进程刚结束可能仍有极短占用，故带重试），再重命名。
    if dest.exists() {
        let mut removed = false;
        for _ in 0..15 {
            if std::fs::remove_file(&dest).is_ok() {
                removed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if !removed {
            bail!("替换 admAgent 失败：旧文件仍被占用，请手动关闭 Agent 终端后重试");
        }
    }
    std::fs::rename(&part_path, &dest).map_err(|e| {
        format!(
            "替换 admAgent 失败: {}（可能 admAgent 正在运行，请关闭 Agent 终端后重试）",
            e
        )
    })?;

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| format!("读取权限失败: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| format!("设置执行权限失败: {}", e))?;
    }

    app.emit(
        "adm-agent-update-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}

/// 检查 admAgent 是否需要更新（仅在点击底部栏 Agent 按钮时调用，不在启动时检查）。
/// 优先级由前端 goAgent 控制：先判断模型是否启动，再判断本地是否下载，最后判断版本号。
#[tauri::command]
pub async fn check_adm_agent_update(app: tauri::AppHandle) -> Result<AdmAgentUpdateCheck, AppError> {
    // 仅 Windows 提供下载地址（mac/linux 暂不支持自动更新）
    #[cfg(target_os = "windows")]
    let download_url = Some("https://adm.tuduoduo.top/agent/win/admAgent.exe".to_string());
    #[cfg(not(target_os = "windows"))]
    let download_url: Option<String> = None;

    let mut needs_update = false;
    let mut local_version: Option<String> = None;
    let mut remote_version: Option<String> = None;

    // 拉取远程更新清单（失败时不强制更新，仅返回本地版本）
    let update_info = match fetch_update_info().await {
        Ok(info) => info,
        Err(_) => {
            local_version = get_adm_agent_local_version(&app).ok().flatten();
            return Ok(AdmAgentUpdateCheck {
                needs_update,
                remote_version,
                local_version,
                download_url,
            });
        }
    };
    remote_version = update_info.adm_agent_version.clone();

    if let Some(ref remote_ver) = remote_version {
        // 仅在能拿到下载地址（Windows）时才判定需要更新
        if download_url.is_some() {
            match get_adm_agent_local_version(&app) {
                Ok(local_opt) => {
                    local_version = local_opt.clone();
                    match local_opt {
                        None => {
                            // 本地未安装，需要下载（首次安装由 goAgent 的 check_adm_agent 流程处理）
                            needs_update = true;
                        }
                        Some(local) => {
                            if normalize_agent_version(&local) != normalize_agent_version(remote_ver) {
                                needs_update = true;
                            }
                        }
                    }
                }
                Err(_) => {
                    // 无法运行/解析，标记 unknown 但不强制下载
                    local_version = Some("unknown".to_string());
                }
            }
        }
    }

    Ok(AdmAgentUpdateCheck {
        needs_update,
        remote_version,
        local_version,
        download_url,
    })
}

/// 获取已配置的 agent 工作目录（默认为空字符串）
#[tauri::command]
pub async fn get_agent_workdir(app: tauri::AppHandle) -> Result<String, AppError> {
    Ok(load_agent_workdir(&app))
}

/// 保存 agent 工作目录到配置文件
#[tauri::command]
pub async fn set_agent_workdir(app: tauri::AppHandle, workdir: String) -> Result<(), AppError> {
    save_agent_workdir(&app, workdir.trim())
}

/// Agent 终端当前状态：进程是否仍在运行 + 当前模型代次。
/// 供前端每次进入 Agent 页时判断是否需要 (重)启动 admAgent：
/// - `running=false`：进程已退出（含崩溃），需要重新拉起；
/// - `model_generation` 与启动时记录的不一致：模型被重启过，旧 admAgent 仍连着旧模型实例，需要重启；
/// - 两者都没变：保持原状，不自动退出（哪怕只是切换页面，或仅改了上下文配置但没重启模型）。
#[derive(Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub model_generation: u64,
}

#[tauri::command]
pub async fn get_agent_status(
    state: tauri::State<'_, AppState>,
) -> Result<AgentStatus, AppError> {
    let mut s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    // try_wait 返回 Ok(None) 表示仍在运行；Ok(Some(_)) 表示已退出；Err 视为不可知 → 视为未运行
    let running = match s.as_mut() {
        Some(sess) => match sess.child.try_wait() {
            Ok(None) => true,
            _ => false,
        },
        None => false,
    };
    let model_generation = *state
        .model_generation
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(AgentStatus {
        running,
        model_generation,
    })
}

/// 启动内嵌终端（Windows 调用 powershell，macOS 调用系统默认 shell），并自动启动 admAgent 工具
/// `rows` / `cols` 为前端 xterm 当前真实尺寸：必须用真实尺寸创建 PTY，否则 admAgent 启动时会按
/// PTY 默认宽度（120 列）布局其 TUI（右边栏上下文实时统计等），而实际显示宽度不同，导致错位/刷新异常。
#[tauri::command]
pub async fn start_agent_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    // 若已有会话，先关闭旧会话
    {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(mut old) = s.take() {
            let _ = old.child.kill();
        }
    }

    // 用前端真实尺寸创建 PTY；缺失时回退到合理默认（避免 admAgent 以固定 120 列布局 TUI 错位）
    let rows = if rows > 0 { rows } else { 30 };
    let cols = if cols > 0 { cols } else { 120 };

    // 启动前：读取配置文件中的上下文大小（ctx_size），生成 / 更新 admAgent.json
    if let Err(e) = ensure_adm_agent_config(&app) {
        eprintln!("[admAgent] 生成 admAgent.json 配置失败: {}", e);
    }

    let agent_path = adm_agent_path(&app)?;
    if !agent_path.exists() {
        bail!("未找到 admAgent 工具: {}", agent_path.display());
    }

    // 创建 PTY（使用前端真实尺寸）
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建终端失败: {}", e))?;

    // 读取工作目录（Windows 直接作为 admAgent 的 --cwd 参数；macOS 走 zsh 启动命令时使用）
    let workdir = load_agent_workdir(&app);

    // 构造要启动的命令。
    // Windows：直接启动 admAgent.exe，不再经过 powershell.exe。
    // 原因：release 版 adm.exe 带 #![windows_subsystem = "windows"]（无控制台），
    // portable-pty 的 ConPTY 在「无控制台父进程」中启动 powershell 时，powershell
    // 初始化失败并弹 0xc0000142 错误。直接以 admAgent 作为 PTY 子进程即可规避。
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = CommandBuilder::new(agent_path.clone());
        if !workdir.is_empty() {
            c.arg("--cwd");
            c.arg(&workdir);
        }
        c
    } else {
        let shell = std::env::var("SHELL")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
        let mut c = CommandBuilder::new(shell);
        c.arg("-i"); // 交互式 shell
        c
    };
    // 设置 TERM，提升 admAgent 等 TUI 程序的终端能力识别（如真彩色、清行序列）
    cmd.env("TERM", "xterm-256color");
    if let Some(parent) = agent_path.parent() {
        cmd.cwd(parent);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动终端失败: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取终端读取失败: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取终端写入失败: {}", e))?;

    // 启动后台读取线程，将 PTY 输出流式推送到前端
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(
                        "agent-terminal-data",
                        serde_json::json!({ "data": encoded }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit("agent-terminal-exit", serde_json::json!({}));
    });

    // 保存会话
    {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        *s = Some(AgentSession {
            master: pair.master,
            writer,
            child,
        });
    }

    // 自动在终端中启动 admAgent 工具。
    // Windows：上面已直接以 admAgent 作为 PTY 子进程启动，无需再向 shell 写启动命令。
    // macOS：走 zsh -i，需要显式写入启动命令。
    #[cfg(target_os = "macos")]
    {
        let launch = if workdir.is_empty() {
            format!("\"{}\"\r\n", agent_path.display())
        } else {
            format!("\"{}\" --cwd \"{}\"\r\n", agent_path.display(), workdir)
        };
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(ref mut sess) = *s {
            let _ = sess.writer.write_all(launch.as_bytes());
            let _ = sess.writer.flush();
        }
    }

    app.emit("agent-terminal-ready", serde_json::json!({})).ok();
    Ok(())
}

/// 向终端写入输入（前端按键）
#[tauri::command]
pub async fn agent_terminal_input(
    state: tauri::State<'_, AppState>,
    data: String,
) -> Result<(), AppError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("解码输入失败: {}", e))?;
    let mut s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(ref mut sess) = *s {
        sess.writer
            .write_all(&decoded)
            .map_err(|e| e.to_string())?;
        sess.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 调整终端大小
#[tauri::command]
pub async fn agent_terminal_resize(
    state: tauri::State<'_, AppState>,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    let s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(ref sess) = *s {
        sess.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整终端大小失败: {}", e))?;
    }
    Ok(())
}

/// 终止 Agent 终端进程及其整个进程树。
/// admAgent 是在 shell（powershell）内部以 `& "路径"` 启动的，属于 shell 的子进程；
/// Windows 上仅 kill 直接子进程（shell）不会连带结束 admAgent（会变为孤儿进程残留）。
/// 因此用 `taskkill /PID <pid> /T /F` 杀掉整棵进程树，确保 admAgent 一并退出。
#[cfg(target_os = "windows")]
fn kill_agent_child_tree(child: &mut Box<dyn Child + Send>) {
    if let Some(pid) = child.process_id() {
        let pid_str = pid.to_string();
        let _ = platform::create_hidden_command("taskkill")
            .args(["/PID", &pid_str, "/T", "/F"])
            .spawn();
    }
    // 兜底：直接 kill 一次
    let _ = child.kill();
}

#[cfg(not(target_os = "windows"))]
fn kill_agent_child_tree(child: &mut Box<dyn Child + Send>) {
    let _ = child.kill();
}

/// 关闭终端会话
#[tauri::command]
pub async fn stop_agent_terminal(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let mut s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(mut sess) = s.take() {
        kill_agent_child_tree(&mut sess.child);
    }
    Ok(())
}

/// 窗口关闭时清理 Agent 会话（供 lib.rs 调用）
pub fn kill_agent_session(state: &AppState) {
    if let Ok(mut s) = state.agent_session.lock() {
        if let Some(mut sess) = s.take() {
            kill_agent_child_tree(&mut sess.child);
        }
    }
}
