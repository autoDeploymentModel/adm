use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sysinfo::System;

/// admAgent server 模式会话：每个 workspace 一个独立会话，持有该 workspace 的
/// SSE 转发任务。子进程由 AppState.agent_child 全局管理（单进程 server
/// 被所有 workspace 共享）。
pub struct AgentServerSession {
    /// SSE 转发任务停止标志
    pub sse_stop: Arc<AtomicBool>,
    /// SSE 转发任务句柄
    pub sse_task: Option<tokio::task::JoinHandle<()>>,
    /// 工作区 ID（与 HashMap key 相同，保留用于调试/日志）
    #[allow(dead_code)]
    pub workspace_id: String,
    /// 客户端 ID（UUID）
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
    /// admAgent server 子进程（全局唯一，所有 workspace 共享）
    pub agent_child: Mutex<Option<tokio::process::Child>>,
    /// 多 workspace 会话（按 workspace_id 索引）
    pub agent_sessions: Mutex<HashMap<String, AgentServerSession>>,
    /// 当前激活的 workspace ID（用于微信路由等需要"当前 tab"的场景）
    pub active_workspace_id: Mutex<Option<String>>,
    /// admAgent server 启停单飞锁
    pub agent_start_lock: tokio::sync::Mutex<()>,
    /// 全局标识：是否有模型成功启动
    pub model_running: Mutex<bool>,
    pub model_supports_images: Mutex<bool>,
    pub model_supports_reasoning: Mutex<bool>,
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
            agent_child: Mutex::new(None),
            agent_sessions: Mutex::new(HashMap::new()),
            active_workspace_id: Mutex::new(None),
            agent_start_lock: tokio::sync::Mutex::new(()),
            model_running: Mutex::new(false),
            model_supports_images: Mutex::new(false),
            model_supports_reasoning: Mutex::new(false),
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
        *self.model_supports_reasoning.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    pub fn set_model_running(&self, running: bool) {
        *self.model_running.lock().unwrap_or_else(|e| e.into_inner()) = running;
    }

    pub fn is_model_running(&self) -> bool {
        self.model_running.lock().map(|g| *g).unwrap_or(false)
    }

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
