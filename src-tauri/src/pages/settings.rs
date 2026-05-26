// settings.html 对应逻辑（配置管理）

use crate::common::*;
use crate::common::config;
use crate::common::utils::platform;

// ===== Tauri Command =====

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    println!("[DEBUG] save_settings called with: {:?}", settings);
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化配置失败: {}", e))?;
    println!("[DEBUG] Writing config.json to: {:?}", config_path);
    println!("[DEBUG] config.json content: {}", json);
    
    let temp_path = config_path.with_extension("tmp");
    std::fs::write(&temp_path, json).map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    
    if let Ok(file) = std::fs::File::open(&temp_path) {
        let _ = file.sync_all();
    }
    
    std::fs::rename(&temp_path, &config_path).map_err(|e| format!("重命名配置文件失败: {}", e))?;
    
    println!("[DEBUG] Config saved successfully to: {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    println!("[DEBUG] load_settings: reading from {:?}", config_path);
    if !config_path.exists() {
        println!("[DEBUG] load_settings: config.json not found, returning defaults");
        return Ok(Settings::default());
    }

    let json = std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    println!("[DEBUG] load_settings raw json: {}", json);
    let settings: Settings = serde_json::from_str(&json).map_err(|e| format!("解析配置文件失败: {}", e))?;
    println!("[DEBUG] load_settings parsed: {:?}", settings);

    Ok(settings)
}

#[tauri::command]
pub async fn get_app_version(app: tauri::AppHandle) -> Result<String, String> {
    let version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());
    Ok(version)
}

#[tauri::command]
pub async fn get_llamacpp_version(app: tauri::AppHandle) -> Result<String, String> {
    let server_path = config::get_llama_server_path(Some(&app))?;

    let mut cmd = platform::create_hidden_command(&server_path);
    #[cfg(target_os = "macos")]
    {
        if let Ok(llamacpp_dir) = config::get_llamacpp_dir(Some(&app)) {
            cmd.env("DYLD_LIBRARY_PATH", llamacpp_dir.to_string_lossy().to_string());
        }
    }
    let output = cmd
        .arg("--version")
        .output()
        .map_err(|e| format!("执行 llama-server --version 失败: {}", e))?;

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
                        return Ok(clean_part.to_string());
                    }
                }
            }
        }
    }

    Err("无法解析版本号".to_string())
}

#[tauri::command]
pub async fn delete_llamacpp(app: tauri::AppHandle) -> Result<(), String> {
    let llamacpp_dir = config::get_llamacpp_dir(Some(&app))?;

    if !llamacpp_dir.exists() {
        return Err("llamacpp 目录不存在".to_string());
    }

    std::fs::remove_dir_all(&llamacpp_dir)
        .map_err(|e| format!("删除 llamacpp 目录失败: {}", e))?;

    println!("[DEBUG] llamacpp directory deleted: {:?}", llamacpp_dir);
    Ok(())
}
