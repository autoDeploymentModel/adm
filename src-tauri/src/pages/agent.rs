// Agent 页面后端逻辑：admAgent server 模式管理 + HTTP API 代理

use crate::app_state::{AppState, AgentServerSession};
use crate::common::agent_http::{self, AgentTransport, build_client, health_check};
use crate::common::config;
use crate::common::types::Settings;
use crate::common::utils::platform;
use crate::common::error::AppError;
use crate::bail;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

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
    // 直接写入目标文件，避免 macOS 上 rename 失败
    std::fs::write(&config_path, &json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

// ===== 平台相关路径 =====

/// admAgent 存放目录（安装包内置 sidecar，不再运行时下载）：
/// - Windows：软件所在根目录（NSIS 把 sidecar 装在 ADM.exe 旁）
/// - macOS：ADM.app/Contents/MacOS（Tauri externalBin 打包位置，即主程序所在目录）
#[allow(unused_variables)]
fn adm_agent_target_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        config::get_exe_dir()
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

/// macOS：清理旧版「运行时下载」模式遗留在 app_data_dir 的 admAgent 二进制（约 50MB+）。
/// 新版直接使用安装包内置的 sidecar，旧文件永久闲置，启动时静默删除（失败不报错不阻塞）。
#[cfg(target_os = "macos")]
pub fn cleanup_legacy_adm_agent(app: &tauri::AppHandle) {
    if let Ok(data_dir) = config::get_data_dir(Some(app)) {
        let legacy = data_dir.join("admAgent");
        if legacy.is_file() {
            match std::fs::remove_file(&legacy) {
                Ok(_) => eprintln!("[admAgent] 已清理旧版下载的二进制: {}", legacy.display()),
                Err(e) => eprintln!("[admAgent] 清理旧版二进制失败（忽略）: {}", e),
            }
        }
    }
}

fn adm_agent_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(adm_agent_target_dir(app)?.join(adm_agent_file_name()))
}

// ===== admAgent.json 配置（本地模型启动成功后统一生成 / 更新）=====

/// 默认上下文大小（配置文件未显式配置 ctx_size 时使用，与示例一致）
const DEFAULT_CONTEXT_WINDOW: u32 = 25600;

/// 默认端口（配置文件未显式配置 port 时使用）
const DEFAULT_PORT: u16 = 5678;

/// admAgent.json 的存放目录。
/// Windows：`%LOCALAPPDATA%\admAgent`（与 admAgent server 的 GlobalConfigData 同目录，
/// 合并优先级高于 `~/.config/admAgent/admAgent.json`，避免低优先级旧值覆盖 UI 写入）；
/// 其它平台：保持 `$HOME/.config/admAgent`（无 LOCALAPPDATA 概念）。
/// 首次切换到新目录时会自动把旧 `~/.config/admAgent/admAgent.json` 一次性迁移
/// （内容合并进新位置、备份到 .migrated.bak、旧位置写占位标记）。
fn adm_agent_config_dir() -> Result<PathBuf, AppError> {
    let dir = if cfg!(target_os = "windows") {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("USERPROFILE")
                    .ok()
                    .map(|p| PathBuf::from(p).join("AppData").join("Local"))
            });
        match local_app_data {
            Some(p) => p.join("admAgent"),
            None => {
                return Err(AppError::msg("无法确定本地应用数据目录（LOCALAPPDATA），无法创建 admAgent 配置目录"));
            }
        }
    } else {
        let home = if let Ok(p) = std::env::var("HOME") {
            PathBuf::from(p)
        } else {
            return Err(AppError::msg("无法确定用户主目录，无法创建 admAgent 配置目录"));
        };
        home.join(".config").join("admAgent")
    };
    // 迁移只针对 Windows 的目录切换；其它平台新旧路径相同，迁移会把自己改名，必须跳过。
    #[cfg(target_os = "windows")]
    migrate_legacy_config(&dir);
    Ok(dir)
}

/// 把 overlay 中 base 缺失的键合并进 base（对象递归合并；标量/数组以 base 为准）。
/// 语义对齐 admAgent server 的 JSON 深合并：新位置（高优先级）内容优先。
#[cfg(target_os = "windows")]
fn merge_json(base: &mut serde_json::Value, overlay: &serde_json::Value) {
    if let (serde_json::Value::Object(b), serde_json::Value::Object(o)) = (base, overlay) {
        for (k, v) in o {
            match b.get_mut(k) {
                Some(bv) => merge_json(bv, v),
                None => {
                    b.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

/// 一次性迁移：把旧 `$HOME/.config/admAgent/admAgent.json` 的内容合并进新目录下的
/// admAgent.json（新文件内容优先，旧文件缺失的键补入，如历史云端 provider），
/// 原内容先备份到 `admAgent.json.migrated.bak`（仅当尚无备份时），随后在旧位置
/// **覆盖写入占位标记** `{"migrated_to_localappdata":true}`（不再改名）。
///
/// 占位而非改名是必须的：admAgent server 的 EnsureDefaultConfig 每次启动都检查
/// `~/.config/admAgent/admAgent.json`，文件不存在就重建默认 local 配置——若迁移把
/// 它改名，server 会重建默认、迁移又改名，形成循环（升级后首次启动即因此出现
/// "Created default local-model config" 日志与配置短暂退化）。占位文件使该检查永远
/// 通过，且占位是未知字段，JSON 合并时对生效配置零影响。
/// 幂等：旧文件不存在或已是占位则直接返回；失败只打日志，不影响主流程（下次调用会重试）。
#[cfg(target_os = "windows")]
fn migrate_legacy_config(new_dir: &std::path::Path) {
    const MIGRATED_MARKER: &str = "migrated_to_localappdata";
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return,
    };
    let legacy_path = home.join(".config").join("admAgent").join("admAgent.json");
    if !legacy_path.exists() {
        return;
    }
    let new_path = new_dir.join("admAgent.json");
    if new_path == legacy_path {
        // 新旧同路径（非 Windows 或 HOME 恰好等于数据目录的异常场景）：无需迁移
        return;
    }
    let legacy = match std::fs::read_to_string(&legacy_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[admAgent] 迁移旧配置：读取 {} 失败: {}", legacy_path.display(), e);
            return;
        }
    };
    let legacy_value: serde_json::Value = match serde_json::from_str(&legacy) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[admAgent] 迁移旧配置：解析 {} 失败: {}", legacy_path.display(), e);
            return;
        }
    };
    // 已是占位：迁移已完成，跳过
    if legacy_value.get(MIGRATED_MARKER).and_then(|v| v.as_bool()) == Some(true) {
        return;
    }
    let result = (|| -> Result<(), AppError> {
        if new_path.exists() {
            let s = std::fs::read_to_string(&new_path)
                .map_err(|e| format!("读取 {} 失败: {}", new_path.display(), e))?;
            let mut new_value: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| format!("解析 {} 失败: {}", new_path.display(), e))?;
            merge_json(&mut new_value, &legacy_value);
            write_json_atomic(&new_path, &new_value)?;
        } else {
            if let Some(parent) = new_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建 {} 失败: {}", parent.display(), e))?;
            }
            std::fs::write(&new_path, &legacy)
                .map_err(|e| format!("写入 {} 失败: {}", new_path.display(), e))?;
        }
        // 备份原配置（仅当尚无备份；避免覆盖更早的真实备份）
        let backup = legacy_path.with_file_name("admAgent.json.migrated.bak");
        if !backup.exists() {
            std::fs::write(&backup, &legacy)
                .map_err(|e| format!("备份旧配置 {} 失败: {}", legacy_path.display(), e))?;
        }
        // 覆盖写占位，保证 EnsureDefaultConfig 不再重建默认配置
        std::fs::write(&legacy_path, format!("{{\"{}\": true}}\n", MIGRATED_MARKER))
            .map_err(|e| format!("写入占位 {} 失败: {}", legacy_path.display(), e))?;
        eprintln!("[admAgent] 已迁移旧配置 {} → {}（旧位置写入占位）", legacy_path.display(), new_path.display());
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("[admAgent] 迁移旧配置失败: {}", e);
    }
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

/// 根据上下文大小、端口、图片支持与推理支持标志构造完整的 admAgent.json 配置结构体。
/// default_max_tokens 取 context_window 的 30%（四舍五入为整数）；
/// 模型支持推理时补充 can_reason / reasoning_levels / default_reasoning_effort，
/// 服务端会发送 reasoning_effort 并遵守 reasoning_content 回传规则。
fn build_adm_agent_config(
    context_window: u32,
    port: u16,
    supports_images: bool,
    supports_reasoning: bool,
) -> serde_json::Value {
    let default_max_tokens = (context_window as f64 * 0.3).round() as u32;
    let (can_reason, reasoning_levels, default_reasoning_effort) = if supports_reasoning {
        (
            serde_json::json!(true),
            serde_json::json!(["low", "medium", "high"]),
            serde_json::json!("medium"),
        )
    } else {
        (serde_json::json!(false), serde_json::Value::Null, serde_json::Value::Null)
    };
    serde_json::json!({
        "model": {
            "provider": "local",
            "model": "localModel"
        },
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
                        "default_max_tokens": default_max_tokens,
                        "supports_images": supports_images,
                        "can_reason": can_reason,
                        "reasoning_levels": reasoning_levels,
                        "default_reasoning_effort": default_reasoning_effort
                    }
                ]
            }
        }
    })
}

