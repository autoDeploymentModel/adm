use serde::Serialize;

/// 应用统一错误类型。
///
/// 通过 `Serialize` 序列化为错误消息字符串（向后兼容前端 `String(err)` 用法），
/// 同时 Rust 侧可通过 `match` 区分错误类型。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum AppError {
    /// 网络请求失败（连接、超时、DNS 等）
    Network(String),
    /// 文件 IO 错误（权限、磁盘空间、路径不存在等）
    Io(String),
    /// 配置/序列化错误
    Config(String),
    /// 模型已在运行等业务状态冲突
    Conflict(String),
    /// 资源未找到
    NotFound(String),
    /// 输入参数校验失败
    InvalidInput(String),
    /// 其他未分类错误
    Other(String),
}

impl AppError {
    /// 快速构造错误（等同 `AppError::Other(msg)`）
    pub fn msg<S: Into<String>>(msg: S) -> Self {
        AppError::Other(msg.into())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Network(msg) => write!(f, "网络错误: {}", msg),
            AppError::Io(msg) => write!(f, "文件错误: {}", msg),
            AppError::Config(msg) => write!(f, "配置错误: {}", msg),
            AppError::Conflict(msg) => write!(f, "{}", msg),
            AppError::NotFound(msg) => write!(f, "未找到: {}", msg),
            AppError::InvalidInput(msg) => write!(f, "参数错误: {}", msg),
            AppError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AppError {}

// ── From impls：让 `?` 运算符自动转换 ──────────────────────

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Config(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

// ── Serialize：序列化为字符串，向后兼容前端 ──────────────

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 便捷类型别名
#[allow(dead_code)]
pub type AppResult<T> = Result<T, AppError>;

/// 提前返回错误的宏（类似 `anyhow::bail!`）
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::common::error::AppError::msg(format!($($arg)*)))
    };
}
