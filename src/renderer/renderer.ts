import {initControls, updateButtonsState, updateDurations} from './ui/controls';
import {initStatus, setStatus} from './ui/status';
import {initOutputs, showAnswer, showText, showError} from './ui/outputs';
import {setProcessing, state} from './state/appState';
import {floatsToWav} from './audio/encoder';
import {logger} from './utils/logger';
import {initializeWelcomeModal} from './ui/welcomeModal';
import {settingsStore} from './state/settingsStore';
import {GoogleStreamingService} from './services/googleStreamingService';
import {getHolderState} from './state/holderState';
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
} from './app/audioSession';
import type {SwitchAudioResult} from './app/audioSession';
// Google SDK is loaded in preload and exposed via window.api.google

import type {AssistantAPI} from './types';

let currentRequestId: string | null = null;
let btnStop: HTMLButtonElement | null = null;
let activeOpId: number = 0;
let screenshotCancelToken: { cancelled: boolean } | null = null;
// Stream event handlers - store references for proper cleanup
let currentStreamDeltaHandler: any = null;
let currentStreamDoneHandler: any = null;
let currentStreamErrorHandler: any = null;
// Stream mode variables
let streamModeContainer: HTMLElement | null = null;
let streamResults: HTMLTextAreaElement | null = null;
let btnSendStream: HTMLButtonElement | null = null;
let isStreamMode: boolean = false;
const googleStreamingService = new GoogleStreamingService();

// Fallback: ensure UI resets if stream completion event is missed
function finalizeStreamIfActive(localRequestId?: string) {
    try {
        if (!currentRequestId) return;
        if (localRequestId && currentRequestId !== localRequestId) return;
        currentRequestId = null;
        try { setStatus('Done', 'ready'); } catch {}
        setProcessing(false);
        hideStopButton();
        updateButtonsState();
        removeStreamHandlers();
    } catch {}
}
// Current stream send hotkey (updated live from settings)
let currentStreamSendHotkey: string = '~';
// Font size management constants
const FONT_SIZE_KEY = 'xexamai-answer-font-size';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 14;

// Helper to get Stop button reliably
function getStopButton(): HTMLButtonElement | null {
    return btnStop || (document.getElementById('btnStopStream') as HTMLButtonElement | null);
}

// Helper to show Stop button
function showStopButton() {
    try {
        getStopButton()?.classList.remove('hidden');
    } catch {}
}

// Helper to hide Stop button
function hideStopButton() {
    try {
        getStopButton()?.classList.add('hidden');
    } catch {}
}

// Helper to remove old stream event handlers
function removeStreamHandlers() {
    try {
        (window.api.assistant as any).offStreamTranscript?.();
        (window.api.assistant as any).offStreamDelta?.();
        (window.api.assistant as any).offStreamDone?.();
        (window.api.assistant as any).offStreamError?.();
    } catch {}
    // Clear handler references
    currentStreamDeltaHandler = null;
    currentStreamDoneHandler = null;
    currentStreamErrorHandler = null;
}

async function updateToggleButtonLabel(preferred?: 'microphone' | 'system') {
    const btn = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
    const icon = document.getElementById('toggleInputIcon') as HTMLImageElement | null;
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

async function updateStreamModeVisibility() {
    try {
        let settings;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }
        const streamMode = settings.streamMode || 'base';
        isStreamMode = streamMode === 'stream';
        
        console.log('Updating stream mode visibility:', { streamMode, isStreamMode, streamModeContainer: !!streamModeContainer });
        
        if (streamModeContainer) {
            if (isStreamMode) {
                streamModeContainer.classList.remove('hidden');
                streamModeContainer.style.display = 'block';
            } else {
                streamModeContainer.classList.add('hidden');
                streamModeContainer.style.display = 'none';
            }
        } else {
            console.warn('streamModeContainer not found');
        }

        // Toggle durations (Send the last: 5s, 10s, 15s, ...) visibility opposite to stream mode
        try {
            const durationsContainer = document.getElementById('send-last-container') as HTMLDivElement | null;
            if (durationsContainer) {
                if (isStreamMode) {
                    durationsContainer.classList.add('hidden');
                    durationsContainer.style.display = 'none';
                } else {
                    durationsContainer.classList.remove('hidden');
                    durationsContainer.style.display = 'block';
                }
            }
        } catch {}
        const activeStream = getCurrentStream();
        if (isStreamMode && activeStream) {
            try { setStatus('Preparing Google stream...', 'processing'); } catch {}
            try {
                await googleStreamingService.start(activeStream);
                setStatus('Google streaming active', 'processing');
            } catch (error) {
                console.error('Failed to start Google streaming:', error);
                setStatus('Failed to start Google streaming', 'error');
            }
        } else if (!isStreamMode) {
            await googleStreamingService.stop();
        }
    } catch (error) {
        console.error('Error updating stream mode visibility:', error);
    }
}

