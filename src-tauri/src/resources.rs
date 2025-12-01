use tauri::{path::BaseDirectory, AppHandle, Manager};

pub fn resolve_sound_path(app: &AppHandle, sound_name: &str) -> Option<String> {
    let relative = format!("sounds/{}", sound_name);
    
    // В dev режиме пробуем через current_dir
    if let Ok(current_dir) = std::env::current_dir() {
        let alt_path = current_dir.join("resources").join("sounds").join(sound_name);
        if alt_path.exists() {
            return Some(alt_path.to_string_lossy().to_string());
        }
    }
    
    // Пробуем через BaseDirectory::Resource (работает в production)
    if let Ok(resource_path) = app.path().resolve(&relative, BaseDirectory::Resource) {
        if resource_path.exists() {
            return Some(resource_path.to_string_lossy().to_string());
        }
    }
    
    // Пробуем через resource_dir()
    if let Ok(resource_dir) = app.path().resource_dir() {
        let dev_path = resource_dir.join(&relative);
        if dev_path.exists() {
            return Some(dev_path.to_string_lossy().to_string());
        }
        let alt_path = resource_dir.join("sounds").join(sound_name);
        if alt_path.exists() {
            return Some(alt_path.to_string_lossy().to_string());
        }
    }
    
    None
}
