import {listen} from '@tauri-apps/api/event';
import {invokeNative} from './bridge/nativeInvoke';
import {settingsStore} from './state/settingsStore';
import {setDuration, setProcessing, setRecording, state} from './state/appState';
import {getStatusSnapshot, setStatus} from './ui/status';
import {hideStopButton} from './ui/stopButton';
import {CHAT_RETRY_EVENT_NAME, removeChatMessages, updateChatMessage} from './ui/outputs';
import {awaitPreloadBridge} from './app/preloadBridge';
import {
    AudioInputType,
    StreamController,
    type RealtimeAcknowledgementUpdate,
    type StreamOperationSettlement,
} from './app/streamController';
import {
    AutoAnswerEngine,
    AutoAnswerTimeline,
    type AutoAnswerEndpointEvent,
    type AutoAnswerEvent,
    type AutoAnswerSpeechStartEvent,
    type AutoAnswerToken,
} from './app/autoAnswerEngine';
import {checkFeatureAccess, showFeatureAccessModal} from './ui/featureAccessModal';
import {checkOllamaModelDownloaded} from './services/ollama';
import {normalizeLocalWhisperModel} from './services/localSpeechModels';
import {registerRendererShutdownHandler, shutdownRendererSession} from './app/sessionShutdown';
import {DisposableScope} from './app/disposableScope';
import {ensureTranscriptionReady} from './utils/transcriptionGuards';
import {logger} from './utils/logger';
import type {SettingsChangeDetail, SettingsChangeResult} from './utils/settingsEvents';
import type {PromptImageAttachment} from '@shared/ipc';
import {isRealtimeTranscription} from './services/realtimeTranscription';
import {isOpenAiRealtimeTranslation} from './services/openAiLiveContract';
import {beginNativeRendererActivity} from './state/rendererActivity';
import {onAudioChunk} from './services/nativeAudio';
import {composeRealtimeTranslationPrompt} from './utils/realtimeTranscript';

export type RendererSettingsSnapshot = {
    durations: number[];
    durationHotkeys: Record<number, string>;
    realtimeTranscription: boolean;
    realtimeTranslation: boolean;
};

export type RendererAutoPromptSnapshot = {
    text: string;
    visibleText: string;
    images: PromptImageAttachment[];
    realtimeTranslation: boolean;
    translationView?: 'translated' | 'source';
    sourceText?: string;
    translatedText?: string;
    sourceEdit?: string;
    providerSourceText?: string;
    translatedEdit?: string;
    providerTranslatedText?: string;
};

export type RendererSessionUi = {
    updateRealtimeTranscript: (previous: string, next: string) => void;
    updateRealtimeTranslation: (update: {
        sourcePrevious: string;
        sourceNext: string;
        translatedPrevious: string;
        translatedNext: string;
    }) => void;
    applyRealtimeAcknowledgement: (update: RealtimeAcknowledgementUpdate) => void;
    restoreQuestionIfEmpty: (text: string) => void;
    getQuestion: () => string;
    getPromptImages: () => PromptImageAttachment[];
    getAutoPromptSnapshot: () => RendererAutoPromptSnapshot;
    restoreAutoPrompt: (snapshot: RendererAutoPromptSnapshot) => void;
    restoreAutoPromptImages: (images: PromptImageAttachment[]) => void;
    clearAutoSubmittedPrompt: (snapshot: RendererAutoPromptSnapshot) => void;
    addPromptImages: (images: PromptImageAttachment[]) => void;
    clearSubmittedPrompt: (text: string, imageIds: string[]) => void;
    setAudioInputPresentation: (type: AudioInputType, switching: boolean) => void;
    setSettingsSnapshot: (snapshot: RendererSettingsSnapshot) => void;
    setAutoModeEnabled: (enabled: boolean) => void;
    setReady: (ready: boolean) => void;
};

const DEFAULT_DURATIONS = [5, 10, 15, 20, 30, 60];
const AUTO_CAPTURE_BUFFER_SECONDS = 60;
const AUTO_CONTINUATION_GRACE_MS = 3_000;

type AutoSubmission = {
    token: AutoAnswerToken;
    prompt: RendererAutoPromptSnapshot;
    requestId: string | null;
    promptCleared: boolean;
    imagesRestored: boolean;
    cancelled: boolean;
    submittedAt: number;
};

async function preloadLocalModelsIfNeeded(): Promise<void> {
    try {
        const settings = await settingsStore.load();
        if ((settings.transcriptionMode || 'api') !== 'local') return;

        if (window.api?.localSpeech) {
            try {
                const status = await window.api.localSpeech.checkHealth();
                if (status?.installed && status?.running) {
                    const model = normalizeLocalWhisperModel(settings.localWhisperModel || 'base') || 'base';
                    await window.api.localSpeech.checkModelDownloaded(model);
                }
            } catch (error) {
                logger.warn('renderer', 'Failed to preload local speech model', {error});
            }
        }

        if (settings.llmHost === 'local') {
            try {
                const model = settings.localLlmModel || settings.llmModel || 'gpt-oss:20b';
                await checkOllamaModelDownloaded(model, {force: true});
            } catch (error) {
                logger.warn('renderer', 'Failed to preload local LLM', {error});
            }
        }
    } catch (error) {
        logger.warn('renderer', 'Failed to read settings for model preload', {error});
    }
}

