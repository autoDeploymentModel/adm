use chrono::{Local, TimeZone};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError, TrySendError};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_BACKUPS: u8 = 3;
const BATCH_SIZE: usize = 50;
const BATCH_MS: u64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl Level {
    fn from_value(value: &Value) -> Self {
        match value.as_str().unwrap_or("info").to_ascii_lowercase().as_str() {
            "debug" => Self::Debug,
            "warn" => Self::Warn,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }
    fn as_str(self) -> &'static str {
        match self { Self::Debug => "debug", Self::Info => "info", Self::Warn => "warn", Self::Error => "error" }
    }
}

struct Logger {
    path: PathBuf,
    boot: String,
    level: AtomicU8,
    sender: mpsc::SyncSender<Message>,
    dropped: AtomicU64,
    errors: AtomicU64,
}

enum Message {
    Event(Value),
    Flush(mpsc::Sender<Result<(), String>>),
}

static LOGGER: OnceLock<Logger> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn canonical_path() -> PathBuf {
    if let Ok(path) = std::env::var("ADM_DESKTOP_LOG") { return PathBuf::from(path); }
    if let Ok(dir) = std::env::var("ADM_LOG_DIR") { return PathBuf::from(dir).join("adm-desktop.jsonl"); }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")));
        return base.join("ADM").join("logs").join("adm-desktop.jsonl");
    }
    #[cfg(target_os = "macos")]
    { return dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("com.adm.admapp").join("logs").join("adm-desktop.jsonl"); }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { return dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("com.adm.admapp").join("logs").join("adm-desktop.jsonl"); }
}

pub fn init() -> Result<PathBuf, String> {
    if let Some(logger) = LOGGER.get() { return Ok(logger.path.clone()); }
    let path = canonical_path();
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let boot = uuid_like();
    let (sender, receiver) = mpsc::sync_channel(4096);
    let worker_path = path.clone();
    let worker_boot = boot.clone();
    thread::Builder::new().name("adm-log-writer".into()).spawn(move || writer_loop(worker_path, worker_boot, receiver)).map_err(|e| e.to_string())?;
    let logger = Logger { path: path.clone(), boot, level: AtomicU8::new(Level::Info as u8), sender, dropped: AtomicU64::new(0), errors: AtomicU64::new(0) };
    let _ = LOGGER.set(logger);
    install_panic_hook();
    emit(Level::Info, "log.writer", "log.writer.start", "Log writer started", json!({"schema":1,"file":"adm-desktop.jsonl","payload_enabled":false}), Value::Null, "desktop")?;
    Ok(path)
}

pub fn path() -> PathBuf { LOGGER.get().map(|l| l.path.clone()).unwrap_or_else(canonical_path) }
pub fn boot() -> String { LOGGER.get().map(|l| l.boot.clone()).unwrap_or_default() }
pub fn set_level(level: Level) {
    if let Some(logger) = LOGGER.get() {
        let old = current_level();
        logger.level.store(level as u8, Ordering::Relaxed);
        let _ = emit(Level::Warn, "log.level", "log.level.change", "Log level changed", json!({"from":old.as_str(),"to":level.as_str(),"source":"config"}), Value::Null, "desktop");
    }
}
pub fn current_level() -> Level {
    LOGGER.get().map(|l| match l.level.load(Ordering::Relaxed) { 0 => Level::Debug, 2 => Level::Warn, 3 => Level::Error, _ => Level::Info }).unwrap_or(Level::Info)
}
pub fn health() -> Value {
    LOGGER.get().map(|l| json!({"dropped":l.dropped.load(Ordering::Relaxed),"errors":l.errors.load(Ordering::Relaxed),"healthy":l.errors.load(Ordering::Relaxed)==0})).unwrap_or_else(|| json!({"healthy":false}))
}

