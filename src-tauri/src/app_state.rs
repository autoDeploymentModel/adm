use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sysinfo::System;

/// admAgent server 模式会话：保存子进程句柄与监听端口。
/// 前端通过 `agent_http_request` 命令代理访问 `http://127.0.0.1:{port}` 的 HTTP API。
/// SSE 事件通过后台 tokio task 从 admAgent SSE 端点读取并转发为 Tauri 事件。
pub struct AgentServerSession {
    /// admAgent server 子进程
    pub child: tokio::process::Child,
    /// server 监听端口
    pub port: u16,
    /// SSE 转发任务停止标志
    pub sse_stop: Arc<AtomicBool>,
    /// 工作区 ID（admAgent server 启动时创建 / 连接的工作区）
    pub workspace_id: String,
    /// 客户端 ID（UUID）
    #[allow(dead_code)]
    pub client_id: String,
}

pub struct AppState {
    pub running_process: Mutex<Option<u32>>,
    pub running_model_id: Mutex<Option<String>>,
    pub running_port: Mutex<Option<u16>>,
    pub downloading_progress: Mutex<HashMap<String, u8>>,
    pub downloading_phase: Mutex<HashMap<String, String>>,
    pub sd_downloading: Mutex<bool>,
    pub sd_download_progress: Mutex<u8>,
    pub sd_download_status: Mutex<String>,
    pub sys: Mutex<System>,
    /// admAgent server 会话
    pub agent_session: Mutex<Option<AgentServerSession>>,
    /// admAgent server 启停单飞锁：覆盖完整异步启动流程，避免并发 spawn/覆盖会话
    pub agent_start_lock: tokio::sync::Mutex<()>,
    /// 全局标识：是否有模型成功启动（用于进入 Agent 页前的判断）
    pub model_running: Mutex<bool>,
    /// 当前运行模型是否支持图片输入（启动时按 support_images + mmproj 文件实际加载判定）
    pub model_supports_images: Mutex<bool>,
    /// 模型启动代次：每次成功启动模型 +1
    pub model_generation: Mutex<u64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_process: Mutex::new(None),
            running_model_id: Mutex::new(None),
            running_port: Mutex::new(None),
            downloading_progress: Mutex::new(HashMap::new()),
            downloading_phase: Mutex::new(HashMap::new()),
            sd_downloading: Mutex::new(false),
            sd_download_progress: Mutex::new(0),
            sd_download_status: Mutex::new("".to_string()),
            sys: Mutex::new(System::new_all()),
            agent_session: Mutex::new(None),
            agent_start_lock: tokio::sync::Mutex::new(()),
            model_running: Mutex::new(false),
            model_supports_images: Mutex::new(false),
            model_generation: Mutex::new(0),
        }
    }

    #[allow(dead_code)]
    pub fn get_running_pid(&self) -> Option<u32> {
        self.running_process.lock().map(|g| g.clone()).unwrap_or(None)
    }

    #[allow(dead_code)]
    pub fn set_running_pid(&self, pid: u32) {
        *self.running_process.lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
    }

    #[allow(dead_code)]
    pub fn clear_running(&self) {
        *self.running_process.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.running_model_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.running_port.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.model_running.lock().unwrap_or_else(|e| e.into_inner()) = false;
        *self.model_supports_images.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    pub fn set_model_running(&self, running: bool) {
        *self.model_running.lock().unwrap_or_else(|e| e.into_inner()) = running;
    }

    pub fn is_model_running(&self) -> bool {
        self.model_running.lock().map(|g| *g).unwrap_or(false)
    }

    /// 模型成功启动一代：代次 +1（返回新代次）
    pub fn bump_model_generation(&self) -> u64 {
        let mut g = self.model_generation.lock().unwrap_or_else(|e| e.into_inner());
        *g += 1;
        *g
    }

    #[allow(dead_code)]
    pub fn get_model_generation(&self) -> u64 {
        *self.model_generation.lock().unwrap_or_else(|e| e.into_inner())
    }
}
