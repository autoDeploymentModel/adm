// index.html 对应逻辑（硬件信息、全局更新）

use crate::common::*;
use crate::app_state::AppState;
use crate::common::config;
use crate::common::utils::archive;
use crate::common::utils::platform;
use crate::common::utils::download::download_with_resume;
use crate::pages::settings::get_llamacpp_version;
use crate::bail;

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

#[cfg(target_os = "windows")]
fn check_vc_redist_installed() -> bool {
    use std::path::Path;
    
    // 方法一：DLL 文件检测
    let dll_path = r"C:\Windows\System32\vcruntime140_1.dll";
    let dll_exists = Path::new(dll_path).exists();
    
    // 方法二：注册表检测（辅助验证）
    let reg_installed = std::process::Command::new("reg")
        .args(["query", "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64", "/v", "Installed"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    
    dll_exists || reg_installed
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
        // 使用 PowerShell Get-CimInstance 替代已弃用的 wmic
        if let Ok(output) = platform::create_hidden_command("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut nvidia_found = None;
            let mut amd_found = None;
            let mut intel_found = None;
            let mut first_gpu = None;

            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if first_gpu.is_none() {
                    first_gpu = Some(trimmed.to_string());
                }
                let lower = trimmed.to_lowercase();
                if lower.contains("nvidia")
                    || lower.contains("geforce")
                    || lower.contains("rtx")
                    || lower.contains("gtx")
                {
                    let series = extract_nvidia_series(trimmed);
                    if nvidia_found.is_none() {
                        nvidia_found = Some((trimmed.to_string(), series));
                    }
                } else if lower.contains("amd") || lower.contains("radeon") {
                    if amd_found.is_none() {
                        amd_found = Some(trimmed.to_string());
                    }
                } else if lower.contains("intel") {
                    if intel_found.is_none() {
                        intel_found = Some(trimmed.to_string());
                    }
                }
            }

            if let Some((name, series)) = nvidia_found {
                gpu_vendor = Some("nvidia".to_string());
                gpu_name = Some(name);
                nvidia_series = series;
            } else if let Some(name) = amd_found {
                gpu_vendor = Some("amd".to_string());
                gpu_name = Some(name);
            } else if let Some(name) = intel_found {
                gpu_vendor = Some("intel".to_string());
                gpu_name = Some(name);
            } else if let Some(name) = first_gpu {
                gpu_name = Some(name);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("system_profiler")
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

fn get_llamacpp_download_url(hardware: &HardwareDetectResult) -> Result<String, AppError> {
    match hardware.os.as_str() {
        "macos" => {
            Ok("https://adm.tuduoduo.top/llamacpp/macos.tar.gz".to_string())
        }
        "windows" => {
            match hardware.gpu_vendor.as_deref() {
                Some("nvidia") => {
                    Ok("https://adm.tuduoduo.top/llamacpp/windows-CUDA12.zip".to_string())
                }
                Some("amd") => {
                    Ok("https://adm.tuduoduo.top/llamacpp/vulkan.zip".to_string())
                }
                Some("intel") => {
                    Ok("https://adm.tuduoduo.top/llamacpp/vulkan.zip".to_string())
                }
                Some(other) => {
                    eprintln!("[WARN] 不支持的显卡型号: {}，将使用 Vulkan 版本", other);
                    Ok("https://adm.tuduoduo.top/llamacpp/vulkan.zip".to_string())
                }
                None => {
                    eprintln!("[WARN] 未检测到支持的显卡，将使用 Vulkan 版本");
                    Ok("https://adm.tuduoduo.top/llamacpp/vulkan.zip".to_string())
                }
            }
        }
        other => {
            bail!("不支持的操作系统: {}，当前仅支持 Windows 和 macOS", other)
        }
    }
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

/// 拉取远程更新清单 update.json（15s 超时）。
/// 供 check_update 与 admAgent 版本检查共用。
pub(crate) async fn fetch_update_info() -> Result<UpdateInfo, AppError> {
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
        bail!("服务器返回错误状态码: {}", response.status());
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应文本失败: {}", e))?;

    serde_json::from_str(&text).map_err(|e| AppError::msg(format!("解析更新信息失败: {}", e)))
}

#[tauri::command]
pub async fn get_system_info(state: tauri::State<'_, AppState>) -> Result<SystemInfo, AppError> {
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
pub async fn check_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, AppError> {
    let current_version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());

    let update_info = fetch_update_info().await?;

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
            if let Ok(url) = get_llamacpp_download_url(&hardware) {
                llamacpp_download_url = Some(url);
            }
        } else {
            // 第二步：二进制存在，尝试获取版本号进行对比
            match get_llamacpp_version(app.clone()).await {
                Ok(local_ver) => {
                    llamacpp_local_version = Some(local_ver.clone());
                    if local_ver != *remote_ver {
                        llamacpp_needs_update = true;
                        let hardware = detect_hardware_for_llamacpp();
                        if let Ok(url) = get_llamacpp_download_url(&hardware) {
                            llamacpp_download_url = Some(url);
                        }
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

    #[cfg(target_os = "windows")]
    let vc_redist_installed = check_vc_redist_installed();
    #[cfg(not(target_os = "windows"))]
    let vc_redist_installed = true;

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
        vc_redist_installed,
    })
}

#[tauri::command]
pub async fn download_and_extract_llamacpp(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if url.trim().is_empty() || !url.starts_with("http") {
        bail!(
            "下载地址无效: {}，请重新检查更新",
            if url.is_empty() { "地址为空" } else { &url }
        );
    }

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

    let part_path = archive_path.with_extension("part");

    let app_clone = app.clone();
    download_with_resume(
        &client, &url, &archive_path, &part_path,
        |progress, _downloaded, _total| {
            app_clone.emit(
                "llamacpp-download-progress",
                serde_json::json!({ "status": "downloading", "progress": progress }),
            ).ok();
        },
    ).await?;

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
        bail!("压缩包不存在: {:?}", archive_path);
    }

    let archive_size = std::fs::metadata(&archive_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if archive_size == 0 {
        bail!("压缩包为空: {:?}", archive_path);
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
        bail!(
            "解压后未找到任何文件\n压缩包: {:?}\n压缩包大小: {} bytes\n请检查压缩包是否完整",
            archive_path, archive_size
        );
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
