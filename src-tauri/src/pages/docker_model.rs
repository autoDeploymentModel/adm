// 图片生成模型：docker 部署流程
//
// 与 llama-server 模型（model_list.rs）并列的一套命令：
//   1. 检查 Docker 环境（未安装则按平台自动下载 / 安装 Docker Desktop）
//   2. 拉取 model_list.json 里 `model_images` 指定的镜像（带进度）
//   3. 启动容器（宿主 64646 → 容器 8188，ComfyUI）
//   4. 「查看模型」由前端用系统浏览器打开 http://127.0.0.1:64646
//
// 事件约定（复用既有事件名，前端 model_list 视图已处理）：
//   docker-progress  { model_id, stage, progress, message }  长任务进度
//   model-started    { model_id, port }                      容器就绪
//   model-stopped    { model_id }                            容器停止
// 出错通过命令返回的 Err 传递给前端（friendlyError + showToast），不使用事件

use crate::app_state::AppState;
use crate::common::config;
use crate::common::utils::download::download_with_resume;
use crate::common::utils::platform::create_hidden_command;
use crate::common::*;
use crate::bail;
use crate::dbg_log;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;

/// 图片生成模型对外端口（宿主）：0.0.0.0:64646 → 容器 8188
pub const DOCKER_MODEL_PORT: u16 = 64646;
/// 容器内 ComfyUI 端口（与镜像 entrypoint 一致）
const CONTAINER_PORT: u16 = 8188;
/// Docker Desktop 下载页（手动安装指引）
const DOCKER_DESKTOP_HOME: &str = "https://www.docker.com/products/docker-desktop/";

// ===== 基础工具 =====

fn platform_str() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 当前平台 Docker Desktop 安装包地址（linux 无官方一键安装包）
fn download_url() -> Option<String> {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
    if cfg!(target_os = "windows") {
        Some(format!("https://desktop.docker.com/win/main/{}/Docker%20Desktop%20Installer.exe", arch))
    } else if cfg!(target_os = "macos") {
        Some(format!("https://desktop.docker.com/mac/main/{}/Docker.dmg", arch))
    } else {
        None
    }
}

/// docker CLI 常见安装位置（安装完 Docker Desktop 后当前进程 PATH 可能还没刷新）
fn cli_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            v.push(PathBuf::from(&pf).join("Docker").join("Docker").join("resources").join("bin").join("docker.exe"));
        }
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            // 单用户安装（install --user）与旧版路径
            v.push(PathBuf::from(&la).join("Programs").join("DockerDesktop").join("resources").join("bin").join("docker.exe"));
            v.push(PathBuf::from(&la).join("Docker").join("Docker").join("resources").join("bin").join("docker.exe"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/usr/local/bin/docker"));
        v.push(PathBuf::from("/opt/homebrew/bin/docker"));
        v.push(PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"));
    }
    #[cfg(target_os = "linux")]
    {
        v.push(PathBuf::from("/usr/bin/docker"));
        v.push(PathBuf::from("/usr/local/bin/docker"));
    }
    v
}

/// 解析可用的 docker CLI：先 PATH，再常见安装位置
pub fn docker_cli() -> Option<PathBuf> {
    if let Ok(out) = create_hidden_command("docker").arg("--version").output() {
        if out.status.success() {
            return Some(PathBuf::from("docker"));
        }
    }
    for c in cli_candidates() {
        if !c.exists() {
            continue;
        }
        if let Ok(out) = create_hidden_command(&c).arg("--version").output() {
            if out.status.success() {
                return Some(c);
            }
        }
    }
    None
}

/// Docker Desktop 主程序（用于自动启动引擎）
fn desktop_app() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut v: Vec<PathBuf> = Vec::new();
        if let Ok(pf) = std::env::var("ProgramFiles") {
            v.push(PathBuf::from(&pf).join("Docker").join("Docker").join("Docker Desktop.exe"));
        }
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(&la).join("Programs").join("DockerDesktop").join("Docker Desktop.exe"));
        }
        return v.into_iter().find(|p| p.exists());
    }
    #[cfg(target_os = "macos")]
    {
        let app = PathBuf::from("/Applications/Docker.app");
        return if app.exists() { Some(app) } else { None };
    }
    #[cfg(target_os = "linux")]
    {
        None
    }
}

