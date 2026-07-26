# admAgent Server 模式 API 文档

> 本文档面向 GUI 客户端开发者，涵盖 admAgent server 模式下所有 HTTP API 端点。
>
> 路由注册源码：`internal/server/server.go` → `installHandler()`
>
> Handler 实现：`internal/server/proto.go`、`internal/server/config.go`
>
> 数据结构定义：`internal/proto/`

---

## 目录

- [概述](#概述)
- [传输协议](#传输协议)
- [通用错误处理](#通用错误处理)
- [SSE 事件流](#sse-事件流)
- [1. 系统接口](#1-系统接口)
- [2. 工作区接口](#2-工作区接口)
- [3. 会话接口](#3-会话接口)
- [4. Agent 接口](#4-agent-接口)
- [5. 配置接口](#5-配置接口)
- [6. LSP 接口](#6-lsp-接口)
- [7. 权限接口](#7-权限接口)
- [8. 文件追踪接口](#8-文件追踪接口)
- [9. 项目接口](#9-项目接口)
- [10. Skills 接口](#10-skills-接口)
- [11. MCP 接口](#11-mcp-接口)
- [附录 A：数据结构定义](#附录-a数据结构定义)
- [附录 B：GUI 开发建议](#附录-bgui-开发建议)

---

## 概述

admAgent server 模式通过 HTTP/1.1 + HTTP/2 (unencrypted h2c) 提供全部 RESTful API，所有路径以 `/v1/` 为前缀。Swagger 文档可通过 `/v1/docs/` 访问。

### 基础信息

| 项目 | 说明 |
|------|------|
| Base Path | `/v1` |
| 协议 | HTTP/1.1、HTTP/2 (h2c) |
| 请求格式 | JSON (`Content-Type: application/json`) |
| 响应格式 | JSON (`Content-Type: application/json`) |
| Swagger UI | `GET /v1/docs/` |

---

## 传输协议

admAgent server 支持三种传输方式（由 host 参数决定）：

| 协议 | 格式 | 平台 | 默认值 |
|------|------|------|--------|
| Unix Socket | `unix:///path/to/socket` | Linux/macOS | `unix:///tmp/admAgent-<uid>.sock` |
| Named Pipe | `npipe:////./pipe/admAgent.sock` | Windows | `npipe:////./pipe/admAgent.sock` |
| TCP | `tcp://host:port` | 全平台 | 无 |

GUI 客户端需根据运行平台选择合适的传输方式连接 server。

---

## 通用错误处理

所有错误响应统一使用以下结构：

```json
{
  "message": "错误描述信息"
}
```

### 错误状态码映射

| HTTP 状态码 | 触发条件 |
|-------------|----------|
| `400 Bad Request` | 请求体解析失败、Agent 未初始化、缺少路径参数、无效的权限操作、未知命令、无效的 client_id |
| `404 Not Found` | 工作区不存在、LSP 客户端不存在、客户端未挂载 |
| `409 Conflict` | 工作区正在关闭中 |
| `500 Internal Server Error` | 其他未预期错误 |

---

## SSE 事件流

GUI 客户端通过 `GET /v1/workspaces/{id}/events` 订阅 Server-Sent Events，实时接收工作区内所有事件。

### 连接要求

- 需要查询参数 `client_id`（UUID 格式）
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
- 每个事件格式：`data: {JSON}\n\n`

### 事件信封结构

```json
{
  "type": "事件类型字符串",
  "payload": { ... }
}
```

其中外层 `type`/`payload` 是 `pubsub.Event`，内层 `type`/`payload` 是具体事件数据。

### 事件类型一览

| `type` 值 | 内层 payload 类型 | 说明 |
|-----------|-------------------|------|
| `lsp_event` | `LSPEvent` | LSP 状态/诊断变更 |
| `mcp_event` | `MCPEvent` | MCP 客户端状态变更 |
| `permission_request` | `PermissionRequest` | 权限请求（等待用户授权） |
| `permission_notification` | `PermissionNotification` | 权限处理结果通知 |
| `message` | `Message` | 消息创建/更新/删除 |
| `session` | `Session` | 会话创建/更新/删除 |
| `file` | `File` | 历史文件变更 |
| `agent_event` | `AgentEvent` | Agent 事件（错误/响应/摘要） |
| `config_changed` | `ConfigChanged` | 配置变更通知 |
| `skills_event` | `SkillsEvent` | Skill 发现状态变更 |
| `run_complete` | `RunComplete` | Agent 运行完成信号（每轮精确一次） |

### 内层事件 `type` 取值

事件内层的 `type` 字段（`pubsub.EventType`）取值为：

| 值 | 说明 |
|----|------|
| `created` | 资源创建 |
| `updated` | 资源更新 |
| `deleted` | 资源删除 |

### 关键事件说明

#### RunComplete（运行完成）

这是每轮 Agent 对话的**权威结束信号**，每轮顶层 agent turn 恰好触发一次。GUI 客户端应基于此事件判断对话是否结束。

```json
{
  "type": "run_complete",
  "payload": {
    "type": "updated",
    "payload": {
      "session_id": "会话ID",
      "run_id": "运行ID（可选，用于精确关联）",
      "message_id": "最终消息ID",
      "text": "最终文本输出",
      "error": "错误信息（非空表示运行出错）",
      "cancelled": false
    }
  }
}
```

**关联策略**：优先用 `run_id` 关联（当客户端发送消息时设置了 `run_id`），否则退化为 `session_id` 关联。

#### PermissionRequest（权限请求）

当 Agent 执行需要用户授权的操作时，会通过此事件通知 GUI 弹出权限确认对话框。

```json
{
  "type": "permission_request",
  "payload": {
    "type": "created",
    "payload": {
      "id": "权限请求ID",
      "session_id": "会话ID",
      "tool_call_id": "工具调用ID",
      "tool_name": "bash",
      "description": "操作描述",
      "action": "执行命令",
      "params": { ... },
      "path": "相关文件路径"
    }
  }
}
```

---

## 1. 系统接口

### 1.1 健康检查

```
GET /v1/health
```

检查服务器是否正常运行。

**请求参数**：无

**响应**：`200 OK`（无响应体）

---

### 1.2 获取版本信息

```
GET /v1/version
```

获取服务器版本信息。

**响应** `200 OK`：

```json
{
  "version": "版本号",
  "commit": "Git提交哈希",
  "build_id": "构建ID",
  "go_version": "Go版本",
  "platform": "操作系统/架构",
  "pid": 12345
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 语义化版本号 |
| `commit` | string | Git commit hash |
| `build_id` | string | 构建标识 |
| `go_version` | string | 编译用的 Go 版本 |
| `platform` | string | 运行平台 (如 `linux/amd64`) |
| `pid` | int | 服务器进程 PID（用于升级时定位进程） |

---

### 1.3 获取全局配置

```
GET /v1/config
```

返回全局服务器配置。

**响应** `200 OK`：全局配置对象（`config.Config` 结构，详见配置文件格式）。

---

### 1.4 发送控制命令

```
POST /v1/control
```

向服务器发送控制命令（如关闭服务器）。

**请求体**：

```json
{
  "command": "shutdown"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 控制命令，目前仅支持 `"shutdown"` |

**响应**：`200 OK`（无响应体）

**错误**：`400` - 未知命令

---

## 2. 工作区接口

### 2.1 列出所有工作区

```
GET /v1/workspaces
```

**响应** `200 OK`：

```json
[
  {
    "id": "工作区ID",
    "path": "/path/to/project",
    "yolo": false,
    "debug": false,
    "data_dir": "/path/to/data",
    "version": "版本号",
    "client_id": "创建者客户端ID",
    "config": { ... },
    "env": ["ENV_VAR=value"],
    "skills": [
      {
        "name": "skill名称",
        "path": "/path/to/skill.md",
        "state": 0,
        "error": ""
      }
    ]
  }
]
```

---

### 2.2 创建工作区

```
POST /v1/workspaces
```

**请求体**（`proto.Workspace`）：

```json
{
  "path": "/path/to/project",
  "yolo": false,
  "debug": false,
  "data_dir": "",
  "client_id": "客户端ID",
  "env": ["ENV_VAR=value"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 工作目录路径 |
| `yolo` | bool | 否 | 跳过所有权限确认 |
| `debug` | bool | 否 | 调试模式 |
| `data_dir` | string | 否 | 数据存储目录 |
| `client_id` | string | 否 | 创建者客户端标识 |
| `env` | []string | 否 | 环境变量列表 |

**响应** `200 OK`：创建后的 `Workspace` 对象

---

### 2.3 删除工作区

```
DELETE /v1/workspaces/{id}?client_id={client_id}
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `id` | 工作区 ID |

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `client_id` | string (UUID) | 是 | 客户端标识 |

**响应**：`200 OK`（无响应体）

---

### 2.4 获取单个工作区

```
GET /v1/workspaces/{id}
```

**响应** `200 OK`：`Workspace` 对象

---

### 2.5 设置当前会话

```
POST /v1/workspaces/{id}/current-session?client_id={client_id}
```

记录客户端当前选中的会话。空 `session_id` 表示清除（如回到落地页）。

**请求体**（`proto.CurrentSession`）：

```json
{
  "session_id": "会话ID"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 是 | 当前会话 ID，空字符串表示清除 |

**响应**：`200 OK`（无响应体）

---

### 2.6 获取工作区配置

```
GET /v1/workspaces/{id}/config
```

**响应** `200 OK`：工作区配置对象

---

### 2.7 获取可用 Providers

```
GET /v1/workspaces/{id}/providers
```

列出工作区可用的模型提供商列表。

**响应** `200 OK`：Provider 信息对象

---

### 2.8 获取工作区所有用户消息

```
GET /v1/workspaces/{id}/messages/user
```

返回工作区内所有会话的用户消息（跨会话）。

**响应** `200 OK`：`Message[]`

---

### 2.9 订阅工作区事件流（SSE）

```
GET /v1/workspaces/{id}/events?client_id={client_id}
```

**响应** `200 OK`：`text/event-stream`

详见 [SSE 事件流](#sse-事件流) 章节。

---

## 3. 会话接口

### 3.1 列出会话

```
GET /v1/workspaces/{id}/sessions
```

**响应** `200 OK`：`Session[]`

```json
[
  {
    "id": "会话ID",
    "parent_session_id": "父会话ID",
    "title": "会话标题",
    "message_count": 10,
    "prompt_tokens": 1000,
    "completion_tokens": 500,
    "context_tokens": 800,
    "summary_message_id": "摘要消息ID",
    "cost": 0.0023,
    "todos": [
      {
        "content": "任务内容",
        "status": "in_progress",
        "active_form": "正在处理..."
      }
    ],
    "created_at": 1719500000,
    "updated_at": 1719500100,
    "is_busy": false,
    "attached_clients": 1
  }
]
```

---

### 3.2 创建会话

```
POST /v1/workspaces/{id}/sessions
```

**请求体**：

```json
{
  "title": "会话标题"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 否 | 会话标题 |

**响应** `200 OK`：`Session` 对象

---

### 3.3 获取单个会话

```
GET /v1/workspaces/{id}/sessions/{sid}
```

**响应** `200 OK`：`Session` 对象

---

### 3.4 更新会话

```
PUT /v1/workspaces/{id}/sessions/{sid}
```

**请求体**（`Session`）：

```json
{
  "title": "新标题",
  "todos": [...]
}
```

**响应** `200 OK`：更新后的 `Session` 对象

---

### 3.5 删除会话

```
DELETE /v1/workspaces/{id}/sessions/{sid}
```

**响应**：`200 OK`（无响应体）

---

### 3.6 获取会话历史文件

```
GET /v1/workspaces/{id}/sessions/{sid}/history
```

返回该会话中被修改/创建的历史文件快照列表。

**响应** `200 OK`：`File[]`

```json
[
  {
    "id": "文件记录ID",
    "session_id": "会话ID",
    "path": "/path/to/file.go",
    "content": "文件内容快照",
    "version": 3,
    "created_at": 1719500000,
    "updated_at": 1719500100
  }
]
```

---

### 3.7 获取会话所有消息

```
GET /v1/workspaces/{id}/sessions/{sid}/messages
```

**响应** `200 OK`：`Message[]`

消息结构详见 [附录 A](#message-结构)。

---

### 3.8 获取会话用户消息

```
GET /v1/workspaces/{id}/sessions/{sid}/messages/user
```

仅返回该会话中 `role` 为 `user` 的消息。

**响应** `200 OK`：`Message[]`

---

## 4. Agent 接口

### 4.1 获取 Agent 信息

```
GET /v1/workspaces/{id}/agent
```

**响应** `200 OK`（`proto.AgentInfo`）：

```json
{
  "is_busy": false,
  "is_ready": true,
  "model": {
    "id": "gpt-4o",
    "name": "GPT-4o",
    "context_window": 128000,
    "supports_images": true,
    "can_reason": false
  },
  "model_cfg": {
    "model": "gpt-4o",
    "provider": "openai"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `is_busy` | bool | Agent 是否正在运行 |
| `is_ready` | bool | Agent 是否已就绪 |
| `model` | ModelInfo | 当前模型信息 |
| `model_cfg` | SelectedModel | 当前选中的模型配置 |

---

### 4.2 发送消息给 Agent

```
POST /v1/workspaces/{id}/agent
```

向 Agent 发送用户消息，异步触发 Agent 运行。此接口是 **fire-and-forget**：立即返回 `202 Accepted`，实际运行结果通过 SSE 事件流获取。

**请求体**（`proto.AgentMessage`）：

```json
{
  "session_id": "会话ID",
  "run_id": "可选的运行ID",
  "prompt": "用户输入内容",
  "attachments": [
    {
      "file_path": "/path/to/file",
      "file_name": "file.png",
      "mime_type": "image/png",
      "content": "base64编码内容"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 是 | 目标会话 ID |
| `run_id` | string | 否 | 运行 ID，用于精确关联 `RunComplete` 事件 |
| `prompt` | string | 是 | 用户提示内容 |
| `attachments` | []Attachment | 否 | 附件列表（content 为 base64 编码） |

**响应**：`202 Accepted`（无响应体）

**错误**：
- `400` - Agent 未初始化
- `409` - 会话繁忙且无法排队

> **GUI 提示**：发送消息后，通过 SSE 事件流接收 `message`（增量更新）和 `run_complete`（结束信号）事件。如果需要在多个并发运行中精确匹配某次请求的结果，请在发送时设置 `run_id`。

---

### 4.3 初始化 Agent

```
POST /v1/workspaces/{id}/agent/init
```

为工作区初始化 Agent。

**响应**：`200 OK`（无响应体）

---

### 4.4 更新 Agent

```
POST /v1/workspaces/{id}/agent/update
```

更新工作区的 Agent 配置（如模型变更后重新加载）。

**响应**：`200 OK`（无响应体）

---

### 4.5 获取 Agent 会话信息

```
GET /v1/workspaces/{id}/agent/sessions/{sid}
```

获取指定会话的 Agent 状态信息。

**响应** `200 OK`（`proto.AgentSession`）：

```json
{
  "id": "会话ID",
  "title": "标题",
  "is_busy": false,
  ...
}
```

---

### 4.6 取消 Agent 会话

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel
```

取消正在运行的 Agent 会话。

**响应**：`200 OK`（无响应体）

---

### 4.7 查询排队提示状态

```
GET /v1/workspaces/{id}/agent/sessions/{sid}/prompts/queued
```

查询该会话是否有排队的提示。

**响应** `200 OK`：

```json
{
  "queued": true
}
```

---

### 4.8 列出排队提示

```
GET /v1/workspaces/{id}/agent/sessions/{sid}/prompts/list
```

列出该会话所有排队的提示内容。

**响应** `200 OK`：`string[]`

---

### 4.9 清除排队提示

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/prompts/clear
```

清除会话中所有排队的提示。

**响应**：`200 OK`（无响应体）

---

### 4.10 摘要会话

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/summarize
```

触发会话摘要生成。

**响应**：`200 OK`（无响应体）

---

### 4.11 撤销上一轮

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/undo
```

撤销上一个 Agent turn 的操作（回滚文件变更）。

**响应**：`200 OK`（无响应体）

---

### 4.12 执行 Shell 命令

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/shell
```

在工作区中直接执行 Shell 命令（Bang 模式）。

**请求体**（`proto.ShellCommandRequest`）：

```json
{
  "session_id": "会话ID",
  "command": "ls -la",
  "term_width": 80
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 否 | 会话 ID（路径参数已提供，会自动设置） |
| `command` | string | 是 | 要执行的命令 |
| `term_width` | int | 否 | 终端宽度（影响输出格式） |

**响应** `200 OK`（`proto.ShellCommandResponse`）：

```json
{
  "output": "命令输出内容",
  "exit_code": 0
}
```

---

## 5. 配置接口

### 5.1 设置配置字段

```
POST /v1/workspaces/{id}/config/set
```

**请求体**（`proto.ConfigSetRequest`）：

```json
{
  "scope": 0,
  "key": "配置键名",
  "value": "配置值（任意类型）"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围：`0`=全局，`1`=工作区 |
| `key` | string | 是 | 配置键名 |
| `value` | any | 是 | 配置值（任意 JSON 类型） |

**响应**：`200 OK`（无响应体）

---

### 5.2 移除配置字段

```
POST /v1/workspaces/{id}/config/remove
```

**请求体**（`proto.ConfigRemoveRequest`）：

```json
{
  "scope": 1,
  "key": "配置键名"
}
```

**响应**：`200 OK`（无响应体）

---

### 5.3 设置首选模型

```
POST /v1/workspaces/{id}/config/model
```

**请求体**（`proto.ConfigModelRequest`）：

```json
{
  "scope": 1,
  "model": {
    "model": "gpt-4o",
    "provider": "openai",
    "reasoning_effort": "high",
    "think": false,
    "temperature": 0.7
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围 |
| `model.model` | string | 是 | 模型 ID |
| `model.provider` | string | 是 | 提供商 ID |
| `model.reasoning_effort` | string | 否 | 推理强度：`low`/`medium`/`high` |
| `model.think` | bool | 否 | 启用思考模式（Anthropic） |
| `model.temperature` | *float64 | 否 | 采样温度 |
| `model.top_p` | *float64 | 否 | Top-p |
| `model.top_k` | *int64 | 否 | Top-k |
| `model.provider_options` | map | 否 | 提供商特定选项 |

**响应**：`200 OK`（无响应体）

---

### 5.4 设置 Compact 模式

```
POST /v1/workspaces/{id}/config/compact
```

**请求体**（`proto.ConfigCompactRequest`）：

```json
{
  "scope": 1,
  "enabled": true
}
```

**响应**：`200 OK`（无响应体）

---

### 5.5 设置 Provider API Key

```
POST /v1/workspaces/{id}/config/provider-key
```

**请求体**（`proto.ConfigProviderKeyRequest`）：

```json
{
  "scope": 0,
  "provider_id": "openai",
  "kind": "string",
  "api_key": "sk-xxxxx"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围 |
| `provider_id` | string | 是 | Provider ID |
| `kind` | string | 是 | 凭据类型，目前仅支持 `"string"` |
| `api_key` | json.RawMessage | 是 | API Key（JSON 编码的字符串） |

**响应**：`200 OK`（无响应体）

---

## 6. LSP 接口

### 6.1 列出 LSP 客户端

```
GET /v1/workspaces/{id}/lsps
```

**响应** `200 OK`（`map[string]LSPClientInfo`）：

```json
{
  "gopls": {
    "name": "gopls",
    "state": "connected",
    "error": "",
    "diagnostic_count": 3,
    "connected_at": "2025-07-26T10:00:00Z"
  }
}
```

LSP `state` 取值：`disabled`、`starting`、`connected`、`error`

---

### 6.2 获取 LSP 诊断

```
GET /v1/workspaces/{id}/lsps/{lsp}/diagnostics
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `lsp` | LSP 客户端名称（如 `gopls`） |

**响应** `200 OK`：诊断信息对象

---

### 6.3 启动 LSP

```
POST /v1/workspaces/{id}/lsps/start
```

为指定路径启动 LSP 服务器。

**请求体**（`proto.LSPStartRequest`）：

```json
{
  "path": "/path/to/file.go"
}
```

**响应**：`200 OK`（无响应体）

---

### 6.4 停止所有 LSP

```
POST /v1/workspaces/{id}/lsps/stop
```

停止工作区内所有 LSP 服务器。

**响应**：`200 OK`（无响应体）

---

## 7. 权限接口

### 7.1 获取跳过权限状态

```
GET /v1/workspaces/{id}/permissions/skip
```

**响应** `200 OK`（`proto.PermissionSkipRequest`）：

```json
{
  "skip": false
}
```

---

### 7.2 设置跳过权限

```
POST /v1/workspaces/{id}/permissions/skip
```

设置是否跳过所有权限确认（YOLO 模式开关）。

**请求体**（`proto.PermissionSkipRequest`）：

```json
{
  "skip": true
}
```

**响应**：`200 OK`（无响应体）

---

### 7.3 授权权限请求

```
POST /v1/workspaces/{id}/permissions/grant
```

响应 Agent 发起的权限请求（允许/拒绝）。

**请求体**（`proto.PermissionGrant`）：

```json
{
  "permission": {
    "id": "权限请求ID",
    "session_id": "会话ID",
    "tool_call_id": "工具调用ID",
    "tool_name": "bash",
    "description": "执行命令: rm -rf /tmp/cache",
    "action": "执行命令",
    "params": { "command": "rm -rf /tmp/cache" },
    "path": ""
  },
  "action": "allow"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `permission` | PermissionRequest | 是 | 权限请求详情（从 SSE 事件获取） |
| `action` | string | 是 | 授权动作：`allow`、`allow_session`、`deny` |

**`action` 取值说明**：

| 值 | 说明 |
|----|------|
| `allow` | 允许本次操作 |
| `allow_session` | 允许本次会话内所有同类操作 |
| `deny` | 拒绝操作 |

**响应** `200 OK`（`proto.PermissionGrantResponse`）：

```json
{
  "resolved": true
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `resolved` | bool | `true`=本次调用处理了该请求；`false`=请求已被其他客户端处理 |

---

## 8. 文件追踪接口

### 8.1 列出会话追踪文件

```
GET /v1/workspaces/{id}/sessions/{sid}/filetracker/files
```

返回指定会话中 Agent 读取过的文件列表。

**响应** `200 OK`：`string[]`（文件路径列表）

---

### 8.2 记录文件读取

```
POST /v1/workspaces/{id}/filetracker/read
```

记录一次文件读取事件。

**请求体**（`proto.FileTrackerReadRequest`）：

```json
{
  "session_id": "会话ID",
  "path": "/path/to/file.go"
}
```

**响应**：`200 OK`（无响应体）

---

### 8.3 获取最后读取时间

```
GET /v1/workspaces/{id}/filetracker/lastread?path={path}&session_id={sid}
```

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 文件路径 |
| `session_id` | string | 否 | 会话 ID（不传则查询工作区级别） |

**响应** `200 OK`：最后读取时间（时间戳）

---

## 9. 项目接口

### 9.1 检查项目是否需要初始化

```
GET /v1/workspaces/{id}/project/needs-init
```

**响应** `200 OK`（`proto.ProjectNeedsInitResponse`）：

```json
{
  "needs_init": true
}
```

---

### 9.2 标记项目已初始化

```
POST /v1/workspaces/{id}/project/init
```

**响应**：`200 OK`（无响应体）

---

### 9.3 获取项目初始化提示

```
GET /v1/workspaces/{id}/project/init-prompt
```

获取用于项目初始化的系统提示内容。

**响应** `200 OK`（`proto.ProjectInitPromptResponse`）：

```json
{
  "prompt": "初始化提示文本..."
}
```

---

## 10. Skills 接口

### 10.1 列出可见 Skills

```
GET /v1/workspaces/{id}/skills
```

**响应** `200 OK`（`proto.SkillInfo[]`）：

```json
[
  {
    "id": "skill-id",
    "name": "skill名称",
    "description": "技能描述",
    "label": "显示标签",
    "source": "builtin",
    "user_invocable": true
  }
]
```

---

### 10.2 读取 Skill 内容

```
POST /v1/workspaces/{id}/skills/read
```

**请求体**（`proto.ReadSkillRequest`）：

```json
{
  "skill_id": "skill-id"
}
```

**响应** `200 OK`（`proto.ReadSkillResponse`）：

```json
{
  "content": "base64编码的skill内容",
  "result": {
    "name": "skill名称",
    "description": "技能描述",
    "source": "builtin",
    "builtin": true
  }
}
```

---

## 11. MCP 接口

### 11.1 获取 MCP 客户端状态

```
GET /v1/workspaces/{id}/mcp/states
```

**响应** `200 OK`（`map[string]MCPClientInfo`）：

```json
{
  "filesystem": {
    "name": "filesystem",
    "state": "connected",
    "error": "",
    "tool_count": 5,
    "prompt_count": 2,
    "resource_count": 10,
    "connected_at": "2025-07-26T10:00:00Z"
  }
}
```

MCP `state` 取值：`disabled`、`starting`、`connected`、`error`

---

### 11.2 刷新 MCP 工具

```
POST /v1/workspaces/{id}/mcp/refresh-tools
```

**请求体**（`proto.MCPNameRequest`）：

```json
{
  "name": "filesystem"
}
```

**响应**：`200 OK`（无响应体）

---

### 11.3 刷新 MCP Prompts

```
POST /v1/workspaces/{id}/mcp/refresh-prompts
```

**请求体**：同 11.2

**响应**：`200 OK`（无响应体）

---

### 11.4 刷新 MCP Resources

```
POST /v1/workspaces/{id}/mcp/refresh-resources
```

**请求体**：同 11.2

**响应**：`200 OK`（无响应体）

---

### 11.5 读取 MCP 资源

```
POST /v1/workspaces/{id}/mcp/read-resource
```

**请求体**（`proto.MCPReadResourceRequest`）：

```json
{
  "name": "filesystem",
  "uri": "file:///path/to/resource"
}
```

**响应** `200 OK`：资源内容对象

---

### 11.6 获取 MCP Prompt

```
POST /v1/workspaces/{id}/mcp/get-prompt
```

**请求体**（`proto.MCPGetPromptRequest`）：

```json
{
  "client_id": "MCP客户端ID",
  "prompt_id": "prompt标识",
  "args": {
    "key": "value"
  }
}
```

**响应** `200 OK`（`proto.MCPGetPromptResponse`）：

```json
{
  "prompt": "prompt文本内容"
}
```

---

### 11.7 启用 Docker MCP

```
POST /v1/workspaces/{id}/mcp/docker/enable
```

启用 Docker MCP 服务器。

**响应**：`200 OK`（无响应体）

---

### 11.8 禁用 Docker MCP

```
POST /v1/workspaces/{id}/mcp/docker/disable
```

禁用 Docker MCP 服务器。

**响应**：`200 OK`（无响应体）

---

## 附录 A：数据结构定义

### Workspace 结构

```typescript
interface Workspace {
  id: string;                    // 工作区 ID
  path: string;                  // 工作目录路径
  yolo?: boolean;                // 跳过权限确认
  debug?: boolean;               // 调试模式
  data_dir?: string;             // 数据目录
  version?: string;              // 版本号
  client_id?: string;            // 创建者客户端 ID
  config?: object;               // 配置对象
  env?: string[];                // 环境变量
  skills?: SkillState[];         // Skill 快照
}
```

### Session 结构

```typescript
interface Session {
  id: string;
  parent_session_id: string;
  title: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  context_tokens: number;
  summary_message_id: string;
  cost: number;
  todos?: Todo[];
  created_at: number;            // Unix 时间戳
  updated_at: number;
  is_busy: boolean;              // 是否有运行中的 Agent
  attached_clients: number;      // 当前查看此会话的客户端数
}

interface Todo {
  content: string;
  status: string;                // pending | in_progress | completed | cancelled
  active_form: string;
}
```

### <a id="message-结构"></a>Message 结构

```typescript
interface Message {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  session_id: string;
  parts: ContentPart[];
  model: string;
  provider: string;
  created_at: number;
  updated_at: number;
}

// ContentPart 是联合类型，通过 type 字段区分
type ContentPart =
  | { type: "text"; data: { text: string } }
  | { type: "reasoning"; data: { thinking: string; signature: string; started_at?: number; finished_at?: number } }
  | { type: "image_url"; data: { url: string; detail?: string } }
  | { type: "binary"; data: { path: string; mime_type: string; data: string } }
  | { type: "tool_call"; data: { id: string; name: string; input: string; type?: string; finished?: boolean } }
  | { type: "tool_result"; data: { tool_call_id: string; name: string; content: string; data?: string; mime_type?: string; metadata: string; is_error: boolean } }
  | { type: "finish"; data: { reason: string; time: number; message?: string; details?: string } }
  | { type: "shell_command"; data: { command: string; output: string; exit_code: number } };
```

**FinishReason 取值**：`end_turn`、`max_tokens`、`tool_use`、`canceled`、`error`、`unknown`

### PermissionRequest 结构

```typescript
interface PermissionRequest {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;             // bash | edit | write | multiedit | download | fetch | view | ls
  description: string;
  action: string;
  params: any;                   // 根据工具名反序列化为具体类型
  path: string;
}
```

### MCPClientInfo 结构

```typescript
interface MCPClientInfo {
  name: string;
  state: "disabled" | "starting" | "connected" | "error";
  error?: string;
  tool_count?: number;
  prompt_count?: number;
  resource_count?: number;
  connected_at: string;          // ISO 8601 时间
}
```

### LSPClientInfo 结构

```typescript
interface LSPClientInfo {
  name: string;
  state: "disabled" | "starting" | "connected" | "error";
  error?: string;
  diagnostic_count?: number;
  connected_at: string;          // ISO 8601 时间
}
```

### AgentInfo 结构

```typescript
interface AgentInfo {
  is_busy: boolean;
  is_ready: boolean;
  model: ModelInfo;
  model_cfg: SelectedModel;
}

interface ModelInfo {
  id: string;
  name?: string;
  context_window?: number;
  default_max_tokens?: number;
  max_output_tokens?: number;
  default_reasoning_effort?: string;
  reasoning_levels?: string[];
  supports_images?: boolean;
  can_reason?: boolean;
  cost_per_1m_in?: number;
  cost_per_1m_out?: number;
}

interface SelectedModel {
  model: string;
  provider: string;
  reasoning_effort?: string;     // low | medium | high
  think?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  provider_options?: Record<string, any>;
}
```

### Config Scope 枚举

```typescript
enum Scope {
  Global = 0,      // ~/.local/share/admAgent/admAgent.json
  Workspace = 1,   // .admAgent/admAgent.json
}
```

---

## 附录 B：GUI 开发建议

### B.1 客户端标识 (client_id)

以下接口**必须**提供 `client_id` 查询参数（UUID 格式）：

- `DELETE /v1/workspaces/{id}`
- `POST /v1/workspaces/{id}/current-session`
- `GET /v1/workspaces/{id}/events`

GUI 启动时应生成一个全局唯一的 `client_id` 并在整个生命周期中复用。

### B.2 典型 GUI 工作流

```
1. GET  /v1/health                         → 检查 server 是否在线
2. GET  /v1/version                        → 获取版本信息
3. POST /v1/workspaces                     → 创建/连接工作区
4. POST /v1/workspaces/{id}/agent/init     → 初始化 Agent
5. GET  /v1/workspaces/{id}/project/needs-init → 检查是否需要项目初始化
6. POST /v1/workspaces/{id}/sessions       → 创建会话
7. GET  /v1/workspaces/{id}/events         → 建立 SSE 连接（保持长连接）
8. POST /v1/workspaces/{id}/agent          → 发送用户消息
9.    [SSE] message 事件                   → 增量渲染 Agent 输出
10.   [SSE] permission_request 事件         → 弹出权限确认对话框
11. POST /v1/workspaces/{id}/permissions/grant → 用户授权/拒绝
12.   [SSE] run_complete 事件               → 标记本轮对话结束
```

### B.3 SSE 事件处理要点

1. **先订阅再发消息**：建立 SSE 连接后再发送 Agent 消息，避免遗漏事件。
2. **断线重连**：SSE 连接断开后需自动重连，重连后重新获取会话状态（`GET /sessions/{sid}/messages`）以补全可能缺失的消息。
3. **多客户端同步**：多个 GUI 客户端可同时连接同一工作区，通过 SSE 事件保持状态同步。`attached_clients` 字段反映当前查看某会话的客户端数量。
4. **RunComplete 关联**：使用 `run_id` 精确关联请求与完成事件，特别是在会话繁忙时排队多个请求的场景。

### B.4 权限处理流程

```
[SSE] permission_request 事件到达
  → GUI 弹出确认对话框，显示 tool_name、description、params
  → 用户选择：允许 / 允许本次会话 / 拒绝
  → POST /v1/workspaces/{id}/permissions/grant
  → [SSE] permission_notification 事件确认处理结果
```

### B.5 API 端点汇总表

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 1 | GET | `/v1/health` | 健康检查 |
| 2 | GET | `/v1/version` | 版本信息 |
| 3 | GET | `/v1/config` | 全局配置 |
| 4 | POST | `/v1/control` | 控制命令 |
| 5 | GET | `/v1/workspaces` | 列出工作区 |
| 6 | POST | `/v1/workspaces` | 创建工作区 |
| 7 | DELETE | `/v1/workspaces/{id}` | 删除工作区 |
| 8 | GET | `/v1/workspaces/{id}` | 获取工作区 |
| 9 | POST | `/v1/workspaces/{id}/current-session` | 设置当前会话 |
| 10 | GET | `/v1/workspaces/{id}/config` | 工作区配置 |
| 11 | GET | `/v1/workspaces/{id}/providers` | 可用 Providers |
| 12 | GET | `/v1/workspaces/{id}/events` | SSE 事件流 |
| 13 | GET | `/v1/workspaces/{id}/messages/user` | 所有用户消息 |
| 14 | GET | `/v1/workspaces/{id}/sessions` | 列出会话 |
| 15 | POST | `/v1/workspaces/{id}/sessions` | 创建会话 |
| 16 | GET | `/v1/workspaces/{id}/sessions/{sid}` | 获取会话 |
| 17 | PUT | `/v1/workspaces/{id}/sessions/{sid}` | 更新会话 |
| 18 | DELETE | `/v1/workspaces/{id}/sessions/{sid}` | 删除会话 |
| 19 | GET | `/v1/workspaces/{id}/sessions/{sid}/history` | 历史文件 |
| 20 | GET | `/v1/workspaces/{id}/sessions/{sid}/messages` | 会话消息 |
| 21 | GET | `/v1/workspaces/{id}/sessions/{sid}/messages/user` | 用户消息 |
| 22 | GET | `/v1/workspaces/{id}/sessions/{sid}/filetracker/files` | 追踪文件 |
| 23 | POST | `/v1/workspaces/{id}/filetracker/read` | 记录文件读取 |
| 24 | GET | `/v1/workspaces/{id}/filetracker/lastread` | 最后读取时间 |
| 25 | GET | `/v1/workspaces/{id}/lsps` | LSP 客户端列表 |
| 26 | GET | `/v1/workspaces/{id}/lsps/{lsp}/diagnostics` | LSP 诊断 |
| 27 | POST | `/v1/workspaces/{id}/lsps/start` | 启动 LSP |
| 28 | POST | `/v1/workspaces/{id}/lsps/stop` | 停止所有 LSP |
| 29 | GET | `/v1/workspaces/{id}/permissions/skip` | 获取跳过权限状态 |
| 30 | POST | `/v1/workspaces/{id}/permissions/skip` | 设置跳过权限 |
| 31 | POST | `/v1/workspaces/{id}/permissions/grant` | 授权权限请求 |
| 32 | GET | `/v1/workspaces/{id}/agent` | Agent 信息 |
| 33 | POST | `/v1/workspaces/{id}/agent` | 发送消息给 Agent |
| 34 | POST | `/v1/workspaces/{id}/agent/init` | 初始化 Agent |
| 35 | POST | `/v1/workspaces/{id}/agent/update` | 更新 Agent |
| 36 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}` | Agent 会话信息 |
| 37 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/cancel` | 取消会话 |
| 38 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/queued` | 排队状态 |
| 39 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/list` | 排队列表 |
| 40 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/clear` | 清除排队 |
| 41 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/summarize` | 摘要会话 |
| 42 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/undo` | 撤销上一轮 |
| 43 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/shell` | 执行 Shell |
| 44 | POST | `/v1/workspaces/{id}/config/set` | 设置配置字段 |
| 45 | POST | `/v1/workspaces/{id}/config/remove` | 移除配置字段 |
| 46 | POST | `/v1/workspaces/{id}/config/model` | 设置模型 |
| 47 | POST | `/v1/workspaces/{id}/config/compact` | 设置 Compact 模式 |
| 48 | POST | `/v1/workspaces/{id}/config/provider-key` | 设置 API Key |
| 49 | GET | `/v1/workspaces/{id}/project/needs-init` | 检查项目初始化 |
| 50 | POST | `/v1/workspaces/{id}/project/init` | 标记已初始化 |
| 51 | GET | `/v1/workspaces/{id}/project/init-prompt` | 初始化提示 |
| 52 | GET | `/v1/workspaces/{id}/skills` | Skills 列表 |
| 53 | POST | `/v1/workspaces/{id}/skills/read` | 读取 Skill |
| 54 | POST | `/v1/workspaces/{id}/mcp/refresh-tools` | 刷新 MCP 工具 |
| 55 | POST | `/v1/workspaces/{id}/mcp/read-resource` | 读取 MCP 资源 |
| 56 | POST | `/v1/workspaces/{id}/mcp/get-prompt` | 获取 MCP Prompt |
| 57 | GET | `/v1/workspaces/{id}/mcp/states` | MCP 状态 |
| 58 | POST | `/v1/workspaces/{id}/mcp/refresh-prompts` | 刷新 MCP Prompts |
| 59 | POST | `/v1/workspaces/{id}/mcp/refresh-resources` | 刷新 MCP Resources |
| 60 | POST | `/v1/workspaces/{id}/mcp/docker/enable` | 启用 Docker MCP |
| 61 | POST | `/v1/workspaces/{id}/mcp/docker/disable` | 禁用 Docker MCP |
| 62 | GET | `/v1/docs/` | Swagger 文档 |
