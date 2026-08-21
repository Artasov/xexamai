use std::collections::VecDeque;

pub(crate) const MIX_SAMPLE_RATE: u32 = 48_000;
pub(crate) const OUTPUT_CHANNELS: u16 = 2;
const DEFAULT_JITTER_MS: u32 = 20;
const MAX_OUTPUT_FRAMES: usize = 2_048;

#[derive(Debug, Clone)]
pub(crate) struct AudioFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PackedSampleEncoding {
    PcmInteger,
    Float,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PackedAudioFormat {
    pub encoding: PackedSampleEncoding,
    pub channels: u16,
    pub sample_rate: u32,
    pub block_align: u16,
    pub container_bits: u16,
    pub valid_bits: u16,
}

/// Decodes one WASAPI-style interleaved packet without making assumptions about
/// 32-bit containers. `silent` intentionally ignores the data pointer contents.
pub(crate) fn decode_packed_audio(
    data: &[u8],
    frames: usize,
    format: PackedAudioFormat,
    silent: bool,
) -> Result<AudioFrame, String> {
    let channels = format.channels.max(1) as usize;
    let block_align = format.block_align as usize;
    let bytes_per_sample = format.container_bits.div_ceil(8) as usize;
    if block_align < channels.saturating_mul(bytes_per_sample) || bytes_per_sample == 0 {
        return Err("Invalid audio block alignment".into());
    }
    let required = frames
        .checked_mul(block_align)
        .ok_or_else(|| "Audio packet size overflow".to_string())?;
    if !silent && data.len() < required {
        return Err("Audio packet is shorter than the declared frame count".into());
    }

    let mut samples = Vec::with_capacity(frames.saturating_mul(channels));
    if silent {
        samples.resize(frames.saturating_mul(channels), 0.0);
        return Ok(AudioFrame::new(
            samples,
            format.sample_rate,
            format.channels,
        ));
    }

    for frame in 0..frames {
        let frame_offset = frame * block_align;
        for channel in 0..channels {
            let offset = frame_offset + channel * bytes_per_sample;
            let bytes = &data[offset..offset + bytes_per_sample];
            let sample = match format.encoding {
                PackedSampleEncoding::Float => match format.container_bits {
                    32 => f32::from_le_bytes(bytes.try_into().expect("validated f32 width")),
                    64 => f64::from_le_bytes(bytes.try_into().expect("validated f64 width")) as f32,
                    bits => return Err(format!("Unsupported float container: {bits} bits")),
                },
                PackedSampleEncoding::PcmInteger => {
                    decode_pcm_integer(bytes, format.container_bits, format.valid_bits)?
                }
            };
            samples.push(sanitize_sample(sample).clamp(-1.0, 1.0));
        }
    }

    Ok(AudioFrame::new(
        samples,
        format.sample_rate,
        format.channels,
    ))
}

impl AudioFrame {
    pub fn new(samples: Vec<f32>, sample_rate: u32, channels: u16) -> Self {
        Self {
            samples,
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
        }
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }
}

/// Converts interleaved input to stereo without quantizing it. Mono is duplicated;
/// multichannel audio keeps L/R and folds centre/surround channels into them.
pub(crate) fn downmix_to_stereo(frame: &AudioFrame) -> Vec<f32> {
    let channels = frame.channels.max(1) as usize;
    let frames = frame.frames();
    let mut output = Vec::with_capacity(frames * OUTPUT_CHANNELS as usize);

    for input in frame.samples.chunks_exact(channels) {
        let (left, right) = match channels {
            1 => (input[0], input[0]),
            2 => (input[0], input[1]),
            _ => {
                let mut left = input[0];
                let mut right = input[1];

                // WAVEFORMATEXTENSIBLE commonly orders centre at index 2 and LFE at 3.
                // Centre is important for speech; LFE is intentionally attenuated.
                if let Some(&centre) = input.get(2) {
                    left += centre * 0.707;
                    right += centre * 0.707;
                }
                if let Some(&lfe) = input.get(3) {
                    left += lfe * 0.25;
                    right += lfe * 0.25;
                }
                if let Some(&surround_left) = input.get(4) {
                    left += surround_left * 0.5;
                }
                if let Some(&surround_right) = input.get(5) {
                    right += surround_right * 0.5;
                }
                for (index, &sample) in input.iter().enumerate().skip(6) {
                    if index % 2 == 0 {
                        left += sample * 0.35;
                    } else {
                        right += sample * 0.35;
                    }
                }
                (left, right)
            }
        };
        output.push(sanitize_sample(left));
        output.push(sanitize_sample(right));
    }

    output
}

#[derive(Debug)]
struct StreamingLinearResampler {
    source_rate: u32,
    target_rate: u32,
    buffer: Vec<f32>,
    next_source_frame: f64,
}

impl StreamingLinearResampler {
    fn new(source_rate: u32, target_rate: u32) -> Self {
        Self {
            source_rate: source_rate.max(1),
            target_rate: target_rate.max(1),
            buffer: Vec::new(),
            next_source_frame: 0.0,
        }
    }

