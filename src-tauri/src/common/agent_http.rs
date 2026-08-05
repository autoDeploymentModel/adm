//! admAgent server 本地传输：Unix socket / Windows named pipe。
//!
//! admAgent 的 `serve` 命令默认绑定平台原生本地传输（对应 Go 侧
//! `internal/server.DefaultHost()`），不占用 TCP 端口；reqwest 不支持
//! 这两种传输，因此这里用 hyper 直接对 socket / named pipe 发起
//! HTTP/1.1 请求（含 SSE 长连接流）。
//!
//! 默认地址与 Go 侧保持一致（这样多客户端/多实例共享同一 server）：
//! - Windows：`\\.\pipe\admAgent-<sid>.sock`（sid = 当前用户 SID）
//! - macOS/Linux：`<XDG_RUNTIME_DIR | temp_dir>/admAgent-<uid>.sock`，
//!   路径超 104 字节（macOS sun_path 上限）时回退 `/tmp`。

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::{Bytes, Incoming};
use hyper::Uri;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};

/// 平台默认传输地址（对应 Go `server.DefaultHost()`）。
/// 两个变体在任意平台都保留（跨平台数据），但只会在对应平台被构造，
/// 因此按平台各有一个变体在死代码分析中“未使用”，属预期。
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub enum AgentTransport {
    /// Unix domain socket 路径（macOS / Linux）
    Unix(PathBuf),
    /// Windows 命名管道路径，如 `\\.\pipe\admAgent-<sid>.sock`
    NamedPipe(String),
}

impl AgentTransport {
    /// 与 Go `server.DefaultHost()` 等价的默认地址。
    pub fn default_host() -> Self {
        #[cfg(target_os = "windows")]
        {
            let sid = current_user_sid().unwrap_or_default();
            AgentTransport::NamedPipe(format!(r"\\.\pipe\admAgent-{}.sock", sid))
        }
        #[cfg(not(target_os = "windows"))]
        {
            // SAFETY: getuid 无失败路径，返回当前进程真实 uid。
            let uid = unsafe { libc::getuid() };
            let dir = std::env::var("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir());
            let mut path = dir.join(format!("admAgent-{}.sock", uid));
            // macOS sun_path 上限 104 字节：超长回退 /tmp（对齐 Go 逻辑）
            if path.as_os_str().to_string_lossy().as_bytes().len() > 104 {
                path = PathBuf::from("/tmp").join(format!("admAgent-{}.sock", uid));
            }
            AgentTransport::Unix(path)
        }
    }

    /// 展示用地址（对齐 Go 的 host URL 格式，如 `unix:///tmp/admAgent-501.sock`）
    pub fn display(&self) -> String {
        match self {
            AgentTransport::Unix(p) => format!("unix://{}", p.display()),
            AgentTransport::NamedPipe(n) => format!("npipe://{}", n),
        }
    }
}

/// 平台 socket 流：统一实现 tokio AsyncRead/AsyncWrite，供 hyper 传输使用
pub enum AgentStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeClient),
}

#[cfg(unix)]
impl tokio::io::AsyncRead for AgentStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Unix(s) => Pin::new(s).poll_read(cx, buf),
            #[cfg(windows)]
            AgentStream::Pipe(p) => Pin::new(p).poll_read(cx, buf),
        }
    }
}

#[cfg(unix)]
impl tokio::io::AsyncWrite for AgentStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            AgentStream::Unix(s) => Pin::new(s).poll_write(cx, buf),
            #[cfg(windows)]
            AgentStream::Pipe(p) => Pin::new(p).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Unix(s) => Pin::new(s).poll_flush(cx),
            #[cfg(windows)]
            AgentStream::Pipe(p) => Pin::new(p).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Unix(s) => Pin::new(s).poll_shutdown(cx),
            #[cfg(windows)]
            AgentStream::Pipe(p) => Pin::new(p).poll_shutdown(cx),
        }
    }
}

