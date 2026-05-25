// model_list.html 对应逻辑（模型管理）

use crate::common::*;
use crate::app_state::AppState;
use crate::common::config;

use std::collections::HashMap;
use tauri::Emitter;
use tauri::Manager;

// ===== Tauri Command =====

#[tauri::command]
pub async fn scan_local_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");

    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("创建 models 目录失败: {}", e))?;
        return Ok(Vec::new());
    }

    let mut model_ids = Vec::new();
    let entries = std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "gguf" {
                    if let Some(stem) = path.file_stem() {
                        model_ids.push(stem.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Ok(model_ids)
}

#[tauri::command]
pub async fn scan_part_files(app: tauri::AppHandle) -> Result<Vec<PartFileProgress>, String> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");

    if !models_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let entries = std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
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
pub async fn fetch_model_list() -> Result<Vec<RemoteModel>, String> {
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
        return Err(format!("服务器返回错误状态码: {}", response.status()));
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
) -> Result<(), String> {
    // 自动将 huggingface.co 替换为国内镜像 hf-mirror.com
    let model_url = model_url.replace("https://huggingface.co/", "https://hf-mirror.com/");

    let data_dir = config::get_data_dir(Some(&app))?;
    let models_dir = data_dir.join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("创建 models 目录失败: {}", e))?;

    let final_path = models_dir.join(format!("{}.gguf", model_id));
    let part_path = models_dir.join(format!("{}.gguf.part", model_id));

    // 如果最终文件已存在，直接返回完成
    if final_path.exists() {
        // 清理残留的 .part 文件
        let _ = std::fs::remove_file(&part_path);
        app.emit(
            "download-complete",
            serde_json::json!({ "model_id": &model_id }),
        )
        .ok();
        return Ok(());
    }

    // 检查是否有未完成的 .part 文件，获取已下载字节数
    let existing_size = if part_path.exists() {
        std::fs::metadata(&part_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    // 注册下载进度到 AppState，供页面切换后恢复百分比显示
    app.state::<AppState>().downloading_progress.lock().unwrap().insert(model_id.clone(), 0u8);

    // Drop guard: 函数退出时清理进度记录（无论成功还是失败）
    struct CleanupGuard {
        h: tauri::AppHandle,
        id: String,
    }
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            if let Ok(mut map) = self.h.state::<AppState>().downloading_progress.lock() {
                map.remove(&self.id);
            }
        }
    }
    let _guard = CleanupGuard { h: app.clone(), id: model_id.clone() };

    // 第一步：获取最终下载 URL（处理重定向）
    let resolve_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let resolve_resp = resolve_client
        .get(&model_url)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let status = resolve_resp.status();
    let final_url = if status.is_redirection() {
        resolve_resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| model_url.clone())
    } else if status.is_success() {
        model_url.clone()
    } else {
        return Err(format!("获取下载链接失败，HTTP 状态码: {}", status.as_u16()));
    };

    // 第二步：用最终 URL 发起下载（支持 Range 续传）
    let download_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;

    let mut req = download_client
        .get(&final_url)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");

    if existing_size > 0 {
        req = req.header("Range", format!("bytes={}-", existing_size));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    let status = response.status();

    if existing_size > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!("续传失败 (HTTP {}), 请重新下载", status.as_u16()));
    }

    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("下载失败，HTTP 状态码: {}", status.as_u16()));
    }

    let total_size = if existing_size > 0 {
        if let Some(content_range) = response.headers().get("content-range") {
            if let Ok(range_str) = content_range.to_str() {
                if let Some(total_str) = range_str.split('/').nth(1) {
                    total_str.trim().parse::<u64>().unwrap_or(0)
                } else {
                    0
                }
            } else {
                0
            }
        } else {
            0
        }
    } else {
        response.content_length().unwrap_or(0)
    };

    use tokio::io::AsyncWriteExt;
    let mut file = if existing_size > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part_path)
            .await
            .map_err(|e| format!("打开续传文件失败: {}", e))?
    } else {
        tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| format!("创建文件失败: {}", e))?
    };

    let mut downloaded: u64 = existing_size;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("下载数据读取失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        let progress = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(99.0) as u8
        } else {
            0
        };

        app.emit(
            "download-progress",
            serde_json::json!({
                "model_id": &model_id,
                "progress": progress,
                "downloaded": downloaded,
                "total": total_size,
            }),
        )
        .ok();

        // 同步更新 AppState 中的进度
        if let Ok(mut map) = app.state::<AppState>().downloading_progress.lock() {
            map.insert(model_id.clone(), progress);
        }
    }

    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    // 下载完成，将 .part 重命名为 .gguf
    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| format!("重命名文件失败: {}", e))?;

    app.emit(
        "download-complete",
        serde_json::json!({ "model_id": &model_id }),
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
) -> Result<(), String> {
    {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        if pid_lock.is_some() {
            return Err("已有模型在运行中，请先停止当前模型".to_string());
        }
    }

    let server_path = config::get_llama_server_path(Some(&app))?;
    let data_dir = config::get_data_dir(Some(&app))?;
    let model_path = data_dir.join("models").join(format!("{}.gguf", model_id));

    if !model_path.exists() {
        return Err(format!("模型文件不存在: {:?}", model_path));
    }

    let mut args: Vec<String> = vec![
        "-m".to_string(),
        model_path.to_string_lossy().to_string(),
    ];

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
    if let Some(r) = &params.reasoning {
        args.extend(["--reasoning".to_string(), r.clone()]);
    }

    let port = params.port.unwrap_or(8080);
    args.extend(["--port".to_string(), port.to_string()]);

    if let Some(host) = &params.host {
        args.extend(["--host".to_string(), host.clone()]);
    }

    args.push("--verbose".to_string());

    println!("[DEBUG] llama-server args: {:?}", args);

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
pub async fn stop_model(state: tauri::State<'_, AppState>) -> Result<(), String> {
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

    Ok(())
}

#[tauri::command]
pub async fn get_model_status(state: tauri::State<'_, AppState>) -> Result<ModelStatus, String> {
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
pub async fn get_downloading_models(state: tauri::State<'_, AppState>) -> Result<HashMap<String, u8>, String> {
    let map = state.downloading_progress.lock().map_err(|e| e.to_string())?;
    Ok(map.clone())
}
