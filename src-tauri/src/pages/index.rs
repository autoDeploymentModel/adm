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

/// llama-server（x64）启动时必须能加载的 VC++ 2015-2022 运行库核心 DLL。
/// vcruntime140_1.dll 是 VS2019(14.20) 才引入的，只用注册表或只查 vcruntime140.dll
/// 会把仅装过 2015/2017 旧版运行库的机器误判为“已安装”，随后拉起 llama-server 时
/// 依然弹出系统错误框（找不到 VCRUNTIME140_1.dll）。
#[cfg(target_os = "windows")]
const VC_RUNTIME_DLLS: [&str; 3] = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

/// 判定 VC++ 运行库是否可满足 llama-server 启动。
/// 按 Windows 加载器顺序检查：先找可执行文件同目录（应用级部署的 DLLs），
/// 再找 System32（官方安装包的落点）；三个 DLL 全部命中才算安装完整。
#[cfg(target_os = "windows")]
pub fn check_vc_redist_installed(app_local_dir: Option<&std::path::Path>) -> bool {
    let dirs: Vec<std::path::PathBuf> = std::iter::once(std::path::PathBuf::from(r"C:\Windows\System32"))
        .chain(app_local_dir.map(|dir| dir.to_path_buf()))
        .collect();

    VC_RUNTIME_DLLS
        .iter()
        .all(|dll| dirs.iter().any(|dir| dir.join(dll).is_file()))
}

/// Linux：加载器能否找到 libvulkan.so.1。优先问 ldconfig（与进程 dlopen 的实际搜索一致），
/// ldconfig 不可用的精简环境再退回常见库目录探测。GUI 启动时 PATH 常缺 /sbin，故先试绝对路径。
#[cfg(target_os = "linux")]
fn vulkan_loader_present() -> bool {
    for ldconfig in ["/sbin/ldconfig", "/usr/sbin/ldconfig", "ldconfig"] {
        if let Ok(out) = std::process::Command::new(ldconfig).arg("-p").output() {
            if out.status.success() {
                return String::from_utf8_lossy(&out.stdout).contains("libvulkan.so.1");
            }
        }
    }
    const CANDIDATES: [&str; 5] = [
        "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
        "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
        "/usr/lib64/libvulkan.so.1",
        "/usr/lib/libvulkan.so.1",
        "/usr/local/lib/libvulkan.so.1",
    ];
    CANDIDATES.iter().any(|p| std::path::Path::new(p).exists())
}

/// 是否装了显卡 Vulkan 驱动（ICD json）。只看 loader 不够：只有运行库没有驱动时
/// llama.cpp 依然枚举不到设备，必须一并检查。
#[cfg(target_os = "linux")]
fn vulkan_icd_present() -> bool {
    // VK_ICD_FILENAMES / VK_DRIVER_FILES 指向的驱动目录不受标准目录限制，显式设置时视为已配置
    if [
        std::env::var("VK_ICD_FILENAMES"),
        std::env::var("VK_DRIVER_FILES"),
    ]
    .iter()
    .any(|v| v.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false))
    {
        return true;
    }
    let mut dirs = vec![
        std::path::PathBuf::from("/usr/share/vulkan/icd.d"),
        std::path::PathBuf::from("/usr/local/share/vulkan/icd.d"),
        std::path::PathBuf::from("/etc/vulkan/icd.d"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(std::path::PathBuf::from(home).join(".local/share/vulkan/icd.d"));
    }
    dirs.iter().any(|dir| {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                })
            })
            .unwrap_or(false)
    })
}

