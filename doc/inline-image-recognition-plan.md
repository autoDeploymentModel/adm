# 多图片识别直接内联计划（v2）

## 背景

目前桌面端 + admAgent 对图片附件统一走 "Vision Bridge"：图片落盘为磁盘路径，
服务端注入 `<system_info>` 引导让主模型执行 `admAgent vision <path>` 子命令，
主模型拿到的是文本描述，看不到原图。该方案在纯文本主模型下是合理兜底，
但在**已支持图片**的主模型（`supports_images=true`）上属于"绕路"：

- 多一次 LLM 调用（多张图 = 多次），延迟和成本都翻倍
- 多模态模型自身的视觉理解能力（OCR、空间关系、细节）被替换成 caption 风格描述
- 描述文本会被压到 32KB 上限（`vision.MaxOutputBytes`），长图细节丢失

**v2 目标（含用户新要求）**：

1. 主模型支持图片时，第一轮直接 base64 内联（`image_url` 走 OpenAI Chat
   Completions 多模态格式），跳过 vision 子命令；纯文本主模型维持 vision bridge。
2. **无论走哪条路径，图片都必须先落盘缓存**（本地临时保存）。
3. **base64 只在发图当轮出现，禁止带入后续轮次的上下文**（历史消息不持久化
   base64，SQLite 只存路径 + 元数据）。
4. 后续轮次不重放 base64（避免上下文爆炸性增长）；仅当用户再次要求识别原图、
   或模型认为上次识别效果不理想需要重新确认时，模型通过本地缓存的路径执行
   `admAgent vision <path>` 做二次识别。
5. **前端统一用方式二（base64）传图片**（必须传 `content`，`file_path` 可选）：
   模型能力判断全部收归服务端 `ingestAttachments` 一处，前端不再读取
   `supports_images`、不再判断内联/路径模式，逻辑大幅简化。

---

## 现状梳理

### 当前链路（按数据流向）

1. **桌面端选/粘图片** —— `src/views/agent/attach.js`
   - `addPendingFiles` / `addPastedPaths`：每张图单独压缩（最大边 2048px，
     >1MB 用 0.7 质量 JPEG），结果进 `S.pendingFiles` 数组，每项结构：
     `{name, type, size, base64, dataUrl, path}`。

2. **发送时统一落盘** —— `src/views/agent/send.js:147-164`
   - `save_attachment_file`（Rust `src-tauri/src/pages/agent.rs:2698`）
     把 base64 写到 `<data_dir>/attachments/<ts>_<name>`，返回绝对路径。
   - 不论几张图，全部走**路径模式**：
     `attachments = [{file_path, file_name, mime_type, content: ""}]`，
     `content` 一律为空（避免内联 base64 触发 70% 上下文守卫死循环，
     注释见 `send.js:142-146`）。

3. **服务端统一处理** —— `admAgent/internal/agent/attachment_ingest.go`
   (`ingestAttachments`)
   - 每个附件分类生成 `<system_info>` 引导。
   - 图片分支（`attachment_ingest.go:160-165`）：
     ```
     - 附件 'xxx'（image/png，路径: ...）: 请直接原样执行本条给出的完整命令
       （"<exe>" vision "<path>"），不要自行拼接…
     ```
   - 多张图 = 多行引导，每张各带自己的完整 `admAgent vision <path>` 命令。
   - `att.Content = nil`（`attachment_ingest.go:143-145`），图片永不内联。

4. **模型逐张执行 vision 命令** —— `admAgent/internal/vision/vision.go`
   - `Describe`：读图 → MIME 嗅探 → 双线性降采样到 ≤2048px → 重新编码 →
     调多模态模型（`agent_vision_model`，缺省内置 `admAgent/admImage-model`
     走图片后端池 `config.PickImageBackend`） → 拿回 ≤32KB 文字描述。
   - 多张图 = 多次 `bash admAgent vision ...` 调用，每次返回一段描述，
     被并入 bash 输出流给主模型。

5. **历史消息持久化** —— `admAgent/internal/message/content.go:551-567`
   - `ToAIMessage` 把非文本 BinaryContent 转 `fantasy.FilePart`，
     **但仅在 `len(content.Data) > 0` 时**。
   - 由于 `ingestAttachments` 把图片 Content 清空，历史里永远不会构造 FilePart，
     `agent.go:2127-2134` 的 `filterFileParts` 也只是防御性兜底。

### 关键支撑（v2 直接复用）

- `config.ModelInfo.SupportsImages`（`admAgent/internal/config/modelinfo.go:35`）
  已含在模型元数据里，由 discover / 自定义 provider 写入。
