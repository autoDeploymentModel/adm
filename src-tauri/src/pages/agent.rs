// agent.html 对应逻辑（Agent 终端：启动独立控制台窗口运行 admAgent）

use crate::app_state::AppState;
use crate::common::config;
use crate::common::types::Settings;
use crate::common::types::AdmAgentUpdateCheck;
use crate::common::error::AppError;
use crate::common::utils::platform::create_hidden_command;
use crate::bail;
use crate::pages::index::fetch_update_info;

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;

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

// ===== 配置文件读写 =====

/// 读取配置文件中的 agent 工作目录（默认空）
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

/// 原子写入工作目录到配置文件
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
    std::fs::rename(&temp_path, config_path)
        .map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

// ===== admAgent.json 配置 =====

const DEFAULT_CONTEXT_WINDOW: u32 = 128000;
const DEFAULT_PORT: u16 = 1010;

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

fn load_ctx_size(app: &tauri::AppHandle) -> Option<i32> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.ctx_size
}

fn load_port(app: &tauri::AppHandle) -> Option<u16> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.port
}

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

fn write_json_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 admAgent 配置失败: {}", e))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &json)
        .map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

fn ensure_adm_agent_config(app: &tauri::AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx_size(app)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW as i32) as u32;
    let port = load_port(app).unwrap_or(DEFAULT_PORT);

    let dir = adm_agent_config_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 admAgent 配置目录失败: {}", e))?;
    let path = dir.join("admAgent.json");

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

    let config = build_adm_agent_config(ctx, port);
    write_json_atomic(&path, &config)
}

// ===== admAgent 版本检查与更新 =====

fn normalize_agent_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

fn parse_adm_agent_version_output(output: &str) -> Option<String> {
    let marker = "admAgent version ";
    let text = output.trim();
    if let Some(idx) = text.find(marker) {
        let ver = text[idx + marker.len()..].trim();
        if !ver.is_empty() {
            return Some(ver.to_string());
        }
    }
    if text.starts_with('v') && text.contains('.') {
        return Some(text.to_string());
    }
    None
}

pub fn get_adm_agent_local_version(app: &tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = adm_agent_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("admAgent 路径包含非法字符: {}", path.display()))?;

    let output = create_hidden_command(path_str)
        .arg("-v")
        .output()
        .map_err(|e| format!("运行 admAgent 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    Ok(parse_adm_agent_version_output(&combined))
}

// ===== 数据结构 =====

#[derive(Serialize)]
pub struct AdmAgentInfo {
    pub exists: bool,
    pub path: String,
}

#[derive(Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub model_generation: u64,
}

// ===== Tauri Commands =====

#[tauri::command]
pub fn get_platform_os() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn check_adm_agent(app: tauri::AppHandle) -> Result<AdmAgentInfo, AppError> {
    let path = adm_agent_path(&app)?;
    let exists = path.exists();
    Ok(AdmAgentInfo {
        exists,
        path: path.to_string_lossy().to_string(),
    })
}

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

    // 替换前先停掉正在运行的 Agent（关闭独立控制台窗口）
    {
        let mut s = state
            .agent_process
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(pid) = s.take() {
            kill_process_tree(pid);
        }
    }

    // 替换旧文件
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