/// llama.cpp 运行库预检（linux 侧对应 Windows 的 check_vc_redist_installed）。
/// 返回 Some(原因) = 需要提示用户，None = 无需提示。
///
/// 与 Windows 的 VC++ 预检不同，这里**只提示不阻断**：Vulkan 缺失只影响 GPU 加速，
/// llama.cpp 仍可用 CPU 推理；但 Linux 只分发 Vulkan 构建（见 get_llamacpp_download_url），
/// 所以用户必须知道「下的这个包在本机跑不了 GPU」，否则只能从 llama-server 原始 stderr 里猜。
pub fn llamacpp_runtime_warning() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if !vulkan_loader_present() {
            return Some(
                "未检测到 Vulkan 运行库（libvulkan.so.1）：Linux 版 llama.cpp 只有 Vulkan 构建，\
                 缺它只能用 CPU 推理。请安装 libvulkan1（Debian/Ubuntu）或 vulkan-loader（Fedora/Arch）"
                    .to_string(),
            );
        }
        if !vulkan_icd_present() {
            return Some(
                "已装 Vulkan 运行库，但未找到显卡 Vulkan 驱动（/usr/share/vulkan/icd.d 下无 ICD）：\
                 只能用 CPU 推理。请安装显卡厂商的 Vulkan 驱动（NVIDIA 为 nvidia 驱动自带的 libGLX_nvidia，\
                 AMD/Intel 为 mesa-vulkan-drivers）"
                    .to_string(),
            );
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// llama-server.exe 实际所在目录（应用级 DLL 的搜索位置）；未安装时退回 llamacpp 根目录。
/// 压缩包可能把二进制解压进子目录，只有取到 exe 所在目录才能与加载器搜索位置对齐。
#[cfg(target_os = "windows")]
fn llama_server_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = config::get_llamacpp_dir(Some(app)).ok()?;
    config::find_llama_server_in_dir(&dir)
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .or(Some(dir))
}

