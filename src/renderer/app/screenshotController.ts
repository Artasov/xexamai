// noinspection JSUnusedGlobalSymbols

import {getActiveChatId, getConversationContext, showAnswer, showError, showText} from '../ui/outputs';
import {setStatus} from '../ui/status';
import {setProcessing, state} from '../state/appState';
import {logger} from '../utils/logger';
import {hideStopButton, showStopButton} from '../ui/stopButton';
import {settingsStore} from '../state/settingsStore';
import type {ChatProvider} from '../ui/chatMetadata';
import {beginNativeRendererActivity} from '../state/rendererActivity';

type CancelToken = { cancelled: boolean; requestId: string };
type ScreenshotControllerUi = {
    getQuestion?: () => string;
    clearQuestionIfUnchanged?: (value: string) => void;
};

export class ScreenshotController {
    private cancelToken: CancelToken | null = null;

    constructor(private readonly ui: ScreenshotControllerUi = {}) {
    }

    isActive(): boolean {
        return !!this.cancelToken && !this.cancelToken.cancelled;
    }

    cancelActive(): boolean {
        if (!this.cancelToken || this.cancelToken.cancelled) {
            return false;
        }
        logger.info('screenshot', 'Screenshot stop requested');
        this.cancelToken.cancelled = true;
        window.api.screen.cancel(this.cancelToken.requestId);
        setStatus('Cancelled', 'ready');
        setProcessing(false);
        hideStopButton();
        return true;
    }

    async start(): Promise<void> {
        if (state.isProcessing) return;

        const cancelToken: CancelToken = {cancelled: false, requestId: `screen-${crypto.randomUUID()}`};
        this.cancelToken = cancelToken;
        const requestChatId = getActiveChatId();
        const rawUserText = this.ui.getQuestion?.().trim() || '';
        let provider: ChatProvider = 'openai';
        try {
            provider = settingsStore.get().screenProcessingModel === 'google' ? 'google' : 'openai';
        } catch {
        }
        const metadata = {source: 'screenshot' as const, provider};

        setProcessing(true);
        setStatus('Capturing screen...', 'processing');
        showStopButton();

        let releaseActivity: (() => Promise<void>) | null = null;
        try {
            releaseActivity = await beginNativeRendererActivity('Capturing and analyzing screenshot');
            logger.info('screenshot', 'Screenshot capture requested');
            const capture = await window.api.screen.capture();
            if (!capture || !capture.base64) {
                throw new Error('Failed to capture screen');
            }

            if (cancelToken.cancelled) {
                logger.info('screenshot', 'Screenshot cancelled after capture');
                return;
            }

            // Capture context before appending the current screenshot marker so
            // the user request is not sent twice (once in history and once with the image).
            const history = getConversationContext(requestChatId);
            const timestamp = new Date().toLocaleString();
            const providerLabel = provider === 'google' ? 'Google' : 'OpenAI';
            const label = `[Screenshot ${capture.width}×${capture.height} sent to ${providerLabel} at ${timestamp}; image pixels are not stored in chat history]`;
            const uiUserMessage = rawUserText ? `${label}\n${rawUserText}` : label;
            showText(uiUserMessage, requestChatId, metadata);
            if (rawUserText) this.ui.clearQuestionIfUnchanged?.(rawUserText);

            setStatus('Analyzing screenshot...', 'processing');

            const result = await window.api.screen.process({
                requestId: cancelToken.requestId,
                imageBase64: capture.base64,
                mime: capture.mime,
                width: capture.width,
                height: capture.height,
                userText: rawUserText || undefined,
                history,
            });

            if (cancelToken.cancelled) {
                logger.info('screenshot', 'Screenshot cancelled after processing request');
                return;
            }

            if (!result?.ok) {
                throw new Error(result?.error || 'Screen processing failed');
            }

            const answerText = (result.answer || '').trim();
            if (answerText) {
                showAnswer(answerText, requestChatId, metadata);
            } else {
                showAnswer('No insights returned.', requestChatId, metadata);
            }
            setStatus('Done', 'ready');
            logger.info('screenshot', 'Screenshot analysis completed', {answerLength: result.answer?.length || 0});
        } catch (error) {
            if (cancelToken.cancelled) {
                logger.info('screenshot', 'Screenshot analysis cancelled', {
                    reason: error instanceof Error ? error.message : String(error),
                });
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.error('screenshot', 'Screenshot analysis failed', {error: message});
            setStatus('Error', 'error');
            showError(message, requestChatId, metadata);
        } finally {
            if (releaseActivity) {
                await releaseActivity().catch((error) => {
                    logger.warn('screenshot', 'Failed to release screenshot activity lease', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
            if (this.cancelToken === cancelToken) {
                this.cancelToken = null;
                setProcessing(false);
                hideStopButton();
            }
        }
    }
}