fn launch_desktop(app_path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let _ = app_path;
        create_hidden_command("open").args(["-a", "Docker"]).spawn()?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        create_hidden_command(app_path).spawn()?;
        Ok(())
    }
}

fn docker_output(cli: &Path, args: &[&str]) -> Result<String, AppError> {
    let out = create_hidden_command(cli).args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        bail!("docker {} 失败: {}", args.first().copied().unwrap_or(""), msg);
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn docker_ok(cli: &Path, args: &[&str]) -> bool {
    create_hidden_command(cli)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 执行 docker 命令并逐行回调输出（stdout / stderr 合并），同时收集最近 60 行用于报错
fn run_streaming(cli: &Path, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<(ExitStatus, Vec<String>), AppError> {
    let mut child = create_hidden_command(cli)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<String>();

    let tx_out = tx.clone();
    let h_out = stdout.map(|s| {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(s).lines().map_while(Result::ok) {
                let _ = tx_out.send(line);
            }
        })
    });
    let tx_err = tx.clone();
    let h_err = stderr.map(|s| {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(s).lines().map_while(Result::ok) {
                let _ = tx_err.send(line);
            }
        })
    });
    drop(tx);

    let mut tail: Vec<String> = Vec::new();
    while let Ok(line) = rx.recv() {
        if tail.len() >= 60 {
            tail.remove(0);
        }
        tail.push(line.clone());
        on_line(&line);
    }
    if let Some(h) = h_out {
        let _ = h.join();
    }
    if let Some(h) = h_err {
        let _ = h.join();
    }
    let status = child.wait()?;
    Ok((status, tail))
}

fn human_size(bytes: u64, total: u64) -> String {
    fn one(b: u64) -> String {
        const GB: f64 = 1024.0 * 1024.0 * 1024.0;
        const MB: f64 = 1024.0 * 1024.0;
        let f = b as f64;
        if f >= GB {
            format!("{:.2}GB", f / GB)
        } else if f >= MB {
            format!("{:.0}MB", f / MB)
        } else {
            format!("{:.0}KB", f / 1024.0)
        }
    }
    if total > 0 {
        format!("{}/{}", one(bytes), one(total))
    } else {
        one(bytes)
    }
}

// ===== 任务进度：写 AppState（供 UI 重载后恢复）+ 推事件 =====

fn set_task(state: &AppState, model_id: &str, stage: &str, progress: u8, message: &str) {
    if let Ok(mut map) = state.docker_tasks.lock() {
        map.insert(
            model_id.to_string(),
            DockerTask { stage: stage.to_string(), progress, message: message.to_string() },
        );
    }
}

fn clear_task(state: &AppState, model_id: &str) {
    if let Ok(mut map) = state.docker_tasks.lock() {
        map.remove(model_id);
    }
}

fn emit_progress(app: &tauri::AppHandle, model_id: &str, stage: &str, progress: u8, message: &str) {
    app.emit(
        "docker-progress",
        serde_json::json!({
            "model_id": model_id,
            "stage": stage,
            "progress": progress,
            "message": message,
        }),
    )
    .ok();
}

fn set_progress(app: &tauri::AppHandle, state: &AppState, model_id: &str, stage: &str, progress: u8, message: &str) {
    set_task(state, model_id, stage, progress, message);
    emit_progress(app, model_id, stage, progress, message);
}

/// 清空 docker 模型运行状态
pub fn clear_running_docker(state: &AppState) {
    *state.running_kind.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.running_container.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.running_port.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 容器名：与 model_id 一一对应
fn container_name(model_id: &str) -> String {
    let mut s = String::from("adm-");
    for c in model_id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            s.push(c.to_ascii_lowercase());
        } else {
            s.push('-');
        }
    }
    s
}

