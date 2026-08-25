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
            commitLiveTurn: vi.fn(async () => undefined),
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

    it('starts translation once and exposes source plus translated transcript streams', async () => {
        let messageListener: ((message: Record<string, any>) => void) | null = null;
        const startLive = vi.fn(async () => undefined);
        const sendAudioChunk = vi.fn();
        const commitLiveTurn = vi.fn(async () => undefined);
        const openai = {
            getLiveCapability: vi.fn(async () => ({
                supported: true,
                configured: true,
                model: 'gpt-live-transcribe',
            })),
            startLive,
            sendAudioChunk,
            commitLiveTurn,
            stopLive: vi.fn(async () => undefined),
            onMessage: vi.fn((listener: (message: Record<string, any>) => void) => {
                messageListener = listener;
                return vi.fn();
            }),
            onError: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal('window', {api: {openai}});

        const translated = vi.fn();
        const service = new OpenAiStreamingService();
        service.onTranslation(translated);
        await service.start({targetLanguage: 'ru'});

        expect(startLive).toHaveBeenCalledWith({prompt: undefined, targetLanguage: 'ru'});
        const emitMessage = messageListener as unknown as (message: Record<string, any>) => void;
        emitMessage({type: 'session.input_transcript.delta', delta: 'Hello'});
        emitMessage({type: 'session.output_transcript.delta', delta: 'Привет'});
        expect(translated).toHaveBeenLastCalledWith({source: 'Hello', translated: 'Привет'});

        mocks.audioListener?.({
            generation: 1,
            sampleRate: 48_000,
            channels: 1,
            samples: [Float32Array.from({length: 9_600}, (_, index) => Math.sin(index / 12) * 0.4)],
            rms: 0.2,
        });
        expect(sendAudioChunk).toHaveBeenCalledTimes(1);

        await service.finalizeTurn();
        expect(commitLiveTurn).toHaveBeenCalledTimes(1);

        await service.stop();
    });

    it('acknowledges a captured translation watermark without consuming later channel deltas', async () => {
        let messageListener: ((message: Record<string, any>) => void) | null = null;
        const openai = {
            getLiveCapability: vi.fn(async () => ({
                supported: true,
                configured: true,
                model: 'gpt-live-transcribe',
            })),
            startLive: vi.fn(async () => undefined),
            sendAudioChunk: vi.fn(),
            commitLiveTurn: vi.fn(async () => undefined),
            stopLive: vi.fn(async () => undefined),
            onMessage: vi.fn((listener: (message: Record<string, any>) => void) => {
                messageListener = listener;
                return vi.fn();
            }),
            onError: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal('window', {api: {openai}});

        const translated = vi.fn();
        const service = new OpenAiStreamingService();
        service.onTranslation(translated);
        await service.start({targetLanguage: 'ru'});

        const emitMessage = messageListener as unknown as (message: Record<string, any>) => void;
        emitMessage({type: 'session.input_transcript.delta', delta: 'How'});
        emitMessage({type: 'session.output_transcript.delta', delta: 'Как'});
        const watermark = service.captureAcknowledgement();
        emitMessage({type: 'session.input_transcript.delta', delta: ' are'});

        expect(service.acknowledgeTranscript(watermark)).toBe(true);
        emitMessage({type: 'session.output_transcript.delta', delta: ' дела'});
        expect(translated).toHaveBeenLastCalledWith({
            source: ' are',
            translated: ' дела',
        });

        await service.stop();
        expect(service.acknowledgeTranscript(watermark)).toBe(false);
    });

    it('flushes a short transcription tail and finalizes a turn without stopping the socket', async () => {
        const sendAudioChunk = vi.fn();
        const commitLiveTurn = vi.fn(async () => undefined);
        const stopLive = vi.fn(async () => undefined);
        const openai = {
            getLiveCapability: vi.fn(async () => ({
                supported: true,
                configured: true,
                model: 'gpt-live-transcribe',
            })),
            startLive: vi.fn(async () => undefined),
            sendAudioChunk,
            commitLiveTurn,
            stopLive,
            onMessage: vi.fn(() => vi.fn()),
            onError: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal('window', {api: {openai}});

        const service = new OpenAiStreamingService();
        await service.start();
        stopLive.mockClear();
        mocks.audioListener?.({
            generation: 1,
            sampleRate: 48_000,
            channels: 1,
            samples: [Float32Array.from({length: 480}, (_, index) => Math.sin(index / 12) * 0.4)],
            rms: 0.2,
        });
        expect(sendAudioChunk).not.toHaveBeenCalled();

        await service.finalizeTurn();

        expect(sendAudioChunk).toHaveBeenCalledTimes(1);
        expect(commitLiveTurn).toHaveBeenCalledTimes(1);
        expect(stopLive).not.toHaveBeenCalled();

        await service.stop();
    });

    it('publishes corrected translation finals and a race-free output boundary', async () => {
        let messageListener: ((message: Record<string, any>) => void) | null = null;
        const openai = {
            getLiveCapability: vi.fn(async () => ({
                supported: true,
                configured: true,
                model: 'gpt-live-transcribe',
            })),
            startLive: vi.fn(async () => undefined),
            sendAudioChunk: vi.fn(),
            commitLiveTurn: vi.fn(async () => undefined),
            stopLive: vi.fn(async () => undefined),
            onMessage: vi.fn((listener: (message: Record<string, any>) => void) => {
                messageListener = listener;
                return vi.fn();
            }),
            onError: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal('window', {api: {openai}});

        const translated = vi.fn();
        const completed = vi.fn();
        const service = new OpenAiStreamingService();
        service.onTranslation(translated);
        service.onTranslationTurnCompleted(completed);
        await service.start({targetLanguage: 'ru'});

        const emitMessage = messageListener as unknown as (message: Record<string, any>) => void;
        emitMessage({type: 'session.output_transcript.delta', delta: 'Привт'});
        const boundary = service.waitForTranslationTurnCompleted();
        emitMessage({type: 'session.output_transcript.completed', transcript: 'Привет'});
        await boundary;

        expect(translated).toHaveBeenLastCalledWith({source: '', translated: 'Привет'});
        expect(completed).toHaveBeenCalledTimes(1);
        expect(service.isTranslationOutputComplete()).toBe(true);
        await expect(service.waitForTranslationTurnCompleted()).resolves.toBeUndefined();

        emitMessage({type: 'session.input_transcript.delta', delta: 'Next'});
        expect(service.isTranslationOutputComplete()).toBe(false);
        emitMessage({type: 'session.output_transcript.completed', transcript: 'Дальше'});
        expect(completed).toHaveBeenCalledTimes(2);

        service.acknowledgeTranscript();
        expect(service.isTranslationOutputComplete()).toBe(false);
        await service.stop();
    });
});
