use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use serde::Serialize;
use std::sync::{mpsc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

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

        let mut devices: Vec<Device> = vec![];
        match source {
            "mic" => {
                if let Some(dev) = find_device_by_id(&host, device_id.as_deref())? {
                    eprintln!("[audio] capture mic device: {}", dev.name().unwrap_or_default());
                    devices.push(dev);
                }
            }
            "system" => {
                // System audio capture is handled by browser getDisplayMedia
                // This should not be called for system mode
                return Err(anyhow!("System audio capture must be handled by browser getDisplayMedia"));
            }
            "mixed" => {
                if let Some(dev) = find_device_by_id(&host, device_id.as_deref())? {
                    eprintln!("[audio] capture mic device: {}", dev.name().unwrap_or_default());
                    devices.push(dev);
                }
                // System audio for mixed mode is handled by browser getDisplayMedia
                eprintln!("[audio] System audio for mixed mode will be handled by browser getDisplayMedia");
            }
            _ => return Err(anyhow!("Unknown source")),
        }

        if devices.is_empty() {
            return Err(anyhow!("No capture devices available"));
        }

        let (stop_tx, stop_rx) = unbounded::<()>();
        let app_handle = app.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<usize>();

        let handle = thread::spawn(move || {
            let mut receivers = Vec::new();
            let mut configs = Vec::new();
            let mut streams: Vec<Stream> = Vec::new();

            for device in devices {
                let (tx, rx) = unbounded::<Vec<i16>>();
                match build_input_stream(device, tx) {
                    Ok((stream, cfg)) => {
                        if stream.play().is_ok() {
                            receivers.push(rx);
                            configs.push(cfg);
                            streams.push(stream);
                        }
                    }
                    Err(err) => eprintln!("[audio] failed to build stream: {err}"),
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
                
                // Skip obvious microphones by name
                if lower.contains("mic") || lower.contains("microphone") || lower.contains("headset") {
                    eprintln!("[audio] Skipping microphone: {} (input: {}, output: {})", name, has_input, has_output);
                    all_devices_info.push((name.clone(), lower, has_input, has_output));
                    continue;
                }
                
                all_devices_info.push((name.clone(), lower.clone(), has_input, has_output));
                
                if !has_input {
                    eprintln!("[audio] Skipping device without input: {} (output: {})", name, has_output);
                    continue;
                }
                
                // Priority based on name patterns and output capability
                let priority = if lower.contains("loopback") {
                    eprintln!("[audio] Found explicit loopback: {}", name);
                    0
                } else if lower.contains("monitor") {
                    eprintln!("[audio] Found monitor: {}", name);
                    1
                } else if lower.contains("stereo mix") {
                    eprintln!("[audio] Found Stereo Mix: {}", name);
                    2
                } else if has_output {
                    // Device with both input and output is likely a loopback device
                    eprintln!("[audio] Found potential loopback (has output): {}", name);
                    3
                } else {
                    // On Windows 11, some loopback devices might not report output config correctly
                    // Try devices that don't look like microphones and have common output device names
                    if lower.contains("speakers") || lower.contains("headphones") || lower.contains("headphone") 
                        || lower.contains("динамики") || lower.contains("наушники") {
                        eprintln!("[audio] Found potential loopback (output device name): {}", name);
                        4
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
        eprintln!("[audio] No system audio device found. On Windows, you may need to enable 'Stereo Mix' in sound settings (Right-click sound icon -> Sounds -> Recording tab -> Enable 'Stereo Mix') or install a virtual audio device like VB-Audio Cable.");
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
    if let Ok(cfg) = device.default_input_config() {
        let fmt = cfg.sample_format();
        return Ok((cfg, fmt));
    }
    let mut configs = device.supported_input_configs()?;
    if let Some(cfg) = configs.next() {
        let fmt = cfg.sample_format();
        return Ok((cfg.with_max_sample_rate(), fmt));
    }
    Err(anyhow!("No supported input config"))
}

fn capture_loop(app: AppHandle, receivers: Vec<Receiver<Vec<i16>>>, stop_rx: Receiver<()>, configs: Vec<StreamConfig>) {
    let output_channels = DEFAULT_CHANNELS as usize;
    let device_channels: Vec<usize> = configs.iter().map(|c| c.channels as usize).collect();
    let sample_rate = configs.get(0).map(|c| c.sample_rate.0).unwrap_or(DEFAULT_SAMPLE_RATE);

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
            if let Ok(buf) = rx.try_recv() {
                let dev_ch = if idx < device_channels.len() { device_channels[idx] } else { 1 };
                let samples = buf.len() / dev_ch.max(1);
                let frames = samples.min(first_samples);
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
