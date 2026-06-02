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

pub fn get_gpu_info() -> (u64, u64, bool) {
    let mut total_vram: u64 = 0;
    let used_vram: u64 = 0;
    let mut has_gpu = false;

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = create_hidden_command("wmic")
            .args(["path", "win32_VideoController", "get", "AdapterRAM"])
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

#[cfg(target_os = "windows")]
fn decode_wmic_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16_data: Vec<u16> = bytes[2..]
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16_data)
    } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let u16_data: Vec<u16> = bytes[2..]
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16_data)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

pub fn detect_gpu_vendor() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("wmic")
            .creation_flags(0x08000000)
            .args(["path", "win32_VideoController", "get", "Name"])
            .output()
        {
            let stdout = decode_wmic_output(&output.stdout);
            let mut nvidia_found = None;
            let mut amd_found = None;
            let mut intel_found = None;

            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed == "Name" {
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
