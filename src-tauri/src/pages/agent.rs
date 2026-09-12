// Agent 页面后端逻辑：admAgent server 模式管理 + HTTP API 代理

use crate::app_state::{AppState, AgentServerSession};
use crate::common::agent_http::{self, AgentTransport, build_client, health_check};
use crate::common::config;
use crate::common::types::{Settings, WorkDirEntry};
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
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
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
            // 迁移在 adm_agent_config_dir() 内部触发，此时不能走
            // update_adm_agent_config（它会再调 adm_agent_config_dir → 递归 + Mutex 重入）。
            // 直接用原子写：临时文件 + rename，不截断目标文件（写前照常备份旧内容）。
            write_json_atomic(&new_path, &new_value, true)?;
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
/// 读取失败、字段缺失或显式为 None 时返回 5678（llama-server 默认端口，UI 已不再允许修改）。
fn load_port(app: &tauri::AppHandle) -> u16 {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return DEFAULT_PORT,
    };
    let config_path = data_dir.join("config.json");
    let json = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return DEFAULT_PORT,
    };
    let settings: Settings = match serde_json::from_str(&json) {
        Ok(s) => s,
        Err(_) => return DEFAULT_PORT,
    };
    settings.launch_params.port.unwrap_or(DEFAULT_PORT)
}

// 注：原先的 build_adm_agent_config() 已删除。
// 它只产出 { model, providers.local } 两个键，一旦被用于「整文件覆盖」就会清空
// agent_proxy / agent_vision_model / options / 全部云端 provider。
// 结构补齐统一由 ensure_adm_agent_config 的字段级补丁完成。

/// 确保 admAgent.json 里 `providers.local` 的结构与当前本地模型能力一致。
///
/// 与旧实现的本质区别：**只补齐缺失字段，绝不整文件覆盖**。
///
/// 旧实现在 `providers.local.models[0]` 不存在（或 base_url 缺失）时会退回
/// `build_adm_agent_config()` 重写整个文件，把 agent_proxy / agent_vision_model /
/// options / 全部云端 provider 一并清掉 —— 用户看到的「云端模型全部消失」就源于此。
/// 现在改为逐级 `entry().or_insert()` 补丁，任何情况下都不动其它字段。
fn ensure_adm_agent_config(app: &tauri::AppHandle) -> Result<(), AppError> {
    let ctx = load_ctx_size(app)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW as i32) as u32;

    let port = load_port(app);

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

    let default_max_tokens = (ctx as f64 * 0.3).round() as u32;
    let base_url = format!("http://127.0.0.1:{}/v1", port);

    update_adm_agent_config(|v| {
        let root = v
            .as_object_mut()
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：根节点不是对象"))?;

        let providers = root
            .entry("providers")
            .or_insert_with(|| serde_json::json!({}));
        if !providers.is_object() {
            return Err(AppError::msg("admAgent.json 结构异常：providers 不是对象"));
        }

        let local = providers
            .as_object_mut()
            .unwrap()
            .entry("local")
            .or_insert_with(|| serde_json::json!({}));
        if !local.is_object() {
            return Err(AppError::msg(
                "admAgent.json 结构异常：providers.local 不是对象",
            ));
        }
        let local = local.as_object_mut().unwrap();

        local.insert("type".to_string(), serde_json::json!("openai-compat"));
        local.insert("name".to_string(), serde_json::json!("Local"));
        local.insert("base_url".to_string(), serde_json::json!(base_url));

        let models = local
            .entry("models")
            .or_insert_with(|| serde_json::json!([]));
        if !models.is_array() {
            return Err(AppError::msg(
                "admAgent.json 结构异常：providers.local.models 不是数组",
            ));
        }
        let models = models.as_array_mut().unwrap();

        if models.is_empty() {
            models.push(serde_json::json!({"id": "localModel", "name": "Local Model"}));
        }
        let first = models
            .first_mut()
            .ok_or_else(|| AppError::msg("providers.local.models 为空"))?;
        if !first.is_object() {
            return Err(AppError::msg(
                "admAgent.json 结构异常：providers.local.models[0] 不是对象",
            ));
        }
        let first = first.as_object_mut().unwrap();

        first.insert("id".to_string(), serde_json::json!("localModel"));
        first.insert("name".to_string(), serde_json::json!("Local Model"));
        first.insert("context_window".to_string(), serde_json::json!(ctx));
        first.insert(
            "default_max_tokens".to_string(),
            serde_json::json!(default_max_tokens),
        );
        first.insert(
            "supports_images".to_string(),
            serde_json::json!(supports_images),
        );

        // 推理能力同步：支持时写全推理元数据，不支持时写 false 并清理可能残留的旧值
        if supports_reasoning {
            first.insert("can_reason".to_string(), serde_json::json!(true));
            first.insert(
                "reasoning_levels".to_string(),
                serde_json::json!(["low", "medium", "high"]),
            );
            first.insert(
                "default_reasoning_effort".to_string(),
                serde_json::json!("medium"),
            );
        } else {
            first.insert("can_reason".to_string(), serde_json::json!(false));
            first.remove("reasoning_levels");
            first.remove("default_reasoning_effort");
        }
        Ok(())
    })
}

/// 进程内串行化对 admAgent.json 的「读-改-写」操作。
///
/// 只覆盖本进程：跨进程（与 admAgent server 之间）的互斥由
/// [`acquire_config_lock`] 负责，两者在 [`update_adm_agent_config`] 中组合使用。
/// 注意：std Mutex **不可重入** —— 调用方不得在持有本锁时再次进入。
static ADM_AGENT_CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ============================================================================
// admAgent.json：跨进程互斥 + 原子落盘 + 统一写入入口
//
// 背景：本文件在 Windows 上与 admAgent server（Go）的数据配置是同一个文件
// （%LOCALAPPDATA%/admAgent/admAgent.json）。旧实现有三个致命缺陷：
//   1. std::fs::write 非原子（先截断），留下文件为 0 字节的窗口；
//   2. Go 侧读到空串时不报错，把空文档当新表，写回后只剩本次设置的字段；
//   3. 解析失败静默回退 build_adm_agent_config()，整文件覆盖清空云端 provider。
// 三者叠加导致切换模型时 admAgent.json 被反复清空。
// ============================================================================

/// 与 admAgent server（Go）共用同一把锁。
/// Go 侧 `ConfigStore.lockConfig` 用的是 `lock.File(path + ".lock")`，
/// 这里必须对**同一个文件**加锁才能做到跨进程互斥。
/// 锁范围与 Go 保持一致（0 .. u32::MAX），否则 Windows 上不会真正互斥。
fn adm_agent_lock_path() -> Result<PathBuf, AppError> {
    Ok(adm_agent_config_dir()?.join("admAgent.json.lock"))
}

/// 等待锁的最长时间。需大于 Go 侧的 configLockDeadline（5s）。
const CONFIG_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CONFIG_LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// 跨进程排他锁句柄，Drop 时自动解锁并关闭文件。
struct ConfigFileLock {
    file: std::fs::File,
}

#[cfg(windows)]
fn try_lock(file: &std::fs::File) -> Result<bool, AppError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows::Win32::System::IO::OVERLAPPED;

    // 锁范围与 Go 的 LockFileEx(0, MaxUint32, MaxUint32) 对齐，否则不互斥
    let mut ov = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    let ok = unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut ov,
        )
    };
    Ok(ok.is_ok())
}

#[cfg(unix)]
fn try_lock(file: &std::fs::File) -> Result<bool, AppError> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(false);
    }
    Err(AppError::msg(format!("flock 失败: {}", e)))
}

#[cfg(windows)]
fn unlock(file: &std::fs::File) -> Result<(), AppError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::UnlockFileEx;
    use windows::Win32::System::IO::OVERLAPPED;

    // UnlockFileEx 只按范围定位，offset 0 + 相同长度即可
    let mut ov = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    unsafe { UnlockFileEx(HANDLE(file.as_raw_handle()), 0, u32::MAX, u32::MAX, &mut ov) }
        .map_err(|e| AppError::msg(format!("解锁 admAgent.json 失败: {}", e)))
}

#[cfg(unix)]
fn unlock(file: &std::fs::File) -> Result<(), AppError> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if rc == 0 {
        Ok(())
    } else {
        Err(AppError::msg(format!(
            "解锁 admAgent.json 失败: {}",
            std::io::Error::last_os_error()
        )))
    }
}

impl Drop for ConfigFileLock {
    fn drop(&mut self) {
        let _ = unlock(&self.file);
    }
}

/// 获取跨进程排他锁，最多等待 [`CONFIG_LOCK_TIMEOUT`]。
fn acquire_config_lock() -> Result<ConfigFileLock, AppError> {
    let path = adm_agent_lock_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // 锁文件只作 flock 载体，绝不能截断（可能有并发持有者）
        .open(&path)
        .map_err(|e| format!("打开锁文件失败: {}", e))?;

    let started = std::time::Instant::now();
    loop {
        if try_lock(&file)? {
            return Ok(ConfigFileLock { file });
        }
        if started.elapsed() > CONFIG_LOCK_TIMEOUT {
            return Err(AppError::msg("获取 admAgent.json 锁超时（10s）"));
        }
        std::thread::sleep(CONFIG_LOCK_RETRY);
    }
}

/// 原子落盘：写临时文件后 rename，**绝不在目标文件上截断**。
///
/// rename 是原子的，并发读者要么看到旧内容要么看到新内容，
/// 不可能看到空文件或半截 JSON —— 这正是旧实现的致命伤。
fn write_json_atomic(
    path: &std::path::Path,
    value: &serde_json::Value,
    keep_backup: bool,
) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 admAgent 配置失败: {}", e))?;

    let dir = path.parent().ok_or_else(|| AppError::msg("配置路径缺少父目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;

    // 写前备份：保留最近一份可用快照，便于人工回滚（失败不影响主流程）。
    // 从备份恢复时必须传 false —— 此时目标文件已损坏，复制会把唯一的好备份覆盖掉。
    if keep_backup {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 0 {
                // 原子复制：admAgent server（Go）也在写同一个 .bak（同一把 flock，
                // 但读取方无锁），避免读者看到半截备份
                if let Err(e) = copy_file_atomic(path, &dir.join("admAgent.json.bak")) {
                    api_debug_log(|| format!("Config ! 写前备份失败: {}", e));
                }
            }
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("admAgent.json.{}.{}.tmp", std::process::id(), nanos));

    std::fs::write(&tmp, &json).map_err(|e| format!("写入临时配置失败: {}", e))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(AppError::msg(format!("替换配置文件失败: {}", e)))
        }
    }
}