    fn reset_rate(&mut self, source_rate: u32) -> Vec<f32> {
        let tail = self.finish();
        self.source_rate = source_rate.max(1);
        self.next_source_frame = 0.0;
        tail
    }

    fn push_stereo(&mut self, samples: &[f32]) -> Vec<f32> {
        if samples.is_empty() {
            return Vec::new();
        }
        self.buffer
            .extend(samples.iter().copied().map(sanitize_sample));
        self.produce(false)
    }

    fn finish(&mut self) -> Vec<f32> {
        let output = self.produce(true);
        self.buffer.clear();
        self.next_source_frame = 0.0;
        output
    }

    fn produce(&mut self, flush: bool) -> Vec<f32> {
        let frames = self.buffer.len() / OUTPUT_CHANNELS as usize;
        if frames == 0 {
            return Vec::new();
        }

        let step = self.source_rate as f64 / self.target_rate as f64;
        let mut output = Vec::new();
        let last_frame = frames.saturating_sub(1) as f64;

        while if flush {
            self.next_source_frame <= last_frame
        } else {
            self.next_source_frame + 1.0 <= last_frame
        } {
            let base = self.next_source_frame.floor() as usize;
            let fraction = (self.next_source_frame - base as f64) as f32;
            let next = (base + 1).min(frames - 1);
            for channel in 0..OUTPUT_CHANNELS as usize {
                let a = self.buffer[base * OUTPUT_CHANNELS as usize + channel];
                let b = self.buffer[next * OUTPUT_CHANNELS as usize + channel];
                output.push(a + (b - a) * fraction);
            }
            self.next_source_frame += step;
        }

        if flush {
            self.buffer.clear();
            self.next_source_frame = 0.0;
            return output;
        }

        // Keep the interpolation anchor plus the fractional phase for the next packet.
        let consumed = self.next_source_frame.floor() as usize;
        if consumed > 0 {
            self.buffer.drain(..consumed * OUTPUT_CHANNELS as usize);
            self.next_source_frame -= consumed as f64;
        }
        output
    }
}

#[derive(Debug)]
pub(crate) struct MixedAudioEngine {
    target_rate: u32,
    mic_resampler: Option<StreamingLinearResampler>,
    system_resampler: Option<StreamingLinearResampler>,
    mic_frames: VecDeque<[f32; 2]>,
    system_frames: VecDeque<[f32; 2]>,
    system_phase: f64,
    started: bool,
    jitter_frames: usize,
    mic_gain: f32,
    system_gain: f32,
}

impl MixedAudioEngine {
    pub fn new(target_rate: u32, mic_gain: f32, system_gain: f32) -> Self {
        let target_rate = target_rate.max(1);
        Self {
            target_rate,
            mic_resampler: None,
            system_resampler: None,
            mic_frames: VecDeque::new(),
            system_frames: VecDeque::new(),
            system_phase: 0.0,
            started: false,
            jitter_frames: frames_for_ms(target_rate, DEFAULT_JITTER_MS),
            mic_gain,
            system_gain,
        }
    }

    pub fn push_mic(&mut self, frame: AudioFrame) {
        let stereo = downmix_to_stereo(&frame);
        let resampled = resample_packet(
            &mut self.mic_resampler,
            frame.sample_rate,
            self.target_rate,
            &stereo,
        );
        extend_frames(&mut self.mic_frames, &resampled);
    }

    pub fn push_system(&mut self, frame: AudioFrame) {
        let stereo = downmix_to_stereo(&frame);
        let resampled = resample_packet(
            &mut self.system_resampler,
            frame.sample_rate,
            self.target_rate,
            &stereo,
        );
        extend_frames(&mut self.system_frames, &resampled);
    }

