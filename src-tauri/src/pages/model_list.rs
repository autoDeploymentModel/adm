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
                                if ext == "part" && fp.file_name().is_none_or(|n| n.to_string_lossy() != format!("{}.gguf.part", dir_str).as_str()) {
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
            "line": format!("[DEBUG] params: ctx={:?} port={:?}", params.ctx_size, params.port),
            "source": "stdout",
        }),
    )
    .ok();

    // 视觉多模态：仅当模型声明支持图片且 mmproj 文件实际存在时才启用（同步记录到 AppState 供 Agent 配置使用）
    let mut vision_enabled = false;
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
            vision_enabled = true;
        }
    }
    *state.model_supports_images.lock().unwrap_or_else(|e| e.into_inner()) = vision_enabled;

    // 推理能力：UI 已不再暴露推理开关，按 llama-server 默认 auto 行为处理
    // （llama-server 按模型格式自动启用，能出推理内容即具备该能力）
    // 同步记录到 AppState 供 Agent 配置（admAgent.json 的 can_reason）使用。
    *state
        .model_supports_reasoning
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = true;

    // 上下文大小（UI 唯一允许调整的参数），0 = 不传，使用模型自带上下文
    if let Some(ctx) = params.ctx_size {
        if ctx > 0 {
            args.extend(["-c".to_string(), ctx.to_string()]);
        }
    }

    // 显卡放置策略：
    // --device 优先取用户显式填写；留空且勾选「排除集成显卡」且机器确有集显+独显时自动填独显列表
    // （Vulkan 等后端默认会把层分给核显，导致推理变慢甚至显存不足），单卡模式下同样生效。
    // 无论来源是用户填写还是自动推导，都必须过一遍 sanitize_device_list：
    // 值会作为独立 argv 直接进入 llama-server，格式非法的后果是服务端拒绝启动。
    let auto_device = if params.exclude_integrated {
        crate::common::utils::platform::discrete_device_list()
    } else {
        None
    };
    let raw_device = params
        .device
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(auto_device.as_deref());
    let device = raw_device.and_then(crate::common::utils::platform::sanitize_device_list);
    // 填了值却被校验拦下：静默丢弃会让用户以为生效了，必须在日志里说清楚
    if raw_device.is_some() && device.is_none() {
        app.emit(
            "model-log",
            serde_json::json!({
                "model_id": &model_id,
                "line": "[WARN] --device 取值格式非法，已忽略该参数（请使用 llama-server --list-devices 输出的名称，逗号分隔）",
                "source": "stderr",
            }),
        )
        .ok();
    }

    // --main-gpu 仅对 none（选卡）与 row（中间结果/KV 放主卡）生效，layer/tensor 下无意义，不下发
    let main_gpu = if params.multi_gpu {
        let sm = params
            .split_mode
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("layer");
        params
            .main_gpu
            .filter(|v| *v >= 0)
            .filter(|_| sm == "none" || sm == "row")
    } else {
        None
    };

    if params.multi_gpu {
        let split_mode = params
            .split_mode
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("layer");
        let tensor_split = params
            .tensor_split
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(crate::common::utils::platform::sanitize_tensor_split);

        args.extend(["--split-mode".to_string(), split_mode.to_string()]);
        if let Some(ts) = tensor_split {
            args.extend(["--tensor-split".to_string(), ts.to_string()]);
        }
        if let Some(mg) = main_gpu {
            args.extend(["--main-gpu".to_string(), mg.to_string()]);
        }
    }
    if let Some(dev) = &device {
        args.extend(["--device".to_string(), dev.clone()]);
    }
    if params.multi_gpu || device.is_some() {
        app.emit(
            "model-log",
            serde_json::json!({
                "model_id": &model_id,
                "line": format!(
                    "[DEBUG] GPU placement: multi-gpu={} split-mode={:?} tensor-split={:?} main-gpu(生效)={:?} device={:?}",
                    params.multi_gpu,
                    params.split_mode,
                    params.tensor_split,
                    main_gpu,
                    device
                ),
                "source": "stdout",
            }),
        )
        .ok();
    }

    // MTP (Multi-Token Prediction) auto-detection
    if model_id.to_lowercase().contains("mtp") {
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

    // 监听端口
    let port: u16 = params.port.unwrap_or(5678);
    args.extend(["--port".to_string(), port.to_string()]);

    // 监听地址（默认 127.0.0.1 仅本地）
    let host = params.host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
    args.extend(["--host".to_string(), host]);

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
            // 同时设置 DYLD_LIBRARY_PATH 和 current_dir：
            // - DYLD_LIBRARY_PATH 用于查找动态库（旧版 macOS）
            // - current_dir 作为备用，防止 SIP 删除 DYLD_LIBRARY_PATH（macOS 14+）
            cmd.env("DYLD_LIBRARY_PATH", llamacpp_dir.to_string_lossy().to_string());
            cmd.current_dir(&llamacpp_dir);
            app.emit(
                "model-log",
                serde_json::json!({
                    "model_id": &model_id,
                    "line": format!("[DEBUG] macOS env: DYLD_LIBRARY_PATH={}, current_dir={}", llamacpp_dir.to_string_lossy(), llamacpp_dir.to_string_lossy()),
                    "source": "stdout",
                }),
            ).ok();
        }
    }

    app.emit(
        "model-log",
        serde_json::json!({
            "model_id": &model_id,
            "line": format!("[DEBUG] server_path: {}", server_path.to_string_lossy()),
            "source": "stdout",
        }),
    ).ok();
    app.emit(
        "model-log",
        serde_json::json!({
            "model_id": &model_id,
            "line": format!("[DEBUG] full command: {} {:?}", server_path.to_string_lossy(), args),
            "source": "stdout",
        }),
    ).ok();

    #[cfg(target_os = "windows")]
    let mut child = cmd
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("启动 llama-server 失败: {} | path: {} | args: {:?}", e, server_path.to_string_lossy(), args);
            app.emit(
                "model-log",
                serde_json::json!({
                    "model_id": &model_id,
                    "line": format!("[ERROR] spawn failed: {}", msg),
                    "source": "stderr",
                }),
            ).ok();
            msg
        })?;

    #[cfg(not(target_os = "windows"))]
    let mut child = crate::common::utils::platform::spawn_detached(cmd.args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()))
        .map_err(|e| {
            let msg = format!("启动 llama-server 失败: {} | path: {} | args: {:?}", e, server_path.to_string_lossy(), args);
            app.emit(
                "model-log",
                serde_json::json!({
                    "model_id": &model_id,
                    "line": format!("[ERROR] spawn failed: {}", msg),
                    "source": "stderr",
                }),
            ).ok();
            msg
        })?;

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

    // 同步本地模型能力（supports_images 等）给运行中的 admAgent：
    // 服务端只在启动时读 admAgent.json，若它先于模型启动（如微信 Bridge 自动拉起），
    // 不同步会导致视觉模型被误判为不支持图片（图片附件被静默丢弃）
    crate::pages::agent::sync_local_model_capabilities(app.clone());

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

    let app_clone2 = app.clone();
    let model_id_clone2 = model_id.clone();

    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};

        // 并发读取 stdout 和 stderr，防止单个流阻塞导致另一个流无法读取
        let stdout_handle = if let Some(stdout) = child.stdout.take() {
            let app_c = app_clone.clone();
            let mid = model_id_clone.clone();
            Some(std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    app_c
                        .emit(
                            "model-log",
                            serde_json::json!({
                                "model_id": &mid,
                                "line": line,
                                "source": "stdout",
                            }),
                        )
                        .ok();

                    if line.contains("llama server listening")
                        || line.contains("HTTP server listening")
                        || line.contains("listening on")
                    {
                        app_c
                            .emit(
                                "model-started",
                                serde_json::json!({
                                    "model_id": &mid,
                                    "port": port,
                                }),
                            )
                            .ok();
                    }
                }
            }))
        } else {
            None
        };

        let stderr_handle = if let Some(stderr) = child.stderr.take() {
            let app_c = app_clone.clone();
            let mid = model_id_clone.clone();
            Some(std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    app_c
                        .emit(
                            "model-log",
                            serde_json::json!({
                                "model_id": &mid,
                                "line": line,
                                "source": "stderr",
                            }),
                        )
                        .ok();
                }
            }))
        } else {
            None
        };

        // 等待 stdout/stderr 读取线程结束
        if let Some(h) = stdout_handle { let _ = h.join(); }
        if let Some(h) = stderr_handle { let _ = h.join(); }

        // 等待子进程退出，获取退出码
        let exit_status = child.wait();
        match &exit_status {
            Ok(status) => {
                app_clone2.emit(
                    "model-log",
                    serde_json::json!({
                        "model_id": &model_id_clone2,
                        "line": format!("[DEBUG] llama-server exited with status: {}", status),
                        "source": "stdout",
                    }),
                ).ok();
            }
            Err(e) => {
                app_clone2.emit(
                    "model-log",
                    serde_json::json!({
                        "model_id": &model_id_clone2,
                        "line": format!("[ERROR] failed to wait for llama-server: {}", e),
                        "source": "stderr",
                    }),
                ).ok();
            }
        }

        // 清除 AppState 中的状态，确保进程退出后可以重新启动
        {
            let state = app_clone2.state::<AppState>();
            *state.running_process.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.running_port.lock().unwrap_or_else(|e| e.into_inner()) = None;
            state.set_model_running(false);
        }

        app_clone2
            .emit(
                "model-stopped",
                serde_json::json!({ "model_id": &model_id_clone2 }),
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
    state.set_model_running(false);

    Ok(())
}

#[tauri::command]
pub async fn delete_local_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
) -> Result<(), AppError> {
    {
        let running_id = state.running_model_id.lock().map_err(|e| e.to_string())?;
        if let Some(ref rid) = *running_id {
            if rid == &model_id {
                bail!("模型正在运行中，请先关闭后再删除");
            }
        }
    }

    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");

    let dir_path = models_dir.join(&model_id);
    if dir_path.exists() {
        std::fs::remove_dir_all(&dir_path)
            .map_err(|e| format!("删除模型目录失败: {}", e))?;
    }

    let file_path = models_dir.join(format!("{}.gguf", model_id));
    if file_path.exists() {
        std::fs::remove_file(&file_path)
            .map_err(|e| format!("删除模型文件失败: {}", e))?;
    }

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