/// 对 admAgent.json 做一次完整的「加锁 → 读 → 改 → 原子写」。
///
/// 三层保护：
/// - 进程内串行：`ADM_AGENT_CONFIG_LOCK`
/// - 跨进程串行：flock `admAgent.json.lock`（与 Go server 同一把锁）
/// - 落盘原子：临时文件 + rename
///
/// 文件不存在时以 `{}` 起步；**文件存在但为空或 JSON 非法时一律返回错误**，
/// 绝不回退默认结构 —— 旧实现正是靠这个回退把用户的云端 provider 全清掉了。
///
/// `mutate` 必须是纯内存变换：内部不得再调用本函数（std Mutex 不可重入）。
fn update_adm_agent_config<T>(
    mutate: impl FnOnce(&mut serde_json::Value) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _inproc = ADM_AGENT_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _filelock = acquire_config_lock()?;

    let dir = adm_agent_config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let path = dir.join("admAgent.json");

    let mut v = if path.exists() {
        let s = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
        if s.trim().is_empty() {
            let msg = "admAgent.json 为空，拒绝写入（可能有并发写正在截断文件）";
            notify_config_corrupt(msg);
            return Err(AppError::msg(msg));
        }
        serde_json::from_str::<serde_json::Value>(&s).map_err(|e| {
            let msg = format!("解析 admAgent.json 失败: {}", e);
            notify_config_corrupt(&msg);
            AppError::msg(msg)
        })?
    } else {
        serde_json::json!({})
    };

    let out = mutate(&mut v)?;
    write_json_atomic(&path, &v, true)?;
    // 改动后校验：落盘内容必须仍是合法 JSON（防御并发写 / 磁盘异常造成的损坏）。
    // 失败不自动回滚，统一交给损坏恢复流程：弹窗提示 → 用户确认 → 从备份恢复。
    if let Err(e) = read_config_json(&path) {
        let msg = format!("写入后校验失败: {}", e);
        notify_config_corrupt(&msg);
        return Err(AppError::msg(msg));
    }
    Ok(out)
}

// ===== admAgent.json 备份与损坏恢复 =====
// 目标：首次启动即保留一份可用备份；每次改动前自动备份（见 write_json_atomic）；
// 检测到损坏时弹原生提示，用户确认后自动从备份恢复并触发服务端重载。

/// 恢复流程使用的 AppHandle（setup 阶段写入；未初始化时所有提示静默跳过）
static CONFIG_RECOVERY_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
/// 恢复提示是否正在展示（并发检测只弹一个对话框）
static CONFIG_PROMPT_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 用户本次会话选择「暂不恢复」（不再重复弹窗骚扰）
static CONFIG_PROMPT_DECLINED: AtomicBool = AtomicBool::new(false);

/// admAgent.json 主文件与备份文件的完整路径
fn adm_agent_config_file_paths() -> Result<(PathBuf, PathBuf), AppError> {
    let dir = adm_agent_config_dir()?;
    Ok((dir.join("admAgent.json"), dir.join("admAgent.json.bak")))
}

/// 读取并校验一份配置：非空且必须是合法 JSON
fn read_config_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let s = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    if s.trim().is_empty() {
        return Err(format!("{} 为空", path.display()));
    }
    serde_json::from_str::<serde_json::Value>(&s)
        .map_err(|e| format!("解析 {} 失败: {}", path.display(), e))
}

/// 读取可用备份；不存在 / 为空 / 非法 JSON 一律视为不可用
fn read_valid_backup() -> Result<serde_json::Value, String> {
    let (_, bak) = adm_agent_config_file_paths().map_err(|e| e.to_string())?;
    if !bak.exists() {
        return Err(format!("未找到备份文件 {}", bak.display()));
    }
    read_config_json(&bak)
}

/// 原子复制文件（先写临时文件再 rename），避免留下半截备份
fn copy_file_atomic(src: &std::path::Path, dst: &std::path::Path) -> Result<(), AppError> {
    let dir = dst.parent().ok_or_else(|| AppError::msg("备份路径缺少父目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let name = dst
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "admAgent.json.bak".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{}.{}.{}.tmp", name, std::process::id(), nanos));
    std::fs::copy(src, &tmp).map_err(|e| format!("复制备份失败: {}", e))?;
    match std::fs::rename(&tmp, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(AppError::msg(format!("替换备份失败: {}", e)))
        }
    }
}

/// 首次启动备份：主文件有效、且备份缺失或已损坏时，用当前配置创建 .bak。
/// 已有有效备份时不覆盖 —— 它是上一份可用快照，损坏恢复依赖它。
fn ensure_agent_config_backup() {
    let (main, bak) = match adm_agent_config_file_paths() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !main.exists() || read_config_json(&main).is_err() {
        return; // 主文件缺失/已损坏：保留现有备份供恢复使用
    }
    if bak.exists() && read_config_json(&bak).is_ok() {
        return;
    }
    match copy_file_atomic(&main, &bak) {
        Ok(()) => api_debug_log(|| "Config: 已创建 admAgent.json 首次启动备份".to_string()),
        Err(e) => api_debug_log(|| format!("Config ! 创建 admAgent.json 备份失败: {}", e)),
    }
}

/// 检测主配置是否损坏；损坏时走统一的恢复提示（正常时静默）
fn check_agent_config_corruption() {
    let (main, _) = match adm_agent_config_file_paths() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !main.exists() {
        return;
    }
    if let Err(e) = read_config_json(&main) {
        notify_config_corrupt(&e);
    }
}

/// 启动时初始化配置备份与损坏恢复：
/// 1) 首次启动备份（主文件有效且备份缺失/损坏时创建 .bak）；
/// 2) 延时等主窗口显示后检测主文件，损坏则弹恢复提示。
pub fn init_agent_config_recovery(app: &tauri::AppHandle) {
    let _ = CONFIG_RECOVERY_APP.set(app.clone());
    tauri::async_runtime::spawn(async move {
        ensure_agent_config_backup();
        // 稍等主窗口渲染完成再弹窗，避免对话框早于界面出现
        tokio::time::sleep(Duration::from_millis(1200)).await;
        check_agent_config_corruption();
    });
}

/// 检测到 admAgent.json 损坏时弹出原生提示（每次会话最多一次）：
/// - 备份可用：询问是否恢复；确认后自动恢复并触发服务端重载，再 emit
///   `agent-config-restored` 通知前端（服务未起来时前端会重跑 init）；
/// - 备份不可用：仅提示文件路径，引导手动处理，不自动改动文件。
fn notify_config_corrupt(detail: &str) {
    let app = match CONFIG_RECOVERY_APP.get() {
        Some(a) => a.clone(),
        None => return, // setup 之前的早期检测：由启动检查负责提示
    };
    if CONFIG_PROMPT_DECLINED.load(Ordering::Relaxed) {
        return;
    }
    if CONFIG_PROMPT_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // 已有提示在展示
    }

    api_debug_log(|| format!("Config ! admAgent.json 异常: {}", detail));
    let main_path = adm_agent_config_file_paths()
        .map(|(m, _)| m.display().to_string())
        .unwrap_or_default();

    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    match read_valid_backup() {
        Ok(_) => {
            app.dialog()
                .message(format!(
                    "检测到 admAgent 配置文件异常，无法读取：\n{}\n\n文件：{}\n\n是否从备份恢复？恢复后会自动重新加载服务配置。",
                    detail, main_path
                ))
                .title("admAgent 配置文件异常")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "恢复备份".to_string(),
                    "暂不恢复".to_string(),
                ))
                .show(move |confirmed| {
                    CONFIG_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
                    if !confirmed {
                        CONFIG_PROMPT_DECLINED.store(true, Ordering::SeqCst);
                        api_debug_log(|| "Config: 用户选择暂不恢复".to_string());
                        return;
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        match restore_agent_config_from_backup(&app) {
                            Ok(()) => {
                                api_debug_log(|| "Config: 已从备份恢复 admAgent.json，触发服务端重载".to_string());
                                let _ = app.emit("agent-config-restored", serde_json::json!({ "ok": true }));
                            }
                            Err(e) => {
                                api_debug_log(|| format!("Config ! 从备份恢复失败: {}", e));
                                let _ = app.emit(
                                    "agent-config-restored",
                                    serde_json::json!({ "ok": false, "error": e.to_string() }),
                                );
                            }
                        }
                    });
                });
        }
        Err(reason) => {
            app.dialog()
                .message(format!(
                    "检测到 admAgent 配置文件异常，无法读取：\n{}\n\n备份不可用：{}\n\n请手动检查或删除该文件后重启 ADM（删除会丢失其中保存的云端模型配置）：\n{}",
                    detail, reason, main_path
                ))
                .title("admAgent 配置文件异常")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .show(move |_| {
                    CONFIG_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
                    CONFIG_PROMPT_DECLINED.store(true, Ordering::SeqCst);
                });
        }
    }
}

/// 从备份恢复 admAgent.json（原子写），并触发服务端从磁盘全量重载。
/// 不走 update_adm_agent_config：当前主文件已损坏，其写前备份会把唯一的好备份覆盖掉。
fn restore_agent_config_from_backup(app: &tauri::AppHandle) -> Result<(), AppError> {
    let (main, _) = adm_agent_config_file_paths()?;
    // 与常规写入共用同一把进程内/跨进程锁，避免与并发写互相踩踏；
    // 先加锁再读备份：Go/Rust 都会在写前重写 .bak，无锁读可能读到半截文件
    let _inproc = ADM_AGENT_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _filelock = acquire_config_lock()?;
    let value = read_valid_backup().map_err(AppError::msg)?;
    write_json_atomic(&main, &value, false)?;
    request_server_config_reload(app);
    Ok(())
}

/// 请求 admAgent server 从磁盘全量重载配置（POST /config/set 写一个无害标量触发）。
/// 服务未运行 / 无活跃工作区时静默跳过 —— 下次启动会自然读到新配置。
/// 失败仅记日志：重载不生效只是沿用旧配置，不影响主流程。
fn request_server_config_reload(app: &tauri::AppHandle) {
    let ws = {
        let state = app.state::<AppState>();
        let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
        match active {
            Some(ws_id) if !ws_id.is_empty() => ws_id,
            _ => {
                api_debug_log(|| "Config: 无活跃工作区，跳过服务端配置重载".to_string());
                return;
            }
        }
    };
    let client = match build_client(&AgentTransport::default_host(), Duration::from_secs(3)) {
        Ok(c) => c,
        Err(_) => return,
    };
    tauri::async_runtime::spawn(async move {
        let set_body = serde_json::json!({ "scope": 0, "key": "providers.local.name", "value": "Local" });
        match tokio::time::timeout(
            Duration::from_secs(10),
            agent_http::send(&client, "POST", &format!("/v1/workspaces/{}/config/set", ws), Some(set_body)),
        )
        .await
        {
            Ok(Ok((st, _))) if (200..300).contains(&st) => {
                api_debug_log(|| "Config: /config/set 热重载完成".to_string());
            }
            Ok(Ok((st, _))) => {
                api_debug_log(|| format!("Config ! /config/set HTTP {}", st));
            }
            Ok(Err(e)) => {
                api_debug_log(|| format!("Config ! /config/set 失败: {}", e));
            }
            Err(_) => {
                api_debug_log(|| "Config ! /config/set 超时".to_string());
            }
        }
    });
}

