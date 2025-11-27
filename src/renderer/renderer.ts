import {initControls, updateDurations} from './ui/controls';
import {listen} from '@tauri-apps/api/event';
import {initStatus, setStatus} from './ui/status';
import {initOutputs} from './ui/outputs';
import {settingsStore} from './state/settingsStore';
import {initializeWelcomeModal} from './ui/welcomeModal';
import {setupAnswerFontSizeControls} from './app/fontSizeControls';
import {awaitPreloadBridge} from './app/preloadBridge';
import {StreamController} from './app/streamController';
import {ScreenshotController} from './app/screenshotController';
import {startLogoAnimation, loadLogo} from './ui/logoAnimation';
import {checkFeatureAccess, showFeatureAccessModal} from './ui/featureAccessModal';
import {registerStopButton, hideStopButton} from './ui/stopButton';
import {state} from './state/appState';
import {requestSystemAudioPermission, getSystemAudioStream} from './services/systemAudioCapture';
import {audioSessionState} from './app/audioSession/internalState';
import {checkOllamaModelDownloaded} from './services/ollama';
import {normalizeLocalWhisperModel} from './services/localSpeechModels';

// Listen to transcription debug events (only if files are being saved)
// Запрашиваем разрешение на системный звук при старте
async function requestSystemAudioPermissionOnStartup() {
    try {
        console.info('[renderer] Requesting system audio permission on startup...');
        const granted = await requestSystemAudioPermission();
        if (granted) {
            const stream = getSystemAudioStream();
            if (stream && stream instanceof MediaStream) {
                audioSessionState.systemAudioStream = stream;
                console.info('[renderer] System audio permission granted and stream saved', {
                    active: stream.active,
                    audioTracks: stream.getAudioTracks().length,
                    videoTracks: stream.getVideoTracks().length,
                });
            } else {
                console.warn('[renderer] System audio stream is not a valid MediaStream', {stream});
            }
        } else {
            console.warn('[renderer] System audio permission not granted');
        }
    } catch (error) {
        console.warn('[renderer] Failed to request system audio permission on startup:', error);
    }
}

// Предзагружаем модели, если включен локальный режим
async function preloadLocalModelsIfNeeded() {
    try {
        const settings = await settingsStore.load();
        const mode = settings.transcriptionMode || 'api';
        
        if (mode === 'local') {
            console.info('[renderer] Preloading local models and checking server status...');
            
            // Проверяем локальную модель транскрипции
            if (window.api?.localSpeech) {
                try {
                    // Используем checkHealth для полной проверки статуса сервера
                    // Это обновит кэш и проверит реальное состояние сервера
                    const status = await window.api.localSpeech.checkHealth();
                    console.info('[renderer] Local speech server status:', {
                        installed: status?.installed,
                        running: status?.running,
                    });
                    
                    if (status?.installed && status?.running) {
                        const model = normalizeLocalWhisperModel(settings.localWhisperModel || 'base') || 'base';
                        const downloaded = await window.api.localSpeech.checkModelDownloaded(model);
                        console.info('[renderer] Local transcription model checked:', {
                            model,
                            downloaded,
                        });
                    } else {
                        console.warn('[renderer] Local speech server not ready:', {
                            installed: status?.installed,
                            running: status?.running,
                        });
                    }
                } catch (error) {
                    console.warn('[renderer] Failed to check local speech server:', error);
                }
            }
            
            // Проверяем локальную LLM модель, если используется локальный LLM
            if (settings.llmHost === 'local') {
                try {
                    const llmModel = settings.localLlmModel || settings.llmModel || 'gpt-oss:20b';
                    const downloaded = await checkOllamaModelDownloaded(llmModel, {force: true});
                    console.info('[renderer] Local LLM model checked:', {
                        model: llmModel,
                        downloaded,
                    });
                } catch (error) {
                    console.warn('[renderer] Failed to check local LLM model:', error);
                }
            }
        }
    } catch (error) {
        console.warn('[renderer] Failed to preload local models:', error);
    }
}

async function setupTranscriptionDebugListener() {
    try {
        await listen('transcription:debug:saved', (event: any) => {
            const {path, size, mode, filename} = event.payload;
            console.log('[transcription] Saved audio file:', {
                path,
                size: `${size} bytes`,
                mode,
                filename,
            });
        });
    } catch (error) {
        // Silently fail - this is optional
    }
}

