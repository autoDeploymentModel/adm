// agent.html 对应逻辑（Agent 终端：本地 admAgent 工具检测 / 下载 / 内嵌终端）

use crate::app_state::{AppState, AgentSession};
use crate::common::config;
use crate::common::types::Settings;
use crate::common::types::AdmAgentUpdateCheck;
use crate::common::utils::platform;
use crate::common::error::AppError;
use crate::bail;
use crate::pages::index::fetch_update_info;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

// 读取配置文件中的 agent 工作目录（默认空）
fn load_agent_workdir(app: &tauri::AppHandle) -> String {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let config_path = data_dir.join("config.json");
    if let Ok(json) = std::fs::read_to_string(&config_path) {
        if let Ok(settings) = serde_json::from_str::<Settings>(&json) {
            return settings.agent_workdir;
        }
    }
    String::new()
}

// 原子写入工作目录到配置文件
fn save_agent_workdir(app: &tauri::AppHandle, workdir: &str) -> Result<(), AppError> {
    let data_dir = config::get_data_dir(Some(app))?;
    let config_path = data_dir.join("config.json");

    let mut settings = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str::<Settings>(&json)
            .map_err(|e| format!("解析配置文件失败: {}", e))?
    } else {
        Settings::default()
    };

    settings.agent_workdir = workdir.to_string();

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    let temp_path = config_path.with_extension("tmp");
    std::fs::write(&temp_path, json).map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    std::fs::rename(&temp_path, &config_path)
        .map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

// ===== 平台相关路径与下载地址 =====

/// admAgent 默认存放目录：
/// - Windows：软件所在根目录（可执行文件所在目录）
/// - macOS：应用用户目录（app_data_dir，如 ~/Library/Application Support/com.adm.admapp）
#[allow(unused_variables)]
fn adm_agent_target_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "windows")]
    {
        config::get_exe_dir()
    }
    #[cfg(target_os = "macos")]
    {
        config::get_data_dir(Some(app))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        bail!("不支持的操作系统，当前仅支持 Windows / macOS")
    }
}

/// admAgent 文件名
fn adm_agent_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "admAgent.exe"
    } else {
        "admAgent"
    }
}

/// 从远程 admAgentVersion 字段（如 "v0.1.0-ec0848"）提取主版本号（如 "0.1.0"）。
fn extract_major_version(remote_ver: &str) -> String {
    let v = remote_ver.trim().trim_start_matches('v').trim();
    let mut parts = vec![];
    for ch in v.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            parts.push(ch);
        } else {
            break;
        }
    }
    let raw: String = parts.iter().collect();
    // 保证至少 x.y.z 三段；不足则补 .0
    let mut segs: Vec<&str> = raw.split('.').collect();
    while segs.len() < 3 {
        segs.push("0");
    }
    segs.truncate(3);
    // 过滤空段
    let filtered: Vec<&str> = segs.into_iter().filter(|s| !s.is_empty()).collect();
    if filtered.is_empty() {
        "0.0.0".to_string()
    } else {
        filtered.join(".")
    }
}

/// admAgent 下载地址（根据平台 + 远程版本动态构造）
/// - Windows：admAgent_{version}_Windows_x86_64.zip
/// - macOS(arm64)：admAgent_{version}_Darwin_arm64.tar.gz
/// - Linux：返回错误（当前未提供 Linux 版本）
fn adm_agent_download_url(remote_ver: &str) -> Result<String, AppError> {
    let ver = extract_major_version(remote_ver);
    #[cfg(target_os = "windows")]
    {
        Ok(format!("https://adm.tuduoduo.top/agent/admAgent_{}_Windows_x86_64.zip", ver))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(format!("https://adm.tuduoduo.top/agent/admAgent_{}_Darwin_arm64.tar.gz", ver))
    }
    #[cfg(target_os = "linux")]
    {
        bail!("当前未提供 Linux 版本的 admAgent，敬请期待")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        bail!("不支持的操作系统，当前仅支持 Windows / macOS (ARM)")
    }
}

/// 压缩包文件名
fn adm_agent_archive_name(remote_ver: &str) -> Result<String, AppError> {
    let ver = extract_major_version(remote_ver);
    #[cfg(target_os = "windows")]
    {
        Ok(format!("admAgent_{}_Windows_x86_64.zip", ver))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(format!("admAgent_{}_Darwin_arm64.tar.gz", ver))
    }
    #[cfg(target_os = "linux")]
    {
        bail!("当前未提供 Linux 版本的 admAgent，敬请期待")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        bail!("不支持的操作系统，当前仅支持 Windows / macOS (ARM)")
    }
}

fn adm_agent_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(adm_agent_target_dir(app)?.join(adm_agent_file_name()))
}

// ===== admAgent.json 配置（agent 启动前生成 / 更新）=====

/// 默认上下文大小（配置文件未显式配置 ctx_size 时使用，与示例一致）
const DEFAULT_CONTEXT_WINDOW: u32 = 128000;