/// 模型启动成功后同步本地模型能力（supports_images / can_reason / context_window）到 admAgent：
/// 1) ensure_adm_agent_config 把最新能力写入 admAgent.json；
/// 2) 若 server 正在运行，POST /config/set 写一个无害标量触发服务端写盘+从磁盘全量重载
///    （服务端只在启动时读配置，SetConfigField 是唯一的热重载入口；
///    不能直接写 models 数组元素：/config/set 落盘到服务端数据配置文件，
///    与 Rust 写的 admAgent.json 合并时数组按拼接处理，会造成模型重复）；
/// 3) POST /agent/update 重建 coordinator 内的 agent，使新 ModelInfo 即时生效。
///    统一视觉链路下 supports_images 不再决定图片处理（图片一律走 vision bridge），
///    仅用于前端 UI 展示与「多模态模型」下拉（agent_vision_model）筛选。
///    失败静默：server 未运行时下次启动自然读到新配置。
pub fn sync_local_model_capabilities(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // ensure_adm_agent_config 内部通过 update_adm_agent_config 自行加锁
        // （进程内 Mutex 不可重入，此处不能再持锁）
        let ensure_result = ensure_adm_agent_config(&app);
        if let Err(e) = ensure_result {
            eprintln!("[admAgent] 同步本地模型能力：写 admAgent.json 失败: {}", e);
            return;
        }
        let ws = {
            let state = app.state::<AppState>();
            let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
            match active {
                Some(ws_id) if !ws_id.is_empty() => ws_id,
                _ => return, // 无激活 workspace
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
        let changed = {
            // 锁由 update_adm_agent_config 统一获取（进程内 Mutex + 跨进程 flock）
            write_agent_vision_model(&value)
        };
        let changed = match changed {
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
            let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
            match active {
                Some(ws_id) if !ws_id.is_empty() => ws_id,
                _ => return, // 无激活 workspace
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
/// 校验目标模型在 providers 中声明 supports_images=true，否则回退内置。
/// 返回是否真的发生了变更（供调用方决定是否触发服务端重载）。
fn write_agent_vision_model(value: &str) -> Result<bool, AppError> {
    let (provider, model) = match value.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => (p.to_string(), m.to_string()),
        _ => ("admAgent".to_string(), "admImage-model".to_string()),
    };

    update_adm_agent_config(move |config| {
        // 校验：模型必须在某个 provider 的 models 中声明 supports_images=true，否则回退内置
        let (final_provider, final_model) = if model_supports_images_in_config(&*config, &provider, &model) {
            (provider.clone(), model.clone())
        } else {
            ("admAgent".to_string(), "admImage-model".to_string())
        };

        let final_target = serde_json::json!({ "provider": final_provider, "model": final_model });
        if config.get("agent_vision_model") == Some(&final_target) {
            return Ok(false);
        }
        config["agent_vision_model"] = final_target;
        Ok(true)
    })
}

/// 检查指定 provider/model 是否在 admAgent.json 的 providers 中声明 supports_images=true。
/// admAgent 是内置 provider（含 admImage-model），不在 providers 键中，需特殊处理。
fn model_supports_images_in_config(config: &serde_json::Value, provider: &str, model: &str) -> bool {
    // admAgent 是内置 provider，其模型（如 admImage-model）支持图片
    if provider == "admAgent" {
        return model == "admImage-model";
    }
    if let Some(providers) = config.get("providers").and_then(|p| p.as_object()) {
        for (key, pc) in providers {
            if key != provider {
                continue;
            }
            if let Some(models) = pc.as_object().and_then(|p| p.get("models").and_then(|m| m.as_array())) {
                return models.iter().any(|m| {
                    m.as_object()
                        .and_then(|mo| {
                            mo.get("id").and_then(|id| id.as_str()).map(|id| {
                                id == model && mo.get("supports_images").and_then(|s| s.as_bool()).unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                });
            }
        }
    }
    false
}

/// 把 HTTP 代理配置写入 admAgent.json 顶层 agent_proxy 并触发服务端热重载。
///
/// admAgent 读取该字段后应用到 LLM 客户端和 Agent HTTP 工具的 Transport。
/// 写入逻辑与 sync_agent_vision_model 相同：写文件 → POST /config/set 触发从磁盘全量重载。
/// 失败静默：代理不生效只是回到直连，不影响主流程。
pub fn sync_agent_proxy(app: &tauri::AppHandle, proxy: &crate::common::types::AgentProxyConfig) {
    let proxy = proxy.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let changed = {
            // 锁由 update_adm_agent_config 统一获取（进程内 Mutex + 跨进程 flock）
            api_debug_log(|| format!("Proxy: 同步代理配置 enabled={} url={}", proxy.enabled, proxy.url));
            write_agent_proxy(&proxy)
        };
        let changed = match changed {
            Ok(c) => c,
            Err(e) => {
                api_debug_log(|| format!("Proxy ! 写 admAgent.json 失败: {}", e));
                return;
            }
        };
        if !changed {
            api_debug_log(|| "Proxy: 配置未变化，跳过重载".to_string());
            return;
        }
        api_debug_log(|| "Proxy: admAgent.json 已更新，触发服务端热重载".to_string());
        request_server_config_reload(&app);
    });
}

/// 把 agent_proxy 写入 admAgent.json 顶层。
/// 返回是否真的发生了变更（供调用方决定是否触发服务端重载）。
fn write_agent_proxy(proxy: &crate::common::types::AgentProxyConfig) -> Result<bool, AppError> {
    // 旧实现在读取/解析失败时静默回退 build_adm_agent_config()，随后整文件覆盖，
    // 把 agent_vision_model / options / 全部云端 provider 一并清掉。
    // 现在解析失败一律返回错误（见 update_adm_agent_config），宁可这次不写，
    // 也不能用默认结构覆盖用户的完整配置。
    let target = serde_json::json!({ "enabled": proxy.enabled, "url": proxy.url });

    update_adm_agent_config(move |config| {
        if config.get("agent_proxy") == Some(&target) {
            return Ok(false);
        }
        config["agent_proxy"] = target;
        Ok(true)
    })
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
        } else if (c.is_whitespace() || c == '-' || c == '_') && !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
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
    // 1) 保证基础结构存在（含 local provider）。
    //    ensure_adm_agent_config 现在是字段级补丁，不会覆盖已有内容，可安全先跑。
    //    锁由 update_adm_agent_config 统一获取，此处不持锁（std Mutex 不可重入）。
    ensure_adm_agent_config(&app)?;

    // 2) 派生 provider key（仅作 JSON 内部键）；模型ID/名称原样写入，区分大小写
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

    // 3) 加锁 → 读 → 改 → 原子写（与 Go server 跨进程互斥）
    let key_for_write = key.clone();
    update_adm_agent_config(move |config| {
        if !config.get("providers").is_some_and(|v| v.is_object()) {
            config["providers"] = serde_json::json!({});
        }
        config["providers"][&key_for_write] = provider;
        Ok(())
    })?;

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
    // 锁由 update_adm_agent_config 统一获取（进程内 Mutex + 跨进程 flock）
    let removed = update_adm_agent_config(|config| {
        let providers = config
            .get_mut("providers")
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：缺少 providers"))?;

        if providers.get(&key).is_none() {
            return Err(AppError::msg(format!("未找到 provider: {}", key)));
        }
        providers.remove(&key);
        Ok(true)
    })?;
    debug_assert!(removed);

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
    let key_for_check = key.clone();

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

    // 加锁 → 读 → 改 → 原子写（与 Go server 跨进程互斥）
    update_adm_agent_config(move |config| {
        let providers = config
            .get_mut("providers")
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：缺少 providers"))?;

        if providers.get(&key_for_check).is_none() {
            return Err(AppError::msg(format!("未找到 provider: {}", key_for_check)));
        }
        providers.insert(key_for_check, new_provider);
        Ok(())
    })?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

// ===== MCP 服务配置（admAgent.json 顶层 `mcp` 映射）=====
// 配置格式与 Go 端 config.MCPConfig 对齐：
// {
//   "mcp": {
//     "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "..."], "env": { "K": "V" } },
//     "remote":     { "type": "http",  "url": "https://...", "headers": { "K": "V" } }
//   }
// }
// 注意：admAgent server 只在启动时初始化 MCP 客户端，新增/修改后需重启 server
// 才会建立连接（/config/set 只触发配置内存重载，不重建 MCP 会话）。

/// MCP 服务配置视图（同时作为前端提交结构，字段名与 admAgent.json 对齐）
#[derive(Serialize, Deserialize, Default)]
pub struct McpServerView {
    /// 服务名称（mcp 映射的 key）
    pub name: String,
    /// 传输类型：stdio / http / sse（缺省 stdio）
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量（stdio）
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    /// 请求头（http/sse）
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// 连接超时（秒），0 表示使用服务端默认值
    #[serde(default)]
    pub timeout: u32,
    #[serde(default)]
    pub disabled: bool,
}

/// MCP 配置的已知字段：更新时先剔除再由新值回填，其余未知字段
/// （enabled_tools / disabled_tools 等）原样保留，避免编辑弹窗丢数据。
const MCP_KNOWN_KEYS: [&str; 8] = ["type", "command", "args", "env", "url", "headers", "timeout", "disabled"];

/// 校验并归一化前端提交的 MCP 配置，返回 (名称, 类型)
fn validate_mcp_input(input: &McpServerView) -> Result<(String, String), AppError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        bail!("MCP 名称不能为空");
    }
    if name.chars().count() > 64 {
        bail!("MCP 名称过长（最多 64 字符）");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        bail!("MCP 名称只能包含字母、数字、下划线、连字符和点");
    }

    let kind = {
        let k = input.kind.trim().to_ascii_lowercase();
        if k.is_empty() { "stdio".to_string() } else { k }
    };
    if !matches!(kind.as_str(), "stdio" | "http" | "sse") {
        bail!("MCP 类型必须是 stdio / http / sse");
    }
    if kind == "stdio" {
        if input.command.trim().is_empty() {
            bail!("stdio 类型必须填写命令");
        }
    } else {
        let url = input.url.trim();
        if url.is_empty() {
            bail!("{} 类型必须填写 URL", kind);
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            bail!("URL 必须以 http:// 或 https:// 开头");
        }
    }
    if input.timeout > 3600 {
        bail!("超时不能超过 3600 秒");
    }
    Ok((name, kind))
}

/// 把前端提交的配置转成写入 admAgent.json 的 JSON 对象（空字段省略，保持文件简洁）
fn mcp_config_value(input: &McpServerView, kind: &str) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".to_string(), serde_json::json!(kind));
    if kind == "stdio" {
        obj.insert("command".to_string(), serde_json::json!(input.command.trim()));
        let args: Vec<String> = input
            .args
            .iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
        if !args.is_empty() {
            obj.insert("args".to_string(), serde_json::json!(args));
        }
        if !input.env.is_empty() {
            obj.insert("env".to_string(), serde_json::json!(input.env));
        }
    } else {
        obj.insert("url".to_string(), serde_json::json!(input.url.trim()));
        if !input.headers.is_empty() {
            obj.insert("headers".to_string(), serde_json::json!(input.headers));
        }
    }
    if input.timeout > 0 {
        obj.insert("timeout".to_string(), serde_json::json!(input.timeout));
    }
    if input.disabled {
        obj.insert("disabled".to_string(), serde_json::json!(true));
    }
    serde_json::Value::Object(obj)
}

/// 更新时合并到旧配置：已知字段用新值覆盖，未知字段保留
fn merge_mcp_config(existing: &serde_json::Value, new_value: serde_json::Value) -> serde_json::Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for key in MCP_KNOWN_KEYS {
        merged.remove(key);
    }
    if let serde_json::Value::Object(new_obj) = new_value {
        for (k, v) in new_obj {
            merged.insert(k, v);
        }
    }
    serde_json::Value::Object(merged)
}

/// 从 admAgent.json 根值解析 mcp 映射为视图列表（按名称排序）
fn mcp_servers_from_value(root: &serde_json::Value) -> Vec<McpServerView> {
    let mut out: Vec<McpServerView> = vec![];
    if let Some(mcp) = root.get("mcp").and_then(|m| m.as_object()) {
        for (name, cfg) in mcp {
            let mut view = McpServerView {
                name: name.clone(),
                kind: cfg.get("type").and_then(|t| t.as_str()).unwrap_or("stdio").to_string(),
                command: cfg.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                url: cfg.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                timeout: cfg.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0) as u32,
                disabled: cfg.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false),
                ..Default::default()
            };
            if let Some(args) = cfg.get("args").and_then(|a| a.as_array()) {
                view.args = args.iter().filter_map(|a| a.as_str().map(|s| s.to_string())).collect();
            }
            if let Some(env) = cfg.get("env").and_then(|e| e.as_object()) {
                view.env = env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
            }
            if let Some(headers) = cfg.get("headers").and_then(|h| h.as_object()) {
                view.headers = headers.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
            }
            out.push(view);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 列出 admAgent.json 中已配置的 MCP 服务
#[tauri::command]
pub async fn list_mcp_servers(_app: tauri::AppHandle) -> Result<Vec<McpServerView>, AppError> {
    let dir = adm_agent_config_dir()?;
    let path = dir.join("admAgent.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let s = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 admAgent.json 失败: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&s)
        .map_err(|e| format!("解析 admAgent.json 失败: {}", e))?;
    Ok(mcp_servers_from_value(&v))
}

/// 新增 MCP 服务的核心逻辑（便于单测），返回归一化后的名称
fn add_mcp_server_core(input: &McpServerView) -> Result<String, AppError> {
    let (name, kind) = validate_mcp_input(input)?;
    let value = mcp_config_value(input, &kind);
    let name_for_write = name.clone();
    update_adm_agent_config(move |config| {
        if !config.get("mcp").is_some_and(|v| v.is_object()) {
            config["mcp"] = serde_json::json!({});
        }
        let mcp = config["mcp"]
            .as_object_mut()
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：mcp 不是对象"))?;
        if mcp.contains_key(&name_for_write) {
            return Err(AppError::msg(format!("MCP「{}」已存在", name_for_write)));
        }
        mcp.insert(name_for_write, value);
        Ok(())
    })?;
    Ok(name)
}

/// 新增 MCP 服务（写入 admAgent.json 顶层 mcp.<name>）
#[tauri::command]
pub async fn add_mcp_server(_app: tauri::AppHandle, input: McpServerView) -> Result<serde_json::Value, AppError> {
    let name = add_mcp_server_core(&input)?;
    Ok(serde_json::json!({ "name": name, "success": true }))
}

/// 修改 MCP 服务的核心逻辑（便于单测）：original_name 定位旧条目，名称可改
fn update_mcp_server_core(original_name: &str, input: &McpServerView) -> Result<String, AppError> {
    let original = original_name.trim().to_string();
    if original.is_empty() {
        bail!("缺少原始 MCP 名称");
    }
    let (name, kind) = validate_mcp_input(input)?;
    let new_value = mcp_config_value(input, &kind);
    let name_for_write = name.clone();
    update_adm_agent_config(move |config| {
        let mcp = config
            .get_mut("mcp")
            .and_then(|m| m.as_object_mut())
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：缺少 mcp"))?;
        let existing = mcp
            .get(&original)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("未找到 MCP「{}」", original)))?;
        if name_for_write != original {
            if mcp.contains_key(&name_for_write) {
                return Err(AppError::msg(format!("MCP「{}」已存在", name_for_write)));
            }
            mcp.remove(&original);
        }
        mcp.insert(name_for_write, merge_mcp_config(&existing, new_value));
        Ok(())
    })?;
    Ok(name)
}

/// 修改 MCP 服务（名称变更时迁移 key，未知字段保留）
#[tauri::command]
pub async fn update_mcp_server(
    _app: tauri::AppHandle,
    original_name: String,
    input: McpServerView,
) -> Result<serde_json::Value, AppError> {
    let name = update_mcp_server_core(&original_name, &input)?;
    Ok(serde_json::json!({ "name": name, "success": true }))
}

/// 删除 MCP 服务的核心逻辑（便于单测）
fn delete_mcp_server_core(name: &str) -> Result<(), AppError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("缺少 MCP 名称");
    }
    let name_for_write = name.clone();
    update_adm_agent_config(move |config| {
        let mcp = config
            .get_mut("mcp")
            .and_then(|m| m.as_object_mut())
            .ok_or_else(|| AppError::msg("admAgent.json 结构异常：缺少 mcp"))?;
        if mcp.remove(&name_for_write).is_none() {
            return Err(AppError::msg(format!("未找到 MCP「{}」", name_for_write)));
        }
        Ok(())
    })?;
    Ok(())
}