#[cfg(windows)]
impl tokio::io::AsyncRead for AgentStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Pipe(p) => Pin::new(p).poll_read(cx, buf),
            #[cfg(unix)]
            AgentStream::Unix(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

#[cfg(windows)]
impl tokio::io::AsyncWrite for AgentStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            AgentStream::Pipe(p) => Pin::new(p).poll_write(cx, buf),
            #[cfg(unix)]
            AgentStream::Unix(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Pipe(p) => Pin::new(p).poll_flush(cx),
            #[cfg(unix)]
            AgentStream::Unix(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            AgentStream::Pipe(p) => Pin::new(p).poll_shutdown(cx),
            #[cfg(unix)]
            AgentStream::Unix(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Windows：获取当前用户 SID（对应 Go `os/user.Current().Uid`，
/// 用于拼出与 Go `DefaultHost()` 一致的命名管道路径）。
#[cfg(target_os = "windows")]
fn current_user_sid() -> io::Result<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = Default::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return Err(io::Error::last_os_error());
        }
        // 先取所需缓冲区大小（返回 ERROR_INSUFFICIENT_BUFFER 属预期）
        let mut size: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        let mut buf = vec![0u8; size.max(1) as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut _),
            size,
            &mut size,
        )
        .is_err()
        {
            return Err(io::Error::last_os_error());
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_str: PWSTR = PWSTR::null();
        if ConvertSidToStringSidW(tu.User.Sid, &mut sid_str).is_err() {
            return Err(io::Error::last_os_error());
        }
        let s = sid_str.to_string().unwrap_or_default();
        let _ = LocalFree(HLOCAL(sid_str.0 as *mut _));
        if s.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "无法获取当前用户 SID",
            ));
        }
        Ok(s)
    }
}

/// hyper-util 连接元数据：本地传输无额外信息，返回空 Connected。
impl hyper_util::client::legacy::connect::Connection for AgentStream {
    fn connected(
        &self,
    ) -> hyper_util::client::legacy::connect::Connected {
        hyper_util::client::legacy::connect::Connected::new()
    }
}

/// hyper 连接器：忽略请求 URI 的 authority，仅按 transport 建立本地连接。
/// 连接过程受 connect_timeout 约束（server 未启动时立即失败，无需长等）。
#[derive(Clone)]
pub struct AgentConnector {
    pub transport: AgentTransport,
    pub connect_timeout: Duration,
}

impl AgentConnector {
    async fn connect(self) -> io::Result<AgentStream> {
        match self.transport {
            AgentTransport::Unix(path) => {
                #[cfg(unix)]
                {
                    let s = tokio::net::UnixStream::connect(path).await?;
                    Ok(AgentStream::Unix(s))
                }
                #[cfg(not(unix))]
                {
                    let _ = &path;
                    Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "unix socket 不支持当前平台",
                    ))
                }
            }
            AgentTransport::NamedPipe(name) => {
                #[cfg(windows)]
                {
                    let p = connect_pipe(&name).await?;
                    Ok(AgentStream::Pipe(p))
                }
                #[cfg(not(windows))]
                {
                    Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "named pipe 不支持当前平台",
                    ))
                }
            }
        }
    }
}

impl tower_service::Service<Uri> for AgentConnector {
    type Response = TokioIo<AgentStream>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _req: Uri) -> Self::Future {
        let this = self.clone();
        let timeout = self.connect_timeout;
        Box::pin(async move {
            let fut = this.connect();
            match tokio::time::timeout(timeout, fut).await {
                Ok(r) => r.map(TokioIo::new),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "连接 admAgent server 超时",
                )),
            }
        })
    }
}

