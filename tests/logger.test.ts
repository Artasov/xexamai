import {afterEach, describe, expect, it, vi} from 'vitest';

import {logger, redactOpenAiCredentials} from '../src/renderer/utils/logger';

const OPENAI_KEYS = [
    `sk-${'Ab3c'.repeat(8)}`,
    `sk-proj-${'Cd4e'.repeat(8)}`,
    `ek_${'Ef5g'.repeat(8)}`,
    `ek-${'Gh6i'.repeat(8)}`,
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('renderer log credential redaction', () => {
    it.each(OPENAI_KEYS)('redacts a bare OpenAI credential embedded in text', (credential) => {
        const output = redactOpenAiCredentials(`WebSocket protocol openai-insecure-api-key.${credential}, closed`);

        expect(output).not.toContain(credential);
        expect(output).toContain('[redacted OpenAI credential]');
    });

    it('does not redact short identifiers or ordinary readable text', () => {
        const input = 'Keep sk-test, ek_value, task-sketch, and sk-this-is-an-ordinary-long-slug.';

        expect(redactOpenAiCredentials(input)).toBe(input);
    });

    it('sanitizes both messages and nested string data before crossing the bridge', () => {
        const bridgeLog = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('window', {api: {log: bridgeLog}});
        const credential = OPENAI_KEYS[1];

        logger.warn('openai-live', `Connection rejected for ${credential}`, {
            nested: {detail: `protocol=${credential}`},
        });

        expect(bridgeLog).toHaveBeenCalledOnce();
        const [entry] = bridgeLog.mock.calls[0];
        expect(JSON.stringify(entry)).not.toContain(credential);
        expect(entry.message).toContain('[redacted OpenAI credential]');
        expect(entry.data.nested.detail).toContain('[redacted OpenAI credential]');
    });
});