/// 删除 MCP 服务
#[tauri::command]
pub async fn delete_mcp_server(_app: tauri::AppHandle, name: String) -> Result<serde_json::Value, AppError> {
    delete_mcp_server_core(&name)?;
    Ok(serde_json::json!({ "name": name, "success": true }))
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

/// 平台默认工作目录：
/// - Windows：软件安装目录（ADM.exe 所在目录）
/// - macOS：用户主目录（$HOME）
/// - 兜底：exe 所在目录
fn platform_default_workdir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(dir) = config::get_exe_dir() {
            return dir;
        }
        // exe 目录获取失败时退回用户主目录
    }
    dirs::home_dir().unwrap_or_else(|| {
        config::get_exe_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

/// 工作目录为空时初始化默认工作目录（幂等）：
/// - Windows：软件安装目录
/// - macOS：用户主目录
/// 同步写入工作目录列表（默认项）与旧字段 agent_workdir，返回当前生效的工作目录。
fn ensure_default_workdir(app: &tauri::AppHandle) -> String {
    let existing = load_agent_workdir(app);
    if !existing.is_empty() {
        return existing;
    }
    // 旧字段为空但列表里有目录：以默认项补齐旧字段，不覆盖用户已有列表
    let dirs = load_workdirs(app);
    if !dirs.is_empty() {
        let list_default = dirs
            .iter()
            .find(|d| d.is_default)
            .or_else(|| dirs.first())
            .map(|d| d.path.clone())
            .unwrap_or_default();
        if !list_default.is_empty() {
            let _ = save_agent_workdir(app, &list_default);
            return list_default;
        }
    }
    let default_path = platform_default_workdir().to_string_lossy().to_string();
    let _ = save_workdirs_internal(
        app,
        &[WorkDirEntry { path: default_path.clone(), is_default: true }],
    );
    default_path
}

/// 获取已配置的 agent 工作目录；为空时自动初始化平台默认工作目录
#[tauri::command]
pub async fn get_agent_workdir(app: tauri::AppHandle) -> Result<String, AppError> {
    Ok(ensure_default_workdir(&app))
}

/// 保存 agent 工作目录到配置文件
#[tauri::command]
pub async fn set_agent_workdir(app: tauri::AppHandle, workdir: String) -> Result<(), AppError> {
    save_agent_workdir(&app, workdir.trim())
}

/// 读取工作目录列表，并在首次加载时从旧 agent_workdir 迁移
fn load_workdirs(app: &tauri::AppHandle) -> Vec<WorkDirEntry> {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let config_path = data_dir.join("config.json");
    let json = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let settings = match serde_json::from_str::<Settings>(&json) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    // Migration: if agent_workdirs is empty but agent_workdir is set,
    // migrate the single workdir into the array.
    if settings.agent_workdirs.is_empty() && !settings.agent_workdir.is_empty() {
        let migrated = vec![WorkDirEntry {
            path: settings.agent_workdir.clone(),
            is_default: true,
        }];
        // Persist the migrated state.
        let _ = save_workdirs_internal(app, &migrated);
        return migrated;
    }

    settings.agent_workdirs
}

/// Write workdirs to config.json (read-modify-write to preserve other fields)
fn save_workdirs_internal(app: &tauri::AppHandle, dirs: &[WorkDirEntry]) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
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

    settings.agent_workdirs = dirs.to_vec();
    // Sync the legacy agent_workdir to the default entry for backward compat.
    let default_path = dirs.iter()
        .find(|d| d.is_default)
        .or_else(|| dirs.first())
        .map(|d| d.path.clone())
        .unwrap_or_default();
    settings.agent_workdir = default_path;

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, &json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 获取工作目录列表（含迁移逻辑；列表为空时自动初始化平台默认工作目录）
#[tauri::command]
pub async fn get_workdirs(app: tauri::AppHandle) -> Result<Vec<WorkDirEntry>, AppError> {
    ensure_default_workdir(&app);
    Ok(load_workdirs(&app))
}

/// 添加工作目录（去重），若列表为空则设为默认
#[tauri::command]
pub async fn add_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    if dirs.iter().any(|d| d.path == path) {
        return Ok(dirs); // Already exists
    }
    let is_first = dirs.is_empty();
    dirs.push(WorkDirEntry { path, is_default: is_first });
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 移除工作目录；若移除的是默认项则将剩余第一项设为默认
#[tauri::command]
pub async fn remove_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    let removed_default = dirs.iter().find(|d| d.path == path).map(|d| d.is_default).unwrap_or(false);
    dirs.retain(|d| d.path != path);
    if removed_default && !dirs.is_empty() {
        dirs[0].is_default = true;
    }
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 设置默认工作目录
#[tauri::command]
pub async fn set_default_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    for d in &mut dirs {
        d.is_default = d.path == path;
    }
    // Also sync legacy agent_workdir
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 验证工作目录列表：检查每个路径是否存在，删除不存在的并返回被删除的路径
#[tauri::command]
pub async fn validate_workdirs(app: tauri::AppHandle) -> Result<Vec<String>, AppError> {
    let mut dirs = load_workdirs(&app);
    let mut removed = Vec::new();
    let mut removed_default = false;

    dirs.retain(|d| {
        let exists = std::path::Path::new(&d.path).is_dir();
        if !exists {
            removed.push(d.path.clone());
            if d.is_default {
                removed_default = true;
            }
        }
        exists
    });

    if removed_default && !dirs.is_empty() {
        dirs[0].is_default = true;
    }

    if !removed.is_empty() {
        save_workdirs_internal(&app, &dirs)?;
    }

    Ok(removed)
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
    /// 当前激活 workspace 的 client_id（页面 remount 时前端需用它同步 S.clientId，
    /// 否则 current-session 等接口会因 client_id 不匹配返回 404）
    pub client_id: Option<String>,
}

/// 会话可用判定：会话存在，且（共享 server 无子进程 或 自有子进程存活）
/// 检查全局 admAgent server 子进程是否存活（已 pull 起子进程时）。
/// 复用共享 server（无子进程）时返回 true（外部管理，假定存活）。
fn server_process_alive(state: &AppState) -> bool {
    let mut c = match state.agent_child.lock() { Ok(g) => g, Err(_) => return false };
    match c.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => true, // 共享 server，无子进程，假定存活
    }
}

/// 供 ilink 桥读取当前激活的 workspace ID。
pub fn current_agent_workspace(app: &tauri::AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    state.active_workspace_id.lock().ok().and_then(|g| g.clone())
}

/// 内部函数：停止 admAgent server，清理所有 workspace 会话和子进程
fn stop_agent_server_internal(state: &tauri::State<'_, AppState>) -> Result<(), AppError> {
    // 停止所有 workspace 的 SSE 转发任务
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        for (_, sess) in sessions.iter() {
            sess.sse_stop.store(true, Ordering::Relaxed);
            if let Some(task) = &sess.sse_task { task.abort(); }
        }
        sessions.clear();
    }
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = None;
    // 终止子进程（只杀本进程拉起的，共享 server 不杀）
    let old_child = state.agent_child.lock().map_err(|e| e.to_string())?.take();
    if let Some(mut child) = old_child {
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
    client_id: String,
) -> Result<AgentServerInfo, AppError> {
    // 覆盖完整异步启动流程的单飞锁。第二个并发调用必须等待第一个完成，
    // 随后直接复用已启动的会话，不能再次 stop + spawn 产生孤儿进程。
    let _start_guard = state.agent_start_lock.lock().await;
    // 检查是否已有运行中的 workspace 会话（server 进程存活）。有则直接复用，
    // 不再重复 spawn 或 stop。
    {
        let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
        if let Some(ws_id) = active {
            let has_session = state.agent_sessions.lock()
                .map(|m| m.contains_key(&ws_id))
                .unwrap_or(false);
            if has_session && server_process_alive(&state) {
                let client_id = state.agent_sessions.lock().unwrap_or_else(|e| e.into_inner())
                    .get(&ws_id).map(|s| s.client_id.clone()).unwrap_or_default();
                return Ok(AgentServerInfo {
                    host: AgentTransport::default_host().display(),
                    workspace_id: ws_id,
                    client_id,
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
        // macOS/Linux 上 Rust 默认配置目录（~/.config/admAgent）与 Go server 的
        // GlobalConfigData（~/.local/share/admAgent）不一致，注入 ADMAGENT_GLOBAL_DATA
        // 让 server 读写与桌面端同步（agent_proxy / agent_vision_model 等顶层字段）
        // 相同的文件。Windows 两侧路径本就一致，无需注入。
        #[cfg(not(target_os = "windows"))]
        if let Ok(dir) = adm_agent_config_dir() {
            cmd.env("ADMAGENT_GLOBAL_DATA", dir);
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

    // 轮询健康检查端点，等待 server 就绪（5 秒）。若 spawn 后检测到 server 已可连
    // （并发启动的其它实例抢先 bind 成功、本进程子进程随即退出），视为复用成功。
    // 5s 阈值已远大于实测冷启动 (~1-2s)；从 15s 缩短是为让「真启动失败」更快暴露，
    // 避免前端空白页面等过久。
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
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
                bail!("等待 admAgent server 启动超时（5秒），请检查 admAgent 是否正常");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    // 使用前端传入的 client_id，确保 SSE 流、POST /v1/workspaces、
    // current-session 全用同一个 client_id（Go 服务端要求 current-session
    // 的 client_id 已挂活跃 SSE 流，否则返回 404 client not attached）。
    let client_id = if client_id.is_empty() {
        // 兜底：前端未传时本地生成（不应发生，但避免空字符串导致服务端校验失败）
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xFFFFFFFFFFFF
        )
    } else {
        client_id
    };

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

    // 全局子进程只存一次（共享 server）
    {
        let mut c = state.agent_child.lock().map_err(|e| e.to_string())?;
        if c.is_none() {
            *c = child;
        }
    }
    // 注册 workspace 会话
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(workspace_id.clone(), AgentServerSession {
            sse_stop: sse_stop.clone(),
            sse_task: Some(sse_task),
            workspace_id: workspace_id.clone(),
            client_id: client_id.clone(),
        });
    }
    // 设为激活 workspace
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = Some(workspace_id.clone());

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
                    let mut payload: serde_json::Value = serde_json::from_str(&event_data)
                        .unwrap_or(serde_json::json!({ "raw": event_data }));
                    // 子 Agent 事件只记日志不转发，避免 SSE 带宽浪费和日志洪泛。
                    let is_sub_agent = is_sub_agent_event(&payload);
                    // 只写关键事件；流式增量/快照等噪音返回 None 不落盘。
                    if is_sub_agent {
                        // 子 Agent 事件只记关键节点（run_complete/agent_event/error），不记流式噪音
                        let ev_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ev_type == "run_complete" || ev_type == "agent_event" {
                            api_debug_log(|| summarize_sse_event(&payload).unwrap_or_default());
                        }
                    } else {
                        api_debug_log(|| summarize_sse_event(&payload).unwrap_or_default());
                        // run_complete 的 payload 携带整轮文本（text 字段），会话上下文增长后
                        // 可能很大；Tauri IPC 对大 payload 偶发投递失败（表现：前端收不到
                        // run_complete → UI 卡"运行中"，需手动点停止），转发前截断防御。
                        // 用 payload 内部 type 判断（event: 行个别实现可能缺失），与
                        // summarize_sse_event 的判定保持一致。
                        if payload.get("type").and_then(|v| v.as_str()) == Some("run_complete") {
                            if let Some(v) = payload.pointer_mut("/payload/payload/text") {
                                if let Some(s) = v.as_str() {
                                    let total = s.chars().count();
                                    if total > 200_000 {
                                        let head: String = s.chars().take(200_000).collect();
                                        *v = serde_json::json!(format!("{}...[正文过长已截断 {} 字符]", head, total - 200_000));
                                        api_debug_log(|| format!("SSE ! run_complete text 超长截断 len={}", total));
                                    }
                                }
                            }
                        }
                        let evt = serde_json::json!({ "type": event_type, "data": payload, "workspace_id": workspace_id });
                        if let Err(e) = app.emit("agent-sse-event", evt) {
                            api_debug_log(|| format!("SSE ! emit 失败 type={} err={}", event_type, e));
                        }
                    }
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
    let mut c = match state.agent_child.lock() { Ok(g) => g, Err(_) => return false };
    match c.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => true, // 共享 server 无子进程，无法探测；返回 true 让前端尝试重启（start_agent_server 会先探活）
    }
}

// ===== 调试模式：admAgent API 交互日志（运行时开关，正式发布版也可用）=====
//
// 由设置里的“调试模式”开关控制（Settings.debug_logging，持久化到
// config.json）：启动时恢复、前端实时切换。关闭时 log_enabled 为 false，
// api_debug_log 一次 atomic load 即返回，无任何开销也不产生文件。

static LOG_ENABLED: AtomicBool = AtomicBool::new(false);

/// 调试日志是否已开启（供 ilink.rs 的 flow_log 复用同一开关）
pub fn is_debug_logging_enabled() -> bool {
    LOG_ENABLED.load(Ordering::Relaxed)
}
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

/// 将 JSON Value 中包含敏感关键词的 key（api_key/secret/password/token）的值替换为 "***"，
/// 用于 HTTP 请求体日志脱敏，避免 API Key 等凭据明文写入 adm_api_debug.log。
fn mask_sensitive_json(value: &serde_json::Value) -> String {
    let mut v = value.clone();
    mask_sensitive_in_place(&mut v);
    api_log_snippet(&v.to_string(), 800)
}
fn mask_sensitive_in_place(value: &mut serde_json::Value) {
    const SENSITIVE: &[&str] = &["api_key", "apikey", "secret", "password", "token"];
    match value {
        serde_json::Value::Object(map) => {
            // 1) 字段名本身含敏感词 → 直接遮蔽其值
            let keys_to_mask: Vec<String> = map.keys()
                .filter(|k| {
                    let lower = k.to_lowercase();
                    SENSITIVE.iter().any(|sk| lower.contains(sk))
                })
                .cloned()
                .collect();
            for k in keys_to_mask {
                if let Some(v) = map.get_mut(&k) {
                    if !matches!(v, serde_json::Value::Null | serde_json::Value::Bool(_)) {
                        *v = serde_json::Value::String("***".to_string());
                    }
                }
            }
            // 2) config/set 场景：key 字段值含敏感词时，遮蔽同对象的 value 字段
            //    body = {"scope":0,"key":"providers.xxx.api_key","value":"sk-..."}
            let key_is_sensitive = map.get("key")
                .and_then(|v| v.as_str())
                .map(|s| {
                    let lower = s.to_lowercase();
                    SENSITIVE.iter().any(|sk| lower.contains(sk))
                })
                .unwrap_or(false);
            if key_is_sensitive {
                if let Some(v) = map.get_mut("value") {
                    if !matches!(v, serde_json::Value::Null | serde_json::Value::Bool(_)) {
                        *v = serde_json::Value::String("***".to_string());
                    }
                }
            }
            for (_, v) in map.iter_mut() {
                mask_sensitive_in_place(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                mask_sensitive_in_place(v);
            }
        }
        _ => {}
    }
}

/// 写一条 admAgent API 交互日志。开关关闭时一次 atomic load 即返回（闭包
/// 不执行，无格式化开销）。与 devtools 控制台的 [agent] API / SSE 日志对应：
/// 所有前端请求都经 agent_http_request 代理、所有 SSE 事件都经
/// forward_sse_events 转发，在这两处落盘即可完整复盘对话中断问题。
/// 行格式：`{epoch_ms} {HH:MM:SS.mmm 本地时间} {内容}`。
/// pub(crate)：供 skills.rs 等其他页面模块复用同一日志通道。
pub(crate) fn api_debug_log<F: FnOnce() -> String>(line: F) {
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
            let _ = writeln!(
                f, "{} {} {}",
                ms, chrono::Local::now().format("%H:%M:%S%.3f"),
                content
            );
        }
    }
}

/// 判断是否子 Agent（agent 工具嵌套调用）的 SSE 事件：其 session_id 为
/// 复合格式 `{parentMsgId}$${toolCallId}`（tool call id 前缀随 provider 不同，
/// 如 OpenAI `call_`、Qwen `chatcmpl-tool-`），前端不处理，不应转发。
/// 注意：只能看 session_id 字段，不能对整个事件 JSON 做 contains("$$")——
/// tool 消息正文（如 shell 的 `$$` 变量）可能含该字符，会导致误判丢弃。
fn is_sub_agent_event(payload: &serde_json::Value) -> bool {
    payload
        .pointer("/payload/payload/session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .contains("$$")
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
            let empty = field("empty_output");
            let empty_s = if empty.is_empty() { "false" } else { empty.as_str() };
            Some(format!(
                "{} run_id={} session={} error={} cancelled={} msg_id={} empty_output={}",
                flag, field("run_id"), field("session_id"), err, field("cancelled"), field("message_id"), empty_s
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
            if inner == "created" {
                Some(format!("< message created role={} id={}", field("role"), field("id")))
            } else if inner == "deleted" {
                Some(format!("< message deleted id={}", field("id")))
            } else {
                None
            }
        }
        // 权限请求 / 结果：Plan/Yolo 下一般直通，出现即值得记。
        "permission_request" => Some(format!("< permission_request tool={} session={}", field("tool_name"), field("session_id"))),
        "permission_notification" => Some(format!("< permission_notification granted={}", field("granted"))),
        // session 快照（context_tokens/is_busy 每次 token 变化都推）、file/lsp/
        // mcp/skills 等杂项：噪音，跳过。解析失败的原始事件仍记一行以便发现异常。
        "session" => None,
        "" if payload.get("raw").is_some() => Some(format!("< raw {}", api_log_snippet(payload.get("raw").and_then(|v| v.as_str()).unwrap_or(""), 200))),
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
    let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
    let running = server_process_alive(&state) && active.is_some();
    let client_id = if running {
        let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        active.as_ref()
            .and_then(|ws_id| sessions.get(ws_id))
            .map(|s| s.client_id.clone())
    } else {
        None
    };
    Ok(AgentServerStatus {
        running,
        host: Some(AgentTransport::default_host().display()),
        workspace_id: active,
        client_id,
    })
}

#[tauri::command]
pub async fn agent_http_request(
    state: tauri::State<'_, AppState>, method: String, path: String, body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    if !server_process_alive(&state) {
        bail!("admAgent server 未运行");
    }
    let started = std::time::Instant::now();
    // 只读 GET 多为高频轮询（每轮 run 后刷 /agent /sessions /messages），是主噪音：
    // 成功时不记，只在出错时留痕；改状态的操作（发消息/切模式/权限）才记请求行。
    let is_get = method.eq_ignore_ascii_case("GET");
    if !is_get {
        api_debug_log(|| format!(
            "HTTP > {} {}{}",
            method.to_uppercase(), path,
            body.as_ref().map(|b| format!(" body={}", mask_sensitive_json(b))).unwrap_or_default()
        ));
    }
    let client = build_client(&AgentTransport::default_host(), Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    // 180s：与 admAgent 服务端图片直调识别的整体超时（describeOverallTimeout）
    // 保持一致——识别在 HTTP 超时前返回或降级，避免“前端报错、后台继续跑”。
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(180),
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
    if !server_process_alive(&state) {
        bail!("admAgent server 未运行");
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

// 取 workspace 的 data_dir（admAgent 侧维护，project_memory.json 与其同级）。
// server 未运行、超时或响应异常时返回错误。
async fn fetch_workspace_data_dir(
    state: &tauri::State<'_, AppState>,
    workspace_id: &str,
) -> Result<String, AppError> {
    if !server_process_alive(state) {
        bail!("admAgent server 未运行");
    }
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
    Ok(ws.get("data_dir").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// 新增/修改/删除 workspace 的项目记忆（写 project_memory.json）。
/// 前端以「完整 anchor 数组」整表提交（新增/修改/删除在数组上完成后落盘），
/// Rust 侧负责：过滤非法条目（非 constraint/decision、value 为空）、按 key
/// （kind:value）去重、补齐 key/updated_at，并原子写盘（.tmp + rename，与
/// admAgent Sync 的写法一致，避免写入半截文件）。
/// 注意：admAgent 每次上下文压缩仍会把内存中持有的持久 anchors 合并回写本文件，
/// 因此手工删除的条目可能被之后的压缩重新沉淀（同名条目以下次沉淀为准）。
#[tauri::command]
pub async fn update_project_memory(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    anchors: serde_json::Value,
) -> Result<(), AppError> {
    let data_dir = fetch_workspace_data_dir(&state, &workspace_id).await?;
    if data_dir.is_empty() {
        bail!("workspace data_dir 为空");
    }

    let arr = anchors.as_array().ok_or("anchors 必须是数组")?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // admAgent 侧锚点的时间戳是 unix 秒（time.Now().Unix()），保持一致
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("constraint");
        if kind != "constraint" && kind != "decision" {
            continue;
        }
        let value = obj.get("value").and_then(|v| v.as_str()).unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        let key = obj.get("key").and_then(|v| v.as_str()).filter(|k| !k.trim().is_empty())
            .map(|k| k.trim().to_string())
            .unwrap_or_else(|| format!("{}:{}", kind, value));
        if !seen.insert(key.clone()) {
            continue;
        }
        let mut o = serde_json::Map::new();
        o.insert("kind".into(), serde_json::json!(kind));
        o.insert("key".into(), serde_json::json!(key));
        o.insert("value".into(), serde_json::json!(value));
        if let Some(why) = obj.get("why").and_then(|v| v.as_str()) {
            let why = why.trim();
            if !why.is_empty() {
                o.insert("why".into(), serde_json::json!(why));
            }
        }
        if let Some(src) = obj.get("source").and_then(|v| v.as_str()) {
            if !src.is_empty() {
                o.insert("source".into(), serde_json::json!(src));
            }
        }
        if let Some(sal) = obj.get("salience").and_then(|v| v.as_f64()) {
            o.insert("salience".into(), serde_json::json!(sal));
        }
        o.insert("updated_at".into(), serde_json::json!(now));
        out.push(serde_json::Value::Object(o));
    }

    let path = std::path::Path::new(&data_dir).join("project_memory.json");
    let dir = path.parent().ok_or("project_memory.json 所在目录无效")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let tmp = dir.join(format!("project_memory.json.{}.tmp", std::process::id()));
    let data = serde_json::to_vec_pretty(&out).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&tmp, &data).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn agent_subscribe_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    client_id: String,
) -> Result<(), AppError> {
    let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
    let sess = sessions.get_mut(&workspace_id).ok_or("workspace session not found")?;

    // 同 workspace 重复订阅（页面挂载/断线重连）：若已有活 SSE 转发任务，直接复用。
    // 绝不能 abort 活任务——abort 产生零流间隙，服务端 streams 计数归零立即
    // teardown 该 workspace；若它是最后一个 workspace，整个 server 自杀退出
    // （表现为 "admAgent 服务异常退出" + 反复重启循环）。
    // forward_sse_events 自带断线自愈循环，无需重建。
    if let Some(task) = &sess.sse_task {
        if !task.is_finished() {
            return Ok(());
        }
    }
    sess.sse_stop.store(true, Ordering::Relaxed);
    let _ = sess.sse_task.take();

    // 创建新的停止标志并更新 session
    let new_sse_stop = Arc::new(AtomicBool::new(false));
    sess.sse_stop = new_sse_stop.clone();

    let transport = AgentTransport::default_host();

    // 启动新的 SSE 转发任务
    let app2 = app.clone();
    sess.sse_task = Some(tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &transport, &workspace_id, &client_id, new_sse_stop).await;
    }));

    Ok(())
}


pub fn kill_agent_session(state: &AppState) {
    // 停止所有 workspace 的 SSE 任务
    if let Ok(mut sessions) = state.agent_sessions.lock() {
        for (_, sess) in sessions.iter() {
            sess.sse_stop.store(true, Ordering::Relaxed);
            if let Some(task) = &sess.sse_task { task.abort(); }
        }
        sessions.clear();
    }
    // 终止子进程
    let old_child = state.agent_child.lock().ok().and_then(|mut g| g.take());
    if let Some(mut child) = old_child {
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

// ===== 新增：多 workspace 管理命令 =====

/// 在已运行的 admAgent server 上创建新 workspace 并启动独立 SSE 转发。
/// 不影响已有 workspace 的运行。
#[tauri::command]
pub async fn create_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    client_id: String,
) -> Result<AgentServerInfo, AppError> {
    // 持有启动锁：避免与 start_agent_server 并发时 server 尚未就绪导致连接失败
    let _guard = state.agent_start_lock.lock().await;
    if !server_process_alive(&state) {
        bail!("admAgent server 未运行");
    }

    let transport = AgentTransport::default_host();
    // 使用前端传入的 client_id（同 start_agent_server）
    let client_id = if client_id.is_empty() {
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xFFFFFFFFFFFF
        )
    } else {
        client_id
    };

    let client = build_client(&transport, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(
            &client,
            "POST",
            "/v1/workspaces",
            Some(serde_json::json!({ "path": path, "client_id": &client_id })),
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
    let workspace_id = body.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "default".to_string());

    // 检查是否已有该 workspace 的活 SSE 转发任务。切回已存在的 path 时
    // Go 端按 path 去重返回同一 workspace_id，若这里无条件 spawn 新任务
    // 会产生僵尸任务：同一 workspace 多条 SSE 流 → 事件重复投递、
    // 前端 run_complete 重复处理导致会话"卡住"。有活任务直接复用。
    {
        let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&workspace_id) {
            if let Some(task) = &existing.sse_task {
                if !task.is_finished() {
                    // 已有活任务，直接复用（保持原有 client_id，SSE 流不变）
                    return Ok(AgentServerInfo {
                        host: AgentTransport::default_host().display(),
                        workspace_id: workspace_id.clone(),
                        client_id: existing.client_id.clone(),
                    });
                }
            }
        }
    }

    // 走到这里说明该 workspace 无活 SSE 任务（首次创建或旧任务已死）：
    // 启动该 workspace 的独立 SSE 转发
    let sse_stop = Arc::new(AtomicBool::new(false));
    let app2 = app.clone();
    let ws_id = workspace_id.clone();
    let cid = client_id.clone();
    let sse_stop2 = sse_stop.clone();
    let t2 = transport.clone();
    let sse_task = tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &t2, &ws_id, &cid, sse_stop2).await;
    });

    // 注册会话
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(workspace_id.clone(), AgentServerSession {
            sse_stop: sse_stop.clone(),
            sse_task: Some(sse_task),
            workspace_id: workspace_id.clone(),
            client_id: client_id.clone(),
        });
    }

    let host = transport.display();
    Ok(AgentServerInfo { host, workspace_id, client_id })
}

