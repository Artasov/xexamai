use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use crossbeam_channel::Sender;
use tauri::AppHandle;
use windows::core::{Interface, GUID};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

use super::audio_processing::{
    decode_packed_audio, AudioFrame, PackedAudioFormat, PackedSampleEncoding,
};
use super::{report_worker_error, SourceReady};

const WAVE_FORMAT_PCM: u16 = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
const AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY_VALUE: u32 = 0x1;
const AUDCLNT_BUFFERFLAGS_SILENT_VALUE: u32 = 0x2;
const PCM_SUBFORMAT: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const IEEE_FLOAT_SUBFORMAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

pub(super) fn spawn_wasapi_source(
    app: AppHandle,
    generation: u64,
    source: String,
    frame_tx: Sender<AudioFrame>,
    cancel: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<SourceReady, String>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut ready_tx = Some(ready_tx);
        let result = unsafe { run_wasapi_capture(&frame_tx, &cancel, &mut ready_tx) };
        if let Err(error) = result {
            if let Some(ready) = ready_tx.take() {
                let _ = ready.send(Err(error.to_string()));
            } else if !cancel.load(Ordering::Acquire) {
                report_worker_error(&app, generation, &source, error.to_string());
                cancel.store(true, Ordering::Release);
            }
        }
    })
}

unsafe fn run_wasapi_capture(
    frame_tx: &Sender<AudioFrame>,
    cancel: &Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<SourceReady, String>>>,
) -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .context("Failed to initialize COM for WASAPI")?;
    }
    let result = unsafe { run_wasapi_capture_initialized(frame_tx, cancel, ready_tx) };
    unsafe { CoUninitialize() };
    result
}

unsafe fn run_wasapi_capture_initialized(
    frame_tx: &Sender<AudioFrame>,
    cancel: &Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<SourceReady, String>>>,
) -> Result<()> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .context("Failed to create the Windows audio device enumerator")?
    };
    // Keep eConsole for compatibility with the previously working Windows path.
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .context("Failed to get the default Windows output endpoint")?;
    let audio_client = unsafe { activate_audio_client(&device) }
        .context("Failed to activate the Windows audio client")?;
    let mix_format_ptr = unsafe { audio_client.GetMixFormat() }
        .context("Failed to read the Windows output mix format")?;
    if mix_format_ptr.is_null() {
        return Err(anyhow!("Windows returned an empty output mix format"));
    }

    let result = unsafe {
        (|| -> Result<()> {
            let format = parse_mix_format(mix_format_ptr)?;
            log::info!(
                target: "audio",
                "WASAPI loopback format: sample_rate={} channels={} container_bits={} valid_bits={} encoding={:?}",
                format.sample_rate,
                format.channels,
                format.container_bits,
                format.valid_bits,
                format.encoding
            );

            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    0,
                    0,
                    mix_format_ptr,
                    None,
                )
                .context("Failed to initialize WASAPI loopback")?;
            let capture_client: IAudioCaptureClient = audio_client
                .GetService::<IAudioCaptureClient>()
                .context("Failed to create the WASAPI capture client")?;
            audio_client
                .Start()
                .context("Failed to start WASAPI loopback")?;

            if let Some(ready) = ready_tx.take() {
                let _ = ready.send(Ok(SourceReady {
                    sample_rate: format.sample_rate,
                    channels: format.channels,
                }));
            }

            let capture_result = capture_packets(&capture_client, frame_tx, cancel, format);
            let stop_result = audio_client
                .Stop()
                .context("Failed to stop WASAPI loopback");
            capture_result.and(stop_result)
        })()
    };

    unsafe { CoTaskMemFree(Some(mix_format_ptr as *const _)) };
    result
}

unsafe fn capture_packets(
    capture_client: &IAudioCaptureClient,
    frame_tx: &Sender<AudioFrame>,
    cancel: &Arc<AtomicBool>,
    format: PackedAudioFormat,
) -> Result<()> {
    while !cancel.load(Ordering::Acquire) {
        let mut packet_frames = unsafe { capture_client.GetNextPacketSize() }
            .context("WASAPI failed to query the next packet")?;
        if packet_frames == 0 {
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        while packet_frames > 0 && !cancel.load(Ordering::Acquire) {
            let mut data_ptr = std::ptr::null_mut();
            let mut available_frames = 0_u32;
            let mut flags = 0_u32;
            let mut device_position = 0_u64;
            let mut qpc_position = 0_u64;
            unsafe {
                capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut available_frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                )
            }
            .context("WASAPI failed to acquire a capture packet")?;

            // Every successful GetBuffer is paired with ReleaseBuffer, including
            // silent/null packets and decode failures.
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT_VALUE != 0;
            let decoded = if available_frames == 0 {
                Ok(AudioFrame::new(
                    Vec::new(),
                    format.sample_rate,
                    format.channels,
                ))
            } else if silent {
                decode_packed_audio(&[], available_frames as usize, format, true)
                    .map_err(|error| anyhow!(error))
            } else if data_ptr.is_null() {
                Err(anyhow!("WASAPI returned a null non-silent audio packet"))
            } else {
                match (available_frames as usize).checked_mul(format.block_align as usize) {
                    Some(byte_len) => {
                        let bytes = unsafe { std::slice::from_raw_parts(data_ptr, byte_len) };
                        decode_packed_audio(bytes, available_frames as usize, format, false)
                            .map_err(|error| anyhow!(error))
                    }
                    None => Err(anyhow!("WASAPI packet size overflow")),
                }
            };
            let release_result = unsafe { capture_client.ReleaseBuffer(available_frames) }
                .context("WASAPI failed to release a capture packet");
            let frame = decoded?;
            release_result?;

            if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY_VALUE != 0 {
                log::warn!(target: "audio", "WASAPI reported a data discontinuity");
            }
            if !frame.samples.is_empty() && frame_tx.send(frame).is_err() {
                return Ok(());
            }

            packet_frames = unsafe { capture_client.GetNextPacketSize() }
                .context("WASAPI failed while draining capture packets")?;
        }
    }
    Ok(())
}