- `proto.AgentInfo.Model`（`proto/proto.go:108-113`）原样回吐 `config.ModelInfo`，
  桌面端 `GET /v1/workspaces/{id}/agent` 已能读到 `supports_images`。
- `fantasy.FilePart` → `llm.ContentPart{Type: image, ImageURL: dataURI}` 的
  转换已在 `agent_loop_llm.go:2066-2077` 实现，只对 `len(Data) > 0` 的图片生效。
- `buildCurrentUserMessage`（`agent_loop_llm.go:1498`）已接受
  `files []fantasy.FilePart` 参数拼装当轮 user 消息的 image parts
  （当前 `files` 参数由 tool-result 媒体回流填充，用户附件未接入）。
- `SessionAgentCall`（`agent.go:218-246`）已有 `Attachments []message.Attachment`
  字段，追加 `InlineFiles` 字段即可打通"当轮内联、不落库"。
- `workaroundProviderMediaLimitations`（`agent.go:2772-2856`）已正确按
  `supportsImages` 处理 tool result 里的媒体回流，无需动。

---

## 核心设计

### 数据三态

| 状态 | 传输层（HTTP） | 本轮的 LLM 请求 | SQLite 持久化 | 后续轮次上下文 |
|---|---|---|---|---|
| 纯文本主模型 + 图片 | base64（统一） | 路径 + vision 引导（现状） | 仅路径 + 元数据 | 无 base64，可再 vision |
| 多模态主模型 + 图片 | base64（统一） | **base64 内联**（新） | **仅路径**（不存 base64） | 无 base64，可再 vision |
| 任意主模型 + 文本 | 路径（现状） | 路径 + view 引导（现状） | 仅路径 + 元数据 | 无变化 |

**关键点**：base64 是"一次性传输"介质，**从不落库**；磁盘缓存是"持久引用"。

> **目的**：避免每一轮都把 base64 代入上下文，导致上下文随轮次爆炸性增长。
> 因此 base64 只在发图当轮出现一次；后续轮次（除非用户再次要求识别原图，
> 或模型认为上一轮识别效果不理想需要重新确认）不重放 base64，需要时复用
> 本地缓存的图片通过 `admAgent vision <path>` 做二次识别。

---

## 改动点

### 1) `admAgent/internal/agent/attachment_ingest.go`（核心）

签名从：

```go
func ingestAttachments(dataDir, sessionID string, attachments []message.Attachment) ([]message.Attachment, string)
```

改为：

```go
// inlineFiles：多模态主模型当轮要内联的图片（wire-only，不持久化）
func ingestAttachments(dataDir, sessionID string, attachments []message.Attachment, supportsImages bool) ([]message.Attachment, string, []fantasy.FilePart)
```

**决策全部在服务端**，前端无论传什么（`content` 必带 base64、`file_path` 可有可无），
统一按以下三步处理（图片分支，`attachment_ingest.go:130-165` 一带）：

```go
// 1) 补齐落盘：needsPersist 判定不变——FilePath 为空/相对/磁盘不存在 → 写入
//    <data_dir>/attachments/<sessionID>/<safe_name> 并回填 FilePath。
//    执行完，所有图片附件状态一致：绝对路径 + 字节已在磁盘。
if len(att.Content) > 0 {
    if needsPersist(att.FilePath) {
        // ... 现有落盘逻辑（写入 session 附件目录）
    }
    // 备份引用，供当轮内联
    inlineData := att.Content

    // 2) 主模型支持图片识别？
    if supportsImages && isImageMime(att.MimeType) && isUsablePath(att.FilePath) {
        // → 支持：直接 base64 内联给 LLM（wire-only，落到 InlineFiles 当轮发送），
        //   不注入 vision 引导。
        inlineFiles = append(inlineFiles, fantasy.FilePart{
            Filename:  name,
            Data:      inlineData,
            MediaType: att.MimeType,
        })
        continue // 跳过下方 vision 引导
    }

    // 3) 不支持（或图片不可用）：Content 置空丢弃内存字节，注入
    //    "<exe>" vision "<path>" 完整命令引导（现状不变）。
    att.Content = nil
}
```

按 `supportsImages` 二选一的引导：

- **true**：图片**不追加** vision-bridge hint（本轮模型已直接看图），历史回放由
  改动点 4 的路径提示负责。
- **false**：保留现有 `admAgent vision <path>` 命令引导（现状不变）。

> **前端不再区分**：`content=""` 的纯路径图片（历史客户端 / 兼容场景）同样走
> 上述 2/3 步（supportsImages=true 时因 Content 空不会进内联分支，自然回退
> vision 引导），无需前端配合。