    /// Returns a bounded mixed chunk. Both sources retain a small jitter window so
    /// callback scheduling does not create gaps. `allow_unpaired_start` lets microphone
    /// audio begin after the startup deadline even when loopback has not emitted a packet;
    /// it never disables the jitter window once mixing has started.
    pub fn take_mixed(&mut self, allow_unpaired_start: bool) -> Option<AudioFrame> {
        if !self.started {
            let system_ready = self.system_frames.len() >= self.jitter_frames;
            if !system_ready && !allow_unpaired_start {
                return None;
            }
            self.started = true;
        }

        let available_mic = self.mic_frames.len().saturating_sub(self.jitter_frames);
        if available_mic == 0 {
            return None;
        }

        let output_frames = available_mic.min(MAX_OUTPUT_FRAMES);
        let queue_error = self.system_frames.len() as isize - self.mic_frames.len() as isize;
        let correction = if self.jitter_frames == 0 {
            0.0
        } else {
            (queue_error as f64 / self.jitter_frames as f64 * 0.001).clamp(-0.005, 0.005)
        };
        let system_step = 1.0 + correction;

        let mut mixed = Vec::with_capacity(output_frames * OUTPUT_CHANNELS as usize);
        for _ in 0..output_frames {
            let mic = self.mic_frames.pop_front().unwrap_or([0.0, 0.0]);
            let system = self.read_system_frame();
            mixed.push(mic[0] * self.mic_gain + system[0] * self.system_gain);
            mixed.push(mic[1] * self.mic_gain + system[1] * self.system_gain);
            self.system_phase += system_step;
            self.consume_system_phase();
        }

        apply_peak_limiter(&mut mixed, 0.98);
        Some(AudioFrame::new(mixed, self.target_rate, OUTPUT_CHANNELS))
    }

    pub fn finish(&mut self) -> Vec<AudioFrame> {
        if let Some(resampler) = self.mic_resampler.as_mut() {
            let tail = resampler.finish();
            extend_frames(&mut self.mic_frames, &tail);
        }
        if let Some(resampler) = self.system_resampler.as_mut() {
            let tail = resampler.finish();
            extend_frames(&mut self.system_frames, &tail);
        }

        // Once both producers have stopped there is no future packet to align against.
        // Drain both tails and zero-pad only the shorter source.
        let tail_frames = self.mic_frames.len().max(self.system_frames.len());
        self.mic_frames.resize(tail_frames, [0.0, 0.0]);
        self.jitter_frames = 0;
        self.started = true;

        let mut output = Vec::new();
        while let Some(frame) = self.take_mixed(true) {
            output.push(frame);
        }
        output
    }

    #[cfg(test)]
    fn buffered_frames(&self) -> (usize, usize) {
        (self.mic_frames.len(), self.system_frames.len())
    }

    fn read_system_frame(&self) -> [f32; 2] {
        if self.system_frames.is_empty() {
            return [0.0, 0.0];
        }
        let base = self.system_phase.floor() as usize;
        let fraction = (self.system_phase - base as f64) as f32;
        let a = self.system_frames.get(base).copied().unwrap_or([0.0, 0.0]);
        let b = self.system_frames.get(base + 1).copied().unwrap_or(a);
        [
            a[0] + (b[0] - a[0]) * fraction,
            a[1] + (b[1] - a[1]) * fraction,
        ]
    }

    fn consume_system_phase(&mut self) {
        let consumed = self.system_phase.floor() as usize;
        let removable = consumed.min(self.system_frames.len());
        for _ in 0..removable {
            self.system_frames.pop_front();
        }
        self.system_phase -= removable as f64;
        if self.system_frames.is_empty() {
            self.system_phase = 0.0;
        }
    }
}

pub(crate) fn quantize_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&sample| {
            let clamped = sanitize_sample(sample).clamp(-1.0, 1.0);
            if clamped <= -1.0 {
                i16::MIN
            } else {
                (clamped * i16::MAX as f32).round() as i16
            }
        })
        .collect()
}

fn resample_packet(
    state: &mut Option<StreamingLinearResampler>,
    source_rate: u32,
    target_rate: u32,
    stereo: &[f32],
) -> Vec<f32> {
    let source_rate = source_rate.max(1);
    let resampler =
        state.get_or_insert_with(|| StreamingLinearResampler::new(source_rate, target_rate));
    let mut output = if resampler.source_rate != source_rate {
        resampler.reset_rate(source_rate)
    } else {
        Vec::new()
    };
    output.extend(resampler.push_stereo(stereo));
    output
}

