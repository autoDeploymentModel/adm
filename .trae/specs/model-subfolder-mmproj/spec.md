# 模型子文件夹存储与多模态投影器支持 Spec

## Why

当前模型下载后所有 `.gguf` 文件平铺在 `models/` 目录下，无法区分主模型与关联文件（如 mmproj 多模态投影器）。此外，对于 `support_images` 为 true 的模型，需要额外下载 mmproj 文件并在启动时传入 `--mmproj` 参数，才能真正启用图片识别能力。

## What Changes

* 模型下载目录从 `models/{model_id}.gguf` 改为 `models/{model_id}/{model_id}.gguf`，每个模型拥有独立子文件夹

* `RemoteModel` 结构体新增 `model_mmproj` 字段（`Option<String>`），用于接收远程 JSON 中的 mmproj 下载 URL

* `download_model` 命令新增参数 `support_images` 和 `model_mmproj`，当 `support_images` 为 true 且 `model_mmproj` 有值时，额外下载 mmproj 文件到同一子文件夹

* `start_model` 命令新增参数 `support_images`，启动时自动检测模型子文件夹下的 mmproj 文件，若存在则添加 `--mmproj` 参数

* `scan_local_models` 扫描逻辑改为遍历子文件夹查找 `.gguf` 文件

* `scan_part_files` 扫描逻辑适配子文件夹结构

* 前端 `download_model` 调用新增 `supportImages` 和 `modelMmproj` 参数传递

* 前端 `start_model` 调用新增 `supportImages` 参数传递

## Impact

# Affected specs: 模型管理、模型下载、模型启动

* Affected code:

  * `src-tauri/src/common/types.rs` - RemoteModel 结构体新增字段

  * `src-tauri/src/pages/model_list.rs` - download\_model / start\_model / scan\_local\_models / scan\_part\_files 逻辑修改

  * `src/model_list.html` - 前端调用参数适配

## MODIFIED Requirements

## Requirement: 模型文件存储结构

系统 SHALL 将每个模型的所有关联文件下载到 `models/{model_id}/` 子文件夹中，主模型文件命名为 `{model_id}.gguf`，mmproj 文件保留原始文件名（如 `mmproj-BF16.gguf`）。

#### Scenario: 下载普通模型

* **WHEN** 用户下载 `support_images` 为 false 的模型

* **THEN** 系统创建 `models/{model_id}/` 文件夹，下载主模型到 `models/{model_id}/{model_id}.gguf`

#### Scenario: 下载多模态模型

* **WHEN** 用户下载 `support_images` 为 true 且 `model_mmproj` 有值的模型

* **THEN** 系统创建 `models/{model_id}/` 文件夹，依次下载主模型和 mmproj 文件到该文件夹

### Requirement: 本地模型扫描

系统 SHALL 递归扫描 `models/` 下各子文件夹中的 `.gguf` 文件，返回模型 ID 列表。

### Requirement: 断点续传文件扫描

系统 SHALL 递归扫描 `models/` 下各子文件夹中的 `.gguf.part` 文件，返回已下载大小。

### Requirement: 模型启动多模态支持

系统 SHALL 在启动模型时检查模型子文件夹下是否存在 mmproj 文件，若存在则自动添加 `--mmproj {mmproj_path}` 参数。

#### Scenario: 启动带 mmproj 的模型

* **WHEN** 用户启动 `support_images` 为 true 的模型且本地存在 mmproj 文件

* **THEN** llama-server 启动参数包含 `--mmproj` 指向本地 mmproj 文件路径

#### Scenario: 启动无 mmproj 的模型

* **WHEN** 用户启动 `support_images` 为 false 的模型

* **THEN** llama-server 启动参数不包含 `--mmproj`

### Requirement: RemoteModel 数据结构

`RemoteModel` 结构体 SHALL 包含可选的 `model_mmproj` 字段，用于接收远程 JSON 中的 mmproj 下载 URL。

### Requirement: 下载命令参数扩展

`download_model` Tauri 命令 SHALL 接收 `support_images` 和 `model_mmproj` 参数，用于决定是否额外下载 mmproj 文件。

### Requirement: 启动命令参数扩展

`start_model` Tauri 命令 SHALL 接收 `support_images` 参数，用于决定是否在启动时查找并传入 mmproj 文件。

## REMOVED Requirements

### Requirement: 旧的平铺存储结构

**Reason**: 所有模型文件平铺在同一目录下无法区分主模型和关联文件
**Migration**: 已下载的模型文件仍在 `models/` 根目录，新下载的模型使用子文件夹结构。scan\_local\_models 同时扫描根目录和子文件夹以保持兼容。