文本附件分支不动。未知 MIME / 不支持格式的错误矩阵提示不动。

文件顶部注释（`attachment_ingest.go:14-23`）更新为：

```
// 附件统一处理（落盘缓存 + 按主模型能力的双路径图片识别）：
//   - 客户端统一以 base64 传图片（content 必带、file_path 可选），本函数先
//     补齐落盘：路径不可用 → 写入 <data_dir>/attachments/<sessionID>/，回填
//     FilePath；路径可用 → 直接复用，不重复写盘。路径随 user 消息持久化
//     （历史轮次仍可见）；
//   - 主模型 supports_images=true：当轮图片 base64 内联给模型（wire-only，
//     不落库），后续轮次上下文不含 base64，需要时模型可对本地缓存路径
//     执行 admAgent vision <path> 再次识别；
//   - 主模型 supports_images=false：图片走 admAgent vision <path>（vision
//     bridge）识别，注入完整识别命令引导（现状不变）；
//   - 收集全部附件路径 + 按类型分类的读取引导，注入 <system_info>。
```

### 2) `admAgent/internal/agent/coordinator.go`（传参 + 转发 inlineFiles）

`coordinator.go:252-258`：

```go
var attachHint string
var inlineFiles []fantasy.FilePart
if len(attachments) > 0 {
    dataDir := c.cfg.Config().Options.DataDirectory
    attachments, attachHint, inlineFiles = ingestAttachments(
        dataDir, sessionID, attachments, model.ModelInfo.SupportsImages,
    )
    if attachHint != "" {
        prompt = prompt + "\n\n" + attachHint
    }
}
```

随后把 `inlineFiles` 放进 `SessionAgentCall`（在构造 `agent.SessionAgentCall` 处
追加 `InlineFiles: inlineFiles`），保证只走当轮 `buildCurrentUserMessage`，
不随消息落库。

### 3) `admAgent/internal/agent/agent.go`（SessionAgentCall 新字段 + 接入 files）

- `SessionAgentCall`（`agent.go:218`）追加：

```go
// InlineFiles 当轮内联（wire-only）的图片附件；不持久化，下轮不重放。
InlineFiles []fantasy.FilePart
```

- `Run` 里 `preparePrompt`（`agent.go:1057`）的 `files` 参数并入
  `call.InlineFiles`：

```go
history, files := a.preparePrompt(ctx, msgs)
files = append(files, call.InlineFiles...) // 当轮图片内联
```

注意 `files` 会被 `runMainLoopWithLLM` 传给 `buildCurrentUserMessage(call, files)`
（`agent_loop_llm.go:304`），最终走 `filePartsToLLMContent` → `image_url`。

- `agent.go:2127-2134` 的 `filterFileParts` 保持现状即可，不必条件化：
  因为**落库的附件 Data 恒为空**，历史消息永远不会构造出 FilePart，
  过滤恒为空操作（幂等）。此前的 v1 计划里"条件化过滤"不再需要。
- `agent.go:2128-2141` 注释同步更新（"files 恒为空"→"落库附件不含 Data，
  历史轮次不内联；当轮内联走 call.InlineFiles"）。

### 4) `admAgent/internal/message/content.go`（历史图片路径回放提示）

`ToAIMessage` 的 binary 循环（`content.go:551-567`）需补一段：当遇到
**图片附件 FilePath 非空但 Data 为空**（历史轮次的多模态/纯文本图片）时，
不再静默跳过，而是把"缓存引用"追加进 user 消息文本：

```go
for _, content := range m.BinaryContent() {
    if IsTextMime(content.MIMEType) {
        continue
    }
    if len(content.Data) == 0 {
        // 历史图片：base64 不重放，但告知模型本地缓存路径可再次识别
        if content.Path != "" && strings.HasPrefix(content.MIMEType, "image/") {
            fmt.Fprintf(&text, "\n[图片 '%s' 已缓存于 %s，如需再次查看原图请执行 %s]",
                content.Name, content.Path, visionHintFor(content.Path))
        }
        continue
    }
    parts = append(parts, fantasy.FilePart{ ... })
}
```

其中 `visionHintFor` 复用 `attachment_ingest.go:104-110` 的
`<quoted-exe> vision <quoted-path>` 命令拼装（提取为公共 helper，避免两处
重复；Windows 反斜杠转正斜杠 + 引号的规则必须一致）。

> 该提示只出现在**带原图的历史 user 消息**里，每张图只出现一次，
> 不会每轮重复注入，上下文增量可控。

### 5) `admAgent/internal/agent/attachment_ingest_test.go`（测试更新）

