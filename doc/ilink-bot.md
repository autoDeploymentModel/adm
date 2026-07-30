# iLink Bot（微信个人号机器人）接入方案

> 状态：**P0 已实现**（含微信内权限审批），待真机联调验证扫码流程
> 实现位置：`src-tauri/src/pages/ilink.rs`（桥接）+ `src/views/settings.js`（绑定 UI）
>
> **实现与本文档的差异**：
> 1. §7.1 修正：`ilink_enabled` / `ilink_workspace_path` / `ilink_permission_mode` 不存 config.json（设置页 save_settings 会整体覆盖 Settings 导致字段丢失），改为全部存 `ilink_state.json`（enabled / workspace_path / permission_mode 字段）。
> 2. 微信内权限审批（原 P1）已随 P0 一并实现；typing 状态与收图片仍留在 P1。
> 3. 新增：Bridge 在 admAgent server 未运行时会自动尝试拉起（60s 冷却），无需用户先打开 Agent 页。
> 4. 实测纠正：`get_bot_qrcode` 的 `qrcode_img_content` 返回的不是图片，而是待扫链接（`https://liteapp.weixin.qq.com/q/...`），Rust 端用 `qrcode` crate 本地渲染为 SVG 二维码后以 data URL 下发前端。
> 5. 实测纠正：`get_qrcode_status` 是**长轮询**接口（未扫码时服务端 hold 住连接 >15s，确认信号只在被 hold 的连接上下发），客户端必须用长超时（70s）+ 断开立即重连，而非短超时秒级轮询；确认判定从宽（响应出现 `bot_token` 即确认，不依赖 `status` 取值），原始响应脱敏后记入数据目录 `ilink_login_debug.log` 便于排查。
> 6. 实测纠正：`sendmessage` 成功时返回 `{"message_id": ...}`（无 `ret` 字段），且 `context_token` 为空也能发送成功；admAgent 的 `run_complete` 事件可能不回传 `run_id`（与前端 sse.js 的处理一致），Bridge 回投匹配采用三级回退：run_id 精确 → session_id 反查在途 run → session_id 反查微信会话映射。
>
> 目标：让用户扫码绑定自己的微信 Bot，之后在微信里直接对话 ADM 内置的 admAgent（收发消息、执行任务、审批权限），ADM 桌面端作为宿主与控制台。

---

## 目录

