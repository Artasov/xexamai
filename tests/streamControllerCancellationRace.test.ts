import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    reconcileRealtimeAcknowledgement,
    reconcileRealtimeTranscript,
} from '../src/renderer/utils/realtimeTranscript';
import type {RealtimeAcknowledgementUpdate} from '../src/renderer/app/streamController';

const mocks = vi.hoisted(() => ({
    appendChatMessage: vi.fn(),
    updateChatMessage: vi.fn(),
    removeChatMessages: vi.fn(),
    state: {isProcessing: false, isRecording: false},
    settings: {
        llmHost: 'api',
        llmModel: 'gpt-4.1-nano',
        apiLlmModel: 'gpt-4.1-nano',
    },
}));

vi.mock('../src/renderer/ui/outputs', () => ({
    appendChatMessage: mocks.appendChatMessage,
    beginRetryChatMessage: vi.fn(),
    getActiveChatId: () => 'chat-1',
    getConversationContext: () => [],
    removeChatMessages: mocks.removeChatMessages,
    showError: vi.fn(),
    updateChatMessage: mocks.updateChatMessage,
}));

vi.mock('../src/renderer/state/appState', () => ({
    state: mocks.state,
    setProcessing: (value: boolean) => {
        mocks.state.isProcessing = value;
    },
    setRecording: vi.fn(),
}));

vi.mock('../src/renderer/state/settingsStore', () => ({
    settingsStore: {
        get: () => ({...mocks.settings}),
        load: async () => ({...mocks.settings}),
        patch: vi.fn(),
    },
}));

vi.mock('../src/renderer/ui/status', () => ({
    getStatusSnapshot: () => ({text: 'Ready', type: 'ready'}),
    setStatus: vi.fn(),
}));

vi.mock('../src/renderer/ui/stopButton', () => ({
    hideStopButton: vi.fn(),
    showStopButton: vi.fn(),
}));

vi.mock('../src/renderer/ui/chatMetadata', () => ({
    resolveLlmProvider: () => 'openai',
}));

vi.mock('../src/renderer/utils/logger', () => ({
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}));

type DoneHandler = (
    event: unknown,
    payload: {requestId?: string; full: string},
) => void;

