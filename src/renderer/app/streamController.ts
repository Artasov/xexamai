import {showAnswer, showError, showText} from '../ui/outputs';
import {setStatus} from '../ui/status';
import {setProcessing, setRecording, state} from '../state/appState';
import {updateButtonsState} from '../ui/controls';
import {floatsToWav} from '../audio/encoder';
import {logger} from '../utils/logger';
import {settingsStore} from '../state/settingsStore';
import {GoogleStreamingService} from '../services/googleStreamingService';
import {
    checkOllamaInstalled,
    checkOllamaModelDownloaded,
    isOllamaModelDownloading,
    isOllamaModelWarming,
    normalizeOllamaModelName
} from '../services/ollama';
import {LOCAL_LLM_MODELS} from '@shared/constants';
import {
    startRecording as startAudioRecording,
    stopRecording as stopAudioRecording,
    switchAudioInput as switchAudioInputDevice,
    getAudioInputType,
    setAudioInputType,
    getCurrentStream,
    getLastSecondsFloats,
    clonePersistentSystemTrack,
    registerPersistentSystemTrack,
} from './audioSession';
import type {SwitchAudioResult} from './audioSession';
import {hideStopButton, showStopButton} from '../ui/stopButton';

type StreamElements = {
    streamModeContainer: HTMLElement | null;
    streamResults: HTMLTextAreaElement | null;
    streamSendButton: HTMLButtonElement | null;
    toggleInputButton: HTMLButtonElement | null;
    toggleInputIcon?: HTMLImageElement | null;
    durationsContainer?: HTMLDivElement | null;
};

type ToggleSource = 'button' | 'hotkey';

export class StreamController {
    private googleStreamingService = new GoogleStreamingService();

    private currentRequestId: string | null = null;
    private activeOpId = 0;
    private streamDeltaHandler: any = null;
    private streamDoneHandler: any = null;
    private streamErrorHandler: any = null;

    private streamModeContainer: HTMLElement | null = null;
    private streamResults: HTMLTextAreaElement | null = null;
    private streamSendButton: HTMLButtonElement | null = null;
    private toggleInputButton: HTMLButtonElement | null = null;
    private toggleInputIcon: HTMLImageElement | null = null;
    private durationsContainer: HTMLDivElement | null = null;

    private isStreamMode = false;
    private currentStreamSendHotkey = '~';
    private streamAccumulator = '';
    private streamModeInitialized = false;
    private googleStreamingActive = false;

    private readonly onTranscript = (text: string) => {
        if (!this.streamResults) return;
        this.streamResults.value += `${text} `;
        this.streamResults.scrollTop = this.streamResults.scrollHeight;
        this.updateStreamSendButtonState();
    };

    private readonly onStreamingError = (error: string) => {
        console.error('Google streaming error:', error);
        setStatus(`Google error: ${error}`, 'error');
    };

    private readonly handleDocumentKeydown = async (event: KeyboardEvent) => {
        try {
            const pressed = this.eventKeyId(event);
            const targetKey = this.normalizeConfigHotkeyKey(this.currentStreamSendHotkey || '~');
            if (event.ctrlKey && pressed === targetKey && this.isStreamMode) {
                event.preventDefault();
                await this.handleStreamTextSend();
            }
        } catch {
        }
    };

    initialize(elements: StreamElements): void {
        this.streamModeContainer = elements.streamModeContainer;
        this.streamResults = elements.streamResults;
        this.streamSendButton = elements.streamSendButton;
        this.toggleInputButton = elements.toggleInputButton;
        this.toggleInputIcon = elements.toggleInputIcon ?? (document.getElementById('toggleInputIcon') as HTMLImageElement | null);
        this.durationsContainer = elements.durationsContainer ?? (document.getElementById('send-last-container') as HTMLDivElement | null);

        if (this.streamResults && this.streamSendButton) {
            const update = () => this.updateStreamSendButtonState();
            this.streamResults.addEventListener('input', update);
            this.streamSendButton.addEventListener('click', async () => {
                await this.handleStreamTextSend();
            });
            update();
        }

        if (this.toggleInputButton) {
            this.toggleInputButton.addEventListener('click', async () => {
                await this.handleAudioInputToggle('button');
            });
        }

        this.googleStreamingService.onTranscript(this.onTranscript);
        this.googleStreamingService.onError(this.onStreamingError);

        document.addEventListener('keydown', this.handleDocumentKeydown);
    }

