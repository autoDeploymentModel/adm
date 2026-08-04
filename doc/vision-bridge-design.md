# Vision Bridge 开发文档

## 背景

用户希望在同一 session 中：主模型 A（纯文本，如 DeepSeek-V4-Flash）做主业务流，当对话中需要分析图片时，**自动**调用多模态模型 B（如用户预先配置好的本地多模态模型）识别图片，将识别结果融入主模型对话流，让 A 继续基于文字描述工作——整个过程对用户透明。

**配套改进**：附件（文件包括图片）**一律**落盘为文件、把磁盘路径报给大模型（取消现有 >60KB 才走路径的阈值）；前端不再以"模型不支持多模态"为由限制图片上传；**TUI 端同样统一走路径**。

## 总体方案（三段式）

```
┌─────────────┐     ┌────────────────────────────┐     ┌──────────────────────┐
│ 客户端       │     │  coordinator / sessionAgent │     │   vision 子命令        │
│ (ADM 前端 /  │     │  (主模型 A: 纯文本)           │     │  (admAgent vision)    │
│  TUI)       │     │                            │     │                      │
│             │     │  统一附件落盘（coordinator）   │     │  读图 → base64 →      │
│ 附件一律     │────▶│  → 附件路径注入 system_info   │     │  POST 多模态 B → 文本  │
│ 传路径       │ 路径 │  → 模型按引导选工具:          │     │                      │
│ (ADM 落盘)  │     │     文本 → view 读            │     │  输出 → tool result   │
│             │     │     图片 → admAgent vision    │     │  → 持久化进会话历史    │
└─────────────┘     └────────────────────────────┘     └──────────────────────┘
```

三段职责：

1. **客户端（ADM 前端 / TUI）**：附件一律不内联——ADM 前端经 `save_attachment_file` 落盘后传 `file_path`；TUI 直接传 base64 附件，由 coordinator 统一落盘。**附件路径的 system_info 注入统一由 coordinator 完成**（双端都不各自注入，避免重复）。
2. **coordinator（统一落盘 + 路径注入）**：对 Content 非空的附件（TUI 等场景）落盘到 `<data_dir>/attachments/<sessionID>/`；收集全部附件路径，注入 `<system_info>附件路径 + 读取引导</system_info>` 到 prompt；图片附件不再被丢弃。
3. **view 工具（分派点） + vision 子命令**：文本 → view 读；图片 + 多模态模型 → view 直读；图片 + 纯文本模型 → view 报错引导 → `admAgent vision <path>` → 文本回流。

## 现状调研（可复用的既有基础设施）

### ADM 前端（`F:/trae/adm/src`）

| 位置 | 现状 | 复用/改动 |
|---|---|---|
| `send.js:152-191` | **已存在"路径模式"**：仅 >60KB 文本附件落盘传路径 + 前端注入 `<system_info>` 引导 | 扩展到**所有附件**；前端注入逻辑移除（改由 coordinator 统一注入） |
| `agent.rs:1704` `save_attachment_file` | base64 → `%TEMP%/adm_attachments/{ts}_{sanitized_name}`，文件名防路径穿越 | 落盘目录改为 ADM 数据目录下的持久目录（如 `<data_dir>/attachments/`），避免系统清理临时目录导致历史路径失效；与 coordinator 落盘目录共用清理策略 |
| `send.js:96-99` | **图片限制**：非多模态模型阻止发送图片 | **删除** |
| `agent.js:433-446` | 附件白名单 `image/*` + 文本类（已含图片） | 保持 |

### admAgent 侧（`F:/trae/adm/admAgent`）

| 位置 | 现状 | 说明 |
|---|---|---|
| `coordinator.go:246-255` | 纯文本模型下图片附件被丢弃 | **改造**：统一落盘 + 路径注入 + 不再丢弃（TUI 由此覆盖） |
| `agent.go:1791` → `content.go:509` | 附件 `FilePath` 已消费：user 消息渲染 `<file path='...'>` 并持久化 | 路径随 user 消息落库，历史轮次模型仍可见路径 |
| `tools/view.go:186-189` | 纯文本模型读图返回 "does not support image data" | 改为引导文案 |
| `tools/bash.go:75-94` | curl/wget 被禁 | vision 子命令用 Go 标准库，无依赖 |
| TUI（`internal/ui`） | 粘贴图片发 base64 附件 | **无需改 UI 层**：coordinator 统一落盘自动覆盖 |

## 多模态模型选择（agent_vision_model）

### 内置 `admImage-model`（默认）

