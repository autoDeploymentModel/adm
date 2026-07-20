use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sysinfo::System;

use portable_pty::{Child, MasterPty};

/// Agent 终端会话：保存一个 PTY 主端的句柄，用于收发数据、调整大小、关闭进程。
/// 另外记录该会话对应的「Agent 终端代次」、读取线程的停止标志与句柄，
/// 用于在 (重)启动 / 停止时彻底回收旧读取线程，避免新旧线程并发向同一
/// `agent-terminal-data` 事件推送数据导致前端出现重复输出。
pub struct AgentSession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
    pub child: Box<dyn Child + Send>,
    /// 本会话的 Agent 终端代次（每次 start_agent_terminal +1）。
    /// 读取线程把该值随每帧数据一同 emit 给前端，前端按代次过滤旧会话残留输出。
    /// 注：线程通过闭包捕获的 `generation` 副本发射；此字段保留在会话上以备诊断 / 未来扩展。
    #[allow(dead_code)]
    pub generation: u64,
    /// 读取线程停止标志：置 true 后线程应在下一次 read 返回后退出。
    pub reader_stop: Arc<AtomicBool>,
    /// 读取线程句柄：用于在替换 / 停止会话时 join 旧线程，确保完全退出。
    pub reader_handle: Option<std::thread::JoinHandle<()>>,
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
    pub agent_session: Mutex<Option<AgentSession>>,
    /// 全局标识：是否有模型成功启动（用于进入 Agent 页前的判断）
    pub model_running: Mutex<bool>,
    /// 模型启动代次：每次成功启动模型 +1，用于进入 Agent 页时判断模型是否已重启
    /// （模型重启后，已运行的 admAgent 进程仍连着旧实例，需要重新拉起）
    pub model_generation: Mutex<u64>,
    /// Agent 终端会话代次：每次成功 start_agent_terminal +1。
    /// 与 model_generation 不同，专指 Agent 终端会话本身的重启代次，
    /// 用于让前端区分 data 事件来自哪一次会话，丢弃旧会话的残留输出。
    pub agent_generation: Mutex<u64>,
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
            model_running: Mutex::new(false),
            model_generation: Mutex::new(0),
            agent_generation: Mutex::new(0),
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

    /// Agent 终端会话代次 +1，返回新代次。每次 start_agent_terminal 调用一次。
    pub fn bump_agent_generation(&self) -> u64 {
        let mut g = self
            .agent_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *g += 1;
        *g
    }
}