pub fn submit(mut entry: Value) -> Result<(), String> {
    let Some(logger) = LOGGER.get() else { return Err("desktop logger is not initialized".into()); };
    let level = Level::from_value(&entry);
    let Some(obj) = entry.as_object_mut() else { return Err("log entry must be an object".into()); };
    if let Some(Value::Object(attrs)) = obj.remove("attrs") {
        for (key, value) in attrs {
            if !matches!(key.as_str(), "v"|"ts"|"ts_ms"|"seq"|"lvl"|"proc"|"pid"|"boot"|"origin"|"doc"|"src"|"comp"|"evt"|"msg"|"trace"|"fields") { obj.insert(key, value); }
        }
    }
    if (level as u8) < logger.level.load(Ordering::Relaxed) { return Ok(()); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    let ts_ms = obj.get("ts_ms").and_then(Value::as_i64).unwrap_or(now);
    if !obj.contains_key("ts_ms") { obj.insert("ts_source".into(), Value::String("receipt".into())); }
    let ts = Local.timestamp_millis_opt(ts_ms).single().map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, false)).unwrap_or_else(|| Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false));
    obj.insert("v".into(), json!(1));
    obj.insert("ts".into(), Value::String(ts));
    obj.insert("ts_ms".into(), json!(ts_ms));
    obj.insert("seq".into(), json!(SEQ.fetch_add(1, Ordering::Relaxed)));
    obj.insert("proc".into(), Value::String("adm-desktop".into()));
    obj.insert("pid".into(), json!(std::process::id()));
    obj.insert("boot".into(), Value::String(logger.boot.clone()));
    obj.insert("origin".into(), Value::String(obj.get("origin").and_then(Value::as_str).unwrap_or("desktop").into()));
    if obj.get("origin").and_then(Value::as_str) == Some("ui") && obj.get("doc").and_then(Value::as_str).unwrap_or("").is_empty() { return Err("origin=ui requires doc".into()); }
    obj.insert("lvl".into(), Value::String(level.as_str().into()));
    obj.entry("comp").or_insert(Value::String("desktop".into()));
    obj.entry("evt").or_insert(Value::String("log.message".into()));
    obj.entry("msg").or_insert(Value::String("Desktop log event".into()));
    redact_object(obj);
    let urgent = level >= Level::Warn || matches!(obj.get("evt").and_then(Value::as_str), Some("proc.start" | "proc.exit" | "agent.turn.start" | "agent.turn.end" | "tool.call.start" | "tool.call.end"));
    match logger.sender.try_send(Message::Event(Value::Object(obj.clone()))) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            logger.dropped.fetch_add(1, Ordering::Relaxed);
            return Err("desktop log queue is full".into());
        }
        Err(TrySendError::Disconnected(_)) => return Err("desktop log writer stopped".into()),
    };
    if urgent { let _ = flush(); }
    Ok(())
}

pub fn emit(level: Level, comp: &str, evt: &str, msg: &str, attrs: Value, trace: Value, origin: &str) -> Result<(), String> {
    let mut obj = match attrs { Value::Object(map) => map, _ => Map::new() };
    obj.insert("comp".into(), Value::String(comp.into()));
    obj.insert("lvl".into(), Value::String(level.as_str().into()));
    obj.insert("evt".into(), Value::String(evt.into()));
    obj.insert("msg".into(), Value::String(msg.into()));
    obj.insert("origin".into(), Value::String(origin.into()));
    if !trace.is_null() { obj.insert("trace".into(), trace); }
    submit(Value::Object(obj))
}

pub fn raw_line(stream: &str, line: &str) {
    let sidecar = stream == "stdout" || stream == "stderr";
    let origin = if sidecar { "sidecar" } else { "desktop" };
    let comp = if sidecar { "sidecar" } else { "legacy" };
    let _ = emit(Level::Info, comp, "raw.line", "Raw log line", json!({"stream":stream,"bytes":line.len(),"line_hash":hash(line),"excerpt":line.chars().take(500).collect::<String>(),"sensitive":true}), Value::Null, origin);
    if std::env::var("ADM_LOG_PAYLOAD").map(|v| v != "0" && !v.is_empty() && v != "false").unwrap_or(false) {
        let total = (line.len() + (256 << 10) - 1) / (256 << 10);
        for (index, chunk) in line.as_bytes().chunks(256 << 10).enumerate() {
            let _ = emit(Level::Info, comp, "raw.payload", "Raw payload chunk", json!({"stream":stream,"line_seq":index+1,"line_total":total.max(1),"payload":String::from_utf8_lossy(chunk),"sensitive":true}), Value::Null, origin);
        }
    }
}

pub fn flush() -> Result<(), String> {
    let Some(logger) = LOGGER.get() else { return Ok(()); };
    let (tx, rx) = mpsc::channel();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut message = Message::Flush(tx);
    loop {
        match logger.sender.try_send(message) {
            Ok(()) => break,
            Err(TrySendError::Full(next)) => {
                if std::time::Instant::now() >= deadline {
                    return Err("desktop log flush timed out".to_string());
                }
                message = next;
                thread::sleep(Duration::from_millis(5));
            }
            Err(TrySendError::Disconnected(_)) => return Err("desktop log writer stopped".to_string()),
        }
    }
    rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "desktop log flush timed out".to_string())?
}

