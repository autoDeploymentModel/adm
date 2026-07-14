// model_list.html 对应逻辑（模型管理）

use crate::common::*;
use crate::app_state::AppState;
use crate::common::config;
use crate::common::utils::download::download_with_resume;
use crate::bail;
use crate::dbg_log;

use std::collections::HashMap;
use tauri::Emitter;
use tauri::Manager;

// ===== Tauri Command =====

#[tauri::command]
pub async fn scan_local_models(app: tauri::AppHandle) -> Result<Vec<LocalModel>, AppError> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");

    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("创建 models 目录失败: {}", e))?;
        return Ok(Vec::new());
    }

    let mut models = Vec::new();

    for entry in std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(dir_name) = path.file_name() {
                let dir_str = dir_name.to_string_lossy().to_string();
                let mut files: Vec<String> = Vec::new();
                if let Ok(dir_entries) = std::fs::read_dir(&path) {
                    for e in dir_entries.flatten() {
                        let fp = e.path();
                        if fp.is_file() {
                            if let Some(name) = fp.file_name() {
                                let name_str = name.to_string_lossy().to_string();
                                if !name_str.ends_with(".part") {
                                    files.push(name_str);
                                }
                            }
                        }
                    }
                }
                if !files.is_empty() {
                    models.push(LocalModel { model_id: dir_str, files });
                }
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "gguf" {
                    if let Some(stem) = path.file_stem() {
                        let model_id = stem.to_string_lossy().to_string();
                        let filename = path.file_name().unwrap().to_string_lossy().to_string();
                        models.push(LocalModel { model_id, files: vec![filename] });
                    }
                }
            }
        }
    }

    Ok(models)
}

