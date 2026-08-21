import {describe, expect, it} from 'vitest';
import {decodeAudioChunkPacket} from '../src/renderer/services/nativeAudio';

function audioPacket(samples: number[], generation = 7, sampleRate = 48_000, channels = 2): Uint8Array {
    const bytes = new Uint8Array(24 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x58415544, false);
    view.setUint16(4, 1, true);
    view.setUint16(6, channels, true);
    view.setUint32(8, sampleRate, true);
    view.setBigUint64(16, BigInt(generation), true);
    samples.forEach((sample, index) => view.setInt16(24 + index * 2, sample, true));
    return bytes;
}

describe('native audio binary channel packets', () => {
    it('decodes ordered interleaved PCM without base64 or JSON copies', () => {
        const decoded = decodeAudioChunkPacket(audioPacket([32_767, -32_768, 16_384, -16_384]));
        expect(decoded?.generation).toBe(7);
        expect(decoded?.sampleRate).toBe(48_000);
        expect(decoded?.channels).toBe(2);
        expect(decoded?.samples[0][0]).toBe(1);
        expect(decoded?.samples[0][1]).toBeCloseTo(16_384 / 32_767, 6);
        expect(decoded?.samples[1][0]).toBe(-1);
        expect(decoded?.samples[1][1]).toBe(-0.5);
    });

    it('rejects malformed headers and incomplete frames', () => {
        const invalidMagic = audioPacket([1, 2]);
        invalidMagic[0] = 0;
        expect(decodeAudioChunkPacket(invalidMagic)).toBeNull();
        expect(decodeAudioChunkPacket(audioPacket([1], 1, 48_000, 2))).toBeNull();
    });
});