fn detect_hardware_for_llamacpp() -> HardwareDetectResult {
    let os = if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    };

    #[allow(unused_mut)]
    let mut gpu_vendor = None;
    #[allow(unused_mut)]
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
        "linux" => {
            // Linux 只提供 Vulkan 构建：一张包同时覆盖 NVIDIA / AMD / Intel
            // （CUDA 构建需另配 CUDA 运行库，暂不单独分发）
            Ok("https://adm.tuduoduo.top/llamacpp/ubuntu-vulkan.tar.gz".to_string())
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

    let gpus = platform::get_gpu_devices();
    // 枚举到显卡时以逐卡结果为准（nvidia-smi 显存准确、多卡求和正确、虚拟显示驱动已过滤）。
    // macOS 例外：Apple Silicon 显存即共享内存，total_vram 保持等于总内存的约定（前端据此识别统一内存）。
    // 这里不能退回 get_gpu_info()：它内部还会再跑一次 system_profiler（耗时数秒且无缓存），
    // 首屏就会把 system_profiler 执行两遍；改为复用上面已缓存的逐卡结果。
    #[cfg(target_os = "macos")]
    let (total_vram, used_vram, has_gpu) = if gpus.is_empty() {
        platform::get_gpu_info()
    } else {
        (sys.total_memory(), 0, true)
    };
    #[cfg(not(target_os = "macos"))]
    let (total_vram, used_vram, has_gpu) = if gpus.is_empty() {
        platform::get_gpu_info()
    } else {
        (
            gpus.iter().map(|g| g.total_vram).sum(),
            gpus.iter().map(|g| g.used_vram).sum(),
            true,
        )
    };

    Ok(SystemInfo {
        total_ram,
        used_ram,
        total_vram,
        used_vram,
        has_gpu,
        cpu_usage,
        cpu_physical_cores,
        cpu_logical_cores,
        gpus,
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

    #[cfg(target_os = "linux")]
    {
        // update.json 未提供 linux 字段时退化为「只提示版本、不显示下载按钮」（前端已处理空地址）
        download_url = update_info.linux.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.linux.as_ref().map(|p| p.content.clone());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
                    if compare_versions(&local_ver, remote_ver) != std::cmp::Ordering::Equal {
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
    let vc_redist_installed = check_vc_redist_installed(llama_server_dir(&app).as_deref());
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

/// 独立的 VC++ 运行库检测：不走网络，启动检测、安装后复验、启动模型前预检都走这里。
/// 与 check_update 分开，避免网络不可用时检测结果一并丢失（用户仍会被弹系统错误框）。
#[tauri::command]
pub fn check_vc_redist(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        check_vc_redist_installed(llama_server_dir(&app).as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        true
    }
}

/// 独立的 llama.cpp 运行库提示（linux：Vulkan 运行库/驱动；其它平台恒为 None）。
/// 同样不走网络，装 llamacpp 的弹窗在开始下载前调用它，把「本机跑不了 GPU」提前讲清楚。
#[tauri::command]
pub fn check_llamacpp_runtime() -> Option<String> {
    llamacpp_runtime_warning()
}

// ===== 应用自身更新（静默下载安装包 → 提示升级）=====

/// 更新包存放目录：与 llamacpp 的临时目录分开，安装包长期保留，
/// 用户「稍后再说」后重启应用仍能直接提示升级（无需重新下载）。
/// 统一放用户数据目录而非 exe 目录：Windows 装在 Program Files 下时那里不可写。
fn app_update_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = match app.path().app_data_dir() {
        Ok(data_dir) => data_dir.join("updates"),
        Err(_) => config::get_base_dir(Some(app))?.join("updates"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {}", e))?;
    Ok(dir)
}

/// 安装包落盘文件名：`ADM-<版本>-<URL 文件名>`。
/// 必须带版本号——下载地址不带版本号时，若沿用同名文件会被断点续传逻辑
/// 误判为"已下载完成"，导致用户升级到的还是上一个版本。
fn app_update_file_name(url: &str, version: &str) -> String {
    let raw = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let cleaned = cleaned.trim_matches('.');

    // 版本号同样来自远端 update.json，必须走同一套白名单：Path::join 不做归一化，
    // 含路径分隔符或 '..' 的版本号会拼出更新目录之外的路径
    let version_filtered: String = version
        .trim()
        .trim_start_matches('v')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let version_filtered = version_filtered.trim_matches('.').to_string();
    let version = if version_filtered.is_empty() {
        "unknown".to_string()
    } else {
        version_filtered
    };

    if cleaned.is_empty() {
        format!("ADM-{}-setup", version)
    } else {
        format!("ADM-{}-{}", version, cleaned)
    }
}

/// Linux：AppImage / deb 需要可执行位才能被直接拉起。
/// 新下载完成与"上次已下载好"两条成功路径都要走一遍——若上次会话在 `.part`
/// 重命名与 chmod 之间被杀，之后就只剩早退路径，安装包永远补不上可执行位。
#[cfg(target_os = "linux")]
fn ensure_installer_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_installer_executable(_path: &std::path::Path) {}

/// 静默下载应用安装包到本地（更新下载地址由 update.json 下发）。
/// 前端启动时后台调用：不弹窗、不阻塞界面，完成后由前端提示用户升级。
/// 已下载过（同名文件存在）时立即返回，实现"重启后无需重新下载直接提示"。
#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    version: String,
    url: String,
) -> Result<String, AppError> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("更新下载地址无效: {}", url);
    }

    let dir = app_update_dir(&app)?;
    let file_name = app_update_file_name(&url, &version);
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{}.part", file_name));

    // 清掉其它版本的残留安装包（每个版本只留当前一个文件，避免磁盘越攒越多）
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path == final_path || path == part_path {
                continue;
            }
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let app_clone = app.clone();
    let emit = move |status: &str, progress: u8| {
        app_clone
            .emit(
                "app-update-progress",
                serde_json::json!({ "status": status, "progress": progress }),
            )
            .ok();
    };

    if final_path.exists() {
        ensure_installer_executable(&final_path);
        emit("done", 100);
        return Ok(final_path.to_string_lossy().to_string());
    }

    emit("downloading", 0);

    // 安装包体积较大且可能走慢速网络，超时放宽到 30 分钟
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let app_progress = app.clone();
    download_with_resume(&client, &url, &final_path, &part_path, |progress, _downloaded, _total| {
        app_progress
            .emit(
                "app-update-progress",
                serde_json::json!({ "status": "downloading", "progress": progress }),
            )
            .ok();
    })
    .await?;

    ensure_installer_executable(&final_path);

    emit("done", 100);
    Ok(final_path.to_string_lossy().to_string())
}

/// 是否为 deb 包（Linux 分发形态之一）。
/// deb 不能直接执行（exec 会返回 ENOEXEC），必须交给包管理器提权安装。
/// 不加 cfg 限制是为了在任意平台的单测里都能验证扩展名判定。
#[cfg(any(target_os = "linux", test))]
fn is_deb_installer_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("deb"))
        .unwrap_or(false)
}

/// 拉起下载好的安装包，随后清理子进程并退出本进程——安装程序需要覆盖
/// 正在运行的可执行文件，ADM 必须先退出。（清理逻辑与托盘「退出」共用）
///
/// Linux 的 deb 例外：它由包管理器安装，必须先等出结果（失败时要把原因告诉
/// 用户，而不是先退出再让升级无声失败），故整体放在阻塞线程里执行。
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let dir = app_update_dir(&app)?;
    let dir_real = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    // 只允许运行更新目录内下载下来的安装包：路径由前端透传，不能变成任意可执行文件的启动器
    let installer = std::fs::canonicalize(&path)
        .map_err(|_| AppError::msg("安装包不存在或已被删除，请重新下载"))?;
    if !installer.starts_with(&dir_real) {
        bail!("安装包路径不合法: {}", path);
    }
    if !installer.is_file() {
        bail!("安装包不存在: {}", path);
    }

    let install_path = installer.clone();
    tauri::async_runtime::spawn_blocking(move || launch_installer(&install_path))
        .await
        .map_err(|e| AppError::msg(format!("安装任务异常: {}", e)))??;

    crate::cleanup_processes(&app);
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    // 新进程组 + 不挂控制台：否则 ADM 一退出，安装向导可能被一并带走。
    // BREAKAWAY 让安装程序脱离 ADM 所在的 Job（部分环境不允许，失败则退回普通启动）
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let spawn = |flags: u32| {
        let mut cmd = std::process::Command::new(path);
        cmd.creation_flags(flags);
        cmd.spawn()
    };

    match spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(_) => Ok(()),
        Err(_) => spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .map(|_| ())
            .map_err(|e| AppError::msg(format!("启动安装程序失败: {}", e))),
    }
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    // DMG 交给系统挂载打开，用户在挂载窗口里把 ADM 拖进「应用程序」完成覆盖
    let mut cmd = std::process::Command::new("open");
    cmd.arg(path);
    platform::spawn_detached(&mut cmd)
        .map(|_| ())
        .map_err(|e| AppError::msg(format!("打开安装包失败: {}", e)))
}

