// iLink Bot（微信个人号机器人）桥接：扫码登录、收消息、转发 admAgent、回复微信。
// 微信侧协议（登录 / 凭据持久化 / 长轮询游标 / context_token / sendmessage / typing）
// 全部委托给 wechatbot crate（https://www.wechatbot.dev/zh/rust），本模块只做 ADM 桥接：
// admAgent 侧仅调用现有 HTTP API（doc/server-api.md），admAgent 源码零改动。
//
// 结构：
//   section 1: 常量 / 持久化（ilink_state.json — 仅 Bot 行为配置；登录凭据由 crate 管理）
//   section 2: wechatbot 实例构建（BotOptions 回调 → Tauri 事件）
//   section 3: 运行时（IlinkRuntime / IlinkManaged）与 Tauri 命令
//   section 4: 扫码登录流程（bot.login）
//   section 5: Bridge 主循环（bot.run 收消息 → admAgent）
//   section 6: admAgent SSE 订阅（run_complete → 回复微信）
//   section 7: 消息转换工具（markdown 降级 / 分段）

use crate::app_state::AppState;
use crate::bail;
use crate::common::config;
use crate::common::error::AppError;
use crate::common::types::Settings;
use crate::pages::agent;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use wechatbot::{BotOptions, ContentType, WeChatBot, WeChatBotError};

// ===== section 1: 常量与持久化 =====

/// 单条微信消息最大字符数，超出按此分段
const WX_CHUNK_CHARS: usize = 1800;
/// admAgent server 自动拉起的重试冷却（秒）
const AGENT_AUTOSTART_COOLDOWN_SECS: u64 = 60;
/// 配对码（登录时微信手机端显示的数字）输入等待超时（秒）
const VERIFY_CODE_TIMEOUT_SECS: u64 = 180;

/// ilink_state.json：Bot 行为配置（owner / 开关）。
/// 登录凭据（token / baseurl / 游标 / context_token）由 wechatbot crate
/// 持久化在 wechatbot_credentials.json，与本文件分离。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct IlinkPersist {
    /// Bot 总开关（绑定成功自动置 true；暂停置 false）
    #[serde(default)]
    pub enabled: bool,
    /// 登录返回的 Bot 账号 ID（Credentials.account_id，仅展示用）
    #[serde(default)]
    pub bot_id: String,
    /// 首个对话者自动成为 owner，其余消息忽略（防陌生人驱动 Agent）
    #[serde(default)]
    pub owner_wx_id: String,
    /// 微信开关：开 = 微信消息注入桌面当前打开的会话；关 = 不接收微信消息
    #[serde(default)]
    pub follow_mode: bool,
}

fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(config::get_data_dir(Some(app))?.join("ilink_state.json"))
}

/// wechatbot crate 的凭据文件（cred_path）：token / baseurl / account_id 等由 crate 读写
fn cred_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(config::get_data_dir(Some(app))?.join("wechatbot_credentials.json"))
}

/// 是否已绑定（crate 凭据文件存在即视为已绑定）
fn creds_exist(app: &tauri::AppHandle) -> bool {
    cred_file_path(app).map(|p| p.exists()).unwrap_or(false)
}

fn load_persist(app: &tauri::AppHandle) -> IlinkPersist {
    let path = match state_file_path(app) {
        Ok(p) => p,
        Err(_) => return IlinkPersist::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<IlinkPersist>(&s).unwrap_or_default(),
        Err(_) => IlinkPersist::default(),
    }
}

/// 直接写入目标文件（与 settings.rs 一致，避免 macOS 上 rename 失败）
fn save_persist_to(path: &std::path::Path, p: &IlinkPersist) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(p)
        .map_err(|e| format!("序列化 ilink 状态失败: {}", e))?;
    std::fs::write(path, &json).map_err(|e| format!("写入 ilink 状态文件失败: {}", e))?;
    Ok(())
}

// ===== section 2: wechatbot 实例构建 =====

/// 构建 wechatbot 实例：凭据落盘到数据目录，登录/错误回调转成 Tauri 事件。
/// awaiting_scan：crate 触发扫码时置位（get_ilink_status 借此上报 waiting_scan）。
fn build_bot(
    app: &tauri::AppHandle,
    awaiting_scan: Arc<AtomicBool>,
) -> Result<WeChatBot, AppError> {
    let cred = cred_file_path(app)?;
    let verify_rx = install_verify_channel(app);
    let app_qr = app.clone();
    let app_err = app.clone();
    let app_vc = app.clone();
    let opts = BotOptions {
        base_url: None,
        cred_path: Some(cred.to_string_lossy().to_string()),
        bot_agent: Some(format!("ADM/{}", env!("CARGO_PKG_VERSION"))),
        // 扫码回调：crate 返回待扫链接，本地渲染 SVG 二维码推给前端
        on_qr_url: Some(Box::new(move |url| {
            awaiting_scan.store(true, Ordering::Relaxed);
            let img = qr_svg_data_url(url).unwrap_or_default();
            emit_status(
                &app_qr,
                json!({ "state": "waiting_scan", "qrcode_img": img, "qrcode_url": url }),
            );
        })),
        on_error: Some(Box::new(move |err| {
            eprintln!("[ilink] wechatbot 错误: {}", err);
            flow_log(&app_err, "bot_error", &err.to_string());
        })),
        // 配对码回调：crate 默认走 stdin，窗口应用无控制台，改为前端输入。
        // 同步回调阻塞等待前端 submit_ilink_verify_code 命令投递（有超时兜底）。
        on_verify_code: Some(Box::new(move |retry| {
            emit_status(&app_vc, json!({ "state": "waiting_verify_code", "retry": retry }));
            let guard = match verify_rx.lock() {
                Ok(g) => g,
                Err(_) => return String::new(),
            };
            // 丢弃历史残留输入，只取本次提示后提交的码
            while guard.try_recv().is_ok() {}
            guard
                .recv_timeout(Duration::from_secs(VERIFY_CODE_TIMEOUT_SECS))
                .unwrap_or_default()
        })),
    };
    Ok(WeChatBot::new(opts))
}

/// 创建配对码通道：Sender 存入 IlinkManaged（供前端命令投递），Receiver 交给回调持有。
/// 每次构建 bot 都会替换旧通道，仅最新 bot 的回调生效。
fn install_verify_channel(
    app: &tauri::AppHandle,
) -> std::sync::Mutex<std::sync::mpsc::Receiver<String>> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let managed = app.state::<IlinkManaged>();
    if let Ok(mut slots) = managed.inner.lock() {
        slots.verify_tx = Some(tx);
    }
    std::sync::Mutex::new(rx)
}

// ===== section 3: 运行时与 Tauri 命令 =====

/// 在途运行路由：run_complete 回投目标
struct RunRoute {
    wx_user: String,
    session_id: String,
}