#[tauri::command]
pub async fn check_adm_agent_update(app: tauri::AppHandle) -> Result<AdmAgentUpdateCheck, AppError> {
    #[cfg(target_os = "windows")]
    let download_url = Some("https://adm.tuduoduo.top/agent/win/admAgent.exe".to_string());
    #[cfg(not(target_os = "windows"))]
    let download_url: Option<String> = None;

    let mut needs_update = false;
    let mut local_version: Option<String> = None;
    let mut remote_version: Option<String> = None;

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
        if download_url.is_some() {
            match get_adm_agent_local_version(&app) {
                Ok(local_opt) => {
                    local_version = local_opt.clone();
                    match local_opt {
                        None => {
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

#[tauri::command]
pub async fn prepare_adm_agent_config(app: tauri::AppHandle) -> Result<(), AppError> {
    ensure_adm_agent_config(&app)
}

#[tauri::command]
pub async fn get_agent_workdir(app: tauri::AppHandle) -> Result<String, AppError> {
    Ok(load_agent_workdir(&app))
}

#[tauri::command]
pub async fn set_agent_workdir(app: tauri::AppHandle, workdir: String) -> Result<(), AppError> {
    save_agent_workdir(&app, workdir.trim())
}

#[tauri::command]
pub async fn get_agent_status(
    state: tauri::State<'_, AppState>,
) -> Result<AgentStatus, AppError> {
    let running = {
        let mut s = state
            .agent_process
            .lock()
            .map_err(|e| e.to_string())?;
        match *s {
            Some(pid) => {
                if is_process_alive(pid) {
                    true
                } else {
                    // 进程已退出，清理 PID
                    *s = None;
                    false
                }
            }
            None => false,
        }
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

/// 检查进程是否仍在运行（通过 OpenProcess / GetExitCodeProcess）
#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{
        OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        let handle = match handle {
            Ok(h) if !h.is_invalid() => h,
            _ => return false,
        };
        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        match result {
            Ok(_) => exit_code == STILL_ACTIVE.0 as u32,
            Err(_) => false,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn is_process_alive(pid: u32) -> bool {
    let output = create_hidden_command("kill")
        .args(["-0", &pid.to_string()])
        .output();
    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// 终端窗口期望的尺寸
#[cfg(target_os = "windows")]
const CONSOLE_WINDOW_WIDTH: i32 = 1280;
#[cfg(target_os = "windows")]
const CONSOLE_WINDOW_HEIGHT: i32 = 800;

/// 启动独立控制台窗口运行 admAgent（PowerShell）。
#[tauri::command]
pub async fn start_agent_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    // 先关掉已有会话（阻塞等待 taskkill 完成）
    {
        let mut s = state.agent_process.lock().map_err(|e| e.to_string())?;
        if let Some(pid) = s.take() {
            kill_process_tree(pid);
        }
    }

    // 确保配置存在
    if let Err(e) = ensure_adm_agent_config(&app) {
        eprintln!("[admAgent] 生成 admAgent.json 配置失败: {}", e);
    }

    let agent_path = adm_agent_path(&app)?;
    if !agent_path.exists() {
        bail!("未找到 admAgent 工具: {}", agent_path.display());
    }

    let workdir = load_agent_workdir(&app);

    #[cfg(target_os = "windows")]
    {
        let agent_path_str = agent_path.to_string_lossy().to_string();
        // PowerShell 命令行：pwsh -NoExit -Command "..."
        // & 调用运算符运行 admAgent；$Host.UI.RawUI.WindowTitle 设置窗口标题
        let ps_cmd = if workdir.is_empty() {
            format!(
                "$Host.UI.RawUI.WindowTitle = 'ADM Agent'; & '{}'",
                agent_path_str.replace('\'', "''")
            )
        } else {
            format!(
                "$Host.UI.RawUI.WindowTitle = 'ADM Agent'; & '{}' --cwd '{}'",
                agent_path_str.replace('\'', "''"),
                workdir.replace('\'', "''")
            )
        };

        // 优先 pwsh (PowerShell 7+)，回退 powershell (Windows 内置 5.1)
        let shell = find_powershell().unwrap_or_else(|| "powershell.exe".to_string());
        let cmd_line = format!(
            " -NoExit -Command \"{}\"",
            ps_cmd.replace('"', "\\\"")
        );

        // 启动前快照所有控制台窗口
        let snapshot = snapshot_console_windows();

        let pid = spawn_console_process(&shell, &cmd_line, &workdir)
            .map_err(|e| format!("启动终端窗口失败: {}", e))?;

        if pid > 0 {
            let mut s = state.agent_process.lock().map_err(|e| e.to_string())?;
            *s = Some(pid);
            // 后台线程：找新增的控制台窗口 → 调整大小居中
            center_console_window(snapshot);
        } else {
            bail!("启动终端窗口失败：无法获取 PID");
        }
    }

    #[cfg(target_os = "macos")]
    {
        let agent_path_str = agent_path.to_string_lossy().to_string();
        let ps_cmd = if workdir.is_empty() {
            agent_path_str.clone()
        } else {
            format!("cd \"{}\" && {}", workdir, agent_path_str)
        };

        // osascript 会在 Terminal 中执行 ps_cmd；osascript 自身随即退出
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            ps_cmd.replace('\\', "\\\\").replace('"', "\\\"")
        );

        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();

        // 等待并定位实际的 admAgent 进程 PID（osascript 已退出，不能再用它的 PID）
        let mut found_pid = 0u32;
        for _ in 0..40 {
            // 最多等 4 秒
            std::thread::sleep(Duration::from_millis(100));
            if let Ok(output) = create_hidden_command("pgrep")
                .args(["-n", "-f", "admAgent"])
                .output()
            {
                if output.status.success() && !output.stdout.is_empty() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(line) = stdout.lines().next() {
                        if let Ok(pid) = line.trim().parse::<u32>() {
                            found_pid = pid;
                            break;
                        }
                    }
                }
            }
        }

        if found_pid > 0 {
            let mut s = state.agent_process.lock().map_err(|e| e.to_string())?;
            *s = Some(found_pid);
        } else {
            bail!("启动终端失败：无法定位 admAgent 进程（请确认 admAgent 已在 Terminal 中启动）");
        }
    }

    Ok(())
}

/// 查找 PowerShell：优先 pwsh (PowerShell 7+)，回退 powershell (内置 5.1)
#[cfg(target_os = "windows")]
fn find_powershell() -> Option<String> {
    // 尝试 where pwsh
    if let Ok(output) = create_hidden_command("where").arg("pwsh").output() {
        if output.status.success() && !output.stdout.is_empty() {
            let path = String::from_utf8_lossy(&output.stdout);
            let path = path.lines().next().unwrap_or("").trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    // 回退到系统内置 powershell.exe
    if let Ok(output) = create_hidden_command("where").arg("powershell").output() {
        if output.status.success() && !output.stdout.is_empty() {
            let path = String::from_utf8_lossy(&output.stdout);
            let path = path.lines().next().unwrap_or("").trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// 使用 CreateProcessW 创建独立控制台窗口。
#[cfg(target_os = "windows")]
fn spawn_console_process(shell: &str, args: &str, workdir: &str) -> Result<u32, String> {
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_CONSOLE,
        PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows::core::PCWSTR;
    use std::os::windows::ffi::OsStrExt;

    // lpApplicationName = shell 路径（支持含空格的路径如 C:\Program Files\...）
    let mut shell_wide: Vec<u16> = std::ffi::OsStr::new(shell).encode_wide().collect();
    shell_wide.push(0);

    // lpCommandLine = 仅参数部分（不含 shell 名称）
    let mut args_wide: Vec<u16> = std::ffi::OsStr::new(args).encode_wide().collect();
    args_wide.push(0);

    // 构造宽字符工作目录
    let workdir_wide: Vec<u16> = if workdir.is_empty() {
        vec![]
    } else {
        let mut w: Vec<u16> = std::ffi::OsStr::new(workdir).encode_wide().collect();
        w.push(0);
        w
    };

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let cwd_ptr = if workdir_wide.is_empty() {
        PCWSTR::null()
    } else {
        PCWSTR(workdir_wide.as_ptr())
    };

    let result = unsafe {
        CreateProcessW(
            windows::core::PCWSTR(shell_wide.as_ptr()),
            windows::core::PWSTR(args_wide.as_mut_ptr()),
            None,
            None,
            false,
            CREATE_NEW_CONSOLE,
            None,
            cwd_ptr,
            &si,
            &mut pi,
        )
    };

    match result {
        Ok(_) => {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(pi.hThread);
                let _ = windows::Win32::Foundation::CloseHandle(pi.hProcess);
            }
            Ok(pi.dwProcessId)
        }
        Err(e) => Err(format!("{}", e)),
    }
}

// ===== 控制台窗口定位（快照法） =====

/// 枚举所有"控制台窗口类"的窗口句柄
#[cfg(target_os = "windows")]
fn snapshot_console_windows() -> Vec<usize> {
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW};
    use windows::Win32::Foundation::LPARAM;

    let mut results: Vec<usize> = Vec::new();

    unsafe extern "system" fn enum_proc(hwnd: windows::Win32::Foundation::HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut buf);
        if len > 0 {
            let class = String::from_utf16_lossy(&buf[..len as usize]);
            if class == "ConsoleWindowClass" {
                let out = &mut *(lparam.0 as *mut Vec<usize>);
                out.push(hwnd.0 as usize);
            }
        }
        windows::Win32::Foundation::TRUE
    }

    let lparam = LPARAM(&mut results as *mut Vec<usize> as isize);
    let _ = unsafe { EnumWindows(Some(enum_proc), lparam) };

    results
}

/// 后台线程：等待新的控制台窗口出现（比快照多出来的那个），然后调整大小并居中。
#[cfg(target_os = "windows")]
fn center_console_window(snapshot: Vec<usize>) {
    std::thread::spawn(move || {
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow,
            SWP_FRAMECHANGED, SWP_NOZORDER, SW_HIDE, SW_SHOW,
        };

        // 重试约 3 秒等待新的控制台窗口出现
        let mut target_hwnd = None;
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let current = snapshot_console_windows();
            // 找到当前存在但快照中不存在的窗口 = 新增的窗口
            for &hwnd in &current {
                if !snapshot.contains(&hwnd) {
                    target_hwnd = Some(hwnd);
                    break;
                }
            }
            if target_hwnd.is_some() {
                break;
            }
        }

        let hwnd_val = match target_hwnd {
            Some(h) => h,
            None => return,
        };
        let hwnd = windows::Win32::Foundation::HWND(hwnd_val as *mut _);

        // 获取窗口所在显示器的工作区矩形
        let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let _ = unsafe { GetMonitorInfoW(monitor, &mut mi) };

        let work_w = (mi.rcWork.right - mi.rcWork.left) as i32;
        let work_h = (mi.rcWork.bottom - mi.rcWork.top) as i32;
        let work_x = mi.rcWork.left;
        let work_y = mi.rcWork.top;

        // 居中坐标
        let x = work_x + (work_w - CONSOLE_WINDOW_WIDTH) / 2;
        let y = work_y + (work_h - CONSOLE_WINDOW_HEIGHT) / 2;

        // 先隐藏避免闪烁，调整大小后显示
        unsafe { let _ = ShowWindow(hwnd, SW_HIDE); }
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                x.max(work_x),
                y.max(work_y),
                CONSOLE_WINDOW_WIDTH,
                CONSOLE_WINDOW_HEIGHT,
                SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
        unsafe { let _ = ShowWindow(hwnd, SW_SHOW); }
    });
}

/// 关闭独立控制台窗口（通过 PID 杀进程树，阻塞等待完成）
#[tauri::command]
pub async fn stop_agent_terminal(
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let pid_opt = {
        let mut s = state.agent_process.lock().map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(pid) = pid_opt {
        kill_process_tree(pid);
    }
    Ok(())
}

/// 窗口关闭时清理 Agent（供 lib.rs 调用）
pub fn kill_agent_session(state: &AppState) {
    if let Ok(mut s) = state.agent_process.lock() {
        if let Some(pid) = s.take() {
            kill_process_tree(pid);
        }
    }
}

/// 阻塞式杀进程树：taskkill /PID /T /F，等待完成才返回
#[cfg(target_os = "windows")]
fn kill_process_tree(pid: u32) {
    let pid_str = pid.to_string();
    let _ = create_hidden_command("taskkill")
        .args(["/PID", &pid_str, "/T", "/F"])
        .output(); // 阻塞等待 taskkill 完成
}

#[cfg(not(target_os = "windows"))]
fn kill_process_tree(pid: u32) {
    let _ = create_hidden_command("kill")
        .args(["-9", &pid.to_string()])
        .output(); // 阻塞等待
    // macOS 兜底：同时按名称杀死 admAgent（防止 PID 已失效的情况）
    #[cfg(target_os = "macos")]
    {
        let _ = create_hidden_command("pkill")
            .args(["-9", "-f", "admAgent"])
            .output();
    }
}