/// 默认端口（配置文件未显式配置 port 时使用）
const DEFAULT_PORT: u16 = 1010;

/// admAgent.json 的存放目录：`$HOME/.config/admAgent`
/// Windows 下 $HOME 即 C:\Users\{username}，最终路径为 C:\Users\{username}\.config\admAgent
fn adm_agent_config_dir() -> Result<PathBuf, AppError> {
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(p) = std::env::var("HOME") {
        PathBuf::from(p)
    } else {
        return Err(AppError::msg("无法确定用户主目录，无法创建 admAgent 配置目录"));
    };
    Ok(home.join(".config").join("admAgent"))
}

/// 从 ADM 配置文件（config.json）读取上下文大小 ctx_size。
/// 读取失败或字段缺失时返回 None，由调用方决定是否回退到默认值。
fn load_ctx_size(app: &tauri::AppHandle) -> Option<i32> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.ctx_size
}

/// 从 ADM 配置文件（config.json）读取端口 port。
/// 读取失败或字段缺失时返回 None，由调用方决定是否回退到默认值。
fn load_port(app: &tauri::AppHandle) -> Option<u16> {
    let data_dir = config::get_data_dir(Some(app)).ok()?;
    let config_path = data_dir.join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let settings: Settings = serde_json::from_str(&json).ok()?;
    settings.launch_params.port
}

/// 根据上下文大小与端口构造完整的 admAgent.json 配置结构体。
/// default_max_tokens 取 context_window 的 30%（四舍五入为整数）。
fn build_adm_agent_config(context_window: u32, port: u16) -> serde_json::Value {
    let default_max_tokens = (context_window as f64 * 0.3).round() as u32;
    serde_json::json!({
        "providers": {
            "local": {
                "type": "openai-compat",
                "name": "Local",
                "base_url": format!("http://127.0.0.1:{}/v1", port),
                "models": [
                    {
                        "id": "localModel",
                        "name": "Local Model",
                        "context_window": context_window,
                        "default_max_tokens": default_max_tokens
                    }
                ]
            }
        },
        "models": {
            "large": { "provider": "local", "model": "localModel" },
            "small": { "provider": "local", "model": "localModel" }
        }
    })
}

/// 确保 admAgent.json 存在且 context_window / default_max_tokens / base_url 与当前配置一致。
///
/// - 目录不存在则创建。
/// - 文件不存在：写入完整的默认结构（context_window、port 来自配置，default_max_tokens = 30%）。
/// - 文件已存在：原地更新 providers.local.models[0] 的 context_window 与 default_max_tokens，
///   以及 providers.local.base_url 中的端口，尽量保留文件中其它字段；
///   若结构异常无法原地更新，则回退写入完整默认结构。
fn ensure_adm_agent_config(app: &tauri::AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx_size(app)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW as i32) as u32;

    let port = load_port(app).unwrap_or(DEFAULT_PORT);

    let dir = adm_agent_config_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 admAgent 配置目录失败: {}", e))?;
    let path = dir.join("admAgent.json");

    // 文件已存在：尝试原地更新 context_window 与 default_max_tokens
    if path.exists() {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&s) {
                let default_max_tokens = (ctx as f64 * 0.3).round() as u32;
                let mut updated = false;
                if let Some(models) = v
                    .get_mut("providers")
                    .and_then(|p| p.get_mut("local"))
                    .and_then(|l| l.get_mut("models"))
                    .and_then(|m| m.as_array_mut())
                {
                    if let Some(first) = models.get_mut(0) {
                        first["context_window"] = serde_json::json!(ctx);
                        first["default_max_tokens"] = serde_json::json!(default_max_tokens);
                        updated = true;
                    }
                    // 同步更新 base_url 中的端口
                    if let Some(base_url) = v
                        .get_mut("providers")
                        .and_then(|p| p.get_mut("local"))
                        .and_then(|l| l.get_mut("base_url"))
                    {
                        *base_url = serde_json::json!(format!("http://127.0.0.1:{}/v1", port));
                        updated = true;
                    }
                }
                if updated {
                    write_json_atomic(&path, &v)?;
                    return Ok(());
                }
            }
        }
    }

    // 文件不存在，或结构异常无法原地更新：写入完整默认结构
    let config = build_adm_agent_config(ctx, port);
    write_json_atomic(&path, &config)
}