/// 确保 admAgent.json 存在且 context_window / default_max_tokens / base_url /
/// supports_images / can_reason 与当前配置一致。
///
/// - 目录不存在则创建。
/// - 文件不存在：写入完整的默认结构（context_window、port 来自配置，default_max_tokens = 30%）。
/// - 文件已存在：原地更新 providers.local.models[0] 的 context_window、default_max_tokens、
///   supports_images（取自 AppState，启动模型时按 mmproj 实际加载判定）
///   与 can_reason / reasoning_levels / default_reasoning_effort（按 --reasoning 参数判定），
///   以及 providers.local.base_url 中的端口，尽量保留文件中其它字段；
/// 若结构异常无法原地更新，则回退写入完整默认结构。
fn ensure_adm_agent_config(app: &tauri::AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx_size(app)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW as i32) as u32;

    let port = load_port(app).unwrap_or(DEFAULT_PORT);

    // 当前运行模型是否支持图片（start_model 时按 support_images + mmproj 实际加载写入）
    let supports_images = app
        .state::<AppState>()
        .model_supports_images
        .lock()
        .map(|g| *g)
        .unwrap_or(false);

    // 当前运行模型是否支持推理（start_model 时按 --reasoning 参数判定写入）
    let supports_reasoning = app
        .state::<AppState>()
        .model_supports_reasoning
        .lock()
        .map(|g| *g)
        .unwrap_or(false);

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
                        first["supports_images"] = serde_json::json!(supports_images);
                        // 推理能力同步：支持时写全推理元数据，不支持时写 false 并清理可能残留的旧值
                        if supports_reasoning {
                            first["can_reason"] = serde_json::json!(true);
                            first["reasoning_levels"] = serde_json::json!(["low", "medium", "high"]);
                            first["default_reasoning_effort"] = serde_json::json!("medium");
                        } else {
                            first["can_reason"] = serde_json::json!(false);
                            if let Some(obj) = first.as_object_mut() {
                                obj.remove("reasoning_levels");
                                obj.remove("default_reasoning_effort");
                            }
                        }
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
    let config = build_adm_agent_config(ctx, port, supports_images, supports_reasoning);
    write_json_atomic(&path, &config)
}

/// 原子写入 JSON：直接写入目标文件，避免 macOS 上 rename 失败。
fn write_json_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 admAgent 配置失败: {}", e))?;
    std::fs::write(path, &json)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 模型启动成功后同步本地模型能力（supports_images / can_reason / context_window）到 admAgent：
/// 1) ensure_adm_agent_config 把最新能力写入 admAgent.json；
/// 2) 若 server 正在运行，POST /config/set 写一个无害标量触发服务端写盘+从磁盘全量重载
///    （服务端只在启动时读配置，SetConfigField 是唯一的热重载入口；
///    不能直接写 models 数组元素：/config/set 落盘到服务端数据配置文件，
///    与 Rust 写的 admAgent.json 合并时数组按拼接处理，会造成模型重复）；
/// 3) POST /agent/update 重建 coordinator 内的 agent，使新 ModelInfo 即时生效。
/// 统一视觉链路下 supports_images 不再决定图片处理（图片一律走 vision bridge），
/// 仅用于前端 UI 展示与「多模态模型」下拉（agent_vision_model）筛选。
/// 失败静默：server 未运行时下次启动自然读到新配置。
pub fn sync_local_model_capabilities(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ensure_adm_agent_config(&app) {
            eprintln!("[admAgent] 同步本地模型能力：写 admAgent.json 失败: {}", e);
            return;
        }
        let ws = {
            let state = app.state::<AppState>();
            let mut guard = match state.agent_session.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(s) => {
                    if session_usable(s) {
                        s.workspace_id.clone()
                    } else {
                        return; // 进程已退出：下次启动会读新配置
                    }
                }
                _ => return, // server 未运行：启动时会读新配置，无需热同步
            }
        };
        let client = match build_client(&AgentTransport::default_host(), Duration::from_secs(3)) {
            Ok(c) => c,
            Err(_) => return,
        };
        // 写无害标量触发服务端重载（合并进刚更新的 admAgent.json）
        let set_body = serde_json::json!({ "scope": 0, "key": "providers.local.name", "value": "Local" });
        match tokio::time::timeout(
            Duration::from_secs(10),
            agent_http::send(&client, "POST", &format!("/v1/workspaces/{}/config/set", ws), Some(set_body)),
        ).await {
            Ok(Ok((st, _))) if (200..300).contains(&st) => {}
            Ok(Ok((st, _))) => {
                eprintln!("[admAgent] 同步本地模型能力：/config/set HTTP {}", st);
                return;
            }
            Ok(Err(e)) => {
                eprintln!("[admAgent] 同步本地模型能力：/config/set 失败: {}", e);
                return;
            }
            Err(_) => {
                eprintln!("[admAgent] 同步本地模型能力：/config/set 超时");
                return;
            }
        }
        // 重建 agent 使新 ModelInfo 生效；agent 未 init 时此接口报错属正常（init 时自然用新配置）
        let update_url = format!("/v1/workspaces/{}/agent/update", ws);
        match tokio::time::timeout(
            Duration::from_secs(10),
            agent_http::send(&client, "POST", &update_url, Some(serde_json::json!({}))),
        ).await {
            Ok(Ok((st, _))) => eprintln!("[admAgent] 同步本地模型能力：/agent/update HTTP {}", st),
            Ok(Err(e)) => eprintln!("[admAgent] 同步本地模型能力：/agent/update 失败: {}", e),
            Err(_) => eprintln!("[admAgent] 同步本地模型能力：/agent/update 超时"),
        }
    });
}