fn container_state(cli: &Path, name: &str) -> Option<bool> {
    match docker_output(cli, &["inspect", "-f", "{{.State.Running}}", name]) {
        Ok(out) => Some(out.trim() == "true"),
        Err(_) => None,
    }
}

/// 容器是否在运行（供 get_model_status 使用）
pub fn container_running(name: &str) -> bool {
    match docker_cli() {
        Some(cli) => container_state(&cli, name) == Some(true),
        None => false,
    }
}

/// 停止容器（阻塞，退出清理与 stop 命令共用）；返回是否成功
pub fn stop_container_blocking(name: &str) -> bool {
    match docker_cli() {
        // -t 2：最多等 2 秒优雅退出，超时由 docker 自己 SIGKILL
        Some(cli) => docker_output(&cli, &["stop", "-t", "2", name]).is_ok(),
        None => false,
    }
}

/// 应用退出时清理：正在运行的图片生成容器需要停止（与 llama-server 一致，
/// 避免退出后仍占用内存/显存与 64646 端口）。幂等，可重复调用。
pub fn cleanup_on_exit(state: &AppState) {
    let kind = state.running_kind.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if kind.as_deref() != Some("docker") {
        return;
    }
    let container = state.running_container.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(name) = container {
        dbg_log!("[docker] 退出清理：停止容器 {}", name);
        let _ = stop_container_blocking(&name);
    }
    clear_running_docker(state);
}

fn has_nvidia_runtime(cli: &Path) -> bool {
    docker_output(cli, &["info", "--format", "{{json .Runtimes}}"])
        .map(|s| s.contains("\"nvidia\""))
        .unwrap_or(false)
}

// ===== Docker Desktop 下载 / 安装 =====