/// 原子写入 JSON：先写临时文件再 rename，避免写入中途崩溃产生半截文件。
fn write_json_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 admAgent 配置失败: {}", e))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &json)
        .map_err(|e| format!("写入临时配置文件失败: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("重命名配置文件失败: {}", e))?;
    Ok(())
}

/// 点击 Agent 按钮时的「更早时机」调用：仅生成 / 更新 admAgent.json 配置，
/// 不依赖模型是否已启动或 admAgent 是否已下载。供前端在 goAgent() 阶段提前调用，
/// 早于真正启动终端（start_agent_terminal 内部也会再调用一次以保证最终一致）。
#[tauri::command]
pub async fn prepare_adm_agent_config(app: tauri::AppHandle) -> Result<(), AppError> {
    ensure_adm_agent_config(&app)
}

// ===== 添加云端模型 Provider =====

/// 把一个云端模型名称转成 admAgent.json providers 下的 JSON key（仅保留 ASCII 字母数字，转小写）。
/// 例如 "Xiaomi MiMo" -> "xiaomimimo"。空名称回退为 "cloud"。
fn slugify_provider_key(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect();
    if s.is_empty() {
        s = "cloud".to_string();
    }
    s
}

/// 把一个云端模型名称转成 model id：转小写，空格/下划线/连字符替换为 '-'，
/// 保留点号（'.'）以与名称保持一致（例如 "MiMo v2.5" -> "mimo-v2.5"），
/// 去掉其它标点，去重首尾连字符。空名称回退为 "model"。
fn slugify_model_id(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if c.is_whitespace() || c == '-' || c == '_' {
            if !out.is_empty() && !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        // 其它标点（如中文、括号等）直接忽略
    }
    while out.ends_with('-') || out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        out = "model".to_string();
    }
    out
}

/// 前端提交的新增云端模型参数
#[derive(Deserialize)]
pub struct CloudProviderInput {
    /// 模型名称（同时作为 provider 的展示名与 model 的 name）
    pub name: String,
    /// API base_url，例如 https://api.xiaomimimo.com/v1
    pub base_url: String,
    /// API Key
    pub api_key: String,
    /// 上下文大小（tokens）。例如 256000（即 256K）
    pub context_window: u32,
}

/// 新增一个云端模型 Provider 到 admAgent.json 的 `providers` 分支下。
///
/// - 先调用 `ensure_adm_agent_config` 保证文件存在且含合法的 `providers.local` 结构，
///   这样后续 admAgent 启动/改上下文时 `ensure_adm_agent_config` 走「原地更新」分支，
///   不会重写默认结构从而覆盖掉本次新增的云端 provider。
/// - 文件已存在则解析并尽量保留其它字段；不存在则用完整默认结构。
/// - 以模型名称派生 provider key 与 model id，插入（或覆盖同名）`providers[key]`。
/// - 写入采用原子方式（临时文件 + rename）。
///
/// 返回新增的 provider key，供前端提示。
#[tauri::command]
pub async fn add_cloud_provider(
    app: tauri::AppHandle,
    input: CloudProviderInput,
) -> Result<serde_json::Value, AppError> {
    // 1) 保证基础结构存在（含 local provider），避免后续被覆盖
    ensure_adm_agent_config(&app)?;

    let dir = adm_agent_config_dir()?;
    let path = dir.join("admAgent.json");

    // 2) 读取现有配置（此时文件一定已存在）
    let mut config: serde_json::Value = if path.exists() {
        let s = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
        serde_json::from_str(&s).map_err(|e| format!("解析 admAgent.json 失败: {}", e))?
    } else {
        build_adm_agent_config(DEFAULT_CONTEXT_WINDOW, DEFAULT_PORT)
    };

    if !config.get("providers").map_or(false, |v| v.is_object()) {
        config["providers"] = serde_json::json!({});
    }

    // 3) 派生 key / model id 并构造 provider
    let key = slugify_provider_key(&input.name);
    let model_id = slugify_model_id(&input.name);

    let provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "context_window": input.context_window
            }
        ]
    });

    config["providers"][&key] = provider;

    // 4) 原子写入
    write_json_atomic(&path, &config)?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

/// 模型管理弹窗中展示的 provider 视图（脱敏无关，api_key 一并返回以便编辑回填）
#[derive(Serialize)]
pub struct CloudProviderView {
    pub key: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub context_window: u32,
}

/// 列出 admAgent.json 中已添加的全部云端模型 Provider（排除自动管理的 `local`）。
/// 返回每项的关键信息，供前端列表展示与编辑回填。
#[tauri::command]
pub async fn list_cloud_providers(
    _app: tauri::AppHandle,
) -> Result<Vec<CloudProviderView>, AppError> {
    let dir = adm_agent_config_dir()?;
    let path = dir.join("admAgent.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let s = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&s)
        .map_err(|e| format!("解析 admAgent.json 失败: {}", e))?;

    let mut out: Vec<CloudProviderView> = vec![];
    if let Some(providers) = v.get("providers").and_then(|p| p.as_object()) {
        for (key, prov) in providers {
            // 跳过自动生成的本地 provider（非用户添加）
            if key == "local" {
                continue;
            }
            let name = prov
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(key.as_str())
                .to_string();
            let base_url = prov
                .get("base_url")
                .and_then(|b| b.as_str())
                .unwrap_or("")
                .to_string();
            let api_key = prov
                .get("api_key")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string();
            let context_window = prov
                .get("models")
                .and_then(|m| m.get(0))
                .and_then(|m0| m0.get("context_window"))
                .and_then(|c| c.as_u64())
                .unwrap_or(0) as u32;
            out.push(CloudProviderView {
                key: key.clone(),
                name,
                base_url,
                api_key,
                context_window,
            });
        }
    }
    Ok(out)
}

/// 更新指定 key 的云端模型 Provider（按 key 定位，替换其全部参数）。
/// 模型名称变更时同步重派生 model id；保留同一 key 以免产生孤儿条目。
#[tauri::command]
pub async fn update_cloud_provider(
    _app: tauri::AppHandle,
    key: String,
    input: CloudProviderInput,
) -> Result<serde_json::Value, AppError> {
    let dir = adm_agent_config_dir()?;
    let path = dir.join("admAgent.json");
    if !path.exists() {
        bail!("未找到 admAgent.json，请先添加云端模型");
    }
    let s = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&s)
        .map_err(|e| format!("解析 admAgent.json 失败: {}", e))?;

    let providers = config
        .get_mut("providers")
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| "admAgent.json 结构异常：缺少 providers".to_string())?;

    if providers.get(&key).is_none() {
        bail!("未找到 provider: {}", key);
    }

    let model_id = slugify_model_id(&input.name);
    let new_provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "context_window": input.context_window
            }
        ]
    });

    providers.insert(key.clone(), new_provider);
    write_json_atomic(&path, &config)?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

