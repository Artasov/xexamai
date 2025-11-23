import {invoke} from '@tauri-apps/api/core';
import {
    getCurrentWindow,
    LogicalPosition,
    LogicalSize,
} from '@tauri-apps/api/window';
import {
    AssistantAPI,
    AuthDeepLinkPayload,
    FastWhisperStatus,
    ScreenProcessRequest,
    ScreenProcessResponse,
} from '@shared/ipc';
import {listen, UnlistenFn} from '@tauri-apps/api/event';
import {
    assistantProcessAudio,
    assistantProcessAudioStream,
    assistantTranscribeOnly,
    assistantAskChat,
    assistantStopStream,
    assistantOnStreamTranscript,
    assistantOnStreamDelta,
    assistantOnStreamDone,
    assistantOnStreamError,
    assistantOffStreamTranscript,
    assistantOffStreamDelta,
    assistantOffStreamDone,
    assistantOffStreamError,
    processScreenImage as assistantProcessScreenImage,
} from '../services/nativeAssistant';

const currentWindow = getCurrentWindow();

async function patchSettings(payload: Record<string, unknown>) {
    await invoke('config_update', { payload });
}

const settingsApi: AssistantAPI['settings'] = {
    get: () => invoke('config_get'),
    setOpenaiApiKey: async (key: string) => {
        await patchSettings({ openaiApiKey: key });
    },
    setWindowOpacity: async (opacity: number) => {
        await patchSettings({ windowOpacity: opacity });
        try {
            const anyWindow = currentWindow as unknown as { setOpacity?: (value: number) => Promise<void> };
            if (typeof anyWindow.setOpacity === 'function') {
                await anyWindow.setOpacity(opacity / 100);
            }
        } catch {}
    },
    setAlwaysOnTop: async (alwaysOnTop: boolean) => {
        await patchSettings({ alwaysOnTop });
        try {
            await currentWindow.setAlwaysOnTop(alwaysOnTop);
        } catch {}
    },
    setHideApp: async (hideApp: boolean) => {
        await patchSettings({ hideApp });
    },
    setWindowSize: async (size) => {
        const width = Math.max(size.width, 400);
        const height = Math.max(size.height, 500);
        await patchSettings({ windowWidth: width, windowHeight: height });
        try {
            await currentWindow.setSize(new LogicalSize(width, height));
        } catch {}
    },
    setWindowScale: async (scale) => {
        await patchSettings({ windowScale: scale });
    },
    setDurations: async (durations) => {
        await patchSettings({ durations });
    },
    setDurationHotkeys: async (map) => {
        await patchSettings({ durationHotkeys: map });
    },
    setAudioInputDevice: async (deviceId) => {
        await patchSettings({ audioInputDeviceId: deviceId });
    },
    setToggleInputHotkey: async (key) => {
        await patchSettings({ toggleInputHotkey: key });
    },
    setAudioInputType: async (type) => {
        await patchSettings({ audioInputType: type });
    },
    setTranscriptionModel: async (model) => {
        await patchSettings({ transcriptionModel: model });
    },
    setTranscriptionPrompt: async (prompt) => {
        await patchSettings({ transcriptionPrompt: prompt });
    },
    setLlmModel: async (model) => {
        await patchSettings({ llmModel: model });
    },
    setLlmPrompt: async (prompt) => {
        await patchSettings({ llmPrompt: prompt });
    },
    setTranscriptionMode: async (mode) => {
        await patchSettings({ transcriptionMode: mode });
    },
    setLlmHost: async (host) => {
        await patchSettings({ llmHost: host });
    },
    setLocalWhisperModel: async (model) => {
        await patchSettings({ localWhisperModel: model });
    },
    setLocalDevice: async (device) => {
        await patchSettings({ localDevice: device });
    },
    setApiSttTimeoutMs: async (timeoutMs) => {
        await patchSettings({ apiSttTimeoutMs: timeoutMs });
    },
    setApiLlmTimeoutMs: async (timeoutMs) => {
        await patchSettings({ apiLlmTimeoutMs: timeoutMs });
    },
    getAudioDevices: async () => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices
                .filter((device) => device.kind === 'audioinput')
                .map((device) => ({
                    deviceId: device.deviceId,
                    label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
                    kind: 'audioinput' as const,
                }));
        } catch {
            return [];
        }
    },
    openConfigFolder: async () => {
        await invoke('open_config_folder');
    },
    setScreenProcessingModel: async (provider) => {
        await patchSettings({ screenProcessingModel: provider });
    },
    setScreenProcessingPrompt: async (prompt) => {
        await patchSettings({ screenProcessingPrompt: prompt });
    },
    setScreenProcessingTimeoutMs: async (timeoutMs) => {
        await patchSettings({ screenProcessingTimeoutMs: timeoutMs });
    },
    setWelcomeModalDismissed: async (dismissed) => {
        await patchSettings({ welcomeModalDismissed: dismissed });
    },
    setGoogleApiKey: async (key) => {
        await patchSettings({ googleApiKey: key });
    },
    setStreamMode: async (mode) => {
        await patchSettings({ streamMode: mode });
    },
    setStreamSendHotkey: async (key) => {
        await patchSettings({ streamSendHotkey: key });
    },
};