    async syncInitialSettings(): Promise<void> {
        let settings: any;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }
        this.currentStreamSendHotkey = settings.streamSendHotkey || '~';
        await this.updateToggleButtonLabel(settings.audioInputType as 'microphone' | 'system' | undefined);
        await this.updateStreamModeVisibility('base');
    }

    handleSettingsChange(key: string, value: unknown): boolean | Promise<boolean> {
        switch (key) {
            case 'streamSendHotkey': {
                this.currentStreamSendHotkey = (value as string) || '~';
                return true;
            }
            case 'audioInputType': {
                const normalized = value === 'system' ? 'system' : 'microphone';
                settingsStore.patch({ audioInputType: normalized });
                setAudioInputType(normalized);
                return this.updateToggleButtonLabel(normalized).then(() => true);
            }
            default:
                return false;
        }
    }

    async handleRecordToggle(shouldRecord: boolean): Promise<void> {
        try {
        if (shouldRecord) {
            await startAudioRecording();
            await this.updateStreamModeVisibility('base');
        } else {
            await stopAudioRecording();
            await this.googleStreamingService.stop();
            this.googleStreamingActive = false;
        }
        } catch (error) {
            console.error('Record toggle failed', error);
            const message = error instanceof Error ? error.message : String(error);
            const code = (error as any)?.code;
            if (code === 'system-audio-capture-failed' || message === 'system-audio-capture-failed') {
                setStatus('Не удалось захватить системный звук. Разрешите доступ или переключитесь на микрофон.', 'error');
            } else {
                setStatus('Ошибка запуска записи', 'error');
            }
            setRecording(false);
            updateButtonsState();
            throw error;
        }
    }

    async handleAskWindow(seconds: number): Promise<void> {
        logger.info('ui', 'Handle ask window', { seconds });

        if (this.currentRequestId) {
            await this.stopActiveStream();
        }

        const opId = ++this.activeOpId;

        setProcessing(true);
        updateButtonsState();

        setStatus('Recognizing...', 'processing');
        showText('');
        showAnswer('');

        const pcm = getLastSecondsFloats(seconds);
        if (!pcm || pcm.channels[0].length === 0) {
            setStatus('No audio in buffer', 'error');
            setProcessing(false);
            updateButtonsState();
            return;
        }

        const wav = floatsToWav(pcm.channels, pcm.sampleRate);
        const arrayBuffer = await wav.arrayBuffer();
        const requestId = `ask-window-${seconds}-` + Date.now();

        try {
            const transcribeRes = await window.api.assistant.transcribeOnly({
                arrayBuffer,
                mime: 'audio/wav',
                filename: `last_${seconds}s.wav`,
                audioSeconds: seconds,
            });

            if (opId !== this.activeOpId) {
                setStatus('Ready', 'ready');
                setProcessing(false);
                updateButtonsState();
                return;
            }
            if (!transcribeRes.ok) {
                setStatus('Error', 'error');
                showError(transcribeRes.error);
                setProcessing(false);
                updateButtonsState();
                return;
            }

            const text = transcribeRes.text;
            showText(text);

            setStatus('Sending to LLM...', 'sending');
            await this.sendChatRequest(requestId, text);
        } catch (error) {
            setStatus('Error', 'error');
            showError(error);
            setProcessing(false);
            this.currentRequestId = null;
            hideStopButton();
            this.removeStreamHandlers();
            updateButtonsState();
        }
    }

    async handleTextSend(text: string): Promise<void> {
        logger.info('ui', 'Handle text send', {
            textLength: text.length,
            inputText: text,
        });
        setProcessing(true);
        updateButtonsState();

        showText(text);
        showAnswer('');

        const textInput = document.getElementById('textInput') as HTMLTextAreaElement | null;
        if (textInput) {
            textInput.value = '';
        }

        const requestId = `text-send-${Date.now()}`;

        try {
            setStatus('Sending to LLM...', 'sending');
            await this.sendChatRequest(requestId, text);
        } catch (error) {
            setStatus('Error', 'error');
            showError(error);
            setProcessing(false);
            this.currentRequestId = null;
            hideStopButton();
            this.removeStreamHandlers();
            updateButtonsState();
        }
    }

    async handleStreamTextSend(): Promise<void> {
        if (!this.streamResults) return;
        const text = this.streamResults.value.trim();
        if (!text) return;
        this.streamResults.value = '';
        this.updateStreamSendButtonState();
        await this.handleTextSend(text);
    }

    async stopActiveStream(): Promise<boolean> {
        if (!this.currentRequestId) {
            return false;
        }

        const requestId = this.currentRequestId;
        logger.info('ui', 'Stop stream requested', { requestId });
        try {
            await window.api.assistant.stopStream({ requestId });
        } catch (error) {
            console.error('Stop stream error', error);
        } finally {
            this.currentRequestId = null;
            this.removeStreamHandlers();
            setStatus('Ready', 'ready');
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
        }
        return true;
    }

    async handleHotkeyToggleRequest(): Promise<void> {
        await this.handleAudioInputToggle('hotkey');
    }

    async updateStreamModeVisibility(_preferred?: 'base' | 'stream'): Promise<void> {
        try {
            this.isStreamMode = false;
            this.streamModeInitialized = true;
            if (this.streamModeContainer) {
                this.streamModeContainer.classList.add('hidden');
                this.streamModeContainer.style.display = 'none';
            }
            if (this.durationsContainer) {
                this.durationsContainer.classList.remove('hidden');
                this.durationsContainer.style.display = 'block';
            }
            if (this.googleStreamingActive) {
                try {
                    await this.googleStreamingService.stop();
                } catch {
                }
                this.googleStreamingActive = false;
            }
        } catch (error) {
            console.error('Error updating stream mode visibility:', error);
        }
    }

    private async sendChatRequest(requestId: string, text: string): Promise<void> {
        if (!(await this.ensureLlmReady())) {
            return;
        }
        this.currentRequestId = requestId;
        this.prepareStreamHandlers(requestId);
        showStopButton();
        await window.api.assistant.askChat({ text, requestId });
    }

    private prepareStreamHandlers(requestId: string): void {
        this.removeStreamHandlers();
        this.streamAccumulator = '';

        this.streamDeltaHandler = (_e: unknown, payload: { requestId?: string; delta: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId) || this.currentRequestId !== requestId) return;
            this.streamAccumulator += payload.delta || '';
            showAnswer(this.streamAccumulator);
            setStatus('Responding...', 'processing');
            showStopButton();
        };

        this.streamDoneHandler = (_e: unknown, payload: { requestId?: string; full: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId)) return;
            logger.info('stream', 'Stream done handler called', { requestId: payload.requestId });
            this.currentRequestId = null;
            setStatus('Done', 'ready');
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
            this.removeStreamHandlers();
        };

        this.streamErrorHandler = (_e: unknown, payload: { requestId?: string; error: string }) => {
            if (!payload || (payload.requestId && payload.requestId !== requestId)) return;
            logger.info('stream', 'Stream error handler called', { requestId: payload.requestId, error: payload.error });
            this.currentRequestId = null;
            const msg = (payload.error || '').toString();
            if (msg.toLowerCase().includes('aborted')) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
                showError(payload.error);
            }
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
            this.removeStreamHandlers();
        };

        window.api.assistant.onStreamDelta(this.streamDeltaHandler);
        window.api.assistant.onStreamDone(this.streamDoneHandler);
        window.api.assistant.onStreamError(this.streamErrorHandler);
    }

    private async ensureLlmReady(): Promise<boolean> {
        let settings: any;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }

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

    private updateStreamSendButtonState(): void {
        if (!this.streamResults || !this.streamSendButton) return;
        try {
            this.streamSendButton.disabled = !(this.streamResults.value.trim().length > 0) || state.isProcessing;
        } catch {
        }
    }

    private normalizeConfigHotkeyKey(key: string): string {
        const lower = String(key || '').toLowerCase();
        if (lower === '~' || lower === '`') return 'backquote';
        return lower;
    }

    private eventKeyId(event: KeyboardEvent): string {
        const code = event.code || '';
        const key = String(event.key || '').toLowerCase();
        if (code === 'Backquote') return 'backquote';
        if (key === 'dead' && code === 'Backquote') return 'backquote';
        return key;
    }

    private async handleAudioInputToggle(source: ToggleSource): Promise<void> {
        try {
            let settingsSnapshot: any;
            try {
                settingsSnapshot = settingsStore.get();
            } catch {
                settingsSnapshot = await settingsStore.load();
            }
            const currentType = (settingsSnapshot.audioInputType || 'microphone') as 'microphone' | 'system';
            const nextType: 'microphone' | 'system' = currentType === 'microphone' ? 'system' : 'microphone';

            let preStream: MediaStream | null | undefined;
            if (state.isRecording && nextType === 'system') {
                preStream = await this.prepareSystemStream(source);
                if (preStream === null) {
                    return;
                }
            }

            const result = await this.switchAudioInput(nextType, { preStream, gesture: source === 'button' });
            if (result.success) {
                settingsStore.patch({ audioInputType: nextType });
            }
        } catch (error) {
            console.error('Toggle input failed', error);
        }
    }

    private async switchAudioInput(newType: 'microphone' | 'system', opts?: { preStream?: MediaStream | null; gesture?: boolean }): Promise<SwitchAudioResult> {
        logger.info('audio', 'Switch input requested', { newType });

        const previousType = getAudioInputType();
        setAudioInputType(newType);

        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }

        const result = await switchAudioInputDevice(newType, opts);
        if (!result.success) {
            setAudioInputType(previousType);
            try {
                await this.updateToggleButtonLabel(previousType);
            } catch {
            }
            return result;
        }

        try {
            await this.updateToggleButtonLabel(newType);
        } catch {
        }

        if (state.isRecording) {
            try {
                let settings: any;
                try {
                    settings = settingsStore.get();
                } catch {
                    settings = await settingsStore.load();
                }
                await this.googleStreamingService.stop();
                this.googleStreamingActive = false;
                setStatus('Recording...', 'recording');
            } catch (error) {
                console.error('Failed to refresh recorder status after input switch', error);
            }
        }

        return result;
    }

    private async prepareSystemStream(source: ToggleSource): Promise<MediaStream | null | undefined> {
        if (source === 'button') {
            return this.prepareSystemStreamWithGesture();
        }
        return this.prepareSystemStreamWithoutGesture();
    }

    private async prepareSystemStreamWithGesture(): Promise<MediaStream | null> {
        try {
            try {
                (window as any).api?.loopback?.enable?.();
            } catch {
            }
            const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            const audioTracks = displayStream.getAudioTracks();
            const sysTrack = audioTracks[0];
            let preStream: MediaStream | undefined;
            if (sysTrack) {
                registerPersistentSystemTrack(sysTrack);
                const clone = sysTrack.clone();
                preStream = new MediaStream([clone]);
            } else if (audioTracks.length) {
                preStream = new MediaStream(audioTracks.map((track) => track.clone()));
            }
            displayStream.getVideoTracks().forEach((track) => track.stop());
            return preStream ?? null;
        } catch (error) {
            console.error('System audio capture cancelled/failed', error);
            setStatus('System audio requires a user selection', 'error');
            return null;
        }
    }

    private async prepareSystemStreamWithoutGesture(): Promise<MediaStream | null> {
        const persistedClone = clonePersistentSystemTrack();
        if (persistedClone) {
            try {
                try {
                    (window as any).api?.loopback?.enable?.();
                } catch {
                }
                return new MediaStream([persistedClone]);
            } catch {
            }
        }

        try {
            try {
                (window as any).api?.loopback?.enable?.();
            } catch {
            }
            const sourceId = await (window as any).api?.media?.getPrimaryDisplaySourceId?.();
            const constraints: any = sourceId
                ? {
                      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                  }
                : {
                      audio: { mandatory: { chromeMediaSource: 'desktop' } },
                      video: { mandatory: { chromeMediaSource: 'desktop' } },
                  };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const audioTracks = stream.getAudioTracks();
            const sysTrack = audioTracks[0] || null;
            let preStream: MediaStream | null = null;
            if (sysTrack) {
                registerPersistentSystemTrack(sysTrack);
                const clone = sysTrack.clone();
                preStream = new MediaStream([clone]);
            }
            try {
                stream.getVideoTracks().forEach((track) => track.stop());
            } catch {
            }
            return preStream;
        } catch (error) {
            console.error('desktopCapturer getUserMedia fallback failed', error);
            return null;
        }
    }

    private async updateToggleButtonLabel(preferred?: 'microphone' | 'system'): Promise<void> {
        const btn = this.toggleInputButton ?? (document.getElementById('btnToggleInput') as HTMLButtonElement | null);
        const icon = this.toggleInputIcon ?? (document.getElementById('toggleInputIcon') as HTMLImageElement | null);
        this.toggleInputButton = btn;
        this.toggleInputIcon = icon;
        if (!btn || !icon) return;

        let type: 'microphone' | 'system' | undefined = preferred;
        if (!type) {
            try {
                const settings = settingsStore.get();
                type = (settings.audioInputType || 'microphone') as 'microphone' | 'system';
            } catch {
                const settings = await settingsStore.load();
                type = (settings.audioInputType || 'microphone') as 'microphone' | 'system';
            }
        }
        if (!type) type = getAudioInputType();

        setAudioInputType(type);
        const iconSrc = type === 'microphone' ? 'img/icons/mic.png' : 'img/icons/audio.png';
        const iconAlt = type === 'microphone' ? 'MIC' : 'SYS';
        const title = type === 'microphone' ? 'Using Microphone' : 'Using System Audio';

        icon.src = iconSrc;
        icon.alt = iconAlt;
        btn.title = title;
    }
}
