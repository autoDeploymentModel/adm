# Tasks

- [x] Task 1: 修改 RemoteModel 数据结构 - 在 types.rs 中为 RemoteModel 添加 model_mmproj 可选字段
  - [x] SubTask 1.1: 在 RemoteModel 结构体中新增 `model_mmproj: Option<String>` 字段，使用 `#[serde(default)]` 标注
  - [x] SubTask 1.2: 验证 serde 反序列化能正确解析包含 model_mmproj 的远程 JSON

- [x] Task 2: 修改 download_model 下载逻辑 - 支持子文件夹存储和 mmproj 文件下载
  - [x] SubTask 2.1: 修改 download_model 函数签名，新增 `support_images: bool` 和 `model_mmproj: Option<String>` 参数
  - [x] SubTask 2.2: 修改存储路径逻辑：创建 `models/{model_id}/` 子文件夹，主模型下载到 `models/{model_id}/{model_id}.gguf`，part 文件为 `models/{model_id}/{model_id}.gguf.part`
  - [x] SubTask 2.3: 当 `support_images` 为 true 且 `model_mmproj` 有值时，在主模型下载完成后，额外下载 mmproj 文件到同一子文件夹（保留原始文件名）
  - [x] SubTask 2.4: mmproj 文件下载复用现有的镜像替换、断点续传、进度事件逻辑

- [x] Task 3: 修改 scan_local_models 和 scan_part_files - 适配子文件夹扫描
  - [x] SubTask 3.1: 修改 scan_local_models，递归遍历 `models/` 下的子文件夹查找 `.gguf` 文件，同时兼容根目录下的旧格式文件
  - [x] SubTask 3.2: 修改 scan_part_files，递归遍历子文件夹查找 `.gguf.part` 文件，同时兼容根目录下的旧格式文件

- [x] Task 4: 修改 start_model 启动逻辑 - 支持 mmproj 参数
  - [x] SubTask 4.1: 修改 start_model 函数签名，新增 `support_images: bool` 参数
  - [x] SubTask 4.2: 修改模型文件路径为 `models/{model_id}/{model_id}.gguf`，同时兼容根目录下的旧格式路径
  - [x] SubTask 4.3: 当 `support_images` 为 true 时，扫描模型子文件夹下的 mmproj 文件（匹配 mmproj*.gguf 模式），若存在则添加 `--mmproj {path}` 到启动参数

- [x] Task 5: 修改前端 model_list.html - 适配新参数传递
  - [x] SubTask 5.1: 修改 handleDownload 函数，传递 `supportImages` 和 `modelMmproj` 参数给 download_model 命令
  - [x] SubTask 5.2: 修改 handleStart 函数，传递 `supportImages` 参数给 start_model 命令
  - [x] SubTask 5.3: 下载按钮的 data 属性新增 model_mmproj 和 support_images 信息

# Task Dependencies
- Task 2 依赖 Task 1（需要 RemoteModel 包含 model_mmproj 字段）
- Task 3 与 Task 2 无强依赖，可并行
- Task 4 依赖 Task 2（子文件夹结构确定后才能修改启动路径）
- Task 5 依赖 Task 1、Task 2、Task 4（前端需要感知新参数）
