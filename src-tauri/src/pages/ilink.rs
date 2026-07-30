// iLink Bot（微信个人号机器人）桥接：扫码登录、长轮询收消息、转发 admAgent、回复微信。
// 协议与方案见 doc/ilink-bot.md；admAgent 侧仅调用现有 HTTP API（doc/server-api.md），admAgent 源码零改动。
//
// 结构：
//   section 1: 常量 / 持久化（ilink_state.json）
//   section 2: iLink HTTP 客户端（鉴权头 / GET / POST）
//   section 3: 运行时（IlinkRuntime / IlinkManaged）与 Tauri 命令
//   section 4: 扫码登录流程
//   section 5: Bridge 主循环（长轮询收消息 → admAgent）
//   section 6: admAgent SSE 订阅（run_complete / permission_request → 回复微信）
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

// ===== section 1: 常量与持久化 =====

/// iLink 官方接入域名（登录后可能被 get_qrcode_status 返回的 baseurl 覆盖）
const ILINK_BASE: &str = "https://ilinkai.weixin.qq.com";
/// getupdates 请求 base_info.channel_version
const CHANNEL_VERSION: &str = "1.0.2";
/// 单条微信消息最大字符数，超出按此分段
const WX_CHUNK_CHARS: usize = 1800;
/// 微信端权限确认超时（秒），超时自动拒绝
const PERM_TIMEOUT_SECS: u64 = 120;
/// admAgent server 自动拉起的重试冷却（秒）
const AGENT_AUTOSTART_COOLDOWN_SECS: u64 = 60;

/// ilink_state.json：凭据 + 游标 + Bot 行为配置。
/// 与 config.json 分开存放：更新频繁（游标每轮落盘）且含登录凭据，
/// 避免被设置页整体覆盖 Settings 时误清。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct IlinkPersist {
    /// Bot 总开关（绑定成功自动置 true；暂停置 false）
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_token: String,
    /// 登录返回的专属 baseurl（非空时优先于官方域名）
    #[serde(default)]
    pub baseurl: String,
    #[serde(default)]
    pub bot_id: String,
    /// 首个对话者自动成为 owner，其余消息忽略（防陌生人驱动 Agent）
    #[serde(default)]
    pub owner_wx_id: String,
    /// getupdates 游标，必须每轮更新并落盘，否则重启后重复收消息
    #[serde(default)]
    pub get_updates_buf: String,
    /// 微信开关：开 = 微信消息注入桌面当前打开的会话；关 = 不接收微信消息
    #[serde(default)]
    pub follow_mode: bool,
    /// owner 最近一条 inbound 消息的 context_token（回复必带；落盘防 Bridge 重启后丢失）
    #[serde(default)]
    pub last_context_token: String,
}


fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(config::get_data_dir(Some(app))?.join("ilink_state.json"))
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

// ===== section 2: iLink HTTP 客户端 =====

/// iLink 固定请求头：AuthorizationType + 随机 X-WECHAT-UIN（防重放）+ Bearer token
fn ilink_headers(bot_token: &str) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    let mut h = HeaderMap::new();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert("AuthorizationType", HeaderValue::from_static("ilink_bot_token"));
    let uin = base64::engine::general_purpose::STANDARD.encode(rand::random::<u32>().to_string());
    if let Ok(v) = HeaderValue::from_str(&uin) {
        h.insert("X-WECHAT-UIN", v);
    }
    if !bot_token.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", bot_token)) {
            h.insert(AUTHORIZATION, v);
        }
    }
    h
}

