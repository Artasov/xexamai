import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
    sockets: [] as FakeWebSocket[],
    eventListeners: new Map<string, Set<(event: {payload: unknown}) => void>>(),
}));

vi.mock('../src/renderer/bridge/nativeInvoke', () => ({
    invokeNative: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: mocks.listen,
}));

vi.mock('@tauri-apps/api/core', () => ({
    Channel: class {
        onmessage: ((message: unknown) => void) | null = null;
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => new Proxy({}, {
        get: () => vi.fn(async () => undefined),
    }),
    LogicalPosition: class {
        constructor(public x: number, public y: number) {}
    },
    LogicalSize: class {
        constructor(public width: number, public height: number) {}
    },
}));

vi.mock('../src/renderer/services/nativeAssistant', () => ({
    assistantAskChat: vi.fn(),
    assistantOffStreamDelta: vi.fn(),
    assistantOffStreamDone: vi.fn(),
    assistantOffStreamError: vi.fn(),
    assistantOffStreamTranscript: vi.fn(),
    assistantOnStreamDelta: vi.fn(),
    assistantOnStreamDone: vi.fn(),
    assistantOnStreamError: vi.fn(),
    assistantOnStreamTranscript: vi.fn(),
    assistantStopStream: vi.fn(),
    assistantTranscribeOnly: vi.fn(),
}));

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    binaryType = '';
    sent: Record<string, unknown>[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: {code: number; reason: string}) => void) | null = null;

    constructor(
        public readonly url: string,
        public readonly protocols?: string | string[],
    ) {
        mocks.sockets.push(this);
    }

    send(data: string): void {
        if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is closed');
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    message(payload: Record<string, unknown>): void {
        this.onmessage?.({data: JSON.stringify(payload)});
    }

    close(code = 1000, reason = ''): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        queueMicrotask(() => this.onclose?.({code, reason}));
    }
}

const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

const emitTauriEvent = (eventName: string, payload: unknown) => {
    for (const listener of mocks.eventListeners.get(eventName) ?? []) {
        listener({payload});
    }
};

const loadApi = async () => {
    await import('../src/renderer/bridge/tauriApi');
    return (globalThis.window as unknown as {api: Window['api']}).api;
};

const startTranscription = async (api: Window['api']) => {
    const starting = api.openai.startLive({});
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
    const socket = mocks.sockets[0];
    socket.open();
    socket.message({type: 'session.updated'});
    await starting;
    return socket;
};

beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.sockets.length = 0;
    mocks.eventListeners.clear();
    mocks.invoke.mockImplementation(async (command: string) => {
        if (command === 'openai_live_create_token') return {token: 'temporary-test-token'};
        return undefined;
    });
    mocks.listen.mockImplementation(async (
        eventName: string,
        listener: (event: {payload: unknown}) => void,
    ) => {
        const listeners = mocks.eventListeners.get(eventName) ?? new Set();
        listeners.add(listener);
        mocks.eventListeners.set(eventName, listeners);
        return () => listeners.delete(listener);
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
        },
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {userAgent: 'Windows test'},
    });
    Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        value: FakeWebSocket,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Tauri bridge realtime lifecycle', () => {
    it('serializes overlapping finalizations until the committed transcript is final', async () => {
        const api = await loadApi();
        const socket = await startTranscription(api);
        api.openai.sendAudioChunk({data: 'AA=='});

        const first = api.openai.commitLiveTurn();
        const second = api.openai.commitLiveTurn();
        let secondSettled = false;
        void second.then(() => { secondSettled = true; });
        await flushMicrotasks();

        expect(socket.sent.filter(({type}) => type === 'input_audio_buffer.commit')).toHaveLength(1);
        expect(secondSettled).toBe(false);

        socket.message({type: 'input_audio_buffer.committed', item_id: 'item-1'});
        await flushMicrotasks();
        expect(secondSettled).toBe(false);
        socket.message({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'item-1',
            transcript: 'Question',
        });

        await Promise.all([first, second]);
        expect(secondSettled).toBe(true);
    });

    it('rejects a failed final transcript instead of accepting a partial turn', async () => {
        const api = await loadApi();
        const socket = await startTranscription(api);
        api.openai.sendAudioChunk({data: 'AA=='});
        const finalizing = api.openai.commitLiveTurn();
        await flushMicrotasks();

        socket.message({type: 'input_audio_buffer.committed', item_id: 'failed-item'});
        await flushMicrotasks();
        socket.message({
            type: 'conversation.item.input_audio_transcription.failed',
            item_id: 'failed-item',
            error: {message: 'audio was not intelligible'},
        });

        await expect(finalizing).rejects.toThrow(/audio was not intelligible/i);
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it('resets an indeterminate commit timeout so the next session is not sequence-poisoned', async () => {
        vi.useFakeTimers();
        const api = await loadApi();
        const firstSocket = await startTranscription(api);
        api.openai.sendAudioChunk({data: 'AA=='});
        const timedOut = api.openai.commitLiveTurn();
        await flushMicrotasks();

        await vi.advanceTimersByTimeAsync(1_500);
        await expect(timedOut).rejects.toThrow(/did not acknowledge the audio commit/i);
        expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);

        const restarting = api.openai.startLive({});
        await vi.advanceTimersByTimeAsync(0);
        const secondSocket = mocks.sockets[1];
        expect(secondSocket).toBeDefined();
        secondSocket.open();
        secondSocket.message({type: 'session.updated'});
        await restarting;

        api.openai.sendAudioChunk({data: 'AA=='});
        const finalizing = api.openai.commitLiveTurn();
        await flushMicrotasks();
        secondSocket.message({type: 'input_audio_buffer.committed', item_id: 'fresh-item'});
        await flushMicrotasks();
        secondSocket.message({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'fresh-item',
            transcript: 'Fresh question',
        });
        await finalizing;
    });

    it('does not surface a superseded setup failure as realtime unavailable', async () => {
        const api = await loadApi();
        const errors: string[] = [];
        api.openai.onError((message) => errors.push(message));
        const starting = api.openai.startLive({});
        await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
        const socket = mocks.sockets[0];

        const stopping = api.openai.stopLive();
        socket.onerror?.();

        await expect(starting).resolves.toBeUndefined();
        await expect(stopping).resolves.toBeUndefined();
        expect(errors).toEqual([]);
    });

    it('does not mark native translation ready when session.closed wins the IPC resolve race', async () => {
        let resolveNativeStart!: () => void;
        const nativeStart = new Promise<void>((resolve) => {
            resolveNativeStart = resolve;
        });
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'openai_translation_start') return nativeStart;
            if (command === 'openai_live_create_token') return {token: 'temporary-test-token'};
            return undefined;
        });
        const api = await loadApi();
        const starting = api.openai.startLive({targetLanguage: 'English'});
        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith('openai_translation_start', {
                targetLanguage: 'English',
            });
        });

        emitTauriEvent('openai-translation-message', {type: 'session.closed'});
        resolveNativeStart();

        await expect(starting).rejects.toThrow(/closed during setup/i);
        api.openai.sendAudioChunk({data: 'AA=='});
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            'openai_translation_send_audio',
            expect.anything(),
        );
    });
});

describe('Tauri bridge screenshot lifecycle', () => {
    it('ignores stale events and cancellation settles and cleans the active native session', async () => {
        const api = await loadApi();
        const capture = api.screen.capture();
        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith(
                'screen_capture_start',
                expect.objectContaining({sessionId: expect.any(Number)}),
            );
        });
        const startCall = mocks.invoke.mock.calls.find(([command]) => command === 'screen_capture_start');
        const sessionId = (startCall?.[1] as {sessionId: number}).sessionId;

        let settled = false;
        void capture.then(() => { settled = true; });
        emitTauriEvent('screen-capture:completed', {
            sessionId: sessionId + 1,
            base64: 'stale',
            width: 1,
            height: 1,
            mime: 'image/jpeg',
        });
        await flushMicrotasks();
        expect(settled).toBe(false);

        await api.screen.cancel();
        await expect(capture).resolves.toBeNull();
        expect(mocks.invoke).toHaveBeenCalledWith('screen_capture_abort', {sessionId});
        for (const listeners of mocks.eventListeners.values()) {
            expect(listeners.size).toBe(0);
        }
    });
});
