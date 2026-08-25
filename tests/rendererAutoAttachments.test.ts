import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {PromptImageAttachment} from '../src/shared/ipc';

const mocks = vi.hoisted(() => ({
    state: {isProcessing: false, isRecording: true},
    stopActiveOperation: vi.fn().mockResolvedValue(true),
    finalizeRealtimeTurn: vi.fn().mockResolvedValue(undefined),
    handleTextSend: vi.fn().mockResolvedValue(true),
    acknowledgeRealtimeSubmission: vi.fn(),
    updateChatMessage: vi.fn(),
    removeChatMessages: vi.fn(),
}));

vi.mock('../src/renderer/state/appState', () => ({
    state: mocks.state,
    setDuration: vi.fn(),
    setProcessing: (value: boolean) => {
        mocks.state.isProcessing = value;
    },
    setRecording: (value: boolean) => {
        mocks.state.isRecording = value;
    },
}));

vi.mock('../src/renderer/app/streamController', () => ({
    StreamController: class {
        stopActiveOperation = mocks.stopActiveOperation;
        finalizeRealtimeTurn = mocks.finalizeRealtimeTurn;
        handleTextSend = mocks.handleTextSend;
        acknowledgeRealtimeSubmission = mocks.acknowledgeRealtimeSubmission;
        getRealtimeCanonicalSnapshot = () => ({
            target: 'openai-transcribe',
            revision: 1,
            text: 'Explain the diagram',
            source: 'Explain the diagram',
            translated: '',
        });
        getOperationSnapshot = () => ({
            inProgress: true,
            requestId: 'request-1',
            chatId: 'chat-1',
            userText: 'Explain the diagram',
            partialText: '',
        });

        constructor(_options: unknown) {}
    },
}));

vi.mock('../src/renderer/ui/status', () => ({
    getStatusSnapshot: () => ({text: 'Ready', type: 'ready'}),
    setStatus: vi.fn(),
}));

vi.mock('../src/renderer/ui/stopButton', () => ({
    hideStopButton: vi.fn(),
}));

vi.mock('../src/renderer/ui/outputs', () => ({
    CHAT_RETRY_EVENT_NAME: 'xexamai:test-retry',
    removeChatMessages: mocks.removeChatMessages,
    updateChatMessage: mocks.updateChatMessage,
}));

vi.mock('../src/renderer/ui/featureAccessModal', () => ({
    checkFeatureAccess: () => true,
    showFeatureAccessModal: vi.fn(),
}));

vi.mock('../src/renderer/state/rendererActivity', () => ({
    beginNativeRendererActivity: vi.fn(),
}));

const image: PromptImageAttachment = {
    id: 'screenshot-1',
    mime: 'image/png',
    base64: 'cGl4ZWxz',
    name: 'Screenshot',
    width: 640,
    height: 480,
};

const prompt = {
    text: 'Explain the diagram',
    visibleText: 'Explain the diagram',
    images: [image],
    realtimeTranslation: false,
};

function createUi() {
    return {
        updateRealtimeTranscript: vi.fn(),
        updateRealtimeTranslation: vi.fn(),
        applyRealtimeAcknowledgement: vi.fn(),
        restoreQuestionIfEmpty: vi.fn(),
        getQuestion: () => prompt.text,
        getPromptImages: () => [image],
        getAutoPromptSnapshot: () => ({...prompt, images: [...prompt.images]}),
        restoreAutoPrompt: vi.fn(),
        restoreAutoPromptImages: vi.fn(),
        clearAutoSubmittedPrompt: vi.fn(),
        addPromptImages: vi.fn(),
        clearSubmittedPrompt: vi.fn(),
        setAudioInputPresentation: vi.fn(),
        setSettingsSnapshot: vi.fn(),
        setAutoModeEnabled: vi.fn(),
        setReady: vi.fn(),
    };
}

type TestSubmission = {
    token: {epoch: number; cycle: number};
    prompt: typeof prompt;
    requestId: string | null;
    promptCleared: boolean;
    imagesRestored: boolean;
    cancelled: boolean;
    submittedAt: number;
};

