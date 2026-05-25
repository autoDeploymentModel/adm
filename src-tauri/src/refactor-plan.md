# lib.rs 模块拆分开发文档（按前端页面划分）

## 一、前端页面结构分析

当前项目采用 **单窗口 + iframe 多页面** 架构，共有 4 个 HTML 页面：

| 页面 | 文件 | 功能描述 | 调用的 Tauri Command |
|------|------|----------|---------------------|
| **主框架** | `index.html` | 应用主窗口，含底部硬件信息栏、全局更新弹窗、事件转发 | `get_system_info`, `check_update`, `download_and_extract_llamacpp`, `plugin:hwinfo\|*` |
| **模型列表** | `model_list.html` | 模型管理核心页面，扫描/下载/启动/停止模型 | `scan_local_models`, `scan_part_files`, `fetch_model_list`, `download_model`, `start_model`, `stop_model`, `get_model_status`, `load_settings` |
| **模型交互** | `model_chat.html` | 模型运行时的交互界面，轮询检测服务、显示聊天页面、日志面板 | `listen` 事件监听（model-log, model-started, model-stopped, model-error） |
| **设置** | `settings.html` | 启动参数配置、版本信息、关于页面 | `save_settings`, `load_settings`, `get_app_version`, `get_llamacpp_version`, `check_update` |

---

## 二、推荐目录结构

```
src-tauri/src/
├── lib.rs                  # 入口文件（仅保留 tauri::Builder 配置）
│
├── main.rs                 # 可选：Windows 平台隐藏控制台入口
│
├── app_state.rs            # 全局状态管理（AppState + 状态访问方法）
│
├── pages/                  # 按页面划分的业务模块
│   ├── mod.rs              # 模块声明
│   │
│   ├── index.rs            # index.html 对应逻辑（硬件信息、全局更新）
│   │   ├── get_system_info()
│   │   ├── check_update()
│   │   ├── download_and_extract_llamacpp()
│   │   └── 自动更新相关辅助函数
│   │
│   ├── model_list.rs       # model_list.html 对应逻辑（模型管理）
│   │   ├── scan_local_models()
│   │   ├── scan_part_files()
│   │   ├── fetch_model_list()
│   │   ├── download_model()
│   │   ├── start_model()
│   │   ├── stop_model()
│   │   ├── get_model_status()
│   │   └── 模型启动/停止相关辅助函数
│   │
│   ├── model_chat.rs       # model_chat.html 对应逻辑（模型交互）
│   │   └（主要依赖 model_list.rs 的 start/stop，无独立 command）
│   │
│   └── settings.rs         # settings.html 对应逻辑（配置管理）
│       ├── save_settings()
│       ├── load_settings()
│       ├── get_app_version()
│       └── get_llamacpp_version()
│
├── common/                 # 公共模块（所有页面共享）
│   ├── mod.rs
│   │
│   ├── types.rs            # 公共数据结构定义
│   │   ├── AppState
│   │   ├── SystemInfo
│   │   ├── ModelStatus
│   │   ├── LaunchParams
│   │   ├── RemoteModel
│   │   ├── Settings
│   │   ├── UpdateInfo / UpdateCheckResult
│   │   ├── PartFileProgress
│   │   └── HardwareDetectResult
│   │
│   ├── config.rs           # 路径管理 + 配置文件读写
│   │   ├── get_resource_dir()
│   │   ├── get_exe_dir()
│   │   ├── get_data_dir()
│   │   ├── get_base_dir()
│   │   ├── get_llamacpp_dir()
│   │   ├── get_llama_server_path()
│   │   └ find_llama_server_in_dir()
│   │
│   └── utils/
│       ├── mod.rs
│       ├── platform.rs     # 跨平台工具函数
│       │   ├── create_hidden_command()
│       │   └ get_gpu_info()
│       │
│       └── archive.rs      # 压缩包解压
│           ├── extract_zip()
│           └ extract_tar_gz()
```

---

## 三、各模块详细说明

### 3.1 `lib.rs` — 入口文件（精简后，约 30 行）

**职责**：仅保留 `tauri::Builder` 配置，声明模块、注册 command

