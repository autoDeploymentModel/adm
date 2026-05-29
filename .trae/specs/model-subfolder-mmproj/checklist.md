# Checklist

- [x] RemoteModel 结构体包含 model_mmproj: Option<String> 字段，serde 能正确解析带该字段的 JSON
- [x] download_model 创建 models/{model_id}/ 子文件夹并下载主模型到子文件夹内
- [x] download_model 当 support_images=true 且 model_mmproj 有值时，额外下载 mmproj 文件到同一子文件夹
- [x] mmproj 文件下载使用原始文件名（从 URL 中提取），支持断点续传
- [x] download_model 下载完成事件正确触发，前端能正确收到 download-complete
- [x] scan_local_models 能扫描到子文件夹中的 .gguf 文件，同时兼容根目录旧格式
- [x] scan_part_files 能扫描到子文件夹中的 .gguf.part 文件，同时兼容根目录旧格式
- [x] start_model 能从子文件夹路径加载模型文件，同时兼容根目录旧格式路径
- [x] start_model 当 support_images=true 且本地存在 mmproj 文件时，启动参数包含 --mmproj
- [x] start_model 当 support_images=false 时，启动参数不包含 --mmproj
- [x] 前端 download_model 调用正确传递 supportImages 和 modelMmproj 参数
- [x] 前端 start_model 调用正确传递 supportImages 参数
- [x] 项目能通过 pnpm tauri build 构建成功