/// 切换当前激活的 workspace（不停止旧 workspace 的 SSE）。
#[tauri::command]
pub async fn switch_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<(), AppError> {
    let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
    if !sessions.contains_key(&workspace_id) {
        bail!("workspace {} 不存在", workspace_id);
    }
    drop(sessions);
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = Some(workspace_id);
    Ok(())
}

// ===== 日志管理 =====

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

/// 前端调试日志写入：让 JS 端把关键事件写到 adm_api_debug.log，
/// 与 Rust 端的 api_debug_log 统一格式、统一文件。
/// 仅在 debug_logging 开启时写入（与 api_debug_log 同一个开关）。
#[tauri::command]
pub async fn agent_debug_log(_app: tauri::AppHandle, line: String) -> Result<(), AppError> {
    api_debug_log(|| format!("UI: {}", line));
    Ok(())
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
        if let Some(plist) = pb.propertyListForType(NSFilenamesPboardType) {
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
                if let Some(s) = item.stringForType(NSPasteboardTypeFileURL) {
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


// ---------------------------------------------------------------------------
// 回归测试：admAgent.json 被并发写清空的修复
//
// 背景：本文件在 Windows 上与 admAgent server（Go）的数据配置是同一个文件。
// 旧实现用非原子的 std::fs::write 先截断文件，并在读取/解析失败时静默回退
// build_adm_agent_config() 整文件覆盖，导致切换模型时 agent_proxy /
// agent_vision_model / options / 全部云端 provider 被清空。
//
// 修复后必须成立的两条不变量：
//   1. 任何写入都只打补丁，已有字段一字不动；
//   2. 文件为空或 JSON 非法时拒绝写入，绝不当成空文档覆盖。
//
// 实现说明：这些用例通过 LOCALAPPDATA 把配置目录重定向到临时目录，而环境变量
// 是进程全局的，因此用 TEST_SERIAL_LOCK 强制用例串行（cargo test 默认多线程并行）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod adm_agent_config_tests {
    use super::*;

    /// 强制用例串行：环境变量是进程全局的，并行会互相踩配置目录。
    static TEST_SERIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 持有串行锁的临时配置目录；drop 时释放锁（目录本身不自动删除，便于失败排查）。
    ///
    /// `dir` 是 **配置目录本身**（即 `.../admAgent`），与 `adm_agent_config_dir()`
    /// 的返回值一致，测试里可直接 `t.dir.join("admAgent.json")`。
    struct TestDir {
        dir: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    fn temp_config_dir(tag: &str) -> TestDir {
        let guard = TEST_SERIAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!(
            "adm_cfg_test_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&base);
        // adm_agent_config_dir()：Windows 为 LOCALAPPDATA/admAgent，其它平台为 HOME/.config/admAgent，
        // 两个环境变量都重定向到临时目录，保证测试在任意平台都不触碰真实用户配置。
        #[cfg(target_os = "windows")]
        let dir = base.join("admAgent");
        #[cfg(not(target_os = "windows"))]
        let dir = {
            std::env::set_var("HOME", &base);
            base.join(".config").join("admAgent")
        };
        std::fs::create_dir_all(&dir).expect("创建临时配置目录失败");
        std::env::set_var("LOCALAPPDATA", &base);
        TestDir { dir, _guard: guard }
    }

    const SAMPLE: &str = r#"{
  "agent_proxy": { "enabled": true, "url": "http://127.0.0.1:10809" },
  "options": { "tui": { "compact_mode": true } },
  "providers": {
    "local": { "name": "Local" },
    "mycloud": { "api_key": "sk-test", "base_url": "https://example.invalid/v1" }
  }
}"#;

    /// 不变量 1：写入只打补丁，已有字段一字不动。
    #[test]
    fn update_preserves_every_unrelated_field() {
        let t = temp_config_dir("preserve");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        update_adm_agent_config(|v| {
            v["agent_vision_model"] = serde_json::json!({ "provider": "p", "model": "m" });
            Ok::<(), AppError>(())
        })
        .expect("写入应成功");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("落盘后必须是合法 JSON");

        assert_eq!(
            out["agent_proxy"]["url"], "http://127.0.0.1:10809",
            "agent_proxy 必须原样保留"
        );
        assert_eq!(
            out["options"]["tui"]["compact_mode"],
            serde_json::json!(true),
            "options.tui 必须原样保留"
        );
        assert_eq!(
            out["providers"]["mycloud"]["api_key"], "sk-test",
            "云端 provider 必须原样保留 —— 旧实现正是把这里清空了"
        );
        assert_eq!(
            out["providers"]["local"]["name"], "Local",
            "local provider 必须保留"
        );
        assert_eq!(
            out["agent_vision_model"]["model"], "m",
            "新字段必须写入"
        );
    }

    // ---- write_agent_vision_model：supports_images 校验 ----

    const VISION_SAMPLE: &str = r#"{
  "providers": {
    "local": {
      "name": "Local",
      "models": [ { "id": "localModel", "name": "Local Model", "supports_images": true } ]
    },
    "visioncloud": {
      "name": "Vision Cloud",
      "base_url": "https://example.invalid/v1",
      "models": [ { "id": "gpt-4o", "name": "GPT-4o", "supports_images": true } ]
    },
    "textcloud": {
      "name": "Text Cloud",
      "base_url": "https://example.invalid/v1",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "supports_images": false },
        { "id": "deepseek", "name": "DeepSeek" }
      ]
    }
  }
}"#;

    fn read_vision_model(path: &std::path::Path) -> serde_json::Value {
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("读回配置"))
                .expect("落盘后必须是合法 JSON");
        out["agent_vision_model"].clone()
    }

    fn assert_builtin_vision(v: &serde_json::Value) {
        assert_eq!(
            v,
            &serde_json::json!({ "provider": "admAgent", "model": "admImage-model" }),
            "应回退为内置 admAgent/admImage-model"
        );
    }

    /// 模型在 providers 中声明 supports_images=true：原样保留，返回 changed=true。
    #[test]
    fn vision_model_kept_when_supports_images_true() {
        let t = temp_config_dir("vision_kept");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        let changed = write_agent_vision_model("visioncloud/gpt-4o").expect("写入应成功");
        assert!(changed, "首次写入应报告变更");
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "visioncloud", "model": "gpt-4o" })
        );
    }

    /// 内置 admAgent 特判：admImage-model 永远有效。
    #[test]
    fn vision_model_builtin_admimage_kept() {
        let t = temp_config_dir("vision_builtin");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("admAgent/admImage-model").expect("写入应成功"));
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "admAgent", "model": "admImage-model" })
        );
    }

    /// 本地模型 local/localModel 且 supports_images=true：保留（不回退内置）。
    #[test]
    fn vision_model_local_kept_when_supports_images() {
        let t = temp_config_dir("vision_local");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("local/localModel").expect("写入应成功"));
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "local", "model": "localModel" })
        );
    }

    /// provider 不存在：回退内置并报告变更。
    #[test]
    fn vision_model_falls_back_when_provider_missing() {
        let t = temp_config_dir("vision_noprov");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        let changed = write_agent_vision_model("nope/gpt-4o").expect("写入应成功");
        assert!(changed, "校验失败改为内置应报告变更");
        assert_builtin_vision(&read_vision_model(&path));
    }

    /// supports_images=false 或字段缺失：同样回退内置。
    #[test]
    fn vision_model_falls_back_when_supports_images_not_true() {
        let t = temp_config_dir("vision_noimg");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(
            write_agent_vision_model("textcloud/gpt-4o").expect("写入应成功"),
            "supports_images=false 应回退内置"
        );
        assert_builtin_vision(&read_vision_model(&path));

        // 缺 supports_images 字段的模型：独立目录验证同样回退并报告变更
        let t2 = temp_config_dir("vision_noimg2");
        let path2 = t2.dir.join("admAgent.json");
        std::fs::write(&path2, VISION_SAMPLE).expect("写入样本配置");
        assert!(
            write_agent_vision_model("textcloud/deepseek").expect("写入应成功"),
            "缺 supports_images 字段应回退内置"
        );
        assert_builtin_vision(&read_vision_model(&path2));
    }

    /// 值未变化（目标已是当前值）：返回 false，调用方跳过服务端重载。
    #[test]
    fn vision_model_no_change_returns_false() {
        let t = temp_config_dir("vision_unchanged");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("visioncloud/gpt-4o").expect("首次写入应成功"));
        let changed = write_agent_vision_model("visioncloud/gpt-4o").expect("二次写入应成功");
        assert!(!changed, "值未变化必须返回 false，避免不必要的服务端重载");
    }

    /// 非法值（无 provider/model 分隔）回退内置。
    #[test]
    fn vision_model_bad_value_falls_back_to_builtin() {
        for bad in ["", "no-slash", "/model", "provider/"] {
            let t = temp_config_dir("vision_badval");
            let path = t.dir.join("admAgent.json");
            std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");
            let changed = write_agent_vision_model(bad).expect("写入应成功");
            assert!(changed, "非法值 {:?} 应回退内置并报告变更", bad);
            assert_builtin_vision(&read_vision_model(&path));
        }
    }

    /// 不变量 2：空文件拒绝写入，且不破坏原文件。
    #[test]
    fn update_rejects_empty_config_file() {
        let t = temp_config_dir("empty");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, "").expect("写入空文件");

        let err = update_adm_agent_config(|v| {
            v["agent_proxy"] = serde_json::json!(true);
            Ok::<(), AppError>(())
        });
        assert!(
            err.is_err(),
            "空文件必须拒绝写入：否则会被写成只含单个字段的残片，整份配置丢失"
        );

        assert_eq!(
            std::fs::read_to_string(&path).expect("读回"),
            "",
            "写入失败时不得改动原文件"
        );
    }

    /// 不变量 2：非法 JSON（截断到一半）同样拒绝写入。
    #[test]
    fn update_rejects_truncated_config_file() {
        let t = temp_config_dir("truncated");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, r#"{"providers": {"local": {"nam"#).expect("写入半截文件");

        assert!(
            update_adm_agent_config(|v| {
                v["agent_proxy"] = serde_json::json!(true);
                Ok::<(), AppError>(())
            })
            .is_err(),
            "半截 JSON 必须拒绝写入"
        );
    }

    /// 连续写入：每次落盘后都必须是合法且完整的 JSON，不得出现空文件。
    /// 这是对原子写（tmp + rename）的直接验证。
    #[test]
    fn repeated_writes_always_leave_valid_complete_json() {
        let t = temp_config_dir("repeat");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        for i in 0..50 {
            update_adm_agent_config(move |v| {
                v["options"]["tui"]["compact_mode"] = serde_json::json!(i % 2 == 0);
                Ok::<(), AppError>(())
            })
            .expect("写入应成功");

            // 每次写完立刻读回：必须合法，且云端 provider 始终存在
            let raw = std::fs::read_to_string(&path).expect("读回配置");
            assert!(!raw.trim().is_empty(), "第 {} 次写后文件为空", i);
            let out: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("第 {} 次写后 JSON 非法: {}", i, e));
            assert_eq!(
                out["providers"]["mycloud"]["api_key"], "sk-test",
                "第 {} 次写后云端 provider 丢失",
                i
            );
        }
    }

    /// 原子写只在同目录留临时文件，成功后必须清理干净。
    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let t = temp_config_dir("notmp");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        update_adm_agent_config(|v| {
            v["agent_proxy"]["url"] = serde_json::json!("http://127.0.0.1:1/v1");
            Ok::<(), AppError>(())
        })
        .expect("写入应成功");

        let leftovers: Vec<_> = std::fs::read_dir(&t.dir)
            .expect("列出目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {:?}", leftovers);
    }

    // ---- MCP 配置（add / update / delete / list） ----

    fn mcp_default() -> McpServerView {
        McpServerView {
            name: "m1".to_string(),
            kind: "stdio".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@modelcontextprotocol/server-filesystem".to_string()],
            ..Default::default()
        }
    }

    /// 新增：写入 mcp.<name>，不动其它字段；同名重复新增报错。
    #[test]
    fn mcp_add_writes_entry_and_rejects_duplicates() {
        let t = temp_config_dir("mcp_add");
        let path = t.dir.join("admAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        let name = add_mcp_server_core(&mcp_default()).expect("新增应成功");
        assert_eq!(name, "m1");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert_eq!(out["mcp"]["m1"]["command"], "npx");
        assert_eq!(out["mcp"]["m1"]["args"][1], "@modelcontextprotocol/server-filesystem");
        assert_eq!(
            out["providers"]["mycloud"]["api_key"], "sk-test",
            "新增 MCP 不得影响其它字段"
        );

        assert!(add_mcp_server_core(&mcp_default()).is_err(), "同名重复新增必须报错");

        let listed = mcp_servers_from_value(&out);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].command, "npx");
        assert_eq!(listed[0].kind, "stdio");
    }

    /// 更新：名称可改（迁移 key），未编辑字段（enabled_tools）保留，空字段省略。
    #[test]
    fn mcp_update_renames_and_preserves_unknown_fields() {
        let t = temp_config_dir("mcp_update");
        let path = t.dir.join("admAgent.json");
        std::fs::write(
            &path,
            r#"{"mcp":{"old":{"type":"stdio","command":"npx","args":["a"],"enabled_tools":["t1"]}}}"#,
        )
        .expect("写入样本配置");

        let input = McpServerView {
            name: "new".to_string(),
            kind: "stdio".to_string(),
            command: "uvx".to_string(),
            ..Default::default()
        };
        let name = update_mcp_server_core("old", &input).expect("更新应成功");
        assert_eq!(name, "new");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert!(out["mcp"].get("old").is_none(), "旧 key 必须移除");
        assert_eq!(out["mcp"]["new"]["command"], "uvx");
        assert!(out["mcp"]["new"].get("args").is_none(), "未填参数时应省略旧 args");
        assert_eq!(out["mcp"]["new"]["enabled_tools"][0], "t1", "未知字段必须保留");

        assert!(
            update_mcp_server_core("missing", &input).is_err(),
            "目标不存在必须报错"
        );
    }

    /// 删除：移除条目；目标不存在时报错。
    #[test]
    fn mcp_delete_removes_entry() {
        let t = temp_config_dir("mcp_delete");
        let path = t.dir.join("admAgent.json");
        std::fs::write(
            &path,
            r#"{"mcp":{"a":{"type":"stdio","command":"x"},"b":{"type":"http","url":"https://e.com/mcp"}}}"#,
        )
        .expect("写入样本配置");

        delete_mcp_server_core("a").expect("删除应成功");
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert!(out["mcp"].get("a").is_none());
        assert!(out["mcp"].get("b").is_some(), "其它 MCP 不得受影响");

        assert!(delete_mcp_server_core("a").is_err(), "重复删除必须报错");
    }

    /// 校验：名称字符 / stdio 命令 / http URL / 超时上限 / 类型缺省。
    #[test]
    fn mcp_validation_rules() {
        let validator = |v: McpServerView| validate_mcp_input(&v);

        assert!(validator(McpServerView {
            name: "  ".into(), kind: "stdio".into(), command: "npx".into(), ..Default::default()
        })
        .is_err(), "空名称");
        assert!(validator(McpServerView {
            name: "a b".into(), kind: "stdio".into(), command: "npx".into(), ..Default::default()
        })
        .is_err(), "非法字符");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "stdio".into(), ..Default::default()
        })
        .is_err(), "stdio 缺命令");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "http".into(), ..Default::default()
        })
        .is_err(), "http 缺 URL");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "http".into(), url: "ftp://x".into(), ..Default::default()
        })
        .is_err(), "非 http(s) 协议");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "stdio".into(), command: "npx".into(), timeout: 3601, ..Default::default()
        })
        .is_err(), "超时超上限");

        let (name, kind) = validate_mcp_input(&McpServerView {
            name: " ok ".into(), command: "npx".into(), ..Default::default()
        })
        .expect("合法配置应通过");
        assert_eq!(name, "ok", "名称应去首尾空白");
        assert_eq!(kind, "stdio", "缺省类型应为 stdio");
    }

    /// 列表：缺 type 视为 stdio，按名称排序。
    #[test]
    fn mcp_list_defaults_and_sorts() {
        let root = serde_json::json!({ "mcp": {
            "zeta": { "type": "http", "url": "https://z.example/mcp", "headers": { "Authorization": "Bearer x" } },
            "alpha": { "command": "npx" }
        }});
        let list = mcp_servers_from_value(&root);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "alpha");
        assert_eq!(list[0].kind, "stdio", "缺省 type 必须回退 stdio");
        assert_eq!(list[1].name, "zeta");
        assert_eq!(list[1].url, "https://z.example/mcp");
        assert_eq!(list[1].headers["Authorization"], "Bearer x");
    }
}

