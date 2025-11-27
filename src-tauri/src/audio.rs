use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use serde::Serialize;
use std::sync::{mpsc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use windows::{
    core::*,
    Win32::Media::Audio::*,
    Win32::Media::Audio::Endpoints::*,
};

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const DEFAULT_CHANNELS: u16 = 2;
const CHUNK_FRAMES: usize = 2048;

#[derive(Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub kind: String, // "mic" | "system" | "other"
    pub channels: u16,
    pub sample_rate: u32,
}

struct ActiveThread {
    stop_tx: Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
    #[cfg(windows)]
    stop_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

pub struct AudioManager {
    active: Mutex<Option<ActiveThread>>,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    pub fn list_devices(&self) -> Result<Vec<AudioDeviceInfo>> {
        let host = cpal::default_host();
        let mut out = Vec::new();
        
        // List all devices
        // On Windows, WASAPI loopback devices appear as input devices
        for device in host.devices()? {
            if let Ok(info) = build_device_info(&device) {
                out.push(info);
            }
        }
        
        Ok(out)
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(active) = self.active.lock().unwrap().take() {
            #[cfg(windows)]
            {
                // Set stop flag for WASAPI loopback
                if let Some(stop_flag) = active.stop_flag {
                    stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
            let _ = active.stop_tx.send(());
            if let Some(handle) = active.handle {
                let _ = handle.join();
            }
        }
        Ok(())
    }

    pub fn start(&self, app: AppHandle, source: &str, device_id: Option<String>) -> Result<()> {
        self.stop()?;
        let host = cpal::default_host();

        let (stop_tx, stop_rx) = unbounded::<()>();
        let mut devices: Vec<Device> = vec![];
        match source {
            "mic" => {
                if let Some(dev) = find_device_by_id(&host, device_id.as_deref())? {
                    eprintln!("[audio] capture mic device: {}", dev.name().unwrap_or_default());
                    devices.push(dev);
                }
            }
            "system" => {
                // Use WASAPI loopback directly for system audio capture
                #[cfg(windows)]
                {
                    match start_wasapi_loopback_capture(app.clone(), stop_tx.clone()) {
                        Ok(stop_flag) => {
                            // WASAPI loopback started successfully, skip CPAL
                            let mut guard = self.active.lock().unwrap();
                            *guard = Some(ActiveThread {
                                stop_tx,
                                handle: None, // WASAPI runs in its own thread
                                stop_flag: Some(stop_flag),
                            });
                            return Ok(());
                        }
                        Err(e) => {
                            return Err(anyhow!("Failed to start WASAPI loopback capture: {}", e));
                        }
                    }
                }
                #[cfg(not(windows))]
                {
                    // Try CPAL fallback for non-Windows
                    if let Some(dev) = find_system_device(&host, device_id.as_deref())? {
                        eprintln!("[audio] capture system device: {}", dev.name().unwrap_or_default());
                        devices.push(dev);
                    } else {
                        return Err(anyhow!("No system audio device found."));
                    }
                }
            }
            "mixed" => {
                // In mixed mode, use WASAPI loopback for system audio and CPAL for mic
                #[cfg(windows)]
                {
                    // Start WASAPI loopback capture for system audio with channel for mixing
                    let (wasapi_tx, wasapi_rx) = unbounded::<Vec<i16>>();
                    match start_wasapi_loopback_capture_for_mixing(app.clone(), stop_tx.clone(), wasapi_tx.clone()) {
                        Ok(stop_flag) => {
                            // Add WASAPI receiver to the list
                            // We'll handle it specially in the capture loop
                            if let Some(dev) = find_device_by_id(&host, device_id.as_deref())? {
                                eprintln!("[audio] capture mic device: {}", dev.name().unwrap_or_default());
                                devices.push(dev);
                            }
                            
                            // Create a special receiver list that includes WASAPI
                            let app_handle = app.clone();
                            let stop_rx_clone = stop_rx.clone();
                            let (ready_tx, ready_rx) = mpsc::channel::<usize>();
                            
                            let handle = thread::spawn(move || {
                                let mut receivers = Vec::new();
                                let mut configs = Vec::new();
                                let mut streams: Vec<Stream> = Vec::new();
                                
                                // Сначала добавляем микрофон(ы) — это будет «основной» сигнал
                                for device in devices {
                                    let device_name = device.name().unwrap_or_else(|_| "Unknown".into());
                                    let (tx, rx) = unbounded::<Vec<i16>>();
                                    match build_input_stream(device, tx) {
                                        Ok((stream, cfg)) => {
                                            if stream.play().is_ok() {
                                                eprintln!("[audio] Successfully started stream for device: {} (sample_rate: {}, channels: {})", 
                                                    device_name, cfg.sample_rate.0, cfg.channels);
                                                receivers.push(rx);
                                                configs.push(cfg);
                                                streams.push(stream);
                                            } else {
                                                eprintln!("[audio] Failed to play stream for device: {}", device_name);
                                            }
                                        }
                                        Err(err) => eprintln!("[audio] failed to build stream for device {}: {}", device_name, err),
                                    }
                                }
                                
                                // В mixed-режиме системный звук идёт как дополнительный источник
                                receivers.push(wasapi_rx);
                                configs.push(StreamConfig {
                                    channels: DEFAULT_CHANNELS,
                                    sample_rate: cpal::SampleRate(DEFAULT_SAMPLE_RATE),
                                    buffer_size: cpal::BufferSize::Default,
                                });
                                
                                if receivers.is_empty() {
                                    let _ = ready_tx.send(0);
                                    return;
                                }
                                
                                let _ = ready_tx.send(receivers.len());
                                capture_loop(app_handle, receivers, stop_rx_clone, configs);
                                drop(streams);
                            });
                            
                            let count = ready_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(0);
                            if count == 0 {
                                return Err(anyhow!("Failed to start audio capture"));
                            }
                            
                            let mut guard = self.active.lock().unwrap();
                            *guard = Some(ActiveThread {
                                stop_tx,
                                handle: Some(handle),
                                stop_flag: Some(stop_flag),
                            });
                            return Ok(());
                        }
                        Err(e) => {
                            eprintln!("[audio] Failed to start WASAPI loopback for mixed mode: {}", e);
                            eprintln!("[audio] Falling back to CPAL for system audio in mixed mode");
                            // Fall through to CPAL approach
                        }
                    }
                }
                // Fallback: use CPAL for both (may not work well on Windows)
                if let Some(dev) = find_device_by_id(&host, device_id.as_deref())? {
                    eprintln!("[audio] capture mic device: {}", dev.name().unwrap_or_default());
                    devices.push(dev);
                }
                if let Some(dev) = find_system_device(&host, None)? {
                    eprintln!("[audio] capture system device for mixed mode: {}", dev.name().unwrap_or_default());
                    devices.push(dev);
                } else {
                    eprintln!("[audio] Warning: No system audio device found for mixed mode. Only microphone will be captured.");
                }
            }
            _ => return Err(anyhow!("Unknown source")),
        }

        if devices.is_empty() {
            return Err(anyhow!("No capture devices available"));
        }

        let app_handle = app.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<usize>();

        let handle = thread::spawn(move || {
            let mut receivers = Vec::new();
            let mut configs = Vec::new();
            let mut streams: Vec<Stream> = Vec::new();

            for device in devices {
                let device_name = device.name().unwrap_or_else(|_| "Unknown".into());
                let (tx, rx) = unbounded::<Vec<i16>>();
                match build_input_stream(device, tx) {
                    Ok((stream, cfg)) => {
                        if stream.play().is_ok() {
                            eprintln!("[audio] Successfully started stream for device: {} (sample_rate: {}, channels: {})", 
                                device_name, cfg.sample_rate.0, cfg.channels);
                            receivers.push(rx);
                            configs.push(cfg);
                            streams.push(stream);
                        } else {
                            eprintln!("[audio] Failed to play stream for device: {}", device_name);
                        }
                    }
                    Err(err) => eprintln!("[audio] failed to build stream for device {}: {}", device_name, err),
                }
            }

            if receivers.is_empty() {
                let _ = ready_tx.send(0);
                return;
            }

            let _ = ready_tx.send(receivers.len());
            capture_loop(app_handle, receivers, stop_rx, configs);
            drop(streams);
        });

        let count = ready_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(0);
        if count == 0 {
            return Err(anyhow!("Failed to start audio capture"));
        }

        let mut guard = self.active.lock().unwrap();
        *guard = Some(ActiveThread {
            stop_tx,
            handle: Some(handle),
            #[cfg(windows)]
            stop_flag: None,
        });
        Ok(())
    }
}

fn build_device_info(device: &Device) -> Result<AudioDeviceInfo> {
    let name = device.name().unwrap_or_else(|_| "Unknown".into());
    let cfg = device
        .default_input_config()
        .or_else(|_| {
            device
                .supported_input_configs()?
                .next()
                .map(|c| c.with_max_sample_rate())
                .ok_or_else(|| anyhow!("no configs"))
        })?;
    let sample_rate = cfg.sample_rate().0;
    let channels = cfg.channels();
    let lower = name.to_lowercase();
    let kind = if lower.contains("loopback")
        || lower.contains("monitor")
        || lower.contains("stereo mix")
        || lower.contains("blackhole")
        || lower.contains("soundflower")
    {
        "system"
    } else {
        "mic"
    };
    Ok(AudioDeviceInfo {
        id: name.clone(),
        name,
        kind: kind.to_string(),
        channels,
        sample_rate,
    })
}

fn find_device_by_id(host: &cpal::Host, id: Option<&str>) -> Result<Option<Device>> {
    if let Some(target) = id {
        for device in host.devices()? {
            if let Ok(name) = device.name() {
                if name == target {
                    return Ok(Some(device));
                }
            }
        }
    }
    Ok(host.default_input_device())
}

fn find_system_device(host: &cpal::Host, id: Option<&str>) -> Result<Option<Device>> {
    if let Some(target) = id {
        for device in host.devices()? {
            if let Ok(name) = device.name() {
                if name == target {
                    // Verify it's actually a system device
                    let lower = name.to_lowercase();
                    if lower.contains("loopback")
                        || lower.contains("monitor")
                        || lower.contains("stereo mix")
                        || lower.contains("blackhole")
                        || lower.contains("soundflower")
                    {
                        // Check if it has input config
                        if device.default_input_config().is_ok() || device.supported_input_configs().is_ok() {
                            return Ok(Some(device));
                        }
                    }
                }
            }
        }
    }
    
    // On Windows, WASAPI loopback devices appear as input devices
    // They are created from render (output) endpoints
    // CPAL should expose them, but we need to search more thoroughly
    let mut candidates: Vec<(Device, String, u32)> = vec![];
    
    #[cfg(windows)]
    {
        // On Windows 10+, WASAPI automatically creates loopback devices for each output device
        // These appear as input devices with the same name as the output device
        eprintln!("[audio] Searching for WASAPI loopback devices...");
        let mut device_count = 0;
        let mut all_devices_info = Vec::new();
        
        // First pass: collect all devices with their info
        for device in host.devices()? {
            device_count += 1;
            if let Ok(name) = device.name() {
                let lower = name.to_lowercase();
                
                // Check if device has input config (required for capture)
                let has_input = device.default_input_config().is_ok() || {
                    if let Ok(mut configs) = device.supported_input_configs() {
                        configs.next().is_some()
                    } else {
                        false
                    }
                };
                
                // Check if device has output config
                let has_output = device.default_output_config().is_ok() || {
                    if let Ok(mut configs) = device.supported_output_configs() {
                        configs.next().is_some()
                    } else {
                        false
                    }
                };
                
                // Skip obvious microphones by name patterns (including Russian)
                let is_mic = lower.contains("mic") 
                    || lower.contains("microphone") 
                    || lower.contains("headset")
                    || lower.contains("микрофон")
                    || lower.contains("микро");
                
                if is_mic {
                    eprintln!("[audio] Skipping microphone: {} (input: {}, output: {})", name, has_input, has_output);
                    all_devices_info.push((name.clone(), lower, has_input, has_output));
                    continue;
                }
                
                all_devices_info.push((name.clone(), lower.clone(), has_input, has_output));
                
                // On Windows 11, WASAPI loopback devices might not report input config
                // but can still be used for loopback capture if they have output
                // Try to use output devices as loopback candidates
                if !has_input && !has_output {
                    eprintln!("[audio] Skipping device without input or output: {}", name);
                    continue;
                }
                
                // If device has output but no input, it might still be usable as loopback
                // On Windows 11, loopback devices often appear as output-only devices
                // We'll add them to candidates but with lower priority
                if !has_input && has_output {
                    eprintln!("[audio] Found output device (may work as loopback): {} (output: true)", name);
                    // Don't skip - add to candidates with lower priority
                } else if !has_input {
                    // Skip devices without both input and output
                    eprintln!("[audio] Skipping device without input: {} (output: {})", name, has_output);
                    continue;
                }
                
                // Get default output device name for comparison
                let default_output_name = host.default_output_device()
                    .and_then(|d| d.name().ok())
                    .map(|n| n.to_lowercase());
                
                // Priority based on name patterns and output capability
                // On Windows 11, loopback devices often have "(WASAPI)" in the name
                let priority = if lower.contains("loopback") {
                    eprintln!("[audio] Found explicit loopback: {}", name);
                    0
                } else if lower.contains("(wasapi)") && (lower.contains("speakers") || lower.contains("динамики") || lower.contains("headphones") || lower.contains("наушники")) {
                    // Windows 11 loopback devices often named like "Speakers (WASAPI)" or "Динамики (WASAPI)"
                    eprintln!("[audio] Found WASAPI loopback device: {}", name);
                    1
                } else if lower.contains("monitor") {
                    eprintln!("[audio] Found monitor: {}", name);
                    2
                } else if lower.contains("stereo mix") || lower.contains("стерео микшер") {
                    eprintln!("[audio] Found Stereo Mix: {}", name);
                    3
                } else if has_output && has_input {
                    // Device with both input and output is likely a loopback device
                    eprintln!("[audio] Found potential loopback (has both input and output): {}", name);
                    4
                } else if has_output {
                    // Output device might work as loopback even without input config
                    // This is common on Windows 11
                    eprintln!("[audio] Found output device (trying as loopback): {}", name);
                    5
                } else {
                    // On Windows 11, loopback devices might not report output config correctly
                    // Try devices that have common output device names
                    let is_output_device_name = lower.contains("speakers") 
                        || lower.contains("headphones") 
                        || lower.contains("headphone")
                        || lower.contains("динамики") 
                        || lower.contains("наушники")
                        || lower.contains("audio")
                        || lower.contains("sound")
                        || lower.contains("analogue")
                        || lower.contains("focusrite");
                    
                    // Also check if name matches default output device (likely loopback)
                    let matches_default = default_output_name.as_ref()
                        .map(|default| lower.contains(default) || default.contains(&lower))
                        .unwrap_or(false);
                    
                    if is_output_device_name || matches_default {
                        eprintln!("[audio] Found potential loopback (output device name or matches default): {}", name);
                        6
                    } else {
                        eprintln!("[audio] Skipping device (no clear loopback indicators): {}", name);
                        continue;
                    }
                };
                
                candidates.push((device, name, priority));
            }
        }
        
        eprintln!("[audio] Scanned {} total devices, found {} loopback candidates", device_count, candidates.len());
        if candidates.is_empty() {
            eprintln!("[audio] All available input devices:");
            for (name, lower, has_input, has_output) in all_devices_info {
                if has_input {
                    eprintln!("[audio]   - {} (input: true, output: {}, is_mic: {})", 
                        name, has_output, lower.contains("mic") || lower.contains("microphone"));
                }
            }
        }
    }
    
    #[cfg(not(windows))]
    {
        // For non-Windows, use simpler logic
        for device in host.devices()? {
            if let Ok(name) = device.name() {
                let lower = name.to_lowercase();
                let priority = if lower.contains("loopback") {
                    0
                } else if lower.contains("monitor") {
                    1
                } else if lower.contains("stereo mix") {
                    2
                } else if lower.contains("blackhole") || lower.contains("soundflower") {
                    3
                } else {
                    continue;
                };
                
                if device.default_input_config().is_ok() || {
                    if let Ok(mut configs) = device.supported_input_configs() {
                        configs.next().is_some()
                    } else {
                        false
                    }
                } {
                    candidates.push((device, name, priority));
                }
            }
        }
    }
    
    // Sort by priority (lower is better)
    candidates.sort_by_key(|(_, _, priority)| *priority);
    
    if let Some((device, name, _)) = candidates.into_iter().next() {
        eprintln!("[audio] Found system device: {}", name);
        Ok(Some(device))
    } else {
        eprintln!("[audio] No system audio device found. Trying to use default output device as loopback...");
        // Last resort: try to use default output device if it has input capability
        #[cfg(windows)]
        {
            if let Some(default_output) = host.default_output_device() {
                if let Ok(name) = default_output.name() {
                    eprintln!("[audio] Checking default output device: {}", name);
                    // Check if it can be used as input (loopback)
                    if default_output.default_input_config().is_ok() || default_output.supported_input_configs().is_ok() {
                        eprintln!("[audio] Using default output device as loopback: {}", name);
                        return Ok(Some(default_output));
                    }
                }
            }
        }
        eprintln!("[audio] Failed to find system audio device. WASAPI loopback may not be available on this system.");
        Ok(None)
    }
}

fn build_input_stream(device: Device, tx: Sender<Vec<i16>>) -> Result<(Stream, StreamConfig)> {
    let (supported, sample_format) = choose_config(&device)?;
    let mut config: StreamConfig = supported.into();
    if config.sample_rate.0 == 0 {
        config.sample_rate = cpal::SampleRate(DEFAULT_SAMPLE_RATE);
    }

    let err_fn = |err| {
        eprintln!("[audio] stream error: {}", err);
    };

    // Send raw i16 data directly to avoid unnecessary conversions
    // This reduces latency and prevents robotic sound
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                // Convert f32 to i16 directly without intermediate Vec<f32>
                let i16_data: Vec<i16> = data
                    .iter()
                    .map(|&s| {
                        let clamped = s.max(-1.0).min(1.0);
                        (clamped * 32767.0).round() as i16
                    })
                    .collect();
                let _ = tx.try_send(i16_data);
            },
            err_fn,
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                // Send i16 data directly - no conversion needed
                let _ = tx.try_send(data.to_vec());
            },
            err_fn,
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                // Convert u16 to i16
                let i16_data: Vec<i16> = data
                    .iter()
                    .map(|&s| {
                        // u16: 0-65535 -> i16: -32768 to 32767
                        ((s as i32) - 32768) as i16
                    })
                    .collect();
                let _ = tx.try_send(i16_data);
            },
            err_fn,
            None,
        )?,
        _ => return Err(anyhow!("Unsupported sample format")),
    };
    Ok((stream, config))
}

