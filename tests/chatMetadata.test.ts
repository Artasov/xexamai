import {describe, expect, it} from 'vitest';
import {isChatProvider, isChatSource, resolveLlmProvider} from '@renderer/ui/chatMetadata';

describe('resolveLlmProvider', () => {
    it.each([
        [{llmHost: 'local', apiLlmModel: 'gemini-3.7-flash'}, 'ollama'],
        [{llmHost: 'api', apiLlmModel: 'gemini-3.7-flash'}, 'google'],
        [{llmHost: 'api', apiLlmModel: 'winky-high'}, 'winky'],
        [{llmHost: 'api', apiLlmModel: 'gpt-5-mini'}, 'openai'],
        [{llmHost: 'api', llmModel: 'gemini-2.5-flash'}, 'google'],
    ] as const)('maps %o to %s', (settings, expected) => {
        expect(resolveLlmProvider(settings)).toBe(expected);
    });
});

describe('chat metadata validation', () => {
    it('accepts only persisted source and provider values', () => {
        expect(isChatSource('screenshot')).toBe(true);
        expect(isChatSource('camera')).toBe(false);
        expect(isChatProvider('ollama')).toBe(true);
        expect(isChatProvider('local')).toBe(false);
    });
});
