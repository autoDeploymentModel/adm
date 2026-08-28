#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::common::GpuInfo;

#[cfg(target_os = "windows")]
pub fn create_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(not(target_os = "windows"))]
pub fn create_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    std::process::Command::new(program)
}

/// 让子进程独立于父进程启动（Unix 上创建新会话/进程组），
/// 这样关闭时才能用 `kill -9 -<pgid>` 一次性杀掉整棵进程树，避免孤儿残留。
#[cfg(not(target_os = "windows"))]
pub fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    // process_group(0) 表示新建进程组，pgid 等于新进程自身的 pid
    cmd.process_group(0);
    // Command 的 builder 方法（args/stdout/stderr/env 等）均返回 &mut Self，
    // 因此调用方传入的链式表达式类型为 &mut Command，这里按可变引用接收，
    // spawn(&mut self) 同样基于可变引用执行。
    cmd.spawn()
}

/// 强杀整个进程树（含子进程），避免 llama-server / SD 派生的子进程残留为孤儿。
///
/// - Windows: `taskkill /PID <pid> /T /F`
/// - Unix: 先尝试按进程组（kill -9 -<pgid>），失败再直接 kill PID
#[cfg(target_os = "windows")]
pub fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .creation_flags(0x08000000)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
pub fn kill_process_tree(pid: u32) {
    // 尝试杀掉整个进程组（llama-server 启动时已用 setsid 独立成组）
    let _ = std::process::Command::new("kill")
        .args(["-9", &format!("-{}", pid)])
        .spawn();
    // 兜底：直接杀 PID（进程组不存在时也不影响）
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .spawn();
}

/// 按进程名强杀所有匹配进程（整棵进程树）。用于关闭窗口时兜底清理残留。
///
/// - Windows: `taskkill /IM <name> /T /F`
/// - Unix: `pkill -9 -f <name>`
#[cfg(target_os = "windows")]
pub fn kill_process_by_name(name: &str) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .creation_flags(0x08000000)
        .args(["/IM", name, "/T", "/F"])
        .spawn();
}

#[cfg(not(target_os = "windows"))]
pub fn kill_process_by_name(name: &str) {
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", name])
        .spawn();
}