fn choose_config(device: &Device) -> Result<(SupportedStreamConfig, SampleFormat)> {
    // Try input config first
    if let Ok(cfg) = device.default_input_config() {
        let fmt = cfg.sample_format();
        return Ok((cfg, fmt));
    }
    if let Ok(mut configs) = device.supported_input_configs() {
        if let Some(cfg) = configs.next() {
            let fmt = cfg.sample_format();
            return Ok((cfg.with_max_sample_rate(), fmt));
        }
    }
    
    // On Windows, WASAPI loopback devices might not have input config
    // but can still be used for capture. Try to use output config as fallback.
    #[cfg(windows)]
    {
        if let Ok(cfg) = device.default_output_config() {
            // Create a compatible input config from output config
            let fmt = cfg.sample_format();
            let sample_rate = cfg.sample_rate();
            let channels = cfg.channels();
            // Try to create input config with same parameters
            if let Ok(mut input_configs) = device.supported_input_configs() {
                if let Some(input_cfg) = input_configs.find(|c| {
                    c.sample_format() == fmt && c.channels() == channels
                }) {
                    return Ok((input_cfg.with_max_sample_rate(), fmt));
                }
            }
            // If no matching input config, try to use output config directly
            // This might work for WASAPI loopback on Windows 11
            eprintln!("[audio] Warning: Device has no input config, trying to use output config parameters");
            // We can't use output config directly, so return error
        }
    }
    
    Err(anyhow!("No supported input config for device"))
}