fn install_desktop(path: &Path) -> Result<(), AppError> {
    dbg_log!("[docker] install desktop: {:?}", path);
    #[cfg(target_os = "windows")]
    {
        // 先尝试单用户安装（不弹 UAC）；失败再退回全局安装（会弹系统授权窗口）
        let mut cmd = create_hidden_command(path);
        cmd.args(["install", "--quiet", "--accept-license", "--user"]);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                return Ok(());
            }
        }
        let mut cmd2 = create_hidden_command(path);
        cmd2.args(["install", "--quiet", "--accept-license"]);
        let out2 = cmd2.output()?;
        if out2.status.success() {
            return Ok(());
        }
        bail!(
            "Docker Desktop 安装失败（exit={}）：{}",
            out2.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out2.stderr).trim()
        );
    }
    #[cfg(target_os = "macos")]
    {
        let out = create_hidden_command("hdiutil")
            .args(["attach", "-nobrowse", "-quiet"])
            .arg(path)
            .output()?;
        if !out.status.success() {
            bail!("挂载 Docker.dmg 失败: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        let src = PathBuf::from("/Volumes/Docker/Docker.app");
        if !src.exists() {
            let _ = create_hidden_command("hdiutil").args(["detach", "/Volumes/Docker"]).output();
            bail!("Docker.dmg 中未找到 Docker.app");
        }
        let cp = create_hidden_command("cp")
            .args(["-Rf"])
            .arg(&src)
            .arg("/Applications/")
            .output()?;
        let _ = create_hidden_command("hdiutil").args(["detach", "/Volumes/Docker"]).output();
        if !cp.status.success() {
            bail!(
                "拷贝 Docker.app 到 /Applications 失败（需要管理员权限）: {}",
                String::from_utf8_lossy(&cp.stderr).trim()
            );
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = path;
        bail!("Linux 请手动安装 Docker Engine / Docker Desktop：{}", DOCKER_DESKTOP_HOME);
    }
}

/// 确保 docker 可用：未安装则下载并安装 Docker Desktop，返回 CLI 路径
async fn ensure_docker_installed(app: &tauri::AppHandle, state: &AppState, model_id: &str) -> Result<PathBuf, AppError> {
    if let Some(cli) = docker_cli() {
        return Ok(cli);
    }

    let url = download_url().ok_or_else(|| {
        AppError::msg(format!("当前平台不支持自动安装 Docker，请手动安装后重试：{}", DOCKER_DESKTOP_HOME))
    })?;

    let data_dir = config::get_data_dir(Some(app))?;
    let downloads = data_dir.join("downloads");
    std::fs::create_dir_all(&downloads)?;
    let (file_name, part_name) = if url.ends_with(".exe") {
        ("DockerDesktopInstaller.exe", "DockerDesktopInstaller.exe.part")
    } else {
        ("Docker.dmg", "Docker.dmg.part")
    };
    let final_path = downloads.join(file_name);
    let part_path = downloads.join(part_name);

    set_progress(app, state, model_id, "download-desktop", 0, "正在下载 Docker Desktop 安装包…");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))?;

    let app_cb = app.clone();
    let mid = model_id.to_string();
    download_with_resume(&client, &url, &final_path, &part_path, move |pct, downloaded, total| {
        emit_progress(
            &app_cb,
            &mid,
            "download-desktop",
            pct,
            &format!("正在下载 Docker Desktop… {}", human_size(downloaded, total)),
        );
    })
    .await?;

    set_progress(app, state, model_id, "install-desktop", 0, "正在安装 Docker Desktop（如弹出系统授权窗口请点击允许）…");
    let path_clone = final_path.clone();
    tauri::async_runtime::spawn_blocking(move || install_desktop(&path_clone))
        .await
        .map_err(|e| AppError::msg(format!("安装任务执行失败: {}", e)))??;

    // 安装完成后 CLI 可能还没出现在 PATH，轮询探测（安装器写盘有延迟）
    set_progress(app, state, model_id, "install-desktop", 90, "正在等待 docker 命令就绪…");
    let start = Instant::now();
    loop {
        if let Some(cli) = docker_cli() {
            return Ok(cli);
        }
        if start.elapsed().as_secs() > 180 {
            bail!("Docker Desktop 已安装但未找到 docker 命令，请重启本应用后重试（或手动确认安装完成）");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// 等待 docker 引擎就绪（必要时自动拉起 Docker Desktop）
fn wait_daemon(app: &tauri::AppHandle, state: &AppState, cli: &Path, model_id: &str, timeout_secs: u64) -> Result<(), AppError> {
    if docker_ok(cli, &["info", "--format", "{{.ServerVersion}}"]) {
        return Ok(());
    }
    set_progress(app, state, model_id, "start-daemon", 0, "正在启动 Docker 引擎…");
    if let Some(p) = desktop_app() {
        let _ = launch_desktop(&p);
    }
    let start = Instant::now();
    let mut last_secs = u64::MAX;
    loop {
        if docker_ok(cli, &["info", "--format", "{{.ServerVersion}}"]) {
            return Ok(());
        }
        let secs = start.elapsed().as_secs();
        if secs > timeout_secs {
            bail!("Docker 引擎启动超时：请手动打开 Docker Desktop，确认状态栏显示 Running 后重试");
        }
        if secs / 5 != last_secs / 5 {
            last_secs = secs;
            set_progress(app, state, model_id, "start-daemon", 0, &format!("正在等待 Docker 引擎启动…（{}s）", secs));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ===== 镜像 =====

/// 从 `docker manifest inspect --verbose` 解析各层压缩后大小（层 id 前 12 位 → 字节）
fn layer_sizes(cli: &Path, image: &str) -> HashMap<String, u64> {
    let mut map = HashMap::new();
    let text = match docker_output(cli, &["manifest", "inspect", "--verbose", image]) {
        Ok(t) => t,
        Err(_) => return map,
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return map,
    };
    let want_arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };

    let layers = if let Some(arr) = json.as_array() {
        // 多平台 index：挑当前平台
        arr.iter()
            .find(|it| {
                it.pointer("/Descriptor/platform/architecture").and_then(|a| a.as_str()) == Some(want_arch)
            })
            .or_else(|| arr.first())
            .and_then(|it| it.pointer("/SchemaV2Manifest/layers"))
            .and_then(|l| l.as_array())
    } else if let Some(manifests) = json.get("manifests").and_then(|m| m.as_array()) {
        manifests
            .iter()
            .find(|m| m.pointer("/platform/architecture").and_then(|a| a.as_str()) == Some(want_arch))
            .or_else(|| manifests.first())
            .and_then(|m| m.get("layers"))
            .and_then(|l| l.as_array())
    } else {
        json.get("layers").and_then(|l| l.as_array())
    };

    if let Some(layers) = layers {
        for l in layers {
            let digest = l.get("digest").and_then(|d| d.as_str()).unwrap_or("");
            let size = l.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
            if digest.is_empty() || size == 0 {
                continue;
            }
            let short: String = digest.trim_start_matches("sha256:").chars().take(12).collect();
            map.insert(short, size);
        }
    }
    map
}

/// `e2de96513ba9: Download complete` → (层 id, 状态)
fn split_layer_line(line: &str) -> Option<(String, String)> {
    let (id, rest) = line.split_once(':')?;
    let id = id.trim();
    if id.len() != 12 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some((id.to_string(), rest.trim().to_string()))
}

fn pull_image(app: &tauri::AppHandle, state: &AppState, cli: &Path, model_id: &str, image: &str) -> Result<(), AppError> {
    let sizes = layer_sizes(cli, image);
    let total: u64 = sizes.values().sum();
    dbg_log!("[docker] pull {} (layers={}, total={}B)", image, sizes.len(), total);

    let mut done: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut finished = false;
    let mut last_pct: i32 = -1;
    let mut last_emit = Instant::now() - Duration::from_secs(10);

    let (status, tail) = run_streaming(cli, &["pull", image], |line| {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if line.contains("Downloaded newer image") || line.contains("Image is up to date") {
            finished = true;
        }
        if let Some((id, rest)) = split_layer_line(line) {
            seen.insert(id.clone());
            if rest.starts_with("Pull complete") || rest.starts_with("Already exists") || rest.starts_with("Download complete") {
                done.insert(id);
            }
        }
        let pct: i32 = if finished {
            100
        } else if total > 0 {
            let d: u64 = done.iter().filter_map(|i| sizes.get(i).copied()).sum();
            (((d as f64) / (total as f64)) * 99.0).min(99.0) as i32
        } else if !seen.is_empty() {
            (((done.len() as f64) / (seen.len() as f64)) * 95.0) as i32
        } else {
            0
        };
        if pct != last_pct || last_emit.elapsed() > Duration::from_secs(1) {
            last_pct = pct;
            last_emit = Instant::now();
            let msg = format!("正在下载镜像…（{}% · {} 层）", pct, seen.len());
            set_task(state, model_id, "pull", pct as u8, &msg);
            emit_progress(app, model_id, "pull", pct as u8, &msg);
        }
    })?;

    if !status.success() {
        let joined = tail.join("\n");
        if joined.contains("unauthorized") || joined.contains("authentication required") || joined.contains("denied") {
            let registry = image.split('/').next().unwrap_or(image);
            bail!(
                "拉取镜像失败：镜像仓库需要登录。请先执行 `docker login {}`（或把该仓库设为公开）后重试",
                registry
            );
        }
        let last = tail.last().cloned().unwrap_or_default();
        bail!("拉取镜像失败：{}", last);
    }
    if !image_exists(cli, image) {
        bail!("镜像拉取命令已结束，但本地仍找不到该镜像，请重试");
    }
    Ok(())
}

fn image_exists(cli: &Path, image: &str) -> bool {
    docker_ok(cli, &["image", "inspect", image])
}

/// 等待 ComfyUI 就绪（容器内 8188 → 宿主 64646）
fn wait_http_ready(app: &tauri::AppHandle, state: &AppState, cli: &Path, name: &str, model_id: &str, timeout_secs: u64) {
    use std::io::{Read, Write};
    let start = Instant::now();
    let mut last_secs = u64::MAX;
    loop {
        // 容器已退出则直接放弃等待
        if container_state(cli, name) == Some(false) {
            set_progress(app, state, model_id, "start", 99, "容器已退出，请打开 Docker Desktop 查看日志");
            return;
        }
        let addr = format!("127.0.0.1:{}", DOCKER_MODEL_PORT);
        if let Ok(mut stream) = std::net::TcpStream::connect_timeout(
            &addr.parse().unwrap_or_else(|_| "127.0.0.1:64646".parse().unwrap()),
            Duration::from_secs(3),
        ) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let req = format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                DOCKER_MODEL_PORT
            );
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf) {
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    if head.contains(" 200") || head.contains(" 302") {
                        set_progress(app, state, model_id, "start", 100, "ComfyUI 已就绪");
                        return;
                    }
                }
            }
        }
        let secs = start.elapsed().as_secs();
        if secs > timeout_secs {
            set_progress(app, state, model_id, "start", 99, "ComfyUI 启动较慢，仍在后台启动中，可稍后点击「查看模型」");
            return;
        }
        if secs / 5 != last_secs / 5 {
            last_secs = secs;
            set_progress(app, state, model_id, "start", 95, &format!("正在等待 ComfyUI 就绪…（{}s）", secs));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ===== Tauri Commands =====

/// 检查 Docker 环境（是否安装 / 引擎是否运行 / 安装包下载地址）
#[tauri::command]
pub async fn check_docker_env() -> Result<DockerEnvStatus, AppError> {
    let cli = docker_cli();
    let installed = cli.is_some();
    let daemon_running = match &cli {
        Some(c) => docker_ok(c, &["info", "--format", "{{.ServerVersion}}"]),
        None => false,
    };
    let version = cli
        .as_ref()
        .and_then(|c| docker_output(c, &["version", "--format", "{{.Client.Version}}"]).ok())
        .map(|s| s.trim().to_string());
    Ok(DockerEnvStatus {
        installed,
        daemon_running,
        version,
        platform: platform_str().to_string(),
        download_url: download_url(),
    })
}

/// 查询本地是否已有该镜像
#[tauri::command]
pub async fn check_docker_image(image: String) -> Result<bool, AppError> {
    if image.trim().is_empty() {
        return Ok(false);
    }
    let cli = match docker_cli() {
        Some(c) => c,
        None => return Ok(false),
    };
    let image_clone = image.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(image_exists(&cli, &image_clone)))
        .await
        .map_err(|e| AppError::msg(format!("查询镜像失败: {}", e)))?
}

/// 进行中的 docker 任务（UI 重载后恢复进度显示）
#[tauri::command]
pub async fn get_docker_tasks(state: tauri::State<'_, AppState>) -> Result<HashMap<String, DockerTask>, AppError> {
    let map = state.docker_tasks.lock().map_err(|e| e.to_string())?;
    Ok(map.clone())
}

/// 启动时对账：查询该模型容器是否仍在运行（上次被强杀 / 崩溃时容器会残留），
/// 在运行则恢复后端运行状态，供 UI 显示「已启动」并允许关闭。
#[tauri::command]
pub async fn sync_docker_container(
    state: tauri::State<'_, AppState>,
    model_id: String,
) -> Result<bool, AppError> {
    let name = container_name(&model_id);
    let name_probe = name.clone();
    let running = tauri::async_runtime::spawn_blocking(move || container_running(&name_probe))
        .await
        .map_err(|e| AppError::msg(format!("容器状态查询失败: {}", e)))?;

    if running {
        {
            *state.running_kind.lock().unwrap_or_else(|e| e.into_inner()) = Some("docker".into());
        }
        {
            *state.running_container.lock().unwrap_or_else(|e| e.into_inner()) = Some(name);
        }
        {
            *state.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(model_id);
        }
        {
            *state.running_port.lock().unwrap_or_else(|e| e.into_inner()) = Some(DOCKER_MODEL_PORT);
        }
    } else {
        // 容器不存在/已停止：清掉指向它的残留记录
        let recorded = state.running_container.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if recorded.as_deref() == Some(name.as_str()) {
            clear_running_docker(&state);
        }
    }
    Ok(running)
}

/// 下载/安装 Docker（如需要）+ 拉取镜像
#[tauri::command]
pub async fn setup_docker_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    image: String,
) -> Result<(), AppError> {
    if image.trim().is_empty() {
        bail!("该模型未配置镜像地址");
    }
    let state_ref: &AppState = &state;
    set_progress(&app, state_ref, &model_id, "check", 0, "正在检查 Docker 环境…");

    // 1) 环境（必要时下载并安装 Docker Desktop）
    let cli = ensure_docker_installed(&app, state_ref, &model_id).await?;

    // 2) 引擎
    let app_b = app.clone();
    let mid = model_id.clone();
    let cli_b = cli.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_b.state::<AppState>();
        wait_daemon(&app_b, &state, &cli_b, &mid, 180)
    })
    .await
    .map_err(|e| AppError::msg(format!("启动 Docker 引擎失败: {}", e)))??;

    // 3) 镜像
    if image_exists(&cli, &image) {
        set_progress(&app, state_ref, &model_id, "pull", 100, "镜像已存在，跳过下载");
    } else {
        let app_c = app.clone();
        let mid = model_id.clone();
        let img = image.clone();
        let cli_c = cli.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_c.state::<AppState>();
            pull_image(&app_c, &state, &cli_c, &mid, &img)
        })
        .await
        .map_err(|e| AppError::msg(format!("拉取镜像任务失败: {}", e)))??;
    }

    clear_task(state_ref, &model_id);
    emit_progress(&app, &model_id, "done", 100, "镜像已就绪");
    Ok(())
}