unsafe fn parse_mix_format(format_ptr: *const WAVEFORMATEX) -> Result<PackedAudioFormat> {
    if format_ptr.is_null() {
        return Err(anyhow!("Windows returned a null WAVEFORMATEX"));
    }
    let base = unsafe { *format_ptr };
    let format_tag = base.wFormatTag;
    let channels = base.nChannels;
    let sample_rate = base.nSamplesPerSec;
    let block_align = base.nBlockAlign;
    let container_bits = base.wBitsPerSample;
    let extension_size = base.cbSize;

    let (encoding, valid_bits) = match format_tag {
        WAVE_FORMAT_PCM => (PackedSampleEncoding::PcmInteger, container_bits),
        WAVE_FORMAT_IEEE_FLOAT => (PackedSampleEncoding::Float, container_bits),
        WAVE_FORMAT_EXTENSIBLE if extension_size >= 22 => {
            let extensible = unsafe { *(format_ptr as *const WAVEFORMATEXTENSIBLE) };
            let sub_format = extensible.SubFormat;
            let valid_bits = unsafe { extensible.Samples.wValidBitsPerSample };
            let encoding = if sub_format == PCM_SUBFORMAT {
                PackedSampleEncoding::PcmInteger
            } else if sub_format == IEEE_FLOAT_SUBFORMAT {
                PackedSampleEncoding::Float
            } else {
                return Err(anyhow!("Unsupported WAVEFORMATEXTENSIBLE sub-format"));
            };
            (
                encoding,
                if valid_bits == 0 {
                    container_bits
                } else {
                    valid_bits
                },
            )
        }
        WAVE_FORMAT_EXTENSIBLE => {
            return Err(anyhow!(
                "WAVEFORMATEXTENSIBLE extension is too short: {extension_size} bytes"
            ));
        }
        other => {
            return Err(anyhow!(
                "Unsupported Windows audio format tag: 0x{other:04x}"
            ))
        }
    };

    if channels == 0 || sample_rate == 0 || block_align == 0 || container_bits == 0 {
        return Err(anyhow!(
            "Windows output mix format contains zero-valued fields"
        ));
    }
    Ok(PackedAudioFormat {
        encoding,
        channels,
        sample_rate,
        block_align,
        container_bits,
        valid_bits,
    })
}

unsafe fn activate_audio_client(device: &IMMDevice) -> windows::core::Result<IAudioClient> {
    type ActivateFn = unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const GUID,
        u32,
        *const core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows::core::HRESULT;

    let device_ptr = Interface::as_raw(device);
    let vtable = unsafe { *(device_ptr as *const *const *const core::ffi::c_void) };
    let activate_fn =
        unsafe { std::mem::transmute::<*const core::ffi::c_void, ActivateFn>(*vtable.add(3)) };
    let mut result = std::ptr::null_mut();
    let status = unsafe {
        activate_fn(
            device_ptr,
            &IAudioClient::IID,
            CLSCTX_ALL.0,
            std::ptr::null(),
            &mut result,
        )
    };
    if status.is_ok() && !result.is_null() {
        Ok(unsafe { IAudioClient::from_raw(result as *mut _) })
    } else {
        Err(status.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_extensible_layout_matches_the_documented_40_bytes() {
        assert_eq!(std::mem::size_of::<WAVEFORMATEX>(), 18);
        assert_eq!(std::mem::size_of::<WAVEFORMATEXTENSIBLE>(), 40);
    }

    #[test]
    fn parses_float_extensible_subformat() {
        let mut format = WAVEFORMATEXTENSIBLE::default();
        format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
        format.Format.nChannels = 2;
        format.Format.nSamplesPerSec = 48_000;
        format.Format.nBlockAlign = 8;
        format.Format.wBitsPerSample = 32;
        format.Format.cbSize = 22;
        format.Samples = WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: 32,
        };
        format.SubFormat = IEEE_FLOAT_SUBFORMAT;
        let parsed = unsafe { parse_mix_format(&format.Format) }.unwrap();
        assert_eq!(parsed.encoding, PackedSampleEncoding::Float);
        assert_eq!(parsed.valid_bits, 32);
    }
}