/// 把「多模态模型（图片识别）」选择同步到 admAgent.json 顶层 agent_vision_model 并触发服务端重载。
///
/// 值格式为 "provider/model" 复合键（如 "admAgent/admImage-model"）；空值或缺省回退内置
/// admAgent/admImage-model。写入 Windows 的 %LOCALAPPDATA%\admAgent\admAgent.json
/// （与云端 provider 同一文件；其它平台仍为 ~/.config/admAgent/admAgent.json），
/// vision 子命令启动时 config.Load 读取该字段。server 运行时通过写无害标量触发 SetConfigFields
/// 的全量重载（从磁盘重读所有配置路径并合并，任意顶层字段随之生效——已验证 reloadFromDiskLocked
/// 会重读 GlobalConfig，不限于 providers 分支）。
///
/// 失败静默：vision 缺省回退内置 admImage-model，不影响主流程。
pub fn sync_agent_vision_model(app: &tauri::AppHandle, value: &str) {
    let value = value.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let changed = match write_agent_vision_model(&value) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[admAgent] 同步多模态模型：写 admAgent.json 失败: {}", e);
                return;
            }
        };
        if !changed {
            return; // 值未变化：跳过服务端重载，避免不必要的配置抖动
        }
        let ws = {
            let state = app.state::<AppState>();
            let mut guard = match state.agent_session.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(s) => {
                    if session_usable(s) {
                        s.workspace_id.clone()
                    } else {
                        return; // 进程已退出：下次启动会读新配置
                    }
                }
                _ => return, // server 未运行：启动时会读新配置，无需热同步
            }
        };
        let client = match build_client(&AgentTransport::default_host(), Duration::from_secs(3)) {
            Ok(c) => c,
            Err(_) => return,
        };
        // 写无害标量触发服务端重载（合并进刚更新的 admAgent.json 顶层 agent_vision_model）
        let set_body = serde_json::json!({ "scope": 0, "key": "providers.local.name", "value": "Local" });
        match tokio::time::timeout(
            Duration::from_secs(10),
            agent_http::send(&client, "POST", &format!("/v1/workspaces/{}/config/set", ws), Some(set_body)),
        ).await {
            Ok(Ok((st, _))) if (200..300).contains(&st) => {
                eprintln!("[admAgent] 同步多模态模型：/config/set 触发重载完成");
            }
            Ok(Ok((st, _))) => {
                eprintln!("[admAgent] 同步多模态模型：/config/set HTTP {}", st);
            }
            Ok(Err(e)) => {
                eprintln!("[admAgent] 同步多模态模型：/config/set 失败: {}", e);
            }
            Err(_) => {
                eprintln!("[admAgent] 同步多模态模型：/config/set 超时");
            }
        }
    });
}

/// 把 agent_vision_model 写入 admAgent.json 顶层（缺省回退内置 admImage-model）。
/// 返回是否真的发生了变更（供调用方决定是否触发服务端重载）。
fn write_agent_vision_model(value: &str) -> Result<bool, AppError> {
    let (provider, model) = match value.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => (p.to_string(), m.to_string()),
        _ => ("admAgent".to_string(), "admImage-model".to_string()),
    };
    let dir = adm_agent_config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 admAgent 配置目录失败: {}", e))?;
    let path = dir.join("admAgent.json");
    let mut config: serde_json::Value = if path.exists() {
        let s = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
        serde_json::from_str(&s).map_err(|e| format!("解析 admAgent.json 失败: {}", e))?
    } else {
        build_adm_agent_config(DEFAULT_CONTEXT_WINDOW, DEFAULT_PORT, false, false)
    };
    let target = serde_json::json!({ "provider": provider, "model": model });
    if config.get("agent_vision_model") == Some(&target) {
        return Ok(false);
    }
    config["agent_vision_model"] = target;
    write_json_atomic(&path, &config)?;
    Ok(true)
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
    /// 模型名称（同时作为 provider 的展示名与 model 的 name，原样写入、区分大小写）
    pub name: String,
    /// API base_url，例如 https://api.xiaomimimo.com/v1
    pub base_url: String,
    /// API Key
    pub api_key: String,
    /// 上下文大小（tokens）。例如 256000（即 256K）
    pub context_window: u32,
    /// 用户填写的模型ID（必填，仅去首尾空白后原样写入、区分大小写）
    #[serde(default)]
    pub model_id: Option<String>,
    /// 是否支持图片输入（视觉模型），默认 false
    #[serde(default)]
    pub supports_images: bool,
    /// 是否开启思考模式（thinking mode）。为 true 时写入
    /// models[0].can_reason / reasoning_levels / default_reasoning_effort，
    /// 服务端会发送 reasoning_effort 并强制遵守 reasoning_content 回传规则；默认 false
    #[serde(default)]
    pub can_reason: bool,
}

/// 提取用户填写的模型ID：仅去首尾空白，不做任何大小写/字符转换（严格按用户填写写入）。
/// 为空时报错，不再静默从名称派生小写 id（历史派生逻辑曾把 MiniMax 等厂商的
/// 大小写敏感模型ID小写化，导致请求 400）。
fn require_model_id(model_id: &Option<String>) -> Result<String, AppError> {
    match model_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Ok(s.to_string()),
        None => bail!("模型ID不能为空"),
    }
}

/// 新增一个云端模型 Provider 到 admAgent.json 的 `providers` 分支下。
///
/// - 先调用 `ensure_adm_agent_config` 保证文件存在且含合法的 `providers.local` 结构，
///   这样后续 admAgent 启动/改上下文时 `ensure_adm_agent_config` 走「原地更新」分支，
///   不会重写默认结构从而覆盖掉本次新增的云端 provider。
/// - 文件已存在则解析并尽量保留其它字段；不存在则用完整默认结构。
/// - 以模型名称派生 provider key；模型ID与名称严格按用户填写写入（区分大小写），
///   插入（或覆盖同名）`providers[key]`。
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
        build_adm_agent_config(DEFAULT_CONTEXT_WINDOW, DEFAULT_PORT, false, false)
    };

    if !config.get("providers").map_or(false, |v| v.is_object()) {
        config["providers"] = serde_json::json!({});
    }

    // 3) 派生 provider key（仅作 JSON 内部键）；模型ID/名称原样写入，区分大小写
    let key = slugify_provider_key(&input.name);
    let model_id = require_model_id(&input.model_id)?;

    // 开启思考模式时补充推理档位元数据，服务端 effectiveReasoningEffort
    // 才能解析出具体档位（与内置远程池模型保持一致）
    let (can_reason, reasoning_levels, default_reasoning_effort) = if input.can_reason {
        (
            serde_json::json!(true),
            serde_json::json!(["low", "medium", "high"]),
            serde_json::json!("medium"),
        )
    } else {
        (serde_json::json!(false), serde_json::Value::Null, serde_json::Value::Null)
    };

    let provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "context_window": input.context_window,
                "supports_images": input.supports_images,
                "can_reason": can_reason,
                "reasoning_levels": reasoning_levels,
                "default_reasoning_effort": default_reasoning_effort
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
    /// models[0].id，供前端调用服务端 `/config/model` 切换模型时使用
    pub model_id: String,
    /// models[0].supports_images，是否支持图片输入
    pub supports_images: bool,
    /// models[0].can_reason，是否开启思考模式
    pub can_reason: bool,
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
            let model_id = prov
                .get("models")
                .and_then(|m| m.get(0))
                .and_then(|m0| m0.get("id"))
                .and_then(|i| i.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| slugify_model_id(&name));
            let supports_images = prov
                .get("models")
                .and_then(|m| m.get(0))
                .and_then(|m0| m0.get("supports_images"))
                .and_then(|s| s.as_bool())
                .unwrap_or(false);
            let can_reason = prov
                .get("models")
                .and_then(|m| m.get(0))
                .and_then(|m0| m0.get("can_reason"))
                .and_then(|s| s.as_bool())
                .unwrap_or(false);
            out.push(CloudProviderView {
                key: key.clone(),
                name,
                base_url,
                api_key,
                context_window,
                model_id,
                supports_images,
                can_reason,
            });
        }
    }
    Ok(out)
}

