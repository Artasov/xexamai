import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('history entitlement persistence policy', () => {
    it('keeps denied conversations memory-only and hydrates storage after access is granted', async () => {
        const storage = new Map<string, string>();
        vi.stubGlobal('window', {
            location: {origin: 'https://app.local'},
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
                removeItem: (key: string) => storage.delete(key),
            },
            addEventListener: vi.fn(),
            requestAnimationFrame: (callback: () => void) => {
                setTimeout(callback, 0);
                return 1;
            },
        });

        const history = await import('../src/renderer/ui/outputs');
        history.setChatHistoryScope(42, 'https://xlartas.com', false);
        history.appendChatMessage('user', 'memory only');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect([...storage.keys()].some((key) => key.includes('chat.sessions'))).toBe(false);

        history.setChatHistoryScope(42, 'https://xlartas.com', true);
        history.appendChatMessage('user', 'persisted');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect([...storage.keys()].some((key) => key.includes('chat.sessions'))).toBe(true);
    });
});
