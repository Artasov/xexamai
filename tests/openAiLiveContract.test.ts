import {describe, expect, it} from 'vitest';
import {
    buildOpenAiLiveSessionUpdate,
    buildOpenAiLiveWebSocketUrl,
    OPENAI_LIVE_ENDPOINT,
    OPENAI_LIVE_MODEL,
} from '../src/renderer/services/openAiLiveContract';

describe('OpenAI Live transcription contract', () => {
    it('connects with the transcription-bound secret without a generic model override', () => {
        const url = buildOpenAiLiveWebSocketUrl();
        expect(url).toBe(OPENAI_LIVE_ENDPOINT);
        expect(url).toBe('wss://api.openai.com/v1/realtime');
        expect(url).not.toContain('?model=');
    });

    it('uses manual commits because gpt-live-transcribe does not support VAD', () => {
        const update = buildOpenAiLiveSessionUpdate();
        const input = update.session.audio.input;

        expect(input.turn_detection).toBeNull();
        expect(input.format).toEqual({type: 'audio/pcm', rate: 24_000});
        expect(input.transcription).toMatchObject({
            model: OPENAI_LIVE_MODEL,
            delay: 'medium',
        });
    });

    it('does not force a language for code-switched speech', () => {
        const update = buildOpenAiLiveSessionUpdate('  Technical   interview  ');
        const transcription = update.session.audio.input.transcription;

        expect(transcription).not.toHaveProperty('language');
        expect(transcription).not.toHaveProperty('languages');
        expect(transcription.prompt).toBe('Technical interview');
    });
});
