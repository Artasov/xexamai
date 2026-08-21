import {listen} from '@tauri-apps/api/event';
import {invokeNative} from './bridge/nativeInvoke';
import {settingsStore} from './state/settingsStore';
import {setDuration, setProcessing, setRecording, state} from './state/appState';
import {setStatus} from './ui/status';
import {hideStopButton} from './ui/stopButton';
import {CHAT_RETRY_EVENT_NAME} from './ui/outputs';
import {awaitPreloadBridge} from './app/preloadBridge';
import {AudioInputType, StreamController} from './app/streamController';
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
import {beginNativeRendererActivity} from './state/rendererActivity';

export type RendererSettingsSnapshot = {
    durations: number[];
    durationHotkeys: Record<number, string>;
    realtimeTranscription: boolean;
};

export type RendererSessionUi = {
    updateRealtimeTranscript: (previous: string, next: string) => void;
    restoreQuestionIfEmpty: (text: string) => void;
    getQuestion: () => string;
    getPromptImages: () => PromptImageAttachment[];
    addPromptImages: (images: PromptImageAttachment[]) => void;
    clearSubmittedPrompt: (text: string, imageIds: string[]) => void;
    setAudioInputPresentation: (type: AudioInputType, switching: boolean) => void;
    setSettingsSnapshot: (snapshot: RendererSettingsSnapshot) => void;
    setReady: (ready: boolean) => void;
};

const DEFAULT_DURATIONS = [5, 10, 15, 20, 30, 60];

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
    private started = false;
    private streamSendHotkey = '~';

    constructor(private readonly ui: RendererSessionUi) {
        this.streamController = new StreamController({
            updateRealtimeTranscript: ui.updateRealtimeTranscript,
            restoreQuestionIfEmpty: ui.restoreQuestionIfEmpty,
            setAudioInputPresentation: ui.setAudioInputPresentation,
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

    async toggleRecording(): Promise<void> {
        if (state.isProcessing || this.scope.isClosed) return;
        const shouldStart = !state.isRecording;
        if (shouldStart && !(await ensureTranscriptionReady())) return;

        logger.info('ui', 'Record button clicked', {shouldStart});
        setRecording(shouldStart);
        try {
            await this.streamController.handleRecordToggle(shouldStart);
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
        }
    }

    async askWindow(seconds: number): Promise<void> {
        if (this.scope.isClosed) return;
        const text = this.ui.getQuestion();
        const images = this.ui.getPromptImages();
        const settings = settingsStore.get();
        if (isRealtimeTranscription(settings.transcriptionMode, settings.transcriptionModel)) {
            if (!text.trim() && !images.length) {
                setStatus('Waiting for realtime transcription...', 'recording');
                return;
            }
            const started = await this.streamController.handleTextSend(text, images);
            if (started) {
                this.streamController.acknowledgeRealtimeSubmission();
                this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
            }
            return;
        }
        setStatus(`Sending last ${seconds}s...`, 'sending');
        const started = await this.streamController.handleAskWindow(seconds, text, images);
        if (started) this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
    }

    async sendQuestion(): Promise<boolean> {
        if (this.scope.isClosed || state.isProcessing) return false;
        const text = this.ui.getQuestion();
        const images = this.ui.getPromptImages();
        const started = await this.streamController.handleTextSend(text, images);
        if (started) {
            this.streamController.acknowledgeRealtimeSubmission();
            this.ui.clearSubmittedPrompt(text, images.map((image) => image.id));
        }
        return started;
    }

    async toggleAudioInput(): Promise<void> {
        if (this.scope.isClosed) return;
        await this.streamController.handleAudioInputToggleRequest();
    }

    async captureScreenshot(): Promise<void> {
        if (this.scope.isClosed || state.isProcessing) return;
        if (!checkFeatureAccess('screen_processing')) {
            showFeatureAccessModal('screen_processing');
            return;
        }
        setProcessing(true);
        setStatus('Capturing screen...', 'processing');
        let releaseActivity: (() => Promise<void>) | null = null;
        try {
            releaseActivity = await beginNativeRendererActivity('Capturing screenshot attachment');
            const capture = await window.api.screen.capture();
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
        } catch (error) {
            logger.error('screenshot', 'Screenshot capture failed', {error});
            setStatus(error instanceof Error ? error.message : 'Screenshot capture failed', 'error');
        } finally {
            if (releaseActivity) await releaseActivity().catch(() => undefined);
            setProcessing(false);
        }
    }

    async stopActiveOperation(): Promise<void> {
        if (await this.streamController.stopActiveOperation()) return;
        hideStopButton();
    }

    async dispose(): Promise<void> {
        this.ui.setReady(false);
        await this.shutdownActiveWork().catch(() => undefined);
        await this.scope.dispose();
        setRecording(false);
        setProcessing(false);
        hideStopButton();
    }

    private async shutdownActiveWork(requireIdle = false): Promise<void> {
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
        if (requireIdle && (state.isRecording || state.isProcessing)) {
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
        if (durations.length) setDuration(Math.max(...durations));
        this.ui.setSettingsSnapshot({
            durations,
            durationHotkeys,
            realtimeTranscription: isRealtimeTranscription(
                typeof transcriptionMode === 'string' ? transcriptionMode : undefined,
                typeof transcriptionModel === 'string' ? transcriptionModel : undefined,
            ),
        });
    }

    private async handleSettingsEvent(detail: SettingsChangeDetail): Promise<SettingsChangeResult> {
        try {
            const {key, value} = detail;
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
                if (key === 'transcriptionMode' || key === 'transcriptionModel') {
                    const settings = settingsStore.get();
                    this.publishSettings(
                        settings.durations,
                        settings.durationHotkeys,
                        settings.transcriptionMode,
                        settings.transcriptionModel,
                    );
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
}