fn capture_loop(app: AppHandle, receivers: Vec<Receiver<Vec<i16>>>, stop_rx: Receiver<()>, configs: Vec<StreamConfig>) {
    let output_channels = DEFAULT_CHANNELS as usize;
    let device_channels: Vec<usize> = configs.iter().map(|c| c.channels as usize).collect();
    let sample_rate = configs.get(0).map(|c| c.sample_rate.0).unwrap_or(DEFAULT_SAMPLE_RATE);
    // Коэффициент вклада системного звука в mixed-режиме (для визуального и фактического микса)
    let system_mix_gain: f32 = 0.1;

    if receivers.is_empty() {
        return;
    }

    loop {
        // Wait for first chunk or stop signal
        let first_chunk = select! {
            recv(stop_rx) -> _ => { break; }
            recv(receivers[0]) -> msg => {
                match msg {
                    Ok(buf) => Some(buf),
                    Err(_) => break,
                }
            }
        };
        if first_chunk.is_none() {
            break;
        }
        
        // Process first chunk
        let first_buf = first_chunk.unwrap();
        let first_samples = first_buf.len() / device_channels[0].max(1);
        let mut mixed: Vec<i16> = vec![0i16; first_samples * output_channels];
        
        // Fill first device
        fill_buffer_i16(&mut mixed, &first_buf, device_channels[0], output_channels, first_samples);

        // Process other devices (for mixed mode)
        for (idx, rx) in receivers.iter().enumerate().skip(1) {
            if let Ok(mut buf) = rx.try_recv() {
                let dev_ch = if idx < device_channels.len() { device_channels[idx] } else { 1 };
                let samples = buf.len() / dev_ch.max(1);
                let frames = samples.min(first_samples);

                // Понижаем уровень дополнительных источников (обычно системный звук)
                for s in buf.iter_mut() {
                    let v = (*s as f32) * system_mix_gain;
                    // Клэмпим в диапазон i16
                    *s = v
                        .round()
                        .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                }

                fill_buffer_i16(&mut mixed, &buf, dev_ch, output_channels, frames);
            }
        }

        // Check for clipping and normalize if needed
        let max_amp = mixed.iter().fold(0i32, |acc, &s| acc.max(s.abs() as i32));
        if max_amp > 32767 {
            // Normalize to prevent clipping
            let gain = 32767.0 / max_amp as f32;
            for s in mixed.iter_mut() {
                *s = ((*s as f32) * gain).round() as i16;
            }
        }

        // Send directly as i16 - no unnecessary conversions
        let bytes: &[u8] = bytemuck::cast_slice(&mixed);
        let payload = AudioChunkPayload {
            sample_rate,
            channels: DEFAULT_CHANNELS,
            data_base64: general_purpose::STANDARD.encode(bytes),
        };
        let _ = app.emit("audio:chunk", payload);
    }
}

