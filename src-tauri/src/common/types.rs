use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct SystemInfo {
    pub total_ram: u64,
    pub used_ram: u64,
    pub total_vram: u64,
    pub used_vram: u64,
    pub has_gpu: bool,
    pub cpu_usage: f32,
    pub cpu_physical_cores: usize,
    pub cpu_logical_cores: usize,
}

#[derive(Serialize, Clone)]
pub struct ModelStatus {
    pub running: bool,
    pub model_id: Option<String>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LaunchParams {
    pub ctx_size: Option<i32>,
    pub n_predict: Option<i32>,
    pub batch_size: Option<i32>,
    pub ubatch_size: Option<i32>,
    pub n_gpu_layers: Option<String>,
    pub threads: Option<i32>,
    pub threads_batch: Option<i32>,
    pub flash_attn: Option<String>,
    pub cache_type_k: Option<String>,
    pub cache_type_v: Option<String>,
    pub mlock: Option<bool>,
    pub mmap: Option<bool>,
    pub temperature: Option<f64>,
    pub top_k: Option<i32>,
    pub top_p: Option<f64>,
    pub min_p: Option<f64>,
    pub repeat_penalty: Option<f64>,
    pub repeat_last_n: Option<i32>,
    pub dry_multiplier: Option<f64>,
    pub dry_allowed_length: Option<i32>,
    pub dry_penalty_last_n: Option<i32>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub reasoning: Option<String>,
    pub spec_draft_n_max: Option<i32>,
    pub spec_type: Option<String>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub preset_mode: Option<String>,
}


#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteModel {
    pub model_id: String,
    pub model_url: String,
    pub model_size: String,
    #[serde(default)]
    pub model_type: String,
    #[serde(default)]
    pub model_description: String,
    pub need_ram: String,
    #[serde(default)]
    pub support_tools: bool,
    #[serde(default)]
    pub support_reasoning: bool,
    #[serde(default)]
    pub support_images: bool,
    #[serde(default)]
    pub model_mmproj: Option<String>,
    #[serde(default)]
    pub model_diffusion: Option<String>,
    #[serde(default)]
    pub model_vae: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkDirEntry {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Settings {
pub launch_params: LaunchParams,
/// 已弃用：单个工作目录（迁移到 agent_workdirs 后仅用于向后兼容读取）
#[serde(default)]
pub agent_workdir: String,
/// 工作目录列表（数组模式），is_default=true 的为当前默认目录
#[serde(default)]
pub agent_workdirs: Vec<WorkDirEntry>,
/// Agent Plan 模式：只读调研并产出计划，不修改任何文件（false = 执行模式直通）
#[serde(default)]
pub agent_plan_mode: bool,
/// Agent 默认 Provider（如 "local" / "xiaomimimo" 等）
#[serde(default)]
pub agent_default_provider: String,
/// Agent 推理强度（auto / low / medium / high）
#[serde(default)]
pub agent_reasoning_effort: String,
/// Agent 采样温度
#[serde(default)]
pub agent_temperature: Option<f64>,
/// 调试模式：开启后在软件根目录记录 admAgent API/SSE 交互日志（每次重启自动清空）
#[serde(default)]
pub debug_logging: bool,
/// 界面语言（"zh" 中文 / "en" English，空或未知回退中文）
#[serde(default)]
pub language: String,
/// Agent 多模态模型（图片识别）："provider/model" 复合键，如 "admAgent/admImage-model"（默认）。
/// 空或缺失 = 内置 admImage-model；同步写入 admAgent.json 顶层 agent_vision_model 供 vision 子命令读取
#[serde(default)]
pub agent_vision_model: String,
}

// ===== 自动更新相关结构 =====

#[derive(Serialize, Deserialize, Clone)]
pub struct PlatformUpdate {
    #[serde(rename = "appUrl")]
    pub app_url: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(rename = "llamacppVersion")]
    pub llamacpp_version: Option<String>,
    #[serde(rename = "admAgentVersion")]
    pub adm_agent_version: Option<String>,
    pub windows: Option<PlatformUpdate>,
    #[serde(rename = "mac")]
    pub mac_os: Option<PlatformUpdate>,
}

#[derive(Serialize, Clone)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub remote_version: String,
    pub current_version: String,
    pub download_url: Option<String>,
    pub changelog_url: Option<String>,
    pub llamacpp_needs_update: bool,
    pub llamacpp_remote_version: Option<String>,
    pub llamacpp_local_version: Option<String>,
    pub llamacpp_download_url: Option<String>,
    pub vc_redist_installed: bool,
}

#[derive(Serialize, Clone)]
pub struct PartFileProgress {
    pub model_id: String,
    pub existing_size: u64,
}

#[derive(Serialize, Clone)]
pub struct LocalModel {
    pub model_id: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct HardwareDetectResult {
    pub os: String,
    pub gpu_vendor: Option<String>,
    pub gpu_name: Option<String>,
    pub nvidia_series: Option<u32>,
}