/// 删除指定 key 的云端模型 Provider。
/// 按 key 定位并从 admAgent.json 的 providers 分支中移除，原子写入。
#[tauri::command]
pub async fn delete_cloud_provider(
    _app: tauri::AppHandle,
    key: String,
) -> Result<serde_json::Value, AppError> {
    let dir = adm_agent_config_dir()?;
    let path = dir.join("admAgent.json");
    if !path.exists() {
        bail!("未找到 admAgent.json");
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

    providers.remove(&key);
    write_json_atomic(&path, &config)?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

/// 更新指定 key 的云端模型 Provider（按 key 定位，替换其全部参数）。
/// 模型ID与名称严格按用户填写写入（区分大小写）；保留同一 key 以免产生孤儿条目。
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

    let model_id = require_model_id(&input.model_id)?;
    // 开启思考模式时补充推理档位元数据，服务端 effectiveReasoningEffort
    // 才能解析出具体档位（与内置远程池模型保持一致）
    let (can_reason, reasoning_levels, default_reasoning_effort) = if input.can_reason {
        (
            serde_json::json!(true),
            serde_json::json!(["low", "medium", "high"]),
            serde_json::json!("medium"),
        )
    } else {
        (serde_json::json!(false), serde_json::Value::Null, serde_json::Value::Null)
    };
    let new_provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "context_window": input.context_window,
                "supports_images": input.supports_images,
                "can_reason": can_reason,
                "reasoning_levels": reasoning_levels,
                "default_reasoning_effort": default_reasoning_effort
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

// ===== admAgent 版本读取 =====

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

/// 获取 admAgent 版本号（供前端调用）
#[tauri::command]
pub async fn get_adm_agent_version(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    get_adm_agent_local_version(&app)
}

/// 获取当前系统架构（主要用于 macOS Intel/ARM 区分）
#[tauri::command]
pub fn get_platform_arch() -> String {
    std::env::consts::ARCH.to_string()
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

// ===== admAgent Server 模式 =====

/// admAgent server 启动信息
#[derive(Serialize)]
pub struct AgentServerInfo {
    /// 本地传输地址展示串（unix://… / npipe://…），多客户端共用同一默认地址
    pub host: String,
    pub workspace_id: String,
    pub client_id: String,
}

/// admAgent server 状态
#[derive(Serialize)]
pub struct AgentServerStatus {
    pub running: bool,
    pub host: Option<String>,
    pub workspace_id: Option<String>,
}

/// 会话可用判定：会话存在，且（共享 server 无子进程 或 自有子进程存活）
fn session_usable(sess: &mut AgentServerSession) -> bool {
    match sess.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => true,
    }
}

/// 供 ilink 桥读取当前 admAgent server 会话的工作区 ID（会话可用才算就绪）。
/// 传输地址固定为平台默认（Unix socket / Windows named pipe），无需再传。
pub fn current_agent_workspace(app: &tauri::AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let mut s = state.agent_session.lock().ok()?;
    match s.as_mut() {
        Some(sess) => {
            if session_usable(sess) && !sess.workspace_id.is_empty() {
                Some(sess.workspace_id.clone())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 内部函数：停止 admAgent server 并清理会话
fn stop_agent_server_internal(state: &tauri::State<'_, AppState>) -> Result<(), AppError> {
    let old = {
        let mut s = state
            .agent_session
            .lock()
            .map_err(|e| e.to_string())?;
        s.take()
    };
    if let Some(mut sess) = old {
        sess.sse_stop.store(true, Ordering::Relaxed);
        // 只终止本进程拉起的子进程；复用的共享 server 不杀（其它客户端/实例还在用），
        // 由服务端在最后一个工作区被 teardown 时自行退出。
        if let Some(child) = sess.child.as_mut() {
            #[cfg(target_os = "windows")]
            {
                if let Some(pid) = child.id() {
                    let pid_str = pid.to_string();
                    let _ = platform::create_hidden_command("taskkill")
                        .args(["/PID", &pid_str, "/T", "/F"])
                        .spawn();
                }
            }
            let _ = child.start_kill();
        }
    }
    Ok(())
}

/// 启动 admAgent server 模式（默认本地传输：Unix socket / Windows named pipe）。
///
/// 多客户端共享：先探测默认传输地址上是否已有 server 在跑（本进程或其它客户端/
/// 实例），有则直接复用（不 spawn、不占端口）；没有才拉起子进程。共享 server
/// 的生命周期由服务端管理——最后一个工作区被 teardown 时自行退出。
#[tauri::command]
pub async fn start_agent_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AgentServerInfo, AppError> {
    // 覆盖完整异步启动流程的单飞锁。第二个并发调用必须等待第一个完成，
    // 随后直接复用已启动的会话，不能再次 stop + spawn 产生孤儿进程。
    let _start_guard = state.agent_start_lock.lock().await;
    {
        let mut session = state.agent_session.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = session.as_mut() {
            if session_usable(existing) {
                return Ok(AgentServerInfo {
                    host: AgentTransport::default_host().display(),
                    workspace_id: existing.workspace_id.clone(),
                    client_id: existing.client_id.clone(),
                });
            }
        }
    }
    stop_agent_server_internal(&state)?;
    // 注：admAgent.json 由本地模型启动成功后统一写入（sync_local_model_capabilities），
    // 此处不再生成/更新，避免未运行模型时用空能力覆盖已写入的 can_reason / supports_images。

    let transport = AgentTransport::default_host();
    let agent_path = adm_agent_path(&app)?;
    if !agent_path.exists() {
        bail!("未找到 admAgent 工具: {}", agent_path.display());
    }

    let workdir = load_agent_workdir(&app);

    // 子进程工作目录：Windows 用二进制所在目录（exe 根目录，可写）；
    // macOS 二进制在只读性质的 ADM.app/Contents/MacOS 内，改用 app_data_dir，
    // 避免任何潜在的「在 bundle 内写文件」行为（配置在 ~/.config/admAgent、工作区靠 --cwd，均不依赖 cwd）。
    // 该目录同时作为「未配置工作目录」时创建 workspace 的默认路径：必须与子进程实际
    // 工作目录一致，否则模型读写文件的目录（workspace path）与用户认知分叉。
    let process_cwd = {
        #[cfg(target_os = "macos")]
        {
            config::get_data_dir(Some(&app))
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        }
        #[cfg(not(target_os = "macos"))]
        {
            agent_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".to_string())
        }
    };

    eprintln!("[admAgent] 使用本地传输 {} 启动 server 模式", transport.display());

    // 探测默认传输：已有 server 在跑则直接复用（多客户端共享同一 server）
    let probe_client = build_client(&transport, Duration::from_secs(2))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let mut child: Option<tokio::process::Child> = if health_check(&probe_client).await {
        eprintln!("[admAgent] 检测到已运行的 admAgent server，直接复用");
        None
    } else {
        // 没有运行中的 server：拉起子进程（不传 --host，服务端绑定平台默认传输）
        let mut cmd = tokio::process::Command::new(&agent_path);
        cmd.arg("server");
        if !workdir.is_empty() {
            cmd.arg("--cwd").arg(&workdir);
        }
        // 启动流程在健康检查/工作区创建阶段失败时自动终止子进程，避免错误路径留下孤儿。
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.current_dir(&process_cwd);

        #[cfg(target_os = "windows")]
        {
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 admAgent server 失败: {}", e))?;

        // 后台读取 stdout/stderr 用于日志记录，同时 emit "model-log" 事件到全局启动日志
        let app_for_stdout = app.clone();
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stdout = stdout;
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]);
                            for line in text.lines() {
                                if line.is_empty() { continue; }
                                eprintln!("[admAgent server] {}", line);
                                app_for_stdout.emit("model-log",
                                    serde_json::json!({ "line": format!("[Agent] {}", line), "source": "stdout" })).ok();
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        let app_for_stderr = app.clone();
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stderr = stderr;
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]);
                            for line in text.lines() {
                                if line.is_empty() { continue; }
                                eprintln!("[admAgent server ERROR] {}", line);
                                app_for_stderr.emit("model-log",
                                    serde_json::json!({ "line": format!("[Agent] {}", line), "source": "stderr" })).ok();
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        Some(child)
    };

    // 轮询健康检查端点，等待 server 就绪（15 秒）。若 spawn 后检测到 server 已可连
    // （并发启动的其它实例抢先 bind 成功、本进程子进程随即退出），视为复用成功。
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if health_check(&probe_client).await {
                break;
            }
            if let Some(c) = child.as_mut() {
                if let Ok(Some(_)) = c.try_wait() {
                    // 子进程已退出：再探一次，可连 = 并发复用；不可连 = 启动失败
                    if health_check(&probe_client).await {
                        child = None;
                        break;
                    }
                    bail!("admAgent server 进程已意外退出，退出码: 见上方日志");
                }
            }
            if tokio::time::Instant::now() > deadline {
                bail!("等待 admAgent server 启动超时（15秒），请检查 admAgent 是否正常");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    let client_id = format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        rand::random::<u32>(),
        rand::random::<u16>(),
        rand::random::<u16>(),
        rand::random::<u16>(),
        rand::random::<u64>() & 0xFFFFFFFFFFFF
    );

    let workspace_id = {
        let client = build_client(&transport, Duration::from_secs(5))
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let workdir_for_api = if workdir.is_empty() {
            // 未配置工作目录：用子进程实际工作目录（= 模型读写文件的目录），
            // 保证 workspace path 与模型操作目录一致，不用 ADM 主进程 cwd。
            process_cwd.clone()
        } else {
            workdir.clone()
        };

        let (status, bytes) = tokio::time::timeout(
            Duration::from_secs(10),
            agent_http::send(
                &client,
                "POST",
                "/v1/workspaces",
                Some(serde_json::json!({ "path": workdir_for_api, "client_id": &client_id })),
            ),
        )
        .await
        .map_err(|_| "创建工作区超时".to_string())?
        .map_err(|e| format!("创建工作区失败: {}", e))?;
        if !(200..300).contains(&status) {
            bail!("创建工作区失败: HTTP {}", status);
        }
        let body: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({}));
        body.get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "default".to_string())
    };

    let sse_stop = Arc::new(AtomicBool::new(false));

    let app2 = app.clone();
    let ws_id = workspace_id.clone();
    let cid = client_id.clone();
    let sse_stop2 = sse_stop.clone();
    let t2 = transport.clone();
    let sse_task = tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &t2, &ws_id, &cid, sse_stop2).await;
    });

    {
        let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
        *s = Some(AgentServerSession {
            child,
            sse_stop: sse_stop.clone(),
            sse_task: Some(sse_task),
            workspace_id: workspace_id.clone(),
            client_id: client_id.clone(),
        });
    }

    let host = transport.display();
    app.emit("agent-server-ready",
        serde_json::json!({ "host": host, "workspace_id": &workspace_id })).ok();

    Ok(AgentServerInfo { host, workspace_id, client_id })
}

