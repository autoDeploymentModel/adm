// index.html 对应逻辑（硬件信息、全局更新）

use crate::common::*;
use crate::app_state::AppState;
use crate::common::config;
use crate::common::utils::archive;
use crate::common::utils::platform;
use crate::pages::settings::get_llamacpp_version;

use tauri::Emitter;

// ===== 辅助函数 =====

#[cfg(target_os = "windows")]
fn extract_nvidia_series(gpu_name: &str) -> Option<u32> {
    let upper = gpu_name.to_uppercase();
    let search_from = if let Some(pos) = upper.find("RTX ") {
        pos + 4
    } else if let Some(pos) = upper.find("GTX ") {
        pos + 4
    } else {
        return None;
    };

    if search_from >= gpu_name.len() {
        return None;
    }
    let remaining = &gpu_name[search_from..];
    let num_str: String = remaining.chars().take_while(|c| c.is_ascii_digit()).collect();
    if num_str.is_empty() {
        return None;
    }
    let model_num: u32 = num_str.parse().ok()?;
    if model_num >= 1000 {
        Some(model_num / 100)
    } else {
        Some(model_num / 10)
    }
}

fn detect_hardware_for_llamacpp() -> HardwareDetectResult {
    let os = if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    };

    let mut gpu_vendor = None;
    let mut gpu_name = None;
    #[allow(unused_mut)]
    let mut nvidia_series = None;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("wmic")
            .creation_flags(0x08000000)
            .args(["path", "win32_VideoController", "get", "Name"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed == "Name" {
                    continue;
                }
                gpu_name = Some(trimmed.to_string());
                let lower = trimmed.to_lowercase();
                if lower.contains("nvidia")
                    || lower.contains("geforce")
                    || lower.contains("rtx")
                    || lower.contains("gtx")
                {
                    gpu_vendor = Some("nvidia".to_string());
                    nvidia_series = extract_nvidia_series(trimmed);
                } else if lower.contains("amd") || lower.contains("radeon") {
                    gpu_vendor = Some("amd".to_string());
                } else if lower.contains("intel") {
                    gpu_vendor = Some("intel".to_string());
                }
                break;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("system_profiler")
            .creation_flags(0x08000000)
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("Chipset Model") || stdout.contains("Metal") {
                gpu_name = Some("Apple GPU".to_string());
                gpu_vendor = Some("apple".to_string());
            }
        }
    }

    HardwareDetectResult {
        os,
        gpu_vendor,
        gpu_name,
        nvidia_series,
    }
}

fn get_llamacpp_download_url(hardware: &HardwareDetectResult) -> Option<String> {
    if hardware.os == "macos" {
        return Some("https://adm.tuduoduo.top/llamacpp/macos.tar.gz".to_string());
    }

    if hardware.os == "windows" {
        if let Some(ref vendor) = hardware.gpu_vendor {
            match vendor.as_str() {
                "nvidia" => {
                    if let Some(series) = hardware.nvidia_series {
                        if series <= 20 {
                            return Some(
                                "https://adm.tuduoduo.top/llamacpp/windows-CUDA12.zip".to_string(),
                            );
                        } else {
                            return Some(
                                "https://adm.tuduoduo.top/llamacpp/windows-CUDA13.zip".to_string(),
                            );
                        }
                    }
                    return Some(
                        "https://adm.tuduoduo.top/llamacpp/windows-CUDA13.zip".to_string(),
                    );
                }
                "amd" => {
                    return Some(
                        "https://adm.tuduoduo.top/llamacpp/llama-amd.zip".to_string(),
                    );
                }
                "intel" => {
                    return Some(
                        "https://adm.tuduoduo.top/llamacpp/llama-intel.zip".to_string(),
                    );
                }
                _ => {}
            }
        }

        return Some("https://adm.tuduoduo.top/llamacpp/llama-cpu.zip".to_string());
    }

    None
}