/// 打开 Windows 命名管道：管道忙（服务端正在接受连接/客户端过多）时短暂重试；
/// 管道不存在则立即失败。tokio 的 ClientOptions::open 是同步 CreateFileW，
/// 本地管道打开耗时微秒级，可接受。
#[cfg(windows)]
async fn connect_pipe(
    name: &str,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231; // windows_sys::ERROR_PIPE_BUSY
    let mut attempt = 0u32;
    loop {
        match ClientOptions::new().open(name) {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempt < 10 => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// admAgent server 的 HTTP 客户端（连接池按 transport 复用）
pub type AgentHttpClient = Client<AgentConnector, Full<Bytes>>;

/// 构建连接超时受限的 HTTP 客户端。
/// 注意：这里的超时只约束建连；请求总体超时由调用方用 tokio::time::timeout 包一层
/// （SSE 长连接绝不能设总超时，见 agent.rs forward_sse_events 注释）。
pub fn build_client(
    transport: &AgentTransport,
    connect_timeout: Duration,
) -> Result<AgentHttpClient, String> {
    let connector = AgentConnector {
        transport: transport.clone(),
        connect_timeout,
    };
    Ok(Client::builder(TokioExecutor::new()).build(connector))
}

/// 生成请求 URI：authority 固定为 "agent"（连接器忽略主机，只用 path）
pub fn uri_for(path: &str) -> Result<Uri, String> {
    Uri::builder()
        .scheme("http")
        .authority("agent")
        .path_and_query(path)
        .build()
        .map_err(|e| format!("无效的请求路径 {}: {}", path, e))
}

/// 发送一次请求并读完整响应体，返回 (HTTP 状态码, 响应体字节)。
/// 调用方负责整体超时与状态码语义（202/204/200/4xx…）。
pub async fn send(
    client: &AgentHttpClient,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(u16, Vec<u8>), String> {
    use http_body_util::BodyExt;
    use http_body_util::Full;
    use hyper::body::Bytes;

    let uri = uri_for(path)?;
    let mut builder = hyper::Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let payload = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
    let req = builder
        .body(Full::new(Bytes::from(payload)))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let collected = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    Ok((status, collected.to_bytes().to_vec()))
}

/// GET 请求并返回响应体流（SSE 长连接用）。连接超时由客户端 builder 控制，
/// 流本身不设总超时。
pub async fn stream_get(
    client: &AgentHttpClient,
    path: &str,
) -> Result<(u16, Incoming), String> {
    use http_body_util::Full;
    use hyper::body::Bytes;

    let uri = uri_for(path)?;
    let req = hyper::Request::builder()
        .method("GET")
        .uri(uri)
        .body(Full::new(Bytes::new()))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;
    Ok((resp.status().as_u16(), resp.into_body()))
}

/// GET /v1/health 探活：能连上且返回 2xx 视为 server 就绪。
pub async fn health_check(client: &AgentHttpClient) -> bool {
    match tokio::time::timeout(
        Duration::from_secs(3),
        send(client, "GET", "/v1/health", None),
    )
    .await
    {
        Ok(Ok((status, _))) => (200..300).contains(&status),
        _ => false,
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// 对真实 admAgent 二进制的命名管道连通性验证：
    /// 1) 探测默认管道——已有 server 在跑就直接验证；
    /// 2) 否则 spawn admAgent server（默认 host），轮询 /v1/health。
    /// 同时验证 Rust 计算的管道名与 Go `DefaultHost()` 一致、tokio 管道
    /// 客户端与 go-winio MessageMode 服务端兼容。
    #[tokio::test]
    async fn named_pipe_health_check_against_real_server() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../admAgent/admAgent.exe");
        if !exe.exists() {
            eprintln!("[test] admAgent.exe 不存在，跳过");
            return;
        }
        let transport = AgentTransport::default_host();
        eprintln!("[test] 默认传输地址: {}", transport.display());
        let client = build_client(&transport, Duration::from_secs(2)).expect("build client");

        let mut spawned: Option<tokio::process::Child> = None;
        let mut healthy = health_check(&client).await;
        if !healthy {
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.arg("server")
                .kill_on_drop(true)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let child = cmd.spawn().expect("spawn admAgent server");
            spawned = Some(child);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            while tokio::time::Instant::now() < deadline {
                if health_check(&client).await {
                    healthy = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        assert!(
            healthy,
            "named pipe 健康检查失败，transport={}",
            transport.display()
        );
        if let Some(mut c) = spawned {
            let _ = c.start_kill();
        }
    }
}
