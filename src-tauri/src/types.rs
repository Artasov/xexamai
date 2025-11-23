use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::constants::{
    DEFAULT_API_LLM_TIMEOUT_MS, DEFAULT_API_STT_TIMEOUT_MS, DEFAULT_AUDIO_INPUT_TYPE,
    DEFAULT_DURATIONS, DEFAULT_LLM_HOST, DEFAULT_LLM_PROMPT, DEFAULT_LOCAL_DEVICE,
    DEFAULT_LOCAL_LLM_MODEL, DEFAULT_LOCAL_WHISPER_MODEL, DEFAULT_OPENAI_MODEL,
    DEFAULT_OPENAI_TRANSCRIPTION_MODEL, DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS,
    DEFAULT_SCREEN_PROMPT, DEFAULT_SCREEN_PROVIDER, DEFAULT_STREAM_MODE,
    DEFAULT_STREAM_SEND_HOTKEY, DEFAULT_TOGGLE_INPUT_HOTKEY, DEFAULT_TRANSCRIPTION_MODE,
    DEFAULT_TRANSCRIPTION_PROMPT, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_MIN_HEIGHT,
    DEFAULT_WINDOW_MIN_WIDTH, DEFAULT_WINDOW_OPACITY, DEFAULT_WINDOW_SCALE,
    DEFAULT_WINDOW_WIDTH,
};

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

fn default_stream_mode() -> String {
    DEFAULT_STREAM_MODE.to_string()
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
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
    pub transcription_mode: String,
    #[serde(default = "default_llm_host")]
    pub llm_host: String,
    #[serde(default = "default_local_whisper_model")]
    pub local_whisper_model: String,
    #[serde(default = "default_local_device")]
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
    pub window_scale: f32,
    #[serde(default = "default_api_stt_timeout")]
    pub api_stt_timeout_ms: u32,
    #[serde(default = "default_api_llm_timeout")]
    pub api_llm_timeout_ms: u32,
    #[serde(default = "default_screen_timeout")]
    pub screen_processing_timeout_ms: u32,
    #[serde(default = "default_stream_mode")]
    pub stream_mode: String,
    #[serde(default = "default_stream_hotkey")]
    pub stream_send_hotkey: String,
    #[serde(default = "default_screen_model")]
    pub screen_processing_model: String,
    #[serde(default = "default_screen_prompt")]
    pub screen_processing_prompt: String,
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
            stream_mode: default_stream_mode(),
            stream_send_hotkey: default_stream_hotkey(),
            screen_processing_model: default_screen_model(),
            screen_processing_prompt: default_screen_prompt(),
        };
        cfg.normalize();
        cfg
    }
}

impl AppConfig {
    pub fn normalize(&mut self) {
        if self.durations.is_empty() {
            self.durations = DEFAULT_DURATIONS.to_vec();
        }
        self.durations.sort_unstable();
        self.durations.dedup();

        ensure_duration_hotkeys(&mut self.duration_hotkeys, &self.durations);
        if self.toggle_input_hotkey.trim().is_empty() {
            self.toggle_input_hotkey = DEFAULT_TOGGLE_INPUT_HOTKEY.to_string();
        }

        if !matches!(self.audio_input_type.as_str(), "microphone" | "system") {
            self.audio_input_type = DEFAULT_AUDIO_INPUT_TYPE.to_string();
        }

        if self.transcription_model.trim().is_empty() {
            self.transcription_model = DEFAULT_OPENAI_TRANSCRIPTION_MODEL.to_string();
        }
        if self.transcription_prompt.trim().is_empty() {
            self.transcription_prompt = DEFAULT_TRANSCRIPTION_PROMPT.to_string();
        }
        if self.llm_model.trim().is_empty() {
            self.llm_model = DEFAULT_OPENAI_MODEL.to_string();
        }
        if self.api_llm_model.trim().is_empty() {
            self.api_llm_model = DEFAULT_OPENAI_MODEL.to_string();
        }
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
        if self.local_whisper_model.trim().is_empty() {
            self.local_whisper_model = DEFAULT_LOCAL_WHISPER_MODEL.to_string();
        }
        if !matches!(self.local_device.as_str(), "cpu" | "gpu") {
            self.local_device = DEFAULT_LOCAL_DEVICE.to_string();
        }

        if self.window_opacity == 0 {
            self.window_opacity = DEFAULT_WINDOW_OPACITY;
        }
        self.window_opacity = self.window_opacity.clamp(10, 100);

        self.window_width = self.window_width.max(DEFAULT_WINDOW_MIN_WIDTH);
        self.window_height = self.window_height.max(DEFAULT_WINDOW_MIN_HEIGHT);
        if !self.window_scale.is_finite() {
            self.window_scale = DEFAULT_WINDOW_SCALE;
        }
        self.window_scale = self.window_scale.clamp(0.5, 3.0);

        if self.api_stt_timeout_ms == 0 {
            self.api_stt_timeout_ms = DEFAULT_API_STT_TIMEOUT_MS;
        }
        if self.api_llm_timeout_ms == 0 {
            self.api_llm_timeout_ms = DEFAULT_API_LLM_TIMEOUT_MS;
        }
        if self.screen_processing_timeout_ms == 0 {
            self.screen_processing_timeout_ms = DEFAULT_SCREEN_PROCESSING_TIMEOUT_MS;
        }

        if self.stream_mode != "base" && self.stream_mode != "stream" {
            self.stream_mode = DEFAULT_STREAM_MODE.to_string();
        }
        if self.stream_send_hotkey.trim().is_empty() {
            self.stream_send_hotkey = DEFAULT_STREAM_SEND_HOTKEY.to_string();
        }

        if self.screen_processing_model != "openai" && self.screen_processing_model != "google" {
            self.screen_processing_model = DEFAULT_SCREEN_PROVIDER.to_string();
        }
        if self.screen_processing_prompt.trim().is_empty() {
            self.screen_processing_prompt = DEFAULT_SCREEN_PROMPT.to_string();
        }
    }
}

fn ensure_duration_hotkeys(map: &mut BTreeMap<u32, String>, durations: &[u32]) {
    if map.is_empty() {
        *map = default_duration_hotkeys();
        return;
    }
    let mut fallback_iter = (b'1'..=b'9').map(|b| (b as char).to_string());
    for duration in durations {
        map.entry(*duration).or_insert_with(|| {
            fallback_iter
                .next()
                .unwrap_or_else(|| duration.to_string())
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokensPayload {
    pub access: String,
    #[serde(default)]
    pub refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthDeepLinkPayload {
    Success {
        provider: String,
        tokens: AuthTokensPayload,
        #[serde(default)]
        user: Option<Value>,
    },
    Error {
        provider: String,
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
            updated_at: Utc::now().timestamp_millis(),
        }
    }
}