const windowApi: AssistantAPI['window'] = {
    minimize: () => currentWindow.minimize(),
    close: () => currentWindow.close(),
    async getBounds() {
        const [position, size] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.outerSize(),
        ]);
        return {
            x: position.x as number,
            y: position.y as number,
            width: size.width as number,
            height: size.height as number,
        };
    },
    async setBounds(bounds) {
        await currentWindow.setPosition(new LogicalPosition(bounds.x, bounds.y));
        await currentWindow.setSize(new LogicalSize(bounds.width, bounds.height));
    },
};

const unimplemented = (feature: string) => {
    return () => {
        throw new Error(`${feature} is not implemented in Tauri bridge yet`);
    };
};

const assistantApi: AssistantAPI['assistant'] = {
    processAudio: assistantProcessAudio,
    processAudioStream: assistantProcessAudioStream,
    transcribeOnly: assistantTranscribeOnly,
    askChat: assistantAskChat,
    stopStream: assistantStopStream,
    onStreamTranscript: (cb) => assistantOnStreamTranscript(cb),
    onStreamDelta: (cb) => assistantOnStreamDelta(cb),
    onStreamDone: (cb) => assistantOnStreamDone(cb),
    onStreamError: (cb) => assistantOnStreamError(cb),
    offStreamTranscript: () => assistantOffStreamTranscript(),
    offStreamDelta: () => assistantOffStreamDelta(),
    offStreamDone: () => assistantOffStreamDone(),
    offStreamError: () => assistantOffStreamError(),
};

let durationUnlisten: UnlistenFn | null = null;
let toggleUnlisten: UnlistenFn | null = null;

const hotkeysApi: AssistantAPI['hotkeys'] = {
    onDuration: (cb) => {
        void (async () => {
            if (durationUnlisten) {
                await durationUnlisten();
                durationUnlisten = null;
            }
            durationUnlisten = await listen<{ sec: number }>('hotkeys:duration', (event) => {
                cb(event, event.payload);
            });
        })();
    },
    offDuration: () => {
        if (durationUnlisten) {
            void durationUnlisten();
            durationUnlisten = null;
        }
    },
    onToggleInput: (cb) => {
        void (async () => {
            if (toggleUnlisten) {
                await toggleUnlisten();
                toggleUnlisten = null;
            }
            toggleUnlisten = await listen('hotkeys:toggle-input', () => {
                cb();
            });
        })();
    },
    offToggleInput: () => {
        if (toggleUnlisten) {
            void toggleUnlisten();
            toggleUnlisten = null;
        }
    },
};

const loopbackApi: AssistantAPI['loopback'] = {
    enable: async () => ({ success: false, error: 'Not implemented' }),
    disable: async () => ({ success: false, error: 'Not implemented' }),
};

const screenApi: AssistantAPI['screen'] = {
    capture: async () => {
        return captureScreenFrame();
    },
    process: async (payload: ScreenProcessRequest): Promise<ScreenProcessResponse> => {
        return assistantProcessScreenImage(payload);
    },
};

