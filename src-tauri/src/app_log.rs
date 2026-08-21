use log::{Level, LevelFilter, Log, Metadata, Record};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LOG_FILE_NAME: &str = "xexamai.log";
const OLD_LOG_FILE_NAME: &str = "xexamai.old.log";
const MAX_LOG_SIZE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_RECORD_BYTES: usize = 64 * 1024;
const LOG_QUEUE_CAPACITY: usize = 1_024;
const FRONTEND_LOG_WINDOW: Duration = Duration::from_secs(10);
const FRONTEND_LOG_LIMIT: u32 = 200;

static LOGGER: FileLogger = FileLogger;
static LOG_SENDER: OnceLock<SyncSender<WriterMessage>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static DROPPED_LOG_LINES: AtomicU64 = AtomicU64::new(0);
static FRONTEND_LOG_RATE: OnceLock<Mutex<FrontendRateWindow>> = OnceLock::new();

enum WriterMessage {
    Line(String),
    Flush(SyncSender<()>),
}

struct FrontendRateWindow {
    started_at: Instant,
    accepted: u32,
}

struct FileLogger;

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        let target = metadata.target();
        if target.starts_with("tao") || target.starts_with("wry") {
            return metadata.level() <= Level::Warn;
        }
        metadata.level() <= Level::Debug
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();

        let raw_line = format!(
            "[{}][{}][{}] {}",
            timestamp,
            record.level(),
            record.target(),
            record.args()
        );
        let line = bound_log_record(&redact_text(&bound_log_record(&raw_line)));

        if let Some(sender) = LOG_SENDER.get() {
            match sender.try_send(WriterMessage::Line(line.clone())) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    DROPPED_LOG_LINES.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Disconnected(_)) => {
                    DROPPED_LOG_LINES.fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        #[cfg(debug_assertions)]
        eprintln!("{line}");
    }

    fn flush(&self) {
        if let Some(sender) = LOG_SENDER.get() {
            let (complete, completed) = sync_channel(0);
            let deadline = Instant::now() + Duration::from_secs(1);
            let mut message = WriterMessage::Flush(complete);
            loop {
                match sender.try_send(message) {
                    Ok(()) => {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if !remaining.is_zero() {
                            let _ = completed.recv_timeout(remaining);
                        }
                        break;
                    }
                    Err(TrySendError::Full(pending)) if Instant::now() < deadline => {
                        message = pending;
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => break,
                }
            }
        }
    }
}

pub(crate) fn init() -> Result<PathBuf, String> {
    let log_path = app_log_path()?;
    rotate_large_log(&log_path)?;

    let file = open_log_file(&log_path)?;
    let (sender, receiver) = sync_channel(LOG_QUEUE_CAPACITY);
    let writer_path = log_path.clone();
    thread::Builder::new()
        .name("xexamai-log-writer".to_string())
        .spawn(move || writer_loop(writer_path, file, receiver))
        .map_err(|error| format!("Failed to start app log writer: {error}"))?;

    let _ = LOG_PATH.set(log_path.clone());
    let _ = LOG_SENDER.set(sender);

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(LevelFilter::Debug))
        .map_err(|error| format!("Failed to initialize app logger: {error}"))?;

    log::info!(target: "app", "App log initialized: {}", log_path.to_string_lossy());
    Ok(log_path)
}

pub(crate) fn allow_frontend_log() -> bool {
    let rate = FRONTEND_LOG_RATE.get_or_init(|| {
        Mutex::new(FrontendRateWindow {
            started_at: Instant::now(),
            accepted: 0,
        })
    });
    let Ok(mut window) = rate.lock() else {
        return false;
    };
    if window.started_at.elapsed() >= FRONTEND_LOG_WINDOW {
        window.started_at = Instant::now();
        window.accepted = 0;
    }
    if window.accepted >= FRONTEND_LOG_LIMIT {
        return false;
    }
    window.accepted += 1;
    true
}

fn open_log_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open app log file: {error}"))?;
    set_private_permissions(path)?;
    Ok(file)
}

