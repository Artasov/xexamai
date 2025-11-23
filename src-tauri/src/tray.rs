use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::show_main_window;

fn load_image_from_path(path: &std::path::Path) -> Option<Image<'static>> {
    let img = image::open(path).ok()?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let pixels = rgba.into_raw();
    Some(Image::new_owned(pixels, width, height))
}

const MENU_SHOW: &str = "show";
const MENU_HIDE: &str = "hide";
const MENU_QUIT: &str = "quit";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id(MENU_SHOW, "Показать окно").build(app)?)
        .item(&MenuItemBuilder::with_id(MENU_HIDE, "Скрыть окно").build(app)?)
        .item(&MenuItemBuilder::with_id(MENU_QUIT, "Выход").build(app)?)
        .build()?;

    let loaded_icon: Option<Image<'static>> = if let Some(default_icon) = app.default_window_icon()
    {
        let rgba_data = default_icon.rgba();
        let width = default_icon.width();
        let height = default_icon.height();
        Some(Image::new_owned(rgba_data.to_vec(), width, height))
    } else {
        let mut found_icon = None;
        if let Ok(current_dir) = std::env::current_dir() {
            for candidate in ["icon.ico", "icon.png"] {
                let path = current_dir.join("src-tauri").join("icons").join(candidate);
                if path.exists() {
                    found_icon = load_image_from_path(&path);
                }
                if found_icon.is_some() {
                    break;
                }
            }
        }
        if found_icon.is_none() {
            found_icon = app
                .path()
                .resource_dir()
                .ok()
                .and_then(|dir| {
                    let ico = dir.join("icons").join("icon.ico");
                    if ico.exists() {
                        load_image_from_path(&ico)
                    } else {
                        let png = dir.join("icons").join("icon.png");
                        if png.exists() {
                            load_image_from_path(&png)
                        } else {
                            None
                        }
                    }
                });
        }
        found_icon
    };

    let mut builder = TrayIconBuilder::new();
    if let Some(icon) = loaded_icon {
        builder = builder.icon(icon);
    }

    builder
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("Failed to show window from tray: {error}");
                }
            }
            MENU_HIDE => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.hide() {
                        eprintln!("Failed to hide window from tray: {error}");
                    }
                }
            }
            MENU_QUIT => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