export class RendererSession {
    private readonly scope = new DisposableScope();
    private readonly streamController: StreamController;
    private readonly autoAnswerEngine = new AutoAnswerEngine({mode: 'buffered'});
    private started = false;
    private streamSendHotkey = '~';
    private autoModeEnabled = false;
    private realtimeTranscription = false;
    private autoSubmission: AutoSubmission | null = null;
    private pendingAutoEndpoint: AutoAnswerEndpointEvent | null = null;
    private pendingAutoEndpointRetryAt = 0;
    private autoRecordingStartInProgress = false;
    private autoStartedRecording = false;
    private autoStopRecordingWhenIdle = false;
    private readonly autoTimeline = new AutoAnswerTimeline();
    private autoEndpointInFlight: AutoAnswerToken | null = null;
    private screenshotCaptureTask: Promise<void> | null = null;
    private screenshotGeneration = 0;
    private shutdownTask: Promise<void> | null = null;

    constructor(private readonly ui: RendererSessionUi) {
        this.autoTimeline.reset(this.monotonicNow());
        this.streamController = new StreamController({
            updateRealtimeTranscript: (previous, next) => {
                ui.updateRealtimeTranscript(previous, next);
                this.handleAutoTranscript(next);
            },
            updateRealtimeTranslation: (update) => {
                ui.updateRealtimeTranslation(update);
                this.handleAutoTranscript(update.translatedNext);
            },
            applyRealtimeAcknowledgement: ui.applyRealtimeAcknowledgement,
            restoreQuestionIfEmpty: ui.restoreQuestionIfEmpty,
            onOperationSettled: (settlement) => this.handleOperationSettled(settlement),
            setAudioInputPresentation: ui.setAudioInputPresentation,
            onAudioInputChanged: () => {
                if (!this.autoModeEnabled) return;
                this.resetAutoTurn(true);
                window.setTimeout(() => {
                    if (this.autoModeEnabled && state.isRecording && !state.isProcessing) {
                        setStatus('Auto · Listening', 'recording');
                    }
                }, 0);
            },
        });
    }

    async start(): Promise<void> {
        if (this.started || this.scope.isClosed) return;
        this.started = true;
        setStatus('Ready', 'ready');
        void listen('transcription:debug:saved', (event: any) => {
            const payload = event.payload || {};
            logger.info('transcription', 'Debug audio saved', {
                path: payload.path,
                size: payload.size,
                mode: payload.mode,
                filename: payload.filename,
            });
        }).then((unlisten) => this.scope.add(unlisten)).catch(() => undefined);

        const bridge = await awaitPreloadBridge();
        if (this.scope.isClosed) return;
        if (!bridge) {
            setStatus('Application bridge unavailable', 'error');
            throw new Error('Application bridge unavailable');
        }

        this.streamController.initialize();
        this.scope.add(() => this.streamController.dispose());
        this.scope.add(onAudioChunk((chunk) => {
            if (!this.autoModeEnabled || !state.isRecording) return;
            const frames = chunk.samples[0]?.length || 0;
            if (!frames || !chunk.sampleRate) return;
            const durationMs = frames / chunk.sampleRate * 1_000;
            this.handleAutoEvents(this.autoAnswerEngine.ingestAudio({
                rms: chunk.rms,
                durationMs,
                // Native audio callbacks can arrive in a burst. Advancing by
                // the represented PCM duration keeps buffered capture anchors
                // correct even when several packets share one wall-clock tick.
                now: this.advanceAutoTimeline(durationMs),
            }));
        }));
        const autoTick = window.setInterval(() => {
            if (!this.autoModeEnabled) {
                if (this.autoStopRecordingWhenIdle && state.isRecording && !state.isProcessing) {
                    void this.stopAutoOwnedRecording();
                }
                return;
            }
            if (!state.isRecording) {
                if (!state.isProcessing) void this.ensureAutoRecording();
                return;
            }
            this.handleAutoEvents(this.autoAnswerEngine.tick(this.advanceAutoTimeline()));
            this.flushPendingAutoEndpoint();
        }, 100);
        this.scope.add(() => window.clearInterval(autoTick));
        await this.streamController.syncInitialSettings();
        if (this.scope.isClosed) return;

        this.scope.add(registerRendererShutdownHandler((reason) => this.shutdownActiveWork(reason === 'update-install')));
        const shutdownUnlisten = await listen('app:shutdown-requested', () => {
            void shutdownRendererSession('app-exit')
                .finally(() => invokeNative('app_shutdown_complete'));
        });
        this.scope.add(shutdownUnlisten);
        if (this.scope.isClosed) return;

        const retryListener = (event: Event) => {
            const detail = (event as CustomEvent<{chatId?: string; messageId?: string; text?: string}>).detail;
            if (!detail?.text?.trim() || !detail.chatId || !detail.messageId) return;
            void this.streamController.retryFailedMessage(detail);
        };
        window.addEventListener(CHAT_RETRY_EVENT_NAME, retryListener);
        this.scope.add(() => window.removeEventListener(CHAT_RETRY_EVENT_NAME, retryListener));

        const settings = await settingsStore.load();
        if (this.scope.isClosed) return;
        this.streamSendHotkey = settings.streamSendHotkey || '~';
        this.publishSettings(
            settings.durations,
            settings.durationHotkeys,
            settings.transcriptionMode,
            settings.transcriptionModel,
        );

        const keydownListener = (event: KeyboardEvent) => {
            if (!event.ctrlKey || this.eventKey(event) !== this.normalizedHotkey(this.streamSendHotkey)) return;
            const question = this.ui.getQuestion().trim();
            const images = this.ui.getPromptImages();
            if ((!question && !images.length) || state.isProcessing) return;
            event.preventDefault();
            void this.sendQuestion();
        };
        document.addEventListener('keydown', keydownListener);
        this.scope.add(() => document.removeEventListener('keydown', keydownListener));

        window.api.hotkeys.onDuration((_event: unknown, payload: {sec: number}) => {
            void this.askWindow(payload.sec);
        });
        this.scope.add(() => window.api.hotkeys.offDuration());
        window.api.hotkeys.onToggleInput(() => {
            void this.streamController.handleHotkeyToggleRequest();
        });
        this.scope.add(() => window.api.hotkeys.offToggleInput());

        const settingsListener = (event: Event) => {
            const detail = (event as CustomEvent<SettingsChangeDetail>).detail;
            if (!detail?.key) return;
            detail.handled = true;
            void this.handleSettingsEvent(detail)
                .then((result) => detail.complete?.(result))
                .catch((error) => detail.complete?.({
                    success: false,
                    appliedValue: detail.value,
                    error: error instanceof Error ? error.message : String(error),
                }));
        };
        window.addEventListener('xexamai:settings-changed', settingsListener);
        this.scope.add(() => window.removeEventListener('xexamai:settings-changed', settingsListener));

        void preloadLocalModelsIfNeeded();
        this.ui.setReady(true);
    }

