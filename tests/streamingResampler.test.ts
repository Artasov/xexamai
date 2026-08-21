import {describe, expect, it} from 'vitest';
import {StreamingPcm16Resampler} from '../src/renderer/audio/streamingResampler';

function collect(chunks: Int16Array[]): Int16Array {
    const result = new Int16Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function sine(sampleRate: number, frequency: number, durationSeconds = 1): Float32Array {
    return Float32Array.from(
        {length: Math.round(sampleRate * durationSeconds)},
        (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.8,
    );
}

function rms(samples: Int16Array, skip = 0): number {
    let sum = 0;
    for (let index = skip; index < samples.length; index += 1) {
        const normalized = samples[index] / 0x8000;
        sum += normalized * normalized;
    }
    return Math.sqrt(sum / Math.max(1, samples.length - skip));
}

describe('streaming PCM resampler', () => {
    it('matches one-shot output across uneven 44.1 kHz packet boundaries', () => {
        const input = Float32Array.from({length: 4_410}, (_, index) => Math.sin(index / 17) * 0.7);
        const oneShot = new StreamingPcm16Resampler(16_000);
        const expected = collect([oneShot.process(input, 44_100), oneShot.finish()]);

        const packeted = new StreamingPcm16Resampler(16_000);
        const actual = collect([
            packeted.process(input.subarray(0, 137), 44_100),
            packeted.process(input.subarray(137, 1_024), 44_100),
            packeted.process(input.subarray(1_024, 2_333), 44_100),
            packeted.process(input.subarray(2_333), 44_100),
            packeted.finish(),
        ]);

        expect(actual).toEqual(expected);
        expect(actual.length).toBe(1_600);
    });

    it('preserves every sample at equal rates without duplicating boundaries', () => {
        const resampler = new StreamingPcm16Resampler(16_000);
        const output = collect([
            resampler.process(Float32Array.from([0, 0.25]), 16_000),
            resampler.process(Float32Array.from([0.5, 0.75]), 16_000),
            resampler.finish(),
        ]);
        expect([...output]).toEqual([0, 8192, 16384, 24575]);
    });

    it('produces the exact OpenAI 24 kHz duration from packeted 48 kHz audio', () => {
        const input = Float32Array.from(
            {length: 4_800},
            (_, index) => Math.sin(index * Math.PI / 31) * 0.6,
        );
        const oneShot = new StreamingPcm16Resampler(24_000);
        const expected = collect([oneShot.process(input, 48_000), oneShot.finish()]);

        const packeted = new StreamingPcm16Resampler(24_000);
        const actual = collect([
            packeted.process(input.subarray(0, 317), 48_000),
            packeted.process(input.subarray(317, 1_641), 48_000),
            packeted.process(input.subarray(1_641, 3_809), 48_000),
            packeted.process(input.subarray(3_809), 48_000),
            packeted.finish(),
        ]);

        expect(actual).toEqual(expected);
        expect(actual.length).toBe(2_400);
    });

    it('strongly attenuates input above the 24 kHz output Nyquist frequency', () => {
        const passBand = new StreamingPcm16Resampler(24_000);
        const passBandOutput = collect([
            passBand.process(sine(48_000, 2_000), 48_000),
            passBand.finish(),
        ]);

        const stopBand = new StreamingPcm16Resampler(24_000);
        const stopBandOutput = collect([
            stopBand.process(sine(48_000, 18_000), 48_000),
            stopBand.finish(),
        ]);

        // Ignore the short causal-filter warm-up when measuring steady state.
        expect(rms(stopBandOutput, 128)).toBeLessThan(rms(passBandOutput, 128) * 0.01);
    });

    it('strongly attenuates input above the 16 kHz output Nyquist frequency', () => {
        const passBand = new StreamingPcm16Resampler(16_000);
        const passBandOutput = collect([
            passBand.process(sine(48_000, 2_000), 48_000),
            passBand.finish(),
        ]);

        const stopBand = new StreamingPcm16Resampler(16_000);
        const stopBandOutput = collect([
            stopBand.process(sine(48_000, 14_000), 48_000),
            stopBand.finish(),
        ]);

        expect(rms(stopBandOutput, 128)).toBeLessThan(rms(passBandOutput, 128) * 0.01);
    });
});