#[cfg(target_os = "linux")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    if is_deb_installer_path(path) {
        return install_deb_package(path);
    }

    // AppImage / .run 等自解压包：补可执行位后直接拉起
    ensure_installer_executable(path);
    // 当前进程本身就跑在 AppImage 里时（$APPIMAGE），必须先用新包覆盖该文件：
    // 直接跑下载目录里的新包只会再开一个实例，旧文件始终没被升级
    if let Some(current) = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from) {
        if current.as_path() != path {
            replace_appimage(&current, path)?;
            return spawn_installer(&current);
        }
    }
    spawn_installer(path)
}

#[cfg(target_os = "linux")]
fn spawn_installer(path: &std::path::Path) -> Result<(), AppError> {
    let mut cmd = std::process::Command::new(path);
    platform::spawn_detached(&mut cmd)
        .map(|_| ())
        .map_err(|e| AppError::msg(format!("启动安装包失败: {}（可手动执行：{}）", e, path.display())))
}

/// 用新下载的 AppImage 覆盖当前正在运行的那个文件（临时文件 + rename，避免写坏原文件）。
/// AppImage 运行时它是 FUSE 挂载的只读文件，但所在目录通常可写，替换不影响正在运行的进程。
#[cfg(target_os = "linux")]
fn replace_appimage(current: &std::path::Path, new_file: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let Some(dir) = current.parent() else {
        bail!("无法定位当前 AppImage 所在目录: {}", current.display());
    };
    let staged = dir.join(format!(".ADM-update-{}", std::process::id()));

    let copy = || -> std::io::Result<()> {
        std::fs::copy(new_file, &staged)?;
        let mut perms = std::fs::metadata(&staged)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&staged, perms)?;
        std::fs::rename(&staged, current)?;
        Ok(())
    };
    copy().map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        AppError::msg(format!(
            "无法覆盖当前 AppImage（{}）：{}\n请手动用下载好的新版本替换该文件：{}",
            current.display(),
            e,
            new_file.display()
        ))
    })
}