fn writer_loop(path: PathBuf, file: File, receiver: Receiver<WriterMessage>) {
    let mut bytes_written = file.metadata().map(|value| value.len()).unwrap_or_default();
    let mut file = Some(file);
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Line(line) => {
                match write_log_line(&path, &mut file, &mut bytes_written, &line) {
                    Ok(true) => {}
                    Ok(false) => {
                        DROPPED_LOG_LINES.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(()) => break,
                }
            }
            WriterMessage::Flush(complete) => {
                let dropped = DROPPED_LOG_LINES.swap(0, Ordering::AcqRel);
                if dropped > 0 {
                    let notice =
                        format!("[logger] dropped {dropped} log lines while the queue was full");
                    match write_log_line(&path, &mut file, &mut bytes_written, &notice) {
                        Ok(true) => {}
                        Ok(false) => {
                            DROPPED_LOG_LINES.fetch_add(dropped, Ordering::Relaxed);
                        }
                        Err(()) => {
                            DROPPED_LOG_LINES.fetch_add(dropped, Ordering::Relaxed);
                            let _ = complete.send(());
                            break;
                        }
                    }
                }
                if let Some(file) = file.as_mut() {
                    let _ = file.flush();
                }
                let _ = complete.send(());
            }
        }
    }
}

fn write_log_line(
    path: &Path,
    file: &mut Option<File>,
    bytes_written: &mut u64,
    line: &str,
) -> Result<bool, ()> {
    let line = bound_log_record(line);
    let line_bytes = line.len() as u64 + 1;
    if bytes_written.saturating_add(line_bytes) > MAX_LOG_SIZE_BYTES {
        if let Some(current) = file.as_mut() {
            let _ = current.flush();
        }
        drop(file.take());
        let rotated = match rotate_log_now(path) {
            Ok(()) => true,
            Err(_error) => {
                #[cfg(debug_assertions)]
                eprintln!("[logger] runtime rotation failed: {_error}");
                false
            }
        };
        let next = open_log_file(path).map_err(|_error| {
            #[cfg(debug_assertions)]
            eprintln!("[logger] failed to reopen log file: {_error}");
        })?;
        *bytes_written = next
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(MAX_LOG_SIZE_BYTES);
        *file = Some(next);
        if !rotated && *bytes_written >= MAX_LOG_SIZE_BYTES {
            return Ok(false);
        }
    }
    let Some(current) = file.as_mut() else {
        return Err(());
    };
    if writeln!(current, "{line}").is_ok() {
        *bytes_written = (*bytes_written).saturating_add(line_bytes);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn bound_log_record(value: &str) -> String {
    truncate_utf8_bytes(value, MAX_LOG_RECORD_BYTES, "...<record-truncated>")
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize, suffix: &str) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes == 0 {
        return String::new();
    }
    let usable_suffix = if suffix.len() <= max_bytes {
        suffix
    } else {
        ""
    };
    let mut end = max_bytes.saturating_sub(usable_suffix.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], usable_suffix)
}

pub(crate) fn current_log_path() -> Result<PathBuf, String> {
    if let Some(path) = LOG_PATH.get() {
        return Ok(path.clone());
    }
    app_log_path()
}

pub(crate) fn current_log_dir() -> Result<PathBuf, String> {
    current_log_path()?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "App log directory is unavailable".to_string())
}

pub(crate) fn redacted_tail(max_bytes: usize) -> Result<String, String> {
    log::logger().flush();
    let path = current_log_path()?;
    let mut file = File::open(&path).map_err(|error| format!("Failed to read app log: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("Failed to inspect app log: {error}"))?
        .len();
    let start = length.saturating_sub(max_bytes as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("Failed to seek app log: {error}"))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read app log: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let redacted = text.lines().map(redact_text).collect::<Vec<_>>().join("\n");
    Ok(truncate_utf8_bytes(&redacted, max_bytes, "...<truncated>"))
}

fn app_log_path() -> Result<PathBuf, String> {
    let base = app_data_base_dir().join("xexamai");
    let log_dir = base.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create app log directory: {error}"))?;
    Ok(log_dir.join(LOG_FILE_NAME))
}

fn app_data_base_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(path) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(path);
        }
        if let Ok(path) = std::env::var("APPDATA") {
            return PathBuf::from(path);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support");
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(path) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(path);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local").join("share");
        }
    }

    std::env::temp_dir()
}

fn rotate_large_log(log_path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(log_path) else {
        return Ok(());
    };

    if metadata.len() <= MAX_LOG_SIZE_BYTES {
        return Ok(());
    }

    rotate_log_now(log_path)
}