pub fn get_gpu_info() -> (u64, u64, bool) {
    let mut total_vram: u64 = 0;
    let used_vram: u64 = 0;
    let mut has_gpu = false;

    #[cfg(target_os = "windows")]
    {
        // 使用 PowerShell Get-CimInstance 替代已弃用的 wmic（Windows 11 22H2+ 标记为 deprecated）
        if let Ok(output) = create_hidden_command("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if let Ok(ram) = trimmed.parse::<u64>() {
                    total_vram += ram;
                    has_gpu = true;
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = create_hidden_command("nvidia-smi")
            .args([
                "--query-gpu=memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() == 2 {
                    if let Ok(total) = parts[0].trim().parse::<u64>() {
                        total_vram += total * 1024 * 1024;
                        has_gpu = true;
                    }
                    if let Ok(used) = parts[1].trim().parse::<u64>() {
                        used_vram += used * 1024 * 1024;
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = create_hidden_command("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("VRAM") || stdout.contains("Metal") || stdout.contains("Chipset") {
                has_gpu = true;
                total_vram = sysinfo::System::new().total_memory();
            }
        }
    }

    (total_vram, used_vram, has_gpu)
}

/// 枚举所有显卡（名称 + 显存），按平台分别实现：
/// - Windows: `nvidia-smi`（准确显存/已用）+ PowerShell CIM 兜底，并过滤虚拟显示驱动
/// - macOS: `system_profiler SPDisplaysDataType`（Chipset Model + VRAM (Total)）
/// - Linux: `nvidia-smi --query-gpu=name,memory.total,memory.used`
/// 结果带 60 秒 TTL 缓存：避免每次刷新硬件栏都重新 spawn 子进程，同时 eGPU / 显卡
/// 热插拔后最多延迟 1 分钟自动刷新（枚举本身需 0.5~2s 子进程调用，不宜每次请求都跑）。
pub fn get_gpu_devices() -> Vec<GpuInfo> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Vec<GpuInfo>)>> = Mutex::new(None);

    let now = Instant::now();
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((ts, list)) = guard.as_ref() {
        if now.duration_since(*ts) < Duration::from_secs(60) {
            return list.clone();
        }
    }
    let list = detect_gpu_devices();
    *guard = Some((now, list.clone()));
    list
}

fn detect_gpu_devices() -> Vec<GpuInfo> {
    let mut devices: Vec<GpuInfo> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // 优先用 nvidia-smi 拿 NVIDIA 卡的准确显存（CIM AdapterRAM 是 UInt32，4GB+ 会截断）。
        // 用 Vec 而不是按名字建索引的 HashMap：同名多卡（如双 RTX 4090）在 HashMap 里会
        // 互相覆盖，两张卡拿到同一份显存数据，且 discrete_device_list() 会输出重复设备名。
        // 改为按顺序配对，每命中一条就标记已消费。
        let mut nv_info: Vec<(String, u64, u64)> = Vec::new();
        if let Ok(output) = create_hidden_command("nvidia-smi")
            .args([
                "--query-gpu=name,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 3 {
                    let name = parts[0].trim().to_string();
                    let total = parts[1].trim().parse::<u64>().unwrap_or(0) * 1024 * 1024;
                    let used = parts[2].trim().parse::<u64>().unwrap_or(0) * 1024 * 1024;
                    nv_info.push((name, total, used));
                }
            }
        }
        let mut nv_consumed = vec![false; nv_info.len()];

        if let Ok(output) = create_hidden_command("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.AdapterRAM }",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(idx) = trimmed.rfind('|') {
                    let name = trimmed[..idx].trim().to_string();
                    // 过滤虚拟/远程显示驱动（向日葵 OrayIddDriver、Hyper-V、VMware、VBox、基本显示适配器等），只保留真实显卡
                    let lower = name.to_lowercase();
                    // 过滤虚拟/远程显示驱动（向日葵 OrayIdDDriver、Hyper-V、VMware、VBox、基本显示适配器等），只保留真实显卡
                    if is_virtual_display_device(&name) {
                        continue;
                    }
                    let mut matched: Option<(u64, u64)> = None;
                    for (i, (nv_name, nv_total, nv_used)) in nv_info.iter().enumerate() {
                        if nv_consumed[i] || nv_name.to_lowercase() != lower {
                            continue;
                        }
                        nv_consumed[i] = true;
                        matched = Some((*nv_total, *nv_used));
                        break;
                    }
                    let (total_vram, used_vram) = matched.unwrap_or_else(|| {
                        (trimmed[idx + 1..].trim().parse::<u64>().unwrap_or(0), 0)
                    });
                    let integrated = is_integrated_gpu(&name);
                    devices.push(GpuInfo {
                        name,
                        total_vram,
                        used_vram,
                        is_integrated: integrated,
                    });
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = create_hidden_command("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut cur_name: Option<String> = None;
            let mut cur_vram: u64 = 0;
            fn flush(
                devices: &mut Vec<GpuInfo>,
                name: &mut Option<String>,
                vram: &mut u64,
            ) {
                if let Some(n) = name.take() {
                    if let Some(existing) = devices.iter_mut().find(|d| d.name == n) {
                        // 同一 GPU 多显示器会重复出现 Chipset Model，合并而非叠加
                        if *vram > existing.total_vram {
                            existing.total_vram = *vram;
                        }
                    } else {
                        let integrated = is_integrated_gpu(&n);
                        devices.push(GpuInfo {
                            name: n,
                            total_vram: *vram,
                            used_vram: 0,
                            is_integrated: integrated,
                        });
                    }
                    *vram = 0;
                }
            }
            for line in stdout.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("Chipset Model:") {
                    flush(&mut devices, &mut cur_name, &mut cur_vram);
                    let name = rest.trim().to_string();
                    if !name.is_empty() {
                        cur_name = Some(name);
                    }
                } else if let Some(rest) = trimmed.strip_prefix("VRAM ") {
                    // 形如 "VRAM (Total): 16 GB" / "VRAM (Dynamic, Max): 32 GB"
                    if let Some(pos) = rest.find(':') {
                        if let Some(bytes) = parse_mac_vram(rest[pos + 1..].trim()) {
                            cur_vram = bytes;
                        }
                    }
                }
            }
            flush(&mut devices, &mut cur_name, &mut cur_vram);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = create_hidden_command("nvidia-smi")
            .args([
                "--query-gpu=name,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 3 {
                    let name = parts[0].trim().to_string();
                    let total = parts[1].trim().parse::<u64>().unwrap_or(0) * 1024 * 1024;
                    let used = parts[2].trim().parse::<u64>().unwrap_or(0) * 1024 * 1024;
                    let integrated = is_integrated_gpu(&name);
                    devices.push(GpuInfo {
                        name,
                        total_vram: total,
                        used_vram: used,
                        is_integrated: integrated,
                    });
                }
            }
        }
    }

    devices
}

