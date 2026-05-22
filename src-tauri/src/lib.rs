use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use sysinfo::System;
use tauri::Emitter;
use tauri::Manager;

// Windows 上隐藏子进程控制台窗口的辅助函数
#[cfg(target_os = "windows")]
fn create_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(target_os = "windows"))]
fn create_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    std::process::Command::new(program)
}

struct AppState {
    running_process: Mutex<Option<u32>>,
    running_model_id: Mutex<Option<String>>,
    running_port: Mutex<Option<u16>>,
    sys: Mutex<System>,
}

#[derive(Serialize, Clone)]
struct SystemInfo {
    total_ram: u64,
    used_ram: u64,
    total_vram: u64,
    used_vram: u64,
    has_gpu: bool,
    cpu_usage: f32,
    cpu_physical_cores: usize,
    cpu_logical_cores: usize,
}

#[derive(Serialize, Clone)]
struct ModelStatus {
    running: bool,
    model_id: Option<String>,
    pid: Option<u32>,
    port: Option<u16>,
}

#[derive(Serialize, Deserialize, Clone)]
struct LaunchParams {
    ctx_size: Option<i32>,
    n_predict: Option<i32>,
    batch_size: Option<i32>,
    ubatch_size: Option<i32>,
    n_gpu_layers: Option<String>,
    threads: Option<i32>,
    threads_batch: Option<i32>,
    flash_attn: Option<String>,
    cache_type_k: Option<String>,
    cache_type_v: Option<String>,
    mlock: Option<bool>,
    mmap: Option<bool>,
    temperature: Option<f64>,
    top_k: Option<i32>,
    top_p: Option<f64>,
    min_p: Option<f64>,
    repeat_penalty: Option<f64>,
    port: Option<u16>,
    host: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct RemoteModel {
    model_id: String,
    model_url: String,
    model_size: String,
    need_ram: String,
    #[serde(default)]
    support_tools: bool,
    #[serde(default)]
    support_reasoning: bool,
    #[serde(default)]
    support_images: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    launch_params: LaunchParams,
}

// ===== 自动更新相关结构 =====

#[derive(Serialize, Deserialize, Clone)]
struct PlatformUpdate {
    #[serde(rename = "appUrl")]
    app_url: String,
    content: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct UpdateInfo {
    version: String,
    windows: Option<PlatformUpdate>,
    #[serde(rename = "mac")]
    mac_os: Option<PlatformUpdate>,
}

#[derive(Serialize, Clone)]
struct UpdateCheckResult {
    has_update: bool,
    remote_version: String,
    current_version: String,
    download_url: Option<String>,
    changelog_url: Option<String>,
}

// ==========================

impl Default for LaunchParams {
    fn default() -> Self {
        Self {
            ctx_size: Some(4096),
            n_predict: Some(-1),
            batch_size: Some(2048),
            ubatch_size: Some(512),
            n_gpu_layers: Some("auto".to_string()),
            threads: None,
            threads_batch: None,
            flash_attn: Some("auto".to_string()),
            cache_type_k: Some("f16".to_string()),
            cache_type_v: Some("f16".to_string()),
            mlock: Some(false),
            mmap: Some(true),
            temperature: Some(0.8),
            top_k: Some(40),
            top_p: Some(0.95),
            min_p: Some(0.05),
            repeat_penalty: Some(1.0),
            port: Some(8080),
            host: Some("127.0.0.1".to_string()),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_params: LaunchParams::default(),
        }
    }
}

fn get_resource_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;
    Ok(resource_dir)
}

fn get_exe_dir() -> Result<std::path::PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("无法获取可执行文件目录".to_string())
        .map(|p| p.to_path_buf())
}

fn get_base_dir(app: Option<&tauri::AppHandle>) -> Result<std::path::PathBuf, String> {
    // 1. 首先尝试从资源目录查找（发布模式）
    if let Some(app_handle) = app {
        if let Ok(resource_dir) = get_resource_dir(app_handle) {
            let test_path = resource_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(resource_dir);
            }
        }
    }
    
    // 2. 尝试从当前工作目录查找（开发模式）
    if let Ok(current_dir) = std::env::current_dir() {
        // 检查是否是 src-tauri 目录或其子目录
        let mut test_dir = current_dir.clone();
        loop {
            let test_path = test_dir.join("llamacpp");
            if test_path.exists() {
                return Ok(test_dir);
            }
            // 向上查找直到根目录
            if !test_dir.pop() {
                break;
            }
        }
    }
    
    // 3. 回退到可执行文件目录
    get_exe_dir()
}

