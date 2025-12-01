pub const CONFIG_DIR_NAME: &str = "xexamai";
pub const CONFIG_FILE_NAME: &str = "config.json";

pub const DEFAULT_WINDOW_WIDTH: u32 = 420;
pub const DEFAULT_WINDOW_HEIGHT: u32 = 780;
pub const DEFAULT_WINDOW_MIN_WIDTH: u32 = 400;
pub const DEFAULT_WINDOW_MIN_HEIGHT: u32 = 500;
pub const DEFAULT_WINDOW_SCALE: f32 = 1.0;
pub const DEFAULT_WINDOW_OPACITY: u32 = 100;

pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-nano";
pub const DEFAULT_OPENAI_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";
pub const DEFAULT_LOCAL_LLM_MODEL: &str = "gpt-oss:20b";
pub const DEFAULT_LOCAL_WHISPER_MODEL: &str = "base";
pub const DEFAULT_LOCAL_DEVICE: &str = "cpu";

pub const DEFAULT_TRANSCRIPTION_MODE: &str = "api";
pub const DEFAULT_LLM_HOST: &str = "api";
pub const DEFAULT_AUDIO_INPUT_TYPE: &str = "mixed";
pub const DEFAULT_STREAM_SEND_HOTKEY: &str = "~";
pub const DEFAULT_TOGGLE_INPUT_HOTKEY: &str = "g";

pub const DEFAULT_DURATIONS: [u32; 6] = [5, 10, 15, 20, 30, 60];

pub const DEFAULT_API_STT_TIMEOUT_MS: u32 = 30_000;
pub const DEFAULT_API_LLM_TIMEOUT_MS: u32 = 30_000;
pub const DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS: u32 = 50_000;

pub const DEFAULT_SCREEN_PROVIDER: &str = "openai";

pub const DEFAULT_TRANSCRIPTION_PROMPT: &str = "This is a technical interview conducted in English. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).";
pub const DEFAULT_LLM_PROMPT: &str = "You are a seasoned technical interview coach for software engineers. Provide detailed, precise answers with technical terminology, example code";
pub const DEFAULT_SCREEN_PROMPT: &str = "You are assisting with a technical interview. Analyze the screenshot and extract key information that could help answer questions about the candidate's environment, tools, or work. Focus on actionable insights.";

pub const SITE_BASE_URL: &str = "https://xldev.ru";
pub const OAUTH_APP_NAME: &str = "xexamai";
pub const OAUTH_SCHEME: &str = "xexamai";
// Shared install location hint for the local speech server so multiple apps reuse one copy.
pub const FAST_WHISPER_INSTALL_ENV_VAR: &str = "WINKY_LOCAL_SPEECH_DIR";
pub const FAST_WHISPER_INSTALL_HINT_FILE: &str = "local-speech-path.txt";
pub const FAST_WHISPER_REPO_URL: &str = "https://github.com/Artasov/fast-fast-whisper.git";
pub const FAST_WHISPER_REPO_NAME: &str = "fast-fast-whisper";
pub const FAST_WHISPER_REPO_ARCHIVE_URL: &str =
    "https://github.com/Artasov/fast-fast-whisper/archive/refs/heads/main.zip";
pub const FAST_WHISPER_PORT: u16 = 8868;
pub const FAST_WHISPER_HEALTH_ENDPOINT: &str = "http://127.0.0.1:8868/health";