```rust
mod app_state;
mod common;
mod pages;

use app_state::AppState;
use pages::{index, model_list, model_chat, settings};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_hwinfo::init())
        .manage(AppState::new())
        .on_window_event(|window, event| {
            // 窗口关闭时清理进程
        })
        .invoke_handler(tauri::generate_handler![
            // index.rs
            index::get_system_info,
            index::check_update,
            index::download_and_extract_llamacpp,
            // model_list.rs
            model_list::scan_local_models,
            model_list::scan_part_files,
            model_list::fetch_model_list,
            model_list::download_model,
            model_list::start_model,
            model_list::stop_model,
            model_list::get_model_status,
            // settings.rs
            settings::save_settings,
            settings::load_settings,
            settings::get_app_version,
            settings::get_llamacpp_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### 3.2 `app_state.rs` — 全局状态管理（约 50 行）

**职责**：定义 `AppState` 结构体，提供安全的状态访问方法

```rust
use std::sync::Mutex;
use sysinfo::System;

pub struct AppState {
    pub running_process: Mutex<Option<u32>>,
    pub running_model_id: Mutex<Option<String>>,
    pub running_port: Mutex<Option<u16>>,
    pub sys: Mutex<System>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_process: Mutex::new(None),
            running_model_id: Mutex::new(None),
            running_port: Mutex::new(None),
            sys: Mutex::new(System::new_all()),
        }
    }

    pub fn get_running_pid(&self) -> Option<u32> {
        self.running_process.lock().unwrap().clone()
    }

    pub fn set_running_pid(&self, pid: u32) {
        *self.running_process.lock().unwrap() = Some(pid);
    }

    pub fn clear_running(&self) {
        *self.running_process.lock().unwrap() = None;
        *self.running_model_id.lock().unwrap() = None;
        *self.running_port.lock().unwrap() = None;
    }
}
```

---

### 3.3 `common/types.rs` — 公共数据结构（约 100 行）

**职责**：定义所有 `#[derive(Serialize, Deserialize)]` 的结构体

| 结构体 | 说明 | 所属页面 |
|--------|------|---------|
| `SystemInfo` | 系统信息返回值 | index |
| `ModelStatus` | 模型运行状态 | model_list |
| `LaunchParams` | 模型启动参数 | settings / model_list |
| `RemoteModel` | 远程模型信息 | model_list |
| `Settings` | 用户配置 | settings |
| `PartFileProgress` | 分片下载进度 | model_list |
| `UpdateInfo` / `UpdateCheckResult` | 更新信息 | index |
| `HardwareDetectResult` | 硬件检测结果 | index |

---

### 3.4 `common/config.rs` — 路径管理（约 100 行）

**职责**：所有目录路径获取、配置文件读写

| 函数 | 说明 |
|------|------|
| `get_resource_dir()` | 获取资源目录 |
| `get_exe_dir()` | 获取可执行文件目录 |
| `get_data_dir()` | 获取数据目录 |
| `get_base_dir()` | 获取基础目录（查找 llamacpp） |
| `get_llamacpp_dir()` | 获取 llamacpp 目录 |
| `get_llama_server_path()` | 查找 llama-server 路径 |
| `find_llama_server_in_dir()` | 在目录中递归查找 |

---

### 3.5 `common/utils/platform.rs` — 平台工具（约 50 行）

**职责**：跨平台命令封装

| 函数 | 说明 |
|------|------|
| `create_hidden_command()` | 创建隐藏控制台窗口的进程 |
| `get_gpu_info()` | 获取 GPU 显存信息（跨平台） |

---

### 3.6 `common/utils/archive.rs` — 压缩包解压（约 80 行）

**职责**：ZIP 和 TAR.GZ 解压

| 函数 | 说明 |
|------|------|
| `extract_zip()` | 解压 ZIP 文件 |
| `extract_tar_gz()` | 解压 TAR.GZ 文件 |

---

### 3.7 `pages/index.rs` — 主框架页面逻辑（约 200 行）

**对应前端**：`index.html`

**职责**：硬件信息获取、全局自动更新

| Command | 说明 | 依赖 |
|---------|------|------|
| `get_system_info()` | 获取 RAM/VRAM/CPU 信息 | `common/utils/platform.rs` |
| `check_update()` | 检查应用和 llamacpp 更新 | `common/types.rs`, `common/config.rs` |
| `download_and_extract_llamacpp()` | 下载并解压 llamacpp | `common/config.rs`, `common/utils/archive.rs` |

