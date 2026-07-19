#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
        return None;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}