async function handleStreamTextSend() {
    if (!streamResults || !streamResults.value.trim()) return;
    
    const text = streamResults.value.trim();
    streamResults.value = '';
    
    await handleTextSend(text);
}

async function switchAudioInput(newType: 'microphone' | 'system', opts?: { preStream?: MediaStream; gesture?: boolean }): Promise<SwitchAudioResult> {
    logger.info('audio', 'Switch input requested', { newType });

    const previousType = getAudioInputType();
    setAudioInputType(newType);

    // Persist new type so settings stay in sync
    try {
        await window.api.settings.setAudioInputType(newType);
    } catch {
    }

    const result = await switchAudioInputDevice(newType, opts);
    if (!result.success) {
        setAudioInputType(previousType);
        try {
            await updateToggleButtonLabel(previousType);
        } catch {
        }
        return result;
    }

    try {
        await updateToggleButtonLabel(newType);
    } catch {
    }

    if (state.isRecording) {
        try {
            let settings;
            try {
                settings = settingsStore.get();
            } catch {
                settings = await settingsStore.load();
            }
            const streamMode = settings.streamMode || 'base';
            if (streamMode === 'stream') {
                try {
                    setStatus('Preparing Google stream...', 'processing');
                } catch {
                }
                const streamToUse = result.stream ?? getCurrentStream();
                if (streamToUse) {
                    await googleStreamingService.start(streamToUse);
                    setStatus('Google streaming active', 'processing');
                }
            } else {
                await googleStreamingService.stop();
                setStatus('Recording...', 'recording');
            }
        } catch (error) {
            console.error('Failed to refresh recorder status after input switch', error);
        }
    }

    return result;
}

async function handleAskWindow(seconds: number) {
    logger.info('ui', 'Handle ask window', { seconds });
    
    // In stream mode, ignore duration buttons
    if (isStreamMode) {
        return;
    }
    
    // Cancel any ongoing stream before starting a new one
    if (currentRequestId) {
        try { await window.api.assistant.stopStream({ requestId: currentRequestId }); } catch {}
        currentRequestId = null;
        removeStreamHandlers();
        hideStopButton();
        setStatus('Ready', 'ready');
        setProcessing(false);
        updateButtonsState();
    }

    // Operation guard to ignore stale results from previous requests
    const opId = ++activeOpId;

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
    currentRequestId = requestId;

    try {
        const transcribeRes = await window.api.assistant.transcribeOnly({
            arrayBuffer,
            mime: 'audio/wav',
            filename: `last_${seconds}s.wav`,
            audioSeconds: seconds,
        });
        // If a newer operation started while transcribing, ignore this result
        if (opId !== activeOpId) {
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

        // Remove old handlers before adding new ones
        removeStreamHandlers();

        let acc = '';
        currentStreamDeltaHandler = (_e: unknown, p: { requestId?: string; delta: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId) || currentRequestId !== requestId) return;
            acc += p.delta || '';
            showAnswer(acc);
            setStatus('Responding...', 'processing');
            showStopButton();
        };
        currentStreamDoneHandler = (_e: unknown, p: { requestId?: string; full: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            logger.info('stream', 'Stream done handler called', { requestId: p.requestId });
            currentRequestId = null;
            setStatus('Done', 'ready');
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
        };
        currentStreamErrorHandler = (_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            logger.info('stream', 'Stream error handler called', { requestId: p.requestId, error: p.error });
            currentRequestId = null;
            const msg = (p.error || '').toString();
            if (msg.toLowerCase().includes('aborted')) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
                showError(p.error);
            }
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
        };

        window.api.assistant.onStreamDelta(currentStreamDeltaHandler);
        window.api.assistant.onStreamDone(currentStreamDoneHandler);
        window.api.assistant.onStreamError(currentStreamErrorHandler);

        // Show Stop button before starting streaming request
        showStopButton();
        await window.api.assistant.askChat({ text, requestId });
        // Fallback cleanup in case Done event was missed
        finalizeStreamIfActive(requestId);

    } catch (error) {
        setStatus('Error', 'error');
        showError(error);
        setProcessing(false);
        currentRequestId = null;
        hideStopButton();
        updateButtonsState();
    }
}