/// GET 请求，返回 (HTTP 状态码, 响应 JSON)。响应体解析宽容（非 JSON 时返回空对象）。
async fn ilink_get(
    client: &reqwest::Client,
    base: &str,
    path_query: &str,
    token: &str,
) -> Result<(u16, Value), AppError> {
    let resp = client
        .get(format!("{}{}", base.trim_end_matches('/'), path_query))
        .headers(ilink_headers(token))
        .send()
        .await
        .map_err(|e| format!("iLink 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, v))
}

/// POST 请求，返回 (HTTP 状态码, 响应 JSON)。
/// 对齐官方 demo：所有 POST 请求体顶层统一注入 base_info.channel_version。
async fn ilink_post(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
    body: &Value,
) -> Result<(u16, Value), AppError> {
    let mut payload = body.clone();
    if payload.get("base_info").is_none() {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("base_info".to_string(), json!({ "channel_version": CHANNEL_VERSION }));
        }
    }
    let resp = client
        .post(format!("{}{}", base.trim_end_matches('/'), path))
        .headers(ilink_headers(token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("iLink 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, v))
}

// ===== section 3: 运行时与 Tauri 命令 =====

/// 在途运行路由：run_complete 回投目标
struct RunRoute {
    wx_user: String,
    session_id: String,
}

/// Bridge 运行期共享数据（poll 任务与 SSE 任务共用）
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
    /// 微信用户 ID → 最近一条 inbound 消息的 context_token（回复必带）
    ctx_tokens: HashMap<String, String>,
    /// 微信用户 ID → 待审批的权限请求 payload（wechat_approve 模式）
    pending_perm: HashMap<String, Value>,
}

/// Bridge 运行时：poll / SSE 两个 tokio 任务共享一个 Arc
pub struct IlinkRuntime {
    app: tauri::AppHandle,
    stop: AtomicBool,
    msg_in: AtomicU64,
    msg_out: AtomicU64,
    /// 上次尝试自动拉起 admAgent server 的时间戳（epoch 秒，冷却用）
    last_agent_start: AtomicU64,
    state_path: PathBuf,
    /// admAgent / sendmessage 用短超时客户端（长轮询与 SSE 各自单独建）
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
    poll_task: Option<tokio::task::JoinHandle<()>>,
    sse_task: Option<tokio::task::JoinHandle<()>>,
    login_task: Option<tokio::task::JoinHandle<()>>,
    login_cancel: Option<Arc<AtomicBool>>,
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

/// 生成 UUID 形式的随机 ID（与 agent.rs client_id same 格式）
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
/// 实测 get_bot_qrcode 的 qrcode_img_content 返回的是待扫链接
/// （https://liteapp.weixin.qq.com/q/...）而非图片，需本地生成二维码。
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
        if p.enabled && !p.bot_token.is_empty() {
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
    if let Some(t) = slots.poll_task.take() {
        t.abort();
    }
    if let Some(t) = slots.sse_task.take() {
        t.abort();
    }
    Ok(())
}

/// 启动 Bridge（要求已有 bot_token）；重复调用会先停旧任务
pub async fn start_bridge_internal(app: &tauri::AppHandle) -> Result<(), AppError> {
    let managed = app.state::<IlinkManaged>();
    stop_bridge_slots(&managed)?;

    let mut persist = load_persist(app);
    if persist.bot_token.is_empty() {
        bail!("尚未绑定微信 Bot，请先扫码绑定");
    }
    persist.enabled = true;
    let path = state_file_path(app)?;
    save_persist_to(&path, &persist)?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let rt = Arc::new(IlinkRuntime {
        app: app.clone(),
        stop: AtomicBool::new(false),
        msg_in: AtomicU64::new(0),
        msg_out: AtomicU64::new(0),
        last_agent_start: AtomicU64::new(0),
        state_path: path,
        http,
        persist: tokio::sync::Mutex::new(persist),
        shared: tokio::sync::Mutex::new(BridgeShared {
            client_id: new_uuid_like(),
            ..Default::default()
        }),
        last_error: std::sync::Mutex::new(String::new()),
    });

    let poll = tokio::spawn(poll_loop(rt.clone()));
    let sse = tokio::spawn(sse_loop(rt.clone()));
    {
        let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
        slots.runtime = Some(rt);
        slots.poll_task = Some(poll);
        slots.sse_task = Some(sse);
    }
    emit_status(app, json!({ "state": "running" }));
    Ok(())
}

// ── Tauri 命令 ──

/// 开始扫码绑定：获取二维码并后台轮询扫码状态，进度通过 ilink-status 事件推送
#[tauri::command]
pub async fn start_ilink_login(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slots = managed.inner.lock().map_err(|e| e.to_string())?;
        if let Some(c) = slots.login_cancel.take() {
            c.store(true, Ordering::Relaxed);
        }
        if let Some(t) = slots.login_task.take() {
            t.abort();
        }
        slots.login_cancel = Some(cancel.clone());
    }
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        login_flow(app2, cancel).await;
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
        if let Some(c) = slots.login_cancel.take() {
            c.store(true, Ordering::Relaxed);
        }
        if let Some(t) = slots.login_task.take() {
            t.abort();
        }
    }
    emit_status(&app, json!({ "state": "stopped" }));
    Ok(())
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
        return Ok(IlinkStatus {
            state: if err.is_empty() { "running" } else { "error" }.to_string(),
            bound: !p.bot_token.is_empty(),
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
        bound: !p.bot_token.is_empty(),
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

/// 暂停桥接（保留 token 与会话映射）
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

/// 解绑：停止桥接并删除凭据 / 游标 / 会话映射
#[tauri::command]
pub async fn unbind_ilink(
    app: tauri::AppHandle,
    managed: tauri::State<'_, IlinkManaged>,
) -> Result<(), AppError> {
    stop_bridge_slots(&managed)?;
    let path = state_file_path(&app)?;
    let _ = std::fs::remove_file(&path);
    emit_status(&app, json!({ "state": "stopped", "bound": false }));
    Ok(())
}

/// 设置微信跟随模式开关（Agent 页模型选择旁）：
/// 开 = 微信消息注入桌面当前打开的会话；关 = 用微信专属会话（微信·xxx）
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

async fn login_flow(app: tauri::AppHandle, cancel: Arc<AtomicBool>) {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": format!("创建 HTTP 客户端失败: {}", e) }));
            return;
        }
    };

    // 1. 获取登录二维码
    let (st, qr) = match ilink_get(&client, ILINK_BASE, "/ilink/bot/get_bot_qrcode?bot_type=3", "").await {
        Ok(r) => r,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": format!("获取二维码失败: {}", e) }));
            return;
        }
    };
    if st != 200 {
        emit_status(&app, json!({ "state": "error", "error": format!("获取二维码失败: HTTP {}", st) }));
        return;
    }
    let qrcode = qr.get("qrcode").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let qr_content = qr.get("qrcode_img_content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let qr_url = qr.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if qrcode.is_empty() {
        emit_status(&app, json!({ "state": "error", "error": "获取二维码失败：响应缺少 qrcode 字段" }));
        return;
    }
    // qrcode_img_content 实测是待扫链接而非图片：本地渲染成二维码；若未来改回 data URL 图片则直传
    let scan_target = if !qr_content.is_empty() { qr_content.clone() } else { qr_url.clone() };
    let qr_img = if scan_target.starts_with("data:image") {
        scan_target.clone()
    } else if !scan_target.is_empty() {
        qr_svg_data_url(&scan_target).unwrap_or_default()
    } else {
        String::new()
    };
    emit_status(&app, json!({ "state": "waiting_scan", "qrcode_img": qr_img, "qrcode_url": scan_target }));

    // 2. 轮询扫码状态。实测该接口是长轮询：未扫码时服务端 hold 住连接（>15s），
    // 确认信号只在被 hold 的连接上下发，客户端超时过短会把它掉丢。
    // 因此用 70s 长超时客户端 + 断开后立即重连，总等待窗口 300s。
    let poll_client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(70))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": format!("创建 HTTP 客户端失败: {}", e) }));
            return;
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_status(&app, json!({ "state": "stopped" }));
            return;
        }
        if tokio::time::Instant::now() > deadline {
            emit_status(&app, json!({ "state": "error", "error": "扫码超时（300 秒），请重新绑定" }));
            return;
        }
        let (st, resp) = match ilink_get(
            &poll_client,
            ILINK_BASE,
            &format!("/ilink/bot/get_qrcode_status?qrcode={}", qrcode),
            "",
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                // 长轮询到期/瞬时网络错误：立即重连
                eprintln!("[ilink] get_qrcode_status 重连: {}", e);
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        log_login_debug(&app, st, &resp);
        if st != 200 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        // 成功判定从宽：响应里出现 bot_token 即视为确认（status 取值命名未公开，不依赖它）
        let token = resp.get("bot_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let status_str = resp
            .get("status")
            .map(|s| if s.is_string() { s.as_str().unwrap_or("").to_string() } else { s.to_string() })
            .unwrap_or_default()
            .to_lowercase();
        if !token.is_empty() {
            let baseurl = resp.get("baseurl").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let path = match state_file_path(&app) {
                Ok(p) => p,
                Err(e) => {
                    emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
                    return;
                }
            };
            let mut p = load_persist(&app);
            p.bot_token = token;
            p.baseurl = baseurl;
            p.enabled = true;
            if let Some(bid) = resp.get("bot_id").and_then(|v| v.as_str()) {
                p.bot_id = bid.to_string();
            }
            if let Err(e) = save_persist_to(&path, &p) {
                emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
                return;
            }
            if let Err(e) = start_bridge_internal(&app).await {
                emit_status(&app, json!({ "state": "error", "error": format!("{}", e) }));
            }
            return;
        }
        if status_str.contains("confirm") || status_str.contains("success") {
            emit_status(&app, json!({ "state": "error", "error": "扫码已确认但响应缺少 bot_token（原始响应已记入 ilink_login_debug.log）" }));
            return;
        }
        if status_str.contains("expire") || status_str.contains("cancel") || status_str.contains("invalid") {
            emit_status(&app, json!({ "state": "error", "error": "二维码已过期或已取消，请重新绑定" }));
            return;
        }
        // 未扫码 / 已扫待确认：立即继续长轮询（不额外 sleep，避免错过确认窗口）
    }
}

/// 登录调试日志：把 get_qrcode_status 原始响应（bot_token 脱敏）写入 stderr 与数据目录日志文件，
/// 用于定位腾讯未公开的字段/状态取值。仅 debug 构建写盘，release 不产生任何文件。
#[cfg(debug_assertions)]
fn log_login_debug(app: &tauri::AppHandle, http_status: u16, v: &Value) {
    let mut redacted = v.clone();
    if redacted.get("bot_token").is_some() {
        redacted["bot_token"] = json!("***");
    }
    let line: String = redacted.to_string().chars().take(600).collect();
    eprintln!("[ilink] qrcode_status HTTP {}: {}", http_status, line);
    if let Ok(dir) = config::get_data_dir(Some(app)) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("ilink_login_debug.log"))
        {
            let _ = writeln!(f, "{} HTTP {} {}", ts, http_status, line);
        }
    }
}