    async toggleRecording(autoInitiated = false): Promise<void> {
        if (this.scope.isClosed) return;
        const shouldStart = !state.isRecording;
        if (state.isProcessing && shouldStart) return;
        if (shouldStart && !(await ensureTranscriptionReady())) return;

        if (!shouldStart && this.autoModeEnabled && !autoInitiated) {
            this.autoModeEnabled = false;
            this.ui.setAutoModeEnabled(false);
        }
        if (state.isProcessing && !shouldStart) {
            if (this.autoSubmission) {
                await this.cancelAutoSubmission('manual', false);
            } else {
                await this.streamController.stopActiveOperation({disposition: 'manual'}).catch(() => false);
            }
        }

        if (shouldStart) {
            if (!autoInitiated) this.autoStartedRecording = false;
            // Calibrate before capture starts. Resetting after the awaited
            // provider/WebSocket setup used to erase the first spoken words.
            this.resetAutoTurn(true);
        }

        logger.info('ui', 'Record button clicked', {shouldStart});
        setRecording(shouldStart);
        try {
            await this.streamController.handleRecordToggle(shouldStart);
            if (!shouldStart) {
                this.autoStartedRecording = false;
                this.resetAutoTurn();
            }
            // Realtime startup reports its own active/error status. Do not
            // overwrite a useful Google error with a generic "Recording...".
            const settings = settingsStore.get();
            if (!shouldStart) {
                setStatus('Ready', 'ready');
            } else if (!isRealtimeTranscription(
                settings.transcriptionMode,
                settings.transcriptionModel,
            )) {
                setStatus('Recording...', 'recording');
            }
        } catch {
            setRecording(false);
            if (autoInitiated) this.autoStartedRecording = false;
        }
    }

    async askWindow(seconds: number): Promise<void> {
        if (this.scope.isClosed || state.isProcessing) return;
        this.prepareManualSubmission();
        const text = this.ui.getQuestion();
        const images = this.ui.getPromptImages();
        const promptSnapshot = this.ui.getAutoPromptSnapshot();
        const settings = settingsStore.get();
        if (isRealtimeTranscription(settings.transcriptionMode, settings.transcriptionModel)) {
            if (!text.trim() && !images.length) {
                setStatus('Waiting for realtime transcription...', 'recording');
                return;
            }
            const started = await this.streamController.handleTextSend(
                text,
                images,
                'text',
                {
                    submittedTranslationView: promptSnapshot.realtimeTranslation
                        ? promptSnapshot.translationView
                        : undefined,
                },
            );
            if (started) {
                this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
                this.streamController.acknowledgeRealtimeSubmission();
            }
            return;
        }
        setStatus(`Sending last ${seconds}s...`, 'sending');
        const started = await this.streamController.handleAskWindow(seconds, text, images);
        if (started) this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
    }

    async sendQuestion(): Promise<boolean> {
        if (this.scope.isClosed || state.isProcessing) return false;
        this.prepareManualSubmission();
        const text = this.ui.getQuestion();
        const images = this.ui.getPromptImages();
        const promptSnapshot = this.ui.getAutoPromptSnapshot();
        const started = await this.streamController.handleTextSend(
            text,
            images,
            'text',
            {
                submittedTranslationView: promptSnapshot.realtimeTranslation
                    ? promptSnapshot.translationView
                    : undefined,
            },
        );
        if (started) {
            this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
            this.streamController.acknowledgeRealtimeSubmission();
        }
        return started;
    }

