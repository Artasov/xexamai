use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    ipc::{Channel, InvokeResponseBody, IpcResponse},
    AppHandle, Emitter,
};

#[path = "audio_processing.rs"]
mod audio_processing;
#[cfg(windows)]
#[path = "wasapi_capture.rs"]
mod wasapi_capture;

use audio_processing::{
    downmix_to_stereo, quantize_i16, AudioFrame, MixedAudioEngine, MIX_SAMPLE_RATE, OUTPUT_CHANNELS,
};
#[cfg(windows)]
use wasapi_capture::spawn_wasapi_source;

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const AUDIO_START_TIMEOUT: Duration = Duration::from_secs(5);
const MIX_STARTUP_GRACE: Duration = Duration::from_millis(80);
const MIC_MIX_GAIN: f32 = 1.0;
const SYSTEM_MIX_GAIN: f32 = 0.35;

#[cfg(target_os = "macos")]
const SYSTEM_DEVICE_KEYWORDS: &[&str] = &[
    "blackhole",
    "loopback",
    "soundflower",
    "vb-audio",
    "aggregate",
    "multi-output",
];
#[cfg(target_os = "linux")]
const SYSTEM_DEVICE_KEYWORDS: &[&str] = &[
    "monitor",
    "pulse",
    "pipewire",
    "null sink",
    "pavucontrol",
    "alsa_output",
];
#[cfg(windows)]
const SYSTEM_DEVICE_KEYWORDS: &[&str] = &[
    "loopback",
    "(wasapi)",
    "monitor",
    "stereo mix",
    "динамики",
    "headphones",
];

#[cfg(not(windows))]
fn is_probable_mic(lower: &str) -> bool {
    lower.contains("mic")
        || lower.contains("microphone")
        || lower.contains("headset")
        || lower.contains("микрофон")
        || lower.contains("микро")
        || lower.contains("airpods")
        || lower.contains("webcam")
}