**辅助函数**：
- `compare_versions()` — 版本号比较
- `get_llamacpp_download_url()` — 根据硬件获取下载 URL
- `detect_hardware_for_llamacpp()` — 硬件检测

---

### 3.8 `pages/model_list.rs` — 模型列表页面逻辑（约 350 行）

**对应前端**：`model_list.html`

**职责**：模型扫描、下载、启动、停止、状态查询

| Command | 说明 | 依赖 |
|---------|------|------|
| `scan_local_models()` | 扫描本地已下载的 GGUF 模型 | `common/config.rs` |
| `scan_part_files()` | 扫描未完成的 .part 下载文件 | `common/config.rs` |
| `fetch_model_list()` | 获取远程模型列表 | 无（独立 HTTP） |
| `download_model()` | 下载模型（断点续传、进度上报） | `common/config.rs` |
| `start_model()` | 启动模型 | `AppState`, `common/config.rs` |
| `stop_model()` | 停止模型 | `AppState` |
| `get_model_status()` | 获取模型运行状态 | `AppState` |

**关键逻辑**：
- 启动前检查是否已有模型运行
- 启动后记录 PID/ModelID/Port 到 AppState
- 停止时发送 SIGKILL/TASKKILL
- 下载支持断点续传和进度事件上报

---

### 3.9 `pages/model_chat.rs` — 模型交互页面逻辑（约 30 行）

**对应前端**：`model_chat.html`

**职责**：此页面**没有独立的 Tauri Command**，主要功能：
- 通过 URL 参数接收 `model_id` 和 `port`
- 轮询检测模型服务是否就绪
- 加载 iframe 显示模型提供的 WebUI
- 监听 Tauri 事件（model-log, model-started, model-stopped, model-error）

**实现方式**：
```rust
// model_chat.rs 仅需导出页面初始化相关的辅助函数（如有）
// 大部分逻辑在前端 JS 中完成
```

---

### 3.10 `pages/settings.rs` — 设置页面逻辑（约 150 行）

**对应前端**：`settings.html`

**职责**：配置保存/加载、版本查询

| Command | 说明 | 依赖 |
|---------|------|------|
| `save_settings()` | 保存启动参数配置 | `common/config.rs` |
| `load_settings()` | 加载启动参数配置 | `common/config.rs` |
| `get_app_version()` | 获取应用版本 | 无 |
| `get_llamacpp_version()` | 获取 llama-server 版本 | `common/config.rs`, `common/utils/platform.rs` |

---

## 四、模块依赖关系图

```
                        ┌──────────┐
                        │ lib.rs   │ (入口 + 注册)
                        └────┬─────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
    │ app_state   │   │  common/    │   │   pages/    │
    │             │   │             │   │             │
    └─────────────┘   │ types.rs    │   │ index.rs    │
                      │ config.rs   │   │ model_list  │
                      │ utils/      │   │ model_chat  │
                      └─────────────┘   │ settings    │
                             ▲          └─────────────┘
                             │
              ┌──────────────┴──────────────┐
              │ 所有 pages 模块依赖 common   │
              │ 所有 pages 模块依赖 app_state│
              └─────────────────────────────┘
```

**依赖规则**：
- `common/*` 和 `app_state.rs` 不依赖 `pages/*`（无循环依赖）
- `pages/*` 可以互相调用辅助函数（如有需要）
- `lib.rs` 依赖所有模块

---

## 五、公共依赖声明

所有模块共享以下依赖（`Cargo.toml` 中已存在）：

```toml
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
sysinfo = "0.30"
reqwest = { version = "0.11", features = ["json", "stream"] }
tokio = { version = "1", features = ["full"] }
futures-util = "0.3"
zip = "0.6"
tar = "0.4"
flate2 = "1.0"
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-hwinfo = "0.2"
```

---

## 六、拆分实施步骤

### 第一阶段：创建骨架（低风险，约 30 分钟）
1. 创建 `common/types.rs`，移动所有结构体定义
2. 创建 `app_state.rs`，移动 `AppState` 和 `Default` 实现
3. 创建 `common/config.rs`，移动目录管理函数
4. 创建 `common/utils/platform.rs` 和 `common/utils/archive.rs`
5. 创建 `pages/mod.rs`、`pages/index.rs`、`pages/model_list.rs`、`pages/model_chat.rs`、`pages/settings.rs`
6. 在 `lib.rs` 中添加 `mod` 声明
7. 确保编译通过