fn extend_frames(target: &mut VecDeque<[f32; 2]>, samples: &[f32]) {
    for frame in samples.chunks_exact(OUTPUT_CHANNELS as usize) {
        target.push_back([frame[0], frame[1]]);
    }
}

fn frames_for_ms(sample_rate: u32, milliseconds: u32) -> usize {
    ((sample_rate as u64 * milliseconds as u64) / 1_000) as usize
}

fn sanitize_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

fn decode_pcm_integer(bytes: &[u8], container_bits: u16, valid_bits: u16) -> Result<f32, String> {
    if container_bits == 8 {
        return Ok((bytes[0] as f32 - 128.0) / 128.0);
    }
    if !matches!(container_bits, 16 | 24 | 32) {
        return Err(format!("Unsupported PCM container: {container_bits} bits"));
    }

    let mut raw = match container_bits {
        16 => i16::from_le_bytes(bytes.try_into().expect("validated i16 width")) as i32,
        24 => {
            let value = bytes[0] as i32 | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            if value & 0x0080_0000 != 0 {
                value | !0x00ff_ffff
            } else {
                value
            }
        }
        32 => i32::from_le_bytes(bytes.try_into().expect("validated i32 width")),
        _ => unreachable!(),
    };
    let valid_bits = valid_bits.clamp(1, container_bits);
    let padding_bits = container_bits - valid_bits;
    if padding_bits > 0 {
        // WAVEFORMATEXTENSIBLE specifies that valid PCM bits are left aligned.
        raw >>= padding_bits;
    }
    let denominator = (1_u64 << (valid_bits - 1)) as f64;
    Ok((raw as f64 / denominator) as f32)
}