// ===== 数据结构 =====

#[derive(Serialize)]
pub struct AdmAgentInfo {
    pub exists: bool,
    pub path: String,
}

// ===== Tauri Command =====

/// 返回当前操作系统标识：windows / macos / linux 等
/// 用于进入 Agent 页前做平台判断（仅 Windows 支持）
#[tauri::command]
pub fn get_platform_os() -> String {
    std::env::consts::OS.to_string()
}

/// 检查本地是否已下载 admAgent 工具
#[tauri::command]
pub async fn check_adm_agent(app: tauri::AppHandle) -> Result<AdmAgentInfo, AppError> {
    let path = adm_agent_path(&app)?;
    let exists = path.exists();
    Ok(AdmAgentInfo {
        exists,
        path: path.to_string_lossy().to_string(),
    })
}

/// 下载 admAgent 工具（远程包含 admAgentVersion 字段，自动构造压缩包 URL 下载并解压）。
/// 会先拉取 update.json 获取远程版本号，再根据平台构造 URL；下载后解压覆盖本地 admAgent。
#[tauri::command]
pub async fn download_adm_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    // 1. 获取远程版本
    let remote_ver = fetch_update_info()
        .await?
        .adm_agent_version
        .ok_or_else(|| "远程配置缺少 admAgentVersion 字段".to_string())?;

    let url = adm_agent_download_url(&remote_ver)?;
    let archive_name = adm_agent_archive_name(&remote_ver)?;
    let dir = adm_agent_target_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // 2. 下载前先停掉正在运行的 admAgent，释放 Windows 上的文件锁
    let old_session = {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(mut sess) = old_session {
        stop_agent_session_clean(&mut sess);
    }

    let archive_path = dir.join(&archive_name);
    app.emit(
        "agent-download-progress",
        serde_json::json!({ "status": "downloading", "progress": 0 }),
    )
    .ok();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !response.status().is_success() {
        bail!("下载失败，HTTP 状态码: {}", response.status());
    }

    let total_size: u64 = response.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(|e| format!("创建压缩包文件失败: {}", e))?;

    let mut downloaded: u64 = 0;
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
            "agent-download-progress",
            serde_json::json!({ "status": "downloading", "progress": progress }),
        )
        .ok();
    }

    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    // 3. 解压覆盖本地 admAgent 文件
    app.emit(
        "agent-download-progress",
        serde_json::json!({ "status": "extracting", "progress": 0 }),
    )
    .ok();

    // 先尝试删除旧文件（进程刚结束可能仍有极短占用，故带重试）
    let dest = adm_agent_path(&app)?;
    if dest.exists() {
        let mut removed = false;
        for _ in 0..15 {
            if std::fs::remove_file(&dest).is_ok() {
                removed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if !removed {
            // 尝试清理压缩包后报错
            let _ = std::fs::remove_file(&archive_path);
            bail!("替换 admAgent 失败：旧文件仍被占用，请手动关闭 Agent 终端后重试");
        }
    }

    // 根据后缀判断压缩包格式并解压
    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let is_zip = archive_name.ends_with(".zip");

    let copied = if is_zip || ext == "zip" {
        crate::common::utils::archive::extract_zip(&archive_path, &dir)?
    } else {
        crate::common::utils::archive::extract_tar_gz(&archive_path, &dir)?
    };

    if copied == 0 {
        let _ = std::fs::remove_file(&archive_path);
        bail!("解压后未找到任何文件，请检查压缩包是否完整");
    }

    // 解压出来的文件名可能与预期不同（如与 admAgent_file_name() 不一致），需要定位并移动到正确路径
    if !dest.exists() {
        // 在目录中搜索 admAgent 可执行文件
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        // 匹配 admAgent 或 admAgent.exe（Windows 中带 .exe 但压缩包可能不带）
                        let is_target = if cfg!(target_os = "windows") {
                            name.eq_ignore_ascii_case(adm_agent_file_name())
                                || name.eq_ignore_ascii_case("admAgent")
                                || name.eq_ignore_ascii_case("admAgent.exe")
                        } else {
                            name == "admAgent" || name == adm_agent_file_name()
                        };
                        if is_target {
                            if p != dest {
                                let _ = std::fs::rename(&p, &dest);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // 4. 删除下载的压缩包
    let _ = std::fs::remove_file(&archive_path);

    // 5. macOS 需要赋予可执行权限
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        if dest.exists() {
            let mut perms = std::fs::metadata(&dest)
                .map_err(|e| format!("读取权限失败: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms).map_err(|e| format!("设置执行权限失败: {}", e))?;
        }
    }

    app.emit(
        "agent-download-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}

// ===== admAgent 版本检查与更新（接入主升级流程） =====

/// 归一化 admAgent 版本号：去掉首尾空白与开头的 'v' 前缀。
/// 例如 "v0.0.1-250db9" -> "0.0.1-250db9"。
/// 注意：admAgent 版本含 commit 短哈希后缀，不能按 semver 数值比较，
/// 故采用归一化后的字符串相等性判断。
fn normalize_agent_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

/// 解析 `admAgent -v` 输出，提取版本号。
/// 输出示例：`admAgent version v0.0.1-250db9`
fn parse_adm_agent_version_output(output: &str) -> Option<String> {
    let marker = "admAgent version ";
    let text = output.trim();
    if let Some(idx) = text.find(marker) {
        let ver = text[idx + marker.len()..].trim();
        if !ver.is_empty() {
            return Some(ver.to_string());
        }
    }
    // 兜底：整行看起来像版本号（以 v 开头且含 '.'）
    if text.starts_with('v') && text.contains('.') {
        return Some(text.to_string());
    }
    None
}

/// 获取本地已安装 admAgent 的版本号（运行 `admAgent -v`）。
/// 未安装或无法解析时返回 Ok(None)。
pub fn get_adm_agent_local_version(app: &tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = adm_agent_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("admAgent 路径包含非法字符: {}", path.display()))?;

    let output = platform::create_hidden_command(path_str)
        .arg("-v")
        .output()
        .map_err(|e| format!("运行 admAgent 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    Ok(parse_adm_agent_version_output(&combined))
}

/// 下载并替换 admAgent 工具（版本更新用）。
/// 使用服务端下发的下载地址（压缩包），下载到 admAgent 默认存放路径解压并覆盖旧版本。
#[tauri::command]
pub async fn download_adm_agent_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    if url.trim().is_empty() || !url.starts_with("http") {
        bail!(
            "下载地址无效: {}，请重新检查更新",
            if url.is_empty() { "地址为空" } else { &url }
        );
    }

    let dir = adm_agent_target_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // 从 URL 中提取文件名作为压缩包名
    let archive_name = url.split('/').next_back().unwrap_or("admAgent_archive").to_string();
    let archive_path = dir.join(&archive_name);

    app.emit(
        "adm-agent-update-progress",
        serde_json::json!({ "status": "downloading", "progress": 0 }),
    )
    .ok();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client.get(&url).send().await.map_err(|e| {
        let detail = if e.is_connect() {
            format!("无法连接到服务器（{}），请检查网络连接", url)
        } else if e.is_timeout() {
            "连接超时，请检查网络或更换网络环境".to_string()
        } else {
            format!("{}", e)
        };
        format!("下载请求失败: {}", detail)
    })?;

    if !response.status().is_success() {
        bail!("下载失败，HTTP 状态码: {}", response.status());
    }

    let total_size: u64 = response.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(|e| format!("创建压缩包文件失败: {}", e))?;

    let mut downloaded: u64 = 0;
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
            "adm-agent-update-progress",
            serde_json::json!({ "status": "downloading", "progress": progress }),
        )
        .ok();
    }
    file.flush().await.map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    app.emit(
        "adm-agent-update-progress",
        serde_json::json!({ "status": "extracting", "progress": 0 }),
    )
    .ok();

    // 解压前先停掉正在运行的 Agent 终端，释放被 Windows 锁定的 admAgent.exe。
    let old_session = {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(mut sess) = old_session {
        stop_agent_session_clean(&mut sess);
    }

    // 先尝试删除旧文件（进程刚结束可能仍有极短占用，故带重试）
    let dest = adm_agent_path(&app)?;
    if dest.exists() {
        let mut removed = false;
        for _ in 0..15 {
            if std::fs::remove_file(&dest).is_ok() {
                removed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if !removed {
            let _ = std::fs::remove_file(&archive_path);
            bail!("替换 admAgent 失败：旧文件仍被占用，请手动关闭 Agent 终端后重试");
        }
    }

    // 根据文件名后缀判断压缩包格式并解压
    let is_zip = archive_name.ends_with(".zip");
    let copied = if is_zip {
        crate::common::utils::archive::extract_zip(&archive_path, &dir)?
    } else {
        crate::common::utils::archive::extract_tar_gz(&archive_path, &dir)?
    };

    if copied == 0 {
        let _ = std::fs::remove_file(&archive_path);
        bail!("解压后未找到任何文件，请检查压缩包是否完整");
    }

    // 解压出来的文件名可能与预期不同（如与 admAgent_file_name() 不一致），需要定位并移动到正确路径
    if !dest.exists() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        let is_target = if cfg!(target_os = "windows") {
                            name.eq_ignore_ascii_case(adm_agent_file_name())
                                || name.eq_ignore_ascii_case("admAgent")
                                || name.eq_ignore_ascii_case("admAgent.exe")
                        } else {
                            name == "admAgent" || name == adm_agent_file_name()
                        };
                        if is_target {
                            if p != dest {
                                let _ = std::fs::rename(&p, &dest);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // 删除下载的压缩包
    let _ = std::fs::remove_file(&archive_path);

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        if dest.exists() {
            let mut perms = std::fs::metadata(&dest)
                .map_err(|e| format!("读取权限失败: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms).map_err(|e| format!("设置执行权限失败: {}", e))?;
        }
    }

    app.emit(
        "adm-agent-update-progress",
        serde_json::json!({ "status": "done", "progress": 100 }),
    )
    .ok();

    Ok(())
}

/// 获取当前系统架构（主要用于 macOS Intel/ARM 区分）
#[tauri::command]
pub fn get_platform_arch() -> String {
    std::env::consts::ARCH.to_string()
}

/// 检查 admAgent 是否需要更新（仅在点击底部栏 Agent 按钮时调用，不在启动时检查）。
/// 支持 Windows 和 macOS (arm64) 平台，根据远程 admAgentVersion 动态构造下载地址。
#[tauri::command]
pub async fn check_adm_agent_update(app: tauri::AppHandle) -> Result<AdmAgentUpdateCheck, AppError> {
    let mut needs_update = false;
    let mut local_version: Option<String> = None;
    let mut remote_version: Option<String> = None;
    let mut download_url: Option<String> = None;

    // 拉取远程更新清单（失败时不强制更新，仅返回本地版本）
    let update_info = match fetch_update_info().await {
        Ok(info) => info,
        Err(_) => {
            local_version = get_adm_agent_local_version(&app).ok().flatten();
            return Ok(AdmAgentUpdateCheck {
                needs_update,
                remote_version,
                local_version,
                download_url,
            });
        }
    };
    remote_version = update_info.adm_agent_version.clone();

    // 根据平台 + 远程版本构造下载地址（Linux 不返回 URL，前端据此提示暂未开放）
    #[cfg(target_os = "windows")]
    {
        if let Some(ref remote_ver) = remote_version {
            download_url = adm_agent_download_url(remote_ver).ok();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(ref remote_ver) = remote_version {
            download_url = adm_agent_download_url(remote_ver).ok();
        }
    }
    // Linux: download_url 保持 None，前端据此判断为暂不支持

    if let Some(ref remote_ver) = remote_version {
        // 仅在能拿到下载地址（Windows / macOS arm64）时才判定需要更新
        if download_url.is_some() {
            match get_adm_agent_local_version(&app) {
                Ok(local_opt) => {
                    local_version = local_opt.clone();
                    match local_opt {
                        None => {
                            // 本地未安装，需要下载（首次安装由 goAgent 的 check_adm_agent 流程处理）
                            needs_update = true;
                        }
                        Some(local) => {
                            if normalize_agent_version(&local) != normalize_agent_version(remote_ver) {
                                needs_update = true;
                            }
                        }
                    }
                }
                Err(_) => {
                    // 无法运行/解析，标记 unknown 但不强制下载
                    local_version = Some("unknown".to_string());
                }
            }
        }
    }

    Ok(AdmAgentUpdateCheck {
        needs_update,
        remote_version,
        local_version,
        download_url,
    })
}

/// 获取已配置的 agent 工作目录（默认为空字符串）
#[tauri::command]
pub async fn get_agent_workdir(app: tauri::AppHandle) -> Result<String, AppError> {
    Ok(load_agent_workdir(&app))
}

/// 保存 agent 工作目录到配置文件
#[tauri::command]
pub async fn set_agent_workdir(app: tauri::AppHandle, workdir: String) -> Result<(), AppError> {
    save_agent_workdir(&app, workdir.trim())
}

/// Agent 终端当前状态：进程是否仍在运行 + 当前模型代次。
/// 供前端每次进入 Agent 页时判断是否需要 (重)启动 admAgent：
/// - `running=false`：进程已退出（含崩溃），需要重新拉起；
/// - `model_generation` 与启动时记录的不一致：模型被重启过，旧 admAgent 仍连着旧模型实例，需要重启；
/// - 两者都没变：保持原状，不自动退出（哪怕只是切换页面，或仅改了上下文配置但没重启模型）。
#[derive(Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub model_generation: u64,
}

#[tauri::command]
pub async fn get_agent_status(
    state: tauri::State<'_, AppState>,
) -> Result<AgentStatus, AppError> {
    let mut s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    // try_wait 返回 Ok(None) 表示仍在运行；Ok(Some(_)) 表示已退出；Err 视为不可知 → 视为未运行
    let running = match s.as_mut() {
        Some(sess) => match sess.child.try_wait() {
            Ok(None) => true,
            _ => false,
        },
        None => false,
    };
    let model_generation = *state
        .model_generation
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(AgentStatus {
        running,
        model_generation,
    })
}

/// 启动内嵌终端（Windows 调用 powershell，macOS 调用系统默认 shell），并自动启动 admAgent 工具
/// `rows` / `cols` 为前端 xterm 当前真实尺寸：必须用真实尺寸创建 PTY，否则 admAgent 启动时会按
/// PTY 默认宽度（120 列）布局其 TUI（右边栏上下文实时统计等），而实际显示宽度不同，导致错位/刷新异常。
#[tauri::command]
pub async fn start_agent_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    // 若已有会话：先彻底回收旧读取线程（置位 stop + kill 子进程 + join），
    // 确保旧线程不会与新线程并发向同一 `agent-terminal-data` 事件推送数据。
    // 重要：仅在锁内做 take（O(1)），把 join 和 kill 移到锁外执行；
    // stop_agent_session_clean 可能阻塞最多 500ms，不能一直持锁。
    let old_session = {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(mut old) = old_session {
        stop_agent_session_clean(&mut old);
    }

    // 本会话的 Agent 终端代次（+1）。读取线程把该值随每帧数据 emit 给前端，
    // 前端按代次过滤旧会话残留输出，结构上杜绝「同一输出显示两遍」。
    let generation = state.bump_agent_generation();
    let reader_stop = Arc::new(AtomicBool::new(false));

    // 用前端真实尺寸创建 PTY；缺失时回退到合理默认（避免 admAgent 以固定 120 列布局 TUI 错位）
    let rows = if rows > 0 { rows } else { 30 };
    let cols = if cols > 0 { cols } else { 120 };

    // 启动前：读取配置文件中的上下文大小（ctx_size），生成 / 更新 admAgent.json
    if let Err(e) = ensure_adm_agent_config(&app) {
        eprintln!("[admAgent] 生成 admAgent.json 配置失败: {}", e);
    }

    let agent_path = adm_agent_path(&app)?;
    if !agent_path.exists() {
        bail!("未找到 admAgent 工具: {}", agent_path.display());
    }

    // 创建 PTY（使用前端真实尺寸）
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建终端失败: {}", e))?;

    // 读取工作目录（Windows 直接作为 admAgent 的 --cwd 参数；macOS 走 zsh 启动命令时使用）
    let workdir = load_agent_workdir(&app);

    // 构造要启动的命令。
    // Windows：直接启动 admAgent.exe，不再经过 powershell.exe。
    // 原因：release 版 adm.exe 带 #![windows_subsystem = "windows"]（无控制台），
    // portable-pty 的 ConPTY 在「无控制台父进程」中启动 powershell 时，powershell
    // 初始化失败并弹 0xc0000142 错误。直接以 admAgent 作为 PTY 子进程即可规避。
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = CommandBuilder::new(agent_path.clone());
        if !workdir.is_empty() {
            c.arg("--cwd");
            c.arg(&workdir);
        }
        c
    } else {
        let shell = std::env::var("SHELL")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
        let mut c = CommandBuilder::new(shell);
        c.arg("-i"); // 交互式 shell
        c
    };
    // 设置 TERM，提升 admAgent 等 TUI 程序的终端能力识别（如真彩色、清行序列）
    cmd.env("TERM", "xterm-256color");
    if let Some(parent) = agent_path.parent() {
        cmd.cwd(parent);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动终端失败: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取终端读取失败: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取终端写入失败: {}", e))?;

    // 启动后台读取线程，将 PTY 输出流式推送到前端。
    // 每帧 payload 携带本会话的代次 `gen`，前端按代次过滤旧会话残留输出。
    // 线程在 stop 标志置位 / EOF / 错误时退出；(重)启动时由 stop_agent_session_clean
    // 先置位 stop + kill 子进程（产生 EOF）再 join，避免新旧线程并发 emit。
    let app2 = app.clone();
    let stop_for_thread = reader_stop.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            // 每次 read 前后都检查 stop：read 返回后检查可避免 emit 旧进程残留数据
            if stop_for_thread.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    // read 返回后再检查一次 stop：若已被要求停止则丢弃这帧（不 emit）
                    if stop_for_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(
                        "agent-terminal-data",
                        serde_json::json!({ "data": encoded, "gen": generation }),
                    );
                }
                Err(_) => break,
            }
        }
        // 仅在本线程是「自然退出」（非被 stop）时才发 exit 事件；
        // 被 stop_agent_session_clean 置位 stop 后退出的情形属于重启/停止流程，
        // 前端会通过新会话的 ready 事件接管，不需要 exit 提示。
        if !stop_for_thread.load(Ordering::Relaxed) {
            let _ = app2.emit("agent-terminal-exit", serde_json::json!({}));
        }
    });

    // 保存会话（含本会话代次与读取线程句柄，供后续 (重)启动 / 停止时回收）
    {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        *s = Some(AgentSession {
            master: pair.master,
            writer,
            child,
            generation,
            reader_stop,
            reader_handle: Some(reader_handle),
        });
    }

    // 自动在终端中启动 admAgent 工具。
    // Windows：上面已直接以 admAgent 作为 PTY 子进程启动，无需再向 shell 写启动命令。
    // macOS：走 zsh -i，需要显式写入启动命令。
    #[cfg(target_os = "macos")]
    {
        let launch = if workdir.is_empty() {
            format!("\"{}\"\r\n", agent_path.display())
        } else {
            format!("\"{}\" --cwd \"{}\"\r\n", agent_path.display(), workdir)
        };
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(ref mut sess) = *s {
            let _ = sess.writer.write_all(launch.as_bytes());
            let _ = sess.writer.flush();
        }
    }

    // ready 事件携带本会话代次：前端据此设置 currentAgentGen，后续 data 事件按该值过滤。
    app.emit("agent-terminal-ready", serde_json::json!({ "gen": generation }))
        .ok();
    Ok(())
}

/// 向终端写入输入（前端按键）
#[tauri::command]
pub async fn agent_terminal_input(
    state: tauri::State<'_, AppState>,
    data: String,
) -> Result<(), AppError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("解码输入失败: {}", e))?;
    let mut s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(ref mut sess) = *s {
        sess.writer
            .write_all(&decoded)
            .map_err(|e| e.to_string())?;
        sess.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 调整终端大小
#[tauri::command]
pub async fn agent_terminal_resize(
    state: tauri::State<'_, AppState>,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    let s = state
        .agent_session
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(ref sess) = *s {
        sess.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整终端大小失败: {}", e))?;
    }
    Ok(())
}

/// 终止 Agent 终端进程及其整个进程树。
/// admAgent 是在 shell（powershell）内部以 `& "路径"` 启动的，属于 shell 的子进程；
/// Windows 上仅 kill 直接子进程（shell）不会连带结束 admAgent（会变为孤儿进程残留）。
/// 因此用 `taskkill /PID <pid> /T /F` 杀掉整棵进程树，确保 admAgent 一并退出。
#[cfg(target_os = "windows")]
fn kill_agent_child_tree(child: &mut Box<dyn Child + Send>) {
    if let Some(pid) = child.process_id() {
        let pid_str = pid.to_string();
        let _ = platform::create_hidden_command("taskkill")
            .args(["/PID", &pid_str, "/T", "/F"])
            .spawn();
    }
    // 兜底：直接 kill 一次
    let _ = child.kill();
}

#[cfg(not(target_os = "windows"))]
fn kill_agent_child_tree(child: &mut Box<dyn Child + Send>) {
    let _ = child.kill();
}

/// 停止并回收一个 Agent 会话的读取线程，再杀掉子进程树。
/// 顺序很重要：
///   1) 先置位 stop 标志——读取线程在 read 返回后会检查该标志，若已停止则不 emit 直接退出；
///   2) 再 kill 子进程树——让 PTY master 的阻塞 read 收到 EOF 从而唤醒线程；
///   3) 最后 join（带超时轮询）确保线程真的退出。
/// 这样可以避免「旧读取线程仍在 emit 旧进程残留输出」与「新会话的输出」同时进入
/// 同一个 `agent-terminal-data` 事件导致前端重复显示。
/// 超时（500ms）后不再阻塞调用方——线程最终会在 EOF/Err 后自行退出。
fn stop_agent_session_clean(sess: &mut AgentSession) {
    // 1) 通知读取线程停止（此后线程即使读到数据也不再 emit）
    sess.reader_stop.store(true, Ordering::Relaxed);
    // 2) 杀掉子进程树：让阻塞中的 read 收到 EOF 唤醒，线程得以检查 stop 并退出
    kill_agent_child_tree(&mut sess.child);
    // 3) 等待读取线程退出（带超时轮询，避免极端情况下永久阻塞调用方）
    if let Some(handle) = sess.reader_handle.take() {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if handle.is_finished() {
                let _ = handle.join();
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // 超时仍未退出：放弃 join，线程最终会自行退出（读到了 EOF 或 Err）
        // 句柄 drop 后 detached，不会泄漏进程，仅理论上的极小资源窗口。
    }
}

/// 关闭终端会话
#[tauri::command]
pub async fn stop_agent_terminal(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let old = {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(mut sess) = old {
        stop_agent_session_clean(&mut sess);
    }
    Ok(())
}

/// 窗口关闭时清理 Agent 会话（供 lib.rs 调用）
pub fn kill_agent_session(state: &AppState) {
    let old = if let Ok(mut s) = state.agent_session.lock() {
        s.take()
    } else {
        None
    };
    if let Some(mut sess) = old {
        stop_agent_session_clean(&mut sess);
    }
}