export async function initializeRenderer() {
    // Setup transcription debug listener (optional)
    setupTranscriptionDebugListener().catch(() => {});
    
    // Запрашиваем разрешение на захват системного звука при старте
    // System audio capture is now handled by Rust WASAPI loopback
    // No need to request getDisplayMedia permission
    
    setupAnswerFontSizeControls();

    initStatus(document.getElementById('status') as HTMLDivElement | null);
    initOutputs({
        text: document.getElementById('textOut') as HTMLDivElement | null,
        answer: document.getElementById('answerOut') as HTMLDivElement | null,
    });

    const bridge = await awaitPreloadBridge();
    if (!bridge) {
        setStatus('Preload-скрипт недоступен', 'error');
        return;
    }
    console.info('[renderer] Preload bridge ready for use');
    
    // Автоматически проверяем доступность моделей после инициализации bridge
    // Это гарантирует, что API полностью готов к использованию
    preloadLocalModelsIfNeeded().catch((error) => {
        console.warn('[renderer] Failed to preload local models:', error);
    });

    const streamController = new StreamController();
    const screenshotController = new ScreenshotController();

    const streamModeContainer = document.getElementById('streamResultsSection');
    const streamResults = document.getElementById('streamResultsTextarea') as HTMLTextAreaElement | null;
    const btnSendStream = document.getElementById('btnSendStreamText') as HTMLButtonElement | null;
    const btnToggleInput = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
    const toggleInputIcon = document.getElementById('toggleInputIcon') as HTMLImageElement | null;
    const durationsContainer = document.getElementById('send-last-container') as HTMLDivElement | null;
    streamController.initialize({
        streamModeContainer: streamModeContainer as HTMLElement | null,
        streamResults,
        streamSendButton: btnSendStream,
        toggleInputButton: btnToggleInput,
        toggleInputIcon,
        durationsContainer,
    });
    await streamController.syncInitialSettings();

    const btnScreenshot = document.getElementById('btnScreenshot') as HTMLButtonElement | null;
    const btnStop = document.getElementById('btnStopStream') as HTMLButtonElement | null;
    registerStopButton(btnStop);

    if (btnScreenshot) {
        btnScreenshot.addEventListener('click', async () => {
            if (checkFeatureAccess('screen_processing')) {
                await screenshotController.start();
            } else {
                showFeatureAccessModal('screen_processing');
            }
        });
    }

    if (btnStop) {
        btnStop.addEventListener('click', async () => {
            if (await streamController.stopActiveStream()) {
                return;
            }
            if (screenshotController.cancelActive()) {
                return;
            }
            hideStopButton();
        });
    }

    const mainLogoElement = document.getElementById('main-logo') as HTMLImageElement | null;
    const logoContainer = document.querySelector('.logo-container') as HTMLElement | null;
    loadLogo(mainLogoElement);
    if (mainLogoElement && logoContainer) {
        startLogoAnimation(mainLogoElement, logoContainer);
    }
    const headerLogoElement = document.getElementById('header-logo') as HTMLImageElement | null;
    loadLogo(headerLogoElement);

    await initializeWelcomeModal();

    const settings = await settingsStore.load();
    const durations = Array.isArray(settings.durations) && settings.durations.length
        ? settings.durations
        : [5, 10, 15, 20, 30, 60];
    const durationHotkeys = settings.durationHotkeys;
    if (Array.isArray(durations) && durations.length) {
        try {
            (state as any).durationSec = Math.max(...durations);
        } catch {
        }
    }

    initControls({
        durations,
        onRecordToggle: async (shouldRecord) => {
            await streamController.handleRecordToggle(shouldRecord);
        },
        onDurationChange: (sec) => {
            streamController.handleAskWindow(sec);
        },
        onTextSend: (text) => {
            streamController.handleTextSend(text);
        },
    });

    try {
        const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
        if (durationsEl && durationHotkeys) {
            const buttons = durationsEl.querySelectorAll('button');
            buttons.forEach((btn) => {
                const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                const key = (durationHotkeys as any)[sec];
                if (!key) return;
                const old = btn.querySelector('.hk');
                if (old) old.remove();
                const label = document.createElement('span');
                label.className = 'hk text-xs text-gray-400 font-extralight';
                label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                btn.appendChild(label);
            });
        }
    } catch {
    }

    window.api.hotkeys.onDuration((_e: unknown, payload: { sec: number }) => {
        try {
            streamController.handleAskWindow(payload.sec);
        } catch {
        }
    });

    window.api.hotkeys.onToggleInput(async () => {
        await streamController.handleHotkeyToggleRequest();
    });

    window.addEventListener('xexamai:settings-changed' as any, async (ev: any) => {
        try {
            const {key, value} = ev?.detail || {};
            const handled = streamController.handleSettingsChange(key, value);
            const finalized = handled instanceof Promise ? await handled : handled;
            if (finalized) {
                return;
            }
            switch (key) {
                case 'durations': {
                    const nextDurations: number[] = Array.isArray(value) ? value : [];
                    settingsStore.patch({ durations: nextDurations });
                    updateDurations(nextDurations, (sec) => {
                        streamController.handleAskWindow(sec);
                    });
                    try {
                        (state as any).durationSec = Math.max(...nextDurations);
                    } catch {
                    }
                    break;
                }
                case 'durationHotkeys': {
                    const map = (value ?? {}) as Record<number, string>;
                    settingsStore.patch({ durationHotkeys: map });
                    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
                    if (!durationsEl) break;
                    const buttons = durationsEl.querySelectorAll('button');
                    buttons.forEach((btn) => {
                        const old = btn.querySelector('.hk');
                        if (old) old.remove();
                        const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                        const hotkey = map?.[sec];
                        if (!hotkey) return;
                        const label = document.createElement('span');
                        label.className = 'hk text-xs text-gray-400 font-extralight';
                        label.textContent = `Ctrl-${String(hotkey).toUpperCase()}`;
                        btn.appendChild(label);
                    });
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            console.error('settings change handler failed', error);
        }
    });

    const minimizeBtn = document.getElementById('minimizeBtn');
    const closeBtn = document.getElementById('closeBtn');

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            window.api.window.minimize();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.api.window.close();
        });
        closeBtn.blur();
        closeBtn.addEventListener('focus', () => {
            closeBtn.blur();
        });
    }
}