/// deb 包：交给 apt 安装（能自动补依赖），用 pkexec 弹系统授权框提权——
/// ADM 无 TTY，sudo 无法交互输入密码，只有 polkit 授权代理可用。
/// 必须等出结果：安装失败（授权取消、依赖冲突）时保持应用运行并把原因显示给用户，
/// 直接把文件当可执行文件拉起是行不通的（deb 不是可执行格式，exec 会 ENOEXEC）。
#[cfg(target_os = "linux")]
fn install_deb_package(path: &std::path::Path) -> Result<(), AppError> {
    let log_path = path.with_extension("install.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|e| AppError::msg(format!("创建安装日志失败: {}", e)))?;
    let log_err = log
        .try_clone()
        .map_err(|e| AppError::msg(format!("创建安装日志失败: {}", e)))?;

    // stdout/stderr 重定向到文件而非管道：安装过程只等退出码，不读管道，
    // 用管道会因缓冲区写满把 apt 卡死
    // --disable-internal-agent：只认桌面会话的 polkit 授权代理（图形密码框），
    // 否则 pkexec 的内部文本代理会试图从 stdin 读密码——stdin 已置 null，会挂到超时
    let mut cmd = std::process::Command::new("pkexec");
    cmd.arg("--disable-internal-agent")
        .arg("env")
        .arg("DEBIAN_FRONTEND=noninteractive")
        .arg("apt-get")
        .arg("install")
        .arg("-y")
        .arg("--allow-downgrades")
        .arg("--no-install-recommends")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));

    let mut child = platform::spawn_detached(&mut cmd).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::msg(format!(
                "系统缺少 pkexec（polkit），无法自动提权安装。\n请手动执行升级：\nsudo apt install \"{}\"",
                path.display()
            ))
        } else {
            AppError::msg(format!("启动安装程序失败: {}", e))
        }
    })?;

    // 等安装结束（上限 10 分钟，超时按失败处理，避免弹窗一直挂着）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(AppError::msg(format!("等待安装程序失败: {}", e))),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    };

    let tail = read_log_tail(&log_path, 800);
    match status {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(AppError::msg(format!(
            "自动安装未能完成（安装程序退出码 {}，可能是授权被取消或系统未运行 polkit 授权代理）。\n请手动执行升级：\nsudo apt install \"{}\"\n\n{}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "未知".to_string()),
            path.display(),
            tail
        ))),
        None => Err(AppError::msg(format!(
            "安装超时（超过 10 分钟）。请手动执行升级：\nsudo apt install \"{}\"\n\n{}",
            path.display(),
            tail
        ))),
    }
}

