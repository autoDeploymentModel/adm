fn main() {
    tauri_build::build();

    // 仅在 Windows 上设置子系统为 WINDOWS，避免命令行窗口
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS");
}