async fn forward_sse_events(
    app: &tauri::AppHandle, transport: &AgentTransport, workspace_id: &str, client_id: &str, stop: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let path = format!("/v1/workspaces/{}/events?client_id={}", workspace_id, client_id);
    println!("[agent] forward_sse_events URL: {}", path);
    // SSE 是无限期长连接：只能限制建连耗时，绝不能给流本身设总超时（同原注释：
    // workspace 靠 SSE 流引用计数存活，最后一条流断开会立即 teardown workspace，
    // 触发 server 自身退出 —— "连接一断，服务即死"）。
    let client = build_client(transport, Duration::from_secs(5))
        .map_err(|e| format!("创建 SSE 客户端失败: {}", e))?;

    loop {
        if stop.load(Ordering::Relaxed) { return Ok(()); }
        let (status, body) = match agent_http::stream_get(&client, &path).await {
            Ok(r) => r,
            Err(e) => {
                if stop.load(Ordering::Relaxed) { return Ok(()); }
                // 连不上时检查 admAgent 进程是否已退出：已退出则通知前端自愈重启，
                // 避免在死进程上无限空转、前端只能看到 "admAgent server 未运行"
                if agent_process_exited(app) {
                    println!("[agent] forward_sse_events: admAgent 进程已退出，通知前端自动重启");
                    api_debug_log(|| "SSE ! admAgent 进程已退出，通知前端自动重启".to_string());
                    let _ = app.emit("agent-server-died", serde_json::json!({}));
                    return Ok(());
                }
                println!("[agent] forward_sse_events 连接失败: {}", e);
                api_debug_log(|| format!("SSE ! 连接失败: {}", e));
                tokio::time::sleep(Duration::from_secs(3)).await; continue;
            }
        };
        if !(200..300).contains(&status) {
            println!("[agent] forward_sse_events HTTP {}", status);
            tokio::time::sleep(Duration::from_secs(3)).await; continue;
        }
        println!("[agent] forward_sse_events SSE 已连接 workspace: {}", workspace_id);
        api_debug_log(|| format!("SSE = 已连接 workspace={} client={}", workspace_id, client_id));

        use futures_util::StreamExt;
        use http_body_util::BodyExt;
        let mut stream = body.into_data_stream();
        let mut buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            if stop.load(Ordering::Relaxed) { return Ok(()); }
            let chunk = match chunk_result { Ok(c) => c, Err(_) => break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find("\n\n") {
                let event_text = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();
                let mut event_type = String::new();
                let mut event_data = String::new();
                for line in event_text.lines() {
                    if let Some(d) = line.strip_prefix("event: ") { event_type = d.to_string(); }
                    else if let Some(d) = line.strip_prefix("data: ") { event_data = d.to_string(); }
                }
                if !event_data.is_empty() {
                    let payload: serde_json::Value = serde_json::from_str(&event_data)
                        .unwrap_or(serde_json::json!({ "raw": event_data }));
                    // 只写关键事件；流式增量/快照等噪音返回 None 不落盘。
                    api_debug_log(|| summarize_sse_event(&payload).unwrap_or_default());
                    let _ = app.emit("agent-sse-event", serde_json::json!({ "type": event_type, "data": payload }));
                }
            }
        }
        // 流断开后立即重连：admAgent 在最后一条 SSE 流断开的瞬间就会 teardown workspace，
        // 任何等待都在扩大 server 自杀的竞争窗口
        if !stop.load(Ordering::Relaxed) {
            println!("[agent] forward_sse_events 流断开，立即重连");
            api_debug_log(|| "SSE ! 流断开，立即重连".to_string());
        }
    }
}

/// 检查 admAgent server 子进程是否已退出（供 SSE 转发循环的自愈判断）。
/// 会话已被清理（正常 stop 流程）时返回 false，由 sse_stop 标志让循环自行退出。
/// 复用的共享 server（无子进程）无法探测进程状态，返回 true 让前端尝试重启：
/// start_agent_server 会先探活，真死才重新拉起，活着的共享 server 不受影响。
fn agent_process_exited(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let mut s = match state.agent_session.lock() { Ok(g) => g, Err(_) => return false };
    match s.as_mut() {
        Some(sess) => match sess.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => true,
        },
        None => false,
    }
}

// ===== 调试模式：admAgent API 交互日志（运行时开关，正式发布版也可用）=====
//
// 由设置里的“调试模式”开关控制（Settings.debug_logging，持久化到
// config.json）：启动时恢复、前端实时切换。关闭时 log_enabled 为 false，
// api_debug_log 一次 atomic load 即返回，无任何开销也不产生文件。

static LOG_ENABLED: AtomicBool = AtomicBool::new(false);
// 日志文件句柄：None = 尚未打开 / 打开失败。开关打开时截断重建，
// 为“每次重启软件自动清空上次日志”：重启后首次 enable 时 File::create 截断。
static LOG_FILE: std::sync::OnceLock<std::sync::Mutex<Option<std::fs::File>>> = std::sync::OnceLock::new();

fn log_file_cell() -> &'static std::sync::Mutex<Option<std::fs::File>> {
    LOG_FILE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 调试日志文件路径：app 数据目录（与 config.json 同处）下的 adm_api_debug.log。
/// 不用 exe 同目录：正式安装下 Windows 的 Program Files 不可写、macOS 会污染
/// .app 签名；app 数据目录始终可写且不影响安装包完整性。
fn api_debug_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = config::get_data_dir(Some(app)).ok()?;
    Some(dir.join("adm_api_debug.log"))
}

/// 开启调试日志：首次开启（含重启后）截断重建日志文件（清空上次），
/// 已处于开启态时幂等返回（不重复截断）——否则调试期间每次保存设置
/// 都会把本会话已积累的日志清空（排查中断时往往会顺手改模型/参数）。
/// 返回日志文件路径供前端展示。
fn enable_api_debug_log(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = api_debug_log_path(app)?;
    if LOG_ENABLED.load(Ordering::Relaxed) {
        return Some(path); // 已开启：保持追加，不重复截断
    }
    let file = std::fs::File::create(&path).ok()?; // 截断：从关到开 / 重启后首次全新
    if let Ok(mut cell) = log_file_cell().lock() {
        *cell = Some(file);
    }
    LOG_ENABLED.store(true, Ordering::Relaxed);
    println!("[agent] 调试日志已开启: {}", path.display());
    Some(path)
}

