import {describe, expect, it} from 'vitest';

import {PcmRingBuffer} from '../src/renderer/audio/pcmRingBuffer';

describe('PcmRingBuffer', () => {
    it('returns the newest partial chunk instead of the oldest prefix', () => {
        const ring = new PcmRingBuffer(10, 1, 10);
        ring.push([Float32Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9)], 10, 10);
        ring.push([Float32Array.of(10, 11, 12, 13, 14, 15, 16, 17, 18, 19)], 10, 10);

        const window = ring.getLastSecondsFloats(1.5);
        expect(window).not.toBeNull();
        expect(Array.from(window!.channels[0])).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
        expect(window!.frames).toBe(15);
        expect(window!.durationSeconds).toBe(1.5);
    });

    it('compacts by exact frame count including part of the oldest chunk', () => {
        const ring = new PcmRingBuffer(10, 1, 1);
        ring.push([Float32Array.from({length: 8}, (_, index) => index)], 8, 10);
        ring.push([Float32Array.from({length: 8}, (_, index) => index + 8)], 8, 10);

        expect(ring.availableDurationSeconds()).toBe(1);
        const window = ring.getLastSecondsFloats(5);
        expect(window).not.toBeNull();
        expect(Array.from(window!.channels[0])).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        expect(window!.requestedSeconds).toBe(5);
        expect(window!.durationSeconds).toBe(1);
    });

    it('duplicates mono and reports actual available duration', () => {
        const ring = new PcmRingBuffer(10, 2, 10);
        ring.push([Float32Array.of(0.25, 0.5, 0.75)], 3, 10);

        const window = ring.getLastSecondsFloats(2);
        expect(window).not.toBeNull();
        expect(window!.durationSeconds).toBe(0.3);
        expect(Array.from(window!.channels[0])).toEqual([0.25, 0.5, 0.75]);
        expect(Array.from(window!.channels[1])).toEqual([0.25, 0.5, 0.75]);
    });

    it('resamples device packets into the fixed ring rate', () => {
        const ring = new PcmRingBuffer(48_000, 2, 1);
        const input = Float32Array.from({length: 4_410}, (_, index) => Math.sin(index * 0.01));
        ring.push([input, input], input.length, 44_100);

        const window = ring.getLastSecondsFloats(1);
        expect(window).not.toBeNull();
        expect(window!.sampleRate).toBe(48_000);
        expect(Math.abs(window!.frames - 4_800)).toBeLessThanOrEqual(2);
        expect(window!.durationSeconds).toBe(window!.frames / 48_000);
    });
});
