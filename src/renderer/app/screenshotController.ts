// noinspection JSUnusedGlobalSymbols

import {getActiveChatId, getConversationContext, showAnswer, showError, showText} from '../ui/outputs';
import {setStatus} from '../ui/status';
import {setProcessing, state} from '../state/appState';
import {updateButtonsState} from '../ui/controls';
import {logger} from '../utils/logger';
import {hideStopButton, showStopButton} from '../ui/stopButton';

type CancelToken = { cancelled: boolean };

export class ScreenshotController {
    private cancelToken: CancelToken | null = null;

    isActive(): boolean {
        return !!this.cancelToken && !this.cancelToken.cancelled;
    }

    cancelActive(): boolean {
        if (!this.cancelToken || this.cancelToken.cancelled) {
            return false;
        }
        logger.info('screenshot', 'Screenshot stop requested');
        this.cancelToken.cancelled = true;
        setStatus('Cancelled', 'ready');
        setProcessing(false);
        hideStopButton();
        updateButtonsState();
        return true;
    }

    async start(): Promise<void> {
        if (state.isProcessing) return;

        const cancelToken: CancelToken = {cancelled: false};
        this.cancelToken = cancelToken;
        const requestChatId = getActiveChatId();
        const textInput = document.getElementById('textInput') as HTMLTextAreaElement | null;
        const rawUserText = textInput?.value?.trim() || '';

        setProcessing(true);
        updateButtonsState();
        setStatus('Capturing screen...', 'processing');
        showAnswer('');
        showStopButton();

        try {
            logger.info('screenshot', 'Screenshot capture requested');
            const capture = await window.api.screen.capture();
            if (!capture || !capture.base64) {
                throw new Error('Failed to capture screen');
            }

            if (cancelToken.cancelled) {
                logger.info('screenshot', 'Screenshot cancelled after capture');
                return;
            }

            const timestamp = new Date().toLocaleString();
            const label = `[Screenshot captured ${timestamp}]`;
            const uiUserMessage = rawUserText ? `${label}\n${rawUserText}` : label;
            showText(uiUserMessage, requestChatId);
            if (textInput && rawUserText) {
                textInput.value = '';
                textInput.dispatchEvent(new Event('input', {bubbles: true}));
            }

            setStatus('Analyzing screenshot...', 'processing');
            const history = getConversationContext(requestChatId);

            const result = await window.api.screen.process({
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
                showAnswer(answerText, requestChatId);
            } else {
                showAnswer('No insights returned.', requestChatId);
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
            showError(message, requestChatId);
        } finally {
            if (this.cancelToken === cancelToken) {
                this.cancelToken = null;
                setProcessing(false);
                updateButtonsState();
                hideStopButton();
            }
        }
    }
}
