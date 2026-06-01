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

#[derive(Serialize, Deserialize, Clone, Debug)]
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
    pub port: Option<u16>,
    pub host: Option<String>,
    pub preset_mode: Option<String>,
}

impl Default for LaunchParams {
    fn default() -> Self {
        Self {
            ctx_size: None,
            n_predict: None,
            batch_size: None,
            ubatch_size: None,
            n_gpu_layers: None,
            threads: None,
            threads_batch: None,
            flash_attn: None,
            cache_type_k: None,
            cache_type_v: None,
            mlock: None,
            mmap: None,
            temperature: None,
            top_k: None,
            top_p: None,
            min_p: None,
            repeat_penalty: None,
            repeat_last_n: None,
            dry_multiplier: None,
            dry_allowed_length: None,
            dry_penalty_last_n: None,
            presence_penalty: None,
            frequency_penalty: None,
            reasoning: None,
            port: None,
            host: None,
            preset_mode: None,
        }
    }
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

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Settings {
    pub launch_params: LaunchParams,
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