fn is_system_device_name(lower: &str) -> bool {
    SYSTEM_DEVICE_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

#[cfg(target_os = "macos")]
fn system_device_priority(lower: &str) -> Option<usize> {
    if lower.contains("blackhole") {
        Some(0)
    } else if lower.contains("loopback") {
        Some(1)
    } else if lower.contains("soundflower") {
        Some(2)
    } else if lower.contains("vb-audio") || lower.contains("virtual") {
        Some(3)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn system_device_priority(lower: &str) -> Option<usize> {
    if lower.contains("monitor") {
        Some(0)
    } else if lower.contains("pulse") || lower.contains("pipewire") {
        Some(1)
    } else if lower.contains("null") && lower.contains("sink") {
        Some(2)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn system_audio_help_message() -> &'static str {
    "No virtual device is available for system-audio capture. \
Install BlackHole (https://existential.audio/blackhole/) or an equivalent driver \
(Loopback / Soundflower), create a Multi-Output Device, select it for system output, \
and restart XexamAI."
}

#[cfg(target_os = "linux")]
fn system_audio_help_message() -> &'static str {
    "No PulseAudio/PipeWire monitor is available. Enable a virtual sink/monitor \
(for example, `pactl load-module module-null-sink sink_name=VirtualSink`), select \
`VirtualSink.monitor` as the input, and restart XexamAI."
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn system_audio_help_message() -> &'static str {
    "The system-audio device is unavailable. Verify that the output device is working \
and restart XexamAI."
}

#[derive(Clone, Serialize, specta::Type)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub kind: AudioDeviceKind,
    pub channels: u16,
    pub sample_rate: u32,
}

#[allow(dead_code)]
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AudioDeviceKind {
    Mic,
    System,
    Other,
}

/// Preserves Tauri's raw binary channel transport while exposing the payload as
/// a `Uint8Array` in generated TypeScript bindings.
#[derive(specta::Type)]
#[specta(type = bytes::Bytes)]
pub struct AudioChunk(Vec<u8>);

impl IpcResponse for AudioChunk {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(self.0.into())
    }
}

struct ActiveCapture {
    generation: u64,
    source: String,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl ActiveCapture {
    fn stop(self) -> Result<()> {
        self.cancel.store(true, Ordering::Release);
        let mut panicked = false;
        for handle in self.handles {
            if handle.join().is_err() {
                panicked = true;
            }
        }
        emit_audio_state(&self.app, self.generation, &self.source, "stopped", None);
        if panicked {
            Err(anyhow!("An audio worker terminated unexpectedly"))
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct AudioLifecycle {
    next_generation: u64,
    active: Option<ActiveCapture>,
}

pub struct AudioManager {
    lifecycle: Mutex<AudioLifecycle>,
}

#[derive(Debug, Clone, Copy)]
struct SourceReady {
    sample_rate: u32,
    channels: u16,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            lifecycle: Mutex::new(AudioLifecycle::default()),
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

    /// Fail closed if the lifecycle mutex was poisoned: update/install callers must
    /// never assume it is safe to terminate while capture state is uncertain.
    pub fn is_active(&self) -> bool {
        self.lifecycle
            .lock()
            .map(|lifecycle| lifecycle.active.is_some())
            .unwrap_or(true)
    }

    pub fn stop(&self) -> Result<()> {
        let active = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow!("Audio lifecycle lock is poisoned"))?
            .active
            .take();
        if let Some(active) = active {
            active.stop()?;
        }
        Ok(())
    }

    pub fn start(
        &self,
        app: AppHandle,
        source: &str,
        device_id: Option<String>,
        chunk_channel: Channel<AudioChunk>,
    ) -> Result<()> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow!("Audio lifecycle lock is poisoned"))?;

        let source = match source {
            "mic" | "system" | "mixed" => source,
            _ => return Err(anyhow!("Unknown audio source: {source}")),
        };
        lifecycle.next_generation = lifecycle.next_generation.wrapping_add(1).max(1);
        let generation = lifecycle.next_generation;
        emit_audio_state(&app, generation, source, "starting", None);

        let host = cpal::default_host();
        let started = match source {
            "mic" => {
                let device = find_device_by_id(&host, device_id.as_deref())?
                    .ok_or_else(|| anyhow!("No microphone capture device is available"))?;
                start_cpal_direct(
                    app.clone(),
                    generation,
                    source,
                    device,
                    chunk_channel.clone(),
                )
            }
            "system" => {
                #[cfg(windows)]
                {
                    start_wasapi_direct(app.clone(), generation, source, chunk_channel.clone())
                }
                #[cfg(not(windows))]
                {
                    let device = find_system_device(&host, device_id.as_deref())?
                        .ok_or_else(|| anyhow!(system_audio_help_message()))?;
                    start_cpal_direct(
                        app.clone(),
                        generation,
                        source,
                        device,
                        chunk_channel.clone(),
                    )
                }
            }
            "mixed" => start_mixed_capture(
                app.clone(),
                generation,
                source,
                &host,
                device_id.as_deref(),
                chunk_channel,
            ),
            _ => unreachable!(),
        };

        match started {
            Ok(active) => {
                // The previous source stays live while the replacement performs
                // its device/COM readiness handshake. Swap only after success so
                // a realtime input change has no setup-sized hole and failure
                // leaves the known-good capture untouched.
                let previous = lifecycle.active.replace(active);
                emit_audio_state(&app, generation, source, "ready", None);
                if let Some(previous) = previous {
                    if let Err(error) = previous.stop() {
                        log::warn!(target: "audio", "Previous capture cleanup failed after a successful switch: {error}");
                    }
                }
                Ok(())
            }
            Err(error) => {
                emit_audio_state(&app, generation, source, "error", Some(error.to_string()));
                Err(error)
            }
        }
    }
}

fn start_cpal_direct(
    app: AppHandle,
    generation: u64,
    source: &str,
    device: Device,
    chunk_channel: Channel<AudioChunk>,
) -> Result<ActiveCapture> {
    let cancel = Arc::new(AtomicBool::new(false));
    let (frame_tx, frame_rx) = unbounded::<AudioFrame>();
    let (ready_tx, ready_rx) = mpsc::channel();
    let producer = spawn_cpal_source(
        app.clone(),
        generation,
        source.to_string(),
        device,
        frame_tx,
        cancel.clone(),
        ready_tx,
    );
    if let Err(error) = wait_until_ready(&ready_rx, AUDIO_START_TIMEOUT, "audio input") {
        cancel.store(true, Ordering::Release);
        let _ = producer.join();
        return Err(error);
    }

    let consumer = spawn_direct_consumer(
        app.clone(),
        generation,
        source.to_string(),
        frame_rx,
        cancel.clone(),
        chunk_channel,
    );
    Ok(ActiveCapture {
        generation,
        source: source.to_string(),
        app,
        cancel,
        handles: vec![producer, consumer],
    })
}

#[cfg(windows)]
fn start_wasapi_direct(
    app: AppHandle,
    generation: u64,
    source: &str,
    chunk_channel: Channel<AudioChunk>,
) -> Result<ActiveCapture> {
    let cancel = Arc::new(AtomicBool::new(false));
    let (frame_tx, frame_rx) = unbounded::<AudioFrame>();
    let (ready_tx, ready_rx) = mpsc::channel();
    let producer = spawn_wasapi_source(
        app.clone(),
        generation,
        source.to_string(),
        frame_tx,
        cancel.clone(),
        ready_tx,
    );
    if let Err(error) = wait_until_ready(&ready_rx, AUDIO_START_TIMEOUT, "WASAPI loopback") {
        cancel.store(true, Ordering::Release);
        let _ = producer.join();
        return Err(error);
    }

    let consumer = spawn_direct_consumer(
        app.clone(),
        generation,
        source.to_string(),
        frame_rx,
        cancel.clone(),
        chunk_channel,
    );
    Ok(ActiveCapture {
        generation,
        source: source.to_string(),
        app,
        cancel,
        handles: vec![producer, consumer],
    })
}

fn start_mixed_capture(
    app: AppHandle,
    generation: u64,
    source: &str,
    host: &cpal::Host,
    device_id: Option<&str>,
    chunk_channel: Channel<AudioChunk>,
) -> Result<ActiveCapture> {
    let mic = find_device_by_id(host, device_id)?
        .ok_or_else(|| anyhow!("No microphone capture device is available"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    let (mic_tx, mic_rx) = unbounded::<AudioFrame>();
    let (system_tx, system_rx) = unbounded::<AudioFrame>();
    let (mic_ready_tx, mic_ready_rx) = mpsc::channel();
    let mic_worker = spawn_cpal_source(
        app.clone(),
        generation,
        source.to_string(),
        mic,
        mic_tx,
        cancel.clone(),
        mic_ready_tx,
    );

    #[cfg(windows)]
    let (system_worker, system_ready_rx) = {
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = spawn_wasapi_source(
            app.clone(),
            generation,
            source.to_string(),
            system_tx,
            cancel.clone(),
            ready_tx,
        );
        (worker, ready_rx)
    };

    #[cfg(not(windows))]
    let (system_worker, system_ready_rx) = {
        let system =
            find_system_device(host, None)?.ok_or_else(|| anyhow!(system_audio_help_message()))?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = spawn_cpal_source(
            app.clone(),
            generation,
            source.to_string(),
            system,
            system_tx,
            cancel.clone(),
            ready_tx,
        );
        (worker, ready_rx)
    };

    let started_at = Instant::now();
    let mic_ready = wait_until_ready(&mic_ready_rx, AUDIO_START_TIMEOUT, "microphone");
    let remaining = AUDIO_START_TIMEOUT.saturating_sub(started_at.elapsed());
    let system_ready = wait_until_ready(&system_ready_rx, remaining, "system audio");
    if let Err(error) = mic_ready.and(system_ready) {
        cancel.store(true, Ordering::Release);
        let _ = mic_worker.join();
        let _ = system_worker.join();
        return Err(error);
    }

    let mixer = spawn_mixed_consumer(
        app.clone(),
        generation,
        source.to_string(),
        mic_rx,
        system_rx,
        cancel.clone(),
        chunk_channel,
    );
    Ok(ActiveCapture {
        generation,
        source: source.to_string(),
        app,
        cancel,
        handles: vec![mic_worker, system_worker, mixer],
    })
}

fn wait_until_ready(
    ready: &mpsc::Receiver<Result<SourceReady, String>>,
    timeout: Duration,
    label: &str,
) -> Result<SourceReady> {
    match ready.recv_timeout(timeout) {
        Ok(Ok(format)) => {
            log::info!(
                target: "audio",
                "{label} ready: sample_rate={} channels={}",
                format.sample_rate,
                format.channels
            );
            Ok(format)
        }
        Ok(Err(error)) => Err(anyhow!("Failed to start {label}: {error}")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(anyhow!("Timed out while starting {label}")),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(anyhow!("{label} worker exited before becoming ready"))
        }
    }
}

fn spawn_cpal_source(
    app: AppHandle,
    generation: u64,
    source: String,
    device: Device,
    frame_tx: Sender<AudioFrame>,
    cancel: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<SourceReady, String>>,
) -> std::thread::JoinHandle<()> {
    thread::spawn(move || {
        let device_name = device_display_name(&device);
        let (error_tx, error_rx) = bounded::<String>(1);
        let (stream, config) = match build_input_stream(device, frame_tx, error_tx) {
            Ok(value) => value,
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };
        if let Err(error) = stream.play() {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
        log::info!(
            target: "audio",
            "CPAL source started: device={} sample_rate={} channels={}",
            device_name,
            config.sample_rate,
            config.channels
        );
        let _ = ready_tx.send(Ok(SourceReady {
            sample_rate: config.sample_rate,
            channels: config.channels,
        }));

        while !cancel.load(Ordering::Acquire) {
            match error_rx.recv_timeout(Duration::from_millis(25)) {
                Ok(error) => {
                    report_worker_error(&app, generation, &source, error);
                    cancel.store(true, Ordering::Release);
                    break;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(stream);
    })
}

fn spawn_direct_consumer(
    app: AppHandle,
    generation: u64,
    source: String,
    frames: Receiver<AudioFrame>,
    cancel: Arc<AtomicBool>,
    chunk_channel: Channel<AudioChunk>,
) -> std::thread::JoinHandle<()> {
    thread::spawn(move || {
        // The producer owns the final Sender and is joined before this consumer.
        // Waiting for disconnect drains every packet queued before the stream stops.
        loop {
            match frames.recv_timeout(Duration::from_millis(25)) {
                Ok(frame) => emit_audio_frame(&chunk_channel, generation, frame),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    if !cancel.load(Ordering::Acquire) {
                        report_worker_error(
                            &app,
                            generation,
                            &source,
                            "Audio source stopped unexpectedly".into(),
                        );
                        cancel.store(true, Ordering::Release);
                    }
                    break;
                }
            }
        }
    })
}

fn spawn_mixed_consumer(
    app: AppHandle,
    generation: u64,
    source: String,
    mic_rx: Receiver<AudioFrame>,
    system_rx: Receiver<AudioFrame>,
    cancel: Arc<AtomicBool>,
    chunk_channel: Channel<AudioChunk>,
) -> std::thread::JoinHandle<()> {
    thread::spawn(move || {
        let started = Instant::now();
        let mut engine = MixedAudioEngine::new(MIX_SAMPLE_RATE, MIC_MIX_GAIN, SYSTEM_MIX_GAIN);
        let mut source_failed = false;

        while !cancel.load(Ordering::Acquire) {
            select! {
                recv(mic_rx) -> message => match message {
                    Ok(frame) => engine.push_mic(frame),
                    Err(_) => { source_failed = true; }
                },
                recv(system_rx) -> message => match message {
                    Ok(frame) => engine.push_system(frame),
                    Err(_) => { source_failed = true; }
                },
                default(Duration::from_millis(5)) => {}
            }
            if source_failed {
                if !cancel.load(Ordering::Acquire) {
                    report_worker_error(
                        &app,
                        generation,
                        &source,
                        "One of the mixed audio sources stopped unexpectedly".into(),
                    );
                    cancel.store(true, Ordering::Release);
                }
                break;
            }

            while let Ok(frame) = mic_rx.try_recv() {
                engine.push_mic(frame);
            }
            while let Ok(frame) = system_rx.try_recv() {
                engine.push_system(frame);
            }
            let force = started.elapsed() >= MIX_STARTUP_GRACE;
            while let Some(frame) = engine.take_mixed(force) {
                emit_audio_frame(&chunk_channel, generation, frame);
            }
        }

        // Producers may observe cancellation a few milliseconds after the mixer.
        // Drain until both Sender owners disappear so their final callbacks are kept.
        let mut mic_disconnected = false;
        let mut system_disconnected = false;
        while !mic_disconnected || !system_disconnected {
            if !mic_disconnected {
                match mic_rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(frame) => engine.push_mic(frame),
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        mic_disconnected = true;
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                }
            }
            if !system_disconnected {
                match system_rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(frame) => engine.push_system(frame),
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        system_disconnected = true;
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                }
            }
        }

        // Preserve resampler and jitter-buffer tails before the worker is joined.
        for frame in engine.finish() {
            emit_audio_frame(&chunk_channel, generation, frame);
        }
    })
}

fn emit_audio_frame(channel: &Channel<AudioChunk>, generation: u64, frame: AudioFrame) {
    let stereo = downmix_to_stereo(&frame);
    let samples = quantize_i16(&stereo);
    if samples.is_empty() {
        return;
    }
    let bytes: &[u8] = bytemuck::cast_slice(&samples);
    let mut packet = Vec::with_capacity(24 + bytes.len());
    packet.extend_from_slice(b"XAUD");
    packet.extend_from_slice(&1_u16.to_le_bytes());
    packet.extend_from_slice(&OUTPUT_CHANNELS.to_le_bytes());
    packet.extend_from_slice(&frame.sample_rate.to_le_bytes());
    packet.extend_from_slice(&0_u32.to_le_bytes());
    packet.extend_from_slice(&generation.to_le_bytes());
    packet.extend_from_slice(bytes);
    if let Err(error) = channel.send(AudioChunk(packet)) {
        log::warn!(target: "audio", "Failed to send audio chunk through IPC channel: {error}");
    }
}

fn emit_audio_state(
    app: &AppHandle,
    generation: u64,
    source: &str,
    state: &str,
    message: Option<String>,
) {
    let payload = AudioStatePayload {
        generation,
        source: source.to_string(),
        state: state.to_string(),
        message,
    };
    let _ = app.emit_to("main", "audio:state", payload);
}

fn report_worker_error(app: &AppHandle, generation: u64, source: &str, message: String) {
    log::error!(target: "audio", "Audio worker failed: {message}");
    emit_audio_state(app, generation, source, "error", Some(message));
}

fn device_display_name(device: &Device) -> String {
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "Unknown".to_string())
}

fn build_device_info(device: &Device) -> Result<AudioDeviceInfo> {
    let name = device_display_name(device);
    let cfg = device.default_input_config().or_else(|_| {
        device
            .supported_input_configs()?
            .next()
            .map(|c| c.with_max_sample_rate())
            .ok_or_else(|| anyhow!("no configs"))
    })?;
    let sample_rate = cfg.sample_rate();
    let channels = cfg.channels();
    let lower = name.to_lowercase();
    let kind = if is_system_device_name(&lower) {
        AudioDeviceKind::System
    } else {
        AudioDeviceKind::Mic
    };
    Ok(AudioDeviceInfo {
        // CPAL 0.17 maps this to the native WASAPI IMMDevice::GetId on
        // Windows and equivalent persistent endpoint IDs on other hosts.
        id: device.id()?.to_string(),
        name,
        kind,
        channels,
        sample_rate,
    })
}

fn select_unique<T>(
    items: impl IntoIterator<Item = T>,
    mut predicate: impl FnMut(&T) -> bool,
) -> std::result::Result<Option<T>, ()> {
    let mut matched = None;
    for item in items {
        if !predicate(&item) {
            continue;
        }
        if matched.is_some() {
            return Err(());
        }
        matched = Some(item);
    }
    Ok(matched)
}

#[cfg(test)]
mod selection_tests {
    use super::select_unique;

    #[test]
    fn selects_only_a_single_matching_endpoint() {
        let endpoints = [
            ("native-a", "USB microphone"),
            ("native-b", "Built-in microphone"),
        ];
        assert_eq!(
            select_unique(endpoints, |(_, name)| *name == "USB microphone"),
            Ok(Some(("native-a", "USB microphone")))
        );
    }

    #[test]
    fn rejects_ambiguous_legacy_display_names() {
        let endpoints = [
            ("native-a", "USB microphone"),
            ("native-b", "USB microphone"),
        ];
        assert_eq!(
            select_unique(endpoints, |(_, name)| *name == "USB microphone"),
            Err(())
        );
    }
}

fn find_device_by_id(host: &cpal::Host, id: Option<&str>) -> Result<Option<Device>> {
    if let Some(target) = id {
        if let Ok(native_id) = target.parse::<cpal::DeviceId>() {
            return host
                .device_by_id(&native_id)
                .map(Some)
                .ok_or_else(|| anyhow!("Selected microphone is no longer available: {target}"));
        }

        // One-release migration for pre-2.4 settings that persisted a display
        // name. Never silently select another/default endpoint on a mismatch.
        match select_unique(host.devices()?, |device| {
            device_display_name(device) == target
        }) {
            Ok(Some(device)) => return Ok(Some(device)),
            Err(()) => {
                return Err(anyhow!(
                    "Multiple microphones are named \"{target}\". Re-select the exact endpoint in Audio settings."
                ));
            }
            Ok(None) => {}
        }
        return Err(anyhow!(
            "Selected microphone is no longer available: {target}"
        ));
    }
    Ok(host.default_input_device())
}

#[cfg(not(windows))]
fn find_system_device(host: &cpal::Host, id: Option<&str>) -> Result<Option<Device>> {
    if let Some(target) = id {
        if let Ok(native_id) = target.parse::<cpal::DeviceId>() {
            let device = host.device_by_id(&native_id).ok_or_else(|| {
                anyhow!("Selected system-audio device is no longer available: {target}")
            })?;
            let lower = device_display_name(&device).to_lowercase();
            if is_system_device_name(&lower) {
                return Ok(Some(device));
            }
            return Err(anyhow!("Selected endpoint is not a system-audio device"));
        }

        match select_unique(host.devices()?, |device| {
            let name = device_display_name(device);
            name == target
                && is_system_device_name(&name.to_lowercase())
                && (device.default_input_config().is_ok()
                    || device.supported_input_configs().is_ok())
        }) {
            Ok(Some(device)) => return Ok(Some(device)),
            Err(()) => {
                return Err(anyhow!(
                    "Multiple system-audio endpoints are named \"{target}\". Re-select the exact endpoint in Audio settings."
                ));
            }
            Ok(None) => {}
        }
        #[cfg(not(windows))]
        {
            return Err(anyhow!(
                "Device \"{}\" was not found. {}",
                target,
                system_audio_help_message()
            ));
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
                    eprintln!(
                        "[audio] Skipping microphone: {} (input: {}, output: {})",
                        name, has_input, has_output
                    );
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
                    eprintln!(
                        "[audio] Found output device (may work as loopback): {} (output: true)",
                        name
                    );
                    // Don't skip - add to candidates with lower priority
                } else if !has_input {
                    // Skip devices without both input and output
                    eprintln!(
                        "[audio] Skipping device without input: {} (output: {})",
                        name, has_output
                    );
                    continue;
                }

                // Get default output device name for comparison
                let default_output_name = host
                    .default_output_device()
                    .and_then(|d| d.name().ok())
                    .map(|n| n.to_lowercase());

                // Priority based on name patterns and output capability
                // On Windows 11, loopback devices often have "(WASAPI)" in the name
                let priority = if lower.contains("loopback") {
                    eprintln!("[audio] Found explicit loopback: {}", name);
                    0
                } else if lower.contains("(wasapi)")
                    && (lower.contains("speakers")
                        || lower.contains("динамики")
                        || lower.contains("headphones")
                        || lower.contains("наушники"))
                {
                    // Windows 11 loopback devices often named like "Speakers (WASAPI)" or "Динамики (WASAPI)"
                    eprintln!("[audio] Found WASAPI loopback device: {}", name);
                    1
                } else if lower.contains("monitor") {
                    eprintln!("[audio] Found monitor: {}", name);
                    2
                } else if lower.contains("stereo mix") || lower.contains("стерео микшер")
                {
                    eprintln!("[audio] Found Stereo Mix: {}", name);
                    3
                } else if has_output && has_input {
                    // Device with both input and output is likely a loopback device
                    eprintln!(
                        "[audio] Found potential loopback (has both input and output): {}",
                        name
                    );
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
                    let matches_default = default_output_name
                        .as_ref()
                        .map(|default| lower.contains(default) || default.contains(&lower))
                        .unwrap_or(false);

                    if is_output_device_name || matches_default {
                        eprintln!("[audio] Found potential loopback (output device name or matches default): {}", name);
                        6
                    } else {
                        eprintln!(
                            "[audio] Skipping device (no clear loopback indicators): {}",
                            name
                        );
                        continue;
                    }
                };

                candidates.push((device, name, priority));
            }
        }

        eprintln!(
            "[audio] Scanned {} total devices, found {} loopback candidates",
            device_count,
            candidates.len()
        );
        if candidates.is_empty() {
            eprintln!("[audio] All available input devices:");
            for (name, lower, has_input, has_output) in all_devices_info {
                if has_input {
                    eprintln!(
                        "[audio]   - {} (input: true, output: {}, is_mic: {})",
                        name,
                        has_output,
                        lower.contains("mic") || lower.contains("microphone")
                    );
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        for device in host.devices()? {
            if let Ok(name) = device.name() {
                let lower = name.to_lowercase();
                if is_probable_mic(&lower) {
                    continue;
                }
                if let Some(priority) = system_device_priority(&lower) {
                    if device.default_input_config().is_ok()
                        || device
                            .supported_input_configs()
                            .map(|mut cfgs| cfgs.next().is_some())
                            .unwrap_or(false)
                    {
                        candidates.push((device, name, priority as u32));
                    }
                }
            }
        }

        candidates.sort_by_key(|(_, _, priority)| *priority);
        if let Some((device, name, _)) = candidates.into_iter().next() {
            eprintln!("[audio] Found system device: {}", name);
            return Ok(Some(device));
        } else {
            return Err(anyhow!(system_audio_help_message()));
        }
    }

    // Windows fallback
    candidates.sort_by_key(|(_, _, priority)| *priority);

    if let Some((device, name, _)) = candidates.into_iter().next() {
        eprintln!("[audio] Found system device: {}", name);
        Ok(Some(device))
    } else {
        eprintln!("[audio] No system audio device found. Trying to use default output device as loopback...");
        #[cfg(windows)]
        {
            if let Some(default_output) = host.default_output_device() {
                if let Ok(name) = default_output.name() {
                    eprintln!("[audio] Checking default output device: {}", name);
                    if default_output.default_input_config().is_ok()
                        || default_output.supported_input_configs().is_ok()
                    {
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

fn build_input_stream(
    device: Device,
    tx: Sender<AudioFrame>,
    error_tx: Sender<String>,
) -> Result<(Stream, StreamConfig)> {
    let (supported, sample_format) = choose_config(&device)?;
    let mut config: StreamConfig = supported.into();
    if config.sample_rate == 0 {
        config.sample_rate = DEFAULT_SAMPLE_RATE;
    }

    let sample_rate = config.sample_rate;
    let channels = config.channels;
    let make_error_handler = || {
        let error_tx = error_tx.clone();
        move |error: cpal::StreamError| {
            let _ = error_tx.try_send(error.to_string());
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                let samples = data
                    .iter()
                    .map(|sample| if sample.is_finite() { *sample } else { 0.0 })
                    .collect();
                let _ = tx.send(AudioFrame::new(samples, sample_rate, channels));
            },
            make_error_handler(),
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                let samples = data
                    .iter()
                    .map(|sample| *sample as f32 / 32_768.0)
                    .collect();
                let _ = tx.send(AudioFrame::new(samples, sample_rate, channels));
            },
            make_error_handler(),
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                let samples = data
                    .iter()
                    .map(|sample| (*sample as f32 - 32_768.0) / 32_768.0)
                    .collect();
                let _ = tx.send(AudioFrame::new(samples, sample_rate, channels));
            },
            make_error_handler(),
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
            let channels = cfg.channels();
            // Try to create input config with same parameters
            if let Ok(mut input_configs) = device.supported_input_configs() {
                if let Some(input_cfg) =
                    input_configs.find(|c| c.sample_format() == fmt && c.channels() == channels)
                {
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

#[derive(Serialize, Clone)]
struct AudioStatePayload {
    generation: u64,
    source: String,
    state: String,
    message: Option<String>,
}