- [1. 背景：iLink 协议是什么](#1-背景ilink-协议是什么)
- [2. 目标与范围](#2-目标与范围)
- [3. 总体架构](#3-总体架构)
- [4. Rust 端设计（核心）](#4-rust-端设计核心)
- [5. 前端设计](#5-前端设计)
- [6. 关键流程详解](#6-关键流程详解)
- [7. 配置与持久化](#7-配置与持久化)
- [8. 新增 Tauri 命令与事件清单](#8-新增-tauri-命令与事件清单)
- [9. 错误处理与可靠性](#9-错误处理与可靠性)
- [10. 安全与合规](#10-安全与合规)
- [11. 分阶段实施计划](#11-分阶段实施计划)
- [12. 测试计划](#12-测试计划)
- [13. 风险与开放问题](#13-风险与开放问题)

---

## 1. 背景：iLink 协议是什么

iLink（智联）是腾讯 2026 年通过 OpenClaw ClawBot 插件**官方开放**的微信个人号 Bot 协议：

- 接入域名：`https://ilinkai.weixin.qq.com`（腾讯官方服务器），媒体 CDN：`https://novac2c.cdn.weixin.qq.com/c2c`
- 纯 HTTP/JSON，无需 SDK，扫码登录后用 `bot_token` Bearer 鉴权
- 收消息采用**长轮询**（类似 Telegram getUpdates，服务器 hold 最长 35s）
- 有官方《微信ClawBot功能使用条款》背书，非灰产 Hook 方案

### 1.1 官方 API 一览（全部 7 个）

| Endpoint | Method | 功能 |
|----------|--------|------|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | GET | 获取登录二维码 |
| `/ilink/bot/get_qrcode_status?qrcode=xxx` | GET | 轮询扫码状态，confirmed 后返回 `bot_token` + `baseurl` |
| `/ilink/bot/getupdates` | POST | 长轮询收消息（核心），游标 `get_updates_buf` |
| `/ilink/bot/sendmessage` | POST | 发送消息（文字/图片/文件/视频/语音） |
| `/ilink/bot/getuploadurl` | POST | 获取 CDN 预签名上传地址（发媒体用） |
| `/ilink/bot/getconfig` | POST | 获取 `typing_ticket` |
| `/ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

### 1.2 请求头固定套路

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: base64(String(randomUint32()))   // 每次随机，防重放
Authorization: Bearer <bot_token>              // 登录后所有请求携带
```

### 1.3 消息结构关键点

```jsonc
// 收到的消息（WeixinMessage）
{
  "from_user_id": "o9cq800kum_xxx@im.wechat",  // 用户 ID
  "to_user_id":   "e06c1ceea05e@im.bot",       // Bot ID
  "message_type": 1,                            // 1=用户发来, 2=Bot 发出
  "message_state": 2,                           // 2=FINISH 完整消息
  "context_token": "AARzJWAF...",               // ★ 回复时必须原样带回
  "item_list": [
    { "type": 1, "text_item": { "text": "你好" } }
  ]
}
```

- `item_list[].type`：1=文本，2=图片，3=语音（silk，附转文字），4=文件，5=视频
- **`context_token` 是对话关联核心**：回复必须带上收到消息里的 token，否则不会出现在正确的聊天窗口
- `get_updates_buf` 是游标：每次响应返回新值，下次请求必须带上，否则重复收消息
- 媒体文件在 CDN 上以 **AES-128-ECB** 加密存储，收发都需要加解密

---

## 2. 目标与范围

### 2.1 用户故事

1. 用户在 ADM 设置页点「绑定微信 Bot」→ 弹出二维码 → 微信扫码确认 → 绑定成功
2. 用户在微信里给 Bot 发消息 → admAgent 在指定工作区执行 → 结果回复到微信
3. Agent 需要权限确认时（非 YOLO），微信里收到确认卡片文本，回复「1/y」允许、「2/n」拒绝
4. ADM 桌面端 Agent 页可以看到微信触发的会话（复用现有会话列表/SSE，天然支持）
5. 用户可随时在设置页解绑 / 暂停 Bot

### 2.2 本期做（P0 + P1）

- ✅ 扫码登录、token 持久化、自动恢复登录态
- ✅ 长轮询收文本消息 → 转发 admAgent → 文本回复
- ✅ 微信端权限审批（文本交互）+ YOLO 直通模式
- ✅ "正在输入"状态、长消息分段、Markdown 降级为纯文本
- ✅ 会话映射：每个微信用户 → 一个 admAgent session（可发指令重开）
- ✅ 收图片（下载解密后作为 attachment 传给 Agent，模型支持图片时生效）

### 2.3 本期不做（P2 及以后）

- ❌ 向微信发送图片/文件（需要 CDN 加密上传链路，P2）
- ❌ 群聊支持（协议侧 group_id 权限尚不明确）
- ❌ 语音消息主动回复（收到的语音自带转文字，按文本处理即可）
- ❌ 多 Bot 账号同时绑定（单账号即可覆盖主场景）

### 2.4 明确约束

- **admAgent（Go 源码）零改动**——全部桥接逻辑放在 ADM 的 Rust 后端，只调用 admAgent 现有 HTTP API（`doc/server-api.md`）
- 前端遵守现有「不编译原生 ESM SPA」架构，不引入任何构建依赖

---

## 3. 总体架构

```
 微信用户                腾讯 iLink 服务器            ADM (Tauri)                    admAgent server
   │                        │                        │                              │
   │  发消息                 │   长轮询 getupdates      │                              │
   │ ─────────────────────▶ │ ◀──────────────────── │  ilink.rs (桥接模块)           │
   │                        │ ──── msgs ──────────▶ │                              │
   │                        │                        │ ── POST /agent (prompt) ───▶ │
   │                        │                        │ ◀── SSE run_complete ─────── │
   │                        │ ◀─── sendmessage ───── │                              │
   │ ◀───────────────────── │                        │                              │
   │  收到 AI 回复            │                        │      │ tauri event           │
   │                        │                        │      ▼                       │
   │                        │                        │  前端设置页/Agent 页            │
   │                        │                        │  (绑定二维码/状态/日志)          │
```

三个要点：

1. **桥接器（Bridge）全部在 Rust 端**：`src-tauri/src/pages/ilink.rs`，以 tokio 后台任务形式运行，不依赖前端页面存活（用户切走页面、最小化窗口都不影响微信消息处理）。
2. **复用 admAgent server 现有能力**：Bridge 作为一个独立的 admAgent HTTP 客户端（独立 `client_id`、独立 SSE 订阅），与前端 Agent 页互不干扰；微信触发的会话在桌面端 Agent 页里自然可见（同一 workspace 的 SSE 广播）。
3. **前端只做控制台**：绑定二维码、开关、状态、简单日志，通过 Tauri 命令 + 事件与 Rust 交互。

### 3.1 为什么不放在前端 JS 做长轮询

- WebView 生命周期不可控（切换视图 unmount、窗口挂起），消息会丢
- CORS 限制直连 `ilinkai.weixin.qq.com` 不可行，反而需要 Rust 代理
- Rust 端 tokio 任务 + reqwest 天然适合长轮询与并发控制

### 3.2 为什么不改 admAgent 加 channel

admAgent 源码只读（项目约束）。且 server API 已完备：`POST /agent` fire-and-forget + SSE `run_complete` 事件闭环，Bridge 无需 admAgent 感知微信的存在。

---

## 4. Rust 端设计（核心）

### 4.1 新增文件

```
src-tauri/src/pages/ilink.rs        # 全部桥接逻辑（对齐现有 pages/ 模块划分）
```

`pages/mod.rs` 增加 `pub mod ilink;`，`lib.rs` 注册命令 + 管理生命周期。

### 4.2 模块内部结构（单文件内按 section 组织，对齐 agent.rs 风格）

```rust
// ── section 1: iLink HTTP 客户端 ──
struct IlinkClient {
    http: reqwest::Client,
    base_url: String,       // 默认官方域名，登录后可被 status 返回的 baseurl 覆盖
    bot_token: String,
}
impl IlinkClient {
    async fn get_bot_qrcode() -> QrcodeResp;                  // GET get_bot_qrcode?bot_type=3
    async fn get_qrcode_status(qrcode: &str) -> QrStatusResp; // GET get_qrcode_status
    async fn get_updates(buf: &str) -> UpdatesResp;           // POST getupdates（35s 长轮询）
    async fn send_message(msg: &OutboundMsg) -> SendResp;     // POST sendmessage
    async fn get_config() -> ConfigResp;                      // POST getconfig（typing_ticket）
    async fn send_typing(ticket: &str, to: &str);             // POST sendtyping
    fn headers(&self) -> HeaderMap;  // 含随机 X-WECHAT-UIN
}

// ── section 2: Bridge 状态机与主循环 ──
enum BridgeState { Stopped, WaitingScan, Running, Error(String) }

struct IlinkBridge {
    state: BridgeState,
    poll_task: Option<JoinHandle<()>>,   // 长轮询任务
    sse_task: Option<JoinHandle<()>>,    // admAgent SSE 订阅任务
    sessions: HashMap<String, WxSessionBinding>, // from_user_id -> session 映射
    pending_permissions: HashMap<String, PendingPermission>, // 等待微信回复的权限请求
    cancel: CancellationToken,
}

// ── section 3: 微信用户 ↔ admAgent 会话映射 ──
struct WxSessionBinding {
    wx_user_id: String,       // xxx@im.wechat
    session_id: String,       // admAgent session
    last_context_token: String, // 每收到一条消息就刷新
    busy_run_id: Option<String>,
}

// ── section 4: 消息转换 ──
fn wx_inbound_to_prompt(msg: &WeixinMessage) -> (String, Vec<Attachment>);
fn agent_text_to_wx_chunks(text: &str) -> Vec<String>;  // markdown 降级 + 分段

// ── section 5: tauri::command 导出 ──
```

### 4.3 与 admAgent 的交互（复用现有基础设施）

`agent.rs` 中已有：admAgent 子进程管理（`start_agent_server` 解析端口）、HTTP 代理逻辑。Bridge 直接复用同一个 base url（`AppState` 中已保存 agent server 端口），**不新起 admAgent 进程**。

Bridge 使用的 admAgent API（均为现有接口，见 `doc/server-api.md`）：

| 用途 | API |
|------|-----|
| 确保工作区存在 | `POST /v1/workspaces`（幂等，path 相同复用） |
| 初始化 Agent | `POST /v1/workspaces/{id}/agent/init` |
| 创建会话 | `POST /v1/workspaces/{id}/sessions`（title 形如 `微信·<昵称/ID后6位>`） |
| 发送用户消息 | `POST /v1/workspaces/{id}/agent`（带 `run_id` 用于精确关联结果） |
| 订阅结果与权限 | `GET /v1/workspaces/{id}/events?client_id=<bridge专属UUID>`（SSE） |
| 权限审批 | `POST /v1/workspaces/{id}/permissions/grant` |
| 取消运行 | `POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel` |

Bridge 的 SSE 订阅关注三类事件：

- `run_complete` → 取 `text`（或 `error`）按 `run_id` 匹配到微信用户，回复微信
- `permission_request` → 非 YOLO 时转成微信文本卡片等待用户答复
- `permission_notification` → 若桌面端先处理了权限，撤销微信侧的 pending 状态并提示

### 4.4 生命周期

- **启动**：App 启动时若配置里 `ilink_enabled=true` 且已有 `bot_token`，等 admAgent server 就绪后自动拉起 Bridge（挂在现有 agent server 启动完成的时机之后）
- **停止**：`stop_ilink_bridge` 命令 / 窗口退出 `on_window_event` 时 cancel token，两个任务优雅退出；长轮询请求设置 40s 超时保证及时退出
- **admAgent 重启**：Bridge 监听 agent server 状态，server 断开时进入 Error 态并重试（指数退避），恢复后重建 SSE + 工作区

---

## 5. 前端设计

遵守现有架构：原生 ESM、视图前缀选择器、无新依赖。

### 5.1 入口位置

**设置页（`src/views/settings.js`）新增「微信 Bot」区块**（与现有云端模型配置并列）：

- 绑定状态卡片：`未绑定 / 等待扫码 / 已绑定（运行中）/ 已暂停 / 错误`
- 「绑定微信」按钮 → 弹出二维码浮层（`qrcode_img_content` 为图片内容，直接 `data:` URL 展示），轮询状态由 Rust 完成，前端只监听事件
- 已绑定后显示：绑定微信 ID（脱敏）、开关（启用/暂停）、「解绑」按钮（自建确认弹窗，不用原生 confirm——项目已知约束）
- Bot 行为配置：
  - **工作目录**：微信会话使用的 workspace 路径（默认复用 Agent 页当前工作区）
  - **权限模式**：`跟随全局 YOLO / 强制 YOLO / 微信内审批`
  - **模型**：默认跟随 Agent 页当前模型（P0 不单独配）

### 5.2 状态展示（Agent 页，轻量）

Agent 页侧边栏会话列表天然显示微信触发的会话（同一 workspace SSE 广播，无需额外开发）；仅在会话标题带 `微信·` 前缀即可辨识。

### 5.3 前端 ↔ Rust 通信

- 命令走 `window.__adm_invoke`，事件走 `window.__adm_listen`（现有全局桥）
- Bridge 状态变化推 `ilink-status` 事件，前端 mount 时 `get_ilink_status` 拉一次全量 + listen 增量，unmount 时释放 unlisten 句柄（防泄漏，现有约定）

---

## 6. 关键流程详解

### 6.1 扫码绑定

```
前端点击「绑定微信」
  → invoke start_ilink_login
  → Rust: GET get_bot_qrcode?bot_type=3
  → emit ilink-status { state:"waiting_scan", qrcode_img: "<base64>" }   → 前端展示二维码
  → Rust 轮询 get_qrcode_status（1s 间隔，120s 超时）
      status=confirmed → 持久化 { bot_token, baseurl, bot_id }
                       → emit ilink-status { state:"running" } → 自动启动 Bridge
      超时/取消        → emit ilink-status { state:"stopped", error:"二维码过期" }
```

### 6.2 收消息 → Agent → 回复（核心链路）

```
poll_task 循环：
  POST getupdates { get_updates_buf: <上次游标> }        // hold ≤35s
  → 持久化新游标（每次都存，防止重启后重复收消息）
  → 对每条 msg（message_type==1 && message_state==2）：
      1. 刷新该用户 binding.last_context_token
      2. 若是控制指令（见 6.5）→ 本地处理，直接回复
      3. 确保 workspace/session 存在（懒创建）
      4. 若该用户上一轮还在运行 → admAgent 会自动排队（409 时提示"上一个任务还在跑"）
      5. 生成 run_id，POST /v1/workspaces/{id}/agent { session_id, run_id, prompt, attachments }
      6. 发 typing：getconfig 拿 ticket → sendtyping（运行中每 ~8s 续一次）

sse_task 收到 run_complete 且 run_id 匹配：
  → text 做 markdown 降级（去 ``` 围栏保留内容、# 转【】、去表格线等）
  → 按 ~2000 字分段（段尾标 (1/3) 页码）
  → 逐段 POST sendmessage {
        to_user_id: binding.wx_user_id,
        message_type: 2, message_state: 2,
        context_token: binding.last_context_token,   // ★ 必带
        item_list: [{ type:1, text_item:{ text } }]
     }
  → error 非空则回复「❌ 执行出错：...」
```

### 6.3 微信内权限审批（非 YOLO 模式）

```
SSE permission_request 到达（session 属于某微信 binding）：
  → 回复微信：
      「⚠️ Agent 请求权限
       工具：bash
       操作：执行命令: rm -rf /tmp/cache
       回复 y 允许 / a 本会话全部允许 / n 拒绝（120 秒超时自动拒绝）」
  → 记入 pending_permissions[wx_user_id]
该用户下一条消息若匹配 y/a/n（不区分大小写）：
  → POST permissions/grant { action: allow / allow_session / deny }
  → resolved=false 说明桌面端已处理，回复「已在电脑端处理」
超时 → 自动 deny 并告知
非 y/a/n 的消息 → 提示"有待处理的权限请求"，不进 Agent
```

### 6.4 收图片

```
item.type==2（图片）：
  → 从 item 中取 CDN url + aes_key
  → 下载 → AES-128-ECB 解密 → base64
  → 作为 attachment { file_name, mime_type:"image/jpeg", content } 附在 prompt 上
  → 模型不支持图片时（AgentInfo.supports_images=false）回复提示
语音（type==3）：直接取自带的转文字结果当作文本 prompt
文件/视频（type==4/5）：P0 回复「暂不支持」
```

### 6.5 微信端控制指令（以 `/` 开头，Bridge 本地处理，不进 Agent）

| 指令 | 行为 |
|------|------|
| `/new` | 关闭当前映射，新建 session（重开对话） |
| `/stop` | 取消当前正在运行的 Agent（cancel API） |
| `/status` | 回复当前模型、工作区、是否运行中 |
| `/help` | 指令说明 |

---

## 7. 配置与持久化

### 7.1 config.json（复用现有 Settings 原子写机制）

```jsonc
{
  // ... 现有字段 ...
  "ilink_enabled": false,          // Bot 总开关
  "ilink_workspace_path": "",      // 微信会话工作目录，空=跟随 Agent 页
  "ilink_permission_mode": "follow" // follow | yolo | wechat_approve
}
```

### 7.2 ilink_state.json（新文件，与 config.json 同目录，同样 .tmp+rename 原子写）

凭据与运行态单独存放（更新频繁 + 敏感，不与用户设置混写）：

```jsonc
{
  "bot_token": "xxx",            // 登录凭据（本地明文，见 §10 说明）
  "baseurl": "https://...",      // 登录返回的专属 baseurl（有则优先）
  "bot_id": "e06c1ceea05e@im.bot",
  "get_updates_buf": "AAY...",   // 长轮询游标，每轮更新后落盘
  "sessions": {                   // 微信用户 → 会话映射（重启后恢复）
    "o9cq800kum_xxx@im.wechat": { "session_id": "...", "title": "微信·kum_xxx" }
  }
}
```

`context_token` 不持久化（时效性 token，重启后等用户下一条消息刷新即可）。

---

## 8. 新增 Tauri 命令与事件清单

### 8.1 命令（`ilink.rs` 导出，`lib.rs` 注册）

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `start_ilink_login` | - | `()` | 获取二维码并开始轮询，进度走事件 |
| `cancel_ilink_login` | - | `()` | 取消扫码等待 |
| `get_ilink_status` | - | `IlinkStatus` | 全量状态（state/bot_id/error/统计） |
| `start_ilink_bridge` | - | `()` | 启动桥接（需已有 token） |
| `stop_ilink_bridge` | - | `()` | 暂停桥接（保留 token） |
| `unbind_ilink` | - | `()` | 停止并删除 token/游标/映射 |
| `set_ilink_settings` | `{ workspace_path, permission_mode }` | `()` | 写 config.json 并热生效 |

### 8.2 事件（Rust → 前端）

| 事件名 | payload | 说明 |
|--------|---------|------|
| `ilink-status` | `{ state, qrcode_img?, bot_id?, error? }` | 状态机变化（含扫码二维码推送） |
| `ilink-activity` | `{ ts, direction, wx_user, summary }` | 收/发消息摘要（设置页日志区，环形缓冲最近 50 条） |

### 8.3 `IlinkStatus` 结构

```typescript
interface IlinkStatus {
  state: "stopped" | "waiting_scan" | "running" | "error";
  bound: boolean;          // 是否有 token
  bot_id?: string;         // 脱敏展示
  error?: string;
  msg_in: number;          // 本次运行累计收
  msg_out: number;         // 累计发
}
```

`src/types.d.ts` 同步补充以上类型声明（checkJs 要求）。

---

## 9. 错误处理与可靠性

| 场景 | 策略 |
|------|------|
| 长轮询网络错误 | 指数退避重试（1s→2s→…→60s 封顶），恢复后继续用旧游标 |
| `bot_token` 失效（401/特定 ret 码） | 停止 Bridge，置 Error 态，事件通知前端"需要重新扫码"，不自动清 token |
| 游标损坏/服务端拒绝 | 用空游标重来一次（接受可能重复的少量消息，发送侧按 run_id 幂等防重复触发） |
| admAgent server 未就绪/重启 | Bridge 等待+重连，期间收到的微信消息回复「服务启动中，请稍后」 |
| Agent 运行超时 | 不设桥接层超时（长任务合法），`/stop` 指令兜底 |
| sendmessage 失败 | 重试 3 次，仍失败则记入 activity 日志（消息已在桌面端会话中，不丢结果） |
| 长轮询 hold 与退出冲突 | reqwest 请求 40s 超时 + CancellationToken select，保证 3s 内可停 |
| 频率控制 | 单用户并发 1（排队由 admAgent 完成）；sendmessage 全局 ≥300ms 间隔，防触发腾讯限频 |

---

## 10. 安全与合规

1. **bot_token 存储**：P0 以文件明文存本地（与现有 cloud provider key 处理方式一致性对齐；如现有实现是加密的则跟随）。文档向用户说明该文件等同微信 Bot 登录态，不要外传。
2. **默认最小权限**：`ilink_permission_mode` 默认 `follow`（跟随全局设置）；文档建议远程场景用 `wechat_approve`，高危操作在微信里确认。
3. **腾讯条款约束**（写入用户文档）：
   - 腾讯仅做消息管道，不存内容，但收集 IP/设备日志
   - 腾讯有权限频、拦截、随时终止服务 → Bot 不可作为核心依赖，桌面端始终可用
   - 禁止用于违法、绕过微信技术保护等行为
4. **输入来源标注**：微信来的 prompt 前置一行系统性提示（如 `[来自微信远程消息]`），让 Agent 上下文中可区分来源，降低远程注入风险感知成本。
5. **只处理私聊**：带 `group_id` 的消息 P0 直接忽略（未验证权限模型）。

---

## 11. 分阶段实施计划

### P0：文本闭环（预计改动 ~800 行 Rust + ~300 行 JS）

1. `ilink.rs`：IlinkClient（qrcode/status/getupdates/sendmessage 4 个接口）+ 状态机 + 持久化
2. Bridge 主循环：收文本 → admAgent → run_complete → 回文本（YOLO 模式）
3. `lib.rs` 注册命令、启动/退出挂钩
4. 设置页绑定 UI（二维码、状态、开关、解绑）
5. `/new` `/stop` `/status` `/help` 指令
6. `pnpm typecheck` + 手工联调

### P1：体验完善

1. 微信内权限审批（wechat_approve 模式）
2. typing 状态（getconfig/sendtyping）
3. 收图片（CDN 下载 + AES-128-ECB 解密 → attachment）、语音转文字直通
4. Markdown 降级与长消息分段打磨
5. activity 日志区

### P2：暂缓（另行评审）

- 发送图片/文件（getuploadurl + 加密上传）
- 群聊、多账号
- 微信端切换模型/工作区指令

### 依赖确认（编码前验证）

- `src-tauri/Cargo.toml` 现有依赖是否已含 AES-ECB 能力（P1 才需要；若无，加 `aes` + `ecb` 两个纯 Rust crate）
- reqwest 已存在（agent.rs 在用），长轮询无新增依赖

---

## 12. 测试计划

| 类别 | 内容 |
|------|------|
| 单元（Rust） | 游标持久化/恢复、markdown 降级、分段算法、指令解析、X-WECHAT-UIN 生成 |
| 联调（真机） | 扫码绑定→发文本→收回复全链路；权限审批 y/a/n/超时；`/stop` 中断长任务 |
| 可靠性 | 断网 30s 恢复；admAgent 手动 kill 后自动恢复；App 重启后游标续传不重复触发任务 |
| 生命周期 | 绑定状态下退出 App 无残留请求；解绑后文件清理干净 |
| 回归 | Agent 页原有功能不受影响（Bridge 独立 client_id，SSE 互不干扰）；`pnpm typecheck` 通过 |

---

## 13. 风险与开放问题

| # | 风险/未知 | 应对 |
|---|-----------|------|
| 1 | `bot_type=3` 含义未公开，登录可能需要 OpenClaw 平台侧资格 | P0 第一步先用 curl 裸验证扫码全流程，跑不通则整个方案挂起 |
| 2 | 官方未公布限频阈值 | 发送侧全局限速 + 失败退避，实测调参 |
| 3 | 协议处于 v1.0.2 早期，字段可能变化 | IlinkClient 隔离协议细节，响应解析全部宽容（unknown fields 忽略） |
| 4 | 腾讯可单方面终止服务 | 产品定位为"增值远程入口"，桌面端始终是完整功能 |
| 5 | `context_token` 有效期未知 | 仅用最新收到的 token；发送失败且疑似 token 过期时提示用户"发一条消息激活" |
| 6 | 远程指令安全（他人加 Bot 好友？） | P0 仅响应首个绑定的 `from_user_id`？——**待定：需实测 Bot 是否会收到非主人消息**；保守起见加白名单（首个对话者自动成为 owner，其余忽略） |

---

## 附：待你确认的决策点

1. **入口位置**：Bot 绑定 UI 放「设置页」还是 Agent 页内？（本方案：设置页）
2. **权限默认值**：默认 `follow`（跟随全局 YOLO 设置）还是默认 `wechat_approve`？（本方案：follow）
3. **工作区策略**：微信会话默认用 Agent 页当前工作区，还是必须单独指定一个固定目录？（本方案：默认跟随、可单独指定）
4. **owner 白名单**（风险 #6）：是否接受"首个对话者即 owner，其他人忽略"的策略？
5. **P0 是否包含收图片**？（本方案放在 P1，若你的模型场景以图片为主可提到 P0）
