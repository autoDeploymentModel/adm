// settings.html 对应逻辑（配置管理）

use crate::common::*;
use crate::common::config;
use crate::dbg_log;
use crate::app_state::AppState;
use tauri::Manager;

// ===== Tauri Command =====

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), AppError> {
    dbg_log!("[DEBUG] save_settings called with: {:?}", settings);
    // 持有 config 写锁：防止与 agent.rs / ilink.rs 的 read-modify-write 并发互相覆盖
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    let json = serde_json::to_string_pretty(&settings).map_err(|e| AppError::msg(format!("序列化配置失败: {}", e)))?;
    dbg_log!("[DEBUG] Writing config.json to: {:?}", config_path);
    dbg_log!("[DEBUG] config.json content: {}", json);
    
    // 直接写入目标文件，避免 macOS 上 rename 操作可能因文件系统属性/权限/沙盒问题失败
    std::fs::write(&config_path, &json).map_err(|e| AppError::msg(format!("写入配置文件失败: {}", e)))?;
    
    // 确保数据刷盘
    if let Ok(file) = std::fs::File::open(&config_path) {
        let _ = file.sync_all();
    }

    // 同步「多模态模型」到 admAgent.json 顶层 agent_vision_model（vision 子命令读取），
    // 值变化时触发服务端重载；失败静默（vision 缺省回退内置 admImage-model）
    crate::pages::agent::sync_agent_vision_model(&app, &settings.agent_vision_model);

    // 同步「代理配置」到 admAgent.json 顶层 agent_proxy，失败静默
    crate::pages::agent::sync_agent_proxy(&app, &settings.agent_proxy);

    dbg_log!("[DEBUG] Config saved successfully to: {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Settings, AppError> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    dbg_log!("[DEBUG] load_settings: reading from {:?}", config_path);
    if !config_path.exists() {
        dbg_log!("[DEBUG] load_settings: config.json not found, returning defaults");
        return Ok(Settings::default());
    }

    let json = std::fs::read_to_string(&config_path).map_err(|e| AppError::msg(format!("读取配置文件失败: {}", e)))?;
    dbg_log!("[DEBUG] load_settings raw json: {}", json);
    let settings: Settings = serde_json::from_str(&json).map_err(|e| AppError::msg(format!("解析配置文件失败: {}", e)))?;
    dbg_log!("[DEBUG] load_settings parsed: {:?}", settings);

    Ok(settings)
}

#[tauri::command]
pub async fn get_app_version(app: tauri::AppHandle) -> Result<String, AppError> {
    let version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());
    Ok(version)
}

#[tauri::command]
pub async fn get_llamacpp_version(app: tauri::AppHandle) -> Result<String, AppError> {
    let server_path = config::get_llama_server_path(Some(&app))?;
    let server_path_str = server_path.to_string_lossy().to_string();

    // 用 CREATE_NO_WINDOW 避免 console 窗口闪烁：
    // - 其他子进程（admAgent -v）也用同模式，正常工作
    // - Rust `Command::output()` 已通过 STARTF_USESTDHANDLES 把 stdout/stderr
    //   接到管道，无需另开控制台窗口
    // - 这里把 stdin 显式置 null，避免从父进程继承到无效的 console 句柄
    let mut cmd = std::process::Command::new(&server_path);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(llamacpp_dir) = config::get_llamacpp_dir(Some(&app)) {
            cmd.env("DYLD_LIBRARY_PATH", llamacpp_dir.to_string_lossy().to_string());
        }
    }

    // 5 秒超时：超过通常意味着 AV/EDR 拦截或子进程挂在 stdin 上等异常。
    // .output() 是阻塞调用，用 spawn_blocking 移到专用线程，避免阻塞 tokio runtime；
    // 再用 oneshot + tokio::time::timeout 强制超时（spawn_blocking 自身不感知超时）。
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let _ = tx.send(cmd.arg("--version").output());
    });

    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(out))) => out,
        Ok(Ok(Err(e))) => {
            // PermissionDenied 是 Windows 上 AV/EDR/Controlled Folder Access
            // 拦截子进程最常见的 OS 错误（错误码 5 ERROR_ACCESS_DENIED）。
            // 其他 PermissionDenied-like 关键词也覆盖 SmartScreen、Defender。
            let raw = format!("执行 llama-server --version 失败: {} | path: {}", e, server_path_str);
            return Err(AppError::msg(decorate_permission_hint(&e, raw)));
        }
        Ok(Err(_)) => {
            return Err(AppError::msg(format!(
                "执行 llama-server --version 失败：子任务通道已关闭 | path: {}",
                server_path_str
            )));
        }
        Err(_) => {
            return Err(AppError::msg(format!(
                "执行 llama-server --version 超时（5s），可能被杀软拦截、扫描或子进程挂起，请尝试在杀软中将此目录加入白名单后重启软件 | path: {}",
                server_path_str
            )));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let version_info = if stdout.is_empty() {
        stderr.to_string()
    } else {
        stdout.to_string()
    };

    for line in version_info.lines() {
        let line_trimmed = line.trim();
        let lower = line_trimmed.to_lowercase();
        if lower.contains("version") {
            if let Some(pos) = lower.find("version") {
                let start = pos + 7;
                if start < line_trimmed.len() {
                    let after_version = line_trimmed[start..].trim();
                    let clean_part = if let Some(pos) = after_version.find(':') {
                        after_version[pos + 1..].trim()
                    } else {
                        after_version
                    };
                    if !clean_part.is_empty() {
                        // 只提取 semver 部分（如 "0.1.0"），去掉 "(build ...)" 后缀
                        let semver = clean_part.split_whitespace().next().unwrap_or(clean_part);
                        return Ok(semver.to_string());
                    }
                }
            }
        }
    }

    Err(AppError::msg(format!(
        "无法解析版本号 | path: {} | output: {}",
        server_path_str,
        version_info.trim()
    )))
}

/// Windows 上 PermissionDenied（错误码 5）/Access is denied 通常来自 AV/EDR/
/// Controlled Folder Access 对 `%LOCALAPPDATA%` 下子进程的拦截。在错误信息后追加
/// 中文提示，便于前端 toast 直接展示给用户。
fn decorate_permission_hint(io_err: &std::io::Error, raw_msg: String) -> String {
    let looks_blocked = matches!(io_err.kind(), std::io::ErrorKind::PermissionDenied)
        || io_err.raw_os_error() == Some(5)
        || raw_msg.contains("Access is denied")
        || raw_msg.contains("PermissionDenied")
        || raw_msg.contains("拒绝访问");

    if looks_blocked {
        format!(
            "{} | 提示：可能被 Windows Defender / 第三方杀软 / 访问受保护文件夹拦截，请将所在目录加入白名单后重启软件",
            raw_msg
        )
    } else {
        raw_msg
    }
}

#[tauri::command]
pub async fn delete_llamacpp(app: tauri::AppHandle) -> Result<(), AppError> {
    let llamacpp_dir = config::get_llamacpp_dir(Some(&app))?;

    if !llamacpp_dir.exists() {
        return Err(AppError::msg("llamacpp 目录不存在"));
    }

    std::fs::remove_dir_all(&llamacpp_dir)
        .map_err(|e| AppError::msg(format!("删除 llamacpp 目录失败: {}", e)))?;

    dbg_log!("[DEBUG] llamacpp directory deleted: {:?}", llamacpp_dir);
    Ok(())
}