/// 关闭调试日志：置位关关、释放句柄并删除日志文件，避免过期日志残留
/// （否则“打开日志目录”会定位到一份不再更新的旧日志，容易误读）。
fn disable_api_debug_log(app: &tauri::AppHandle) {
    LOG_ENABLED.store(false, Ordering::Relaxed);
    if let Ok(mut cell) = log_file_cell().lock() {
        *cell = None;
    }
    if let Some(path) = api_debug_log_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

/// 单行日志内容去换行 + 截断。
fn api_log_snippet(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ↵ ");
    flat.chars().take(max).collect()
}

/// 写一条 admAgent API 交互日志。开关关闭时一次 atomic load 即返回（闭包
/// 不执行，无格式化开销）。与 devtools 控制台的 [agent] API / SSE 日志对应：
/// 所有前端请求都经 agent_http_request 代理、所有 SSE 事件都经
/// forward_sse_events 转发，在这两处落盘即可完整复盘对话中断问题。
/// 行格式：`{epoch_ms} {HH:MM:SS.mmm UTC} {内容}`，与 admAgent.log 对时时
/// 本地时间 = UTC + 本机时区偏移。
fn api_debug_log<F: FnOnce() -> String>(line: F) {
    if !LOG_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    use std::io::Write;
    if let Ok(mut cell) = log_file_cell().lock() {
        if let Some(f) = cell.as_mut() {
            let content = line();
            // 空内容（如 summarize_sse_event 对噪音事件返回 None）不写，
            // 避免产生只有时间戳的空行。
            if content.is_empty() { return; }
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let secs = ms / 1000;
            let _ = writeln!(
                f, "{} {:02}:{:02}:{:02}.{:03}Z {}",
                ms, (secs / 3600) % 24, (secs / 60) % 60, secs % 60, ms % 1000,
                content
            );
        }
    }
}

/// 把一条 SSE 事件精简为一行可排查摘要；返回 None 表示这类事件是噪音
/// （流式 message updated 增量、session token 快照等），不写日志。
/// 只保留能定位“对话为何中断/卡住”的关键节点：运行收尾、错误、权限、
/// 消息创建节奏、连接生命周期。SSE data 结构：
/// `{ type: <事件类型>, payload: { type: created|updated|deleted, payload: {..} } }`。
fn summarize_sse_event(payload: &serde_json::Value) -> Option<String> {
    let ev = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let inner = payload.pointer("/payload/type").and_then(|v| v.as_str()).unwrap_or("");
    let data = payload.pointer("/payload/payload");
    // 取 data 下的字符串字段（数字/布尔转成字面量），缺失返回空串。
    let field = |k: &str| -> String {
        match data.and_then(|d| d.get(k)) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => String::new(),
        }
    };
    match ev {
        // 运行收尾：最关键的一条。error 非空 = 服务端报错中断；
        // cancelled = 被取消；两者皆空 = 正常收尾（叙述性 stop / 完成）。
        "run_complete" => {
            let err = field("error");
            let has_err = !err.is_empty() && err != "null";
            let flag = if has_err { "! run_complete" } else { "< run_complete" };
            Some(format!(
                "{} run_id={} session={} error={} cancelled={} msg_id={}",
                flag, field("run_id"), field("session_id"), err, field("cancelled"), field("message_id")
            ))
        }
        // Agent 事件：错误 / 摘要（summarize）。
        "agent_event" => {
            let err = field("error");
            let has_err = !err.is_empty() && err != "null";
            let flag = if has_err { "! agent_event" } else { "< agent_event" };
            Some(format!("{} type={} session={} error={}", flag, field("type"), field("session_id"), err))
        }
        // 消息节奏：只记 created（新建 user/assistant/tool 消息），跳过 updated
        // 的流式增量（一轮上百条 thinking 是主噪音）。能看出“这轮到底产出了
        // 哪些消息”——全程只一条 assistant 无 tool = 叙述性 stop。
        "message" => {
            if inner != "created" { return None; }
            Some(format!("< message created role={} id={}", field("role"), field("id")))
        }
        // 权限请求 / 结果：Plan/Yolo 下一般直通，出现即值得记。
        "permission_request" => Some(format!("< permission_request tool={} session={}", field("tool_name"), field("session_id"))),
        "permission_notification" => Some(format!("< permission_notification granted={}", field("granted"))),
        // session 快照（context_tokens/is_busy 每次 token 变化都推）、file/lsp/
        // mcp/skills 等杂项：噪音，跳过。解析失败的原始事件仍记一行以便发现异常。
        "session" => None,
        "" if payload.get("raw").is_some() => Some(format!("< raw {}", api_log_snippet(&payload.get("raw").and_then(|v| v.as_str()).unwrap_or(""), 200))),
        _ => None,
    }
}

#[tauri::command]
pub async fn stop_agent_server(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    // 与启动共用同一把锁，避免启动尚未登记 session 时 stop 无效、随后进程又冒出来。
    let _start_guard = state.agent_start_lock.lock().await;
    stop_agent_server_internal(&state)
}

#[tauri::command]
pub async fn get_agent_server_status(state: tauri::State<'_, AppState>) -> Result<AgentServerStatus, AppError> {
    let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
    match s.as_mut() {
        Some(sess) => {
            let running = session_usable(sess);
            Ok(AgentServerStatus {
                running,
                host: Some(AgentTransport::default_host().display()),
                workspace_id: Some(sess.workspace_id.clone()),
            })
        }
        None => Ok(AgentServerStatus { running: false, host: None, workspace_id: None }),
    }
}

#[tauri::command]
pub async fn agent_http_request(
    state: tauri::State<'_, AppState>, method: String, path: String, body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    {
        let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
        match s.as_mut() {
            Some(sess) => {
                if !session_usable(sess) {
                    bail!("admAgent server 未运行");
                }
            }
            None => bail!("admAgent server 未运行"),
        }
    }
    let started = std::time::Instant::now();
    // 只读 GET 多为高频轮询（每轮 run 后刷 /agent /sessions /messages），是主噪音：
    // 成功时不记，只在出错时留痕；改状态的操作（发消息/切模式/权限）才记请求行。
    let is_get = method.eq_ignore_ascii_case("GET");
    if !is_get {
        api_debug_log(|| format!(
            "HTTP > {} {}{}",
            method.to_uppercase(), path,
            body.as_ref().map(|b| format!(" body={}", api_log_snippet(&b.to_string(), 800))).unwrap_or_default()
        ));
    }
    let client = build_client(&AgentTransport::default_host(), Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(120),
        agent_http::send(&client, &method, &path, body),
    )
    .await
    .map_err(|_| "HTTP 请求超时".to_string())?
    .map_err(|e| {
        // 网络失败一律留痕（含 GET）：连不上 server 是中断的关键线索。
        api_debug_log(|| format!("HTTP ! {} {} 请求失败({}ms): {}", method.to_uppercase(), path, started.elapsed().as_millis(), e));
        format!("HTTP 请求失败: {}", e)
    })?;

    // 无响应体的状态码直接返回空 JSON 对象
    // 202 Accepted: /agent 发送消息（fire-and-forget）
    // 204 No Content: 删除等操作
    if status == 202 || status == 204 {
        api_debug_log(|| format!("HTTP < {} {} {} ({}ms)", status, method.to_uppercase(), path, started.elapsed().as_millis()));
        return Ok(serde_json::json!({}));
    }

    // 对于 200 OK，尝试解析 JSON；如果解析失败（空 body），返回空对象
    // 这适用于 /agent/update 等成功但无 body 的接口
    if status == 200 {
        // 成功响应不 dump body（GET /messages 等会打一大坡）；只记非 GET 的一行状态+耗时。
        let result = serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({}));
        if !is_get {
            api_debug_log(|| format!("HTTP < 200 {} {} ({}ms)", method.to_uppercase(), path, started.elapsed().as_millis()));
        }
        return Ok(result);
    }

    // 其它状态码（4xx/5xx）：读取响应体作为错误抛出。
    // 此前会把错误 JSON 当成功结果返回，前端 Array.isArray 判定失败后静默降级为
    // 空列表/空聊天（表现为“列表加载不出来”且控制台无任何报错）
    let text = String::from_utf8_lossy(&bytes).to_string();
    let snippet: String = text.chars().take(300).collect();
    api_debug_log(|| format!(
        "HTTP ! {} {} {} ({}ms) err={}",
        status, method.to_uppercase(), path, started.elapsed().as_millis(),
        api_log_snippet(&snippet, 300)
    ));
    bail!("HTTP {} {} {}: {}", status, method.to_uppercase(), path, snippet);
}