/// release 构建：登录调试日志为空操作（不写盘、不打印）。
#[cfg(not(debug_assertions))]
fn log_login_debug(_app: &tauri::AppHandle, _http_status: u16, _v: &Value) {}


// ===== section 5: Bridge 主循环（长轮询收消息） =====

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

/// 长轮询主循环：getupdates（服务器 hold ≤35s）→ 逐条处理
async fn poll_loop(rt: Arc<IlinkRuntime>) {
    // 长轮询专用客户端：总超时必须覆盖 35s hold
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(50))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_last_error(&rt, &format!("创建长轮询客户端失败: {}", e));
            return;
        }
    };
    let mut backoff: u64 = 1;
    loop {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        let (base, token, buf) = {
            let p = rt.persist.lock().await;
            let base = if p.baseurl.trim().is_empty() { ILINK_BASE.to_string() } else { p.baseurl.clone() };
            (base, p.bot_token.clone(), p.get_updates_buf.clone())
        };
        let body = json!({
            "get_updates_buf": buf,
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        let result = ilink_post(&client, &base, "/ilink/bot/getupdates", &token, &body).await;
        let (status, v) = match result {
            Ok(r) => r,
            Err(e) => {
                // 长轮询到期（50s）属正常，不算错误；立即重新发起
                if e.to_string().contains("timed out") || e.to_string().contains("timeout") {
                    continue;
                }
                eprintln!("[ilink] getupdates 网络错误: {}", e);
                flow_log(&rt.app, "poll_error", &format!("{}", e));
                set_last_error(&rt, &format!("网络错误: {}", e));
                sleep_cancellable(&rt, backoff).await;
                backoff = (backoff * 2).min(60);
                continue;
            }
        };
        if status == 401 || status == 403 {
            // 登录失效：停止收消息但保留 token（用户可选择重新扫码）
            let msg = "微信 Bot 登录已失效，请重新扫码绑定";
            set_last_error(&rt, msg);
            emit_status(&rt.app, json!({ "state": "error", "error": msg }));
            return;
        }
        if status != 200 {
            set_last_error(&rt, &format!("getupdates HTTP {}", status));
            sleep_cancellable(&rt, backoff).await;
            backoff = (backoff * 2).min(60);
            continue;
        }
        let ret = v.get("ret").and_then(|r| r.as_i64()).unwrap_or(0);
        if ret != 0 {
            let errmsg = v.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
            eprintln!("[ilink] getupdates ret={} errmsg={}", ret, errmsg);
            flow_log(&rt.app, "poll_ret_err", &format!("ret={} errmsg={}", ret, errmsg));
            set_last_error(&rt, &format!("getupdates ret={} {}", ret, errmsg));
            sleep_cancellable(&rt, backoff).await;
            backoff = (backoff * 2).min(60);
            continue;
        }
        // 每轮 getupdates 正常返回都记心跳（含 0 条），用于判断 poll 循环是否存活
        let msg_cnt = v.get("msgs").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);
        flow_log(&rt.app, "poll_cycle", &format!("msgs={}", msg_cnt));
        backoff = 1;
        set_last_error(&rt, "");
        // 游标必须每轮更新并落盘，否则会重复收消息
        if let Some(new_buf) = v.get("get_updates_buf").and_then(|b| b.as_str()) {
            if !new_buf.is_empty() {
                let mut p = rt.persist.lock().await;
                p.get_updates_buf = new_buf.to_string();
                let _ = save_persist_to(&rt.state_path, &p);
            }
        }
        if let Some(msgs) = v.get("msgs").and_then(|m| m.as_array()) {
            if !msgs.is_empty() {
                flow_log(&rt.app, "poll_recv", &format!("getupdates 返回 {} 条消息", msgs.len()));
            }
            for m in msgs {
                if rt.stop.load(Ordering::Relaxed) {
                    return;
                }
                // dump 完整 inbound 原始 JSON（仅 debug），看清 iLink 提供的全部字段与 token
                flow_log(&rt.app, "inbound_raw", &m.to_string());
                handle_inbound(&rt, m).await;
            }
        }
    }
}