type AttachmentSession = {
    autoModeEnabled: boolean;
    realtimeTranscription: boolean;
    autoSubmission: TestSubmission | null;
    autoAnswerEngine: {
        currentToken: () => {epoch: number; cycle: number};
        invalidate: () => {epoch: number; cycle: number};
    };
    cancelAutoSubmission: (
        disposition: 'manual' | 'auto-continuation' | 'auto-new-turn',
        restorePrompt: boolean,
    ) => Promise<void>;
    handleAutoEndpoint: (event: {
        type: 'endpoint';
        token: {epoch: number; cycle: number};
        at: number;
        mode: 'realtime';
        transcript: string;
        transcriptRevision: number;
        continuation: boolean;
        speechStartedAt: number;
        endpointAt: number;
        captureDurationMs: number;
        preRollMs: number;
    }) => Promise<void>;
    handleOperationSettled: (settlement: {
        requestId: string;
        status: 'completed' | 'failed' | 'cancelled';
        chatId?: string;
        userText?: string;
        userMessageId?: string;
        assistantMessageId?: string;
        partialText: string;
    }) => void;
};

function submission(token = {epoch: 0, cycle: 0}): TestSubmission {
    return {
        token,
        prompt: {...prompt, images: [...prompt.images]},
        requestId: 'request-1',
        promptCleared: true,
        imagesRestored: false,
        cancelled: false,
        submittedAt: 1_000,
    };
}

beforeEach(() => {
    mocks.state.isProcessing = false;
    mocks.state.isRecording = true;
    mocks.stopActiveOperation.mockReset().mockResolvedValue(true);
    mocks.finalizeRealtimeTurn.mockReset().mockResolvedValue(undefined);
    mocks.handleTextSend.mockReset().mockResolvedValue(true);
    mocks.acknowledgeRealtimeSubmission.mockReset();
    mocks.updateChatMessage.mockReset();
    mocks.removeChatMessages.mockReset();
    vi.stubGlobal('window', {
        setTimeout: (callback: () => void) => {
            callback();
            return 1;
        },
        clearTimeout: vi.fn(),
    });
});

