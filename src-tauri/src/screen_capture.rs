use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(windows)]
use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WindowEvent};

use crate::config::ConfigState;

const OVERLAY_LABEL: &str = "screenshot-overlay";
const EVENT_READY: &str = "screen-capture:ready";
const EVENT_CAPTURING: &str = "screen-capture:capturing";
const EVENT_COMPLETED: &str = "screen-capture:completed";
const EVENT_CANCELLED: &str = "screen-capture:cancelled";
const EVENT_ERROR: &str = "screen-capture:error";
#[cfg(windows)]
const MAX_CAPTURE_DIMENSION: u32 = 1_920;
#[cfg(windows)]
const JPEG_QUALITY: u8 = 86;
const SESSION_ID_MASK: u32 = 0x3fff_ffff;
const SESSION_SELECTING: u32 = 0x4000_0000;
const SESSION_CAPTURING: u32 = 0x8000_0000;
const SESSION_ABORTED: u32 = 0xc000_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancellationTransition {
    AbortPreparation,
    CloseOverlay,
    AbortCapture,
    AlreadyAborted,
}

#[derive(Debug, Default)]
pub struct ScreenCaptureState {
    // Lower 30 bits hold the renderer-generated session id. The upper two
    // bits encode preparation/selection/capture/abort as one atomic value so a
    // callback from an old overlay cannot mutate a newer session.
    active_session_id: AtomicU32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    session_id: u32,
    base64: String,
    width: u32,
    height: u32,
    mime: String,
}

/// A rectangle expressed as fractions of the overlay viewport. Normalized
/// coordinates keep the renderer independent of Windows DPI and monitor scale.
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenCaptureError {
    session_id: u32,
    message: String,
}