/// 名称启发式判断是否为集成显卡（核显）。
/// 只在高置信度时判为集显：误把独显当核显会让模型被排除到错误的设备上。
pub fn is_integrated_gpu(name: &str) -> bool {
    let n = name.to_lowercase();
    // Intel Arc、Iris Xe MAX 为独立显卡
    if n.contains("arc") || n.contains("xe max") {
        return false;
    }
    if n.contains("intel") || n.contains("uhd") || n.contains("iris") {
        return true;
    }
    if n.contains("radeon") || n.contains("amd") {
        // Radeon RX / Pro 系列是独显；APU 核显命名形如 "AMD Radeon(TM) Graphics" / "Radeon 780M Graphics"
        if n.contains("rx ") || n.contains("pro ") {
            return false;
        }
        return n.contains("graphics") || n.contains("vega");
    }
    false
}

/// 需要把模型限定到独立显卡时返回 `--device` 参数值（逗号分隔的独显名）。
/// 仅在同时枚举到集显与独显时返回：纯独显/纯集显机器交给 llama-server 自行选择，
/// 避免多传一个可能因设备名不匹配而导致启动失败的参数。
pub fn discrete_device_list() -> Option<String> {
    let gpus = get_gpu_devices();
    if !gpus.iter().any(|g| g.is_integrated) {
        return None;
    }
    let names: Vec<String> = gpus
        .iter()
        .filter(|g| !g.is_integrated)
        .map(|g| g.name.clone())
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(names.join(","))
}

/// 逗号分隔命令行取值的长度上限，超出直接丢弃（正常设备名 / 分配比例远达不到这个量级）
const ARG_LIST_MAX_LEN: usize = 512;

/// 校验 `--device` 取值：`--list-devices` 输出的设备名，逗号分隔。
/// 该值会作为独立 argv 传给 llama-server，必须挡住两类问题：
/// - 以 `-` 开头的段会被 llama.cpp 当成新参数（argv 注入）；
/// - 控制字符会污染日志与启动失败信息。
/// 校验不通过返回 None，调用方应放弃下发该参数，而不是原样透传。
pub fn sanitize_device_list(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > ARG_LIST_MAX_LEN {
        return None;
    }
    let all_valid = trimmed.split(',').all(|seg| {
        let seg = seg.trim();
        !seg.is_empty() && !seg.starts_with('-') && seg.chars().all(|c| !c.is_control())
    });
    if !all_valid {
        return None;
    }
    Some(trimmed.to_string())
}

/// 校验 `--tensor-split` 取值：正数比例列表，如 "3,1" / "0.5,0.5"。
/// 规则与 `sanitize_device_list` 一致：不通过就返回 None，由调用方放弃下发。
pub fn sanitize_tensor_split(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > ARG_LIST_MAX_LEN {
        return None;
    }
    let all_valid = trimmed.split(',').all(|seg| {
        let seg = seg.trim();
        !seg.is_empty()
            && seg.chars().all(|c| c.is_ascii_digit() || c == '.')
            && seg.parse::<f64>().map(|f| f > 0.0).unwrap_or(false)
    });
    if !all_valid {
        return None;
    }
    Some(trimmed.to_string())
}

/// 解析 macOS 显存文本，如 "16 GB" / "8192 MB"，返回字节数
#[cfg(target_os = "macos")]
fn parse_mac_vram(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix("GB") {
        (n.trim(), 1024u64 * 1024 * 1024)
    } else if let Some(n) = s.strip_suffix("MB") {
        (n.trim(), 1024u64 * 1024)
    } else {
        return None;
    };
    let v: f64 = num.parse().ok()?;
    Some((v * mult as f64) as u64)
}

pub fn detect_gpu_vendor() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // 使用 PowerShell Get-CimInstance 替代已弃用的 wmic
        if let Ok(output) = create_hidden_command("powershell")
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

            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let lower = trimmed.to_lowercase();
                if lower.contains("nvidia")
                    || lower.contains("geforce")
                    || lower.contains("rtx")
                    || lower.contains("gtx")
                {
                    nvidia_found = Some(());
                } else if lower.contains("amd") || lower.contains("radeon") {
                    amd_found = Some(());
                } else if lower.contains("intel") {
                    intel_found = Some(());
                }
            }

            if nvidia_found.is_some() {
                return Some("nvidia".to_string());
            } else if amd_found.is_some() {
                return Some("amd".to_string());
            } else if intel_found.is_some() {
                return Some("intel".to_string());
            }
        }
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("Chipset Model") || stdout.contains("Metal") {
                return Some("apple".to_string());
            }
        }
        None
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}