/// 读取日志文件末尾若干字符（安装失败时用于展示 apt 的真实原因）
#[cfg(target_os = "linux")]
fn read_log_tail(path: &std::path::Path, max_chars: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

#[tauri::command]
pub async fn download_and_extract_llamacpp(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    install_llamacpp_from_url(app, url).await
}

/// 重新安装：先删除现有 llamacpp 目录，再按当前硬件重新下载安装包
/// （复用升级用的下载/解压逻辑，只是不比较版本号）
#[tauri::command]
pub async fn reinstall_llamacpp(app: tauri::AppHandle) -> Result<(), AppError> {
    // Windows：VC++ 运行库缺失时 llama-server 无法运行，先拦下，避免白等一次下载
    #[cfg(target_os = "windows")]
    if !check_vc_redist_installed(llama_server_dir(&app).as_deref()) {
        bail!("系统缺少 Visual C++ 运行库（VCRUNTIME140_1.dll），请先安装 VC++ 2015-2022 运行库后重试。");
    }

    // 先解析下载地址：拿不到地址（如不支持的系统）时不删除现有文件
    let hardware = detect_hardware_for_llamacpp();
    let url = get_llamacpp_download_url(&hardware)?;

    let llamacpp_dir = config::get_llamacpp_dir(Some(&app))?;
    if llamacpp_dir.exists() {
        std::fs::remove_dir_all(&llamacpp_dir).map_err(|e| {
            format!(
                "删除旧版 llamacpp 文件失败（llama-server 可能正在运行或被杀软占用，请先停止模型后重试）: {}",
                e
            )
        })?;
        eprintln!("[INFO] llamacpp directory removed for reinstall: {:?}", llamacpp_dir);
    }

    install_llamacpp_from_url(app, url).await
}

async fn install_llamacpp_from_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
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
    // 下载地址固定不含版本号，残留的旧压缩包/续传分片会让 download_with_resume
    // 误判"已下载完成"或拼接出损坏的包，必须每次清空后全新下载
    let _ = std::fs::remove_dir_all(&temp_dir);
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
                    std::fs::remove_dir_all(&path).map_err(|e| {
                        format!(
                            "删除旧版本文件失败（llama-server 可能正在运行或被杀软占用，请先停止模型后重试）: {}",
                            e
                        )
                    })?;
                } else if path.is_file() {
                    std::fs::remove_file(&path).map_err(|e| {
                        format!(
                            "删除旧版本文件失败（llama-server 可能正在运行或被杀软占用，请先停止模型后重试）: {}",
                            e
                        )
                    })?;
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

#[cfg(test)]
mod tests {
    use super::{app_update_file_name, is_deb_installer_path};
    use std::path::Path;
    // 文件名必须带版本号：下载地址不带版本号时，沿用同名文件会被断点续传逻辑
    // 当成"已下载完成"，用户点升级装上的还是旧版本。
    #[test]
    fn file_name_contains_version() {
        let name = app_update_file_name("https://adm.tuduoduo.top/ADM_x64-setup.exe", "0.6.5");
        assert!(name.starts_with("ADM-0.6.5-"), "got {}", name);
        assert!(name.ends_with("ADM_x64-setup.exe"), "got {}", name);
    }

    #[test]
    fn file_name_strips_query_and_unsafe_chars() {
        let name = app_update_file_name(
            "https://cdn.example.com/dl/ADM%20v1.2.3.dmg?token=abc#frag",
            "v1.2.3",
        );
        assert_eq!(name, "ADM-1.2.3-ADM20v1.2.3.dmg");
    }

    #[test]
    fn file_name_falls_back_when_url_has_no_file_part() {
        let name = app_update_file_name("https://adm.tuduoduo.top/", "1.0.0");
        assert_eq!(name, "ADM-1.0.0-setup");
    }

    // 版本号同样来自远端 update.json：含路径分隔符 / '..' 时必须被白名单吃掉，
    // 否则 dir.join 会拼出更新目录之外的路径（Path::join 不做归一化）
    #[test]
    fn file_name_neutralizes_path_like_version() {
        let name = app_update_file_name("https://adm.tuduoduo.top/a.exe", "../../etc/passwd");
        assert!(!name.contains('/') && !name.contains(".."), "got {}", name);
        assert_eq!(name, "ADM-etcpasswd-a.exe");
    }

    #[test]
    fn file_name_falls_back_when_version_is_empty() {
        let name = app_update_file_name("https://adm.tuduoduo.top/a.exe", "v");
        assert_eq!(name, "ADM-unknown-a.exe");
    }

    // Linux 分发的 deb 不能当可执行文件拉起（exec 会 ENOEXEC），必须走包管理器安装；
    // 落地文件名形如 `ADM-0.7.5-ADM_0.7.5_amd64.deb`，扩展名判定不受前缀影响
    #[test]
    fn detects_deb_installer_by_extension() {
        assert!(is_deb_installer_path(Path::new("/tmp/updates/ADM-0.7.5-ADM_0.7.5_amd64.deb")));
        assert!(is_deb_installer_path(Path::new("/tmp/updates/ADM-0.7.5-setup.DEB")));
        assert!(!is_deb_installer_path(Path::new("/tmp/updates/ADM-0.7.5-ADM_0.7.5_amd64.AppImage")));
        assert!(!is_deb_installer_path(Path::new("/tmp/updates/ADM-0.7.5-setup")));
    }
}