fn apply_peak_limiter(samples: &mut [f32], ceiling: f32) {
    let peak = samples
        .iter()
        .copied()
        .map(|sample| sanitize_sample(sample).abs())
        .fold(0.0_f32, f32::max);
    let gain = if peak > ceiling && peak > 0.0 {
        ceiling / peak
    } else {
        1.0
    };
    for sample in samples {
        *sample = sanitize_sample(*sample) * gain;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_constant(frames: usize, value: f32, rate: u32) -> AudioFrame {
        AudioFrame::new(vec![value; frames * 2], rate, 2)
    }

    #[test]
    fn downmix_duplicates_mono_and_preserves_stereo() {
        let mono = AudioFrame::new(vec![0.25, -0.5], 48_000, 1);
        assert_eq!(downmix_to_stereo(&mono), vec![0.25, 0.25, -0.5, -0.5]);

        let stereo = AudioFrame::new(vec![0.1, 0.2, 0.3, 0.4], 48_000, 2);
        assert_eq!(downmix_to_stereo(&stereo), stereo.samples);
    }

    #[test]
    fn downmix_keeps_centre_dialogue() {
        let surround = AudioFrame::new(vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 48_000, 6);
        let stereo = downmix_to_stereo(&surround);
        assert!((stereo[0] - 0.707).abs() < 0.0001);
        assert!((stereo[1] - 0.707).abs() < 0.0001);
    }

    #[test]
    fn streaming_resampler_preserves_packet_tail() {
        let mut resampler = StreamingLinearResampler::new(48_000, 48_000);
        let first = resampler.push_stereo(&[0.0, 0.0, 0.25, 0.25]);
        let second = resampler.push_stereo(&[0.5, 0.5, 0.75, 0.75]);
        let tail = resampler.finish();
        let combined = [first, second, tail].concat();
        assert_eq!(combined, vec![0.0, 0.0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75]);
    }

    #[test]
    fn resampler_produces_expected_44100_to_48000_duration() {
        let input_frames = 4_410;
        let mut input = Vec::with_capacity(input_frames * 2);
        for frame in 0..input_frames {
            let sample = (frame as f32 * 0.01).sin();
            input.extend([sample, sample]);
        }
        let mut resampler = StreamingLinearResampler::new(44_100, 48_000);
        let output = [resampler.push_stereo(&input), resampler.finish()].concat();
        let output_frames = output.len() / 2;
        assert!(
            (output_frames as isize - 4_800).abs() <= 1,
            "frames={output_frames}"
        );
        assert!(output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn mixed_engine_uses_jitter_window_and_flushes_tail() {
        let mut engine = MixedAudioEngine::new(48_000, 1.0, 0.5);
        engine.push_mic(stereo_constant(2_000, 0.4, 48_000));
        engine.push_system(stereo_constant(2_000, 0.4, 48_000));

        let first = engine.take_mixed(false).expect("mixed chunk");
        assert_eq!(first.sample_rate, 48_000);
        assert_eq!(first.channels, 2);
        assert!(!first.samples.is_empty());
        assert!(first.samples.iter().all(|sample| *sample <= 0.98));

        let flushed_frames: usize = engine.finish().iter().map(AudioFrame::frames).sum();
        assert!(flushed_frames > 0);
        assert_eq!(engine.buffered_frames().0, 0);
    }

    #[test]
    fn forced_start_does_not_disable_the_jitter_window() {
        let mut engine = MixedAudioEngine::new(48_000, 1.0, 0.5);
        engine.push_mic(stereo_constant(2_000, 0.4, 48_000));

        let first = engine.take_mixed(true).expect("startup fallback chunk");
        assert!(first.frames() > 0);
        assert_eq!(
            engine.buffered_frames().0,
            frames_for_ms(48_000, DEFAULT_JITTER_MS)
        );
        assert!(engine.take_mixed(true).is_none());
    }

    #[test]
    fn finish_keeps_the_longer_source_tail() {
        let mut engine = MixedAudioEngine::new(48_000, 1.0, 0.5);
        engine.push_mic(stereo_constant(1_000, 0.4, 48_000));
        engine.push_system(stereo_constant(1_500, 0.2, 48_000));

        let flushed_frames: usize = engine.finish().iter().map(AudioFrame::frames).sum();
        assert_eq!(flushed_frames, 1_500);
        assert_eq!(engine.buffered_frames(), (0, 0));
    }

    #[test]
    fn limiter_avoids_integer_saturation() {
        let mut engine = MixedAudioEngine::new(48_000, 1.0, 1.0);
        engine.push_mic(stereo_constant(2_000, 0.9, 48_000));
        engine.push_system(stereo_constant(2_000, 0.9, 48_000));
        let mixed = engine.take_mixed(false).expect("mixed chunk");
        assert!(mixed.samples.iter().all(|sample| sample.abs() <= 0.980_001));
        let quantized = quantize_i16(&mixed.samples);
        assert!(quantized
            .iter()
            .all(|sample| *sample != i16::MIN && *sample != i16::MAX));
    }

    #[test]
    fn packed_decoder_distinguishes_float_and_32_bit_pcm() {
        let pcm = PackedAudioFormat {
            encoding: PackedSampleEncoding::PcmInteger,
            channels: 1,
            sample_rate: 48_000,
            block_align: 4,
            container_bits: 32,
            valid_bits: 32,
        };
        let float = PackedAudioFormat {
            encoding: PackedSampleEncoding::Float,
            ..pcm
        };
        let pcm_frame = decode_packed_audio(&i32::MAX.to_le_bytes(), 1, pcm, false).unwrap();
        let float_frame = decode_packed_audio(&0.5_f32.to_le_bytes(), 1, float, false).unwrap();
        assert!(pcm_frame.samples[0] > 0.999);
        assert!((float_frame.samples[0] - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn packed_decoder_handles_24_valid_bits_in_32_bit_container() {
        let format = PackedAudioFormat {
            encoding: PackedSampleEncoding::PcmInteger,
            channels: 1,
            sample_rate: 44_100,
            block_align: 4,
            container_bits: 32,
            valid_bits: 24,
        };
        let left_aligned_half_scale = (0x0040_0000_i32 << 8).to_le_bytes();
        let decoded = decode_packed_audio(&left_aligned_half_scale, 1, format, false).unwrap();
        assert!((decoded.samples[0] - 0.5).abs() < 0.000_001);
    }

    #[test]
    fn packed_decoder_materializes_silent_packets_without_data() {
        let format = PackedAudioFormat {
            encoding: PackedSampleEncoding::Float,
            channels: 2,
            sample_rate: 48_000,
            block_align: 8,
            container_bits: 32,
            valid_bits: 32,
        };
        let decoded = decode_packed_audio(&[], 3, format, true).unwrap();
        assert_eq!(decoded.samples, vec![0.0; 6]);
    }
}
