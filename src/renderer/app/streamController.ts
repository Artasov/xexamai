import {
    appendChatMessage,
    beginRetryChatMessage,
    getActiveChatId,
    getConversationContext,
    showError,
    updateChatMessage
} from '../ui/outputs';
import {setStatus} from '../ui/status';
import {setProcessing, setRecording, state} from '../state/appState';
import {floatsToWav} from '../audio/encoder';
import {logger} from '../utils/logger';
import {settingsStore} from '../state/settingsStore';
import {GoogleStreamingService} from '../services/googleStreamingService';
import {LatestIntentQueue} from './latestIntentQueue';
import {
    checkOllamaInstalled,
    checkOllamaModelDownloaded,
    isOllamaModelDownloading,
    isOllamaModelWarming,
    normalizeOllamaModelName
} from '../services/ollama';
import {LOCAL_LLM_MODELS} from '@shared/constants';
import type {SwitchAudioResult} from './audioSession';
import {
    getAudioInputType,
    getLastSecondsFloats,
    setAudioInputType,
    startRecording as startAudioRecording,
    stopRecording as stopAudioRecording,
    switchAudioInput as switchAudioInputDevice,
} from './audioSession';
import {hideStopButton, showStopButton} from '../ui/stopButton';
import {resolveLlmProvider, type ChatProvider, type ChatSource} from '../ui/chatMetadata';
import {migrateLegacyAudioDeviceSelection} from './audioSession/deviceSelection';

export type AudioInputType = 'microphone' | 'system' | 'mixed';

export type StreamControllerUi = {
    updateRealtimeTranscript?: (previous: string, next: string) => void;
    restoreQuestionIfEmpty?: (text: string) => void;
    setAudioInputPresentation?: (type: AudioInputType, switching: boolean) => void;
};

type PendingConversation = {
    chatId: string;
    requestId: string;
    userText: string;
    userMessageId: string;
    assistantMessageId: string;
};

export class StreamController {
    private googleStreamingService = new GoogleStreamingService();
    private initialized = false;
    private disposed = false;

    private currentRequestId: string | null = null;
    private activeOpId = 0;
    private streamDeltaHandler: any = null;
    private streamDoneHandler: any = null;
    private streamErrorHandler: any = null;

    private streamAccumulator = '';
    private googleStreamingActive = false;
    private readonly googleRealtimeTransitions = new LatestIntentQueue();
    private lastRealtimeTranscript = '';
    private operationInProgress = false;
    private audioSwitchInProgress = false;
    private pendingConversation: PendingConversation | null = null;
    private cancelledRequestIds = new Set<string>();

    constructor(private readonly ui: StreamControllerUi = {}) {
    }

    private toErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private setErrorStatus(message: string): void {
        setStatus(message, 'error');
        setProcessing(false);
    }

    private async loadSettingsSafe(): Promise<any> {
        try {
            return settingsStore.get();
        } catch {
            return settingsStore.load();
        }
    }

