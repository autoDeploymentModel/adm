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
    /// 每张显卡的详细信息（多卡时含多张，单卡/无卡时长度为 1 或 0）
    pub gpus: Vec<GpuInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuInfo {
    /// 显卡名称，如 "NVIDIA GeForce RTX 4090"
    pub name: String,
    /// 总显存（字节），0 = 未知；集成显卡该值不可信（共享内存不计入）
    pub total_vram: u64,
    /// 已用显存（字节），0 = 未知
    pub used_vram: u64,
    /// 是否为集成显卡（核显）
    pub is_integrated: bool,
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
    /// 监听端口（仅作为历史配置兼容入口；UI 已不再允许修改，后端始终使用 5678）
    pub port: Option<u16>,
    /// 监听地址，如 "127.0.0.1" / "0.0.0.0"
    pub host: Option<String>,
    /// 多卡模式：启用后按 split_mode / tensor_split / main_gpu / device 将模型分载到多张 GPU
    #[serde(default)]
    pub multi_gpu: bool,
    /// 多卡分片方式（--split-mode）：none / layer / row / tensor，空则默认 layer
    #[serde(default)]
    pub split_mode: Option<String>,
    /// 各 GPU 分配比例（--tensor-split），如 "3,1"，空则不传按显存自动分配
    #[serde(default)]
    pub tensor_split: Option<String>,
    /// 主卡索引（--main-gpu），默认 0
    #[serde(default)]
    pub main_gpu: Option<i32>,
    /// 参与 offload 的设备列表（--device），如 "CUDA0,CUDA1" 或完整显卡名，空则为全部可用设备
    #[serde(default)]
    pub device: Option<String>,
    /// 排除集成显卡：设备列表留空且同时存在集显/独显时，自动只把模型放到独立显卡
    /// （Vulkan 等后端默认会把层分给核显，导致推理变慢甚至显存不足）。
    /// 默认关闭：自动注入的 `--device` 用的是操作系统报告名（WMI/CIM、system_profiler），
    /// 与 llama-server `--list-devices` 的取值格式不保证一致，匹配不上会让服务端
    /// 拒绝启动或静默降级到 CPU。默认开启等于在用户无感知的情况下改动启动行为，
    /// 因此保持 opt-in，由用户核对 `--list-devices` 输出后自行开启。
    #[serde(default)]
    pub exclude_integrated: bool,
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
/// HTTP 代理配置（同步写入 admAgent.json 顶层 agent_proxy，供 admAgent 读取并应用到 LLM 客户端和 HTTP 工具）
#[serde(default)]
pub agent_proxy: AgentProxyConfig,
}

/// 代理配置（仅 admAgent 使用，桌面端业务请求不走代理）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AgentProxyConfig {
    /// 是否启用代理
    #[serde(default)]
    pub enabled: bool,
    /// 代理地址，如 "http://127.0.0.1:7890" 或 "socks5://127.0.0.1:1080"
    #[serde(default)]
    pub url: String,
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