fn rotate_log_now(log_path: &Path) -> Result<(), String> {
    let old_path = log_path.with_file_name(OLD_LOG_FILE_NAME);
    let _ = fs::remove_file(&old_path);
    fs::rename(log_path, &old_path)
        .map_err(|error| format!("Failed to rotate app log file: {error}"))?;
    set_private_permissions(&old_path)
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to secure log file permissions: {error}"))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Redacts common credential forms before any log record reaches disk or stderr.
/// This is deliberately a final safety net: callers should still avoid logging secrets.
pub(crate) fn redact_text(value: &str) -> String {
    // Bearer must be handled before the generic `Authorization:` assignment pass:
    // otherwise that pass replaces only the word `Bearer` (up to the first space)
    // and leaves the credential behind without a marker the bearer pass can find.
    let mut output = redact_bearer_values(&sanitize_controls(value));
    for key in [
        "authorization",
        "access_token",
        "refresh_token",
        "access",
        "refresh",
        "api_key",
        "apikey",
        "password",
        "client_secret",
        "secret",
        "token",
    ] {
        output = redact_assigned_value(&output, key);
    }
    redact_openai_credentials(&redact_bearer_values(&output))
}

pub(crate) fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    redact_json_at_depth(value, 0)
}

fn redact_json_at_depth(value: &serde_json::Value, depth: usize) -> serde_json::Value {
    if depth >= 8 {
        return serde_json::Value::String("<max-depth>".to_string());
    }
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .take(64)
                .map(|(key, value)| {
                    let redacted = if is_sensitive_key(key) {
                        serde_json::Value::String("[REDACTED]".to_string())
                    } else {
                        redact_json_at_depth(value, depth + 1)
                    };
                    (sanitize_controls(key), redacted)
                })
                .collect(),
        ),
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .iter()
                .take(64)
                .map(|value| redact_json_at_depth(value, depth + 1))
                .collect(),
        ),
        serde_json::Value::String(value) => {
            serde_json::Value::String(truncate_chars(&redact_text(value), 2_048))
        }
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "access"
            | "accesstoken"
            | "refresh"
            | "refreshtoken"
            | "token"
            | "password"
            | "apikey"
            | "clientsecret"
            | "secret"
    )
}

fn sanitize_controls(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    format!(
        "{}...<truncated>",
        value.chars().take(max).collect::<String>()
    )
}

fn redact_openai_credentials(value: &str) -> String {
    const REDACTED: &str = "[REDACTED]";
    const MIN_PAYLOAD_LEN: usize = 20;

    let mut output = String::with_capacity(value.len());
    let mut copy_from = 0;
    let mut index = 0;
    while index < value.len() {
        let remaining = &value[index..];
        let prefix_len = if remaining.starts_with("sk-proj-") {
            "sk-proj-".len()
        } else if remaining.starts_with("sk-svcacct-") {
            "sk-svcacct-".len()
        } else if remaining.starts_with("sk-") {
            "sk-".len()
        } else if remaining.starts_with("ek_") {
            "ek_".len()
        } else if remaining.starts_with("ek-") {
            "ek-".len()
        } else {
            index += remaining.chars().next().map(char::len_utf8).unwrap_or(1);
            continue;
        };

        let has_left_boundary = value[..index]
            .chars()
            .next_back()
            .is_none_or(|character| !is_openai_credential_character(character));
        if !has_left_boundary {
            index += prefix_len;
            continue;
        }

        let payload_start = index + prefix_len;
        let mut end = payload_start;
        while end < value.len()
            && value.as_bytes()[end].is_ascii()
            && is_openai_credential_character(char::from(value.as_bytes()[end]))
        {
            end += 1;
        }
        let payload = &value.as_bytes()[payload_start..end];
        let looks_like_credential = payload.len() >= MIN_PAYLOAD_LEN
            && payload.iter().any(u8::is_ascii_alphabetic)
            && payload.iter().any(u8::is_ascii_digit);
        if !looks_like_credential {
            index += prefix_len;
            continue;
        }

        output.push_str(&value[copy_from..index]);
        output.push_str(REDACTED);
        copy_from = end;
        index = end;
    }
    output.push_str(&value[copy_from..]);
    output
}