fn get_llama_server_path(app: Option<&tauri::AppHandle>) -> Result<std::path::PathBuf, String> {
    let base_dir = get_base_dir(app)?;

    #[cfg(target_os = "windows")]
    let path = base_dir.join("llamacpp").join("windows").join("llama-server.exe");

    #[cfg(target_os = "linux")]
    let path = base_dir.join("llamacpp").join("linux").join("llama-server");

    #[cfg(target_os = "macos")]
    let path = base_dir.join("llamacpp").join("mac").join("llama-server");

    if path.exists() {
        Ok(path)
    } else {
        Err(format!("未找到 llama-server: {:?}", path))
    }
}

fn get_gpu_info() -> (u64, u64, bool) {
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
            }
        }
    }

    (total_vram, used_vram, has_gpu)
}

#[tauri::command]
async fn get_system_info(state: tauri::State<'_, AppState>) -> Result<SystemInfo, String> {
    let mut sys = state.sys.lock().map_err(|e| format!("锁获取失败: {}", e))?;
    sys.refresh_all();

    let total_ram = sys.total_memory();
    let used_ram = sys.used_memory();
    let cpu_usage = sys.global_cpu_usage();
    let cpu_physical_cores = sys.physical_core_count().unwrap_or(0);
    let cpu_logical_cores = sys.cpus().len();

    let (total_vram, used_vram, has_gpu) = get_gpu_info();

    Ok(SystemInfo {
        total_ram,
        used_ram,
        total_vram,
        used_vram,
        has_gpu,
        cpu_usage,
        cpu_physical_cores,
        cpu_logical_cores,
    })
}

#[tauri::command]
async fn scan_local_models(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let exe_dir = get_exe_dir()?;
    let models_dir = exe_dir.join("models");

    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| format!("创建 models 目录失败: {}", e))?;
        return Ok(Vec::new());
    }

    let mut model_ids = Vec::new();
    let entries = std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
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
    }

    Ok(model_ids)
}

#[derive(Serialize)]
struct PartFileProgress {
    model_id: String,
    existing_size: u64,
}