#[tauri::command]
pub async fn scan_part_files(app: tauri::AppHandle) -> Result<Vec<PartFileProgress>, AppError> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");

    if !models_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();

    for entry in std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(dir_name) = path.file_name() {
                let dir_str = dir_name.to_string_lossy().to_string();
                let part_file = path.join(format!("{}.gguf.part", dir_str));
                if part_file.exists() {
                    let size = std::fs::metadata(&part_file).map(|m| m.len()).unwrap_or(0);
                    result.push(PartFileProgress { model_id: dir_str.clone(), existing_size: size });
                }
                if let Ok(entries) = std::fs::read_dir(&path) {
                    for entry in entries.flatten() {
                        let fp = entry.path();
                        if fp.is_file() {
                            if let Some(ext) = fp.extension() {
                                if ext == "part" && fp.file_name().map_or(true, |n| n.to_string_lossy() != format!("{}.gguf.part", dir_str).as_str()) {
                                    let size = std::fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
                                    result.push(PartFileProgress { model_id: dir_str.clone(), existing_size: size });
                                }
                            }
                        }
                    }
                }
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "part" {
                    if let Some(stem) = path.file_stem() {
                        let stem_str = stem.to_string_lossy().to_string();
                        let model_id = stem_str.trim_end_matches(".gguf").to_string();
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        result.push(PartFileProgress { model_id, existing_size: size });
                    }
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn fetch_model_list() -> Result<Vec<RemoteModel>, AppError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get("https://adm.tuduoduo.top/model.json")
        .send()
        .await
        .map_err(|e| format!("获取模型列表失败: {}", e))?;

    if !response.status().is_success() {
        bail!("服务器返回错误状态码: {}", response.status());
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应文本失败: {}", e))?;

    let models: Vec<RemoteModel> = serde_json::from_str(&text)
        .map_err(|e| format!("解析模型列表失败: {}", e))?;

    Ok(models)
}

#[tauri::command]
pub async fn download_model(
    app: tauri::AppHandle,
    model_id: String,
    model_url: String,
    model_mmproj: Option<String>,
    model_diffusion: Option<String>,
    model_vae: Option<String>,
    model_type: String,
) -> Result<(), AppError> {
    {
        let state = app.state::<AppState>();
        let map = state.downloading_progress.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&model_id) {
            bail!("该模型正在下载中，请勿重复点击");
        }
    }

    let model_url = model_url.replace("https://huggingface.co/", "https://hf-mirror.com/");

    let data_dir = config::get_data_dir(Some(&app))?;
    let model_dir = data_dir.join("models").join(&model_id);
    std::fs::create_dir_all(&model_dir).map_err(|e| format!("创建模型目录失败: {}", e))?;

    let model_filename = model_url
        .rsplit('/')
        .next()
        .unwrap_or(&model_id)
        .to_string();
    let final_path = model_dir.join(&model_filename);
    let part_path = model_dir.join(format!("{}.part", model_filename));

    let download_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;

    app.state::<AppState>().downloading_progress.lock().unwrap_or_else(|e| e.into_inner()).insert(model_id.clone(), 0u8);

    struct CleanupGuard {
        h: tauri::AppHandle,
        id: String,
    }
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            if let Ok(mut map) = self.h.state::<AppState>().downloading_progress.lock() {
                map.remove(&self.id);
            }
            if let Ok(mut map) = self.h.state::<AppState>().downloading_phase.lock() {
                map.remove(&self.id);
            }
        }
    }
    let _guard = CleanupGuard { h: app.clone(), id: model_id.clone() };

    // ===== 主模型文件下载 =====
    {
        let app_clone = app.clone();
        let mid = model_id.clone();
        download_with_resume(
            &download_client, &model_url, &final_path, &part_path,
            |progress, downloaded, total| {
                app_clone.emit(
                    "download-progress",
                    serde_json::json!({
                        "model_id": &mid,
                        "progress": progress,
                        "downloaded": downloaded,
                        "total": total,
                        "type": "model",
                    }),
                ).ok();
                if let Ok(mut map) = app_clone.state::<AppState>().downloading_progress.lock() {
                    map.insert(mid.clone(), progress);
                }
            },
        ).await?;
        app.emit(
            "download-complete",
            serde_json::json!({ "model_id": &model_id, "type": "model" }),
        ).ok();
    }

    // ===== 视觉多模态：mmproj 文件下载 =====
    if model_type == "视觉多模态理解" {
        if let Some(mmproj_url) = model_mmproj {
            app.state::<AppState>().downloading_phase.lock().unwrap_or_else(|e| e.into_inner()).insert(model_id.clone(), "mmproj".to_string());
            download_extra_file(
                &app, &model_id, &model_dir, &mmproj_url,
                &download_client, "mmproj"
            ).await?;
        }
    }

    // ===== 文生图：diffusion + vae 文件下载 =====
    if model_type == "文本生成图片" {
        if let Some(diffusion_url) = model_diffusion {
            app.state::<AppState>().downloading_phase.lock().unwrap_or_else(|e| e.into_inner()).insert(model_id.clone(), "diffusion".to_string());
            download_extra_file(
                &app, &model_id, &model_dir, &diffusion_url,
                &download_client, "diffusion"
            ).await?;
        }
        if let Some(vae_url) = model_vae {
            app.state::<AppState>().downloading_phase.lock().unwrap_or_else(|e| e.into_inner()).insert(model_id.clone(), "vae".to_string());
            download_extra_file(
                &app, &model_id, &model_dir, &vae_url,
                &download_client, "vae"
            ).await?;
        }
    }

    Ok(())
}