`TestIngestAttachments_AllModelsUseVisionBridge`
（`attachment_ingest_test.go:141-158`）断言"图片 Content 必清空、hint 必含
vision"，需要拆成三个用例：

- `TestIngestAttachments_TextModelForcesVisionBridge`：
  supportsImages=false 时清 Content + 出 vision 引导 + **落盘**（FilePath 非空）。
- `TestIngestAttachments_VisionModelInlinesContent`：
  supportsImages=true 时 Content 清空（不落库）、`inlineFiles` 返回 1 个
  FilePart（Data 非空、MediaType 正确）、**落盘**（FilePath 非空）、
  hint 中**不包含** `vision` / `admAgent vision`。
- `TestIngestAttachments_VisionModelInlinesContent_OnlyThisTurn`：
  连续两次 ingest（模拟下轮），第二次同一附件（FilePath 已存在、Content 空）
  → `inlineFiles` 为空、hint 为空（不重复注入）。

新增边界：

- 混合附件（1 图片 + 1 文本）：图片进 inlineFiles、文本走 view 引导，均落盘。
- supportsImages=true 且 FilePath 已存在（粘贴场景）：仍落盘（幂等覆盖）+
  内联；Content 清空。
- supportsImages=true 且 Content 为空（桌面端极端路径）：inlineFiles 为空，
  降级走 vision 引导（保留旧行为，避免裸路径无法读）。

### 6) 桌面端 `src/views/agent/send.js`（图片统一发 base64，文本走路径）

**前端不再读取 `supports_images`、不再区分内联/路径模式**，只按附件类型分
两支。`send.js:147-164` 改造：

```js
for (var i = 0; i < filesToSend.length; i++) {
    var f = filesToSend[i];
    var isImage = f.type && f.type.indexOf("image/") === 0;
    if (isImage) {
        // 图片：统一走方式二（base64 内联传输）——必须带 content；
        // file_path 可选：粘贴场景有真实路径就带上（服务端判定存在则
        // 跳过写盘），没有则服务端自动落盘。内联/vision 引导完全由
        // 服务端按主模型能力决定。
        attachments.push({
            file_path: f.path || "",
            file_name: f.name,
            mime_type: f.type,
            content: f.base64,
        });
        continue;
    }
    // 文本：保持路径模式（内容不内联，避免触发上下文守卫）
    var realPath = f.path || null;
    if (!realPath) {
        try {
            realPath = await invoke("save_attachment_file", {
                file_name: f.name,
                base64_content: f.base64 || "",
            });
        } catch (e) {
            console.warn("[agent] 附件落盘失败:", e);
            showError(_t("附件保存失败，已取消发送: ") + f.name
                + " (" + friendlyError(e, { inline: true }) + ")");
            return;
        }
    }
    attachments.push({
        file_path: realPath,
        file_name: f.name,
        mime_type: f.type || "application/octet-stream",
        content: "",
    });
}
```

**不动的部分**：`attach.js` 压缩逻辑、Rust `save_attachment_file`（文本路径模式
仍需；图片不再调用）、`f.base64` 在前端内存中的生命周期（发完即弃）。

### 7) 桌面端 `src/views/agent/send.js:142-146`（注释更新）

原注释"避免内联 base64 触发 70% 上下文守卫死循环"改为：

> 文本附件一律不内联进 prompt（避免内联内容触发 70% 上下文守卫死循环），
> 统一落盘传路径。图片附件统一以 base64 内联传输（`content` 必带），由
> 服务端落盘缓存并按主模型能力决定：支持图片 → 当轮 wire 层内联给模型
> （**base64 不落库**，后续轮次通过本地缓存路径 + `admAgent vision` 再次识别）；
> 不支持 → 注入 vision 命令引导。前端不感知模型能力。

---

## 不动的部分

| 区域 | 原因 |
|---|---|
| `admAgent/internal/vision/vision.go` | TUI 端 / 纯文本主模型 / CLI 独立使用都要保留，且作为"再次识别"回放入口 |
| `workaroundProviderMediaLimitations`（`agent.go:2772`） | 已按 `supportsImages` 分支处理 tool result 媒体 |
| `content.go:497-519`（`PromptWithTextAttachments`） | 文本内联逻辑不变 |
| `agent_loop_llm.go:2066-2077`（`filePartsToLLMContent`） | 已把非空 Data 的 FilePart 转 `image_url`，自动生效 |
| `proto.AgentInfo.Model.SupportsImages` | 已在 `/agent` GET 返回 |
| Rust `save_attachment_file` | 文本附件路径模式仍需，图片不再调用；保留 |
| TUI 端发送链路 | TUI 一直传 base64 + FilePath；ingestAttachments 统一落盘 + 按 supportsImages 分支，TUI 自动享受 |