/// 读取 workspace 的跨会话项目记忆（project_memory.json）。
/// admAgent 每次上下文压缩时会把 durable 的 constraint/decision anchors 同步进
/// `{workspace data_dir}/project_memory.json`（与 rail3.db 同级）。本命令先从
/// admAgent 取 workspace 的 data_dir，再读取该文件，仅用于前端只读展示。
/// 文件不存在或为空返回空数组。
#[tauri::command]
pub async fn read_project_memory(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<serde_json::Value, AppError> {
    {
        let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
        match s.as_mut() {
            Some(sess) => {
                if !session_usable(sess) {
                    bail!("admAgent server 未运行");
                }
            }
            None => bail!("admAgent server 未运行"),
        }
    }

    // GET /v1/workspaces/{id} → { id, path, data_dir, ... }
    let client = build_client(&AgentTransport::default_host(), Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(30),
        agent_http::send(&client, "GET", &format!("/v1/workspaces/{}", workspace_id), None),
    )
    .await
    .map_err(|_| "获取 workspace 信息超时".to_string())?
    .map_err(|e| format!("HTTP 请求失败: {}", e))?;
    if !(200..300).contains(&status) {
        bail!("HTTP {} 获取 workspace 信息失败", status);
    }
    let ws: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("解析 workspace 响应失败: {}", e))?;
    let data_dir = ws.get("data_dir").and_then(|v| v.as_str()).unwrap_or("");
    if data_dir.is_empty() {
        return Ok(serde_json::json!([]));
    }

    let path = std::path::Path::new(data_dir).join("project_memory.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            // 文件存在但内容非法/为空时按空处理，绝不让展示层报错
            Ok(serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!([])))
        }
        Err(_) => Ok(serde_json::json!([])),
    }
}

#[tauri::command]
pub async fn agent_subscribe_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    client_id: String,
) -> Result<(), AppError> {
    let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
    let sess = s.as_mut().ok_or("Agent server 未运行")?;

    // 停止旧的 SSE 转发任务（设标志，旧任务在下一个 chunk 到达时退出）
    sess.sse_stop.store(true, Ordering::Relaxed);
    let old_task = sess.sse_task.take();
    // 仅在切换到不同 workspace 时 abort 强制断开旧连接：
    // - 不 abort：空闲 workspace 没有事件，旧连接无限期挂着→被切走的 workspace
    //   靠僵尸连接"假活"，之后连接一断服务端立即 teardown，前端再用该 id 全是 404；
    //   此时新 workspace 由创建 hold 保活（设置弹窗先 POST 创建再切换），不受影响。
    // - 同 workspace 重订（页面挂载/断线重连）绝不能 abort：会产生零流间隙，
    //   服务端引用计数归零直接 teardown 当前 workspace；若它是最后一个，
    //   整个 server 立即自杀退出（表现为"admAgent 服务异常退出"）。
    //   让旧任务凭 stop 标志自然退出，新旧流短暂重叠由服务端 streams 计数兼容。
    if sess.workspace_id != workspace_id {
        if let Some(task) = old_task { task.abort(); }
    }

    // 创建新的停止标志并更新 session
    let new_sse_stop = Arc::new(AtomicBool::new(false));
    sess.sse_stop = new_sse_stop.clone();
    sess.workspace_id = workspace_id.clone();

    let transport = AgentTransport::default_host();

    // 启动新的 SSE 转发任务
    let app2 = app.clone();
    sess.sse_task = Some(tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &transport, &workspace_id, &client_id, new_sse_stop).await;
    }));

    Ok(())
}

#[tauri::command]
pub async fn agent_unsubscribe_events(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let mut s = state.agent_session.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = s.as_mut() {
        sess.sse_stop.store(true, Ordering::Relaxed);
        if let Some(task) = sess.sse_task.take() { task.abort(); }
    }
    Ok(())
}

pub fn kill_agent_session(state: &AppState) {
    let old = if let Ok(mut s) = state.agent_session.lock() { s.take() } else { None };
    if let Some(mut sess) = old {
        sess.sse_stop.store(true, Ordering::Relaxed);
        // 只终止本进程拉起的子进程；复用的共享 server 不杀（服务端在最后一个
        // 工作区被 teardown 时自行退出，其它客户端/实例不受影响）。
        if let Some(child) = sess.child.as_mut() {
            #[cfg(target_os = "windows")]
            {
                if let Some(pid) = child.id() {
                    let pid_str = pid.to_string();
                    let _ = platform::create_hidden_command("taskkill").args(["/PID", &pid_str, "/T", "/F"]).spawn();
                }
            }
            let _ = child.start_kill();
        }
    }
}

// ===== 日志管理 =====

