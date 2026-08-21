use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON payload at intentionally dynamic IPC boundaries. Specta represents it
/// as `unknown` without recursively expanding `serde_json::Value`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct JsonValue(Value);

impl specta::Type for JsonValue {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <specta_typescript::Unknown as specta::Type>::definition(types)
    }
}

impl JsonValue {
    pub fn into_inner(self) -> Value {
        self.0
    }
}

impl std::ops::Deref for JsonValue {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for JsonValue {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

use crate::constants::{
    BACKEND_DOMAIN_RU, DEFAULT_API_LLM_TIMEOUT_MS, DEFAULT_API_STT_TIMEOUT_MS,
    DEFAULT_AUDIO_INPUT_TYPE, DEFAULT_BACKEND_DOMAIN, DEFAULT_DURATIONS, DEFAULT_LLM_HOST,
    DEFAULT_LLM_PROMPT, DEFAULT_LOCAL_DEVICE, DEFAULT_LOCAL_LLM_MODEL, DEFAULT_LOCAL_WHISPER_MODEL,
    DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_TRANSCRIPTION_MODEL, DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS,
    DEFAULT_SCREEN_PROMPT, DEFAULT_SCREEN_PROVIDER, DEFAULT_STREAM_SEND_HOTKEY,
    DEFAULT_TOGGLE_INPUT_HOTKEY, DEFAULT_TRANSCRIPTION_MODE, DEFAULT_TRANSCRIPTION_PROMPT,
    DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_MIN_HEIGHT, DEFAULT_WINDOW_MIN_WIDTH,
    DEFAULT_WINDOW_OPACITY, DEFAULT_WINDOW_SCALE, DEFAULT_WINDOW_WIDTH,
};

const VALID_LOCAL_DEVICES: &[&str] = &["auto", "cpu", "cuda", "metal", "gpu"];
const VALID_LOCAL_WHISPER_MODELS: &[&str] = &[
    "tiny", "base", "small", "medium", "large", "large-v2", "large-v3",
];
const CURRENT_GEMINI_PRO_MODEL: &str = "gemini-3.1-pro-preview";
const CURRENT_GEMINI_FLASH_MODEL: &str = "gemini-3.7-flash";

fn migrate_retired_gemini_model(value: &str) -> String {
    match value.trim() {
        "gemini-1.5-pro" | "gemini-2.0-pro" | "gemini-3.0-pro" | "gemini-3-pro-preview" => {
            CURRENT_GEMINI_PRO_MODEL.to_string()
        }
        "gemini-1.5-flash" | "gemini-2.0-flash" | "gemini-2.0-flash-exp" | "gemini-3.0-flash" => {
            CURRENT_GEMINI_FLASH_MODEL.to_string()
        }
        other => other.to_string(),
    }
}

fn default_durations() -> Vec<u32> {
    DEFAULT_DURATIONS.to_vec()
}

fn default_duration_hotkeys() -> BTreeMap<u32, String> {
    let mut map = BTreeMap::new();
    for (idx, duration) in DEFAULT_DURATIONS.iter().enumerate() {
        let digit = ((idx as u8) + b'1') as char;
        map.insert(*duration, digit.to_string());
    }
    map
}

fn default_toggle_hotkey() -> String {
    DEFAULT_TOGGLE_INPUT_HOTKEY.to_string()
}

fn normalize_hotkey(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if chars.next().is_some() || first.is_control() || first.is_whitespace() {
        return None;
    }
    if first.is_ascii_alphanumeric()
        || matches!(
            first,
            '`' | '~' | '-' | '=' | '[' | ']' | ';' | '\'' | ',' | '.' | '/'
        )
    {
        Some(first.to_ascii_lowercase().to_string())
    } else {
        None
    }
}

fn default_audio_input_type() -> String {
    DEFAULT_AUDIO_INPUT_TYPE.to_string()
}

fn default_transcription_model() -> String {
    DEFAULT_OPENAI_TRANSCRIPTION_MODEL.to_string()
}

fn default_llm_model() -> String {
    DEFAULT_OPENAI_MODEL.to_string()
}

fn default_api_llm_model() -> String {
    DEFAULT_OPENAI_MODEL.to_string()
}

fn default_local_llm_model() -> String {
    DEFAULT_LOCAL_LLM_MODEL.to_string()
}

fn default_llm_prompt() -> String {
    DEFAULT_LLM_PROMPT.to_string()
}

fn default_transcription_mode() -> String {
    DEFAULT_TRANSCRIPTION_MODE.to_string()
}

fn default_llm_host() -> String {
    DEFAULT_LLM_HOST.to_string()
}

fn default_local_whisper_model() -> String {
    DEFAULT_LOCAL_WHISPER_MODEL.to_string()
}

fn default_local_device() -> String {
    DEFAULT_LOCAL_DEVICE.to_string()
}

fn default_window_scale() -> f32 {
    DEFAULT_WINDOW_SCALE
}

fn default_stream_hotkey() -> String {
    DEFAULT_STREAM_SEND_HOTKEY.to_string()
}

fn default_screen_model() -> String {
    DEFAULT_SCREEN_PROVIDER.to_string()
}

fn default_screen_prompt() -> String {
    DEFAULT_SCREEN_PROMPT.to_string()
}

fn default_backend_domain() -> String {
    DEFAULT_BACKEND_DOMAIN.to_string()
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum AudioInputTypeContract {
    Microphone,
    System,
    Mixed,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum ApiOrLocalContract {
    Api,
    Local,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum LocalDeviceContract {
    Auto,
    Cpu,
    Cuda,
    Metal,
    Gpu,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum WhisperModelContract {
    Tiny,
    Base,
    Small,
    Medium,
    Large,
    #[serde(rename = "large-v2")]
    LargeV2,
    #[serde(rename = "large-v3")]
    LargeV3,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum ScreenProviderContract {
    Openai,
    Google,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
enum BackendDomainContract {
    #[serde(rename = "xlartas.com")]
    Com,
    #[serde(rename = "xlartas.ru")]
    Ru,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_backend_domain")]
    #[specta(type = BackendDomainContract)]
    pub backend_domain: String,
    // Provider credentials are accepted only for one-time migration from the
    // legacy config file. They are never serialized back to disk or IPC.
    #[serde(default, skip_serializing)]
    #[specta(skip)]
    pub openai_api_key: Option<String>,
    #[serde(default, skip_serializing)]
    #[specta(skip)]
    pub google_api_key: Option<String>,
    #[serde(default = "default_durations")]
    pub durations: Vec<u32>,
    #[serde(default = "default_duration_hotkeys")]
    pub duration_hotkeys: BTreeMap<u32, String>,
    #[serde(default = "default_toggle_hotkey")]
    pub toggle_input_hotkey: String,
    #[serde(default)]
    pub audio_input_device_id: Option<String>,
    #[serde(default = "default_audio_input_type")]
    #[specta(type = AudioInputTypeContract)]
    pub audio_input_type: String,
    #[serde(default = "default_transcription_model")]
    pub transcription_model: String,
    #[serde(default = "default_transcription_prompt")]
    pub transcription_prompt: String,
    #[serde(default = "default_llm_model")]
    pub llm_model: String,
    #[serde(default = "default_api_llm_model")]
    pub api_llm_model: String,
    #[serde(default = "default_local_llm_model")]
    pub local_llm_model: String,
    #[serde(default = "default_llm_prompt")]
    pub llm_prompt: String,
    #[serde(default = "default_transcription_mode")]
    #[specta(type = ApiOrLocalContract)]
    pub transcription_mode: String,
    #[serde(default = "default_llm_host")]
    #[specta(type = ApiOrLocalContract)]
    pub llm_host: String,
    #[serde(default = "default_local_whisper_model")]
    #[specta(type = WhisperModelContract)]
    pub local_whisper_model: String,
    #[serde(default = "default_local_device")]
    #[specta(type = LocalDeviceContract)]
    pub local_device: String,
    #[serde(default)]
    pub window_opacity: u32,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_hide_app")]
    pub hide_app: bool,
    #[serde(default)]
    pub welcome_modal_dismissed: bool,
    #[serde(default = "default_window_width")]
    pub window_width: u32,
    #[serde(default = "default_window_height")]
    pub window_height: u32,
    #[serde(default = "default_window_scale")]
    #[specta(type = specta_typescript::Number)]
    pub window_scale: f32,
    #[serde(default = "default_api_stt_timeout")]
    pub api_stt_timeout_ms: u32,
    #[serde(default = "default_api_llm_timeout")]
    pub api_llm_timeout_ms: u32,
    #[serde(default = "default_screen_timeout")]
    pub screen_processing_timeout_ms: u32,
    #[serde(default = "default_stream_hotkey")]
    pub stream_send_hotkey: String,
    #[serde(default = "default_screen_model")]
    #[specta(type = ScreenProviderContract)]
    pub screen_processing_model: String,
    #[serde(default = "default_screen_prompt")]
    pub screen_processing_prompt: String,
    #[serde(default)]
    pub save_recorder_files: bool,
    /// Whether the user opted in to attaching a cleaned diagnostic snapshot to reports.
    #[serde(default)]
    pub diagnostics_enabled: bool,
}

fn default_window_width() -> u32 {
    DEFAULT_WINDOW_WIDTH
}

fn default_window_height() -> u32 {
    DEFAULT_WINDOW_HEIGHT
}

fn default_hide_app() -> bool {
    true
}

fn default_transcription_prompt() -> String {
    DEFAULT_TRANSCRIPTION_PROMPT.to_string()
}

fn default_api_stt_timeout() -> u32 {
    DEFAULT_API_STT_TIMEOUT_MS
}

fn default_api_llm_timeout() -> u32 {
    DEFAULT_API_LLM_TIMEOUT_MS
}

fn default_screen_timeout() -> u32 {
    DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut cfg = Self {
            backend_domain: default_backend_domain(),
            openai_api_key: None,
            google_api_key: None,
            durations: default_durations(),
            duration_hotkeys: default_duration_hotkeys(),
            toggle_input_hotkey: default_toggle_hotkey(),
            audio_input_device_id: None,
            audio_input_type: default_audio_input_type(),
            transcription_model: default_transcription_model(),
            transcription_prompt: default_transcription_prompt(),
            llm_model: default_llm_model(),
            api_llm_model: default_api_llm_model(),
            local_llm_model: default_local_llm_model(),
            llm_prompt: default_llm_prompt(),
            transcription_mode: default_transcription_mode(),
            llm_host: default_llm_host(),
            local_whisper_model: default_local_whisper_model(),
            local_device: default_local_device(),
            window_opacity: DEFAULT_WINDOW_OPACITY,
            always_on_top: false,
            hide_app: true,
            welcome_modal_dismissed: false,
            window_width: DEFAULT_WINDOW_WIDTH,
            window_height: DEFAULT_WINDOW_HEIGHT,
            window_scale: DEFAULT_WINDOW_SCALE,
            api_stt_timeout_ms: DEFAULT_API_STT_TIMEOUT_MS,
            api_llm_timeout_ms: DEFAULT_API_LLM_TIMEOUT_MS,
            screen_processing_timeout_ms: DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS,
            stream_send_hotkey: default_stream_hotkey(),
            screen_processing_model: default_screen_model(),
            screen_processing_prompt: default_screen_prompt(),
            save_recorder_files: false,
            diagnostics_enabled: false,
        };
        cfg.normalize();
        cfg
    }
}

impl AppConfig {
    pub fn normalize(&mut self) {
        if self.backend_domain != DEFAULT_BACKEND_DOMAIN && self.backend_domain != BACKEND_DOMAIN_RU
        {
            self.backend_domain = default_backend_domain();
        }

        self.durations
            .retain(|duration| (1..=300).contains(duration));
        if self.durations.is_empty() {
            self.durations = DEFAULT_DURATIONS.to_vec();
        }
        self.durations.sort_unstable();
        self.durations.dedup();

        ensure_duration_hotkeys(&mut self.duration_hotkeys, &self.durations);
        self.toggle_input_hotkey = normalize_hotkey(&self.toggle_input_hotkey)
            .unwrap_or_else(|| DEFAULT_TOGGLE_INPUT_HOTKEY.to_string());

        if !matches!(
            self.audio_input_type.as_str(),
            "microphone" | "system" | "mixed"
        ) {
            self.audio_input_type = DEFAULT_AUDIO_INPUT_TYPE.to_string();
        }

        if self.transcription_model.trim().is_empty() {
            self.transcription_model = DEFAULT_OPENAI_TRANSCRIPTION_MODEL.to_string();
        }
        self.transcription_model = migrate_retired_gemini_model(&self.transcription_model);
        if self.transcription_prompt.trim().is_empty() {
            self.transcription_prompt = DEFAULT_TRANSCRIPTION_PROMPT.to_string();
        }
        if self.llm_model.trim().is_empty() {
            self.llm_model = DEFAULT_OPENAI_MODEL.to_string();
        }
        if self.api_llm_model.trim().is_empty() {
            self.api_llm_model = DEFAULT_OPENAI_MODEL.to_string();
        }
        self.api_llm_model = migrate_retired_gemini_model(&self.api_llm_model);
        self.llm_model = migrate_retired_gemini_model(&self.llm_model);
        if self.local_llm_model.trim().is_empty() {
            self.local_llm_model = DEFAULT_LOCAL_LLM_MODEL.to_string();
        }
        if self.llm_prompt.trim().is_empty() {
            self.llm_prompt = DEFAULT_LLM_PROMPT.to_string();
        }
        if !matches!(self.transcription_mode.as_str(), "api" | "local") {
            self.transcription_mode = DEFAULT_TRANSCRIPTION_MODE.to_string();
        }
        if !matches!(self.llm_host.as_str(), "api" | "local") {
            self.llm_host = DEFAULT_LLM_HOST.to_string();
        }
        if self.llm_host == "api" {
            self.llm_model = self.api_llm_model.clone();
        } else {
            self.llm_model = self.local_llm_model.clone();
        }
        self.local_whisper_model = self.local_whisper_model.trim().to_lowercase();
        if !VALID_LOCAL_WHISPER_MODELS.contains(&self.local_whisper_model.as_str()) {
            self.local_whisper_model = DEFAULT_LOCAL_WHISPER_MODEL.to_string();
        }
        let normalized_device = self.local_device.trim().to_lowercase();
        if VALID_LOCAL_DEVICES.contains(&normalized_device.as_str()) {
            self.local_device = normalized_device;
        } else {
            self.local_device = DEFAULT_LOCAL_DEVICE.to_string();
        }

        if self.window_opacity == 0 {
            self.window_opacity = DEFAULT_WINDOW_OPACITY;
        }
        self.window_opacity = self.window_opacity.clamp(10, 100);

        self.window_width = self.window_width.clamp(DEFAULT_WINDOW_MIN_WIDTH, 7680);
        self.window_height = self.window_height.clamp(DEFAULT_WINDOW_MIN_HEIGHT, 4320);
        if !self.window_scale.is_finite() {
            self.window_scale = DEFAULT_WINDOW_SCALE;
        }
        self.window_scale = self.window_scale.clamp(0.5, 3.0);

        self.api_stt_timeout_ms = self.api_stt_timeout_ms.clamp(1_000, 600_000);
        self.api_llm_timeout_ms = self.api_llm_timeout_ms.clamp(1_000, 600_000);
        self.screen_processing_timeout_ms = self.screen_processing_timeout_ms.clamp(1_000, 600_000);

        self.stream_send_hotkey = normalize_hotkey(&self.stream_send_hotkey)
            .unwrap_or_else(|| DEFAULT_STREAM_SEND_HOTKEY.to_string());

        if self.screen_processing_model != "openai" && self.screen_processing_model != "google" {
            self.screen_processing_model = DEFAULT_SCREEN_PROVIDER.to_string();
        }
        if self.screen_processing_prompt.trim().is_empty() {
            self.screen_processing_prompt = DEFAULT_SCREEN_PROMPT.to_string();
        }
    }
}

fn ensure_duration_hotkeys(map: &mut BTreeMap<u32, String>, durations: &[u32]) {
    let previous = std::mem::take(map);
    let mut used = std::collections::BTreeSet::new();
    let mut fallback_iter = (b'1'..=b'9')
        .map(|byte| (byte as char).to_string())
        .chain(('a'..='z').map(|character| character.to_string()));
    for duration in durations {
        let preferred = previous
            .get(duration)
            .and_then(|value| normalize_hotkey(value));
        let value = preferred
            .filter(|candidate| !used.contains(candidate))
            .or_else(|| fallback_iter.find(|candidate| !used.contains(candidate)));
        if let Some(value) = value {
            used.insert(value.clone());
            map.insert(*duration, value);
        }
    }
}

#[derive(Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokensPayload {
    pub access: String,
    #[serde(default)]
    pub refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionCapability {
    pub access: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthDeepLinkPayload {
    Success {
        provider: String,
        #[serde(default)]
        state: Option<String>,
        #[serde(default)]
        #[specta(type = Option<specta_typescript::Unknown>)]
        user: Option<Value>,
    },
    Error {
        provider: String,
        error: String,
        #[serde(default)]
        state: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FastWhisperStatus {
    pub installed: bool,
    pub running: bool,
    pub phase: String,
    pub message: String,
    pub error: Option<String>,
    pub last_action: Option<String>,
    pub last_success_at: Option<i64>,
    pub log_line: Option<String>,
    #[serde(default)]
    pub install_dir: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    pub updated_at: i64,
}

impl FastWhisperStatus {
    pub fn new(message: &str) -> Self {
        Self {
            installed: false,
            running: false,
            phase: "not-installed".into(),
            message: message.into(),
            error: None,
            last_action: None,
            last_success_at: None,
            log_line: None,
            install_dir: None,
            base_url: None,
            updated_at: Utc::now().timestamp_millis(),
        }
    }
}