/// Bridge 运行期共享数据（bot 任务与 SSE 任务共用）
#[derive(Default)]
struct BridgeShared {
    /// 当前对接的 admAgent server 端口（None = 未就绪）
    port: Option<u16>,
    /// Bridge 专属工作区 ID（None = 需要重建，设置变更时也会被置空以热生效）
    workspace_id: Option<String>,
    /// Bridge 专属 SSE client_id（与前端 Agent 页互不干扰）
    client_id: String,
    /// run_id → 回投路由（run_complete 可能不带 run_id，需支持按 session_id 回退匹配）
    runs: HashMap<String, RunRoute>,
}

/// Bridge 运行时：bot / SSE 两个 tokio 任务共享一个 Arc
pub struct IlinkRuntime {
    app: tauri::AppHandle,
    stop: AtomicBool,
    msg_in: AtomicU64,
    msg_out: AtomicU64,
    /// 上次尝试自动拉起 admAgent server 的时间戳（epoch 秒，冷却用）
    last_agent_start: AtomicU64,
    state_path: PathBuf,
    /// wechatbot 实例：登录 / 长轮询 / 发消息 / typing 全部经由它
    bot: WeChatBot,
    /// 凭据失效触发扫码时置位（状态查询上报 waiting_scan）
    awaiting_scan: Arc<AtomicBool>,
    /// admAgent HTTP 用短超时客户端（SSE 单独建）
    http: reqwest::Client,
    persist: tokio::sync::Mutex<IlinkPersist>,
    shared: tokio::sync::Mutex<BridgeShared>,
    last_error: std::sync::Mutex<String>,
}

/// Tauri 托管状态：Bridge 任务槽位（lib.rs 中 app.manage 注册）
#[derive(Default)]
pub struct IlinkManaged {
    inner: std::sync::Mutex<IlinkSlots>,
}

#[derive(Default)]
struct IlinkSlots {
    runtime: Option<Arc<IlinkRuntime>>,
    bot_task: Option<tokio::task::JoinHandle<()>>,
    sse_task: Option<tokio::task::JoinHandle<()>>,
    login_task: Option<tokio::task::JoinHandle<()>>,
    /// 配对码投递端（build_bot 时创建；submit_ilink_verify_code 命令写入）
    verify_tx: Option<std::sync::mpsc::Sender<String>>,
    /// 桌面端当前打开的会话 ID（前端实时同步；空 = 未打开）。
    /// 放在 slots 而非 per-runtime 的 BridgeShared：暂停/重启 Bridge 不丢失。
    follow_session: Option<String>,
}

/// 前端状态查询结构（含行为配置，一次拉全）
#[derive(Serialize)]
pub struct IlinkStatus {
    pub state: String, // stopped | waiting_scan | running | error
    pub bound: bool,
    pub enabled: bool,
    pub bot_id: String,
    pub owner: String,
    pub error: String,
    pub msg_in: u64,
    pub msg_out: u64,
    /// 微信跟随模式开关（Agent 页模型选择旁的开关状态）
    pub follow: bool,
}

fn emit_status(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("ilink-status", payload);
}

/// 收发消息摘要事件（设置页活动日志）
fn emit_activity(app: &tauri::AppHandle, direction: &str, wx_user: &str, summary: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let brief: String = summary.chars().take(80).collect();
    let _ = app.emit(
        "ilink-activity",
        json!({ "ts": ts, "direction": direction, "wx_user": short_wx_id(wx_user), "summary": brief }),
    );
}

fn set_last_error(rt: &IlinkRuntime, msg: &str) {
    if let Ok(mut g) = rt.last_error.lock() {
        *g = msg.to_string();
    }
}

/// 生成 UUID 形式的随机 ID（与 agent.rs client_id 同格式）
fn new_uuid_like() -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        rand::random::<u32>(),
        rand::random::<u16>(),
        rand::random::<u16>(),
        rand::random::<u16>(),
        rand::random::<u64>() & 0xFFFFFFFFFFFF
    )
}

/// 微信 ID 缩略展示：取 '@' 前部分的后 6 位
fn short_wx_id(wx_id: &str) -> String {
    let head = wx_id.split('@').next().unwrap_or(wx_id);
    let chars: Vec<char> = head.chars().collect();
    if chars.len() <= 6 {
        head.to_string()
    } else {
        chars[chars.len() - 6..].iter().collect()
    }
}

/// 把扫码目标内容渲染为 SVG 二维码 data URL。
/// crate 的 on_qr_url 回调给的是待扫链接（https://liteapp.weixin.qq.com/q/...），
/// 需本地生成二维码图片供前端展示。
fn qr_svg_data_url(content: &str) -> Option<String> {
    let code = qrcode::QrCode::new(content.as_bytes()).ok()?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    ))
}

/// App 启动时自动恢复：已绑定且启用时后台拉起 Bridge（lib.rs setup 调用）。
/// Bridge 会在内部等待 admAgent server 就绪，此处无需关心时序。
pub fn auto_start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let p = load_persist(&app);
        if p.enabled && creds_exist(&app) {
            if let Err(e) = start_bridge_internal(&app).await {
                eprintln!("[ilink] 自动启动 Bridge 失败: {}", e);
            }
        }
    });
}

/// 停止 Bridge 任务（不动持久化文件）
fn stop_bridge_slots(managed: &tauri::State<'_, IlinkManaged>) -> Result<(), AppError> {
    let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
    if let Some(rt) = slots.runtime.take() {
        rt.stop.store(true, Ordering::Relaxed);
    }
    if let Some(t) = slots.bot_task.take() {
        t.abort();
    }
    if let Some(t) = slots.sse_task.take() {
        t.abort();
    }
    Ok(())
}

/// 启动 Bridge（要求已有登录凭据）；重复调用会先停旧任务
pub async fn start_bridge_internal(app: &tauri::AppHandle) -> Result<(), AppError> {
    let managed = app.state::<IlinkManaged>();
    stop_bridge_slots(&managed)?;

    if !creds_exist(app) {
        bail!("尚未绑定微信 Bot，请先扫码绑定");
    }
    let mut persist = load_persist(app);
    persist.enabled = true;
    let path = state_file_path(app)?;
    save_persist_to(&path, &persist)?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let awaiting_scan = Arc::new(AtomicBool::new(false));
    let bot = build_bot(app, awaiting_scan.clone())?;
    let rt = Arc::new(IlinkRuntime {
        app: app.clone(),
        stop: AtomicBool::new(false),
        msg_in: AtomicU64::new(0),
        msg_out: AtomicU64::new(0),
        last_agent_start: AtomicU64::new(0),
        state_path: path,
        bot,
        awaiting_scan,
        http,
        persist: tokio::sync::Mutex::new(persist),
        shared: tokio::sync::Mutex::new(BridgeShared {
            client_id: new_uuid_like(),
            ..Default::default()
        }),
        last_error: std::sync::Mutex::new(String::new()),
    });

    let bot_task = tokio::spawn(bot_loop(rt.clone()));
    let sse = tokio::spawn(sse_loop(rt.clone()));
    {
        let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
        slots.runtime = Some(rt);
        slots.bot_task = Some(bot_task);
        slots.sse_task = Some(sse);
    }
    emit_status(app, json!({ "state": "running" }));
    Ok(())
}

