use log::{Level, LevelFilter, Log, Metadata, Record};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const LOG_FILE_NAME: &str = "xexamai.log";
const OLD_LOG_FILE_NAME: &str = "xexamai.old.log";
const MAX_LOG_SIZE_BYTES: u64 = 5 * 1024 * 1024;

static LOGGER: FileLogger = FileLogger;
static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

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

        let line = format!(
            "[{}][{}][{}] {}",
            timestamp,
            record.level(),
            record.target(),
            record.args()
        );

        if let Some(file) = LOG_FILE.get() {
            if let Ok(mut file) = file.lock() {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        }

        #[cfg(debug_assertions)]
        eprintln!("{line}");
    }

    fn flush(&self) {
        if let Some(file) = LOG_FILE.get() {
            if let Ok(mut file) = file.lock() {
                let _ = file.flush();
            }
        }
    }
}

pub(crate) fn init() -> Result<PathBuf, String> {
    let log_path = app_log_path()?;
    rotate_large_log(&log_path)?;

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open app log file: {error}"))?;

    let _ = LOG_PATH.set(log_path.clone());
    let _ = LOG_FILE.set(Mutex::new(file));

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(LevelFilter::Debug))
        .map_err(|error| format!("Failed to initialize app logger: {error}"))?;

    log::info!(target: "app", "App log initialized: {}", log_path.to_string_lossy());
    Ok(log_path)
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

    let old_path = log_path.with_file_name(OLD_LOG_FILE_NAME);
    let _ = fs::remove_file(&old_path);
    fs::rename(log_path, old_path)
        .map_err(|error| format!("Failed to rotate app log file: {error}"))
}
