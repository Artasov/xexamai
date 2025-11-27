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
    getLastSecondsFloats,
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
                const normalized = value === 'system' ? 'system' : (value === 'mixed' ? 'mixed' : 'microphone');
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

        // Check if audio has actual signal (not just silence)
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
        
        // If amplitude is too low, likely silence or very quiet
        // Lowered threshold because Rust code now applies gain
        if (maxAmplitude < 0.0001 && rms < 0.00005) {
            logger.warn('ui', 'Audio appears to be silence', { 
                maxAmplitude, 
                rms,
                seconds, 
                frames: pcm.channels[0].length 
            });
            setStatus('No audio signal detected (silence). Check microphone and speak louder.', 'error');
            setProcessing(false);
            updateButtonsState();
            return;
        }
        
        // Warn if audio is very quiet but not completely silent
        if (maxAmplitude < 0.01) {
            logger.warn('ui', 'Audio is very quiet, may cause transcription issues', { 
                maxAmplitude, 
                rms,
                seconds 
            });
        }

        // Additional validation: check if all channels have same length
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
        
        // Validate WAV file size (should be at least 44 bytes header + some data)
        if (arrayBuffer.byteLength < 1000) {
            logger.error('ui', 'WAV file too small', { 
                size: arrayBuffer.byteLength, 
                seconds, 
                frames: expectedFrames,
                sampleRate: pcm.sampleRate,
                channels: pcm.channels.length,
            });
            setStatus('Audio buffer too small or empty', 'error');
            setProcessing(false);
            updateButtonsState();
            return;
        }
        
        // Validate WAV header
        const view = new DataView(arrayBuffer);
        const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
        if (riff !== 'RIFF' || wave !== 'WAVE') {
            logger.error('ui', 'Invalid WAV header', { riff, wave });
            setStatus('Invalid audio format', 'error');
            setProcessing(false);
            updateButtonsState();
            return;
        }
        
        // Check actual audio data (skip 44-byte header)
        let dataMaxAmp = 0;
        let dataSampleCount = 0;
        if (arrayBuffer.byteLength > 44) {
            const dataView = new DataView(arrayBuffer, 44);
            const sampleCount = (arrayBuffer.byteLength - 44) / 2;
            for (let i = 0; i < Math.min(sampleCount, 1000); i++) {
                const sample = dataView.getInt16(i * 2, true);
                const amp = Math.abs(sample / 32767.0);
                if (amp > dataMaxAmp) dataMaxAmp = amp;
                dataSampleCount++;
            }
        }
        
        const requestId = `ask-window-${seconds}-` + Date.now();
        logger.info('ui', 'Sending audio for transcription', {
            size: arrayBuffer.byteLength,
            seconds,
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
            const currentType = (settingsSnapshot.audioInputType || 'microphone') as 'microphone' | 'system' | 'mixed';
            const nextType: 'microphone' | 'system' | 'mixed' =
                currentType === 'microphone'
                    ? 'system'
                    : currentType === 'system'
                        ? 'mixed'
                        : 'microphone';

            const result = await this.switchAudioInput(nextType);
            if (result.success) {
                settingsStore.patch({ audioInputType: nextType });
            }
        } catch (error) {
            console.error('Toggle input failed', error);
        }
    }

    private async switchAudioInput(newType: 'microphone' | 'system' | 'mixed'): Promise<SwitchAudioResult> {
        logger.info('audio', 'Switch input requested', { newType });

        const previousType = getAudioInputType();
        setAudioInputType(newType);

        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }

        // Update icon immediately for better UX
        try {
            await this.updateToggleButtonLabel(newType);
        } catch {
        }

        const result = await switchAudioInputDevice(newType);
        if (!result.success) {
            setAudioInputType(previousType);
            try {
                await window.api.settings.setAudioInputType(previousType);
            } catch {
            }
            try {
                await this.updateToggleButtonLabel(previousType);
            } catch {
            }
            return result;
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

    private async prepareSystemStream(_source: ToggleSource): Promise<MediaStream | null | undefined> {
        // Native capture no longer needs a browser stream.
        return null;
    }

    private async updateToggleButtonLabel(preferred?: 'microphone' | 'system' | 'mixed'): Promise<void> {
        const btn = this.toggleInputButton ?? (document.getElementById('btnToggleInput') as HTMLButtonElement | null);
        let icon = this.toggleInputIcon ?? (document.getElementById('toggleInputIcon') as HTMLImageElement | null);
        this.toggleInputButton = btn;
        if (!btn) return;

        let type: 'microphone' | 'system' | 'mixed' | undefined = preferred as any;
        if (!type) {
            try {
                const settings = settingsStore.get();
                type = (settings.audioInputType || 'microphone') as any;
            } catch {
                const settings = await settingsStore.load();
                type = (settings.audioInputType || 'microphone') as any;
            }
        }
        if (!type) type = getAudioInputType();

        setAudioInputType(type);
        const iconAlt = type === 'microphone' ? 'MIC' : type === 'system' ? 'SYS' : 'MIX';
        const title = type === 'microphone'
            ? 'Using Microphone'
            : type === 'system'
                ? 'Using System Audio'
                : 'Using Mic + System Audio';

        btn.title = title;

        // Для mixed режима показываем две иконки рядом
        if (type === 'mixed') {
            // Очищаем содержимое кнопки
            btn.innerHTML = '';
            // Создаём контейнер для двух иконок
            const container = document.createElement('div');
            container.style.cssText = 'display: flex; align-items: center; gap: 2px;';
            
            // Иконка микрофона
            const micIcon = document.createElement('img');
            micIcon.src = 'img/icons/mic.png';
            micIcon.alt = 'MIC';
            micIcon.className = 'h-5 w-5';
            micIcon.style.cssText = 'filter: invert(1); opacity: 80%;';
            
            // Иконка системного звука
            const audioIcon = document.createElement('img');
            audioIcon.src = 'img/icons/audio.png';
            audioIcon.alt = 'SYS';
            audioIcon.className = 'h-5 w-5';
            audioIcon.style.cssText = 'filter: invert(1); opacity: 80%;';
            
            container.appendChild(micIcon);
            container.appendChild(audioIcon);
            btn.appendChild(container);
        } else {
            // Для остальных режимов показываем одну иконку
            // Восстанавливаем оригинальную структуру, если её нет
            if (!icon || !btn.contains(icon)) {
                btn.innerHTML = '';
                icon = document.createElement('img');
                icon.id = 'toggleInputIcon';
                icon.className = 'h-5 w-5';
                icon.style.cssText = 'filter: invert(1); opacity: 80%;';
                btn.appendChild(icon);
                this.toggleInputIcon = icon;
            }
            const iconSrc = type === 'microphone' ? 'img/icons/mic.png' : 'img/icons/audio.png';
            icon.src = iconSrc;
            icon.alt = iconAlt;
        }
    }
}