// ── Tauri 命令 ──

/// 开始扫码绑定：bot.login(force) 走 crate 扫码流程，进度通过 ilink-status 事件推送
#[tauri::command]
pub async fn start_ilink_login(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    // 先停掉在跑的 Bridge / 旧登录任务，避免两个 bot 实例并发长轮询
    stop_bridge_slots(&managed)?;
    {
        let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
        if let Some(t) = slots.login_task.take() {
            t.abort();
        }
    }
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        login_flow(app2).await;
    });
    let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
    slots.login_task = Some(task);
    Ok(())
}

/// 取消扫码等待
#[tauri::command]
pub async fn cancel_ilink_login(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    {
        let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
        if let Some(t) = slots.login_task.take() {
            t.abort();
        }
    }
    emit_status(&app, json!({ "state": "stopped" }));
    Ok(())
}

/// 前端提交配对码（登录时微信手机端显示的数字）
#[tauri::command]
pub async fn submit_ilink_verify_code(
    managed: tauri::State<'_, IlinkManaged>,
    code: String,
) -> Result<(), AppError> {
    let tx = {
        let slots = managed.inner.lock().map_err(|e| e.to_string())?;
        slots.verify_tx.clone()
    };
    match tx {
        Some(tx) => tx
            .send(code.trim().to_string())
            .map_err(|_| AppError::from("登录流程已结束，无法提交配对码".to_string())),
        None => bail!("当前没有等待配对码的登录流程"),
    }
}

/// 查询完整状态（含行为配置与统计）
#[tauri::command]
pub async fn get_ilink_status(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<IlinkStatus, AppError> {
    let (logging_in, rt) = {
        let slots = managed.inner.lock().map_err(|e| e.to_string())?;
        let logging = slots
            .login_task
            .as_ref()
            .map(|t| !t.is_finished())
            .unwrap_or(false);
        (logging, slots.runtime.clone())
    };
    if let Some(rt) = rt {
        let p = rt.persist.lock().await.clone();
        let err = rt.last_error.lock().map(|g| g.clone()).unwrap_or_default();
        let state = if rt.awaiting_scan.load(Ordering::Relaxed) {
            "waiting_scan"
        } else if err.is_empty() {
            "running"
        } else {
            "error"
        };
        return Ok(IlinkStatus {
            state: state.to_string(),
            bound: creds_exist(&app),
            enabled: p.enabled,
            bot_id: p.bot_id,
            owner: short_wx_id(&p.owner_wx_id),
            error: err,
            msg_in: rt.msg_in.load(Ordering::Relaxed),
            msg_out: rt.msg_out.load(Ordering::Relaxed),
            follow: p.follow_mode,
        });
    }
    let p = load_persist(&app);
    Ok(IlinkStatus {
        state: if logging_in { "waiting_scan" } else { "stopped" }.to_string(),
        bound: creds_exist(&app),
        enabled: p.enabled,
        bot_id: p.bot_id,
        owner: short_wx_id(&p.owner_wx_id),
        error: String::new(),
        msg_in: 0,
        msg_out: 0,
        follow: p.follow_mode,
    })
}

/// 启动桥接（已绑定、处于暂停状态时恢复）
#[tauri::command]
pub async fn start_ilink_bridge(app: tauri::AppHandle) -> Result<(), AppError> {
    start_bridge_internal(&app).await
}

/// 暂停桥接（保留凭据与会话映射）
#[tauri::command]
pub async fn stop_ilink_bridge(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    let rt = { managed.inner.lock().map_err(|e| e.to_string())?.runtime.clone() };
    if let Some(rt) = rt {
        let mut p = rt.persist.lock().await;
        p.enabled = false;
        save_persist_to(&rt.state_path, &p)?;
    } else {
        let mut p = load_persist(&app);
        p.enabled = false;
        save_persist_to(&state_file_path(&app)?, &p)?;
    }
    stop_bridge_slots(&managed)?;
    emit_status(&app, json!({ "state": "stopped" }));
    Ok(())
}

/// 解绑：停止桥接并删除行为配置与 crate 凭据文件
#[tauri::command]
pub async fn unbind_ilink(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    stop_bridge_slots(&managed)?;
    if let Ok(path) = state_file_path(&app) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(cred) = cred_file_path(&app) {
        let _ = std::fs::remove_file(&cred);
    }
    emit_status(&app, json!({ "state": "stopped", "bound": false }));
    Ok(())
}

/// 设置微信跟随模式开关（Agent 页模型选择旁）：
/// 开 = 微信消息注入桌面当前打开的会话；关 = 不接收微信消息
#[tauri::command]
pub async fn set_ilink_follow(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
    enabled: bool,
) -> Result<(), AppError> {
    let rt = { managed.inner.lock().map_err(|e| e.to_string())?.runtime.clone() };
    if let Some(rt) = rt {
        let mut p = rt.persist.lock().await;
        p.follow_mode = enabled;
        save_persist_to(&rt.state_path, &p)?;
    } else {
        let mut p = load_persist(&app);
        p.follow_mode = enabled;
        save_persist_to(&state_file_path(&app)?, &p)?;
    }
    flow_log(&app, "follow_toggle", &format!("微信跟随模式 = {}", enabled));
    Ok(())
}

/// 前端同步桌面当前打开的会话 ID（切换/新建/删除会话时调用；空字符串 = 未打开）。
/// 存入 slots（不随 Bridge 重启丢失），微信消息以此为目标会话。
#[tauri::command]
pub async fn set_ilink_current_session(
    managed: tauri::State<'_, IlinkManaged>,
    session_id: String,
) -> Result<(), AppError> {
    let sid = session_id.trim().to_string();
    let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
    slots.follow_session = if sid.is_empty() { None } else { Some(sid) };
    Ok(())
}

/// 从 slots 读取桌面当前会话 ID（跨 Bridge 重启存活）
fn current_follow_session(app: &tauri::AppHandle) -> Option<String> {
    let managed = app.state::<IlinkManaged>();
    let slots = managed.inner.lock().ok()?;
    slots.follow_session.clone()
}

// ===== section 4: 扫码登录流程 =====

/// 扫码绑定：bot.login(true) 强制重新走扫码（二维码经 on_qr_url 回调推给前端），
/// 成功后 crate 已将凭据写入 cred_path，这里记录 bot_id 并拉起 Bridge。
async fn login_flow(app: tauri::AppHandle) {
    let awaiting = Arc::new(AtomicBool::new(false));
    let bot = match build_bot(&app, awaiting) {
        Ok(b) => b,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
            return;
        }
    };
    match bot.login(true).await {
        Ok(creds) => {
            flow_log(&app, "login_ok", &format!("account_id={}", creds.account_id));
            let mut p = load_persist(&app);
            p.bot_id = creds.account_id.clone();
            p.enabled = true;
            match state_file_path(&app) {
                Ok(path) => {
                    if let Err(e) = save_persist_to(&path, &p) {
                        emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
                        return;
                    }
                }
                Err(e) => {
                    emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
                    return;
                }
            }
            if let Err(e) = start_bridge_internal(&app).await {
                emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
            }
        }
        Err(e) => {
            emit_status(
                &app,
                json!({ "state": "error", "error": format!("扫码绑定失败: {}", e) }),
            );
        }
    }
}