/// 简单解析 semver 版本号 "x.y.z" 并比较
fn compare_versions(current: &str, remote: &str) -> std::cmp::Ordering {
    let parse_version = |v: &str| -> Vec<u32> {
        v.trim()
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect()
    };

    let cur_parts = parse_version(current);
    let rem_parts = parse_version(remote);

    for i in 0..cur_parts.len().max(rem_parts.len()) {
        let cur = cur_parts.get(i).copied().unwrap_or(0);
        let rem = rem_parts.get(i).copied().unwrap_or(0);
        if cur < rem {
            return std::cmp::Ordering::Less;
        }
        if cur > rem {
            return std::cmp::Ordering::Greater;
        }
    }
    std::cmp::Ordering::Equal
}

// ===== Tauri Command =====

#[tauri::command]
pub async fn get_system_info(state: tauri::State<'_, AppState>) -> Result<SystemInfo, String> {
    let mut sys = state.sys.lock().map_err(|e| format!("锁获取失败: {}", e))?;
    sys.refresh_all();

    let total_ram = sys.total_memory();
    let used_ram = sys.used_memory();
    let cpu_usage = sys.global_cpu_usage();
    let cpu_physical_cores = sys.physical_core_count().unwrap_or(0);
    let cpu_logical_cores = sys.cpus().len();

    let (total_vram, used_vram, has_gpu) = platform::get_gpu_info();

    Ok(SystemInfo {
        total_ram,
        used_ram,
        total_vram,
        used_vram,
        has_gpu,
        cpu_usage,
        cpu_physical_cores,
        cpu_logical_cores,
    })
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get("https://adm.tuduoduo.top/update.json")
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("服务器返回错误状态码: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应文本失败: {}", e))?;

    let update_info: UpdateInfo = serde_json::from_str(&text)
        .map_err(|e| format!("解析更新信息失败: {}", e))?;

    let has_update = compare_versions(&current_version, &update_info.version) == std::cmp::Ordering::Less;

    let download_url;
    let changelog_url;

    #[cfg(target_os = "windows")]
    {
        download_url = update_info.windows.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.windows.as_ref().map(|p| p.content.clone());
    }

    #[cfg(target_os = "macos")]
    {
        download_url = update_info.mac_os.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.mac_os.as_ref().map(|p| p.content.clone());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        download_url = None;
        changelog_url = None;
    }

    // 远程版本号直接使用
    let llamacpp_remote_version = update_info.llamacpp_version.clone();
    let mut llamacpp_local_version: Option<String> = None;
    let mut llamacpp_needs_update = false;
    let mut llamacpp_download_url: Option<String> = None;

    if let Some(ref remote_ver) = llamacpp_remote_version {
        // 第一步：直接检查 llama-server 二进制文件是否存在
        let llamacpp_dir = config::get_llamacpp_dir(Some(&app));
        let binary_exists = llamacpp_dir
            .as_ref()
            .map(|dir| config::find_llama_server_in_dir(dir).is_some())
            .unwrap_or(false);

        if !binary_exists {
            // 二进制文件不存在，需要下载
            llamacpp_needs_update = true;
            let hardware = detect_hardware_for_llamacpp();
            llamacpp_download_url = get_llamacpp_download_url(&hardware);
        } else {
            // 第二步：二进制存在，尝试获取版本号进行对比
            match get_llamacpp_version(app.clone()).await {
                Ok(local_ver) => {
                    llamacpp_local_version = Some(local_ver.clone());
                    if local_ver != *remote_ver {
                        llamacpp_needs_update = true;
                        let hardware = detect_hardware_for_llamacpp();
                        llamacpp_download_url = get_llamacpp_download_url(&hardware);
                    }
                }
                Err(_) => {
                    // 二进制存在但版本号获取/解析失败（例如输出格式差异）
                    // 仍然认为已安装，不触发下载，设版本号为 unknown
                    llamacpp_local_version = Some("unknown".to_string());
                }
            }
        }
    }

    Ok(UpdateCheckResult {
        has_update,
        remote_version: update_info.version,
        current_version,
        download_url,
        changelog_url,
        llamacpp_needs_update,
        llamacpp_remote_version,
        llamacpp_local_version,
        llamacpp_download_url,
    })
}