fn writer_loop(path: PathBuf, boot: String, receiver: Receiver<Message>) {
    let mut batch = VecDeque::new();
    loop {
        let first = match receiver.recv() {
            Ok(Message::Event(value)) => value,
            Ok(Message::Flush(tx)) => { let _ = tx.send(Ok(())); continue },
            Err(_) => break,
        };
        batch.push_back(first);
        let deadline = std::time::Instant::now() + Duration::from_millis(BATCH_MS);
        let mut flushes = Vec::new();
        loop {
            if batch.len() >= BATCH_SIZE { break; }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() { break; }
            match receiver.recv_timeout(remaining) {
                Ok(Message::Event(value)) => batch.push_back(value),
                Ok(Message::Flush(tx)) => { flushes.push(tx); break },
                Err(_) => break,
            }
        }
        if !flushes.is_empty() {
            loop {
                match receiver.try_recv() {
                    Ok(Message::Event(value)) => batch.push_back(value),
                    Ok(Message::Flush(tx)) => flushes.push(tx),
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            }
        }
        let mut data = String::new();
        for mut entry in batch.drain(..) {
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("boot".into(), Value::String(boot.clone()));
                obj.insert("pid".into(), json!(std::process::id()));
                obj.insert("seq".into(), json!(SEQ.fetch_add(1, Ordering::Relaxed)));
            }
            if let Ok(line) = serde_json::to_string(&entry) { data.push_str(&line); data.push('\n'); }
        }
        let result = if data.is_empty() { Ok(()) } else { append_locked(&path, data.as_bytes()) };
        if let Err(err) = &result {
            if let Some(logger) = LOGGER.get() { logger.errors.fetch_add(1, Ordering::Relaxed); }
            eprintln!("desktop log write failed: {err}");
        }
        for tx in flushes { let _ = tx.send(result.clone()); }
    }
}

fn append_locked(path: &Path, data: &[u8]) -> Result<(), String> {
    let lock_path = format!("{}.lock", path.display());
    let lock = OpenOptions::new().read(true).write(true).create(true).open(&lock_path).map_err(|e| e.to_string())?;
    acquire_lock(&lock)?;
    let result = (|| {
        if fs::metadata(path).map(|m| m.len()).unwrap_or(0) >= MAX_FILE_BYTES { rotate(path)?; }
        let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())
    })();
    release_lock(&lock);
    result
}

fn rotate(path: &Path) -> Result<(), String> {
    let fourth = format!("{}.4", path.display());
    if fs::metadata(&fourth).is_ok() { fs::remove_file(&fourth).map_err(|e| e.to_string())?; }
    for i in (1..=MAX_BACKUPS).rev() {
        let from = if i == 1 { path.to_path_buf() } else { PathBuf::from(format!("{}.{}", path.display(), i-1)) };
        let to = PathBuf::from(format!("{}.{}", path.display(), i));
        if fs::metadata(&from).is_ok() { fs::rename(&from, &to).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[cfg(windows)]
fn acquire_lock(file: &File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
    use windows::Win32::System::IO::OVERLAPPED;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    unsafe { LockFileEx(HANDLE(file.as_raw_handle()), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, u32::MAX, u32::MAX, &mut overlapped) }.map_err(|e| e.to_string())
}
#[cfg(windows)]
fn release_lock(file: &File) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::UnlockFileEx;
    use windows::Win32::System::IO::OVERLAPPED;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    unsafe { let _ = UnlockFileEx(HANDLE(file.as_raw_handle()), 0, u32::MAX, u32::MAX, &mut overlapped); }
}
#[cfg(unix)]
fn acquire_lock(file: &File) -> Result<(), String> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}
#[cfg(unix)]
fn release_lock(file: &File) { unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN); } }

fn install_panic_hook() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let old = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            old(info);
            let stack = std::backtrace::Backtrace::force_capture().to_string();
            let mut entry = json!({"v":1,"ts_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64,"lvl":"error","proc":"adm-desktop","origin":"desktop","comp":"proc","evt":"proc.panic","msg":"Desktop panic","component":"desktop","stack":stack,"panic_kind":"rust","sensitive":true});
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("ts".into(), Value::String(Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)));
                obj.insert("seq".into(), json!(SEQ.fetch_add(1, Ordering::Relaxed)));
                obj.insert("pid".into(), json!(std::process::id()));
                obj.insert("boot".into(), Value::String(boot()));
                redact_object(obj);
            }
            if let Ok(line) = serde_json::to_string(&entry) { let _ = emergency_append(&path(), format!("{line}\n")); }
        }));
    });
}
fn emergency_append(path: &Path, line: String) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