/// 启动图片生成容器（宿主 64646 → 容器 8188）
#[tauri::command]
pub async fn start_docker_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    image: String,
) -> Result<(), AppError> {
    {
        let pid = state.running_process.lock().map_err(|e| e.to_string())?;
        if pid.is_some() {
            bail!("已有模型在运行中，请先关闭当前模型");
        }
    }
    {
        let kind = state.running_kind.lock().map_err(|e| e.to_string())?.clone();
        let running_id = state.running_model_id.lock().map_err(|e| e.to_string())?.clone();
        if kind.as_deref() == Some("docker") && running_id.as_deref() != Some(model_id.as_str()) {
            bail!("已有图片生成模型在运行中，请先关闭当前模型");
        }
    }

    let name = container_name(&model_id);
    let app_a = app.clone();
    let mid = model_id.clone();
    let img = image.clone();
    let name_a = name.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let state = app_a.state::<AppState>();
        let cli = docker_cli().ok_or_else(|| {
            AppError::msg(format!("未检测到 Docker，请先点击「下载」自动安装（或手动安装：{}）", DOCKER_DESKTOP_HOME))
        })?;

        wait_daemon(&app_a, &state, &cli, &mid, 180)?;

        if !image_exists(&cli, &img) {
            bail!("镜像尚未下载完成，请先点击「下载」");
        }

        // 容器可能已存在：仅当镜像一致时复用（换过 tag / 重新拉过镜像时按新镜像重建，
        // 否则 docker start 会继续跑旧镜像）
        let state_now = container_state(&cli, &name_a);
        let container_present = state_now.is_some();
        let container_running_now = state_now == Some(true);
        let container_image = if container_present {
            docker_output(&cli, &["inspect", "-f", "{{.Config.Image}}", &name_a])
                .ok()
                .map(|s| s.trim().to_string())
        } else {
            None
        };
        let image_changed = container_image.as_deref().map(|s| s != img.as_str()).unwrap_or(false);

        if container_running_now && !image_changed {
            // 已在运行且镜像一致：直接复用
            set_progress(&app_a, &state, &mid, "start", 60, "容器已在运行");
        } else if container_present && !image_changed {
            set_progress(&app_a, &state, &mid, "start", 50, "正在启动容器…");
            docker_output(&cli, &["start", &name_a])
                .map_err(|e| AppError::msg(format!("启动容器失败: {}", e)))?;
        } else {
            if container_present {
                set_progress(&app_a, &state, &mid, "start", 20, "镜像已更新，正在重建容器…");
                let _ = docker_output(&cli, &["rm", "-f", &name_a]);
            } else {
                set_progress(&app_a, &state, &mid, "start", 30, "正在创建并启动容器…");
            }
            let data_dir = config::get_data_dir(Some(&app_a))?;
            let base = data_dir.join("comfyui");
            let mut args: Vec<String> = vec![
                "run".into(),
                "-d".into(),
                "--name".into(),
                name_a.clone(),
                "-p".into(),
                format!("{}:{}", DOCKER_MODEL_PORT, CONTAINER_PORT),
                "--restart".into(),
                "unless-stopped".into(),
            ];
            if has_nvidia_runtime(&cli) {
                args.push("--gpus".into());
                args.push("all".into());
            }
            // 生成结果 / 输入 / 用户配置持久化到应用数据目录
            for (host, guest) in [
                ("output", "/opt/ComfyUI/output"),
                ("input", "/opt/ComfyUI/input"),
                ("user", "/opt/ComfyUI/user"),
            ] {
                let dir = base.join(host);
                std::fs::create_dir_all(&dir)?;
                args.push("-v".into());
                args.push(format!("{}:{}", dir.to_string_lossy(), guest));
            }
            args.push(img.clone());
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            docker_output(&cli, &refs).map_err(|e| AppError::msg(format!("启动容器失败: {}", e)))?;
        }

        wait_http_ready(&app_a, &state, &cli, &name_a, &mid, 300);

        // 等待期间容器若退出（显存/内存不足、镜像问题等），不能标记为已启动
        if container_state(&cli, &name_a) != Some(true) {
            clear_task(&state, &mid);
            bail!("容器已退出，模型启动失败：请确认显存/内存是否充足，或打开 Docker Desktop 查看该容器日志");
        }

        {
            *state.running_kind.lock().unwrap_or_else(|e| e.into_inner()) = Some("docker".into());
            *state.running_container.lock().unwrap_or_else(|e| e.into_inner()) = Some(name_a.clone());
            *state.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(mid.clone());
            *state.running_port.lock().unwrap_or_else(|e| e.into_inner()) = Some(DOCKER_MODEL_PORT);
        }
        clear_task(&state, &mid);
        app_a
            .emit("model-started", serde_json::json!({ "model_id": &mid, "port": DOCKER_MODEL_PORT }))
            .ok();
        Ok(())
    })
    .await
    .map_err(|e| AppError::msg(format!("启动任务执行失败: {}", e)))?
}