admAgent 内置虚拟多模态模型 `admImage-model`（`custom_providers.go:42`），挂在内置 provider `admAgent`（`custom_providers.go:294-308`）下，`SupportsImages=true` 且携带 `BackendPool`：

- **图片组 = 远程后端列表（backendModelsURL）中所有 `supports_images=true` 的模型**，round-robin 轮询（`pick(true)`）；api_key/base_url 随远程 JSON 下发、不落盘；
- 离线时 `defaultBackendPool` 兜底（内置多模态 `sensenova-6.7-flash-lite`）；
- **零配置可用**：只要图片组非空，`admAgent vision` 直接可用。

### 前端设置

Agent 设置弹窗（`settings_dialog.js`）新增「多模态模型（图片识别）」下拉：

- **选项**：固定首项 `admImage-model`（默认，标注"内置 · 自动轮询"）+ 所有 `supports_images=true` 的已配置模型（云端 provider + 本地多模态，复用现有模型列表数据，`model.js:211/238`）；
- **说明文案**：`用于识别会话中的图片；默认为内置 admImage-model`；
- **持久化链路**：
  1. 前端写入 `S.settings.agent_vision_model` → `save_settings`（config.json `Settings` 结构体，`types.rs:117` 新增字段）；
  2. Rust 后端 `save_settings` 时（或新增 `set_agent_vision_model` command）**同步写入 `$HOME/.config/admAgent/admAgent.json` 顶层 `agent_vision_model`**（复用 agent.rs 现有 admAgent.json 读写 + 触发服务端重载机制，`agent.rs:329`；**实现时需验证该重载对任意顶层字段生效，若不通用则改用显式 reload API**）；
  3. vision 子命令启动时 `config.Load` 读取：有值 → 用指定 provider/model；无值 → 默认 `admImage-model`。

### admAgent.json 模板

```jsonc
{
  "agent_vision_model": { "provider": "admAgent", "model": "admImage-model" }
  // 缺省（不写该字段）= 默认 admImage-model
}
```

### 选择逻辑（vision 子命令）

```
读 admAgent.json
  ├─ 有 agent_vision_model → 解析 provider/model
  │     ├─ 命中内置 admAgent/admImage-model → BackendPool.pick(true) 取一个图片后端
  │     └─ 命中本地配置 provider → 普通 client（base_url/api_key 走 cfg.Resolve）
  └─ 无（缺省） → 默认 admAgent/admImage-model
失败 → 错误矩阵 #10
```

## 实现计划

### 一期

#### A. ADM 前端 + Rust 改动（4 处，`src/` + `src-tauri/`）

1. **`send.js:96-99` 删除图片限制**——非多模态模型允许上传图片（由 vision 桥兜底）。
2. **`send.js:152-191` 路径模式扩展至全部附件**：
   - 取消 `LARGE_TEXT_ATTACH_BYTES`（60KB）阈值：所有附件无条件走路径（`save_attachment_file` 落盘，粘贴路径场景直接用已有 `f.path`）→ `attachments.push({file_path: realPath, ...content:""})`；
   - **删除前端 system_info 注入逻辑**（`pathModeHints` 相关）——路径注入统一由 coordinator 完成；
   - 落盘失败：`showError` 明确文案 + 中止发送（错误矩阵 #2b）；
   - 空 prompt 默认提示词不变。
3. **`attach.js` 白名单提示升级**（3 处：69/246/297）——"暂不支持该格式"文案补充原因：`该格式无法分析（工具仅支持文本与图片）：<文件名>`（错误矩阵 #3）。
4. **设置弹窗新增「多模态模型」选择**（`settings_dialog.js` + `template.js` 新增 HTML 结构 + `src-tauri/src/common/types.rs` + `src-tauri/src/pages/agent.rs`）——默认 `admImage-model`，持久化并同步写 admAgent.json（详见「多模态模型选择」章节）；`i18n.js` 新增相关翻译 key。

#### B. admAgent 改动（需审核）

1. **coordinator 统一附件处理**（`coordinator.go:246` 区域改造）：
   - Content 非空的附件（TUI/其他客户端场景）→ 落盘到 `<data_dir>/attachments/<sessionID>/<safe_name>`（复用 sanitize 逻辑，防路径穿越；失败按错误矩阵 #2 注入提示）；
   - **附件文件保留至 session 生命周期**（不能 run 结束时删，否则历史轮次路径失效）：session 删除时清理 + 每 session 数量/大小上限（如 50 个或 200MB，超限清理最旧）——避免磁盘泄漏同时保证历史路径可用；
   - 收集全部附件路径（含前端已传 `file_path` 的）→ 注入 `<system_info>` 到 prompt：路径列表 + 按**类型分类**引导（文本→view 分段读；图片→多模态 view 直读 / 纯文本 `admAgent vision`；其他类型→标注不支持，错误矩阵 #1/#1b）；**system_info 中图片引导使用 `os.Executable()` 得到的 admAgent 完整路径拼命令**（server 模式下 sidecar 不在 PATH，模型直接执行 `admAgent` 会 command not found）；
   - 图片附件不再被丢弃（转成路径文本后自然消解），`attachments` 对象保留 `FilePath` 供 `content.go:509` 持久化 `<file path='...'>`；
   - 多模态主模型场景：附件同样注入路径（模型可 view 直读，行为与现状等价）。
