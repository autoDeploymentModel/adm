fn main() {
    tauri_build::build();

    // 仅在 Windows 上设置子系统为 WINDOWS，避免命令行窗口。
    // 必须用 `-bins` 限定：不带后缀的 `rustc-link-arg` 对包内所有 target 生效，
    // 包括 `cargo test --lib` 生成的测试二进制；测试入口是 main 而非 WinMain，
    // 强行指定 WINDOWS 子系统会报 LNK2019: 无法解析的外部符号 WinMain。
    // （bin 自身还有 main.rs 的 `#![windows_subsystem = "windows"]` 兜底。）
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bins=/SUBSYSTEM:WINDOWS");
}