### 第二阶段：迁移业务逻辑（中风险，约 2 小时）
1. 将 `lib.rs` 中 `get_system_info`、`check_update`、`download_and_extract_llamacpp` 迁移到 `pages/index.rs`
2. 将 `scan_local_models`、`scan_part_files`、`fetch_model_list`、`download_model`、`start_model`、`stop_model`、`get_model_status` 迁移到 `pages/model_list.rs`
3. 将 `save_settings`、`load_settings`、`get_app_version`、`get_llamacpp_version` 迁移到 `pages/settings.rs`
4. 更新各模块的 `use` 导入路径
5. 确保编译通过

### 第三阶段：精简入口文件（低风险，约 15 分钟）
1. 删除 `lib.rs` 中已迁移的代码
2. 仅保留 `mod` 声明和 `tauri::Builder` 配置
3. 确保编译通过

### 第四阶段：验证（约 30 分钟）
1. 运行 `pnpm tauri dev` 验证功能
2. 手动测试核心功能：
   - [ ] 底部硬件信息栏正常显示
   - [ ] 模型列表页面正常加载
   - [ ] 模型下载功能正常
   - [ ] 模型启动/停止功能正常
   - [ ] 设置页面保存/加载正常
   - [ ] 自动更新检查正常
3. 运行 `pnpm tauri build` 验证构建

---

## 七、代码量预估

| 模块 | 预估行数 |
|------|---------|
| `lib.rs` | ~30 |
| `app_state.rs` | ~50 |
| `common/types.rs` | ~100 |
| `common/config.rs` | ~100 |
| `common/utils/platform.rs` | ~50 |
| `common/utils/archive.rs` | ~80 |
| `pages/mod.rs` | ~5 |
| `pages/index.rs` | ~200 |
| `pages/model_list.rs` | ~350 |
| `pages/model_chat.rs` | ~30 |
| `pages/settings.rs` | ~150 |
| **总计** | **~1145** |

代码总量略有减少（去除了部分冗余代码），结构更清晰。

---

## 八、注意事项

### 8.1 模块间通信
- `pages/model_list.rs` 的 `start_model` 启动模型后，通过 `app.emit("model-started", ...)` 发送事件
- `pages/model_chat.rs` 的前端通过 `listen` 接收事件
- 后端无需跨模块调用，通过 Tauri 事件解耦

### 8.2 AppState 注入
- 所有需要访问运行状态的 command 通过 `state: tauri::State<'_, AppState>` 注入
- `app_state.rs` 提供 `new()` 在 `lib.rs` 中初始化

### 8.3 跨模块辅助函数
- 如 `pages/model_list.rs` 需要调用 `pages/index.rs` 的某个辅助函数，可考虑：
  - 方案 A：将函数移到 `common/` 中（推荐）
  - 方案 B：在 `pages/mod.rs` 中重新导出

### 8.4 平台条件编译
- `#[cfg(target_os = "windows")]` 等条件编译在各模块中保持一致
- 平台特定代码集中在 `common/utils/platform.rs`

---

## 九、后续优化建议

1. **错误处理统一化**：定义 `common/error.rs`，统一 `AppError` 枚举
2. **日志系统**：引入 `tracing` 替代 `println!`
3. **测试覆盖**：为各模块添加 `#[cfg(test)]` 单元测试
4. **配置持久化**：考虑使用 `dirs` crate 替代手动路径查找
5. **异步优化**：评估 `tokio::task::spawn_blocking` 处理 CPU 密集型操作

---

## 十、审核确认

请审核以上模块拆分方案，确认以下内容：

- [ ] 按前端页面划分模块是否合理
- [ ] `model_chat.rs` 是否需要添加独立 command
- [ ] `common/` 和 `pages/` 的边界是否清晰
- [ ] 是否需要将某些辅助函数提升到 `common/`
- [ ] 目录命名风格（`common` vs `shared`，`pages` vs `modules`）

审核通过后，我将按照 **第六节** 的步骤逐步实施拆分。