fn fill_buffer_i16(target: &mut [i16], src: &[i16], src_channels: usize, dst_channels: usize, frames: usize) {
    if src.is_empty() || target.is_empty() || src_channels == 0 || dst_channels == 0 {
        return;
    }
    
    // src is interleaved: [L, R, L, R, ...] for stereo or [M, M, M, ...] for mono
    // target is interleaved: [L, R, L, R, ...] for stereo output
    let frames = frames.min(target.len() / dst_channels).min(src.len() / src_channels);
    
    if src_channels == 1 && dst_channels == 2 {
        // Mono to stereo: duplicate channel
        for i in 0..frames {
            let sample = src[i];
            let base = i * dst_channels;
            if base < target.len() {
                target[base] = target[base].saturating_add(sample);
            }
            if base + 1 < target.len() {
                target[base + 1] = target[base + 1].saturating_add(sample);
            }
        }
    } else if src_channels == dst_channels {
        // Same channel count: add to target (for mixing)
        let samples_to_copy = frames * src_channels;
        let limit = samples_to_copy.min(target.len()).min(src.len());
        for i in 0..limit {
            target[i] = target[i].saturating_add(src[i]);
        }
    } else if src_channels == 2 && dst_channels == 1 {
        // Stereo to mono: average channels
        for i in 0..frames {
            let left_idx = i * src_channels;
            let right_idx = left_idx + 1;
            if left_idx < src.len() && right_idx < src.len() && i < target.len() {
                let avg = ((src[left_idx] as i32 + src[right_idx] as i32) / 2) as i16;
                target[i] = target[i].saturating_add(avg);
            }
        }
    } else {
        // Different channel counts: map channels
        for i in 0..frames {
            for dst_ch in 0..dst_channels {
                let src_ch = dst_ch % src_channels;
                let src_idx = i * src_channels + src_ch;
                let dst_idx = i * dst_channels + dst_ch;
                if src_idx < src.len() && dst_idx < target.len() {
                    target[dst_idx] = target[dst_idx].saturating_add(src[src_idx]);
                }
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct AudioChunkPayload {
    sample_rate: u32,
    channels: u16,
    data_base64: String,
}

#[cfg(windows)]
fn start_wasapi_loopback_capture(app: AppHandle, _stop_tx: Sender<()>) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::Audio::Endpoints::*;
    use windows::Win32::System::Com::*;
    use windows::core::Interface;
    
    let app_clone = app.clone();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    
    thread::spawn(move || {
        unsafe {
            // Initialize COM
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                eprintln!("[audio] Failed to initialize COM");
                return;
            }
            
            eprintln!("[audio] COM initialized");
            
            // Get device enumerator
            let enumerator: IMMDeviceEnumerator = match CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            ) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[audio] Failed to create device enumerator: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            // Get default render (output) device for loopback
            let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[audio] Failed to get default render device: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            // Get device ID for logging
            let device_id = match device.GetId() {
                Ok(id) => id.to_string().unwrap_or_else(|_| "Unknown".to_string()),
                Err(_) => "Unknown".to_string(),
            };
            
            eprintln!("[audio] Using WASAPI loopback device: {}", device_id);
            
            // Activate audio client
            // In Windows API, IMMDevice::Activate is used to get IAudioClient
            // We need to call Activate method directly through COM interface
            let audio_client: IAudioClient = match unsafe {
                // Get raw pointer to IMMDevice
                let device_ptr = device.as_raw() as *mut _;
                // Call Activate method through vtable
                // IMMDevice::Activate signature: HRESULT Activate(REFIID iid, DWORD dwClsCtx, PROPVARIANT *pActivationParams, void **ppInterface)
                type ActivateFn = unsafe extern "system" fn(
                    *mut core::ffi::c_void,
                    *const windows::core::GUID,
                    u32, // CLSCTX
                    *const core::ffi::c_void, // PROPVARIANT (can be NULL)
                    *mut *mut core::ffi::c_void,
                ) -> windows::core::HRESULT;
                
                let vtable = *(device_ptr as *const *const *const core::ffi::c_void);
                // Activate is the 4th method in IMMDevice vtable (after QueryInterface, AddRef, Release)
                let activate_fn = std::mem::transmute::<*const core::ffi::c_void, ActivateFn>(
                    *vtable.add(3)
                );
                
                let mut result: *mut core::ffi::c_void = std::ptr::null_mut();
                let hr = activate_fn(
                    device_ptr,
                    &IAudioClient::IID,
                    CLSCTX_ALL.0,
                    std::ptr::null(),
                    &mut result,
                );
                
                if hr.is_ok() && !result.is_null() {
                    Ok(IAudioClient::from_raw(result as *mut _))
                } else {
                    Err(hr)
                }
            } {
                Ok(ac) => ac,
                Err(e) => {
                    eprintln!("[audio] Failed to activate audio client: {:?}", e);
                    eprintln!("[audio] Falling back to CPAL for system audio capture");
                    CoUninitialize();
                    return;
                }
            };
            
            // Get mix format
            let mix_format_ptr = match audio_client.GetMixFormat() {
                Ok(ptr) => ptr,
                Err(e) => {
                    eprintln!("[audio] Failed to get mix format: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            if mix_format_ptr.is_null() {
                eprintln!("[audio] Mix format pointer is null");
                CoUninitialize();
                return;
            }
            
            // Check if it's WAVEFORMATEXTENSIBLE
            let mix_format = *mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels as u16;
            let bits_per_sample = mix_format.wBitsPerSample;
            let block_align = mix_format.nBlockAlign as usize;
            
            // Determine actual bits per sample
            // For WAVEFORMATEXTENSIBLE, wBitsPerSample in WAVEFORMATEX is usually 0 or invalid
            // We need to use the value from the extended structure
            let actual_bits_per_sample = if mix_format.wFormatTag == 0xFFFE && mix_format.cbSize >= 22 {
                // It's WAVEFORMATEXTENSIBLE, read the extended structure
                // In WAVEFORMATEXTENSIBLE, the actual bits per sample is at offset 22 (wValidBitsPerSample)
                // But we should use wBitsPerSample from WAVEFORMATEX if it's valid, otherwise read from extended
                if bits_per_sample > 0 && bits_per_sample <= 32 {
                    bits_per_sample
                } else {
                    // Read from extended structure at offset 22 (wValidBitsPerSample)
                    let ext_ptr = mix_format_ptr as *const u8;
                    let valid_bits_ptr = unsafe { ext_ptr.add(22) as *const u16 };
                    let valid_bits = unsafe { *valid_bits_ptr };
                    if valid_bits > 0 && valid_bits <= 32 {
                        valid_bits
                    } else {
                        // Default to 16 if we can't determine
                        16
                    }
                }
            } else {
                // Standard WAVEFORMATEX, use wBitsPerSample directly
                if bits_per_sample > 0 && bits_per_sample <= 32 {
                    bits_per_sample
                } else {
                    // Default to 16 if invalid
                    16
                }
            };
            
            eprintln!("[audio] WASAPI format: sample_rate={}, channels={}, bits_per_sample={}", 
                sample_rate, channels, actual_bits_per_sample);
            
            // Initialize audio client in loopback mode
            // REFTIMES_PER_SEC = 10,000,000 (100ns units)
            // Use 0 for buffer duration to let system choose optimal value
            let buffer_duration = 0; // Let system choose optimal buffer size
            let hr = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            );
            
            if hr.is_err() {
                eprintln!("[audio] Failed to initialize WASAPI loopback client: {:?}", hr);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                CoUninitialize();
                return;
            }
            
            eprintln!("[audio] WASAPI loopback client initialized");
            
            // Get buffer size
            let buffer_frames = match audio_client.GetBufferSize() {
                Ok(frames) => frames,
                Err(e) => {
                    eprintln!("[audio] Failed to get buffer frames: {:?}", e);
                    CoTaskMemFree(Some(mix_format_ptr as *const _));
                    CoUninitialize();
                    return;
                }
            };
            
            eprintln!("[audio] WASAPI buffer frames: {}", buffer_frames);
            
            // Get capture client
            let capture_client: IAudioCaptureClient = match audio_client.GetService::<IAudioCaptureClient>() {
                Ok(cc) => cc,
                Err(e) => {
                    eprintln!("[audio] Failed to get capture client: {:?}", e);
                    CoTaskMemFree(Some(mix_format_ptr as *const _));
                    CoUninitialize();
                    return;
                }
            };
            
            // Start capture
            let hr = audio_client.Start();
            if hr.is_err() {
                eprintln!("[audio] Failed to start WASAPI loopback stream: {:?}", hr);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                CoUninitialize();
                return;
            }
            
            eprintln!("[audio] WASAPI loopback stream started");
            
            // Capture loop
            let stop_flag_capture = stop_flag_clone.clone();
            loop {
                // Check for stop signal
                if stop_flag_capture.load(Ordering::Relaxed) {
                    eprintln!("[audio] WASAPI loopback capture stopped by signal");
                    break;
                }
                
                // Get available data
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut available_frames: u32 = 0;
                let mut flags: u32 = 0;
                let mut device_position: u64 = 0;
                let mut qpc_position: u64 = 0;
                
                let hr = capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut available_frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                );
                
                if hr.is_err() || data_ptr.is_null() || available_frames == 0 {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                
                // Convert to i16 samples
                // Calculate bytes per frame
                let bytes_per_frame = (actual_bits_per_sample / 8) * channels as u16;
                let total_bytes = available_frames as usize * bytes_per_frame as usize;
                
                let samples: Vec<i16> = match actual_bits_per_sample {
                    16 => {
                        // Data is already i16
                        let data_slice = std::slice::from_raw_parts(
                            data_ptr as *const i16,
                            available_frames as usize * channels as usize
                        );
                        data_slice.to_vec()
                    }
                    32 => {
                        // Data is f32, convert to i16
                        let float_slice = std::slice::from_raw_parts(
                            data_ptr as *const f32,
                            available_frames as usize * channels as usize
                        );
                        float_slice.iter()
                            .map(|&f| {
                                let clamped = f.max(-1.0).min(1.0);
                                (clamped * 32767.0).round() as i16
                            })
                            .collect()
                    }
                    _ => {
                        eprintln!("[audio] Unsupported bits per sample: {}, trying to convert from bytes", actual_bits_per_sample);
                        // Try to read as raw bytes and convert
                        let bytes_slice = std::slice::from_raw_parts(data_ptr, total_bytes);
                        // For now, just skip unsupported formats
                        let _ = capture_client.ReleaseBuffer(available_frames);
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };
                
                // Release buffer
                let _ = capture_client.ReleaseBuffer(available_frames);
                
                if samples.is_empty() {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                
                // Send chunk
                let bytes: &[u8] = bytemuck::cast_slice(&samples);
                let payload = AudioChunkPayload {
                    sample_rate,
                    channels,
                    data_base64: general_purpose::STANDARD.encode(bytes),
                };
                let _ = app_clone.emit("audio:chunk", payload);
            }
            
            // Cleanup
            let _ = audio_client.Stop();
            CoTaskMemFree(Some(mix_format_ptr as *const _));
            CoUninitialize();
            
            eprintln!("[audio] WASAPI loopback capture thread ended");
        }
    });
    
    Ok(stop_flag)
}

#[cfg(windows)]
fn start_wasapi_loopback_capture_for_mixing(
    app: AppHandle, 
    _stop_tx: Sender<()>,
    tx: Sender<Vec<i16>>,
) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::Audio::Endpoints::*;
    use windows::Win32::System::Com::*;
    use windows::core::Interface;
    
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    
    thread::spawn(move || {
        unsafe {
            // Initialize COM
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                eprintln!("[audio] Failed to initialize COM");
                return;
            }
            
            eprintln!("[audio] COM initialized for mixed mode");
            
            // Get device enumerator
            let enumerator: IMMDeviceEnumerator = match CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            ) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[audio] Failed to create device enumerator: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            // Get default render (output) device for loopback
            let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[audio] Failed to get default render device: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            // Activate audio client
            let audio_client: IAudioClient = match unsafe {
                let device_ptr = device.as_raw() as *mut _;
                type ActivateFn = unsafe extern "system" fn(
                    *mut core::ffi::c_void,
                    *const windows::core::GUID,
                    u32,
                    *const core::ffi::c_void,
                    *mut *mut core::ffi::c_void,
                ) -> windows::core::HRESULT;
                
                let vtable = *(device_ptr as *const *const *const core::ffi::c_void);
                let activate_fn = std::mem::transmute::<*const core::ffi::c_void, ActivateFn>(
                    *vtable.add(3)
                );
                
                let mut result: *mut core::ffi::c_void = std::ptr::null_mut();
                let hr = activate_fn(
                    device_ptr,
                    &IAudioClient::IID,
                    CLSCTX_ALL.0,
                    std::ptr::null(),
                    &mut result,
                );
                
                if hr.is_ok() && !result.is_null() {
                    Ok(IAudioClient::from_raw(result as *mut _))
                } else {
                    Err(hr)
                }
            } {
                Ok(ac) => ac,
                Err(e) => {
                    eprintln!("[audio] Failed to activate audio client: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            // Get mix format
            let mix_format_ptr = match audio_client.GetMixFormat() {
                Ok(ptr) => ptr,
                Err(e) => {
                    eprintln!("[audio] Failed to get mix format: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };
            
            if mix_format_ptr.is_null() {
                eprintln!("[audio] Mix format pointer is null");
                CoUninitialize();
                return;
            }
            
            let mix_format = *mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels as u16;
            let bits_per_sample = mix_format.wBitsPerSample;
            
            let actual_bits_per_sample = if mix_format.wFormatTag == 0xFFFE && mix_format.cbSize >= 22 {
                if bits_per_sample > 0 && bits_per_sample <= 32 {
                    bits_per_sample
                } else {
                    let ext_ptr = mix_format_ptr as *const u8;
                    let valid_bits_ptr = unsafe { ext_ptr.add(22) as *const u16 };
                    let valid_bits = unsafe { *valid_bits_ptr };
                    if valid_bits > 0 && valid_bits <= 32 {
                        valid_bits
                    } else {
                        16
                    }
                }
            } else {
                if bits_per_sample > 0 && bits_per_sample <= 32 {
                    bits_per_sample
                } else {
                    16
                }
            };
            
            eprintln!("[audio] WASAPI format for mixing: sample_rate={}, channels={}, bits_per_sample={}", 
                sample_rate, channels, actual_bits_per_sample);
            
            // Initialize audio client in loopback mode
            let buffer_duration = 0;
            let hr = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            );
            
            if hr.is_err() {
                eprintln!("[audio] Failed to initialize WASAPI loopback client: {:?}", hr);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                CoUninitialize();
                return;
            }
            
            // Get buffer size
            let buffer_frames = match audio_client.GetBufferSize() {
                Ok(frames) => frames,
                Err(e) => {
                    eprintln!("[audio] Failed to get buffer frames: {:?}", e);
                    CoTaskMemFree(Some(mix_format_ptr as *const _));
                    CoUninitialize();
                    return;
                }
            };
            
            // Get capture client
            let capture_client: IAudioCaptureClient = match audio_client.GetService::<IAudioCaptureClient>() {
                Ok(cc) => cc,
                Err(e) => {
                    eprintln!("[audio] Failed to get capture client: {:?}", e);
                    CoTaskMemFree(Some(mix_format_ptr as *const _));
                    CoUninitialize();
                    return;
                }
            };
            
            // Start capture
            let hr = audio_client.Start();
            if hr.is_err() {
                eprintln!("[audio] Failed to start WASAPI loopback stream: {:?}", hr);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                CoUninitialize();
                return;
            }
            
            eprintln!("[audio] WASAPI loopback stream started for mixing");
            
            // Capture loop - send to channel instead of emitting directly
            let stop_flag_capture = stop_flag_clone.clone();
            loop {
                if stop_flag_capture.load(Ordering::Relaxed) {
                    eprintln!("[audio] WASAPI loopback capture stopped by signal");
                    break;
                }
                
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut available_frames: u32 = 0;
                let mut flags: u32 = 0;
                let mut device_position: u64 = 0;
                let mut qpc_position: u64 = 0;
                
                let hr = capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut available_frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                );
                
                if hr.is_err() || data_ptr.is_null() || available_frames == 0 {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                
                let bytes_per_frame = (actual_bits_per_sample / 8) * channels as u16;
                let total_bytes = available_frames as usize * bytes_per_frame as usize;
                
                let samples: Vec<i16> = match actual_bits_per_sample {
                    16 => {
                        let data_slice = std::slice::from_raw_parts(
                            data_ptr as *const i16,
                            available_frames as usize * channels as usize
                        );
                        data_slice.to_vec()
                    }
                    32 => {
                        let float_slice = std::slice::from_raw_parts(
                            data_ptr as *const f32,
                            available_frames as usize * channels as usize
                        );
                        float_slice.iter()
                            .map(|&f| {
                                let clamped = f.max(-1.0).min(1.0);
                                (clamped * 32767.0).round() as i16
                            })
                            .collect()
                    }
                    _ => {
                        let _ = capture_client.ReleaseBuffer(available_frames);
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };
                
                let _ = capture_client.ReleaseBuffer(available_frames);
                
                if samples.is_empty() {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                
                // Send to channel for mixing instead of emitting directly
                let _ = tx.send(samples);
            }
            
            // Cleanup
            let _ = audio_client.Stop();
            CoTaskMemFree(Some(mix_format_ptr as *const _));
            CoUninitialize();
            
            eprintln!("[audio] WASAPI loopback capture thread ended for mixing");
        }
    });
    
    Ok(stop_flag)
}
