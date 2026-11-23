use crate::common::types::{DockerTask, LaunchParams};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sysinfo::System;

/// 一次成功拉起过的本地模型启动参数：进程运行期崩溃后按同一份参数自动拉起。
/// 只记录 llama-server 进程模型（docker 模型有自己的容器恢复链路）。
#[derive(Clone)]
pub struct ModelLaunchSpec {
    pub model_id: String,
    pub params: LaunchParams,
    pub support_images: bool,
    pub model_filename: Option<String>,
}

/// docker 长任务的取消标志 + 令牌。
/// 同一 model 上可能出现重叠任务（取消后立刻重下 / 重启动），token 保证只有
/// 当前任务的收尾才会清掉记录，旧任务不得抹掉新任务的取消标志。
pub struct DockerCancel {
    pub token: u64,
    pub flag: Arc<AtomicBool>,
}

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
    /// 当前运行模型的类型：None=无 / Some("process")=llama-server / Some("docker")=图片生成容器
    pub running_kind: Mutex<Option<String>>,
    /// docker 部署时记录的容器名（
    pub running_container: Mutex<Option<String>>,
    /// docker 长任务进度（model_id -> 任务），供 UI 重载后恢复
    pub docker_tasks: Mutex<HashMap<String, DockerTask>>,
    /// docker 长任务取消标志（model_id -> 取消记录）：任务启动时创建、结束时移除，
    /// 「取消」命令置位，下载 / 等待引擎 / 拉镜像等循环读取后中止
    pub docker_cancels: Mutex<HashMap<String, DockerCancel>>,
    /// docker 长任务拉起的子进程（model_id -> pid）：取消与退出清理时强杀，
    /// 避免 `docker pull` 在应用退出后继续在后台下载
    pub docker_children: Mutex<HashMap<String, u32>>,
    pub downloading_progress: Mutex<HashMap<String, u8>>,
    pub downloading_phase: Mutex<HashMap<String, String>>,
    pub sys: Mutex<System>,
    /// admAgent server 子进程（全局唯一，所有 workspace 共享）
    pub agent_child: Mutex<Option<tokio::process::Child>>,
    /// 多 workspace 会话（按 workspace_id 索引）
    pub agent_sessions: Mutex<HashMap<String, AgentServerSession>>,
    /// 当前激活的 workspace ID（用于微信路由等需要"当前 tab"的场景）
    pub active_workspace_id: Mutex<Option<String>>,
    /// admAgent server 启停单飞锁
    pub agent_start_lock: tokio::sync::Mutex<()>,
    /// config.json 读-改-写 互斥锁（防止前端操作与微信端指令并发写 config.json 互相覆盖）
    pub config_write_lock: std::sync::Mutex<()>,
    /// 全局标识：是否有模型成功启动
    pub model_running: Mutex<bool>,
    pub model_supports_images: Mutex<bool>,
    pub model_supports_reasoning: Mutex<bool>,
    pub model_generation: Mutex<u64>,
    /// 用户主动停止 llama-server 的意图：stop_model 在 kill 前置位、start_model 复位。
    /// 启动监控线程据此区分「用户点关闭」与「llama-server 启动异常退出」，后者发 model-error 提示
    pub model_stop_intent: AtomicBool,
    /// 最近一次成功拉起的本地模型参数：运行期崩溃（非启动失败、非用户停止）后按同一份参数
    /// 自动拉起一次，避免用户会话因为推理引擎崩溃被卡在「连接被拒」。
    pub last_model_launch: Mutex<Option<ModelLaunchSpec>>,
    /// 上次自动重启的时间：崩溃自动拉起按此节流（窗口内再次崩溃只提示、不再拉起），
    /// 防止驱动级故障（如 Vulkan DeviceLost）导致的重启循环。
    pub last_auto_restart: Mutex<Option<std::time::Instant>>,
    /// 本地模型启动互斥：start_model 命令与崩溃自动重启串行化。
    /// 两条路径都先查「是否已有模型在运行」再 spawn，不串行时可能各拉起一个 llama-server，
    /// 后写状态的一方抢不到端口退出后还会把状态清成「已停止」。
    pub model_start_lock: Mutex<()>,
    /// 应用退出标志：cleanup_processes 最先置位。崩溃自动重启线程可能正在延迟等待，
    /// 据此放弃拉起新引擎，避免应用退出后遗留孤儿 llama-server（占端口/显存）。
    pub app_exiting: AtomicBool,
    /// 系统托盘是否创建成功。托盘菜单是「退出」的唯一入口，因此关闭窗口前必须判断：
    /// 托盘不可用（Linux 缺 libayatana-appindicator3 / 桌面无 StatusNotifier 宿主）时
    /// 只能直接退出，隐藏窗口会让进程留在后台且界面里再也无法退出
    pub tray_available: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_process: Mutex::new(None),
            running_model_id: Mutex::new(None),
            running_port: Mutex::new(None),
            running_kind: Mutex::new(None),
            running_container: Mutex::new(None),
            docker_tasks: Mutex::new(HashMap::new()),
            docker_cancels: Mutex::new(HashMap::new()),
            docker_children: Mutex::new(HashMap::new()),
            downloading_progress: Mutex::new(HashMap::new()),
            downloading_phase: Mutex::new(HashMap::new()),
            sys: Mutex::new(System::new_all()),
            agent_child: Mutex::new(None),
            agent_sessions: Mutex::new(HashMap::new()),
            active_workspace_id: Mutex::new(None),
            agent_start_lock: tokio::sync::Mutex::new(()),
            config_write_lock: std::sync::Mutex::new(()),
            model_running: Mutex::new(false),
            model_supports_images: Mutex::new(false),
            model_supports_reasoning: Mutex::new(false),
            model_generation: Mutex::new(0),
            model_stop_intent: AtomicBool::new(false),
            last_model_launch: Mutex::new(None),
            last_auto_restart: Mutex::new(None),
            model_start_lock: Mutex::new(()),
            app_exiting: AtomicBool::new(false),
            tray_available: AtomicBool::new(false),
        }
    }

    #[allow(dead_code)]
    pub fn get_running_pid(&self) -> Option<u32> {
        self.running_process.lock().map(|g| *g).unwrap_or(None)
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
        *self.running_kind.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.running_container.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