    async toggleAutoMode(): Promise<void> {
        if (this.scope.isClosed) return;
        const next = !this.autoModeEnabled;
        this.autoModeEnabled = next;
        this.ui.setAutoModeEnabled(next);

        if (!next) {
            const ownedRecording = this.autoStartedRecording || this.autoRecordingStartInProgress;
            this.resetAutoTurn();
            if (this.autoSubmission) {
                // The prompt belongs to the user. Restore it and exclude the
                // superseded auto turn so switching Auto off never loses input
                // or pollutes the next request's history.
                await this.cancelAutoSubmission('auto-continuation', true);
            }
            if (ownedRecording) {
                this.autoStopRecordingWhenIdle = true;
                await this.stopAutoOwnedRecording();
            } else if (state.isRecording && !state.isProcessing) {
                this.restoreRecordingStatus();
            }
            return;
        }

        this.autoStopRecordingWhenIdle = false;
        this.resetAutoTurn(true);

        if (!state.isRecording && !state.isProcessing) {
            await this.ensureAutoRecording();
            if (!this.autoModeEnabled) {
                if (state.isRecording && !state.isProcessing) this.restoreRecordingStatus();
                return;
            }
            if (!state.isRecording) {
                this.autoModeEnabled = false;
                this.ui.setAutoModeEnabled(false);
                return;
            }
        }
        const canonicalTranscript = this.streamController.getRealtimeCanonicalSnapshot().text.trim();
        if (this.realtimeTranscription && canonicalTranscript) {
            this.handleAutoEvents(this.autoAnswerEngine.updateTranscript({
                text: canonicalTranscript,
                now: this.advanceAutoTimeline(),
            }));
        }
        if (state.isRecording && !state.isProcessing) {
            setStatus('Auto · Listening', 'recording');
        }
    }

    async toggleAudioInput(): Promise<void> {
        if (this.scope.isClosed) return;
        await this.streamController.handleAudioInputToggleRequest();
    }

    async captureScreenshot(): Promise<void> {
        if (this.screenshotCaptureTask) return this.screenshotCaptureTask;
        if (this.scope.isClosed || this.shutdownTask) return;
        const generation = this.screenshotGeneration;
        const task = this.captureScreenshotGeneration(generation);
        this.screenshotCaptureTask = task;
        try {
            await task;
        } finally {
            if (this.screenshotCaptureTask === task) this.screenshotCaptureTask = null;
        }
    }

    private async captureScreenshotGeneration(generation: number): Promise<void> {
        if (this.scope.isClosed || generation !== this.screenshotGeneration || state.isProcessing) return;
        if (!checkFeatureAccess('screen_processing')) {
            showFeatureAccessModal('screen_processing');
            return;
        }
        setProcessing(true);
        setStatus('Capturing screen...', 'processing');
        let releaseActivity: (() => Promise<void>) | null = null;
        let resumeStatusDelay: number | null = null;
        try {
            releaseActivity = await beginNativeRendererActivity('Capturing screenshot attachment');
            if (this.scope.isClosed || generation !== this.screenshotGeneration) return;
            const capture = await window.api.screen.capture();
            if (this.scope.isClosed || generation !== this.screenshotGeneration) return;
            if (capture === null) {
                setStatus('Ready', 'ready');
                resumeStatusDelay = 0;
                return;
            }
            if (!capture?.base64) throw new Error('Failed to capture screen');
            this.ui.addPromptImages([{
                id: crypto.randomUUID(),
                mime: capture.mime || 'image/jpeg',
                base64: capture.base64,
                name: 'Screenshot',
                width: capture.width,
                height: capture.height,
            }]);
            setStatus('Screenshot attached', 'ready');
            resumeStatusDelay = 900;
        } catch (error) {
            if (this.scope.isClosed || generation !== this.screenshotGeneration) return;
            logger.error('screenshot', 'Screenshot capture failed', {error});
            setStatus(error instanceof Error ? error.message : 'Screenshot capture failed', 'error');
        } finally {
            if (releaseActivity) await releaseActivity().catch(() => undefined);
            setProcessing(false);
            this.flushPendingAutoEndpoint();
            if (resumeStatusDelay !== null) {
                window.setTimeout(() => {
                    const status = getStatusSnapshot();
                    if (
                        !state.isProcessing
                        && (status.text === 'Screenshot attached' || status.text === 'Ready')
                    ) {
                        if (!state.isRecording) setStatus('Ready', 'ready');
                        else if (this.autoModeEnabled) setStatus('Auto · Listening', 'recording');
                        else this.restoreRecordingStatus();
                    }
                }, resumeStatusDelay);
            }
        }
    }

    async stopActiveOperation(): Promise<void> {
        if (this.autoSubmission) {
            this.autoAnswerEngine.finalize(this.autoSubmission.token);
            this.pendingAutoEndpoint = null;
            await this.cancelAutoSubmission('manual', false);
            return;
        }
        if (await this.streamController.stopActiveOperation()) return;
        hideStopButton();
    }