#[tauri::command]
async fn scan_part_files(_app: tauri::AppHandle) -> Result<Vec<PartFileProgress>, String> {
    let exe_dir = get_exe_dir()?;
    let models_dir = exe_dir.join("models");

    if !models_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let entries = std::fs::read_dir(&models_dir).map_err(|e| format!("读取 models 目录失败: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "part" {
                        if let Some(stem) = path.file_stem() {
                            // stem 可能是 model_id.gguf → 取 .gguf 前面的部分
                            let stem_str = stem.to_string_lossy().to_string();
                            let model_id = stem_str.trim_end_matches(".gguf").to_string();
                            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                            result.push(PartFileProgress { model_id, existing_size: size });
                        }
                    }
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
async fn fetch_model_list() -> Result<Vec<RemoteModel>, String> {
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
async fn download_model(
    app: tauri::AppHandle,
    model_id: String,
    model_url: String,
) -> Result<(), String> {
    // 自动将 huggingface.co 替换为国内镜像 hf-mirror.com
    let model_url = model_url.replace("https://huggingface.co/", "https://hf-mirror.com/");

    let exe_dir = get_exe_dir()?;
    let models_dir = exe_dir.join("models");
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

    // ---------- 第一步：获取最终下载 URL（处理重定向） ----------
    // hf-mirror.com 会 302 重定向到 S3 签名 URL，跨域重定向会丢失 Range 头
    // 所以先手动获取最终 URL，再用最终 URL 直接下载

    // 创建不跟随重定向的客户端，用于获取最终 URL
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
        // 从 Location 头获取重定向后的真实 S3 签名 URL
        resolve_resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| model_url.clone())
    } else if status.is_success() {
        // 没有重定向，直接使用原始 URL
        model_url.clone()
    } else {
        return Err(format!("获取下载链接失败，HTTP 状态码: {}", status.as_u16()));
    };

    // ---------- 第二步：用最终 URL 发起下载（支持 Range 续传） ----------
    let download_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;

    let mut req = download_client
        .get(&final_url)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");

    // 如果有已下载的部分，添加 Range 请求头实现断点续传
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={}-", existing_size));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    let status = response.status();

    // 续传时服务器应返回 206 Partial Content；全新下载返回 200
    if existing_size > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        // 服务器不支持断点续传，删除 .part 从头下载
        let _ = std::fs::remove_file(&part_path);
        // 清空已下载记录，下次从头开始
        return Err(format!("续传失败 (HTTP {}), 请重新下载", status.as_u16()));
    }

    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("下载失败，HTTP 状态码: {}", status.as_u16()));
    }

    // 获取总大小：续传时从 Content-Range 解析，否则从 Content-Length 获取
    let total_size = if existing_size > 0 {
        if let Some(content_range) = response.headers().get("content-range") {
            if let Ok(range_str) = content_range.to_str() {
                // Content-Range 格式: bytes {start}-{end}/{total}
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

    // 打开 .part 文件：续传时追加，否则新建
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
async fn start_model(
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

    let server_path = get_llama_server_path(Some(&app))?;
    let exe_dir = get_exe_dir()?;
    let model_path = exe_dir.join("models").join(format!("{}.gguf", model_id));

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

    let port = params.port.unwrap_or(8080);
    args.extend(["--port".to_string(), port.to_string()]);

    if let Some(host) = &params.host {
        args.extend(["--host".to_string(), host.clone()]);
    }

    let mut child = create_hidden_command(&server_path)
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

    // 立即发送启动成功事件，让前端更新按钮状态
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
            for line in reader.lines() {
                if let Ok(line) = line {
                    app_clone
                        .emit(
                            "model-log",
                            serde_json::json!({
                                "model_id": &model_id_clone,
                                "line": line,
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
async fn stop_model(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let pid = {
        let pid_lock = state.running_process.lock().map_err(|e| e.to_string())?;
        pid_lock.ok_or("没有正在运行的模型")?
    };

    #[cfg(target_os = "windows")]
    {
        create_hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .spawn()
            .map_err(|e| format!("停止进程失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        create_hidden_command("kill")
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
async fn get_model_status(state: tauri::State<'_, AppState>) -> Result<ModelStatus, String> {
    let pid = state
        .running_process
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let model_id = state
        .running_model_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let port = state.running_port.lock().map_err(|e| e.to_string())?.clone();

    let running = if let Some(pid) = pid {
        let mut sys = System::new();
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
async fn save_settings(settings: Settings) -> Result<(), String> {
    let exe_dir = get_exe_dir()?;
    let config_path = exe_dir.join("config.json");

    let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, json).map_err(|e| format!("写入配置文件失败: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn load_settings() -> Result<Settings, String> {
    let exe_dir = get_exe_dir()?;
    let config_path = exe_dir.join("config.json");

    if !config_path.exists() {
        return Ok(Settings::default());
    }

    let json = std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let settings: Settings = serde_json::from_str(&json).map_err(|e| format!("解析配置文件失败: {}", e))?;

    Ok(settings)
}

#[tauri::command]
async fn get_llamacpp_version(app: tauri::AppHandle) -> Result<String, String> {
    let server_path = get_llama_server_path(Some(&app))?;

    let output = create_hidden_command(&server_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("执行 llama-server --version 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let version_info = if stdout.is_empty() {
        stderr.to_string()
    } else {
        stdout.to_string()
    };

    Ok(version_info.trim().to_string())
}

// ===== 版本比较辅助函数 =====

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

// ===== 自动更新命令 =====

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());

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
        return Err(format!("服务器返回错误状态码: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应文本失败: {}", e))?;

    let update_info: UpdateInfo = serde_json::from_str(&text)
        .map_err(|e| format!("解析更新信息失败: {}", e))?;

    let has_update = compare_versions(&current_version, &update_info.version) == std::cmp::Ordering::Less;

    // 根据当前平台获取下载链接
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

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        download_url = None;
        changelog_url = None;
    }

    Ok(UpdateCheckResult {
        has_update,
        remote_version: update_info.version,
        current_version,
        download_url,
        changelog_url,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_hwinfo::init())
        .manage(AppState {
            running_process: Mutex::new(None),
            running_model_id: Mutex::new(None),
            running_port: Mutex::new(None),
            sys: Mutex::new(System::new_all()),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let pid = state.running_process.lock().ok().and_then(|l| *l);
                if let Some(pid) = pid {
                    #[cfg(target_os = "windows")]
                    {
                        let pid_str: String = pid.to_string();
                        let _ = create_hidden_command("taskkill")
                            .args(["/PID", &pid_str, "/F"])
                            .spawn();
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        let _ = create_hidden_command("kill")
                            .args(["-9", &pid.to_string()])
                            .spawn();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            scan_local_models,
            scan_part_files,
            fetch_model_list,
            download_model,
            start_model,
            stop_model,
            get_model_status,
            save_settings,
            load_settings,
            get_llamacpp_version,
            check_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}