#[cfg(test)]
mod sse_sub_agent_filter_tests {
    use super::*;

    fn ev(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "type": "message", "payload": { "type": "created", "payload": data } })
    }

    #[test]
    fn normal_session_uuid_is_forwarded() {
        let p = ev(serde_json::json!({ "id": "m1", "session_id": "05068656-be01-43b1-aaa5-f9dffaa95e3d", "role": "assistant" }));
        assert!(!is_sub_agent_event(&p));
    }

    #[test]
    fn openai_style_nested_session_dropped() {
        let p = ev(serde_json::json!({ "session_id": "f16a88b6-fc15-496b-a03c-6ebdfe54b1c3$$call_abc123" }));
        assert!(is_sub_agent_event(&p));
    }

    #[test]
    fn qwen_style_nested_session_dropped() {
        // 真实事故样本（adm_api_debug 2026-09）：$$call_ 前缀不匹配导致误转发
        let p = serde_json::json!({ "type": "run_complete", "payload": { "type": "updated", "payload": {
            "session_id": "c5a4abbd-ec37-42ef-9e4f-e691f131b83a$$chatcmpl-tool-b577aa9f6c9ceb61",
            "run_id": "run-1788225954786-v2gyqeynm", "error": "context deadline exceeded" } } });
        assert!(is_sub_agent_event(&p));
    }

    #[test]
    fn tool_body_with_dollarsigns_not_misjudged() {
        // shell `$$` 出现在消息正文中不得误判为子 Agent（event_data.contains 旧写法会踩）
        let p = ev(serde_json::json!({ "session_id": "05068656-be01-43b1-aaa5-f9dffaa95e3d", "role": "tool", "content": "kill -INT -$$ 12345" }));
        assert!(!is_sub_agent_event(&p));
    }

    #[test]
    fn events_without_session_id_forwarded() {
        assert!(!is_sub_agent_event(&serde_json::json!({ "type": "config_changed" })));
        assert!(!is_sub_agent_event(&serde_json::json!({ "raw": "not-json" })));
    }
}