#[tauri::command]
#[specta::specta]
pub async fn screen_capture_start(
    window: WebviewWindow,
    app: AppHandle,
    config: State<'_, Arc<ConfigState>>,
    state: State<'_, Arc<ScreenCaptureState>>,
    session_id: u32,
) -> Result<(), String> {
    ensure_window(&window, "main")?;
    validate_session_id(session_id)?;

    #[cfg(not(windows))]
    {
        let _ = (app, config, state);
        return Err("Interactive screen capture is not supported on this platform".to_string());
    }

    #[cfg(windows)]
    {
        if state
            .active_session_id
            .compare_exchange(0, session_id, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("A screen capture is already in progress".to_string());
        }
        if let Some(stale_overlay) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = stale_overlay.close();
            for _ in 0..50 {
                if app.get_webview_window(OVERLAY_LABEL).is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if app.get_webview_window(OVERLAY_LABEL).is_some() {
                let _ = state.active_session_id.compare_exchange(
                    session_id,
                    0,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                return Err("The previous screen capture overlay is still closing".to_string());
            }
        }

        let result = if state.active_session_id.load(Ordering::Acquire) == session_id {
            create_overlay(
                &window,
                &app,
                config.inner().as_ref(),
                state.inner().clone(),
                session_id,
            )
            .await
        } else {
            Err("The screen capture session was cancelled before startup".to_string())
        };
        if result.is_err() {
            cleanup_failed_start(&app, state.inner(), session_id).await;
        }
        result
    }
}

#[tauri::command]
#[specta::specta]
pub async fn screen_capture_overlay_ready(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ScreenCaptureState>>,
    session_id: u32,
) -> Result<(), String> {
    ensure_window(&window, OVERLAY_LABEL)?;
    validate_session_id(session_id)?;
    let selecting_session = session_id | SESSION_SELECTING;
    for _ in 0..200 {
        let current = state.active_session_id.load(Ordering::Acquire);
        if current == selecting_session {
            break;
        }
        if current != session_id {
            let _ = window.close();
            return Err("The screen capture session is no longer active".to_string());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if state.active_session_id.load(Ordering::Acquire) != selecting_session {
        let message = "Screen capture overlay preparation timed out".to_string();
        fail_active_session(&app, state.inner(), &window, session_id, message.clone());
        return Err(message);
    }

    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        let message = format!("Could not show the screen capture overlay: {error}");
        fail_active_session(&app, state.inner(), &window, session_id, message.clone());
        return Err(message);
    }
    if state.active_session_id.load(Ordering::Acquire) != selecting_session {
        let _ = window.hide();
        let _ = window.close();
        return Err("The screen capture session is no longer active".to_string());
    }

    if let Err(error) = app.emit_to("main", EVENT_READY, session_id) {
        let message = format!("Could not initialize screen capture: {error}");
        fail_active_session(&app, state.inner(), &window, session_id, message.clone());
        return Err(message);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn screen_capture_finish(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ScreenCaptureState>>,
    session_id: u32,
    region: Option<ScreenCaptureRegion>,
) -> Result<(), String> {
    ensure_window(&window, OVERLAY_LABEL)?;
    validate_session_id(session_id)?;
    let selecting_session = session_id | SESSION_SELECTING;
    let capturing_session = session_id | SESSION_CAPTURING;
    if state
        .active_session_id
        .compare_exchange(
            selecting_session,
            capturing_session,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return Err("The screen capture session is no longer active".to_string());
    }
    let _ = app.emit_to("main", EVENT_CAPTURING, session_id);

    let capture_result = async {
        window
            .hide()
            .map_err(|error| format!("Could not hide the screen capture overlay: {error}"))?;

        // Make sure the transparent overlay has left the compositor before GDI
        // copies the desktop. This keeps the dimming layer out of the result.
        #[cfg(windows)]
        {
            let _ = unsafe { windows::Win32::Graphics::Dwm::DwmFlush() };
        }
        tokio::time::sleep(Duration::from_millis(45)).await;

        #[cfg(windows)]
        {
            let hwnd = window.hwnd().map_err(|error| error.to_string())?;
            let hwnd_value = hwnd.0 as usize;
            tauri::async_runtime::spawn_blocking(move || {
                capture_windows_monitor(hwnd_value, region)
            })
            .await
            .map_err(|error| format!("Screen capture task failed: {error}"))?
        }

        #[cfg(not(windows))]
        {
            let _ = region;
            Err("Interactive screen capture is not supported on this platform".to_string())
        }
    }
    .await;

    let should_deliver = state
        .active_session_id
        .compare_exchange(capturing_session, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if !should_deliver {
        let _ = state.active_session_id.compare_exchange(
            session_id | SESSION_ABORTED,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
    if should_deliver {
        match capture_result {
            Ok(mut capture) => {
                capture.session_id = session_id;
                if let Err(error) = app.emit_to("main", EVENT_COMPLETED, capture) {
                    log::warn!(target: "screen-capture", "Could not deliver the captured screenshot: {error}");
                }
            }
            Err(message) => {
                let _ = app.emit_to(
                    "main",
                    EVENT_ERROR,
                    ScreenCaptureError {
                        session_id,
                        message: message.clone(),
                    },
                );
                log::warn!(target: "screen-capture", "Interactive capture failed: {message}");
            }
        }
    }

    let _ = window.close();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn screen_capture_cancel(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ScreenCaptureState>>,
    session_id: u32,
) -> Result<(), String> {
    ensure_window(&window, OVERLAY_LABEL)?;
    validate_session_id(session_id)?;
    if cancel_active_session(&app, state.inner(), Some(&window), session_id) {
        Ok(())
    } else {
        Err("The screen capture session is no longer active".to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub fn screen_capture_abort(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ScreenCaptureState>>,
    session_id: u32,
) -> Result<(), String> {
    ensure_window(&window, "main")?;
    validate_session_id(session_id)?;
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    cancel_active_session(&app, state.inner(), overlay.as_ref(), session_id);
    Ok(())
}

fn ensure_window(window: &WebviewWindow, expected_label: &str) -> Result<(), String> {
    if window.label() == expected_label {
        Ok(())
    } else {
        Err("Screen capture command is not available to this window".to_string())
    }
}

fn validate_session_id(session_id: u32) -> Result<(), String> {
    if session_id == 0 || session_id > SESSION_ID_MASK {
        Err("The screen capture session identifier is invalid".to_string())
    } else {
        Ok(())
    }
}

fn cancellation_transition(current: u32, session_id: u32) -> Option<CancellationTransition> {
    if current == session_id {
        Some(CancellationTransition::AbortPreparation)
    } else if current == (session_id | SESSION_SELECTING) {
        Some(CancellationTransition::CloseOverlay)
    } else if current == (session_id | SESSION_CAPTURING) {
        Some(CancellationTransition::AbortCapture)
    } else if current == (session_id | SESSION_ABORTED) {
        Some(CancellationTransition::AlreadyAborted)
    } else {
        None
    }
}

#[cfg(windows)]
async fn cleanup_failed_start(app: &AppHandle, state: &ScreenCaptureState, session_id: u32) {
    let aborted_session = session_id | SESSION_ABORTED;
    loop {
        let current = state.active_session_id.load(Ordering::Acquire);
        if current == aborted_session {
            break;
        }
        if current != session_id {
            return;
        }
        if state
            .active_session_id
            .compare_exchange(
                session_id,
                aborted_session,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            break;
        }
    }

    // Keep the state reservation until this session's overlay is gone. If the
    // id were released first, a concurrent start could create the same label
    // and this cleanup path could accidentally close the new overlay.
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.close();
        for _ in 0..50 {
            if app.get_webview_window(OVERLAY_LABEL).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let _ = state.active_session_id.compare_exchange(
        aborted_session,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

#[cfg(windows)]
async fn create_overlay(
    main_window: &WebviewWindow,
    app: &AppHandle,
    config: &ConfigState,
    state: Arc<ScreenCaptureState>,
    session_id: u32,
) -> Result<(), String> {
    let monitor = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Windows could not determine the current monitor".to_string())?;
    let monitor_position = *monitor.position();
    let monitor_size = *monitor.size();
    let logical_size = monitor_size.to_logical::<f64>(monitor.scale_factor());
    let config = config.get().await;
    if state.active_session_id.load(Ordering::Acquire) != session_id {
        return Err("The screen capture session was cancelled before startup".to_string());
    }

    // Synchronize the main window immediately. The regular preference path is
    // intentionally delayed for startup rendering, which would otherwise leave
    // a short race after toggling Hide from screen recording.
    if let Err(error) = set_window_capture_exclusion(main_window, config.hide_app) {
        if config.hide_app {
            return Err(error);
        }
        log::warn!(target: "screen-capture", "Could not clear main-window capture exclusion: {error}");
    }

    let overlay = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("screenshot.html".into()),
    )
    .title("Capture screenshot")
    .inner_size(logical_size.width, logical_size.height)
    .visible(false)
    .focused(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .content_protected(config.hide_app)
    .initialization_script(format!(
        "Object.defineProperty(window, '__XEXAMAI_SCREEN_CAPTURE_SESSION_ID__', {{ value: {session_id} }});"
    ))
    .build()
    .map_err(|error| format!("Could not create the screen capture overlay: {error}"))?;

    overlay
        .set_position(PhysicalPosition::new(
            monitor_position.x,
            monitor_position.y,
        ))
        .map_err(|error| format!("Could not position the screen capture overlay: {error}"))?;
    overlay
        .set_size(PhysicalSize::new(monitor_size.width, monitor_size.height))
        .map_err(|error| format!("Could not size the screen capture overlay: {error}"))?;

    // Tauri's content_protected flag is useful across platforms, while the
    // checked Win32 call guarantees there is no visible privacy-breaking flash.
    if config.hide_app {
        set_window_capture_exclusion(&overlay, true)?;
    }

    let app_for_destroy = app.clone();
    let state_for_destroy = state.clone();
    overlay.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            cancel_active_session(&app_for_destroy, &state_for_destroy, None, session_id);
        }
    });
    state
        .active_session_id
        .compare_exchange(
            session_id,
            session_id | SESSION_SELECTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| "The screen capture session is no longer active".to_string())?;

    Ok(())
}

fn cancel_active_session(
    app: &AppHandle,
    state: &ScreenCaptureState,
    overlay: Option<&WebviewWindow>,
    session_id: u32,
) -> bool {
    let aborted_session = session_id | SESSION_ABORTED;
    loop {
        let current = state.active_session_id.load(Ordering::Acquire);
        let (next, keep_alive) = match cancellation_transition(current, session_id) {
            Some(CancellationTransition::AbortPreparation) => (aborted_session, false),
            Some(CancellationTransition::CloseOverlay) => (0, false),
            Some(CancellationTransition::AbortCapture) => (aborted_session, true),
            Some(CancellationTransition::AlreadyAborted) => {
                if let Some(overlay) = overlay {
                    let _ = overlay.hide();
                }
                return true;
            }
            None => return false,
        };
        if state
            .active_session_id
            .compare_exchange(current, next, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            continue;
        }

        let _ = app.emit_to("main", EVENT_CANCELLED, session_id);
        if let Some(overlay) = overlay {
            // Once GDI capture has started, keep the hidden WebView alive until
            // its command future performs native cleanup. Preparing/selecting
            // overlays have no background capture work and can close now.
            if keep_alive {
                let _ = overlay.hide();
            } else {
                let _ = overlay.close();
            }
        }
        return true;
    }
}

fn fail_active_session(
    app: &AppHandle,
    state: &ScreenCaptureState,
    overlay: &WebviewWindow,
    session_id: u32,
    message: String,
) {
    let failed = loop {
        let current = state.active_session_id.load(Ordering::Acquire);
        if current != session_id && current != (session_id | SESSION_SELECTING) {
            break false;
        }
        if state
            .active_session_id
            .compare_exchange(current, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            break true;
        }
    };
    if failed {
        let _ = app.emit_to(
            "main",
            EVENT_ERROR,
            ScreenCaptureError {
                session_id,
                message: message.clone(),
            },
        );
    }
    log::warn!(target: "screen-capture", "{message}");
    let _ = overlay.close();
}

#[cfg(windows)]
pub(crate) fn set_window_capture_exclusion(
    window: &WebviewWindow,
    excluded: bool,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let affinity = if excluded {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe { SetWindowDisplayAffinity(HWND(hwnd.0), affinity) }
        .map_err(|error| format!("Windows could not update screen-capture privacy: {error}"))
}

#[cfg(windows)]
fn capture_windows_monitor(
    hwnd_value: usize,
    region: Option<ScreenCaptureRegion>,
) -> Result<ScreenCapture, String> {
    use std::ffi::c_void;
    use std::mem::size_of;

    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::{ExtendedColorType, RgbImage};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };

    let hwnd = HWND(hwnd_value as *mut c_void);
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_invalid() {
        return Err("Windows could not determine the current monitor".to_string());
    }

    let mut monitor_info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return Err("Windows could not read the current monitor bounds".to_string());
    }

    let bounds = monitor_info.rcMonitor;
    let monitor_width = bounds.right - bounds.left;
    let monitor_height = bounds.bottom - bounds.top;
    if monitor_width <= 0 || monitor_height <= 0 {
        return Err("Windows returned invalid monitor bounds".to_string());
    }
    let capture_rect = normalized_region_to_pixels(region, monitor_width, monitor_height)?;
    let source_left = bounds.left + capture_rect.left;
    let source_top = bounds.top + capture_rect.top;
    let source_width = capture_rect.width;
    let source_height = capture_rect.height;

    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err("Windows could not open the screen for capture".to_string());
    }
    let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if memory_dc.is_invalid() {
        unsafe {
            ReleaseDC(None, screen_dc);
        }
        return Err("Windows could not create a screen capture context".to_string());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, source_width, source_height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(None, screen_dc);
        }
        return Err("Windows could not allocate the screen capture bitmap".to_string());
    }

    let previous_object = unsafe { SelectObject(memory_dc, bitmap.into()) };
    if previous_object.is_invalid() {
        unsafe {
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory_dc);
            ReleaseDC(None, screen_dc);
        }
        return Err("Windows could not prepare the screen capture bitmap".to_string());
    }
    let mut bitmap_selected = true;
    let capture_result = (|| -> Result<Vec<u8>, String> {
        unsafe {
            BitBlt(
                memory_dc,
                0,
                0,
                source_width,
                source_height,
                Some(screen_dc),
                source_left,
                source_top,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|error| format!("Windows failed to copy the selected screen area: {error}"))?;
        unsafe {
            SelectObject(memory_dc, previous_object);
        }
        bitmap_selected = false;

        let mut bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: source_width,
                biHeight: -source_height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let byte_len = (source_width as usize)
            .checked_mul(source_height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "Screen capture dimensions are too large".to_string())?;
        let mut bgra = vec![0_u8; byte_len];
        let scan_lines = unsafe {
            GetDIBits(
                memory_dc,
                bitmap,
                0,
                source_height as u32,
                Some(bgra.as_mut_ptr().cast()),
                &mut bitmap_info,
                DIB_RGB_COLORS,
            )
        };
        if scan_lines != source_height {
            return Err("Windows returned an incomplete screen image".to_string());
        }
        Ok(bgra)
    })();

    unsafe {
        if bitmap_selected {
            SelectObject(memory_dc, previous_object);
        }
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory_dc);
        ReleaseDC(None, screen_dc);
    }

    let bgra = capture_result?;
    let rgb_byte_len = (source_width as usize)
        .checked_mul(source_height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "Screen capture dimensions are too large".to_string())?;
    let mut rgb = Vec::with_capacity(rgb_byte_len);
    for pixel in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let source = RgbImage::from_raw(source_width as u32, source_height as u32, rgb)
        .ok_or_else(|| "Could not assemble the captured screen image".to_string())?;
    let scale =
        (MAX_CAPTURE_DIMENSION as f64 / f64::from(source.width().max(source.height()))).min(1.0);
    let width = (f64::from(source.width()) * scale).round().max(1.0) as u32;
    let height = (f64::from(source.height()) * scale).round().max(1.0) as u32;
    let frame = if width == source.width() && height == source.height() {
        source
    } else {
        image::imageops::resize(&source, width, height, FilterType::Triangle)
    };

    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, JPEG_QUALITY)
        .encode(
            frame.as_raw(),
            frame.width(),
            frame.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| format!("Could not encode the captured screen: {error}"))?;

    Ok(ScreenCapture {
        // Filled by the async command after capture. Keeping session identity
        // in the delivered payload prevents a late native event from settling
        // a newer renderer request.
        session_id: 0,
        base64: base64::engine::general_purpose::STANDARD.encode(encoded),
        width: frame.width(),
        height: frame.height(),
        mime: "image/jpeg".to_string(),
    })
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PixelCaptureRect {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

#[cfg(any(windows, test))]
fn normalized_region_to_pixels(
    region: Option<ScreenCaptureRegion>,
    monitor_width: i32,
    monitor_height: i32,
) -> Result<PixelCaptureRect, String> {
    if monitor_width <= 0 || monitor_height <= 0 {
        return Err("Screen capture monitor dimensions are invalid".to_string());
    }

    let Some(region) = region else {
        return Ok(PixelCaptureRect {
            left: 0,
            top: 0,
            width: monitor_width,
            height: monitor_height,
        });
    };
    if ![region.x, region.y, region.width, region.height]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err("The selected screen area is invalid".to_string());
    }
    if region.width <= 0.0 || region.height <= 0.0 {
        return Err("The selected screen area is empty".to_string());
    }

    let left_ratio = region.x.clamp(0.0, 1.0);
    let top_ratio = region.y.clamp(0.0, 1.0);
    let right_ratio = (region.x + region.width).clamp(0.0, 1.0);
    let bottom_ratio = (region.y + region.height).clamp(0.0, 1.0);
    if right_ratio <= left_ratio || bottom_ratio <= top_ratio {
        return Err("The selected screen area is outside the monitor".to_string());
    }

    let left = (left_ratio * f64::from(monitor_width)).floor() as i32;
    let top = (top_ratio * f64::from(monitor_height)).floor() as i32;
    let right = (right_ratio * f64::from(monitor_width)).ceil() as i32;
    let bottom = (bottom_ratio * f64::from(monitor_height)).ceil() as i32;
    Ok(PixelCaptureRect {
        left,
        top,
        width: (right - left).max(1),
        height: (bottom - top).max(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_monitor_region_preserves_physical_dimensions() {
        assert_eq!(
            normalized_region_to_pixels(None, 2560, 1440).unwrap(),
            PixelCaptureRect {
                left: 0,
                top: 0,
                width: 2560,
                height: 1440,
            }
        );
    }

    #[test]
    fn normalized_region_rounds_outward_without_losing_edge_pixels() {
        let region = ScreenCaptureRegion {
            x: 0.1,
            y: 0.2,
            width: 0.5,
            height: 0.25,
        };
        assert_eq!(
            normalized_region_to_pixels(Some(region), 1920, 1080).unwrap(),
            PixelCaptureRect {
                left: 192,
                top: 216,
                width: 960,
                height: 270,
            }
        );
    }

    #[test]
    fn normalized_region_is_clamped_to_monitor_bounds() {
        let region = ScreenCaptureRegion {
            x: -0.1,
            y: 0.8,
            width: 0.4,
            height: 0.4,
        };
        assert_eq!(
            normalized_region_to_pixels(Some(region), 1000, 500).unwrap(),
            PixelCaptureRect {
                left: 0,
                top: 400,
                width: 301,
                height: 100,
            }
        );
    }

    #[test]
    fn invalid_region_is_rejected() {
        let region = ScreenCaptureRegion {
            x: 0.5,
            y: 0.5,
            width: f64::NAN,
            height: 0.2,
        };
        assert!(normalized_region_to_pixels(Some(region), 1920, 1080).is_err());
    }

    #[test]
    fn cancellation_transitions_are_session_scoped() {
        let session_id = 42;
        assert_eq!(
            cancellation_transition(session_id, session_id),
            Some(CancellationTransition::AbortPreparation)
        );
        assert_eq!(
            cancellation_transition(session_id | SESSION_SELECTING, session_id),
            Some(CancellationTransition::CloseOverlay)
        );
        assert_eq!(
            cancellation_transition(session_id | SESSION_CAPTURING, session_id),
            Some(CancellationTransition::AbortCapture)
        );
        assert_eq!(
            cancellation_transition(session_id | SESSION_ABORTED, session_id),
            Some(CancellationTransition::AlreadyAborted)
        );
        assert_eq!(cancellation_transition(session_id + 1, session_id), None);
        assert_eq!(
            cancellation_transition((session_id + 1) | SESSION_CAPTURING, session_id),
            None
        );
    }

    #[test]
    fn screen_capture_session_ids_cannot_overlap_phase_bits() {
        assert!(validate_session_id(1).is_ok());
        assert!(validate_session_id(SESSION_ID_MASK).is_ok());
        assert!(validate_session_id(0).is_err());
        assert!(validate_session_id(SESSION_ID_MASK + 1).is_err());
    }
}