// ===== section 5: Bridge 主循环（bot.run 收消息） =====

/// 可中断休眠：每秒检查一次停止标志
async fn sleep_cancellable(rt: &IlinkRuntime, secs: u64) {
    for _ in 0..secs {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// 从 AppState 读取当前 admAgent server 的端口 + 工作区 ID（进程存活才算就绪）。
/// Bridge 复用 Agent 页所在的同一工作区，微信触发的会话才能在桌面端 Agent 页可见。
fn current_agent_backend(app: &tauri::AppHandle) -> Option<(u16, String)> {
    let state = app.state::<AppState>();
    let mut s = state.agent_session.lock().ok()?;
    match s.as_mut() {
        Some(sess) => {
            if matches!(sess.child.try_wait(), Ok(None)) && !sess.workspace_id.is_empty() {
                Some((sess.port, sess.workspace_id.clone()))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// admAgent server 未运行时尝试自动拉起（带冷却，失败静默等下轮）
async fn maybe_autostart_agent(rt: &Arc<IlinkRuntime>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = rt.last_agent_start.load(Ordering::Relaxed);
    if now.saturating_sub(last) < AGENT_AUTOSTART_COOLDOWN_SECS {
        return;
    }
    rt.last_agent_start.store(now, Ordering::Relaxed);
    let app = rt.app.clone();
    let state = app.state::<AppState>();
    if let Err(e) = agent::start_agent_server(app.clone(), state).await {
        eprintln!("[ilink] 自动启动 admAgent server 失败: {}", e);
    }
}

/// 读取 config.json（失败返回默认，供工作目录 / YOLO 跟随）
fn load_settings(app: &tauri::AppHandle) -> Settings {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return Settings::default(),
    };
    match std::fs::read_to_string(data_dir.join("config.json")) {
        Ok(s) => serde_json::from_str::<Settings>(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// 写回 config.json 的 agent_plan_mode（读-改-写，保留其它字段）。
/// 供微信端 /plan、/yolo 指令切换模式持久化，与 Agent 页共享同一份 config.json。
fn save_agent_plan_mode(app: &tauri::AppHandle, plan: bool) -> Result<(), AppError> {
    let data_dir = config::get_data_dir(Some(app))?;
    let config_path = data_dir.join("config.json");
    let mut settings = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str::<Settings>(&json).map_err(|e| format!("解析配置文件失败: {}", e))?
    } else {
        Settings::default()
    };
    settings.agent_plan_mode = plan;
    let json =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, &json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// admAgent HTTP POST（返回 HTTP 状态码 + 宽容解析的 JSON）
async fn agent_post(rt: &IlinkRuntime, port: u16, path: &str, body: &Value) -> Result<(u16, Value), AppError> {
    let resp = rt
        .http
        .post(format!("http://127.0.0.1:{}{}", port, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("admAgent 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, v))
}

/// admAgent HTTP GET
async fn agent_get(rt: &IlinkRuntime, port: u16, path: &str) -> Result<(u16, Value), AppError> {
    let resp = rt
        .http
        .get(format!("http://127.0.0.1:{}{}", port, path))
        .send()
        .await
        .map_err(|e| format!("admAgent 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, v))
}

/// Bridge 主任务：登录（复用已存凭据）→ 注册消息处理器 → bot.run 长轮询。
/// 游标持久化 / 重连 / notify_start / context_token 管理均由 crate 内部处理。
async fn bot_loop(rt: Arc<IlinkRuntime>) {
    // 消息处理器：crate 回调是同步的，克隆消息后转入异步任务处理。
    // 用 Weak 断开 rt → bot → handler → rt 的强引用环，Bridge 停止后可正常释放。
    let weak = Arc::downgrade(&rt);
    rt.bot
        .on_message(Box::new(move |msg| {
            let Some(rt) = weak.upgrade() else { return };
            if rt.stop.load(Ordering::Relaxed) {
                return;
            }
            let msg = msg.clone();
            tauri::async_runtime::spawn(async move {
                handle_incoming(&rt, msg).await;
            });
        }))
        .await;

    // 登录：正常直接复用 cred_path 里的凭据；凭据失效时 crate 会重新触发扫码回调
    let creds = match rt.bot.login(false).await {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("微信 Bot 登录失败: {}（如登录已失效请重新扫码绑定）", e);
            set_last_error(&rt, &msg);
            emit_status(&rt.app, json!({ "state": "error", "error": msg }));
            return;
        }
    };
    rt.awaiting_scan.store(false, Ordering::Relaxed);
    {
        let mut p = rt.persist.lock().await;
        if p.bot_id != creds.account_id {
            p.bot_id = creds.account_id.clone();
            let _ = save_persist_to(&rt.state_path, &p);
        }
    }
    flow_log(&rt.app, "bot_login", &format!("account_id={}", creds.account_id));
    emit_status(&rt.app, json!({ "state": "running" }));

    // 长轮询主循环：阻塞直到 stop / 致命错误（网络抖动由 crate 内部重试）
    if let Err(e) = rt.bot.run().await {
        if !rt.stop.load(Ordering::Relaxed) {
            let msg = format!("微信 Bot 连接中断: {}（如登录已失效请重新扫码绑定）", e);
            eprintln!("[ilink] {}", msg);
            set_last_error(&rt, &msg);
            emit_status(&rt.app, json!({ "state": "error", "error": msg }));
        }
    }
}

/// 处理一条 inbound 微信消息（crate 已过滤为用户发出的完整消息）
async fn handle_incoming(rt: &Arc<IlinkRuntime>, msg: wechatbot::IncomingMessage) {
    let from = msg.user_id.clone();
    if from.is_empty() {
        return;
    }
    // dump 原始消息（仅 debug），便于核对 crate 解析结果
    flow_log(&rt.app, "inbound_raw", &format!("{:?}", msg.raw));
    // owner 白名单：首个对话者自动成为 owner，其余人消息忽略
    let owner = {
        let mut p = rt.persist.lock().await;
        if p.owner_wx_id.is_empty() {
            p.owner_wx_id = from.clone();
            let _ = save_persist_to(&rt.state_path, &p);
        }
        p.owner_wx_id.clone()
    };
    if owner != from {
        return;
    }
    // 微信开关关闭：不接收任何微信消息（回一条提示后忽略，避免用户困惑为何无响应）
    if !rt.persist.lock().await.follow_mode {
        send_wx_text(rt, &from, "微信消息接收已关闭。请在电脑端 Agent 页模型选择旁开启「💬 微信」开关。").await;
        return;
    }
    // 提取文本：文本消息直接取；语音消息取转写文字
    let mut text = msg.text.trim().to_string();
    if text.is_empty() && matches!(msg.content_type, ContentType::Voice) {
        text = msg
            .voices
            .iter()
            .filter_map(|v| v.text.clone())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
    }
    // 图片消息：用 crate 的 download 拉取并解密原图，转 base64 附件随消息转发
    // （admAgent POST /agent 支持 attachments，与桌面端发图同一通道）
    let mut attachments: Vec<Value> = Vec::new();
    if matches!(msg.content_type, ContentType::Image) {
        match rt.bot.download(&msg).await {
            Ok(Some(media)) => {
                let ext = media
                    .format
                    .clone()
                    .unwrap_or_default()
                    .trim_start_matches('.')
                    .to_lowercase();
                let mime = match ext.as_str() {
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "bmp" => "image/bmp",
                    "webp" => "image/webp",
                    _ => "image/jpeg",
                };
                let name = media
                    .file_name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| format!("wechat-image.{}", if ext.is_empty() { "jpg" } else { ext.as_str() }));
                flow_log(&rt.app, "inbound_image", &format!("from={} bytes={} mime={} name={}", short_wx_id(&from), media.data.len(), mime, name));
                attachments.push(json!({
                    "file_name": name,
                    "mime_type": mime,
                    "content": base64::engine::general_purpose::STANDARD.encode(&media.data),
                }));
            }
            Ok(None) => {
                // 消息里没有可下载的媒体引用（如仅缩略图未就绪）
                flow_log(&rt.app, "inbound_image", &format!("from={} download 返回 None", short_wx_id(&from)));
                send_wx_text(rt, &from, "❌ 图片获取失败（消息中未找到可下载的媒体），请重发。").await;
                return;
            }
            Err(e) => {
                eprintln!("[ilink] 下载微信图片失败: {}", e);
                flow_log(&rt.app, "inbound_image", &format!("from={} 下载失败: {}", short_wx_id(&from), e));
                send_wx_text(rt, &from, &format!("❌ 图片下载失败：{}", e)).await;
                return;
            }
        }
    }
    if text.is_empty() && attachments.is_empty() {
        if !matches!(msg.content_type, ContentType::Text) {
            send_wx_text(rt, &from, "暂不支持该消息类型，请发送文字或图片。").await;
        }
        return;
    }
    rt.msg_in.fetch_add(1, Ordering::Relaxed);
    let summary = if text.is_empty() { "[图片]".to_string() } else { text.clone() };
    emit_activity(&rt.app, "in", &from, &summary);
    flow_log(&rt.app, "inbound", &format!("from={} atts={} text={}", short_wx_id(&from), attachments.len(), text));

    // 控制指令（本地处理，不进 Agent；带图片时不视为指令）
    if attachments.is_empty() && text.starts_with('/') {
        handle_command(rt, &from, &text).await;
        return;
    }

    forward_to_agent(rt, &from, &text, attachments).await;
}

/// 微信端控制指令：/stop /status /help
async fn handle_command(rt: &Arc<IlinkRuntime>, from: &str, text: &str) {
    let cmd = text.split_whitespace().next().unwrap_or("").to_lowercase();
    match cmd.as_str() {
        "/stop" => {
            let (port, ws) = backend_of(rt).await;
            let sid = current_follow_session(&rt.app);
            match (port, ws, sid) {
                (Some(port), Some(ws), Some(sid)) if !sid.is_empty() => {
                    let path = format!("/v1/workspaces/{}/agent/sessions/{}/cancel", ws, sid);
                    match agent_post(rt, port, &path, &json!({})).await {
                        Ok((200, _)) => send_wx_text(rt, from, "⏹️ 已发送取消指令。").await,
                        Ok((st, _)) => send_wx_text(rt, from, &format!("取消失败：HTTP {}", st)).await,
                        Err(e) => send_wx_text(rt, from, &format!("取消失败：{}", e)).await,
                    }
                }
                _ => send_wx_text(rt, from, "当前没有正在运行的任务。").await,
            }
        }
        "/status" => {
            let (port, ws) = backend_of(rt).await;
            let s = load_settings(&rt.app);
            let workdir = if s.agent_workdir.is_empty() { "（跟随 Agent 页）".to_string() } else { s.agent_workdir.clone() };
            let mode = if s.agent_plan_mode { "Plan（只读计划）" } else { "执行（直接修改）" };
            let mut lines = vec![
                "📊 状态".to_string(),
                format!("工作目录：{}", workdir),
                format!("模式：{}", mode),
            ];
            match (port, ws) {
                (Some(port), Some(ws)) => {
                    match agent_get(rt, port, &format!("/v1/workspaces/{}/agent", ws)).await {
                        Ok((200, info)) => {
                            let model = info
                                .get("model_cfg")
                                .and_then(|m| m.get("model"))
                                .and_then(|m| m.as_str())
                                .unwrap_or("未知");
                            let provider = info
                                .get("model_cfg")
                                .and_then(|m| m.get("provider"))
                                .and_then(|m| m.as_str())
                                .unwrap_or("未知");
                            let busy = info.get("is_busy").and_then(|b| b.as_bool()).unwrap_or(false);
                            lines.push(format!("模型：{} ({})", model, provider));
                            lines.push(format!("运行中：{}", if busy { "是" } else { "否" }));
                        }
                        _ => lines.push("Agent 信息获取失败".to_string()),
                    }
                }
                _ => lines.push("Agent 服务：未就绪".to_string()),
            }
            send_wx_text(rt, from, &lines.join("\n")).await;
        }
        "/plan" => set_plan_mode(rt, from, true).await,
        "/yolo" | "/execute" => set_plan_mode(rt, from, false).await,
        "/help" | "/h" => {
            send_wx_text(
                rt,
                from,
                "🤖 ADM Agent 指令：\n/plan  切换只读计划模式\n/yolo  切换执行模式\n/stop  取消当前任务\n/status  查看运行状态\n/help  显示本帮助\n\n消息会进入电脑端当前打开的会话。",
            )
            .await;
        }
        _ => {
            send_wx_text(rt, from, "未知指令，发送 /help 查看可用指令。").await;
        }
    }
}

/// 切换 Agent 模式（Plan / 执行），供微信端 /plan、/yolo 指令复用：
/// 写回 config.json → 若后端就绪则实时同步 agent/mode → 发 Tauri 事件让 Agent 页按钮跟随 → 回微信确认。
async fn set_plan_mode(rt: &Arc<IlinkRuntime>, from: &str, plan: bool) {
    if let Err(e) = save_agent_plan_mode(&rt.app, plan) {
        send_wx_text(rt, from, &format!("❌ 切换模式失败：{}", e)).await;
        return;
    }
    // 后端就绪时实时同步到当前工作区（旧版 admAgent 无此接口时忽略失败，写盘仍生效）
    let (port, ws) = backend_of(rt).await;
    if let (Some(port), Some(ws)) = (port, ws) {
        let _ = agent_post(rt, port, &format!("/v1/workspaces/{}/agent/mode", ws), &json!({ "plan": plan })).await;
    }
    // 通知前端 Agent 页更新模式按钮/输入框，保持两端一致
    let _ = rt.app.emit("agent-mode-changed", json!({ "plan": plan }));
    flow_log(&rt.app, "set_mode", &format!("plan={}", plan));
    let reply = if plan {
        "📋 已切换到 Plan 模式（只读计划，不修改文件）。"
    } else {
        "⚡ 已切换到执行模式（直接执行修改）。"
    };
    send_wx_text(rt, from, reply).await;
}

/// 读取当前后端（端口 + 工作区）。直接实时读 AppState（前端当前订阅的工作区），
/// 而非 Bridge 的 SSE 缓存：避免前端切换工作区后的窗口期内把微信消息发进旧（孤儿）工作区。
async fn backend_of(rt: &Arc<IlinkRuntime>) -> (Option<u16>, Option<String>) {
    match current_agent_backend(&rt.app) {
        Some((p, w)) => (Some(p), Some(w)),
        None => (None, None),
    }
}

/// 转发消息给 admAgent（fire-and-forget，结果由 SSE run_complete 回投）。
/// 微信消息直接注入桌面当前打开的会话（开关已在 handle_incoming 入口校验）。
/// attachments：图片等附件（base64），与桌面端 send.js 的 attachments 字段同格式。
async fn forward_to_agent(rt: &Arc<IlinkRuntime>, from: &str, text: &str, attachments: Vec<Value>) {
    let (port, ws) = backend_of(rt).await;
    let (port, ws) = match (port, ws) {
        (Some(p), Some(w)) => (p, w),
        _ => {
            send_wx_text(rt, from, "⏳ Agent 服务尚未就绪，请先在电脑端打开 Agent 页。").await;
            return;
        }
    };
    // 带图时校验当前模型是否支持图片（对齐桌面端 send.js 的 supports_images 检查），
    // 否则图片会被模型静默忽略，用户以为 Agent 看到了图
    if !attachments.is_empty() {
        if let Ok((200, info)) = agent_get(rt, port, &format!("/v1/workspaces/{}/agent", ws)).await {
            let supports = info
                .get("model")
                .and_then(|m| m.get("supports_images"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if !supports {
                let model = info
                    .get("model")
                    .and_then(|m| m.get("id"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知");
                send_wx_text(rt, from, &format!("❌ 当前模型（{}）不支持图片，请在电脑端切换到支持图片的模型后重发。", model)).await;
                return;
            }
        }
    }
    // 目标会话 = 桌面当前打开的会话（从 slots 读，跨 Bridge 重启存活）；未打开时提示用户
    let sid = match current_follow_session(&rt.app) {
        Some(s) if !s.is_empty() => s,
        _ => {
            send_wx_text(rt, from, "请先在电脑端 Agent 页打开（或新建）一个会话，微信消息将进入该会话。").await;
            return;
        }
    };
    let run_id = format!("wx-{:016x}", rand::random::<u64>());
    rt.shared.lock().await.runs.insert(
        run_id.clone(),
        RunRoute { wx_user: from.to_string(), session_id: sid.clone() },
    );
    flow_log(&rt.app, "forward", &format!("run_id={} session={} port={} atts={} prompt={}", run_id, sid, port, attachments.len(), text));
    // 前置来源标注，让 Agent 上下文可区分远程消息；纯图无文字时给默认提示词
    let prompt = if text.is_empty() {
        "[来自微信远程消息]\n（用户发来一张图片，请查看并处理）".to_string()
    } else {
        format!("[来自微信远程消息]\n{}", text)
    };
    let mut body = json!({ "session_id": sid, "run_id": run_id, "prompt": prompt });
    if !attachments.is_empty() {
        body["attachments"] = Value::Array(attachments);
    }
    match agent_post(rt, port, &format!("/v1/workspaces/{}/agent", ws), &body).await {
        Ok((202, _)) | Ok((200, _)) => {
            flow_log(&rt.app, "forward_ok", &format!("run_id={} 已提交 admAgent（等待 run_complete 回复）", run_id));
            // 启动原生"正在输入"状态：周期续发，本 run 完成（从 runs 移除）时停止。
            // 不发文本占位气泡，避免留下多余消息。
            spawn_typing(rt, from, &run_id);
        }
        Ok((409, _)) => {
            rt.shared.lock().await.runs.remove(&run_id);
            send_wx_text(rt, from, "⚠️ 上一个任务仍在执行且无法排队，请稍后再试。").await;
        }
        Ok((404, _)) => {
            // 桌面会话已失效（如被删除/切走）：提示用户重选
            rt.shared.lock().await.runs.remove(&run_id);
            send_wx_text(rt, from, "桌面当前会话已失效，请在电脑端重新打开一个会话后重发。").await;
        }
        Ok((st, v)) => {
            rt.shared.lock().await.runs.remove(&run_id);
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
            send_wx_text(rt, from, &format!("❌ 发送失败：HTTP {} {}", st, msg)).await;
        }
        Err(e) => {
            rt.shared.lock().await.runs.remove(&run_id);
            send_wx_text(rt, from, &format!("❌ 发送失败：{}", e)).await;
        }
    }
}

// ===== section 6: admAgent SSE 订阅 =====

/// 启动"正在输入"状态循环：typing 有时效，每 4s 续发（bot.send_typing 内部处理 ticket）；
/// 以 run_id 是否仍在 runs 中作为停止信号（run_complete/错误分支会移除它）。
fn spawn_typing(rt: &Arc<IlinkRuntime>, wx_user: &str, run_id: &str) {
    let rt2 = rt.clone();
    let wx = wx_user.to_string();
    let rid = run_id.to_string();
    tokio::spawn(async move {
        for _ in 0..75 {
            if rt2.stop.load(Ordering::Relaxed) {
                return;
            }
            if !rt2.shared.lock().await.runs.contains_key(&rid) {
                return;
            }
            let ok = rt2.bot.send_typing(&wx).await.is_ok();
            flow_log(&rt2.app, "typing", &format!("to={} sent={}", short_wx_id(&wx), ok));
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    });
}

/// 后端监督 + SSE 订阅循环：等待 admAgent server → 建工作区 → 订阅事件流。
/// admAgent 未运行时尝试自动拉起（带冷却）；断流后自动重连。
async fn sse_loop(rt: Arc<IlinkRuntime>) {
    // SSE 是无限期长连接：只限制建连耗时，不给流本身设总超时（同 agent.rs 注释）
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_last_error(&rt, &format!("创建 SSE 客户端失败: {}", e));
            return;
        }
    };
    loop {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        // 复用 Agent 页所在工作区（AppState 中 admAgent server 创建的那个），
        // 微信会话才能出现在桌面端 Agent 页会话列表里（同工作区 session SSE 广播）。
        let (port, agent_ws) = match current_agent_backend(&rt.app) {
            Some(pw) => pw,
            None => {
                {
                    let mut s = rt.shared.lock().await;
                    s.port = None;
                    s.workspace_id = None;
                }
                maybe_autostart_agent(&rt).await;
                sleep_cancellable(&rt, 2).await;
                continue;
            }
        };
        // 工作区变化（Agent 页切目录/重启）或首次：采用新工作区并设置权限跳过
        let need_setup = {
            let s = rt.shared.lock().await;
            s.workspace_id.as_deref() != Some(agent_ws.as_str()) || s.port != Some(port)
        };
        if need_setup {
            if let Err(e) = adopt_workspace(&rt, port, &agent_ws).await {
                eprintln!("[ilink] 采用工作区失败: {}", e);
                set_last_error(&rt, &format!("采用工作区失败: {}", e));
                sleep_cancellable(&rt, 3).await;
                continue;
            }
            set_last_error(&rt, "");
            flow_log(&rt.app, "adopt_ws", &format!("复用 Agent 页工作区 ws={} port={}", agent_ws, port));
        }
        let (ws, cid) = {
            let s = rt.shared.lock().await;
            match (&s.workspace_id, &s.client_id) {
                (Some(w), c) => (w.clone(), c.clone()),
                _ => continue,
            }
        };
        let url = format!("http://127.0.0.1:{}/v1/workspaces/{}/events?client_id={}", port, ws, cid);
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[ilink] SSE 连接失败: {}", e);
                sleep_cancellable(&rt, 2).await;
                continue;
            }
        };
        if resp.status().as_u16() == 404 {
            // 工作区已被服务端 teardown：下轮重建
            rt.shared.lock().await.workspace_id = None;
            sleep_cancellable(&rt, 1).await;
            continue;
        }
        if !resp.status().is_success() {
            sleep_cancellable(&rt, 2).await;
            continue;
        }
        eprintln!("[ilink] SSE 已连接 workspace: {}", ws);

        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        'stream: loop {
            // 带超时读流：空闲工作区无事件 chunk，stream.next() 会无限阻塞，
            // 导致前端切换工作区后 Bridge 永远跟不上（微信消息发进孤儿工作区）。
            // 每 5s 醒来检查一次 AppState 工作区是否变化，变了就断流重连跟随。
            let chunk_result = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
                Ok(Some(r)) => r,
                Ok(None) => break 'stream, // 流结束
                Err(_) => {
                    // 读超时：检查停止标志与工作区是否已变更
                    if rt.stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let latest = current_agent_backend(&rt.app);
                    let stale = match &latest {
                        Some((p, w)) => *p != port || w != &ws,
                        None => true,
                    };
                    if stale {
                        flow_log(&rt.app, "ws_follow", &format!("前端工作区已变更（旧 ws={}），断流跟随", ws));
                        rt.shared.lock().await.workspace_id = None;
                        break 'stream;
                    }
                    continue 'stream;
                }
            };
            if rt.stop.load(Ordering::Relaxed) {
                return;
            }
            // 设置热生效：workspace_id 被置空时放弃当前流，重建
            if rt.shared.lock().await.workspace_id.is_none() {
                break 'stream;
            }
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(_) => break 'stream,
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find("\n\n") {
                let event_text = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();
                let mut event_name = String::new();
                let mut event_data = String::new();
                for line in event_text.lines() {
                    if let Some(d) = line.strip_prefix("event: ") {
                        event_name = d.to_string();
                    } else if let Some(d) = line.strip_prefix("data: ") {
                        event_data = d.to_string();
                    }
                }
                if event_data.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&event_data) {
                    handle_sse_event(&rt, &v, &event_name).await;
                }
            }
        }
        // 断流后立即重连（工作区可能仍存活，保留 workspace_id 由 404 分支兜底）
        if !rt.stop.load(Ordering::Relaxed) {
            eprintln!("[ilink] SSE 流断开，重连");
        }
    }
}

/// 采用 Agent 页所在工作区（不再自建独立工作区），使微信会话在桌面端 Agent 页可见。
/// 最小侵入原则：仅在 Agent 未就绪时才 init，仅在状态与期望不一致时才设置。
async fn adopt_workspace(rt: &Arc<IlinkRuntime>, port: u16, ws: &str) -> Result<(), AppError> {
    let ready = match agent_get(rt, port, &format!("/v1/workspaces/{}/agent", ws)).await {
        Ok((200, info)) => info.get("is_ready").and_then(|b| b.as_bool()).unwrap_or(false),
        _ => false,
    };
    if !ready {
        let (st, _) = agent_post(rt, port, &format!("/v1/workspaces/{}/agent/init", ws), &json!({})).await?;
        if st != 200 {
            bail!("初始化 Agent 失败: HTTP {}", st);
        }
        flow_log(&rt.app, "adopt_init", &format!("ws={} 未就绪，已 init", ws));
    }
    // 审批模式已移除：权限请求恒直通（skip=true），只读约束由 Plan 模式的服务端工具集承担
    let cur_skip = match agent_get(rt, port, &format!("/v1/workspaces/{}/permissions/skip", ws)).await {
        Ok((200, v)) => v.get("skip").and_then(|b| b.as_bool()),
        _ => None,
    };
    if cur_skip != Some(true) {
        let _ = agent_post(rt, port, &format!("/v1/workspaces/{}/permissions/skip", ws), &json!({ "skip": true })).await;
        flow_log(&rt.app, "adopt_skip", &format!("ws={} skip {:?} -> true", ws, cur_skip));
    }
    // 同步 Plan 模式（跟随 Agent 页设置；旧版 admAgent 无此接口时忽略失败）
    let want_plan = load_settings(&rt.app).agent_plan_mode;
    let cur_plan = match agent_get(rt, port, &format!("/v1/workspaces/{}/agent/mode", ws)).await {
        Ok((200, v)) => v.get("plan").and_then(|b| b.as_bool()),
        _ => None,
    };
    if cur_plan != Some(want_plan) {
        let _ = agent_post(rt, port, &format!("/v1/workspaces/{}/agent/mode", ws), &json!({ "plan": want_plan })).await;
        flow_log(&rt.app, "adopt_plan", &format!("ws={} plan {:?} -> {}", ws, cur_plan, want_plan));
    }
    let mut s = rt.shared.lock().await;
    s.port = Some(port);
    s.workspace_id = Some(ws.to_string());
    Ok(())
}

/// 处理一条 admAgent SSE 事件（信封：{type, payload: {type, payload}}；
/// 事件名优先取 data JSON 的 type，缺失时回退 SSE `event:` 行）
async fn handle_sse_event(rt: &Arc<IlinkRuntime>, v: &Value, event_name: &str) {
    let etype_owned = v
        .get("type")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .unwrap_or(event_name)
        .to_string();
    let etype = etype_owned.as_str();
    let payload = v.get("payload").cloned().unwrap_or(Value::Null);
    let inner = payload.get("payload").cloned().unwrap_or_else(|| payload.clone());
    if etype != "message" && etype != "session" && !etype.is_empty() {
        let brief: String = inner.to_string().chars().take(300).collect();
        flow_log(&rt.app, "sse_event", &format!("type={} {}", etype, brief));
    }
    match etype {
        "run_complete" => {
            let run_id = inner.get("run_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let session_id = inner.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let route = {
                let mut s = rt.shared.lock().await;
                let key = if !run_id.is_empty() {
                    if s.runs.contains_key(&run_id) { Some(run_id.clone()) } else { None }
                } else if !session_id.is_empty() {
                    s.runs
                        .iter()
                        .find(|(_, r)| r.session_id == session_id)
                        .map(|(k, _)| k.clone())
                } else {
                    None
                };
                key.and_then(|k| s.runs.remove(&k))
            };
            let Some(route) = route else {
                flow_log(&rt.app, "run_complete_unmatched", &format!("run_id={} session={} 非微信触发的运行，不回投", run_id, session_id));
                return;
            };
            let wx = route.wx_user;
            let error = inner.get("error").and_then(|e| e.as_str()).unwrap_or("");
            let cancelled = inner.get("cancelled").and_then(|c| c.as_bool()).unwrap_or(false);
            let text = inner.get("text").and_then(|t| t.as_str()).unwrap_or("");
            flow_log(&rt.app, "run_complete", &format!("wx={} run_id={} error={} cancelled={} text_len={}", short_wx_id(&wx), run_id, error, cancelled, text.chars().count()));
            let reply = if !error.is_empty() {
                format!("❌ 执行出错：{}", error)
            } else if cancelled {
                "⏹️ 任务已取消。".to_string()
            } else if text.trim().is_empty() {
                "✅ 任务完成（无文本输出）。".to_string()
            } else {
                downgrade_markdown(text)
            };
            send_wx_text(rt, &wx, &reply).await;
        }
        "permission_request" => {
            // 审批模式已移除：skip=true 下正常不会收到；同步瞬间的竞态请求直接放行，
            // 避免微信触发的运行被卡住（Plan 模式下服务端只挂载只读工具，放行的也只能是读操作）
            let (port, ws) = backend_of(rt).await;
            if let (Some(port), Some(ws)) = (port, ws) {
                let body = json!({ "permission": inner, "action": "allow" });
                let _ = agent_post(rt, port, &format!("/v1/workspaces/{}/permissions/grant", ws), &body).await;
                flow_log(&rt.app, "perm_auto_allow", "权限请求已自动放行（审批模式已移除）");
            }
        }
        _ => {}
    }
}

/// 发送一条微信消息（单条，不分段）：bot.send 内部管理 context_token / base_info。
/// NoContext（Bridge 重启后尚无 inbound）不重试；其余错误重试 3 次。
async fn send_wx_msg(rt: &Arc<IlinkRuntime>, wx_user: &str, text: &str) -> bool {
    let mut sent = false;
    for attempt in 0..3 {
        match rt.bot.send(wx_user, text).await {
            Ok(()) => {
                sent = true;
                break;
            }
            Err(WeChatBotError::NoContext(uid)) => {
                eprintln!("[ilink] sendmessage 失败：尚无 {} 的 context_token（需等对方先发一条消息）", short_wx_id(&uid));
                break;
            }
            Err(e) => {
                eprintln!("[ilink] sendmessage 失败: {} (第{}次)", e, attempt + 1);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if sent {
        rt.msg_out.fetch_add(1, Ordering::Relaxed);
        emit_activity(&rt.app, "out", wx_user, text);
        flow_log(&rt.app, "reply_ok", &format!("to={} text={}", short_wx_id(wx_user), text));
    } else {
        emit_activity(&rt.app, "err", wx_user, "消息发送失败（已重试）");
        flow_log(&rt.app, "reply_fail", &format!("to={} 发送失败", short_wx_id(wx_user)));
    }
    sent
}

/// 发送文本到微信（自动分段，段间 300ms 限速）。
async fn send_wx_text(rt: &Arc<IlinkRuntime>, wx_user: &str, text: &str) {
    let chunks = split_chunks(text, WX_CHUNK_CHARS);
    let total = chunks.len();
    for (i, chunk) in chunks.into_iter().enumerate() {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        let body_text = if total > 1 { format!("{}\n({}/{})", chunk, i + 1, total) } else { chunk };
        send_wx_msg(rt, wx_user, &body_text).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// ===== section 7: 消息转换工具 =====

/// 流程调试日志：仅 debug 构建写盘，release 不产生任何文件。
#[cfg(debug_assertions)]
fn flow_log(app: &tauri::AppHandle, stage: &str, detail: &str) {
    eprintln!("[ilink][flow] {} | {}", stage, detail);
    if let Ok(dir) = config::get_data_dir(Some(app)) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let flat: String = detail.replace('\n', " ↵ ").chars().take(1500).collect();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("ilink_flow_debug.log"))
        {
            let _ = writeln!(f, "{} [{}] {}", ts, stage, flat);
        }
    }
}

/// release 构建：流程调试日志为空操作。
#[cfg(not(debug_assertions))]
fn flow_log(_app: &tauri::AppHandle, _stage: &str, _detail: &str) {}

/// Markdown 降级为微信可读纯文本：去代码围栏、标题转【】、去加粗星号
fn downgrade_markdown(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            continue;
        }
        let mut l = line.to_string();
        if trimmed.starts_with('#') {
            let title = trimmed.trim_start_matches('#').trim();
            if title.is_empty() {
                continue;
            }
            l = format!("【{}】", title);
        }
        l = l.replace("**", "");
        out.push(l);
    }
    out.join("\n").trim().to_string()
}

/// 按字符数分段，优先在换行处切分（不早于段中点）
fn split_chunks(text: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        let mut cut = end;
        if end < chars.len() {
            let floor = start + max_chars / 2;
            for i in (floor..end).rev() {
                if chars[i] == '\n' {
                    cut = i + 1;
                    break;
                }
            }
        }
        let seg: String = chars[start..cut].iter().collect();
        let seg = seg.trim().to_string();
        if !seg.is_empty() {
            chunks.push(seg);
        }
        start = cut;
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

