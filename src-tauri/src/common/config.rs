use std::path::{Path, PathBuf};
use tauri::Manager;
use crate::common::error::AppError;

pub fn get_resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let resource_dir = app
        .path()
        .resource_dir()
        ?;
    Ok(resource_dir)
}

pub fn get_exe_dir() -> Result<PathBuf, AppError> {
    std::env::current_exe()
        ?
        .parent()
        .ok_or(AppError::msg("无法获取可执行文件目录"))
        .map(|p| p.to_path_buf())
}

pub fn get_data_dir(app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "macos")]
    if let Some(app_handle) = app {
        if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
            std::fs::create_dir_all(&app_data_dir).ok();
            return Ok(app_data_dir);
        }
    }
    let _ = app;
    get_exe_dir()
}

pub fn get_base_dir(app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(app_handle) = app {
            if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                std::fs::create_dir_all(&app_data_dir).ok();
                return Ok(app_data_dir);
            }
        }
    }

    if let Some(app_handle) = app {
        if let Ok(resource_dir) = get_resource_dir(app_handle) {
            let test_path = resource_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(resource_dir);
            }
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        let mut test_dir = current_dir.clone();
        loop {
            let test_path = test_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(test_dir);
            }
            if !test_dir.pop() {
                break;
            }
        }
    }

    if let Ok(exe_dir) = get_exe_dir() {
        let test_path = exe_dir.join("llamacpp");
        if test_path.exists() {
            return Ok(exe_dir);
        }
    }

    get_exe_dir()
}

pub fn find_llama_server_in_dir(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }

    let target_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    fn search(dir: &Path, target: &str) -> Option<PathBuf> {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(found) = search(&path, target) {
                        return Some(found);
                    }
                } else if path.file_name().and_then(|n| n.to_str()) == Some(target) {
                    return Some(path);
                }
            }
        }
        None
    }

    search(dir, target_name)
}

pub fn get_llamacpp_dir(app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
    let base_dir = get_base_dir(app)?;
    Ok(base_dir.join("llamacpp"))
}

pub fn get_llama_server_path(app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
    let llamacpp_dir = get_llamacpp_dir(app)?;

    if let Some(found) = find_llama_server_in_dir(&llamacpp_dir) {
        return Ok(found);
    }

    Err(AppError::msg(format!("未找到 llama-server 在目录: {:?}", llamacpp_dir)))
}
