import {describe, expect, it} from 'vitest';

import {buildHistoryScope, scopedHistoryStorageKey} from '../src/renderer/ui/historyScope';

describe('chat history storage isolation', () => {
    it('separates accounts and backend origins', () => {
        const comUser = buildHistoryScope('https://xlartas.com', 42);
        const ruUser = buildHistoryScope('https://xlartas.ru', 42);
        const otherUser = buildHistoryScope('https://xlartas.com', 43);
        expect(new Set([comUser, ruUser, otherUser]).size).toBe(3);
        expect(scopedHistoryStorageKey('history', comUser)).not.toBe(
            scopedHistoryStorageKey('history', otherUser),
        );
    });

    it('rejects an attacker-controlled backend origin', () => {
        expect(() => buildHistoryScope('https://xlartas.com.attacker.example', 42)).toThrow();
        expect(() => buildHistoryScope('http://xlartas.com', 42)).toThrow();
    });
});