---

## 改动文件清单

| 文件 | 类型 | 改动量 |
|---|---|---|
| `admAgent/internal/agent/attachment_ingest.go` | 改 | 中（双路径分支 + 落盘前置 + 返回 inlineFiles + 注释） |
| `admAgent/internal/agent/coordinator.go` | 改 | 小（传 supportsImages + 接收/转发 inlineFiles） |
| `admAgent/internal/agent/agent.go` | 改 | 小（SessionAgentCall.InlineFiles + files 并入 + 注释） |
| `admAgent/internal/message/content.go` | 改 | 小（历史图片路径回放提示） |
| `admAgent/internal/agent/attachment_ingest_test.go` | 改 | 中（拆 3 用例 + 边界） |
| `src/views/agent/send.js` | 改 | 小（图片统一 base64 分支，移除模型能力判断） |

---

## 风险与注意

- **上下文窗口突变（已缓解）**：base64 只在当轮出现，历史上下文不含图片字节；
  但当轮多图 + 大图仍可能瞬时占用较多 token。多模态模型通常 ≥ 64k 上下文；
  `agent.go:1614` 的 `clampContextUnderLimit` 已存在兜底。
- **"再次识别"的语义**：历史回放提示（改动点 4）只在带原图的 user 消息里出现
  一次，模型据此知道"原图在本地缓存、可 vision 重看"。若用户下轮不提及图片，
  该提示静默存在，不增加每轮开销。
- **provider 兼容性**：`fantasy.FilePart` → `image_url` 转换走 `llm/client.go:861`
  标准 OpenAI Chat Completions 格式，兼容该协议的 provider 应都支持；
  Anthropic / Bedrock provider 已有 `workaroundProviderMediaLimitations` 保护，
  需确认直发 FilePart 也被它们的 fantasy provider 正确转换。
- **粘贴路径场景**：`f.path` 已存在且磁盘有效 → 服务端跳过写盘，vision 引导
  读原文件（原图若超 2048px 由 vision 内部降采样，行为正确）；`f.path` 不存在
  或 Content 为空 → 服务端落盘压缩版内容或降级 vision 引导，均无需前端配合。
- **磁盘缓存上限**：单 session 附件 ≤ 50 个 / 200MB（`attachment_ingest.go:27-28`，
  超限按 mtime 清最旧），内联路径同样受此约束，不会无限膨胀。
- **模型能力判断以服务端为准**（已消除前端竞态）：`coordinator.Run` 在
  `c.currentAgent.Model().ModelInfo.SupportsImages` 处取值，切模型后立即发图
  使用的是服务端最新生效的模型，不存在前端旧缓存问题。

---

## 验证步骤

1. **构建**：
   - `pnpm typecheck`（前端必跑）
   - `cd admAgent && go build ./...`

2. **后端单测**：
   - `cd admAgent && go test ./internal/agent/ -count=1` +
     `go test ./internal/message/ -count=1`
   - 重点跑 `attachment_ingest` / `coordinator` / `agent` 包新用例。

3. **桌面端手工 E2E**：
   - 多模态主模型（如 GPT-4o / Claude 3.5，`supports_images=true`）发 3 张图
     提问 → 模型直接看图回答（响应里不再有"图片描述"前置句）；
     检查 `<data_dir>/attachments/<sessionID>/` 有 3 个缓存文件。
   - 紧接着第二轮同一会话发文字（不带图）→ 抓取该轮 LLM 请求，确认
     **不含任何 base64 image_url**；问"第一张图里有什么"→ 模型应引用历史
     回答或主动执行 `admAgent vision <path>` 重新识别。
   - 切回 text-only 模型发同一组图 → 仍走 vision bridge 全流程
     （同一份前端代码，服务端自动切换，无需前端改动）。
   - 同会话内切模型后复测 → 新轮次按服务端最新模型能力切换。
   - 粘贴路径场景复测：粘贴后发图，`attachments.file_path` 带真实路径，
     `content` 带 base64，确认服务端跳过重复写盘且内联/引导行为正确。

4. **回归**：
   - TUI 端多图粘贴、混合格式（图片 + txt）、超大图片（>1MB 压缩）、
     已落盘附件复用、session 删除后附件清理。

5. **历史回放**：
   - 多模态模型发图 → 切文本模型 → 再切回多模态模型 → 历史轮次图片
     上下文无 base64，原图路径提示可见，可手动 vision 重看。