2. **新增 `internal/vision/` 包 + `internal/cmd/vision.go`**（vision 子命令）：读图 → **降采样（最大边 ≤ 2048px，防小上下文多模态模型超限并提速）** → base64 → OpenAI 兼容 API → 文本；**B 模型 prompt 模板固定**：system=「只输出简洁纯文本图片描述，不加 markdown/对话/反问」、user=「[提示: {hint}]
描述图片内容」；输出主动截断到 32KB（错误矩阵 #11）；超时 120s；大小 ≤ 20MB；MIME 嗅探；路径校验；**模型解析**：读 `agent_vision_model`，未配置默认 `admAgent`/`admImage-model`（`BackendPool.pick(true)` 取图片后端；**BackendPool 刷新时机**：config.Load 后等待一次远程刷新（短超时，如 2s），失败则用 fallback 池并照常工作）；**错误分类**（非图片/超限/API 错误/模型不可用，错误矩阵 #7-10，退出码 0/1/2）。
3. **`internal/cmd/root.go`**：`rootCmd.AddCommand(visionCmd)`（1 行）。
4. **新增 `internal/skills/builtin/vision-bridge/SKILL.md`**：指令型（`//go:embed builtin/*` 自动打包，`embed.go:31` 自动发现）；description 常驻 system prompt，指示图片一律 `admAgent vision <path>`，非零退出码读 stderr 告知用户。
5. **`tools/view.go` 报错细化**：`186-189` 纯文本模型读图 → 引导文案（矩阵 #5）；`211-213` 非 UTF-8 文本 → 分类提示（矩阵 #4）。
6. **配置**：`admAgent.json` 顶层新增 `agent_vision_model`（provider + model）；**缺省 = 内置 `admImage-model`**（零配置可用）；ADM 侧经 Rust 写入并触发重载（见「多模态模型选择」）。

#### C. 模式兼容性

TUI 与 server 共享同一 Coordinator（`app.go:538` 只建一次）：coordinator 统一落盘后，TUI 粘贴图片与前端上传图片走同一路径，双模式行为一致；权限交互差异（TUI 内联弹窗 / server 走前端）继承 bash 工具现有机制。`admAgent run` CLI 一次性模式已随 `d59bb388` 移除，无需兼容。

### 二期（可选）

| 项 | 内容 |
|---|---|
| 附件清理 | coordinator `<data_dir>/attachments/` 已随 session 删除 + 上限清理（一期）；前端历史遗留 `%TEMP%/adm_attachments/`（升级前版本）的迁移清理 |
| vision 缓存 | 同一图片路径+提示词 sha256 缓存，避免重复调 B |
| 批量识别 | vision 子命令支持多图 |

## 数据流

```
客户端上传附件（ADM: 前端先落盘 %TEMP%/adm_attachments/ → 传 file_path;
              TUI: 直接传 base64 附件）
  │
  ▼ coordinator（统一处理）
对 Content 非空的附件落盘 → <data_dir>/attachments/<sessionID>/<name>
收集全部附件路径 → 注入 <system_info>附件路径与读取引导</system_info>
prompt = 用户文字 + system_info
attachments = [{file_path: <path>, content: ""}]
  │
  ▼ sessionAgent
user 消息持久化（含 <file path='...'> 与 system_info 路径文本）
  │
  ▼ 模型（纯文本 A）
识别到 vision-bridge skill → bash: admAgent vision <path> "识别图片"
  │
  ▼ vision 子命令
ReadFile → base64 data URI → POST 多模态 B → 文本描述
  │
  ▼ 回流
stdout → tool result → 持久化进 session (SQLite)
  │
  ▼ 后续轮次
A 看到描述文本 → 继续干活（历史中图片只有文本，无 base64 膨胀）
```

## 边界与限制

