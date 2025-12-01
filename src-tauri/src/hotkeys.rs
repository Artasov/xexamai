use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::types::AppConfig;

#[derive(Default)]
pub struct HotkeyManager {
    duration_shortcuts: Mutex<Vec<String>>,
    toggle_shortcut: Mutex<Option<String>>,
}

impl HotkeyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_config(&self, app: &AppHandle, config: &AppConfig) {
        self.register_duration_hotkeys(app, config);
        self.register_toggle_hotkey(app, config);
    }

    fn register_duration_hotkeys(&self, app: &AppHandle, config: &AppConfig) {
        let manager = app.global_shortcut();
        let mut registered = self.duration_shortcuts.lock().unwrap();
        for accelerator in registered.drain(..) {
            let _ = manager.unregister(accelerator.as_str());
        }

        let mut used = HashSet::new();
        for duration in &config.durations {
            if let Some(key) = config.duration_hotkeys.get(duration) {
                if let Some(accelerator) = normalize_accelerator(key) {
                    if !used.insert(accelerator.clone()) {
                        continue;
                    }
                    let seconds = *duration;
                    match manager.on_shortcut(accelerator.as_str(), move |app_handle, _, _| {
                        let _ = app_handle.emit("hotkeys:duration", json!({ "sec": seconds }));
                    }) {
                        Ok(_) => registered.push(accelerator),
                        Err(error) => {
                            eprintln!(
                                "[hotkeys] failed to register duration hotkey '{}': {error}",
                                key
                            );
                        }
                    }
                }
            }
        }
    }

    fn register_toggle_hotkey(&self, app: &AppHandle, config: &AppConfig) {
        let manager = app.global_shortcut();
        let mut guard = self.toggle_shortcut.lock().unwrap();
        if let Some(existing) = guard.take() {
            let _ = manager.unregister(existing.as_str());
        }
        let key = config.toggle_input_hotkey.trim();
        if key.is_empty() {
            return;
        }
        if let Some(accelerator) = normalize_accelerator(key) {
            match manager.on_shortcut(accelerator.as_str(), move |app_handle, _, _| {
                let _ = app_handle.emit("hotkeys:toggle-input", json!({}));
            }) {
                Ok(_) => {
                    *guard = Some(accelerator);
                }
                Err(error) => {
                    eprintln!(
                        "[hotkeys] failed to register toggle hotkey '{}': {error}",
                        key
                    );
                }
            }
        }
    }
}

fn normalize_accelerator(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut accelerator = String::from("Ctrl+");
    if trimmed.len() == 1 {
        accelerator.push_str(&trimmed.to_uppercase());
    } else {
        accelerator.push_str(trimmed);
    }
    Some(accelerator)
}