/// 处理一条 inbound 微信消息
async fn handle_inbound(rt: &Arc<IlinkRuntime>, msg: &Value) {
    // 只处理用户发来的完整消息（message_type 1 = 用户发出，message_state 2 = FINISH）
    if msg.get("message_type").and_then(|v| v.as_i64()).unwrap_or(0) != 1 {
        return;
    }
    if msg.get("message_state").and_then(|v| v.as_i64()).unwrap_or(2) != 2 {
        return;
    }
    // P0 不支持群聊：带 group_id 的消息忽略（权限模型未验证）
    if msg.get("group_id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
        return;
    }
    let from = match msg.get("from_user_id").and_then(|v| v.as_str()) {
        Some(f) if !f.is_empty() => f.to_string(),
        _ => return,
    };
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
    // 刷新 context_token（回复必须原样带回，仅保留最新；同步落盘防 Bridge 重启后丢失）
    if let Some(ctx) = msg.get("context_token").and_then(|v| v.as_str()) {
        if !ctx.is_empty() {
            rt.shared.lock().await.ctx_tokens.insert(from.clone(), ctx.to_string());
            let mut p = rt.persist.lock().await;
            p.last_context_token = ctx.to_string();
            let _ = save_persist_to(&rt.state_path, &p);
        }
    }
    // 微信开关关闭：不接收任何微信消息（回一条提示后忽略，避免用户困惑为何无响应）
    if !rt.persist.lock().await.follow_mode {
        send_wx_text(rt, &from, "微信消息接收已关闭。请在电脑端 Agent 页模型选择旁开启「💬 微信」开关。").await;
        return;
    }
    // 提取文本：type 1 文本直接取；type 3 语音尝试取转写文字
    let mut text = String::new();
    let mut unsupported = false;
    if let Some(items) = msg.get("item_list").and_then(|v| v.as_array()) {
        for item in items {
            match item.get("type").and_then(|v| v.as_i64()).unwrap_or(0) {
                1 => {
                    if let Some(t) = item.get("text_item").and_then(|t| t.get("text")).and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                3 => {
                    let vt = item
                        .get("voice_item")
                        .and_then(|vi| {
                            vi.get("translate_result")
                                .or_else(|| vi.get("translate_text"))
                                .or_else(|| vi.get("text"))
                        })
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if !vt.is_empty() {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(vt);
                    } else {
                        unsupported = true;
                    }
                }
                _ => unsupported = true,
            }
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        if unsupported {
            send_wx_text(rt, &from, "暂不支持该消息类型，请发送文字。").await;
        }
        return;
    }
    rt.msg_in.fetch_add(1, Ordering::Relaxed);
    emit_activity(&rt.app, "in", &from, &text);
    flow_log(&rt.app, "inbound", &format!("from={} text={}", short_wx_id(&from), text));

    // 有待审批权限时优先匹配 y/a/n
    let has_pending = { rt.shared.lock().await.pending_perm.contains_key(&from) };
    if has_pending {
        let ans = text.to_lowercase();
        match ans.as_str() {
            "y" | "yes" | "1" | "允许" | "同意" => {
                resolve_permission(rt, &from, "allow").await;
                return;
            }
            "a" | "all" | "3" | "本会话允许" => {
                resolve_permission(rt, &from, "allow_session").await;
                return;
            }
            "n" | "no" | "2" | "拒绝" => {
                resolve_permission(rt, &from, "deny").await;
                return;
            }
            _ => {
                send_wx_text(rt, &from, "⚠️ 有待处理的权限请求，请先回复：y 允许 / a 本会话全部允许 / n 拒绝").await;
                return;
            }
        }
    }

    // 控制指令（本地处理，不进 Agent）
    if text.starts_with('/') {
        handle_command(rt, &from, &text).await;
        return;
    }

    forward_to_agent(rt, &from, &text).await;
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
            let perm = if s.agent_yolo { "YOLO（直通）" } else { "微信内审批 y/a/n" };
            let mut lines = vec![
                "📊 状态".to_string(),
                format!("工作目录：{}", workdir),
                format!("权限：跟随 Agent 页（{}）", perm),
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
        "/help" | "/h" => {
            send_wx_text(
                rt,
                from,
                "🤖 ADM Agent 指令：\n/stop  取消当前任务\n/status  查看运行状态\n/help  显示本帮助\n\n消息会进入电脑端当前打开的会话。",
            )
            .await;
        }
        _ => {
            send_wx_text(rt, from, "未知指令，发送 /help 查看可用指令。").await;
        }
    }
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
/// 微信消息直接注入桌面当前打开的会话（开关已在 handle_inbound 入口校验）。
async fn forward_to_agent(rt: &Arc<IlinkRuntime>, from: &str, text: &str) {
    let (port, ws) = backend_of(rt).await;
    let (port, ws) = match (port, ws) {
        (Some(p), Some(w)) => (p, w),
        _ => {
            send_wx_text(rt, from, "⏳ Agent 服务尚未就绪，请先在电脑端打开 Agent 页。").await;
            return;
        }
    };
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
    flow_log(&rt.app, "forward", &format!("run_id={} session={} port={} prompt={}", run_id, sid, port, text));
    // 前置来源标注，让 Agent 上下文可区分远程消息
    let prompt = format!("[来自微信远程消息]\n{}", text);
    let body = json!({ "session_id": sid, "run_id": run_id, "prompt": prompt });
    match agent_post(rt, port, &format!("/v1/workspaces/{}/agent", ws), &body).await {
        Ok((202, _)) | Ok((200, _)) => {
            // 不发"已收到"ack：iLink 按 context_token 一问一答，同一 token 发两条会被撤回。仅 run_complete 时回一条。
            flow_log(&rt.app, "forward_ok", &format!("run_id={} 已提交 admAgent（等待 run_complete 回复）", run_id));
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
        // 断流后立即重连（工作区可能仍存活，保留 workspace_id 由 404 分支兑底）
        if !rt.stop.load(Ordering::Relaxed) {
            eprintln!("[ilink] SSE 流断开，重连");
        }
    }
}

/// 采用 Agent 页所在工作区（不再自建独立工作区），使微信会话在桌面端 Agent 页可见。
/// 最小侵入原则：仅在 Agent 未就绪时才 init，仅在 skip 与期望不一致时才设置。
/// 避免对 Agent 页正在查看的工作区发多余 init/config_changed，否则前端会重载、消息闪失。
async fn adopt_workspace(rt: &Arc<IlinkRuntime>, port: u16, ws: &str) -> Result<(), AppError> {
    // 仅在 Agent 未就绪时才 init：对已就绪工作区重复 init 会扰动 coordinator，
    // 表现为 Agent 页正在查看的会话消息突然消失
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
    // 权限跟随 Agent 页的 YOLO 开关；仅在当前值不一致时才写入，
    // 避免每次 adopt 都触发 config_changed 广播干扰前端
    let want_skip = load_settings(&rt.app).agent_yolo;
    let cur_skip = match agent_get(rt, port, &format!("/v1/workspaces/{}/permissions/skip", ws)).await {
        Ok((200, v)) => v.get("skip").and_then(|b| b.as_bool()),
        _ => None,
    };
    if cur_skip != Some(want_skip) {
        let _ = agent_post(rt, port, &format!("/v1/workspaces/{}/permissions/skip", ws), &json!({ "skip": want_skip })).await;
        flow_log(&rt.app, "adopt_skip", &format!("ws={} skip {:?} -> {}", ws, cur_skip, want_skip));
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
    // 调试：非高频 message/session 事件记流程日志，便于排查事件结构差异
    if etype != "message" && etype != "session" && !etype.is_empty() {
        let brief: String = inner.to_string().chars().take(300).collect();
        flow_log(&rt.app, "sse_event", &format!("type={} {}", etype, brief));
    }
    match etype {
        "run_complete" => {
            let run_id = inner.get("run_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let session_id = inner.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            // 匹配规则：run_id 精确 →（仅无 run_id 时）session_id 反查在途 run。
            // 带 run_id 但不是我们登记的 run（如桌面自己发起的运行）必须忽略，否则会错投到微信。
            let wx = {
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
                key.and_then(|k| s.runs.remove(&k)).map(|r| r.wx_user)
            };
            let Some(wx) = wx else {
                flow_log(&rt.app, "run_complete_unmatched", &format!("run_id={} session={} 非微信触发的运行，不回投", run_id, session_id));
                return;
            };
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
            // 权限跟随 Agent 页：非 YOLO 时才会收到 permission_request（YOLO 开启时服务端已跳过），
            // 因微信端无弹窗一律转为微信文本审批（y/a/n）。
            let session_id = inner.get("session_id").and_then(|s| s.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return;
            }
            // 反查微信用户：按在途 run 的 session_id 匹配（微信触发的运行在 runs 中有登记）。
            // 查不到则是桌面自己的运行，不处理（桌面自有弹窗审批）。
            let wx = {
                let s = rt.shared.lock().await;
                s.runs
                    .values()
                    .find(|r| r.session_id == session_id)
                    .map(|r| r.wx_user.clone())
            };
            let Some(wx) = wx else { return };
            let perm_id = inner.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
            let tool = inner.get("tool_name").and_then(|t| t.as_str()).unwrap_or("未知工具");
            let desc = inner.get("description").and_then(|d| d.as_str()).unwrap_or("");
            rt.shared.lock().await.pending_perm.insert(wx.clone(), inner.clone());
            send_wx_text(
                rt,
                &wx,
                &format!(
                    "⚠️ Agent 请求权限\n工具：{}\n操作：{}\n\n回复 y 允许 / a 本会话全部允许 / n 拒绝（{} 秒内未回复自动拒绝）",
                    tool, desc, PERM_TIMEOUT_SECS
                ),
            )
            .await;
            // 超时自动拒绝
            let rt2 = rt.clone();
            let wx2 = wx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(PERM_TIMEOUT_SECS)).await;
                let still_pending = {
                    let s = rt2.shared.lock().await;
                    s.pending_perm
                        .get(&wx2)
                        .and_then(|p| p.get("id"))
                        .and_then(|i| i.as_str())
                        .map(|i| i == perm_id)
                        .unwrap_or(false)
                };
                if still_pending {
                    resolve_permission(&rt2, &wx2, "deny").await;
                    send_wx_text(&rt2, &wx2, "⏱️ 权限请求超时，已自动拒绝。").await;
                }
            });
        }
        "permission_notification" => {
            // 桌面端先处理了权限：清除微信侧 pending 并提示
            let pid = inner
                .get("id")
                .or_else(|| inner.get("request_id"))
                .and_then(|i| i.as_str())
                .unwrap_or("");
            if pid.is_empty() {
                return;
            }
            let wx = {
                let mut s = rt.shared.lock().await;
                let hit = s
                    .pending_perm
                    .iter()
                    .find(|(_, p)| p.get("id").and_then(|i| i.as_str()) == Some(pid))
                    .map(|(k, _)| k.clone());
                if let Some(ref k) = hit {
                    s.pending_perm.remove(k);
                }
                hit
            };
            if let Some(wx) = wx {
                send_wx_text(rt, &wx, "ℹ️ 该权限请求已在电脑端处理。").await;
            }
        }
        _ => {}
    }
}

/// 提交权限审批结果到 admAgent
async fn resolve_permission(rt: &Arc<IlinkRuntime>, from: &str, action: &str) {
    let perm = { rt.shared.lock().await.pending_perm.remove(from) };
    let Some(perm) = perm else { return };
    let (port, ws) = backend_of(rt).await;
    let (port, ws) = match (port, ws) {
        (Some(p), Some(w)) => (p, w),
        _ => {
            send_wx_text(rt, from, "❌ Agent 服务未就绪，权限处理失败。").await;
            return;
        }
    };
    let body = json!({ "permission": perm, "action": action });
    match agent_post(rt, port, &format!("/v1/workspaces/{}/permissions/grant", ws), &body).await {
        Ok((200, v)) => {
            let resolved = v.get("resolved").and_then(|r| r.as_bool()).unwrap_or(true);
            let reply = if !resolved {
                "ℹ️ 该权限请求已在电脑端处理。".to_string()
            } else {
                match action {
                    "allow" => "✅ 已允许本次操作。".to_string(),
                    "allow_session" => "✅ 已允许本会话内所有同类操作。".to_string(),
                    _ => "🚫 已拒绝该操作。".to_string(),
                }
            };
            send_wx_text(rt, from, &reply).await;
        }
        Ok((st, _)) => send_wx_text(rt, from, &format!("❌ 权限处理失败：HTTP {}", st)).await,
        Err(e) => send_wx_text(rt, from, &format!("❌ 权限处理失败：{}", e)).await,
    }
}

/// 发送文本到微信（自动分段，段间 300ms 限速，失败重试 3 次）。
/// 报文字段对齐官方 demo：必带每消息唯一 client_id 与空 from_user_id。
async fn send_wx_text(rt: &Arc<IlinkRuntime>, wx_user: &str, text: &str) {
    let (base, token) = {
        let p = rt.persist.lock().await;
        let base = if p.baseurl.trim().is_empty() { ILINK_BASE.to_string() } else { p.baseurl.clone() };
        (base, p.bot_token.clone())
    };
    // context_token：内存优先，Bridge 重启后回退持久化的最近值
    let ctx = {
        let mem = rt.shared.lock().await.ctx_tokens.get(wx_user).cloned().unwrap_or_default();
        if !mem.is_empty() {
            mem
        } else {
            rt.persist.lock().await.last_context_token.clone()
        }
    };
    let chunks = split_chunks(text, WX_CHUNK_CHARS);
    let total = chunks.len();
    for (i, chunk) in chunks.into_iter().enumerate() {
        if rt.stop.load(Ordering::Relaxed) {
            return;
        }
        let body_text = if total > 1 { format!("{}\n({}/{})", chunk, i + 1, total) } else { chunk };
        let body = json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": wx_user,
                "client_id": format!("adm-{}", new_uuid_like()),
                "message_type": 2,
                "message_state": 2,
                "context_token": ctx,
                "item_list": [ { "type": 1, "text_item": { "text": body_text } } ]
            }
        });
        // 失败重试 3 次（消息已在桌面端会话中留存，最终失败仅记日志）
        let mut sent = false;
        for attempt in 0..3 {
            match ilink_post(&rt.http, &base, "/ilink/bot/sendmessage", &token, &body).await {
                Ok((200, v)) if v.get("ret").and_then(|r| r.as_i64()).unwrap_or(0) == 0 => {
                    log_send_debug(&rt.app, wx_user, 200, &v, ctx.len());
                    sent = true;
                    break;
                }
                Ok((st, v)) => {
                    eprintln!("[ilink] sendmessage 失败 HTTP {} resp={} (第{}次)", st, v, attempt + 1);
                    log_send_debug(&rt.app, wx_user, st, &v, ctx.len());
                }
                Err(e) => {
                    eprintln!("[ilink] sendmessage 网络错误: {} (第{}次)", e, attempt + 1);
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if sent {
            rt.msg_out.fetch_add(1, Ordering::Relaxed);
            emit_activity(&rt.app, "out", wx_user, &body_text);
            flow_log(&rt.app, "reply_ok", &format!("to={} seg={}/{} ctx_len={} text={}", short_wx_id(wx_user), i + 1, total, ctx.len(), body_text));
        } else {
            emit_activity(&rt.app, "err", wx_user, "消息发送失败（已重试 3 次）");
            flow_log(&rt.app, "reply_fail", &format!("to={} seg={}/{} ctx_len={} 重试 3 次仍失败", short_wx_id(wx_user), i + 1, total, ctx.len()));
        }
        // 全局发送限速，防触发腾讯限频
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// ===== section 7: 消息转换工具 =====

/// 发送调试日志：记录 sendmessage 响应到数据目录 ilink_send_debug.log（便于离线排查投递问题）。
/// 仅 debug 构建写盘，release 不产生任何文件。
#[cfg(debug_assertions)]
fn log_send_debug(app: &tauri::AppHandle, wx_user: &str, http_status: u16, resp: &Value, ctx_len: usize) {
    if let Ok(dir) = config::get_data_dir(Some(app)) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let brief: String = resp.to_string().chars().take(300).collect();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("ilink_send_debug.log"))
        {
            let _ = writeln!(f, "{} to={} ctx_len={} HTTP {} {}", ts, short_wx_id(wx_user), ctx_len, http_status, brief);
        }
    }
}

/// release 构建：发送调试日志为空操作（不写盘）。
#[cfg(not(debug_assertions))]
fn log_send_debug(_app: &tauri::AppHandle, _wx_user: &str, _http_status: u16, _resp: &Value, _ctx_len: usize) {}

/// 流程调试日志：把一次微信对话从收消息→转发 admAgent→SSE 事件→回投的各阶段
/// 按时间顺序记入数据目录 ilink_flow_debug.log，便于后续完整回放链路定位问题。
/// 仅 debug 构建写盘，release 不产生任何文件。
#[cfg(debug_assertions)]
fn flow_log(app: &tauri::AppHandle, stage: &str, detail: &str) {
    eprintln!("[ilink][flow] {} | {}", stage, detail);
    if let Ok(dir) = config::get_data_dir(Some(app)) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // 单行化 detail，防止多行输出打乱日志结构；截断过长内容
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

/// release 构建：流程调试日志为空操作（不写盘、不打印）。
#[cfg(not(debug_assertions))]
fn flow_log(_app: &tauri::AppHandle, _stage: &str, _detail: &str) {}



/// Markdown 降级为微信可读纯文本：去代码围栏、标题转【】、去加粗星号
fn downgrade_markdown(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        // 代码围栏行整行去掉（保留围栏内容）
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