/// 虚拟/远程显示设备识别（向日葵 OrayIdDDriver、微软基础适配器、Hyper-V、VMware、VBox、
/// 间接显示驱动等）：这些设备没有真实显存，混入下拉列表/自动选卡会造成误导。
/// 注意 OrayIdDDriver 小写为 orayidddriver（三个 d），iddriver 关键字匹配不上，需单独列 oray。
pub fn is_virtual_display_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("microsoft basic")
        || lower.contains("remote display")
        || lower.contains("iddriver")
        || lower.contains("idddriver")
        || lower.contains("oray")
        || lower.contains("indirect display")
        || lower.contains("display link")
        || lower.contains("parsec")
        || lower.contains("hyper-v")
        || lower.contains("virtual")
        || lower.contains("vbox")
        || lower.contains("vmware")
}

#[cfg(test)]
mod tests {
    use super::{is_integrated_gpu, sanitize_device_list, sanitize_tensor_split};

    // is_integrated_gpu 是纯启发式判断，判错的代价是模型被排除到错误的设备上。
    // 这组用例锁住当前语义，改动匹配规则时会立刻暴露回归。
    #[test]
    fn intel_uhd_is_integrated() {
        assert!(is_integrated_gpu("Intel(R) UHD Graphics 770"));
    }

    #[test]
    fn intel_iris_is_integrated() {
        assert!(is_integrated_gpu("Intel(R) Iris(R) Xe Graphics"));
    }

    #[test]
    fn intel_arc_is_discrete() {
        assert!(!is_integrated_gpu("Intel(R) Arc(TM) A770 Graphics"));
    }

    #[test]
    fn nvidia_is_discrete() {
        assert!(!is_integrated_gpu("NVIDIA GeForce RTX 4090"));
    }

    #[test]
    fn amd_apu_graphics_is_integrated() {
        assert!(is_integrated_gpu("AMD Radeon(TM) Graphics"));
        assert!(is_integrated_gpu("AMD Radeon 780M Graphics"));
    }

    #[test]
    fn amd_rx_is_discrete() {
        assert!(!is_integrated_gpu("AMD Radeon RX 7900 XTX"));
    }

    #[test]
    fn apple_silicon_is_not_marked_integrated() {
        // Apple Silicon 是统一内存，按独显处理，否则 discrete_device_list() 会把它排除掉
        assert!(!is_integrated_gpu("Apple M3 Pro"));
    }

    #[test]
    fn device_list_accepts_backend_names() {
        assert_eq!(
            sanitize_device_list("CUDA0,CUDA1").as_deref(),
            Some("CUDA0,CUDA1")
        );
        assert_eq!(
            sanitize_device_list("  NVIDIA GeForce RTX 4090 ").as_deref(),
            Some("NVIDIA GeForce RTX 4090")
        );
    }

    #[test]
    fn device_list_rejects_argv_injection() {
        // 以 '-' 开头的段会被 llama.cpp 当成新参数
        assert_eq!(sanitize_device_list("-ngl 99"), None);
        assert_eq!(sanitize_device_list("CUDA0,--verbose"), None);
    }

    #[test]
    fn device_list_rejects_empty_and_control_chars() {
        assert_eq!(sanitize_device_list(""), None);
        assert_eq!(sanitize_device_list("   "), None);
        assert_eq!(sanitize_device_list("CUDA0,"), None);
        assert_eq!(sanitize_device_list("CUDA0\nCUDA1"), None);
    }

    #[test]
    fn device_list_rejects_oversized_value() {
        assert_eq!(sanitize_device_list(&"a".repeat(513)), None);
    }

    #[test]
    fn tensor_split_accepts_ratios_and_fractions() {
        assert_eq!(sanitize_tensor_split("3,1").as_deref(), Some("3,1"));
        assert_eq!(sanitize_tensor_split("0.5,0.5").as_deref(), Some("0.5,0.5"));
        assert_eq!(sanitize_tensor_split(" 3 , 1 ").as_deref(), Some("3 , 1"));
    }

    #[test]
    fn tensor_split_rejects_invalid_values() {
        assert_eq!(sanitize_tensor_split(""), None);
        assert_eq!(sanitize_tensor_split("3,"), None);
        assert_eq!(sanitize_tensor_split("0,0"), None);
        assert_eq!(sanitize_tensor_split("abc"), None);
        assert_eq!(sanitize_tensor_split("3;rm -rf"), None);
        assert_eq!(sanitize_tensor_split("-1,2"), None);
    }
}