async fn download_extra_file(
    app: &tauri::AppHandle,
    model_id: &str,
    model_dir: &std::path::Path,
    file_url: &str,
    download_client: &reqwest::Client,
    file_type: &str,
) -> Result<(), AppError> {
    let file_url = file_url.replace("https://huggingface.co/", "https://hf-mirror.com/");

    let filename = file_url
        .rsplit('/')
        .next()
        .unwrap_or(file_type)
        .to_string();
    let final_path = model_dir.join(&filename);
    let part_path = model_dir.join(format!("{}.part", filename));

    // 发送初始进度（0%）
    app.emit(
        "download-progress",
        serde_json::json!({
            "model_id": model_id,
            "progress": 0u8,
            "downloaded": 0u64,
            "total": 0u64,
            "type": file_type,
        }),
    )
    .ok();

    // 使用通用下载函数（带断点续传）
    let app_clone = app.clone();
    let mid = model_id.to_string();
    let ft = file_type.to_string();
    download_with_resume(
        download_client, &file_url, &final_path, &part_path,
        |progress, downloaded, total| {
            app_clone.emit(
                "download-progress",
                serde_json::json!({
                    "model_id": &mid,
                    "progress": progress,
                    "downloaded": downloaded,
                    "total": total,
                    "type": &ft,
                }),
            )
            .ok();
        },
    )
    .await?;

    app.emit(
        "download-complete",
        serde_json::json!({ "model_id": model_id, "type": file_type }),
    )
    .ok();

    Ok(())
}