    async dispose(): Promise<void> {
        this.autoModeEnabled = false;
        this.ui.setAutoModeEnabled(false);
        this.resetAutoTurn();
        this.ui.setReady(false);
        await this.shutdownActiveWork().catch(() => undefined);
        await this.scope.dispose();
        setRecording(false);
        setProcessing(false);
        hideStopButton();
    }

    private shutdownActiveWork(requireIdle = false): Promise<void> {
        if (this.shutdownTask) {
            return requireIdle
                ? this.shutdownTask.then(() => this.assertRendererIdle())
                : this.shutdownTask;
        }
        const task = this.performShutdownActiveWork(requireIdle);
        this.shutdownTask = task;
        return task.finally(() => {
            if (this.shutdownTask === task) this.shutdownTask = null;
        });
    }

    private async performShutdownActiveWork(requireIdle: boolean): Promise<void> {
        this.screenshotGeneration += 1;
        const screenshotCaptureTask = this.screenshotCaptureTask;
        await window.api.screen.cancel().catch(() => undefined);
        if (screenshotCaptureTask) await screenshotCaptureTask.catch(() => undefined);
        await this.streamController.stopActiveOperation().catch(() => false);
        if (state.isRecording) {
            await this.streamController.handleRecordToggle(false).catch(() => undefined);
            setRecording(false);
        }
        try {
            await Promise.resolve(window.api.google.stopLive());
        } catch {
        }
        try {
            await Promise.resolve(window.api.openai.stopLive());
        } catch {
        }
        if (requireIdle) this.assertRendererIdle();
    }

    private assertRendererIdle(): void {
        if (state.isRecording || state.isProcessing) {
            throw new Error('Active renderer work could not be stopped safely');
        }
    }

    private publishSettings(
        durationsValue: unknown,
        hotkeysValue: unknown,
        transcriptionMode?: unknown,
        transcriptionModel?: unknown,
    ): void {
        const durations = Array.isArray(durationsValue) && durationsValue.length
            ? durationsValue.filter((value): value is number => Number.isFinite(value) && value > 0)
            : DEFAULT_DURATIONS;
        const durationHotkeys = hotkeysValue && typeof hotkeysValue === 'object'
            ? hotkeysValue as Record<number, string>
            : {};
        if (durations.length) setDuration(Math.max(AUTO_CAPTURE_BUFFER_SECONDS, ...durations));
        this.realtimeTranscription = isRealtimeTranscription(
            typeof transcriptionMode === 'string' ? transcriptionMode : undefined,
            typeof transcriptionModel === 'string' ? transcriptionModel : undefined,
        );
        this.autoAnswerEngine.setMode(
            this.realtimeTranscription ? 'realtime' : 'buffered',
            this.advanceAutoTimeline(),
        );
        this.ui.setSettingsSnapshot({
            durations,
            durationHotkeys,
            realtimeTranscription: this.realtimeTranscription,
            realtimeTranslation: isOpenAiRealtimeTranslation(
                typeof transcriptionMode === 'string' ? transcriptionMode : undefined,
                typeof transcriptionModel === 'string' ? transcriptionModel : undefined,
            ),
        });
    }

