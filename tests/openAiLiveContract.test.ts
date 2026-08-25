import {describe, expect, it} from 'vitest';
import {
    buildOpenAiLiveSessionUpdate,
    buildOpenAiLiveWebSocketUrl,
    OpenAiTranscriptAssembler,
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

    it('acknowledges only text present in a captured watermark', () => {
        const assembler = new OpenAiTranscriptAssembler();
        expect(assembler.apply({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'turn-1',
            delta: 'First question',
        })).toBe('First question');
        const watermark = assembler.captureAcknowledgement();

        expect(assembler.apply({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'turn-1',
            delta: ' with detail',
        })).toBe('First question with detail');
        assembler.acknowledge(watermark);

        expect(assembler.apply({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'turn-1',
            delta: ' and context',
        })).toBe(' with detail and context');
    });

    it('does not hide an authoritative revision that diverges after capture', () => {
        const assembler = new OpenAiTranscriptAssembler();
        assembler.apply({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'turn-1',
            delta: 'Helo',
        });
        const watermark = assembler.captureAcknowledgement();
        assembler.apply({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'turn-1',
            transcript: 'Hello',
        });
        assembler.acknowledge(watermark);

        expect(assembler.apply({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'turn-1',
            delta: ' world',
        })).toBe('Hello world');
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

    it('preserves asymmetric source and translation deltas after a captured watermark', () => {
        const assembler = new OpenAiTranslationTranscriptAssembler();
        assembler.apply({type: 'session.input_transcript.delta', delta: 'How'});
        assembler.apply({type: 'session.output_transcript.delta', delta: 'Как'});
        const watermark = assembler.captureAcknowledgement();

        assembler.apply({type: 'session.input_transcript.delta', delta: ' are'});
        assembler.acknowledge(watermark);
        expect(assembler.apply({
            type: 'session.output_transcript.delta',
            delta: ' дела',
        })).toEqual({
            source: ' are',
            translated: ' дела',
        });
    });

    it('does not clear a translation completion boundary received after capture', () => {
        const assembler = new OpenAiTranslationTranscriptAssembler();
        assembler.apply({type: 'session.output_transcript.delta', delta: 'Гото'});
        const watermark = assembler.captureAcknowledgement();
        assembler.apply({
            type: 'session.output_transcript.completed',
            transcript: 'Готово',
        });

        assembler.acknowledge(watermark);
        expect(assembler.isOutputCompleted()).toBe(true);
        expect(assembler.consumeOutputBoundary()).toBe(true);
    });

    it('replaces delta text with completed transcripts and exposes one output boundary', () => {
        const assembler = new OpenAiTranslationTranscriptAssembler();
        assembler.apply({type: 'session.input_transcript.delta', delta: 'Helo'});
        expect(assembler.apply({
            type: 'session.input_transcript.completed',
            transcript: 'Hello',
        })).toEqual({source: 'Hello', translated: ''});
        expect(assembler.completionState()).toEqual({input: true, output: false});

        assembler.apply({type: 'session.output_transcript.delta', delta: 'Привт'});
        expect(assembler.completionState()).toEqual({input: false, output: false});
        expect(assembler.apply({
            type: 'session.output_transcript.completed',
            transcript: 'Привет',
        })).toEqual({source: 'Hello', translated: 'Привет'});
        expect(assembler.isOutputCompleted()).toBe(true);
        expect(assembler.consumeOutputBoundary()).toBe(true);
        expect(assembler.consumeOutputBoundary()).toBe(false);

        assembler.apply({type: 'session.output_transcript.completed', transcript: 'Привет'});
        expect(assembler.consumeOutputBoundary()).toBe(false);
    });

    it('retains accumulated text when completion has no transcript and resets on delta or acknowledge', () => {
        const assembler = new OpenAiTranslationTranscriptAssembler();
        assembler.apply({type: 'session.output_transcript.delta', delta: 'Ready'});
        expect(assembler.apply({type: 'session.output_transcript.completed'})).toEqual({
            source: '',
            translated: 'Ready',
        });
        expect(assembler.isOutputCompleted()).toBe(true);

        assembler.apply({type: 'session.input_transcript.delta', delta: 'Next'});
        expect(assembler.isOutputCompleted()).toBe(false);
        assembler.apply({type: 'session.output_transcript.completed', transcript: 'Готово'});
        expect(assembler.isOutputCompleted()).toBe(true);
        assembler.acknowledge();
        expect(assembler.completionState()).toEqual({input: false, output: false});
        expect(assembler.consumeOutputBoundary()).toBe(false);
    });
});