fn is_openai_credential_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
}

fn redact_bearer_values(value: &str) -> String {
    let mut output = value.to_string();
    let mut cursor = 0;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative) = lower[cursor..].find("bearer ") else {
            break;
        };
        let start = cursor + relative + "bearer ".len();
        let end = find_unquoted_value_end(&output, start);
        if end <= start {
            cursor = start;
            continue;
        }
        output.replace_range(start..end, "[REDACTED]");
        cursor = start + "[REDACTED]".len();
    }
    output
}

fn redact_assigned_value(value: &str, key: &str) -> String {
    let mut output = value.to_string();
    let mut cursor = 0;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative) = lower[cursor..].find(key) else {
            break;
        };
        let key_start = cursor + relative;
        let mut separator = key_start + key.len();
        let bytes = output.as_bytes();
        while separator < bytes.len() && matches!(bytes[separator], b' ' | b'\t' | b'\'' | b'"') {
            separator += 1;
        }
        if separator >= bytes.len() || !matches!(bytes[separator], b':' | b'=') {
            cursor = key_start + key.len();
            continue;
        }
        let mut start = separator + 1;
        while start < bytes.len() && matches!(bytes[start], b' ' | b'\t') {
            start += 1;
        }
        let quoted = bytes
            .get(start)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'));
        if quoted.is_some() {
            start += 1;
        }
        let end = if let Some(quote) = quoted {
            output.as_bytes()[start..]
                .iter()
                .position(|byte| *byte == quote)
                .map(|position| start + position)
                .unwrap_or(output.len())
        } else {
            find_unquoted_value_end(&output, start)
        };
        if end <= start {
            cursor = start;
            continue;
        }
        output.replace_range(start..end, "[REDACTED]");
        cursor = start + "[REDACTED]".len();
    }
    output
}

fn find_unquoted_value_end(value: &str, start: usize) -> usize {
    value.as_bytes()[start..]
        .iter()
        .position(|byte| {
            matches!(
                byte,
                b' ' | b'\t' | b'\r' | b'\n' | b'&' | b',' | b'}' | b']' | b'\'' | b'"'
            )
        })
        .map(|position| start + position)
        .unwrap_or(value.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_query_and_json_credentials() {
        let input = r#"Authorization: Bearer header.payload.signature token=abc {"refresh":"xyz","ok":true}"#;
        let output = redact_text(input);
        assert!(!output.contains("header.payload.signature"));
        assert!(!output.contains("abc"));
        assert!(!output.contains("xyz"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_bare_openai_credentials() {
        for prefix in ["sk-", "sk-proj-", "ek_", "ek-"] {
            let credential = format!("{prefix}{}", "Ab3c".repeat(8));
            let input = format!("WebSocket protocol openai-insecure-api-key.{credential}, closed");
            let output = redact_text(&input);
            assert!(!output.contains(&credential));
            assert!(output.contains("[REDACTED]"));
        }
    }

    #[test]
    fn preserves_non_credential_openai_like_text() {
        let input = "Keep sk-test, ek_value, task-sketch, and sk-this-is-an-ordinary-long-slug.";
        assert_eq!(redact_text(input), input);
    }

    #[test]
    fn frontend_json_is_bounded_and_redacted_recursively() {
        let value = serde_json::json!({
            "nested": {"accessToken": "secret-access", "safe": "hello\nforged"},
            "password": "secret-password"
        });
        let output = redact_json(&value);
        let serialized = serde_json::to_string(&output).unwrap();
        assert!(!serialized.contains("secret-access"));
        assert!(!serialized.contains("secret-password"));
        assert!(!serialized.contains("\\n"));
    }

    #[test]
    fn native_log_records_are_utf8_safe_and_size_bounded() {
        let input = "я".repeat(MAX_LOG_RECORD_BYTES);
        let output = bound_log_record(&input);
        assert!(output.len() <= MAX_LOG_RECORD_BYTES);
        assert!(output.ends_with("...<record-truncated>"));
    }

    #[test]
    fn diagnostic_tail_uses_a_real_utf8_byte_limit() {
        let output = truncate_utf8_bytes(&"я".repeat(20_000), 16 * 1024, "...<truncated>");
        assert!(output.len() <= 16 * 1024);
        assert!(output.ends_with("...<truncated>"));
    }
}
