import {listen} from '@tauri-apps/api/event';
import {invokeNative} from './bridge/nativeInvoke';
import {settingsStore} from './state/settingsStore';
import {setDuration, setProcessing, setRecording, state} from './state/appState';
import {setStatus} from './ui/status';
import {hideStopButton} from './ui/stopButton';
import {CHAT_RETRY_EVENT_NAME} from './ui/outputs';
import {awaitPreloadBridge} from './app/preloadBridge';
import {AudioInputType, StreamController} from './app/streamController';
import {ScreenshotController} from './app/screenshotController';
import {checkFeatureAccess, showFeatureAccessModal} from './ui/featureAccessModal';
import {checkOllamaModelDownloaded} from './services/ollama';
import {normalizeLocalWhisperModel} from './services/localSpeechModels';
import {registerRendererShutdownHandler, shutdownRendererSession} from './app/sessionShutdown';
import {DisposableScope} from './app/disposableScope';
import {ensureTranscriptionReady} from './utils/transcriptionGuards';
import {logger} from './utils/logger';
import type {SettingsChangeDetail, SettingsChangeResult} from './utils/settingsEvents';

export type RendererSettingsSnapshot = {
    durations: number[];
    durationHotkeys: Record<number, string>;
};

export type RendererSessionUi = {
    updateRealtimeTranscript: (previous: string, next: string) => void;
    restoreQuestionIfEmpty: (text: string) => void;
    getQuestion: () => string;
    clearQuestionIfUnchanged: (text: string) => void;
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
    private readonly screenshotController: ScreenshotController;
    private started = false;
    private streamSendHotkey = '~';

    constructor(private readonly ui: RendererSessionUi) {
        this.streamController = new StreamController({
            updateRealtimeTranscript: ui.updateRealtimeTranscript,
            restoreQuestionIfEmpty: ui.restoreQuestionIfEmpty,
            setAudioInputPresentation: ui.setAudioInputPresentation,
        });
        this.screenshotController = new ScreenshotController({
            getQuestion: ui.getQuestion,
            clearQuestionIfUnchanged: ui.clearQuestionIfUnchanged,
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
        this.publishSettings(settings.durations, settings.durationHotkeys);

        const keydownListener = (event: KeyboardEvent) => {
            if (!event.ctrlKey || this.eventKey(event) !== this.normalizedHotkey(this.streamSendHotkey)) return;
            const question = this.ui.getQuestion().trim();
            if (!question || state.isProcessing) return;
            event.preventDefault();
            void this.sendQuestion(question).then((started) => {
                if (started) this.ui.clearQuestionIfUnchanged(question);
            });
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
            setStatus(shouldStart ? 'Recording...' : 'Ready', shouldStart ? 'recording' : 'ready');
        } catch {
            setRecording(false);
        }
    }

    async askWindow(seconds: number): Promise<void> {
        if (this.scope.isClosed) return;
        setStatus(`Sending last ${seconds}s...`, 'sending');
        await this.streamController.handleAskWindow(seconds);
    }

    async sendQuestion(text: string): Promise<boolean> {
        if (this.scope.isClosed || state.isProcessing) return false;
        return this.streamController.handleTextSend(text);
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
        await this.screenshotController.start();
    }

    async stopActiveOperation(): Promise<void> {
        if (await this.streamController.stopActiveOperation()) return;
        if (this.screenshotController.cancelActive()) return;
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
        this.screenshotController.cancelActive();
        await this.streamController.stopActiveOperation().catch(() => false);
        if (state.isRecording) {
            await this.streamController.handleRecordToggle(false).catch(() => undefined);
            setRecording(false);
        }
        try {
            await Promise.resolve(window.api.google.stopLive());
        } catch {
        }
        if (requireIdle && (state.isRecording || state.isProcessing)) {
            throw new Error('Active renderer work could not be stopped safely');
        }
    }

    private publishSettings(durationsValue: unknown, hotkeysValue: unknown): void {
        const durations = Array.isArray(durationsValue) && durationsValue.length
            ? durationsValue.filter((value): value is number => Number.isFinite(value) && value > 0)
            : DEFAULT_DURATIONS;
        const durationHotkeys = hotkeysValue && typeof hotkeysValue === 'object'
            ? hotkeysValue as Record<number, string>
            : {};
        if (durations.length) setDuration(Math.max(...durations));
        this.ui.setSettingsSnapshot({durations, durationHotkeys});
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
            if (applied) return {success: true, appliedValue: value};

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
            this.publishSettings(settings.durations, settings.durationHotkeys);
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