#[tauri::command]
pub async fn download_and_extract_llamacpp(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let llamacpp_dir = config::get_llamacpp_dir(Some(&app))?;

    std::fs::create_dir_all(&llamacpp_dir).map_err(|e| format!("创建 llamacpp 目录失败: {}", e))?;

    let file_name = url.split('/').next_back().unwrap_or("download");
    let temp_dir = llamacpp_dir.join(".tmp_download");
    let archive_path = temp_dir.join(file_name);

    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    app.emit(
        "llamacpp-download-progress",
        serde_json::json!({ "status": "downloading", "progress": 0 }),
    )
    .ok();

    // ===== 断点续传下载 =====
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut existing_size: u64 = 0;
    if archive_path.exists() {
        existing_size = std::fs::metadata(&archive_path)
            .map(|m| m.len())
            .unwrap_or(0);
    }

    let mut req = client.get(&url);
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={}-", existing_size));
    }

    let response = req.send().await.map_err(|e| format!("下载请求失败: {}", e))?;

    let is_partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut total_size: u64 = 0;

    if is_partial && existing_size > 0 {
        // 解析 Content-Range 头获取总大小
        if let Some(content_range) = response.headers().get("Content-Range") {
            if let Ok(range_str) = content_range.to_str() {
                if let Some(total_part) = range_str.split('/').nth(1) {
                    if let Ok(t) = total_part.parse::<u64>() {
                        total_size = t;
                    }
                }
            }
        }
        app.emit(
            "llamacpp-download-progress",
            serde_json::json!({ "status": "resuming", "progress": if total_size > 0 { (existing_size as f64 / total_size as f64) * 100.0 } else { 0.0 } as u8 }),
        )
        .ok();
    } else if existing_size > 0 {
        // 服务器不支持续传，删除旧文件从头下载
        let _ = std::fs::remove_file(&archive_path);
        existing_size = 0;
    }

    if !response.status().is_success() && !is_partial {
        return Err(format!("下载失败，HTTP 状态码: {}", response.status()));
    }

    if total_size == 0 {
        total_size = response.content_length().unwrap_or(0);
    }

    use tokio::io::AsyncWriteExt;
    let mut file = if existing_size > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&archive_path)
            .await
            .map_err(|e| format!("打开续传文件失败: {}", e))?
    } else {
        tokio::fs::File::create(&archive_path)
            .await
            .map_err(|e| format!("创建临时文件失败: {}", e))?
    };

    let mut downloaded: u64 = existing_size;
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
            "llamacpp-download-progress",
            serde_json::json!({ "status": "downloading", "progress": progress }),
        )
        .ok();
    }

    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    app.emit(
        "llamacpp-download-progress",
        serde_json::json!({ "status": "extracting", "progress": 0 }),
    )
    .ok();

    // 清空llamacpp目录，删除旧版本的所有文件（保留.tmp_download临时目录）
    if llamacpp_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&llamacpp_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && !path.ends_with(".tmp_download") {
                    let _ = std::fs::remove_dir_all(&path);
                } else if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    // 验证压缩包是否存在
    if !archive_path.exists() {
        return Err(format!("压缩包不存在: {:?}", archive_path));
    }

    let archive_size = std::fs::metadata(&archive_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if archive_size == 0 {
        return Err(format!("压缩包为空: {:?}", archive_path));
    }

    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    // 用纯Rust库解压
    let copied = if ext == "zip" {
        archive::extract_zip(&archive_path, &llamacpp_dir)?
    } else {
        archive::extract_tar_gz(&archive_path, &llamacpp_dir)?
    };

    if copied == 0 {
        return Err(format!(
            "解压后未找到任何文件\n压缩包: {:?}\n压缩包大小: {} bytes\n请检查压缩包是否完整",
            archive_path, archive_size
        ));
    }

    let _ = std::fs::remove_dir_all(&temp_dir);

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(server_path) = config::find_llama_server_in_dir(&llamacpp_dir) {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&server_path)
                .map_err(|e| format!("读取权限失败: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&server_path, perms)
                .map_err(|e| format!("设置执行权限失败: {}", e))?;
        }
    }

    app.emit(
        "llamacpp-download-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}