| 场景 | 一期覆盖 | 说明 |
|---|---|---|
| 前端上传/拖拽/粘贴图片 | ✅ | 前端落盘 + coordinator 注入 |
| 前端上传文本/代码附件 | ✅ | 同样全部走路径（取消 60KB 阈值） |
| TUI 粘贴图片/附件 | ✅ | coordinator 统一落盘覆盖，无需改 TUI UI 层 |
| 模型在对话中发现图片文件 | ✅ | skill 引导 vision |
| 多模态主模型看图 | ✅ | view 直读图片（不经过 vision）；>200KB 大图自动降采样 ≤2048px（复用 vision 降采样），不再受原 MaxViewSize=200KB 上限报错 |
| 网络 URL 图片 | ⚠️ | `download` 工具下载后调 vision（skill 可指示） |

## 附件类型分类与错误处理

### 类型分类（coordinator 注入 system_info 时按 MimeType 判定）

| 类别 | 判定 | 处理引导 |
|---|---|---|
| 文本类 | `IsTextMime`（text/* + json/xml/yaml/js 等） | `view <path>` 分段读取 |
| 图片类 | `image/*` | 多模态模型 → `view` 直读；纯文本模型 → `admAgent vision <path>` |
| 其他（不支持） | 视频/音频/zip/pdf/octet-stream 等 | **明确标注不支持**，见错误矩阵第 1 行 |

### 错误处理矩阵（检测点 → 模型可见提示 → 用户可见）

| # | 场景 | 检测点 | 模型可见提示（工具输出 / system_info） | 用户可见 |
|---|---|---|---|---|
| 1 | 附件类型非文本非图片（zip/pdf/video 等） | coordinator 注入分类 | `⚠ 附件 '<name>'（<mime>）暂不支持：view 仅支持文本、vision 仅支持图片。请直接告知用户此附件无法分析，不要尝试用工具读取` | 模型转述 |
| 1b | 附件 MIME 未知（File.type 为空） | coordinator 注入分类 | `⚠ 附件 '<name>' 的 MIME 类型未知，无法确定文件类型。若确认为文本或图片请用户手动指定；否则告知用户暂不支持` | 模型转述 |
| 2 | coordinator 落盘失败（TUI / base64 场景） | coordinator 落盘错误 | `⚠ 附件 '<name>' 保存失败（<原因>），无法分析。请告知用户重试` | 模型转述 |
| 2b | 前端直接落盘（非 TUI）| `send.js` `save_attachment_file` | 前端 `showError` 明确文案 + **中止发送**（不静默降级内联） | 用户直接看到错误弹窗 |
| 3 | 前端白名单外格式（选择器/拖拽/粘贴） | `attach.js` 三处入口（69/246/297） | 文案升级为：`该格式无法分析（工具仅支持文本与图片）：<文件名>` | 用户直接看到错误提示 |
| 4 | view 读非文本文件（二进制/非 UTF-8） | `view.go:211-213` utf8 校验 | `文件不是有效的 UTF-8 文本，view 无法读取。若为图片请改用 admAgent vision <path>；若为其他格式请告知用户暂不支持` | 模型转述 |
| 5 | view 读图片 + 纯文本模型 | `view.go:186-189` | `此模型不支持图片，请改用 admAgent vision <path> 识别` | 模型转 vision |
| 6 | view 图片超限 | `view.go` 图片分支 | **多模态主模型**：>200KB（原 MaxViewSize 内联上限）的图片不再报错，自动降采样（复用 vision 的 `DownscaleImage`，最大边 ≤ 2048px 重编码）后返回；>20MB 仍报错（`Image file is too large...`）。**纯文本主模型**不受影响（走矩阵 #5 引导） | 模型转述 / 直接看图 |
| 7 | vision 读非图片文件 | vision 子命令 | stderr：`vision 仅支持图片（PNG/JPEG/GIF/WebP/BMP），'<path>' 不是图片` + 退出码 1 | 模型转述 |
| 8 | vision 图片超限 | vision 子命令 | stderr：`图片 '<path>' 超过 20MB 上限` + 退出码 1 | 模型转述 |
| 9 | vision 调 B 失败 | vision 子命令错误分类 | stderr 分类文案：超时 / 认证失败(401) / 模型不存在(404) / 余额不足(402/403) / 网络错误 / 服务端错误(5xx)，各附退出码 1 | 模型转述 |
| 10 | vision 模型不可用（`admImage-model` 图片组为空 / 指定 provider+model 不存在） | vision 子命令启动校验 | stderr：`多模态模型不可用：admImage-model 当前无可用图片后端，请在 ADM 设置中选择多模态模型或检查后端服务` + 退出码 2 | 模型转述 |
| 11 | vision 描述文本过长（>32KB） | vision 子命令输出 | stdout 主动截断到 32KB + 追加 `...[内容截断]` 保证不超过 bash tool 的 stdout 上限；模型如需更多细节可调整 hint 重试 | 模型见截断标记 |

### 设计要点

- **错误必须"模型可见且可转述"**：工具报错一律走 stdout/stderr 文本（非零退出码），system_info 直接写进 prompt，模型能原样转述给用户，不允许静默失败；
- **vision 退出码约定**：`0` 成功 / `1` 参数、文件、API 调用类错误 / `2` 配置缺失类错误（模型可按码区分"环境问题"与"内容问题"）；
- **多模态主模型同样生效**：第 1/1b/3/4 行对多模态模型同样成立（view 也读不了 zip/pdf），只是图片不再经 vision；
- **前端提示升级**：`attach.js` 现有"暂不支持该格式"文案补一句原因（工具仅支持文本与图片），让用户第一时间明白是能力边界而非 bug。

### 设计风险

**Skill 触发非 100% 可靠**：vision-bridge skill 靠 description 常驻 system prompt + coordinator system_info 双路径提示，但模型仍可能忽略 skill 直接调 `view`。此时 view 的引导文案（矩阵 #5）是兜底——依赖模型解析引导并切换到 `admAgent vision`。

减轻措施：
- **双播路径**：skill description（system prompt）+ coordinator system_info（prompt 注入）都会提示「图片用 admAgent vision」；
- **view 引导文案清晰**：直接给出准确命令格式（`admAgent vision <path>`），降低模型误解概率；
- **多模态主模型不受影响**：图片走 view 直读，不依赖 skill；
- **可后续增强**（二期）：view 工具自动判断模型能力，纯文本模型读图时直接把图片数据代理给 vision 而非报错——消除 skill 依赖；
- **实测验证**：M4 联调阶段重点测模型是否按预期走 vision。

**小文本附件行为回退**：取消 60KB 阈值后，小文本附件从"内联直接可见"退化为"路径需模型自觉 view 才可见"——若模型不主动读，附件内容对模型不可见。缓解：system_info 强引导（"以下附件必须读取后才能处理"）+ 模型能力依赖（主流模型会跟随）。这是用户明确要求的统一路径模式的固有 trade-off，接受并在 M4 验证。

## 安全考虑

- **路径穿越**：前端 `save_attachment_file` 已 sanitize（agent.rs:1714）；coordinator 落盘复用同样 sanitize 逻辑；vision 子命令不限制工作目录范围（与 view 工具一致，粘贴外部路径是合法用例），路径校验只防绝对路径逃逸到系统目录，permission 系统兜底；
- **大小限制**：附件 20MB（read_attachment_file 上限）、vision 读图 ≤ 20MB、view 直读图片 >20MB 报错；多模态主模型经 view 直读时 >200KB 的图片自动降采样到 ≤2048px（复用 vision 降采样，防小上下文模型超限并提速）。
- **权限**：bash 调用 vision 继承 bash 工具 permission 机制，不引入新绕过点；**注意**：server 模式下每次图片识别都会触发一次 bash 权限请求（前端弹窗），高频图片场景可提示用户用 yolo/自动批准缓解（ADM 设置已支持）；
- **密钥**：B 模型 api_key 走现有 provider 体系（`cfg.Resolve` 处理脱敏/模板），不进日志。

## 里程碑

1. **M1（前端）**：send.js 两处改动（删图片限制 + 全部附件路径模式 + 移除前端注入）+ attach.js 提示升级 + 设置弹窗「多模态模型」选择器（settings_dialog.js + template.js HTML + types.rs + agent.rs）+ i18n.js 翻译 key，验证所有附件类型均以 file_path 发送。
2. **M2（admAgent core）**：coordinator 统一落盘+路径注入（含 TUI 覆盖、session 级保留与上限清理、vision 可执行路径注入）+ vision 包/子命令（含 `agent_vision_model` 解析、默认 admImage-model、降采样、BackendPool 刷新等待）+ root.go 注册；单测（落盘、注入、图片→文本、模型选择、错误路径、大小限制）。
3. **M3（skill）**：vision-bridge SKILL.md + view 报错引导；`go build` + 内置 skill 发现测试。
4. **M4（联调）**：重新打包 admAgent 进 `buildAgent/`，ADM 内验证：纯文本模型 + 图片附件（前端与 TUI 两条路径）→ 自动识别 → 描述入对话流 → 继续干活；多模态模型 + 图片 → view 直读不受影响。
5. **M5（二期，可选）**：附件清理、缓存、批量识别。