const authListeners = new Set<(payload: AuthDeepLinkPayload) => void>();
let authUnlisten: UnlistenFn | null = null;

const googleApi: AssistantAPI['google'] = {
    startLive: async () => {
        throw new Error('Google live is not implemented');
    },
    sendAudioChunk: () => {
        throw new Error('Google live is not implemented');
    },
    stopLive: () => {},
    onMessage: () => {},
    onError: () => {},
};

const authApi: AssistantAPI['auth'] = {
    startOAuth: (provider) => invoke('auth_start_oauth', { provider }),
    onOAuthPayload: (cb) => {
        authListeners.add(cb);
        ensureAuthSubscription();
        return () => {
            authListeners.delete(cb);
            if (!authListeners.size && authUnlisten) {
                void authUnlisten();
                authUnlisten = null;
            }
        };
    },
    consumePendingOAuthPayloads: async () => {
        const payloads = await invoke<AuthDeepLinkPayload[]>('auth_consume_pending');
        payloads.forEach(dispatchAuthPayload);
        return payloads;
    },
};

const mediaApi: AssistantAPI['media'] = {
    getPrimaryDisplaySourceId: async () => null,
};

const localSpeechApi: AssistantAPI['localSpeech'] = {
    getStatus: () => invoke<FastWhisperStatus>('local_speech_get_status'),
    checkHealth: () => invoke<FastWhisperStatus>('local_speech_check_health'),
    install: () => invoke<FastWhisperStatus>('local_speech_install'),
    start: () => invoke<FastWhisperStatus>('local_speech_start'),
    restart: () => invoke<FastWhisperStatus>('local_speech_restart'),
    reinstall: () => invoke<FastWhisperStatus>('local_speech_reinstall'),
    stop: () => invoke<FastWhisperStatus>('local_speech_stop'),
    checkModelDownloaded: (model: string) =>
        invoke<boolean>('local_speech_check_model_downloaded', { model }),
};

const ollamaApi: AssistantAPI['ollama'] = {
    checkInstalled: () => invoke<boolean>('ollama_check_installed'),
    listModels: () => invoke<string[]>('ollama_list_models'),
    pullModel: (model: string) => invoke('ollama_pull_model', { model }),
    warmupModel: (model: string) => invoke('ollama_warmup_model', { model }),
};

const api: AssistantAPI = {
    assistant: assistantApi,
    hotkeys: hotkeysApi,
    settings: settingsApi,
    window: windowApi,
    loopback: loopbackApi,
    screen: screenApi,
    google: googleApi,
    auth: authApi,
    media: mediaApi,
    localSpeech: localSpeechApi,
    ollama: ollamaApi,
    log: async (entry) => {
        console.info(`[${entry.category}] ${entry.message}`, entry.data ?? {});
    },
};

declare global {
    interface Window {
        api: AssistantAPI;
    }
}

if (typeof window !== 'undefined') {
    (window as any).api = api;
}

async function ensureAuthSubscription() {
    if (authUnlisten || !authListeners.size) {
        return;
    }
    authUnlisten = await listen<AuthDeepLinkPayload>('auth:deep-link', (event) => {
        dispatchAuthPayload(event.payload);
    });
}

function dispatchAuthPayload(payload: AuthDeepLinkPayload) {
    authListeners.forEach((listener) => {
        try {
            listener(payload);
        } catch (error) {
            console.error('[authBridge] listener failed', error);
        }
    });
}

async function captureScreenFrame(): Promise<{ base64: string; width: number; height: number; mime: string }> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            frameRate: 1,
        },
        audio: false,
    });
    try {
        const video = document.createElement('video');
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
            video.onloadedmetadata = () => resolve();
        });
        await video.play().catch(() => {});
        const width = video.videoWidth || 1920;
        const height = video.videoHeight || 1080;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Unable to capture screen frame');
        }
        ctx.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1] || '';
        return {
            base64,
            width,
            height,
            mime: 'image/png',
        };
    } finally {
        stream.getTracks().forEach((t) => t.stop());
    }
}