fn redact_object(obj: &mut Map<String, Value>) {
    for (key, value) in obj.iter_mut() {
        if sensitive_key(key) { *value = Value::String("[REDACTED]".into()); continue; }
        match value {
            Value::String(text) => *value = Value::String(redact_text(text)),
            Value::Array(items) => { for item in items.iter_mut().take(20) { redact_value(item); } },
            Value::Object(nested) => redact_object(nested),
            _ => {}
        }
    }
}
fn redact_value(value: &mut Value) { if let Value::Object(obj) = value { redact_object(obj); } else if let Value::String(text) = value { *value = Value::String(redact_text(text)); } }
fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    if ["_hash","_bytes","_count","_id","_name","_pct","_tokens","_ms","_code","_reason","_source","_decision","_flags","_total"].iter().any(|suffix| key.ends_with(suffix)) { return false; }
    ["password","passwd","secret","api_key","apikey","authorization","cookie","credential","private_key","access_token","refresh_token","prompt","messages","content","tool_input","command","stdout","stderr","body","raw","config_value"].iter().any(|part| key.contains(part))
}
fn redact_text(text: &str) -> String {
    let mut out = text.to_string();
    for marker in ["Bearer ", "Basic "] {
        if let Some(index) = out.find(marker) {
            let start = index + marker.len();
            let end = out[start..].find(char::is_whitespace).map(|n| start+n).unwrap_or(out.len());
            out.replace_range(start..end, "[REDACTED]");
        }
    }
    if std::env::var("ADM_LOG_PATHS").as_deref() != Ok("1") {
        if let Some(index) = out.find(":\\") { out.replace_range(index.., &format!("path_{}", hash(&out[index..]))); }
        if let Some(index) = out.find('/') { out.replace_range(index.., &format!("path_{}", hash(&out[index..]))); }
    }
    out.chars().take(2048).collect()
}
pub fn hash_for_log(text: &str) -> String { hash(text) }
pub fn new_id(prefix: &str) -> String { format!("{prefix}_{}", uuid_like()) }
fn hash(text: &str) -> String {
    let mut value = 0xcbf29ce484222325u64;
    for byte in text.bytes() { value ^= byte as u64; value = value.wrapping_mul(0x100000001b3); }
    format!("{value:016x}")
}
fn uuid_like() -> String {
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) { chunk.copy_from_slice(&rand::random::<u64>().to_le_bytes()); }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15])
}

#[tauri::command]
pub async fn agent_debug_log_structured(entry: Value) -> Result<(), String> { submit(entry) }
#[tauri::command]
pub async fn agent_debug_log_batch(entries: Vec<Value>) -> Result<(), String> { for entry in entries { submit(entry)?; } flush() }
#[tauri::command]
pub async fn agent_debug_log_flush() -> Result<(), String> { flush() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secrets_and_paths_by_default() {
        assert!(sensitive_key("api_key"));
        assert!(!sensitive_key("command_hash"));
        assert!(!sensitive_key("prompt_bytes"));
        let text = redact_text("Bearer supersecretvalue /home/user/private/file.txt");
        assert!(!text.contains("supersecretvalue"));
        assert!(!text.contains("/home/user"));
    }

    #[test]
    fn uuid_shape_is_valid() {
        let id = uuid_like();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[8], b'-');
        assert_eq!(id.as_bytes()[13], b'-');
    }

    #[test]
    fn writer_appends_schema_and_redacts() {
        let dir = std::env::temp_dir().join(format!("adm-log-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ADM_LOG_DIR", &dir);
        let path = init().unwrap();
        assert_eq!(path, dir.join("adm-desktop.jsonl"));
        submit(json!({"origin":"ui","doc":"doc-1","lvl":"warn","comp":"ui.test","evt":"ui.test","msg":"hello","prompt":"secret","trace":{"turn":"t1"}})).unwrap();
        flush().unwrap();
        let data = fs::read_to_string(dir.join("adm-desktop.jsonl")).unwrap();
        let line = data.lines().find(|line| line.contains("\"evt\":\"ui.test\"")).expect("event line");
        let entry: Value = serde_json::from_str(line).unwrap();
        assert_eq!(entry["v"], 1);
        assert_eq!(entry["origin"], "ui");
        assert_eq!(entry["doc"], "doc-1");
        assert_eq!(entry["proc"], "adm-desktop");
        assert_eq!(entry["prompt"], "[REDACTED]");
        assert!(entry["seq"].is_u64());
        assert!(entry["boot"].as_str().unwrap().len() == 36);
        let _ = fs::remove_dir_all(dir);
    }
}