describe('automatic screenshot attachment ownership', () => {
    it('restores text and image for a continuation and excludes the cancelled attempt', async () => {
        const {RendererSession} = await import('../src/renderer/renderer');
        const ui = createUi();
        const session = new RendererSession(ui) as unknown as AttachmentSession;
        session.autoSubmission = submission();

        await session.cancelAutoSubmission('auto-continuation', true);

        expect(ui.restoreAutoPrompt).toHaveBeenCalledOnce();
        expect(ui.restoreAutoPromptImages).not.toHaveBeenCalled();
        expect(mocks.stopActiveOperation).toHaveBeenCalledWith({
            disposition: 'auto-continuation',
            excludeFromHistory: true,
        });
        expect(session.autoSubmission).toBeNull();
    });

    it('moves only the image into a new turn and excludes the superseded partial turn', async () => {
        const {RendererSession} = await import('../src/renderer/renderer');
        const ui = createUi();
        const session = new RendererSession(ui) as unknown as AttachmentSession;
        session.autoSubmission = submission();

        await session.cancelAutoSubmission('auto-new-turn', false);

        expect(ui.restoreAutoPrompt).not.toHaveBeenCalled();
        expect(ui.restoreAutoPromptImages).toHaveBeenCalledOnce();
        expect(ui.restoreAutoPromptImages).toHaveBeenCalledWith([image]);
        expect(mocks.stopActiveOperation).toHaveBeenCalledWith({
            disposition: 'auto-new-turn',
            excludeFromHistory: true,
        });
    });

    it('consumes an image exactly once after a completed response', async () => {
        const {RendererSession} = await import('../src/renderer/renderer');
        const ui = createUi();
        const session = new RendererSession(ui) as unknown as AttachmentSession;
        session.autoSubmission = submission();

        session.handleOperationSettled({
            requestId: 'request-1',
            status: 'completed',
            chatId: 'chat-1',
            userText: prompt.text,
            userMessageId: 'user-1',
            assistantMessageId: 'assistant-1',
            partialText: 'Complete answer',
        });

        expect(ui.restoreAutoPrompt).not.toHaveBeenCalled();
        expect(ui.restoreAutoPromptImages).not.toHaveBeenCalled();
        expect(session.autoSubmission).toBeNull();
    });

    it('does not resurrect an image when a fast response settles during bridge dispatch', async () => {
        const {RendererSession} = await import('../src/renderer/renderer');
        const ui = createUi();
        let session!: AttachmentSession;
        mocks.handleTextSend.mockImplementationOnce(async () => {
            session.handleOperationSettled({
                requestId: 'request-1',
                status: 'completed',
                chatId: 'chat-1',
                userText: prompt.text,
                userMessageId: 'user-1',
                assistantMessageId: 'assistant-1',
                partialText: 'Complete answer',
            });
            session.autoAnswerEngine.invalidate();
            return true;
        });
        session = new RendererSession(ui) as unknown as AttachmentSession;
        session.autoModeEnabled = true;
        session.realtimeTranscription = true;
        const token = session.autoAnswerEngine.currentToken();

        await session.handleAutoEndpoint({
            type: 'endpoint',
            token,
            at: 2_000,
            mode: 'realtime',
            transcript: prompt.text,
            transcriptRevision: 1,
            continuation: false,
            speechStartedAt: 1_000,
            endpointAt: 2_000,
            captureDurationMs: 2_000,
            preRollMs: 800,
        });

        expect(ui.clearAutoSubmittedPrompt).toHaveBeenCalledOnce();
        expect(ui.restoreAutoPrompt).not.toHaveBeenCalled();
        expect(ui.restoreAutoPromptImages).not.toHaveBeenCalled();
        expect(mocks.stopActiveOperation).not.toHaveBeenCalled();
        expect(session.autoSubmission).toBeNull();
    });

    it('restores a failed or not-started submission without duplicating its image', async () => {
        const {RendererSession} = await import('../src/renderer/renderer');
        const failedUi = createUi();
        const failedSession = new RendererSession(failedUi) as unknown as AttachmentSession;
        failedSession.autoSubmission = submission();

        failedSession.handleOperationSettled({
            requestId: 'request-1',
            status: 'failed',
            chatId: 'chat-1',
            userText: prompt.text,
            userMessageId: 'user-1',
            assistantMessageId: 'assistant-1',
            partialText: '',
        });
        failedSession.handleOperationSettled({
            requestId: 'request-1',
            status: 'failed',
            partialText: '',
        });

        expect(failedUi.restoreAutoPrompt).toHaveBeenCalledOnce();
        expect(failedUi.restoreAutoPromptImages).not.toHaveBeenCalled();

        const notStartedUi = createUi();
        const notStartedSession = new RendererSession(notStartedUi) as unknown as AttachmentSession;
        notStartedSession.autoModeEnabled = true;
        notStartedSession.realtimeTranscription = true;
        mocks.handleTextSend.mockResolvedValueOnce(false);
        const token = notStartedSession.autoAnswerEngine.currentToken();

        await notStartedSession.handleAutoEndpoint({
            type: 'endpoint',
            token,
            at: 2_000,
            mode: 'realtime',
            transcript: prompt.text,
            transcriptRevision: 1,
            continuation: false,
            speechStartedAt: 1_000,
            endpointAt: 2_000,
            captureDurationMs: 2_000,
            preRollMs: 800,
        });

        expect(notStartedUi.clearAutoSubmittedPrompt).toHaveBeenCalledOnce();
        expect(notStartedUi.restoreAutoPrompt).toHaveBeenCalledOnce();
        expect(notStartedUi.restoreAutoPromptImages).not.toHaveBeenCalled();
        expect(notStartedSession.autoSubmission).toBeNull();
    });

    it('excludes a multimodal request invalidated while bridge dispatch is pending', async () => {
        let resolveStarted!: (started: boolean) => void;
        mocks.handleTextSend.mockReturnValueOnce(new Promise<boolean>((resolve) => {
            resolveStarted = resolve;
        }));
        const {RendererSession} = await import('../src/renderer/renderer');
        const ui = createUi();
        const session = new RendererSession(ui) as unknown as AttachmentSession;
        session.autoModeEnabled = true;
        session.realtimeTranscription = true;
        const token = session.autoAnswerEngine.currentToken();

        const handling = session.handleAutoEndpoint({
            type: 'endpoint',
            token,
            at: 2_000,
            mode: 'realtime',
            transcript: prompt.text,
            transcriptRevision: 1,
            continuation: false,
            speechStartedAt: 1_000,
            endpointAt: 2_000,
            captureDurationMs: 2_000,
            preRollMs: 800,
        });
        await vi.waitFor(() => expect(mocks.handleTextSend).toHaveBeenCalledOnce());
        session.autoAnswerEngine.invalidate();
        resolveStarted(true);
        await handling;

        expect(ui.restoreAutoPrompt).toHaveBeenCalledOnce();
        expect(mocks.stopActiveOperation).toHaveBeenCalledWith({
            disposition: 'auto-new-turn',
            excludeFromHistory: true,
        });
        expect(session.autoSubmission).toBeNull();
    });
});