/// 停止图片生成容器
#[tauri::command]
pub async fn stop_docker_model(app: tauri::AppHandle, model_id: String) -> Result<(), AppError> {
    let name = container_name(&model_id);
    let app_a = app.clone();
    let mid = model_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = stop_container_blocking(&name);
        let state = app_a.state::<AppState>();
        clear_running_docker(&state);
        app_a
            .emit("model-stopped", serde_json::json!({ "model_id": &mid }))
            .ok();
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| AppError::msg(format!("停止任务执行失败: {}", e)))??;
    Ok(())
}

/// 删除本地镜像（释放磁盘空间）
#[tauri::command]
pub async fn delete_docker_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    image: String,
) -> Result<(), AppError> {
    {
        let kind = state.running_kind.lock().map_err(|e| e.to_string())?.clone();
        let running_id = state.running_model_id.lock().map_err(|e| e.to_string())?.clone();
        if kind.as_deref() == Some("docker") && running_id.as_deref() == Some(model_id.as_str()) {
            bail!("模型正在运行中，请先关闭后再删除镜像");
        }
    }
    let img = image.clone();
    let name = container_name(&model_id);
    tauri::async_runtime::spawn_blocking(move || {
        let cli = docker_cli().ok_or_else(|| AppError::msg("未检测到 Docker"))?;
        // 先删掉引用该镜像的容器，否则 rmi 会因容器占用而失败。
        // 用 inspect 是否成功判断“容器存在”（含已停止），避免把引擎报错误当“不存在”
        if docker_ok(&cli, &["inspect", &name]) {
            let _ = docker_output(&cli, &["rm", "-f", &name]);
        }
        docker_output(&cli, &["rmi", "-f", &img]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("删除镜像任务失败: {}", e)))??;
    let _ = app;
    Ok(())
}