/// 获取 admAgent 日志文件路径（<数据目录>/.admAgent/logs/admAgent.log）。
/// admAgent 的 DataDirectory 默认 ".admAgent" 按进程 cwd 解析，故日志落在进程 cwd 下：
/// - macOS：start_agent_server 把进程 cwd 设为 app_data_dir（避免写入只读的 App bundle）
/// - 其它平台：进程 cwd = admAgent 二进制所在目录
fn get_adm_agent_log_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "macos")]
    {
        return Ok(config::get_data_dir(Some(app))?
            .join(".admAgent")
            .join("logs")
            .join("admAgent.log"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let agent_path = adm_agent_path(app)?;
        let agent_dir = agent_path.parent().unwrap_or(std::path::Path::new("."));
        Ok(agent_dir
            .join(".admAgent")
            .join("logs")
            .join("admAgent.log"))
    }
}

/// 读取 admAgent 日志文件内容（返回最后 N 行，默认 2000 行）
#[tauri::command]
pub async fn get_adm_agent_logs(app: tauri::AppHandle, tail: Option<usize>) -> Result<String, AppError> {
    let log_path = get_adm_agent_log_path(&app)?;
    if !log_path.exists() {
        return Ok("（admAgent 日志文件不存在: {}）".to_string().replace("{}", &log_path.display().to_string()));
    }

    let content = tokio::fs::read_to_string(&log_path)
        .await
        .map_err(|e| format!("读取日志文件失败: {}", e))?;

    let tail_n = tail.unwrap_or(2000);
    if tail_n > 0 {
        let lines: Vec<&str> = content.lines().collect();
        let start = if lines.len() > tail_n { lines.len() - tail_n } else { 0 };
        Ok(lines[start..].join("\n"))
    } else {
        Ok(content)
    }
}

/// 导出 admAgent 日志到用户指定的文件路径
#[tauri::command]
pub async fn export_agent_logs(app: tauri::AppHandle) -> Result<(), AppError> {
    use tauri_plugin_dialog::DialogExt;

    let log_path = get_adm_agent_log_path(&app)?;
    if !log_path.exists() {
        bail!("admAgent 日志文件不存在: {}", log_path.display());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("日志文件", &["log", "txt"])
        .add_filter("所有文件", &["*"])
        .set_file_name("admAgent.log")
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.await.map_err(|_| "保存对话框失败".to_string())?;
    let file_path = file_path.ok_or_else(|| "用户取消了保存".to_string())?;

    let dest_path = file_path
        .as_path()
        .ok_or_else(|| "无法获取保存路径".to_string())?;

    tokio::fs::copy(&log_path, dest_path)
        .await
        .map_err(|e| format!("导出日志失败: {}", e))?;

    Ok(())
}

/// 弹出系统目录选择对话框，返回用户选择的目录路径
#[tauri::command]
pub async fn pick_workdir_folder(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let path = rx
        .await
        .map_err(|_| "选择目录对话框失败".to_string())?;
    let path = path.ok_or_else(|| "用户取消了选择".to_string())?;

    let path = path
        .into_path()
        .map_err(|e| format!("无法获取目录路径: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// 启动时根据持久化设置恢复调试日志开关（config.json 的 debug_logging）。
/// 开启时截断重建日志文件 —— 实现“每次重启软件自动清空上次日志”。
/// 在 setup 阶段调用，早于任何 admAgent 交互。
pub fn init_debug_logging(app: &tauri::AppHandle) {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return,
    };
    let config_path = data_dir.join("config.json");
    let enabled = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|json| serde_json::from_str::<Settings>(&json).ok())
        .map(|s| s.debug_logging)
        .unwrap_or(false);
    if enabled {
        enable_api_debug_log(app);
    }
}

/// 设置调试日志开关（前端实时切换）。开启时首次截断重建日志文件（清空上次），
/// 返回日志文件绝对路径；关闭时释放句柄并删除旧日志、返回空串。
/// 运行时开关与编译 profile 无关，正式发布版同样生效。
#[tauri::command]
pub async fn set_debug_logging(app: tauri::AppHandle, enabled: bool) -> Result<String, AppError> {
    if enabled {
        match enable_api_debug_log(&app) {
            Some(path) => Ok(path.to_string_lossy().to_string()),
            None => bail!("无法创建调试日志文件"),
        }
    } else {
        disable_api_debug_log(&app);
        Ok(String::new())
    }
}

/// 在系统文件管理器中打开调试日志所在位置（app 数据目录）。
/// 日志文件已存在时定位并高亮该文件；尚未生成时（未开过调试）
/// 打开其所在目录。
#[tauri::command]
pub async fn open_debug_log_dir(app: tauri::AppHandle) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let path = api_debug_log_path(&app).ok_or("无法确定调试日志路径")?;
    if path.exists() {
        // 文件存在：在文件管理器中定位并高亮
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| format!("打开日志目录失败: {}", e))?;
    } else {
        // 文件不存在（未开过调试）：打开所在目录
        let dir = path.parent().ok_or("无法确定日志目录")?;
        app.opener()
            .open_path(dir.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }
    Ok(())
}

/// 读取粘贴/拖入的文件内容，供前端作为附件发送（图片走浏览器剪贴板直读，
/// 文本等文件剪贴板只带路径，需在此读取真实内容）。
/// 返回文件名与 base64 编码内容；MIME 由前端按扩展名推断（与选择器逻辑一致）。
#[tauri::command]
pub async fn read_attachment_file(path: String) -> Result<serde_json::Value, AppError> {
    use base64::Engine;
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    if !meta.is_file() {
        bail!("不是文件: {}", p.display());
    }
    const MAX_ATTACH_SIZE: u64 = 20 * 1024 * 1024;
    if meta.len() > MAX_ATTACH_SIZE {
        bail!("文件过大: {} (最大 20MB)", p.display());
    }
    let data = std::fs::read(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(serde_json::json!({ "name": name, "base64": b64 }))
}

/// 判断路径是否为目录。粘贴"复制的文件夹"时前端据此把目录路径作为文本插入
/// 输入框（而不是报"暂不支持该格式"），方便告知模型文件所在目录。
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
}

/// 把前端传入的 base64 附件内容写入持久附件目录，返回磁盘绝对路径。
/// 所有附件（文本/图片，不再区分大小）统一落盘传路径，由 coordinator 收集路径
/// 注入 <system_info> 读取引导（文本→view、图片→vision），避免内联 base64 触发
/// 70% 上下文守卫死循环。落盘目录为 ADM 数据目录下的 attachments/（持久，不随
/// 系统清理临时目录而失效；与 coordinator 的 session 级附件目录共用清理策略）。
/// 浏览器选择/拖拽的 File 对象没有磁盘路径，需在此落盘；粘贴路径场景前端直接
/// 持有真实路径，无需调用本命令。
/// 注意：rename_all = "snake_case" 使前端沿用 file_name / base64_content 参数名
/// （Tauri 默认按 camelCase 收参，会要求 fileName / base64Content）。
#[tauri::command(rename_all = "snake_case")]
pub async fn save_attachment_file(
    app: tauri::AppHandle,
    file_name: String,
    base64_content: String,
) -> Result<String, AppError> {
    use base64::Engine;
    use std::time::{SystemTime, UNIX_EPOCH};
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_content)
        .map_err(|e| format!("附件 base64 解码失败: {}", e))?;
    // 安全化文件名：仅保留字母数字、点、下划线、连字符，防路径穿越
    let safe_name: String = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    let safe_name = if safe_name.is_empty() {
        "attachment".to_string()
    } else {
        safe_name
    };
    let data_dir = config::get_data_dir(Some(&app))?;
    let dir = data_dir.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败: {}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{}_{}", ts, safe_name));
    std::fs::write(&path, &data).map_err(|e| format!("写入附件文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取系统剪贴板中的文件路径列表（Windows 资源管理器复制文件时为 CF_HDROP 格式；
/// macOS Finder 复制文件时为 NSPasteboard 的 NSFilenamesPboardType / public.file-url）。
/// 返回空数组表示剪贴板无文件（复制的是文本/图片等）。WKWebView 不把 Finder 复制的
/// 文件暴露给网页 DataTransfer，故在 Rust 侧直读剪贴板。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    let mut paths: Vec<String> = Vec::new();
    unsafe {
        if OpenClipboard(None).is_err() {
            return Ok(paths);
        }
        // 枚举剪贴板格式，定位 CF_HDROP（文件列表）
        let mut fmt: u32 = 0;
        loop {
            let next = EnumClipboardFormats(fmt);
            if next == 0 {
                break;
            }
            fmt = next;
            if fmt == CF_HDROP.0 as u32 {
                if let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) {
                    if !handle.0.is_null() {
                        let ptr = GlobalLock(HGLOBAL(handle.0));
                        if !ptr.is_null() {
                            let hdrop = HDROP(ptr);
                            let count = DragQueryFileW(hdrop, u32::MAX, None);
                            for i in 0..count {
                                let len = DragQueryFileW(hdrop, i, None);
                                if len == 0 {
                                    continue;
                                }
                                let mut buf = vec![0u16; (len + 1) as usize];
                                DragQueryFileW(hdrop, i, Some(&mut buf));
                                let s = String::from_utf16_lossy(&buf[..len as usize]);
                                if !s.is_empty() {
                                    paths.push(s);
                                }
                            }
                            let _ = GlobalUnlock(HGLOBAL(handle.0));
                        }
                    }
                }
                break;
            }
        }
        let _ = CloseClipboard();
    }
    Ok(paths)
}

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(deprecated)] // NSFilenamesPboardType 已废弃但仍是最权威的多文件来源
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    use objc2_app_kit::{NSPasteboard, NSFilenamesPboardType, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSString};

    let mut paths: Vec<String> = Vec::new();
    let pb = NSPasteboard::generalPasteboard();

    unsafe {
        // Finder/AppKit 复制文件：NSFilenamesPboardType 为权威类型（路径字符串数组）
        if let Some(plist) = pb.propertyListForType(&NSFilenamesPboardType) {
            if let Ok(arr) = plist.downcast::<NSArray>() {
                for s in arr.iter() {
                    if let Some(str) = s.downcast_ref::<NSString>() {
                        let p = str.to_string();
                        if !p.is_empty() {
                            paths.push(p);
                        }
                    }
                }
                if !paths.is_empty() {
                    return Ok(paths);
                }
            }
        }

        // 兜底：逐条读取 public.file-url（file:///path → /path；多选文件时每个文件一个 item）
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                if let Some(s) = item.stringForType(&NSPasteboardTypeFileURL) {
                    let url = s.to_string();
                    let path = url.strip_prefix("file://").map(str::to_string).unwrap_or(url);
                    if !path.is_empty() && !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    Ok(paths)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