beforeEach(() => {
    mocks.state.isProcessing = false;
    mocks.state.isRecording = false;
    mocks.appendChatMessage
        .mockReset()
        .mockReturnValueOnce('user-1')
        .mockReturnValueOnce('assistant-1');
    mocks.updateChatMessage.mockReset();
    mocks.removeChatMessages.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('StreamController dispatch cancellation races', () => {
    it('keeps a superseded multimodal partial visible but out of future context', async () => {
        type DeltaHandler = (
            event: unknown,
            payload: {requestId?: string; delta: string},
        ) => void;
        const handlers: {delta?: DeltaHandler} = {};
        const askChat = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('window', {
            api: {
                assistant: {
                    askChat,
                    stopStream: vi.fn().mockResolvedValue(undefined),
                    onStreamDelta: vi.fn((handler: DeltaHandler) => {
                        handlers.delta = handler;
                    }),
                    onStreamDone: vi.fn(),
                    onStreamError: vi.fn(),
                    offStreamDelta: vi.fn(),
                    offStreamDone: vi.fn(),
                    offStreamError: vi.fn(),
                },
            },
        });
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController();
        const image = {
            id: 'screenshot-1',
            mime: 'image/png',
            base64: 'cGl4ZWxz',
            name: 'Screenshot',
        };

        await expect(controller.handleTextSend('Explain this diagram', [image])).resolves.toBe(true);
        const requestId = controller.getOperationSnapshot().requestId;
        expect(requestId).toBeTruthy();
        expect(handlers.delta).toBeTypeOf('function');
        handlers.delta?.(undefined, {
            requestId: requestId || undefined,
            delta: 'This partial answer contains several useful words already.',
        });

        await controller.stopActiveOperation({
            disposition: 'auto-new-turn',
            excludeFromHistory: true,
        });

        expect(mocks.removeChatMessages).not.toHaveBeenCalled();
        expect(mocks.updateChatMessage).toHaveBeenCalledWith(
            'user-1',
            {historyExcluded: true},
            {chatId: 'chat-1'},
        );
        expect(mocks.updateChatMessage).toHaveBeenCalledWith(
            'assistant-1',
            expect.objectContaining({
                role: 'assistant',
                historyExcluded: true,
                pending: false,
            }),
            {chatId: 'chat-1'},
        );
    });

    it('keeps acknowledged cumulative realtime text out of the next canonical snapshot', async () => {
        const updates: Array<{previous: string; next: string}> = [];
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController({
            updateRealtimeTranscript: (previous, next) => updates.push({previous, next}),
        });
        const realtime = controller as unknown as {
            onTranscript: (text: string) => void;
            desiredRealtimeTarget: 'google';
        };
        realtime.desiredRealtimeTarget = 'google';

        realtime.onTranscript('First question');
        expect(controller.getRealtimeCanonicalSnapshot().text).toBe('First question');
        controller.acknowledgeRealtimeSubmission();
        expect(controller.getRealtimeCanonicalSnapshot().text).toBe('');

        realtime.onTranscript('First question with detail');
        expect(updates[updates.length - 1]).toEqual({previous: '', next: ' with detail'});
        expect(controller.getRealtimeCanonicalSnapshot().text).toBe(' with detail');

        realtime.onTranscript('First question with more detail');
        expect(updates[updates.length - 1]).toEqual({
            previous: ' with detail',
            next: ' with more detail',
        });
        expect(controller.getRealtimeCanonicalSnapshot().text).toBe(' with more detail');
    });

    it('preserves transcript received while a manual send is awaiting bridge dispatch', async () => {
        let resolveAsk!: () => void;
        const ask = new Promise<void>((resolve) => {
            resolveAsk = resolve;
        });
        vi.stubGlobal('window', {
            api: {
                assistant: {
                    askChat: vi.fn(() => ask),
                    stopStream: vi.fn().mockResolvedValue(undefined),
                    onStreamDelta: vi.fn(),
                    onStreamDone: vi.fn(),
                    onStreamError: vi.fn(),
                    offStreamDelta: vi.fn(),
                    offStreamDone: vi.fn(),
                    offStreamError: vi.fn(),
                },
            },
        });
        const acknowledgements: RealtimeAcknowledgementUpdate[] = [];
        let textarea = '';
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController({
            updateRealtimeTranscript: (previous, next) => {
                textarea = reconcileRealtimeTranscript(textarea, previous, next);
            },
            applyRealtimeAcknowledgement: (update) => {
                acknowledgements.push(update);
                textarea = reconcileRealtimeAcknowledgement(
                    textarea,
                    update.submittedText || update.acknowledgedTranscript,
                    update.transcript,
                );
            },
        });
        const realtime = controller as unknown as {
            onTranscript: (text: string) => void;
            desiredRealtimeTarget: 'google';
        };
        realtime.desiredRealtimeTarget = 'google';
        realtime.onTranscript('First question');

        const sending = controller.handleTextSend('First question');
        await vi.waitFor(() => expect(window.api.assistant.askChat).toHaveBeenCalledOnce());
        realtime.onTranscript('First question with detail');
        textarea += ' typed note';
        resolveAsk();
        await expect(sending).resolves.toBe(true);

        controller.acknowledgeRealtimeSubmission();
        expect(acknowledgements[acknowledgements.length - 1]).toEqual({
            target: 'google',
            submittedText: 'First question',
            acknowledgedTranscript: 'First question',
            acknowledgedSource: '',
            acknowledgedTranslated: '',
            transcript: ' with detail',
            source: ' with detail',
            translated: '',
        });
        expect(controller.getRealtimeCanonicalSnapshot()).toMatchObject({
            text: ' with detail',
            source: ' with detail',
        });
        expect(textarea).toBe('with detail typed note');
    });

    it('preserves asymmetric translation channels received during manual dispatch', async () => {
        let resolveAsk!: () => void;
        const ask = new Promise<void>((resolve) => {
            resolveAsk = resolve;
        });
        vi.stubGlobal('window', {
            api: {
                assistant: {
                    askChat: vi.fn(() => ask),
                    stopStream: vi.fn().mockResolvedValue(undefined),
                    onStreamDelta: vi.fn(),
                    onStreamDone: vi.fn(),
                    onStreamError: vi.fn(),
                    offStreamDelta: vi.fn(),
                    offStreamDone: vi.fn(),
                    offStreamError: vi.fn(),
                },
            },
        });
        const acknowledgements: RealtimeAcknowledgementUpdate[] = [];
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController({
            applyRealtimeAcknowledgement: (update) => acknowledgements.push(update),
        });
        const realtime = controller as unknown as {
            onTranslation: (text: {source: string; translated: string}) => void;
            activeRealtimeTarget: 'openai-translate';
        };
        realtime.activeRealtimeTarget = 'openai-translate';
        realtime.onTranslation({source: 'How', translated: 'Как'});
        let visibleTranslation = 'Как';

        const sending = controller.handleTextSend('Как', [], 'text', {
            submittedTranslationView: 'translated',
        });
        await vi.waitFor(() => expect(window.api.assistant.askChat).toHaveBeenCalledOnce());
        realtime.onTranslation({source: 'How are', translated: 'Как'});
        visibleTranslation += ' Answer briefly';
        resolveAsk();
        await expect(sending).resolves.toBe(true);

        controller.acknowledgeRealtimeSubmission();
        expect(acknowledgements[acknowledgements.length - 1]).toEqual({
            target: 'openai-translate',
            submittedText: 'Как',
            submittedTranslationView: 'translated',
            acknowledgedTranscript: '',
            acknowledgedSource: 'How',
            acknowledgedTranslated: 'Как',
            transcript: '',
            source: ' are',
            translated: '',
        });
        expect(controller.getRealtimeCanonicalSnapshot()).toMatchObject({
            text: '',
            source: ' are',
            translated: '',
        });
        const acknowledgement = acknowledgements[acknowledgements.length - 1];
        expect(reconcileRealtimeAcknowledgement(
            'How are',
            acknowledgement.acknowledgedSource,
            acknowledgement.source,
        )).toBe('are');
        expect(reconcileRealtimeAcknowledgement(
            visibleTranslation,
            acknowledgement.acknowledgedTranslated,
            acknowledgement.translated,
        )).toBe('Answer briefly');
    });

    it('reports not-started when stop wins while askChat is still dispatching', async () => {
        let resolveAsk!: () => void;
        const ask = new Promise<void>((resolve) => {
            resolveAsk = resolve;
        });
        const askChat = vi.fn(() => ask);
        vi.stubGlobal('window', {
            api: {
                assistant: {
                    askChat,
                    stopStream: vi.fn().mockResolvedValue(undefined),
                    onStreamDelta: vi.fn(),
                    onStreamDone: vi.fn(),
                    onStreamError: vi.fn(),
                    offStreamDelta: vi.fn(),
                    offStreamDone: vi.fn(),
                    offStreamError: vi.fn(),
                },
            },
        });
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController();

        const sending = controller.handleTextSend('Question');
        await vi.waitFor(() => expect(askChat).toHaveBeenCalledOnce());
        const stopping = controller.stopActiveOperation({disposition: 'manual'});
        await stopping;
        resolveAsk();

        await expect(sending).resolves.toBe(false);
    });

    it('still reports started when a provider completes before askChat returns', async () => {
        let doneHandler: DoneHandler | null = null;
        const askChat = vi.fn(async (request: {requestId: string}) => {
            doneHandler?.(undefined, {requestId: request.requestId, full: 'Fast answer'});
        });
        vi.stubGlobal('window', {
            api: {
                assistant: {
                    askChat,
                    stopStream: vi.fn().mockResolvedValue(undefined),
                    onStreamDelta: vi.fn(),
                    onStreamDone: vi.fn((handler: DoneHandler) => {
                        doneHandler = handler;
                    }),
                    onStreamError: vi.fn(),
                    offStreamDelta: vi.fn(),
                    offStreamDone: vi.fn(),
                    offStreamError: vi.fn(),
                },
            },
        });
        const {StreamController} = await import('../src/renderer/app/streamController');
        const controller = new StreamController();

        await expect(controller.handleTextSend('Question')).resolves.toBe(true);
        expect(controller.getOperationSnapshot().inProgress).toBe(false);
    });
});
