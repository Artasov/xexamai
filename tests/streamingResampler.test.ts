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
});
