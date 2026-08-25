import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

function stubWindow() {
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
            callback();
            return 1;
        },
    });
}

describe('automatic turn chat history', () => {
    it('keeps superseded drafts visible but out of future model context', async () => {
        stubWindow();
        const history = await import('../src/renderer/ui/outputs');
        const chatId = history.createNewChat();
        const userId = history.appendChatMessage('user', 'What is a transaction?', {chatId});
        history.appendChatMessage('assistant', 'A transaction groups operations', {
            chatId,
            historyExcluded: true,
        });
        history.updateChatMessage(userId, {historyExcluded: true}, {chatId});

        expect(history.getConversationContext(chatId)).toEqual([]);

        history.appendChatMessage('user', 'What is a database transaction?', {chatId});
        history.appendChatMessage('assistant', 'It is an atomic unit of work.', {chatId});
        expect(history.getConversationContext(chatId)).toEqual([
            {role: 'user', content: 'What is a database transaction?'},
            {role: 'assistant', content: 'It is an atomic unit of work.'},
        ]);
    });

    it('removes an empty superseded pair atomically', async () => {
        stubWindow();
        const history = await import('../src/renderer/ui/outputs');
        const chatId = history.createNewChat();
        const userId = history.appendChatMessage('user', 'unfinished question', {chatId});
        const assistantId = history.appendChatMessage('assistant', 'Syncing...', {
            chatId,
            pending: true,
        });

        expect(history.removeChatMessages([userId, assistantId], {chatId})).toBe(true);
        expect(history.getConversationContext(chatId)).toEqual([]);
        expect(history.removeChatMessages([userId, assistantId], {chatId})).toBe(false);
    });

    it('does not fall back to the active chat for a stale chat id', async () => {
        stubWindow();
        const history = await import('../src/renderer/ui/outputs');
        const chatId = history.createNewChat();
        const userId = history.appendChatMessage('user', 'Keep this message', {chatId});

        expect(history.removeChatMessages([userId], {chatId: 'deleted-chat'})).toBe(false);
        expect(history.getConversationContext(chatId)).toEqual([
            {role: 'user', content: 'Keep this message'},
        ]);
    });

    it('keeps a failed pair excluded until its retry succeeds', async () => {
        stubWindow();
        const history = await import('../src/renderer/ui/outputs');
        const chatId = history.createNewChat();
        const userId = history.appendChatMessage('user', 'Explain transactions', {chatId});
        const errorId = history.appendChatMessage('error', 'Network failed', {
            chatId,
            retryText: 'Explain transactions',
        });

        const retry = history.beginRetryChatMessage(chatId, errorId);
        expect(retry?.userMessageId).toBe(userId);
        expect(history.getConversationContext(chatId)).toEqual([]);

        history.updateChatMessage(userId, {historyExcluded: false}, {chatId});
        history.updateChatMessage(errorId, {
            role: 'assistant',
            text: 'A transaction is an atomic unit of work.',
            pending: false,
            historyExcluded: false,
        }, {chatId});
        expect(history.getConversationContext(chatId)).toEqual([
            {role: 'user', content: 'Explain transactions'},
            {role: 'assistant', content: 'A transaction is an atomic unit of work.'},
        ]);
    });

    it('refuses to retry an orphaned error that would create assistant-only context', async () => {
        stubWindow();
        const history = await import('../src/renderer/ui/outputs');
        const chatId = history.createNewChat();
        const errorId = history.appendChatMessage('error', 'Network failed', {
            chatId,
            retryText: 'Missing question',
        });

        expect(history.beginRetryChatMessage(chatId, errorId)).toBeNull();
        expect(history.getConversationContext(chatId)).toEqual([]);
    });
});