    private async handleSettingsEvent(detail: SettingsChangeDetail): Promise<SettingsChangeResult> {
        try {
            const {key, value} = detail;
            const changesRealtimePipeline = key === 'transcriptionMode'
                || key === 'transcriptionModel'
                || key === 'realtimeTranslationLanguage';
            if (changesRealtimePipeline && this.autoSubmission) {
                await this.cancelAutoSubmission('auto-continuation', true);
            }
            const handled = this.streamController.handleSettingsChange(key, value);
            const applied = handled instanceof Promise ? await handled : handled;
            if (key === 'audioInputType' || key === 'audioInputDeviceId') {
                const appliedValue = key === 'audioInputType'
                    ? settingsStore.get().audioInputType || 'microphone'
                    : settingsStore.get().audioInputDeviceId || '';
                return {
                    success: applied,
                    appliedValue,
                    error: applied ? undefined : 'Audio input could not be switched safely',
                };
            }
            if (applied) {
                if (
                    changesRealtimePipeline
                ) {
                    const settings = settingsStore.get();
                    this.publishSettings(
                        settings.durations,
                        settings.durationHotkeys,
                        settings.transcriptionMode,
                        settings.transcriptionModel,
                    );
                    if (this.autoModeEnabled) {
                        this.resetAutoTurn(true);
                    }
                }
                return {success: true, appliedValue: value};
            }

            if (key === 'durations') {
                settingsStore.patch({durations: Array.isArray(value) ? value as number[] : []});
            } else if (key === 'durationHotkeys') {
                settingsStore.patch({durationHotkeys: (value || {}) as Record<number, string>});
            } else if (key === 'streamSendHotkey') {
                this.streamSendHotkey = typeof value === 'string' && value ? value : '~';
                settingsStore.patch({streamSendHotkey: this.streamSendHotkey});
                return {success: true, appliedValue: this.streamSendHotkey};
            } else {
                return {success: false, appliedValue: value, error: 'Unsupported setting'};
            }
            const settings = settingsStore.get();
            this.publishSettings(
                settings.durations,
                settings.durationHotkeys,
                settings.transcriptionMode,
                settings.transcriptionModel,
            );
            return {success: true, appliedValue: value};
        } catch (error) {
            logger.error('settings', 'Settings change handler failed', {error});
            return {
                success: false,
                appliedValue: detail.value,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private normalizedHotkey(value: string): string {
        const key = value.toLowerCase();
        return key === '~' || key === '`' ? 'backquote' : key;
    }

    private eventKey(event: KeyboardEvent): string {
        if (event.code === 'Backquote') return 'backquote';
        return event.key.toLowerCase();
    }

    private monotonicNow(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    private advanceAutoTimeline(audioDurationMs = 0): number {
        return audioDurationMs > 0
            ? this.autoTimeline.advanceAudio(audioDurationMs)
            : this.autoTimeline.current();
    }

    private resetAutoTimeline(): number {
        return this.autoTimeline.reset(this.monotonicNow());
    }

    private restoreRecordingStatus(): void {
        const target = this.streamController.getRealtimeCanonicalSnapshot().target;
        setStatus(
            target === 'openai-translate'
                ? 'Recording · OpenAI Translate'
                : target === 'openai-transcribe'
                    ? 'Recording · OpenAI Live'
                    : target === 'google'
                        ? 'Recording · Google Live'
                        : 'Recording...',
            'recording',
        );
    }

    private async ensureAutoRecording(): Promise<void> {
        if (
            this.autoRecordingStartInProgress
            || !this.autoModeEnabled
            || state.isRecording
            || state.isProcessing
            || this.scope.isClosed
        ) return;
        this.autoRecordingStartInProgress = true;
        const startedFromIdle = !state.isRecording;
        try {
            await this.toggleRecording(true);
            if (startedFromIdle && state.isRecording) this.autoStartedRecording = true;
            if (this.autoModeEnabled && !state.isRecording) {
                this.autoModeEnabled = false;
                this.ui.setAutoModeEnabled(false);
                this.resetAutoTurn();
            }
            if (!this.autoModeEnabled && this.autoStartedRecording) {
                this.autoStopRecordingWhenIdle = true;
                await this.stopAutoOwnedRecording();
            }
        } finally {
            this.autoRecordingStartInProgress = false;
        }
    }

    private async stopAutoOwnedRecording(): Promise<void> {
        if (!this.autoStartedRecording || !state.isRecording || state.isProcessing) return;
        this.autoStopRecordingWhenIdle = false;
        await this.toggleRecording(true);
        this.autoStartedRecording = false;
    }

    private resetAutoTurn(recalibrate = false): void {
        this.pendingAutoEndpoint = null;
        this.pendingAutoEndpointRetryAt = 0;
        const now = this.resetAutoTimeline();
        if (recalibrate) this.autoAnswerEngine.recalibrate(now);
        else this.autoAnswerEngine.invalidate(now);
    }

    private prepareManualSubmission(): void {
        if (!this.autoModeEnabled) return;
        this.resetAutoTurn();
    }

    private handleAutoTranscript(text: string): void {
        if (!this.autoModeEnabled || !state.isRecording || !this.realtimeTranscription) return;
        this.handleAutoEvents(this.autoAnswerEngine.updateTranscript({
            text,
            now: this.advanceAutoTimeline(),
        }));
    }

    private handleAutoEvents(events: AutoAnswerEvent[]): void {
        for (const event of events) {
            if (event.type === 'speech-start') {
                void this.handleAutoSpeechStart(event);
            } else {
                void this.handleAutoEndpoint(event);
            }
        }
    }

    private async handleAutoSpeechStart(event: AutoAnswerSpeechStartEvent): Promise<void> {
        this.pendingAutoEndpoint = null;
        const submission = this.autoSubmission;
        if (!submission || submission.cancelled) return;
        if (
            event.continuation
            && event.resumedFromCycle !== undefined
            && event.resumedFromCycle !== submission.token.cycle
        ) return;

        const partial = this.streamController.getOperationSnapshot().partialText.replace(/\s+/g, ' ').trim();
        const hasMeaningfulPartial = partial.length >= 24 || partial.split(' ').filter(Boolean).length >= 5;
        // A slow provider may still be on "Syncing" after the ordinary
        // continuation window. With no useful answer to preserve, resumed
        // speech is much more likely to be the rest of the same question.
        const continuation = event.continuation || (
            this.realtimeTranscription
            && submission.promptCleared
            && !hasMeaningfulPartial
            && event.at - submission.submittedAt <= AUTO_CONTINUATION_GRACE_MS
        );
        await this.cancelAutoSubmission(
            continuation ? 'auto-continuation' : 'auto-new-turn',
            continuation,
        );
        if (this.autoModeEnabled && state.isRecording && !state.isProcessing) {
            setStatus('Auto · Listening', 'recording');
        }
    }

    private async cancelAutoSubmission(
        disposition: 'manual' | 'auto-continuation' | 'auto-new-turn',
        restorePrompt: boolean,
    ): Promise<void> {
        const submission = this.autoSubmission;
        if (!submission || submission.cancelled) return;
        submission.cancelled = true;
        this.restoreAutoSubmission(submission, restorePrompt);
        await this.streamController.stopActiveOperation({
            disposition,
            // Image bytes intentionally are not persisted in conversation
            // history. A cancelled multimodal request therefore cannot become
            // valid future context merely because it produced a useful partial
            // answer: keep the draft visible, but let the next attempt own the
            // restored pixels and be the sole accepted history turn.
            excludeFromHistory: submission.prompt.images.length > 0,
        }).catch(() => false);
        if (this.autoSubmission === submission) this.autoSubmission = null;
    }

    private restoreAutoSubmission(submission: AutoSubmission, includeText: boolean): void {
        if (!submission.promptCleared) return;
        if (includeText) {
            this.ui.restoreAutoPrompt(submission.prompt);
            submission.promptCleared = false;
            submission.imagesRestored = true;
            return;
        }
        if (!submission.imagesRestored && submission.prompt.images.length) {
            this.ui.restoreAutoPromptImages(submission.prompt.images);
            submission.imagesRestored = true;
        }
    }

    private async handleAutoEndpoint(event: AutoAnswerEndpointEvent): Promise<void> {
        if (
            !this.autoModeEnabled
            || !state.isRecording
            || !this.autoAnswerEngine.isCurrent(event.token)
        ) return;

        if (state.isProcessing || this.autoSubmission || this.autoEndpointInFlight) {
            this.pendingAutoEndpoint = event;
            return;
        }

        this.pendingAutoEndpoint = null;
        this.pendingAutoEndpointRetryAt = 0;
        this.autoEndpointInFlight = event.token;
        let attemptedSubmission: AutoSubmission | null = null;
        try {
            if (this.realtimeTranscription) {
                // OpenAI transcription has manual turn detection. Committing
                // here yields the provider's final wording without closing the
                // long-lived realtime socket; Translate waits briefly for its
                // corresponding output-completed boundary.
                await this.streamController.finalizeRealtimeTurn();
            }
            if (
                !this.autoModeEnabled
                || !state.isRecording
                || !this.autoAnswerEngine.isCurrent(event.token)
            ) return;

            const uiPrompt = this.ui.getAutoPromptSnapshot();
            const canonical = this.streamController.getRealtimeCanonicalSnapshot();
            const canonicalText = canonical.text.trim();
            const resolvedSource = uiPrompt.sourceText?.trim() || canonical.source.trim();
            const resolvedTranslation = uiPrompt.translatedText?.trim() || canonical.translated.trim();
            const effectiveText = this.realtimeTranscription && uiPrompt.realtimeTranslation
                ? composeRealtimeTranslationPrompt(
                    resolvedTranslation || resolvedSource,
                    uiPrompt.sourceEdit || '',
                )
                : this.realtimeTranscription
                    ? uiPrompt.text.trim() || canonicalText
                    : uiPrompt.text;
            const usedCanonicalFallback = this.realtimeTranscription
                && !uiPrompt.realtimeTranslation
                && !uiPrompt.text.trim()
                && !!canonicalText;
            const prompt: RendererAutoPromptSnapshot = {
                ...uiPrompt,
                text: effectiveText,
                ...(this.realtimeTranscription
                && uiPrompt.realtimeTranslation
                && canonical.target === 'openai-translate'
                    ? {
                        sourceText: resolvedSource,
                        translatedText: resolvedTranslation,
                        providerSourceText: uiPrompt.providerSourceText?.trim() || canonical.source.trim(),
                        providerTranslatedText: uiPrompt.providerTranslatedText?.trim()
                            || canonical.translated.trim(),
                        visibleText: uiPrompt.translationView === 'source'
                            ? resolvedSource
                            : resolvedTranslation,
                    }
                    : usedCanonicalFallback
                        ? {visibleText: canonicalText}
                        : {}),
            };
            if (this.realtimeTranscription && !prompt.text.trim() && !prompt.images.length) {
                this.autoAnswerEngine.finalize(event.token);
                return;
            }

            const submission: AutoSubmission = {
                token: event.token,
                prompt,
                requestId: null,
                promptCleared: false,
                imagesRestored: false,
                cancelled: false,
                submittedAt: event.at,
            };
            this.autoSubmission = submission;
            attemptedSubmission = submission;

            this.ui.clearAutoSubmittedPrompt(prompt);
            submission.promptCleared = true;
            if (this.realtimeTranscription) {
                this.streamController.acknowledgeRealtimeSubmission();
                // The provider and textarea now start a fresh turn. Clearing the
                // engine copy prevents a late final revision from satisfying the
                // next utterance before that utterance has any transcript.
                this.autoAnswerEngine.updateTranscript({
                    text: '',
                    now: this.advanceAutoTimeline(),
                });
            }

            const started = this.realtimeTranscription
                ? await this.streamController.handleTextSend(prompt.text, prompt.images, 'audio')
                : await this.streamController.handleAskWindow(
                    Math.max(1, Math.min(AUTO_CAPTURE_BUFFER_SECONDS, event.captureDurationMs / 1_000)),
                    prompt.text,
                    prompt.images,
                    {automatic: true},
                );

            if (!started) {
                if (!submission.cancelled) this.restoreAutoSubmission(submission, true);
                if (this.autoSubmission === submission) this.autoSubmission = null;
                if (this.autoAnswerEngine.isCurrent(event.token)) this.autoAnswerEngine.finalize(event.token);
                return;
            }

            const operation = this.streamController.getOperationSnapshot();
            // A very fast provider can settle while askChat is still returning
            // through the bridge. The settlement is authoritative: never
            // resurrect an attachment that was already consumed successfully.
            if (this.autoSubmission !== submission) return;
            submission.requestId = operation.requestId;
            if (submission.cancelled || !this.autoAnswerEngine.isCurrent(event.token)) {
                if (!submission.cancelled) this.restoreAutoSubmission(submission, true);
                await this.streamController.stopActiveOperation({
                    disposition: event.continuation ? 'auto-continuation' : 'auto-new-turn',
                    excludeFromHistory: prompt.images.length > 0,
                });
                if (this.autoSubmission === submission) this.autoSubmission = null;
                return;
            }

            // Extremely fast local providers can finish before the awaited bridge
            // call returns. Treat that as a completed turn even though no active id
            // remains to match in onOperationSettled.
            if (!operation.inProgress || !operation.requestId) {
                this.autoAnswerEngine.finalize(event.token);
                if (this.autoSubmission === submission) this.autoSubmission = null;
            }
        } catch (error) {
            logger.warn('auto-mode', 'Could not finalize or submit automatic turn', {error});
            if (attemptedSubmission && this.autoSubmission === attemptedSubmission) {
                if (!attemptedSubmission.cancelled) {
                    this.restoreAutoSubmission(attemptedSubmission, true);
                }
                this.autoSubmission = null;
            }
            if (
                this.autoModeEnabled
                && state.isRecording
                && this.autoAnswerEngine.isCurrent(event.token)
            ) {
                this.pendingAutoEndpoint = event;
                this.pendingAutoEndpointRetryAt = this.monotonicNow() + 1_000;
                setStatus('Auto · Waiting for final transcript', 'recording');
            }
        } finally {
            if (this.autoEndpointInFlight === event.token) this.autoEndpointInFlight = null;
            this.flushPendingAutoEndpoint();
        }
    }

    private handleOperationSettled(settlement: StreamOperationSettlement): void {
        const submission = this.autoSubmission;
        const expectedUserText = submission
            ? submission.prompt.text.trim()
                || (submission.prompt.images.length ? 'Analyze the attached image(s).' : '')
            : '';
        const settledUserText = settlement.userText?.trim() || '';
        const pendingTextMatches = settledUserText === expectedUserText
            || (
                !this.realtimeTranscription
                && !!settledUserText
                && !!expectedUserText
                && settledUserText.includes(expectedUserText)
            );
        const matchesSubmission = !!submission && (
            submission.requestId === settlement.requestId
            || (
                submission.requestId === null
                && !submission.cancelled
                && !!expectedUserText
                && pendingTextMatches
            )
        );
        if (submission && matchesSubmission) {
            if (settlement.status === 'failed') {
                this.restoreAutoSubmission(submission, true);
                if (settlement.chatId && settlement.userMessageId && settlement.assistantMessageId) {
                    const partial = settlement.partialText.replace(/\s+/g, ' ').trim();
                    const meaningfulPartial = partial.length >= 24
                        || partial.split(' ').filter(Boolean).length >= 5;
                    if (meaningfulPartial) {
                        // Keep a useful draft visible, but never feed an
                        // unanswered/failed automatic turn back into the LLM.
                        updateChatMessage(
                            settlement.userMessageId,
                            {historyExcluded: true},
                            {chatId: settlement.chatId},
                        );
                        updateChatMessage(
                            settlement.assistantMessageId,
                            {
                                role: 'assistant',
                                text: settlement.partialText.trim(),
                                pending: false,
                                interrupted: false,
                                retryText: undefined,
                                historyExcluded: true,
                            },
                            {chatId: settlement.chatId},
                        );
                    } else {
                        removeChatMessages(
                            [settlement.userMessageId, settlement.assistantMessageId],
                            {chatId: settlement.chatId},
                        );
                    }
                }
                this.autoAnswerEngine.finalize(submission.token);
            } else if (settlement.status === 'completed') {
                this.autoAnswerEngine.finalize(submission.token);
            }
            this.autoSubmission = null;
        }
        window.setTimeout(() => {
            if (
                settlement.status !== 'failed'
                && this.autoModeEnabled
                && state.isRecording
                && !state.isProcessing
            ) {
                setStatus('Auto · Listening', 'recording');
            }
            this.flushPendingAutoEndpoint();
        }, 0);
    }

    private flushPendingAutoEndpoint(): void {
        const endpoint = this.pendingAutoEndpoint;
        if (!endpoint || state.isProcessing || this.autoSubmission || this.autoEndpointInFlight) return;
        if (this.pendingAutoEndpointRetryAt > this.monotonicNow()) return;
        if (!this.autoAnswerEngine.isCurrent(endpoint.token)) {
            this.pendingAutoEndpoint = null;
            return;
        }
        void this.handleAutoEndpoint(endpoint);
    }
}