#[tauri::command]
pub async fn start_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    params: LaunchParams,
    support_images: bool,
    model_filename: Option<String>,
) -> Result<(), AppError> {
    {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        if pid_lock.is_some() {
            bail!("已有模型在运行中，请先停止当前模型");
        }
    }

    let server_path = config::get_llama_server_path(Some(&app))?;
    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");
    let model_path = if let Some(fname) = &model_filename {
        let subfolder_path = models_dir.join(&model_id).join(fname);
        if subfolder_path.exists() {
            subfolder_path
        } else {
            return Err(AppError::msg(format!("模型文件不存在: {:?}", subfolder_path)));
        }
    } else {
        let subfolder_path = models_dir.join(&model_id).join(format!("{}.gguf", model_id));
        let root_path = models_dir.join(format!("{}.gguf", model_id));
        if subfolder_path.exists() {
            subfolder_path
        } else if root_path.exists() {
            root_path
        } else {
            return Err(AppError::msg(format!("模型文件不存在: {:?}", subfolder_path)));
        }
    };

    let mut args: Vec<String> = vec![
        "-m".to_string(),
        model_path.to_string_lossy().to_string(),
    ];

    // 诊断日志：打印接收到的参数
    app.emit(
        "model-log",
        serde_json::json!({
            "model_id": &model_id,
            "line": format!("[DEBUG] model_filename: {:?}", model_filename),
            "source": "stdout",
        }),
    )
    .ok();
    app.emit(
        "model-log",
        serde_json::json!({
            "model_id": &model_id,
            "line": format!("[DEBUG] params: ctx={:?} ngl={:?} threads={:?} fa={:?} temp={:?} port={:?} host={:?} spec_type={:?}",
                params.ctx_size, params.n_gpu_layers, params.threads, params.flash_attn,
                params.temperature, params.port, params.host, params.spec_type),
            "source": "stdout",
        }),
    )
    .ok();

    if support_images {
        let model_dir = model_path.parent().unwrap();
        let mut mmproj_path: Option<std::path::PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(model_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name() {
                        let name_str = name.to_string_lossy();
                        if name_str.starts_with("mmproj") && name_str.ends_with(".gguf") {
                            mmproj_path = Some(path);
                            break;
                        }
                    }
                }
            }
        }
        if let Some(mp) = mmproj_path {
            args.extend(["--mmproj".to_string(), mp.to_string_lossy().to_string()]);
        }
    }

    if let Some(ctx) = params.ctx_size {
        args.extend(["-c".to_string(), ctx.to_string()]);
    }
    if let Some(n) = params.n_predict {
        args.extend(["-n".to_string(), n.to_string()]);
    }
    if let Some(b) = params.batch_size {
        args.extend(["-b".to_string(), b.to_string()]);
    }
    if let Some(ub) = params.ubatch_size {
        args.extend(["-ub".to_string(), ub.to_string()]);
    }
    if let Some(ngl) = &params.n_gpu_layers {
        args.extend(["-ngl".to_string(), ngl.clone()]);
    }
    if let Some(t) = params.threads {
        args.extend(["-t".to_string(), t.to_string()]);
    }
    if let Some(tb) = params.threads_batch {
        args.extend(["-tb".to_string(), tb.to_string()]);
    }
    if let Some(fa) = &params.flash_attn {
        args.extend(["-fa".to_string(), fa.clone()]);
    }
    if let Some(ctk) = &params.cache_type_k {
        args.extend(["-ctk".to_string(), ctk.clone()]);
    }
    if let Some(ctv) = &params.cache_type_v {
        args.extend(["-ctv".to_string(), ctv.clone()]);
    }
    if let Some(true) = params.mlock {
        args.push("--mlock".to_string());
    }
    if let Some(false) = params.mmap {
        args.push("--no-mmap".to_string());
    }
    if let Some(temp) = params.temperature {
        args.extend(["--temp".to_string(), temp.to_string()]);
    }
    if let Some(topk) = params.top_k {
        args.extend(["--top-k".to_string(), topk.to_string()]);
    }
    if let Some(topp) = params.top_p {
        args.extend(["--top-p".to_string(), topp.to_string()]);
    }
    if let Some(minp) = params.min_p {
        args.extend(["--min-p".to_string(), minp.to_string()]);
    }
    if let Some(rp) = params.repeat_penalty {
        args.extend(["--repeat-penalty".to_string(), rp.to_string()]);
    }
    if let Some(rln) = params.repeat_last_n {
        args.extend(["--repeat-last-n".to_string(), rln.to_string()]);
    }
    if let Some(dm) = params.dry_multiplier {
        args.extend(["--dry-multiplier".to_string(), dm.to_string()]);
    }
    if let Some(dal) = params.dry_allowed_length {
        args.extend(["--dry-allowed-length".to_string(), dal.to_string()]);
    }
    if let Some(dpln) = params.dry_penalty_last_n {
        args.extend(["--dry-penalty-last-n".to_string(), dpln.to_string()]);
    }
    if let Some(pp) = params.presence_penalty {
        args.extend(["--presence-penalty".to_string(), pp.to_string()]);
    }
    if let Some(fp) = params.frequency_penalty {
        args.extend(["--frequency-penalty".to_string(), fp.to_string()]);
    }
    if let Some(r) = &params.reasoning {
        args.extend(["--reasoning".to_string(), r.clone()]);
    }

    // MTP (Multi-Token Prediction) auto-detection
    if let Some(spec_type) = &params.spec_type {
        if spec_type != "none" {
            if let Some(n) = params.spec_draft_n_max {
                args.extend(["--spec-draft-n-max".to_string(), n.to_string()]);
            }
            args.extend(["--spec-type".to_string(), spec_type.clone()]);
        }
    } else if model_id.to_lowercase().contains("mtp") {
            args.extend(["--spec-draft-n-max".to_string(), "2".to_string()]);
            args.extend(["--spec-type".to_string(), "draft-mtp".to_string()]);
            app.emit(
                "model-log",
                serde_json::json!({
                    "model_id": &model_id,
                    "line": "[DEBUG] MTP auto-detection: triggered (model_id contains 'MTP')",
                    "source": "stdout",
                }),
            )
            .ok();
        }

    let port = params.port.unwrap_or(1010);
    args.extend(["--port".to_string(), port.to_string()]);

    if let Some(host) = &params.host {
        args.extend(["--host".to_string(), host.clone()]);
    }

    args.push("--verbose".to_string());

    dbg_log!("[DEBUG] llama-server args: {:?}", args);

    app.emit(
        "model-log",
        serde_json::json!({
            "model_id": &model_id,
            "line": format!("启动参数: {:?}", args),
            "source": "stdout",
        }),
    )
    .ok();

    let mut cmd = crate::common::utils::platform::create_hidden_command(&server_path);
    #[cfg(target_os = "macos")]
    {
        if let Ok(llamacpp_dir) = config::get_llamacpp_dir(Some(&app)) {
            cmd.env("DYLD_LIBRARY_PATH", llamacpp_dir.to_string_lossy().to_string());
        }
    }
    let mut child = cmd
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 llama-server 失败: {}", e))?;

    let pid = child.id();

    {
        let mut pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        *pid_lock = Some(pid);
    }
    {
        let mut model_lock = state.running_model_id.lock().map_err(|e| e.to_string())?;
        *model_lock = Some(model_id.clone());
    }
    {
        let mut port_lock = state.running_port.lock().map_err(|e| e.to_string())?;
        *port_lock = Some(port);
    }
    state.set_model_running(true);
    state.bump_model_generation(); // 模型重启代次 +1，供 Agent 页判断是否需要重启 admAgent

    app.emit(
        "model-started",
        serde_json::json!({
            "model_id": &model_id,
            "port": port,
        }),
    )
    .ok();

    let app_clone = app.clone();
    let model_id_clone = model_id.clone();

    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                app_clone
                    .emit(
                        "model-log",
                        serde_json::json!({
                            "model_id": &model_id_clone,
                            "line": line,
                            "source": "stdout",
                        }),
                    )
                    .ok();

                if line.contains("llama server listening")
                    || line.contains("HTTP server listening")
                    || line.contains("listening on")
                {
                    app_clone
                        .emit(
                            "model-started",
                            serde_json::json!({
                                "model_id": &model_id_clone,
                                "port": port,
                            }),
                        )
                        .ok();
                }
            }
        }

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                app_clone
                    .emit(
                        "model-log",
                        serde_json::json!({
                            "model_id": &model_id_clone,
                            "line": line,
                            "source": "stderr",
                        }),
                    )
                    .ok();
            }
        }

        // 清除 AppState 中的状态，确保进程退出后可以重新启动
        {
            let state = app_clone.state::<AppState>();
            *state.running_process.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.running_port.lock().unwrap_or_else(|e| e.into_inner()) = None;
            state.set_model_running(false);
        }

        app_clone
            .emit(
                "model-stopped",
                serde_json::json!({ "model_id": &model_id_clone }),
            )
            .ok();
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_model(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let pid = {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        pid_lock.ok_or("没有正在运行的模型")?
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("taskkill")
            .creation_flags(0x08000000)
            .args(["/PID", &pid.to_string(), "/F"])
            .spawn()
            .map_err(|e| format!("停止进程失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn()
            .map_err(|e| format!("停止进程失败: {}", e))?;
    }

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
    state.set_model_running(false);

    Ok(())
}

/// 查询是否有模型已成功启动（全局标识），用于进入 Agent 页前的判断
#[tauri::command]
pub async fn is_model_running(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    Ok(state.is_model_running())
}

#[tauri::command]
pub async fn get_model_status(state: tauri::State<'_, AppState>) -> Result<ModelStatus, AppError> {
    let pid = *state
        .running_process
        .lock()
        .map_err(|e| e.to_string())?;
    let model_id = state
        .running_model_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let port = *state.running_port.lock().map_err(|e| e.to_string())?;

    let running = if let Some(pid) = pid {
        let mut sys = sysinfo::System::new();
        sys.refresh_all();
        sys.process(sysinfo::Pid::from_u32(pid)).is_some()
    } else {
        false
    };

    if !running {
        let mut pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        *pid_lock = None;
        let mut model_lock = state.running_model_id.lock().map_err(|e| e.to_string())?;
        *model_lock = None;
        let mut port_lock = state.running_port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }

    Ok(ModelStatus {
        running,
        model_id,
        pid,
        port,
    })
}

#[tauri::command]
pub async fn get_downloading_models(state: tauri::State<'_, AppState>) -> Result<HashMap<String, u8>, AppError> {
    let map = state.downloading_progress.lock().map_err(|e| e.to_string())?;
    Ok(map.clone())
}

#[tauri::command]
pub async fn get_downloading_phases(state: tauri::State<'_, AppState>) -> Result<HashMap<String, String>, AppError> {
    let map = state.downloading_phase.lock().map_err(|e| e.to_string())?;
    Ok(map.clone())
}