async function handleTextSend(text: string) {
    logger.info('ui', 'Handle text send', { 
        textLength: text.length,
        inputText: text 
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
    currentRequestId = requestId;

    try {
        setStatus('Sending to LLM...', 'sending');

        // Remove old handlers before adding new ones
        removeStreamHandlers();

        let acc = '';
        currentStreamDeltaHandler = (_e: unknown, p: { requestId?: string; delta: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId) || currentRequestId !== requestId) return;
            acc += p.delta || '';
            showAnswer(acc);
            setStatus('Responding...', 'processing');
            showStopButton();
        };
        currentStreamDoneHandler = (_e: unknown, p: { requestId?: string; full: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            logger.info('stream', 'Stream done handler called', { requestId: p.requestId });
            currentRequestId = null;
            setStatus('Done', 'ready');
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
        };
        currentStreamErrorHandler = (_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            logger.info('stream', 'Stream error handler called', { requestId: p.requestId, error: p.error });
            currentRequestId = null;
            const msg = (p.error || '').toString();
            if (msg.toLowerCase().includes('aborted')) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
                showError(p.error);
            }
            setProcessing(false);
            hideStopButton();
            updateButtonsState();
        };

        window.api.assistant.onStreamDelta(currentStreamDeltaHandler);
        window.api.assistant.onStreamDone(currentStreamDoneHandler);
        window.api.assistant.onStreamError(currentStreamErrorHandler);

        // Show Stop button before starting streaming request
        showStopButton();
        await window.api.assistant.askChat({
            text,
            requestId,
        });
        // Fallback cleanup in case Done event was missed
        finalizeStreamIfActive(requestId);

    } catch (error) {
        setStatus('Error', 'error');
        showError(error);
        setProcessing(false);
        currentRequestId = null;
        hideStopButton();
        updateButtonsState();
    }
}

async function handleScreenshot() {
    if (state.isProcessing) return;

    const cancelToken = { cancelled: false };
    screenshotCancelToken = cancelToken;

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
        showText(label);

        setStatus('Analyzing screenshot...', 'processing');

        const result = await window.api.screen.process({
            imageBase64: capture.base64,
            mime: capture.mime,
            width: capture.width,
            height: capture.height,
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
            showAnswer(answerText);
        } else {
            showAnswer('No insights returned.');
        }
        setStatus('Done', 'ready');
        logger.info('screenshot', 'Screenshot analysis completed', { answerLength: result.answer?.length || 0 });
    } catch (error) {
        if (cancelToken.cancelled) {
            logger.info('screenshot', 'Screenshot analysis cancelled', {
                reason: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error('screenshot', 'Screenshot analysis failed', { error: message });
        setStatus('Error', 'error');
        showError(message);
    } finally {
        if (screenshotCancelToken === cancelToken) {
            screenshotCancelToken = null;
            setProcessing(false);
            updateButtonsState();
            hideStopButton();
        }
    }
}

export async function initializeRenderer() {
    // Initialize font size functionality
    initializeFontSize();
    
    // Add wheel event listener for font size control
    document.addEventListener('wheel', handleFontSizeWheel, { passive: false });

    initStatus(document.getElementById('status') as HTMLDivElement | null);
    initOutputs({
        text: document.getElementById('textOut') as HTMLDivElement | null,
        answer: document.getElementById('answerOut') as HTMLDivElement | null,
    });

    let bridge = (window as unknown as { api?: AssistantAPI }).api;
    if (bridge) {
        console.info('[renderer] Preload bridge detected immediately', Object.keys(bridge));
    }
    if (!bridge) {
        const isElectron =
            typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron/') ||
            typeof window !== 'undefined' && (window as any)?.process?.type === 'renderer';

        if (isElectron) {
            console.warn('[renderer] Preload bridge not immediately available, polling...');
            for (let i = 0; i < 30; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                bridge = (window as unknown as { api?: AssistantAPI }).api;
                if (bridge) break;
            }
            if (bridge) {
                console.info('[renderer] Preload bridge detected after polling', Object.keys(bridge));
            }
        }

        if (!bridge) {
            if (isElectron) {
                console.error('[renderer] Preload bridge could not be reached after polling.');
            } else {
                console.info('[renderer] Running outside Electron; preload bridge intentionally unavailable.');
            }
            setStatus('Preload-скрипт недоступен', 'error');
            return;
        }
    }
    console.info('[renderer] Preload bridge ready for use');
    
    // Initialize stream mode elements
    streamModeContainer = document.getElementById('streamResultsSection');
    streamResults = document.getElementById('streamResultsTextarea') as HTMLTextAreaElement | null;
    btnSendStream = document.getElementById('btnSendStreamText') as HTMLButtonElement | null;
    const btnScreenshot = document.getElementById('btnScreenshot') as HTMLButtonElement | null;

    googleStreamingService.onTranscript((text: string) => {
        if (!streamResults) return;
        streamResults.value += `${text} `;
        streamResults.scrollTop = streamResults.scrollHeight;
        if (btnSendStream) {
            btnSendStream.disabled = !(streamResults.value.trim().length > 0) || state.isProcessing;
        }
    });

    googleStreamingService.onError((error: string) => {
        console.error('Google streaming error:', error);
        setStatus(`Google error: ${error}`, 'error');
    });

    // Enable/disable send button based on textarea content
    try {
        if (streamResults && btnSendStream) {
            const updateStreamSendState = () => {
                btnSendStream!.disabled = !(streamResults!.value.trim().length > 0) || state.isProcessing;
            };
            streamResults.addEventListener('input', updateStreamSendState);
            updateStreamSendState();
        }
    } catch {}

    if (btnScreenshot) {
        btnScreenshot.addEventListener('click', async () => {
            if (state.isProcessing) return;
            const access = checkHolderAccess();
            if (access === 'holder') {
                await handleScreenshot();
            } else if (access === 'non-holder') {
                showHolderOnlyModal();
            } else {
                setStatus('Checking holder status...', 'sending');
                setTimeout(() => setStatus('Ready', 'ready'), 1500);
            }
        });
    }
    
    // Load logos
    const loadLogo = (logoElement: HTMLImageElement) => {
        if (logoElement) {
            try {
                // Try to load logo from brand folder
                logoElement.src = '../../brand/logo_white.png';
                logoElement.onerror = () => {
                    // Fallback: try alternative path
                    logoElement.src = 'brand/logo_white.png';
                    logoElement.onerror = () => {
                        // Final fallback: hide logo if not found
                        logoElement.style.display = 'none';
                    };
                };
            } catch (error) {
                console.warn('Could not load logo:', error);
                logoElement.style.display = 'none';
            }
        }
    };

    // Load main logo
    const mainLogoElement = document.getElementById('main-logo') as HTMLImageElement;
    const logoContainer = document.querySelector('.logo-container') as HTMLElement;
    loadLogo(mainLogoElement);

    // Start logo animation sequence
    if (mainLogoElement && logoContainer) {
        startLogoAnimation(mainLogoElement, logoContainer);
    }

    // Load header logo
    const headerLogoElement = document.getElementById('header-logo') as HTMLImageElement;
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
            try {
                if (shouldRecord) {
                    await startAudioRecording();
                    await updateStreamModeVisibility();
                } else {
                    await stopAudioRecording();
                    await googleStreamingService.stop();
                }
            } catch (error) {
                console.error('Record toggle failed', error);
                setStatus('Error starting recording', 'error');
            }
        },
        onDurationChange: (sec) => {
            handleAskWindow(sec);
        },
        onTextSend: (text) => {
            handleTextSend(text);
        },
    });

    // Toggle input button
    try {
        await updateToggleButtonLabel();
        const btn = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
        if (btn) {
            btn.addEventListener('click', async () => {
                try {
                    let settingsSnapshot;
                    try {
                        settingsSnapshot = settingsStore.get();
                    } catch {
                        settingsSnapshot = await settingsStore.load();
                    }
                    const cur = (settingsSnapshot.audioInputType || 'microphone') as 'microphone' | 'system';
                    const next: 'microphone' | 'system' = cur === 'microphone' ? 'system' : 'microphone';
                    let preStream: MediaStream | undefined;
                    if (state.isRecording && next === 'system') {
                        try {
                            // Hint OS to prepare loopback before capture (do not await)
                            try { (window as any).api?.loopback?.enable?.(); } catch {}
                            const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                            const audioTracks = disp.getAudioTracks();
                            const sysTrack = audioTracks[0];
                            if (sysTrack) {
                                // Keep original system track alive for future hotkey reuse
                                registerPersistentSystemTrack(sysTrack);
                                // Use a clone for the active recorder, so stopping recording won't kill the persisted one
                                const clone = sysTrack.clone();
                                preStream = new MediaStream([clone]);
                            } else {
                                preStream = new MediaStream(audioTracks);
                            }
                            disp.getVideoTracks().forEach((t) => t.stop());
                        } catch (err) {
                            console.error('System audio capture cancelled/failed', err);
                            setStatus('System audio requires a user selection', 'error');
                            return;
                        }
                    }
                    const result = await switchAudioInput(next, { preStream, gesture: true });
                    if (result.success) {
                        settingsStore.patch({ audioInputType: next });
                    }
                } catch (e) {
                    console.error('Toggle input failed', e);
                }
            });
        }
    } catch {}

    // Проставим подписи хоткеев на кнопках
    try {
        const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
        if (durationsEl && durationHotkeys) {
            const buttons = durationsEl.querySelectorAll('button');
            buttons.forEach((btn) => {
                const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                const key = (durationHotkeys as any)[sec];
                if (key) {
                    // remove old hint if exists
                    const old = btn.querySelector('.hk');
                    if (old) old.remove();
                    const label = document.createElement('span');
                    label.className = 'hk text-xs text-gray-400 font-extralight';
                    label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                    btn.appendChild(label);
                }
            });
        }
    } catch {}

    // Подписка на глобальные хоткеи
    window.api.hotkeys.onDuration((_e: unknown, payload: { sec: number }) => {
        try {
            handleAskWindow(payload.sec);
        } catch {}
    });

    // Хоткей переключения входа
    try {
        window.api.hotkeys.onToggleInput(async () => {
            try {
                let settingsSnapshot;
                try {
                    settingsSnapshot = settingsStore.get();
                } catch {
                    settingsSnapshot = await settingsStore.load();
                }
                const cur = (settingsSnapshot.audioInputType || 'microphone') as 'microphone' | 'system';
                const next: 'microphone' | 'system' = cur === 'microphone' ? 'system' : 'microphone';
                let preStream: MediaStream | undefined;
                // If we have a persisted system track from a previous user gesture, reuse it without prompting
                if (state.isRecording && next === 'system') {
                    const persistedClone = clonePersistentSystemTrack();
                    if (persistedClone) {
                        try {
                            // Enable loopback in background
                            try { (window as any).api?.loopback?.enable?.(); } catch {}
                            preStream = new MediaStream([persistedClone]);
                        } catch {}
                    }
                }
                // Fallback: try Electron desktopCapturer-based capture without gesture
                if (state.isRecording && next === 'system' && !preStream) {
                    try {
                        const sourceId = await (window as any).api?.media?.getPrimaryDisplaySourceId?.();
                        const gumConstraints: any = sourceId ? {
                            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                        } : {
                            audio: { mandatory: { chromeMediaSource: 'desktop' } },
                            video: { mandatory: { chromeMediaSource: 'desktop' } },
                        };
                        const stream = await navigator.mediaDevices.getUserMedia(gumConstraints);
                        const audioTracks = stream.getAudioTracks();
                        const sysTrack = audioTracks[0] || null;
                        if (sysTrack) {
                            registerPersistentSystemTrack(sysTrack);
                            const clone = sysTrack.clone();
                            preStream = new MediaStream([clone]);
                        }
                        // Stop video tracks immediately
                        try { stream.getVideoTracks().forEach(t => t.stop()); } catch {}
                    } catch (e) {
                        console.error('desktopCapturer getUserMedia fallback failed', e);
                    }
                }
                const result = await switchAudioInput(next, { preStream, gesture: false });
                if (result.success) {
                    settingsStore.patch({ audioInputType: next });
                }
            } catch (e) {
                console.error('Toggle input via hotkey failed', e);
            }
        });
    } catch {}

    btnStop = document.getElementById('btnStopStream') as HTMLButtonElement | null;
    if (btnStop) {
        btnStop.addEventListener('click', async () => {
            if (currentRequestId) {
                logger.info('ui', 'Stop button clicked', { requestId: currentRequestId });
                try {
                    await window.api.assistant.stopStream({ requestId: currentRequestId });
                } catch (e) {
                    console.error('Stop stream error', e);
                } finally {
                    currentRequestId = null;
                    removeStreamHandlers();
                    setStatus('Ready', 'ready');
                    setProcessing(false);
                    hideStopButton();
                    updateButtonsState();
                }
                return;
            }

            if (screenshotCancelToken && !screenshotCancelToken.cancelled) {
                logger.info('ui', 'Screenshot stop button clicked');
                screenshotCancelToken.cancelled = true;
                setStatus('Cancelled', 'ready');
                setProcessing(false);
                hideStopButton();
                updateButtonsState();
                return;
            }

            hideStopButton();
        });
    }

    // Stream mode event handlers
    if (btnSendStream) {
        btnSendStream.addEventListener('click', async () => {
            await handleStreamTextSend();
        });
    }

    // Stream send hotkey (dynamic)
    try {
        let settings;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }
        currentStreamSendHotkey = settings.streamSendHotkey || '~';
    } catch (error) {
        console.error('Error reading initial stream send hotkey:', error);
    }

    // Helper to make tilde/backquote robust across layouts
    function normalizeConfigHotkeyKey(k: string): string {
        const lower = String(k || '').toLowerCase();
        if (lower === '~' || lower === '`') return 'backquote';
        return lower;
    }
    function eventKeyId(e: KeyboardEvent): string {
        const code = (e.code || '');
        const key = String(e.key || '').toLowerCase();
        if (code === 'Backquote') return 'backquote';
        if (key === 'dead' && code === 'Backquote') return 'backquote';
        return key;
    }

    // Single keydown listener that uses a mutable hotkey value
    document.addEventListener('keydown', async (e) => {
        try {
            const pressed = eventKeyId(e);
            const targetKey = normalizeConfigHotkeyKey(currentStreamSendHotkey || '~');
            if (e.ctrlKey && pressed === targetKey && isStreamMode) {
                e.preventDefault();
                await handleStreamTextSend();
            }
        } catch {}
    });

    // React to settings changes dispatched from SettingsPanel
    window.addEventListener('xexamai:settings-changed' as any, async (ev: any) => {
        try {
            const { key, value } = ev?.detail || {};
            switch (key) {
                case 'streamSendHotkey': {
                    currentStreamSendHotkey = value || '~';
                    break;
                }
                case 'streamMode': {
                    settingsStore.patch({ streamMode: value });
                    await updateStreamModeVisibility();
                    break;
                }
                case 'audioInputType': {
                    const normalized = value === 'system' ? 'system' : 'microphone';
                    settingsStore.patch({ audioInputType: normalized });
                    setAudioInputType(normalized);
                    await updateToggleButtonLabel(normalized);
                    break;
                }
                case 'durations': {
                    const nextDurations: number[] = Array.isArray(value) ? value : [];
                    settingsStore.patch({ durations: nextDurations });
                    updateDurations(nextDurations, (sec) => {
                        handleAskWindow(sec);
                    });
                    try {
                        (state as any).durationSec = Math.max(...nextDurations);
                    } catch {}
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
                        if (hotkey) {
                            const label = document.createElement('span');
                            label.className = 'hk text-xs text-gray-400 font-extralight';
                            label.textContent = `Ctrl-${String(hotkey).toUpperCase()}`;
                            btn.appendChild(label);
                        }
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

    // Initialize stream mode visibility after all elements are ready
    await updateStreamModeVisibility();

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
        
        // Убираем фокус с кнопки Close при загрузке, чтобы не показывалась подсказка
        closeBtn.blur();
        
        // Дополнительная защита: убираем фокус при получении фокуса
        closeBtn.addEventListener('focus', () => {
            closeBtn.blur();
        });
    }
}

function startLogoAnimation(logoElement: HTMLImageElement, container: HTMLElement) {
    // Wait for logo to load, then start animation
    const startAnimation = () => {
        // Phase 1: Fade in (0.1 seconds)
        setTimeout(() => {
            logoElement.classList.add('logo-fade-in');
        }, 100);

        // Phase 2: Transition to final state (after 2.5 seconds total)
        setTimeout(() => {
            logoElement.classList.remove('logo-fade-in');
            logoElement.classList.add('logo-final-state');
            container.classList.add('final-state');
        }, 2500);
    };

    // Check if logo is already loaded
    if (logoElement.complete && logoElement.naturalHeight !== 0) {
        startAnimation();
    } else {
        logoElement.addEventListener('load', startAnimation);
        // Fallback: start animation even if load event doesn't fire
        setTimeout(startAnimation, 1000);
    }
}

// Font size management functions
function getCurrentFontSize(): number {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE;
}

function setFontSize(size: number, showNotification: boolean = true): void {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
    localStorage.setItem(FONT_SIZE_KEY, clampedSize.toString());
    document.documentElement.style.setProperty('--answer-font-size', `${clampedSize}px`);
    
    // Show temporary notification only if requested
    if (showNotification) {
        showFontSizeNotification(clampedSize);
    }
}

function showFontSizeNotification(size: number): void {
    // Remove existing notification if any
    const existing = document.getElementById('font-size-notification');
    if (existing) {
        existing.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.id = 'font-size-notification';
    notification.textContent = `Font size: ${size}px`;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 10000;
        pointer-events: none;
        transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Fade out after 2 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 2000);
}

function initializeFontSize(): void {
    const currentSize = getCurrentFontSize();
    setFontSize(currentSize, false); // Don't show notification on initialization
}

function handleFontSizeWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;
    
    event.preventDefault();
    
    const currentSize = getCurrentFontSize();
    const delta = event.deltaY > 0 ? -1 : 1;
    const newSize = currentSize + delta;
    
    setFontSize(newSize, true); // Show notification when user changes font size
}
function showHolderOnlyModal(): void {
    const existing = document.getElementById('holder-only-modal') as HTMLDivElement | null;
    if (existing) {
        existing.classList.add('holder-overlay--visible');
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'holder-only-modal';
    overlay.className = 'holder-overlay holder-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'holder-modal card fc gap-3';

    const title = document.createElement('h3');
    title.textContent = 'Screen processing is holder-only';
    title.className = 'text-lg font-semibold';

    const message = document.createElement('p');
    message.className = 'text-sm text-gray-300';
    message.innerHTML = `This feature is available only to token holders <strong style="word-break: break-word;">D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG</strong>.<br/>All links and instructions are available on our website: <a href="https://xldev.ru/en/xexamai" target="_blank" rel="noreferrer">https://xldev.ru/en/xexamai</a>.`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Got it';
    closeBtn.addEventListener('click', () => {
        overlay.classList.remove('holder-overlay--visible');
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            overlay.classList.remove('holder-overlay--visible');
        }
    });

    modal.appendChild(title);
    modal.appendChild(message);
    modal.appendChild(closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.classList.add('holder-overlay--visible');
    });
}

type HolderAccess = 'holder' | 'non-holder' | 'pending';

function checkHolderAccess(): HolderAccess {
    const snapshot = getHolderState();
    if (snapshot.loading && !snapshot.status) {
        return 'pending';
    }
    const status = snapshot.status;
    if (!status) {
        return 'non-holder';
    }
    if (status.checkingBalance) {
        return 'pending';
    }
    const hasToken = status.hasToken ?? false;
    const authorized = status.isAuthorized ?? false;
    return hasToken || authorized ? 'holder' : 'non-holder';
}
