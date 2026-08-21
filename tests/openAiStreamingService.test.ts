import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    audioListener: null as ((chunk: any) => void) | null,
    releaseActivity: vi.fn(async () => undefined),
    unsubscribeAudio: vi.fn(),
}));

vi.mock('../src/renderer/state/rendererActivity', () => ({
    beginNativeRendererActivity: vi.fn(async () => mocks.releaseActivity),
}));

vi.mock('../src/renderer/services/nativeAudio', () => ({
    onAudioChunk: vi.fn((listener: (chunk: any) => void) => {
        mocks.audioListener = listener;
        return mocks.unsubscribeAudio;
    }),
}));

import {OpenAiStreamingService} from '../src/renderer/services/openAiStreamingService';

describe('OpenAI streaming reconnect buffer', () => {
    beforeEach(() => {
        mocks.audioListener = null;
        mocks.releaseActivity.mockClear();
        mocks.unsubscribeAudio.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps audio captured after a failed setup and flushes it after reconnect', async () => {
        const sendAudioChunk = vi.fn();
        const startLive = vi.fn()
            .mockRejectedValueOnce(new Error('temporary setup failure'))
            .mockResolvedValueOnce(undefined);
        const openai = {
            getLiveCapability: vi.fn(async () => ({
                supported: true,
                configured: true,
                model: 'gpt-live-transcribe',
            })),
            startLive,
            sendAudioChunk,
            stopLive: vi.fn(async () => undefined),
            onMessage: vi.fn(() => vi.fn()),
            onError: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal('window', {api: {openai}});

        const service = new OpenAiStreamingService();
        await expect(service.start()).rejects.toThrow('temporary setup failure');

        expect(mocks.audioListener).toBeTypeOf('function');
        mocks.audioListener?.({
            generation: 1,
            sampleRate: 48_000,
            channels: 1,
            samples: [Float32Array.from({length: 1_920}, (_, index) => Math.sin(index / 12) * 0.4)],
            rms: 0.2,
        });
        expect(sendAudioChunk).not.toHaveBeenCalled();

        await service.start();

        expect(startLive).toHaveBeenCalledTimes(2);
        expect(sendAudioChunk).toHaveBeenCalledTimes(1);
        expect(sendAudioChunk.mock.calls[0]?.[0]?.data).toEqual(expect.any(String));
        expect(sendAudioChunk.mock.calls[0][0].data.length).toBeGreaterThan(100);

        await service.stop();
    });
});
