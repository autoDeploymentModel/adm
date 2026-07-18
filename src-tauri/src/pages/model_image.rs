use crate::common::config;
use crate::common::utils::platform;
use crate::common::utils::download::download_with_resume;
use crate::common::error::AppError;
use crate::app_state::AppState;
use crate::bail;
use crate::dbg_log;
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

#[derive(Serialize, Clone)]
pub struct SdStatus {
    pub exists: bool,
    pub downloading: bool,
    pub progress: u8,
    pub status: String,
}

fn get_sd_cli_path(base_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let sd_dir = base_dir.join("sd");
    let target = if cfg!(target_os = "windows") {
        "sd-cli.exe"
    } else {
        "sd-cli"
    };
    let sd_cli_path = sd_dir.join(target);
    if sd_cli_path.exists() {
        Some(sd_cli_path)
    } else {
        None
    }
}

fn find_newest_image_in_sd(sd_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    if !sd_dir.exists() {
        return None;
    }

    let entries = std::fs::read_dir(sd_dir).ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_file()
                && e.path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| matches!(ext.to_lowercase().as_str(), "png" | "jpg" | "jpeg"))
                    .unwrap_or(false)
        })
        .max_by_key(|e| std::fs::metadata(e.path()).and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

#[tauri::command]
pub async fn get_sd_status(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<SdStatus, AppError> {
    let base_dir = config::get_base_dir(Some(&app))?;
    let sd_dir = base_dir.join("sd");
    let target = if cfg!(target_os = "windows") {
        "sd-cli.exe"
    } else {
        "sd-cli"
    };
    let sd_cli_path = sd_dir.join(target);
    let exists = sd_cli_path.exists();

    let downloading = *state.sd_downloading.lock().map_err(|e| e.to_string())?;
    let progress = *state.sd_download_progress.lock().map_err(|e| e.to_string())?;
    let status = state.sd_download_status.lock().map_err(|e| e.to_string())?.clone();

    Ok(SdStatus { exists, downloading, progress, status })
}

fn get_download_url() -> Result<String, AppError> {
    let gpu_vendor = platform::detect_gpu_vendor();

    if cfg!(target_os = "windows") {
        match gpu_vendor.as_deref() {
            Some("nvidia") => Ok("https://adm.tuduoduo.top/sd/sd-cuda.zip".to_string()),
            Some("amd") => Ok("https://adm.tuduoduo.top/sd/sd-vulkan.zip".to_string()),
            Some("intel") => Ok("https://adm.tuduoduo.top/sd/sd-vulkan.zip".to_string()),
            Some(other) => {
                eprintln!("[WARN] 不支持的显卡型号: {}，将使用 Vulkan 版本", other);
                Ok("https://adm.tuduoduo.top/sd/sd-vulkan.zip".to_string())
            }
            None => {
                eprintln!("[WARN] 未检测到支持的显卡，将使用 Vulkan 版本");
                Ok("https://adm.tuduoduo.top/sd/sd-vulkan.zip".to_string())
            }
        }
    } else if cfg!(target_os = "macos") {
        Ok("https://adm.tuduoduo.top/sd/sd-macos.zip".to_string())
    } else {
        bail!("不支持的操作系统，当前仅支持 Windows 和 macOS")
    }
}

fn calc_part_file_progress(base_dir: &std::path::Path, download_url: &str) -> u8 {
    let sd_dir = base_dir.join("sd");
    let file_name = download_url.split('/').next_back().unwrap_or("download");
    let archive_path = sd_dir.join(".tmp_download").join(file_name);
    let part_path = archive_path.with_extension("part");

    // 检查 .part 文件（新格式）或 archive 文件（旧格式兼容）
    let check_path = if part_path.exists() { &part_path } else { &archive_path };

    if check_path.exists() {
        if let Ok(metadata) = std::fs::metadata(check_path) {
            let size = metadata.len();
            if size > 0 {
                // 粗略按文件大小估算，50MB 以下视为 <10%，100MB 以上视为 ~50%
                let mb = size / (1024 * 1024);
                if mb < 50 {
                    return ((mb as f64 / 500.0) * 100.0) as u8;
                }
                return 50;
            }
        }
    }
    0
}

#[tauri::command]
pub async fn download_and_extract_sd(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    // 检查是否已在下载中，防止并发
    {
        let mut downloading = state.sd_downloading.lock().map_err(|e| e.to_string())?;
        if *downloading {
            let progress = *state.sd_download_progress.lock().map_err(|e| e.to_string())?;
            app.emit(
                "sd-download-progress",
                serde_json::json!({ "status": "resuming", "progress": progress }),
            )
            .ok();
            bail!("SD 推理框架正在下载中，请勿重复操作");
        }
        *downloading = true;
    }
    {
        let mut progress = state.sd_download_progress.lock().map_err(|e| e.to_string())?;
        *progress = 0;
    }
    {
        let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
        *s = "downloading".to_string();
    }

    let base_dir = config::get_base_dir(Some(&app))?;
    let sd_dir = base_dir.join("sd");

    std::fs::create_dir_all(&sd_dir).map_err(|e| format!("创建 sd 目录失败: {}", e))?;

    let download_url = get_download_url()?;

    // 先检查是否有部分下载文件，还原进度
    let part_progress = calc_part_file_progress(&base_dir, &download_url);
    if part_progress > 0 {
        {
            let mut p = state.sd_download_progress.lock().map_err(|e| e.to_string())?;
            *p = part_progress;
        }
        app.emit(
            "sd-download-progress",
            serde_json::json!({ "status": "resuming", "progress": part_progress }),
        )
        .ok();
    } else {
        app.emit(
            "sd-download-progress",
            serde_json::json!({ "status": "downloading", "progress": 0 }),
        )
        .ok();
    }

    let file_name = download_url.split('/').next_back().unwrap_or("download");
    let temp_dir = sd_dir.join(".tmp_download");
    let archive_path = temp_dir.join(file_name);

    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 断点续传下载
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let part_path = archive_path.with_extension("part");

    let app_clone = app.clone();
    download_with_resume(
        &client, &download_url, &archive_path, &part_path,
        |progress, _downloaded, _total| {
            let st = app_clone.state::<AppState>();
            if let Ok(mut p) = st.sd_download_progress.lock() {
                *p = progress;
            }
            app_clone.emit(
                "sd-download-progress",
                serde_json::json!({ "status": "downloading", "progress": progress }),
            ).ok();
        },
    ).await.map_err(|e| {
        // 下载失败时重置状态
        let st = app.state::<AppState>();
        if let Ok(mut downloading) = st.sd_downloading.lock() {
            *downloading = false;
        }
        if let Ok(mut s) = st.sd_download_status.lock() {
            *s = "".to_string();
        }
        e
    })?;

    {
        let mut p = state.sd_download_progress.lock().map_err(|e| e.to_string())?;
        *p = 99;
    }
    {
        let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
        *s = "extracting".to_string();
    }

    app.emit(
        "sd-download-progress",
        serde_json::json!({ "status": "extracting", "progress": 99 }),
    )
    .ok();

    if !archive_path.exists() {
        {
            let mut downloading = state.sd_downloading.lock().map_err(|e| e.to_string())?;
            *downloading = false;
        }
        {
            let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
            *s = "".to_string();
        }
        bail!("压缩包不存在: {:?}", archive_path);
    }

    let archive_size = std::fs::metadata(&archive_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if archive_size == 0 {
        {
            let mut downloading = state.sd_downloading.lock().map_err(|e| e.to_string())?;
            *downloading = false;
        }
        {
            let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
            *s = "".to_string();
        }
        bail!("压缩包为空: {:?}", archive_path);
    }

    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let copied = if ext == "zip" {
        crate::common::utils::archive::extract_zip(&archive_path, &sd_dir)?
    } else {
        crate::common::utils::archive::extract_tar_gz(&archive_path, &sd_dir)?
    };

    if copied == 0 {
        {
            let mut downloading = state.sd_downloading.lock().map_err(|e| e.to_string())?;
            *downloading = false;
        }
        {
            let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
            *s = "".to_string();
        }
        bail!(
            "解压后未找到任何文件\n压缩包: {:?}\n压缩包大小: {} bytes\n请检查压缩包是否完整",
            archive_path, archive_size
        );
    }

    let _ = std::fs::remove_dir_all(&temp_dir);

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(sd_cli) = get_sd_cli_path(&base_dir) {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&sd_cli)
                .map_err(|e| format!("读取权限失败: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&sd_cli, perms)
                .map_err(|e| format!("设置执行权限失败: {}", e))?;
        }
    }

    {
        let mut p = state.sd_download_progress.lock().map_err(|e| e.to_string())?;
        *p = 100;
    }
    {
        let mut s = state.sd_download_status.lock().map_err(|e| e.to_string())?;
        *s = "done".to_string();
    }
    {
        let mut downloading = state.sd_downloading.lock().map_err(|e| e.to_string())?;
        *downloading = false;
    }

    app.emit(
        "sd-download-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}

#[tauri::command]
pub async fn save_sd_image_as(app: tauri::AppHandle, source_path: String) -> Result<(), AppError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg"])
        .set_file_name("generated_image.png")
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.await.map_err(|_| "保存对话框失败".to_string())?;
    let file_path = file_path.ok_or("用户取消了保存")?;

    let dest_path = file_path
        .as_path()
        .ok_or_else(|| "无法获取文件路径".to_string())?;

    std::fs::copy(&source_path, dest_path).map_err(|e| format!("保存文件失败: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn start_sd_generation(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    prompt: String,
    width: u32,
    height: u32,
    model_url: String,
    model_diffusion: Option<String>,
    model_vae: Option<String>,
) -> Result<(), AppError> {
    {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        if pid_lock.is_some() {
            bail!("已有进程在运行中，请先停止当前进程");
        }
    }

    let base_dir = config::get_base_dir(Some(&app))?;
    let sd_dir = base_dir.join("sd");

    let sd_cli_path = get_sd_cli_path(&base_dir)
        .ok_or("未找到 sd-cli 执行文件，请先下载".to_string())?;

    let models_dir = base_dir.join("models");
    let model_dir = models_dir.join(&model_id);

    if !model_dir.exists() {
        bail!("模型目录不存在: {:?}", model_dir);
    }

    let get_filename = |url: &str| -> String {
        url.split('/').next_back().unwrap_or(url).to_string()
    };

    let llm_filename = get_filename(&model_url);
    let llm_path = model_dir.join(&llm_filename);

    if !llm_path.exists() {
        bail!("模型文件不存在: {:?}", llm_path);
    }

    let args: Vec<String> = vec![
        "--diffusion-model".to_string(),
        model_dir.join(
            model_diffusion.as_ref()
                .map(|u| get_filename(u))
                .unwrap_or_else(|| "z-image-turbo-Q4_K_M.gguf".to_string())
        ).to_string_lossy().to_string(),
        "--vae".to_string(),
        model_dir.join(
            model_vae.as_ref()
                .map(|u| get_filename(u))
                .unwrap_or_else(|| "diffusion_pytorch_model.safetensors".to_string())
        ).to_string_lossy().to_string(),
        "--llm".to_string(),
        llm_path.to_string_lossy().to_string(),
        "-p".to_string(),
        prompt.clone(),
        "--cfg-scale".to_string(),
        "1.0".to_string(),
        "-v".to_string(),
        "--offload-to-cpu".to_string(),
        "--diffusion-fa".to_string(),
        "--vae-tiling".to_string(),
        "-H".to_string(),
        height.to_string(),
        "-W".to_string(),
        width.to_string(),
        "--steps".to_string(),
        "8".to_string(),
    ];

    dbg_log!("[DEBUG] sd-cli args: {:?}", args);

    let mut cmd = platform::create_hidden_command(&sd_cli_path);
    #[cfg(target_os = "macos")]
    {
        if let Ok(sd_dir) = config::get_base_dir(Some(&app)).map(|d| d.join("sd")) {
            cmd.env("DYLD_LIBRARY_PATH", sd_dir.to_string_lossy().to_string());
        }
    }
    cmd.current_dir(&sd_dir);

    #[cfg(target_os = "windows")]
    let mut child = cmd
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 sd-cli 失败: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    let mut child = crate::common::utils::platform::spawn_detached(cmd.args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()))
        .map_err(|e| format!("启动 sd-cli 失败: {}", e))?;

    let pid = child.id();

    {
        let mut pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        *pid_lock = Some(pid);
    }
    {
        let mut model_lock = state.running_model_id.lock().map_err(|e| e.to_string())?;
        *model_lock = Some(model_id.clone());
    }

    app.emit(
        "sd-started",
        serde_json::json!({
            "model_id": &model_id,
        }),
    )
    .ok();

    let app_clone = app.clone();
    let model_id_clone = model_id.clone();

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let app_for_stdout = app_clone.clone();
    let mid_for_stdout = model_id_clone.clone();
    let stdout_handle = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = stdout_pipe {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                app_for_stdout
                    .emit(
                        "sd-log",
                        serde_json::json!({
                            "model_id": &mid_for_stdout,
                            "line": line,
                            "source": "stdout",
                        }),
                    )
                    .ok();
            }
        }
    });

    let app_for_stderr = app_clone.clone();
    let mid_for_stderr = model_id_clone.clone();
    let stderr_handle = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(stderr) = stderr_pipe {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                app_for_stderr
                    .emit(
                        "sd-log",
                        serde_json::json!({
                            "model_id": &mid_for_stderr,
                            "line": line,
                            "source": "stderr",
                        }),
                    )
                    .ok();
            }
        }
    });

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    // 查找生成的图片并发送到前端
    let newest_image = find_newest_image_in_sd(&sd_dir);
    if let Some(image_path) = newest_image {
        match std::fs::read(&image_path) {
            Ok(data) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                app_clone
                    .emit(
                        "sd-image-result",
                        serde_json::json!({
                            "model_id": &model_id_clone,
                            "image_data": b64,
                            "file_path": image_path.to_string_lossy().to_string(),
                        }),
                    )
                    .ok();
                app_clone
                    .emit(
                        "sd-log",
                        serde_json::json!({
                            "model_id": &model_id_clone,
                            "line": format!("图片已生成: {}", image_path.to_string_lossy()),
                            "source": "info",
                        }),
                    )
                    .ok();
            }
            Err(e) => {
                app_clone
                    .emit(
                        "sd-log",
                        serde_json::json!({
                            "model_id": &model_id_clone,
                            "line": format!("读取生成图片失败: {}", e),
                            "source": "stderr",
                        }),
                    )
                    .ok();
            }
        }
    } else {
        app_clone
            .emit(
                "sd-log",
                serde_json::json!({
                    "model_id": &model_id_clone,
                    "line": "未找到生成的图片文件，请检查 sd-cli 输出",
                    "source": "stderr",
                }),
            )
            .ok();
    }

    // 清除进程状态，允许下一次生成
    {
        let mut pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        *pid_lock = None;
    }
    {
        let mut model_lock = state.running_model_id.lock().map_err(|e| e.to_string())?;
        *model_lock = None;
    }
    {
        let mut port_lock = state.running_port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }

    app_clone
        .emit(
            "sd-complete",
            serde_json::json!({ "model_id": &model_id_clone }),
        )
        .ok();

    Ok(())
}

#[tauri::command]
pub async fn stop_sd(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let pid = {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        pid_lock.ok_or("没有正在运行的进程")?
    };

    crate::common::utils::platform::kill_process_tree(pid);

    {
        let mut pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        *pid_lock = None;
    }
    {
        let mut model_lock = state.running_model_id.lock().map_err(|e| e.to_string())?;
        *model_lock = None;
    }
    {
        let mut port_lock = state.running_port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }

    Ok(())
}