    private readonly onTranscript = (text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) return;
        if (normalized === this.lastRealtimeTranscript) return;
        const previous = this.lastRealtimeTranscript;
        this.lastRealtimeTranscript = normalized;
        this.ui.updateRealtimeTranscript?.(previous, normalized);
    };

    private readonly onStreamingError = (error: string) => {
        console.error('Google streaming error:', error);
        setStatus(`Google error: ${error}`, 'error');
    };

    initialize(): void {
        if (this.initialized || this.disposed) return;
        this.initialized = true;
        this.googleStreamingService.onTranscript(this.onTranscript);
        this.googleStreamingService.onError(this.onStreamingError);
    }

    async syncInitialSettings(): Promise<void> {
        const settings = await this.loadSettingsSafe();
        try {
            await migrateLegacyAudioDeviceSelection(
                await window.api.audio.listDevices(),
                settings.audioInputDeviceId || '',
            );
        } catch (error) {
            logger.warn('audio', 'Legacy microphone selection could not be migrated', {
                error: this.toErrorMessage(error),
            });
        }
        const audioInputType = (settings.audioInputType || 'microphone') as AudioInputType;
        setAudioInputType(audioInputType);
        await this.updateToggleButtonLabel(audioInputType);
    }

    handleSettingsChange(key: string, value: unknown): boolean | Promise<boolean> {
        switch (key) {
            case 'audioInputType': {
                const normalized = value === 'system' ? 'system' : (value === 'mixed' ? 'mixed' : 'microphone');
                return this.applyAudioInputSetting(normalized);
            }
            case 'audioInputDeviceId':
                return this.applyAudioDeviceSetting(typeof value === 'string' ? value : '');
            case 'transcriptionMode':
            case 'transcriptionModel': {
                settingsStore.patch({[key]: value} as any);
                return (state.isRecording ? this.syncGoogleRealtime() : Promise.resolve()).then(() => true);
            }
            default:
                return false;
        }
    }

    async handleRecordToggle(shouldRecord: boolean): Promise<void> {
        try {
            if (shouldRecord) {
                await startAudioRecording();
                await this.syncGoogleRealtime();
            } else {
                try {
                    await stopAudioRecording();
                } finally {
                    // Recording state is changed by RendererSession before this
                    // call. Queueing the stop prevents it overlapping an older
                    // capability/token/WebSocket start.
                    await this.syncGoogleRealtime();
                }
            }
        } catch (error) {
            console.error('Record toggle failed', error);
            const message = error instanceof Error ? error.message : String(error);
            const code = (error as any)?.code;
            if (code === 'system-audio-capture-failed' || message === 'system-audio-capture-failed') {
                setStatus('System audio capture failed. Grant access or switch to microphone.', 'error');
            } else {
                setStatus('Failed to start recording', 'error');
            }
            setRecording(false);
            throw error;
        }
    }

    async handleAskWindow(seconds: number): Promise<void> {
        logger.info('ui', 'Handle ask window', {seconds});

        if (state.isProcessing) {
            await this.stopActiveOperation();
        }

        const opId = ++this.activeOpId;
        const chatId = getActiveChatId();
        this.operationInProgress = true;

        setProcessing(true);
        showStopButton();
        setStatus('Recognizing...', 'processing');

        const pcm = getLastSecondsFloats(seconds);
        if (!pcm || pcm.channels[0].length === 0) {
            logger.warn('ui', 'No audio in buffer', {
                seconds,
                hasPcm: !!pcm,
                channelsLength: pcm?.channels?.length || 0,
                firstChannelLength: pcm?.channels[0]?.length || 0,
                inputType: getAudioInputType()
            });
            setStatus('No audio in buffer', 'error');
            setProcessing(false);
            this.operationInProgress = false;
            hideStopButton();
            return;
        }

        const actualSeconds = pcm.durationSeconds;
        const durationLabel = actualSeconds >= 10 ? actualSeconds.toFixed(1) : actualSeconds.toFixed(2);
        const hasFullWindow = actualSeconds + (1 / pcm.sampleRate) >= seconds;
        appendChatMessage(
            'system',
            hasFullWindow
                ? `Last ${durationLabel}s sent for transcription...`
                : `Only ${durationLabel}s of the requested ${seconds}s is available; sending that audio...`,
            {chatId, source: 'audio'},
        );

        let audioBuffer: ArrayBuffer;
        let maxAmplitude = 0;
        let rms = 0;
        let expectedFrames = 0;
        let dataMaxAmp = 0;
        try {
            const result = await this.prepareAudioBuffer(pcm, actualSeconds);
            audioBuffer = result.arrayBuffer;
            maxAmplitude = result.maxAmplitude;
            rms = result.rms;
            expectedFrames = result.expectedFrames;
            dataMaxAmp = result.dataMaxAmp;
        } catch (error) {
            this.setErrorStatus(this.toErrorMessage(error));
            this.operationInProgress = false;
            setProcessing(false);
            hideStopButton();
            return;
        }

        const requestId = `ask-window-${crypto.randomUUID()}`;
        this.currentRequestId = requestId;
        logger.info('ui', 'Sending audio for transcription', {
            size: audioBuffer.byteLength,
            requestedSeconds: seconds,
            actualSeconds,
            sampleRate: pcm.sampleRate,
            channels: pcm.channels.length,
            frames: expectedFrames,
            maxAmplitude,
            rms,
            wavDataMaxAmp: dataMaxAmp,
            wavHeaderValid: true,
        });

        try {
            const transcribeRes = await window.api.assistant.transcribeOnly({
                arrayBuffer: audioBuffer,
                mime: 'audio/wav',
                filename: `last_${Math.round(actualSeconds * 1000)}ms.wav`,
                audioSeconds: actualSeconds,
                requestId,
            });

            if (opId !== this.activeOpId) {
                setStatus('Ready', 'ready');
                setProcessing(false);
                this.operationInProgress = false;
                return;
            }
            if (!transcribeRes.ok) {
                setStatus('Error', 'error');
                showError(transcribeRes.error, chatId, {source: 'audio'});
                setProcessing(false);
                this.operationInProgress = false;
                this.currentRequestId = null;
                hideStopButton();
                return;
            }

            const text = transcribeRes.text;

            setStatus('Sending to LLM...', 'sending');
            const started = await this.sendChatRequest(requestId, text, 'audio', chatId, opId);
            if (!started) {
                this.ui.restoreQuestionIfEmpty?.(text);
            }
        } catch (error) {
            if (opId !== this.activeOpId) {
                // A user cancellation invalidates this operation before the
                // native transcription promise rejects. Do not surface that
                // expected cancellation as a new error.
                setProcessing(false);
                this.operationInProgress = false;
                this.currentRequestId = null;
                hideStopButton();
                this.removeStreamHandlers();
                return;
            }
            setStatus('Error', 'error');
            const hadPending = !!this.pendingConversation;
            this.failPendingConversation(this.toErrorMessage(error));
            if (!hadPending) {
                showError(error, chatId, {source: 'audio'});
            }
            setProcessing(false);
            this.operationInProgress = false;
            this.currentRequestId = null;
            hideStopButton();
            this.removeStreamHandlers();
        }
    }

    async handleTextSend(text: string): Promise<boolean> {
        const normalizedText = text.trim();
        if (!normalizedText) return false;
        logger.info('ui', 'Handle text send', {
            textLength: normalizedText.length,
        });
        const opId = ++this.activeOpId;
        const chatId = getActiveChatId();
        this.operationInProgress = true;
        setProcessing(true);
        showStopButton();

        const requestId = `text-send-${crypto.randomUUID()}`;

        try {
            if (opId !== this.activeOpId) {
                setStatus('Ready', 'ready');
                setProcessing(false);
                this.operationInProgress = false;
                hideStopButton();
                return false;
            }
            setStatus('Sending to LLM...', 'sending');
            const started = await this.sendChatRequest(requestId, normalizedText, 'text', chatId, opId);
            return started;
        } catch (error) {
            setStatus('Error', 'error');
            const hadPending = !!this.pendingConversation;
            this.failPendingConversation(this.toErrorMessage(error));
            if (!hadPending) {
                showError(error, chatId, {source: 'text'});
            }
            setProcessing(false);
            this.operationInProgress = false;
            this.currentRequestId = null;
            hideStopButton();
            this.removeStreamHandlers();
            return false;
        }
    }

    async stopActiveStream(): Promise<boolean> {
        return this.stopActiveOperation();
    }

    async retryFailedMessage(detail: {chatId?: string; messageId?: string; text?: string} | string): Promise<boolean> {
        const payload = typeof detail === 'string' ? {text: detail} : detail;
        const normalized = payload.text?.trim() || '';
        if (!normalized || !payload.chatId || !payload.messageId || state.isProcessing) return false;

        const opId = ++this.activeOpId;
        this.operationInProgress = true;
        setProcessing(true);
        setStatus('Checking model...', 'processing');
        try {
            if (!(await this.ensureLlmReady()) || opId !== this.activeOpId) {
                setProcessing(false);
                this.operationInProgress = false;
                return false;
            }
            const retry = beginRetryChatMessage(payload.chatId, payload.messageId);
            if (!retry) throw new Error('The selected message can no longer be retried.');
            const requestId = `retry-${crypto.randomUUID()}`;
            this.pendingConversation = {...retry, requestId};
            const provider = resolveLlmProvider(await this.loadSettingsSafe());
            updateChatMessage(retry.assistantMessageId, {
                retryText: retry.userText,
                pending: true,
                source: retry.source,
                provider,
            }, {chatId: retry.chatId});
            const history = getConversationContext(retry.chatId);
            const lastHistoryMessage = history[history.length - 1];
            if (lastHistoryMessage?.role === 'user' && lastHistoryMessage.content.trim() === retry.userText) {
                history.pop();
            }
            this.currentRequestId = requestId;
            this.prepareStreamHandlers(requestId);
            showStopButton();
            setStatus('Retrying...', 'sending');
            await window.api.assistant.askChat({text: retry.userText, requestId, history});
            return true;
        } catch (error) {
            this.failPendingConversation(this.toErrorMessage(error));
            setStatus('Error', 'error');
            setProcessing(false);
            this.operationInProgress = false;
            this.currentRequestId = null;
            hideStopButton();
            this.removeStreamHandlers();
            return false;
        }
    }

    async stopActiveOperation(): Promise<boolean> {
        const hasActive = this.operationInProgress || !!this.currentRequestId;
        if (!hasActive) {
            return false;
        }

        this.activeOpId++;
        const requestId = this.currentRequestId;
        logger.info('ui', 'Stop operation requested', {requestId});
        if (requestId) {
            this.cancelledRequestIds.add(requestId);
            try {
                await window.api.assistant.stopStream({requestId});
            } catch (error) {
                console.error('Stop stream error', error);
            }
        }

        if (this.pendingConversation) {
            const pending = this.pendingConversation;
            const partial = this.streamAccumulator.trim();
            updateChatMessage(pending.assistantMessageId, {
                role: 'error',
                text: partial ? `${partial}\n\n[Interrupted — retry to continue]` : '[Interrupted — retry to continue]',
                pending: false,
                interrupted: true,
                retryText: pending.userText,
            }, {chatId: pending.chatId});
            this.pendingConversation = null;
        }

        this.currentRequestId = null;
        this.removeStreamHandlers();
        setStatus('Ready', 'ready');
        setProcessing(false);
        this.operationInProgress = false;
        hideStopButton();
        return true;
    }

    async handleHotkeyToggleRequest(): Promise<void> {
        await this.handleAudioInputToggle();
    }

    async handleAudioInputToggleRequest(): Promise<void> {
        await this.handleAudioInputToggle();
    }

    private async applyAudioInputSetting(type: AudioInputType): Promise<boolean> {
        if (type === getAudioInputType()) {
            await this.updateToggleButtonLabel(type);
            return true;
        }
        if (this.audioSwitchInProgress) {
            settingsStore.patch({audioInputType: getAudioInputType()});
            return false;
        }

        this.audioSwitchInProgress = true;
        this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
        try {
            const result = await this.switchAudioInput(type);
            return result.success;
        } catch (error) {
            logger.error('audio', 'Settings audio input switch failed', {error: this.toErrorMessage(error)});
            return false;
        } finally {
            this.audioSwitchInProgress = false;
            this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
        }
    }

    private async applyAudioDeviceSetting(deviceId: string): Promise<boolean> {
        const current = settingsStore.get().audioInputDeviceId || '';
        if (deviceId === current) return true;
        if (this.audioSwitchInProgress) return false;

        this.audioSwitchInProgress = true;
        this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
        try {
            const result = await this.switchAudioInput(getAudioInputType(), deviceId);
            return result.success;
        } catch (error) {
            logger.error('audio', 'Settings microphone switch failed', {error: this.toErrorMessage(error)});
            return false;
        } finally {
            this.audioSwitchInProgress = false;
            this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
        }
    }

    private async prepareAudioBuffer(
        pcm: { channels: Float32Array[]; sampleRate: number; durationSeconds: number },
        seconds: number
    ): Promise<{
        arrayBuffer: ArrayBuffer;
        maxAmplitude: number;
        rms: number;
        expectedFrames: number;
        dataMaxAmp: number;
    }> {
        let maxAmplitude = 0;
        let sumSquared = 0;
        let sampleCount = 0;
        for (const channel of pcm.channels) {
            for (let i = 0; i < channel.length; i++) {
                const amp = Math.abs(channel[i]);
                sumSquared += channel[i] * channel[i];
                sampleCount++;
                if (amp > maxAmplitude) {
                    maxAmplitude = amp;
                }
            }
        }
        const rms = Math.sqrt(sumSquared / Math.max(1, sampleCount));

        if (maxAmplitude < 0.0001 && rms < 0.00005) {
            logger.warn('ui', 'Audio appears to be silence', {
                maxAmplitude,
                rms,
                seconds,
                frames: pcm.channels[0].length,
            });
            throw new Error('No audio signal detected (silence). Check microphone and speak louder.');
        }

        if (maxAmplitude < 0.01) {
            logger.warn('ui', 'Audio is very quiet, may cause transcription issues', {
                maxAmplitude,
                rms,
                seconds,
            });
        }

        const expectedFrames = pcm.channels[0]?.length || 0;
        for (let i = 1; i < pcm.channels.length; i++) {
            if (pcm.channels[i]?.length !== expectedFrames) {
                logger.error('ui', 'Channel length mismatch', {
                    channel0: pcm.channels[0]?.length,
                    channelI: pcm.channels[i]?.length,
                    channelIndex: i,
                });
            }
        }

        const wav = floatsToWav(pcm.channels, pcm.sampleRate);
        const arrayBuffer = await wav.arrayBuffer();

        if (arrayBuffer.byteLength < 1000) {
            logger.error('ui', 'WAV file too small', {
                size: arrayBuffer.byteLength,
                seconds,
                frames: expectedFrames,
                sampleRate: pcm.sampleRate,
                channels: pcm.channels.length,
            });
            throw new Error('Audio buffer too small or empty');
        }

        const view = new DataView(arrayBuffer);
        const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
        if (riff !== 'RIFF' || wave !== 'WAVE') {
            logger.error('ui', 'Invalid WAV header', {riff, wave});
            throw new Error('Invalid audio format');
        }

        let dataMaxAmp = 0;
        if (arrayBuffer.byteLength > 44) {
            const dataView = new DataView(arrayBuffer, 44);
            const sampleCount = (arrayBuffer.byteLength - 44) / 2;
            for (let i = 0; i < Math.min(sampleCount, 1000); i++) {
                const sample = dataView.getInt16(i * 2, true);
                const amp = Math.abs(sample / 32767.0);
                if (amp > dataMaxAmp) dataMaxAmp = amp;
            }
        }

        return {arrayBuffer, maxAmplitude, rms, expectedFrames, dataMaxAmp};
    }

    private async sendChatRequest(
        requestId: string,
        text: string,
        source: ChatSource,
        chatId: string,
        opId?: number,
    ): Promise<boolean> {
        if (typeof opId === 'number' && opId !== this.activeOpId) {
            return false;
        }
        if (!(await this.ensureLlmReady())) {
            setProcessing(false);
            this.operationInProgress = false;
            hideStopButton();
            return false;
        }
        if (typeof opId === 'number' && opId !== this.activeOpId) {
            return false;
        }
        const provider = resolveLlmProvider(await this.loadSettingsSafe());
        const history = getConversationContext(chatId);
        this.pendingConversation = this.createPendingConversation(chatId, requestId, text, source, provider);
        this.currentRequestId = requestId;
        this.prepareStreamHandlers(requestId);
        showStopButton();
        await window.api.assistant.askChat({text, requestId, history});
        return true;
    }

    private prepareStreamHandlers(requestId: string): void {
        this.removeStreamHandlers();
        this.streamAccumulator = '';

        this.streamDeltaHandler = (_e: unknown, payload: { requestId?: string; delta: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId) || this.currentRequestId !== requestId) return;
            this.streamAccumulator += payload.delta || '';
            if (this.pendingConversation?.requestId === requestId) {
                const pending = this.pendingConversation;
                updateChatMessage(this.pendingConversation.assistantMessageId, {
                    text: this.streamAccumulator,
                    pending: true,
                }, {chatId: pending.chatId});
            }
            setStatus('Responding...', 'processing');
            showStopButton();
        };

        this.streamDoneHandler = (_e: unknown, payload: { requestId?: string; full: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId)) return;
            logger.info('stream', 'Stream done handler called', {requestId: payload.requestId});
            const full = (payload.full || this.streamAccumulator || '').trim();
            const pending = this.pendingConversation?.requestId === requestId ? this.pendingConversation : null;
            if (pending) {
                updateChatMessage(pending.assistantMessageId, {
                    text: full,
                    pending: false,
                    retryText: undefined,
                    interrupted: false,
                }, {chatId: pending.chatId});
                this.pendingConversation = null;
            }
            this.cancelledRequestIds.delete(requestId);
            this.currentRequestId = null;
            setStatus('Done', 'ready');
            setProcessing(false);
            this.operationInProgress = false;
            hideStopButton();
            this.removeStreamHandlers();
        };

        this.streamErrorHandler = (_e: unknown, payload: { requestId?: string; error: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId)) return;
            logger.info('stream', 'Stream error handler called', {requestId: payload.requestId, error: payload.error});
            this.currentRequestId = null;
            const msg = (payload.error || '').toString();
            const pending = this.pendingConversation?.requestId === requestId ? this.pendingConversation : null;
            const aborted = msg.toLowerCase().includes('aborted') || this.cancelledRequestIds.has(requestId);
            if (pending) {
                if (aborted) {
                    const partial = this.streamAccumulator.trim();
                    updateChatMessage(pending.assistantMessageId, {
                        role: 'error',
                        text: partial ? `${partial}\n\n[Interrupted — retry to continue]` : '[Interrupted — retry to continue]',
                        pending: false,
                        interrupted: true,
                        retryText: pending.userText,
                    }, {chatId: pending.chatId});
                } else {
                    updateChatMessage(pending.assistantMessageId, {
                        role: 'error',
                        text: payload.error,
                        pending: false,
                        retryText: pending.userText,
                    }, {chatId: pending.chatId});
                }
                this.pendingConversation = null;
            }
            this.cancelledRequestIds.delete(requestId);

            if (aborted) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
            }
            setProcessing(false);
            this.operationInProgress = false;
            hideStopButton();
            this.removeStreamHandlers();
        };

        window.api.assistant.onStreamDelta(this.streamDeltaHandler);
        window.api.assistant.onStreamDone(this.streamDoneHandler);
        window.api.assistant.onStreamError(this.streamErrorHandler);
    }

    private createPendingConversation(
        chatId: string,
        requestId: string,
        userText: string,
        source: ChatSource,
        provider: ChatProvider,
    ): PendingConversation {
        const userMessageId = appendChatMessage('user', userText, {chatId, source, provider});
        const assistantMessageId = appendChatMessage('assistant', 'Syncing...', {
            pending: true,
            chatId,
            retryText: userText,
            source,
            provider,
        });
        return {
            chatId,
            requestId,
            userText,
            userMessageId,
            assistantMessageId,
        };
    }

    private failPendingConversation(errorMessage: string): void {
        if (!this.pendingConversation) return;
        updateChatMessage(this.pendingConversation.assistantMessageId, {
            role: 'error',
            text: errorMessage,
            pending: false,
            retryText: this.pendingConversation.userText,
        }, {chatId: this.pendingConversation.chatId});
        this.pendingConversation = null;
    }

    private async ensureLlmReady(): Promise<boolean> {
        const settings = await this.loadSettingsSafe();

        if (settings.llmHost !== 'local') {
            return true;
        }

        const model = normalizeOllamaModelName(
            settings.localLlmModel || settings.llmModel || LOCAL_LLM_MODELS[0] || 'gpt-oss:20b'
        );

        try {
            const installed = await checkOllamaInstalled();
            if (!installed) {
                setStatus('Install Ollama to use local LLMs', 'error');
                return false;
            }
        } catch (error) {
            logger.error('llm', 'Failed to detect Ollama', {error});
            setStatus('Failed to detect Ollama installation', 'error');
            return false;
        }

        try {
            const downloaded = await checkOllamaModelDownloaded(model, {force: true});
            if (!downloaded) {
                setStatus(`Download the ${model} LLM model first`, 'error');
                return false;
            }
            if (isOllamaModelDownloading(model)) {
                setStatus(`The ${model} model is downloading`, 'error');
                return false;
            }
            if (isOllamaModelWarming(model)) {
                setStatus(`The ${model} model is warming up`, 'error');
                return false;
            }
        } catch (error) {
            logger.error('llm', 'Failed to verify Ollama model', {error});
            setStatus('Failed to verify local LLM model', 'error');
            return false;
        }

        return true;
    }

    private removeStreamHandlers(): void {
        try {
            (window.api.assistant as any).offStreamTranscript?.();
            (window.api.assistant as any).offStreamDelta?.();
            (window.api.assistant as any).offStreamDone?.();
            (window.api.assistant as any).offStreamError?.();
        } catch {
        }
        this.streamDeltaHandler = null;
        this.streamDoneHandler = null;
        this.streamErrorHandler = null;
        this.streamAccumulator = '';
    }

    private async handleAudioInputToggle(): Promise<void> {
        if (this.audioSwitchInProgress) return;
        this.audioSwitchInProgress = true;
        this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
        try {
            const currentType = getAudioInputType();
            const nextType: 'microphone' | 'system' | 'mixed' =
                currentType === 'microphone'
                    ? 'system'
                    : currentType === 'system'
                        ? 'mixed'
                        : 'microphone';

            const result = await this.switchAudioInput(nextType);
            settingsStore.patch({audioInputType: result.activeType});
        } catch (error) {
            console.error('Toggle input failed', error);
        } finally {
            this.audioSwitchInProgress = false;
            this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
        }
    }

    private async syncGoogleRealtime(): Promise<void> {
        return this.googleRealtimeTransitions.run(async (isCurrent) => {
            if (!isCurrent()) return;
            const settings = await this.loadSettingsSafe();
            if (!isCurrent()) return;
            const shouldRun = !this.disposed
                && state.isRecording
                && settings.transcriptionMode !== 'local'
                && typeof settings.transcriptionModel === 'string'
                && settings.transcriptionModel.startsWith('gemini-');
            if (!shouldRun) {
                await this.googleStreamingService.stop();
                if (!isCurrent()) return;
                this.googleStreamingActive = false;
                this.lastRealtimeTranscript = '';
                return;
            }
            if (this.googleStreamingActive) return;
            this.lastRealtimeTranscript = '';
            try {
                await this.googleStreamingService.start(null, {streamMode: 'base'});
                if (!isCurrent()) return;
                this.googleStreamingActive = true;
                setStatus('Recording · Gemini Live transcription active', 'recording');
            } catch (error) {
                this.googleStreamingActive = false;
                await this.googleStreamingService.stop().catch(() => undefined);
                if (!isCurrent()) return;
                logger.warn('google-live', 'Realtime transcription unavailable', {
                    error: this.toErrorMessage(error),
                });
                // Realtime is an enhancement; retain the rolling recorder so
                // normal "send last N seconds" requests keep working.
                setStatus('Recording · realtime transcription unavailable', 'recording');
            }
        });
    }

    private async switchAudioInput(newType: AudioInputType, newDeviceId?: string): Promise<SwitchAudioResult> {
        logger.info('audio', 'Switch input requested', {newType, newDeviceId});

        const result = await switchAudioInputDevice(newType, newDeviceId);
        setAudioInputType(result.activeType);
        settingsStore.patch({
            audioInputType: result.activeType,
            audioInputDeviceId: result.activeDeviceId,
        });
        try {
            await this.updateToggleButtonLabel(result.activeType);
        } catch {
        }
        if (!result.success) return result;

        if (state.isRecording) {
            // GoogleStreamingService subscribes to the shared native audio bus,
            // so the existing Live session automatically receives the new
            // source. Keeping it open avoids dropping audio during a reconnect.
            setStatus(
                this.googleStreamingActive
                    ? 'Recording · Gemini Live transcription active'
                    : 'Recording...',
                'recording',
            );
        }

        return result;
    }

    private async updateToggleButtonLabel(preferred?: AudioInputType): Promise<void> {
        let type: AudioInputType | undefined = preferred;
        if (!type) {
            const settings = await this.loadSettingsSafe();
            type = (settings.audioInputType || 'microphone') as AudioInputType;
        }
        if (!type) type = getAudioInputType();

        setAudioInputType(type);
        this.ui.setAudioInputPresentation?.(type, this.audioSwitchInProgress);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.activeOpId += 1;
        await this.stopActiveOperation().catch(() => false);
        await this.syncGoogleRealtime().catch(() => undefined);
        this.googleStreamingActive = false;
        this.removeStreamHandlers();
    }
}
