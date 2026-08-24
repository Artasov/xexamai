import {describe, expect, it} from 'vitest';
import {
    buildOpenAiLiveSessionUpdate,
    buildOpenAiLiveWebSocketUrl,
    OpenAiTranslationTranscriptAssembler,
    isOpenAiRealtimeTranslation,
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

describe('OpenAI Realtime translation contract', () => {
    it('activates only for the API translation model', () => {
        expect(isOpenAiRealtimeTranslation('api', 'gpt-realtime-translate')).toBe(true);
        expect(isOpenAiRealtimeTranslation('local', 'gpt-realtime-translate')).toBe(false);
        expect(isOpenAiRealtimeTranslation('api', 'gpt-live-transcribe')).toBe(false);
    });

    it('keeps source and translated append-only deltas independently', () => {
        const assembler = new OpenAiTranslationTranscriptAssembler();
        expect(assembler.apply({type: 'session.input_transcript.delta', delta: 'How'})).toEqual({
            source: 'How',
            translated: '',
        });
        expect(assembler.apply({type: 'session.output_transcript.delta', delta: 'Как'})).toEqual({
            source: 'How',
            translated: 'Как',
        });
        expect(assembler.apply({type: 'session.input_transcript.delta', delta: ' are'})).toEqual({
            source: 'How are',
            translated: 'Как',
        });

        assembler.acknowledge();
        expect(assembler.apply({type: 'session.output_transcript.delta', delta: ' дела'})).toEqual({
            source: '',
            translated: ' дела',
        });
    });
});
