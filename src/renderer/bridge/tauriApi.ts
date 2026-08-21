import {Channel} from '@tauri-apps/api/core';
import {invokeNative as invoke} from './nativeInvoke';
import {getCurrentWindow, LogicalPosition, LogicalSize,} from '@tauri-apps/api/window';
import {
    AssistantAPI,
    AuthDeepLinkPayload,
    AuthMethodsResponse,
    DiagnosticsSnapshot,
    FastWhisperStatus,
    ScreenProcessRequest,
    ScreenProcessResponse,
} from '@shared/ipc';
import {listen, UnlistenFn} from '@tauri-apps/api/event';
import {AsyncListenerSlot} from './asyncListenerSlot';
import {GOOGLE_LIVE_ENDPOINT, GOOGLE_LIVE_MODEL} from '../services/googleLiveContract';
import type {OllamaStreamEvent} from '@shared/generated/NativeBindings';
import {
    assistantAskChat,
    assistantOffStreamDelta,
    assistantOffStreamDone,
    assistantOffStreamError,
    assistantOffStreamTranscript,
    assistantOnStreamDelta,
    assistantOnStreamDone,
    assistantOnStreamError,
    assistantOnStreamTranscript,
    assistantStopStream,
    assistantTranscribeOnly,
    cancelScreenProcessing,
    processScreenImage as assistantProcessScreenImage,
} from '../services/nativeAssistant';

const currentWindow = getCurrentWindow();

async function patchSettings(payload: Record<string, unknown>) {
    await invoke('config_update', {payload});
}

const makeSettingSetter =
    <T>(key: keyof AssistantAPI['settings'] extends never ? string : string) =>
        async (value: T) => {
            await patchSettings({[key]: value});
        };

const settingsApi: AssistantAPI['settings'] = {
    get: () => invoke('config_get'),
    setOpenaiApiKey: makeSettingSetter<string>('openaiApiKey'),
    setWindowOpacity: async (opacity: number) => {
        await patchSettings({windowOpacity: opacity});
        // Opacity is applied in Rust via DWM
    },
    setAlwaysOnTop: async (alwaysOnTop: boolean) => {
        await patchSettings({alwaysOnTop});
        try {
            await currentWindow.setAlwaysOnTop(alwaysOnTop);
        } catch {
        }
    },
    setHideApp: async (hideApp: boolean) => {
        await patchSettings({hideApp});
        // Screen recording exclusion is applied in Rust via SetWindowDisplayAffinity
    },
    setWindowSize: async (size) => {
        const width = Math.max(size.width, 400);
        const height = Math.max(size.height, 500);
        await patchSettings({windowWidth: width, windowHeight: height});
        try {
            await currentWindow.setSize(new LogicalSize(width, height));
        } catch {
        }
    },
    setWindowScale: async (scale) => {
        await patchSettings({windowScale: scale});
        // Scale is applied in Rust by resizing the window and adjusting CSS zoom
    },
    setDurations: makeSettingSetter('durations'),
    setDurationHotkeys: makeSettingSetter('durationHotkeys'),
    setAudioInputDevice: makeSettingSetter('audioInputDeviceId'),
    setToggleInputHotkey: makeSettingSetter('toggleInputHotkey'),
    setAudioInputType: makeSettingSetter('audioInputType'),
    setTranscriptionModel: makeSettingSetter('transcriptionModel'),
    setTranscriptionPrompt: makeSettingSetter('transcriptionPrompt'),
    setLlmModel: async (model, host) => {
        const payload: Record<string, unknown> = {llmModel: model};
        if (host === 'local') {
            payload.localLlmModel = model;
        } else if (host === 'api') {
            payload.apiLlmModel = model;
        }
        await patchSettings(payload);
    },
    setLlmPrompt: makeSettingSetter('llmPrompt'),
    setTranscriptionMode: makeSettingSetter('transcriptionMode'),
    setLlmHost: makeSettingSetter('llmHost'),
    setLocalWhisperModel: makeSettingSetter('localWhisperModel'),
    setLocalDevice: makeSettingSetter('localDevice'),
    setApiSttTimeoutMs: makeSettingSetter('apiSttTimeoutMs'),
    setApiLlmTimeoutMs: makeSettingSetter('apiLlmTimeoutMs'),
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
    openLogsFolder: async () => {
        await invoke('open_app_logs_folder');
    },
    getLogPath: () => invoke('app_log_path'),
    setScreenProcessingModel: makeSettingSetter('screenProcessingModel'),
    setScreenProcessingPrompt: makeSettingSetter('screenProcessingPrompt'),
    setScreenProcessingTimeoutMs: makeSettingSetter('screenProcessingTimeoutMs'),
    setWelcomeModalDismissed: makeSettingSetter('welcomeModalDismissed'),
    setGoogleApiKey: makeSettingSetter('googleApiKey'),
    setStreamSendHotkey: makeSettingSetter<string>('streamSendHotkey'),
    setBackendDomain: makeSettingSetter('backendDomain'),
    setDiagnosticsEnabled: makeSettingSetter<boolean>('diagnosticsEnabled'),
};

const audioApi: AssistantAPI['audio'] = {
    listDevices: () => invoke('audio_list_devices'),
    startCapture: (source, deviceId, onChunk) => {
        const channel = new Channel<ArrayBuffer | Uint8Array>();
        channel.onmessage = onChunk;
        return invoke('audio_start_capture', {source, deviceId, onChunk: channel});
    },
    stopCapture: () => invoke('audio_stop_capture'),
};

const diagnosticsApi: AssistantAPI['diagnostics'] = {
    snapshot: () => invoke('diagnostics_snapshot'),
};

const windowApi: AssistantAPI['window'] = {
    minimize: () => currentWindow.minimize(),
    close: () => currentWindow.close(),
    async getBounds() {
        const [position, size, scaleFactor] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.outerSize(),
            currentWindow.scaleFactor(),
        ]);
        const logicalPosition = position.toLogical(scaleFactor);
        const logicalSize = size.toLogical(scaleFactor);
        return {
            x: logicalPosition.x,
            y: logicalPosition.y,
            width: logicalSize.width,
            height: logicalSize.height,
        };
    },
    async setBounds(bounds) {
        await currentWindow.setPosition(new LogicalPosition(bounds.x, bounds.y));
        await currentWindow.setSize(new LogicalSize(bounds.width, bounds.height));
    },
};

const assistantApi: AssistantAPI['assistant'] = {
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

type DurationHotkeyEvent = {event: unknown; payload: {sec: number}};
const durationListener = new AsyncListenerSlot<DurationHotkeyEvent>();
const toggleListener = new AsyncListenerSlot<void>();

const hotkeysApi: AssistantAPI['hotkeys'] = {
    onDuration: (cb) => {
        durationListener.replace(
            (emit) => listen<{sec: number}>('hotkeys:duration', (event) => emit({event, payload: event.payload})),
            ({event, payload}) => cb(event, payload),
        );
    },
    offDuration: () => durationListener.clear(),
    onToggleInput: (cb) => {
        toggleListener.replace(
            (emit) => listen('hotkeys:toggle-input', () => emit()),
            () => cb(),
        );
    },
    offToggleInput: () => toggleListener.clear(),
};

const loopbackApi: AssistantAPI['loopback'] = {
    enable: async () => ({success: false, error: 'Not implemented'}),
    disable: async () => ({success: false, error: 'Not implemented'}),
};

const screenApi: AssistantAPI['screen'] = {
    capture: async () => {
        return captureScreenFrame();
    },
    process: async (payload: ScreenProcessRequest): Promise<ScreenProcessResponse> => {
        return assistantProcessScreenImage(payload);
    },
    cancel: (requestId: string) => cancelScreenProcessing(requestId),
};

const authListeners = new Set<(payload: AuthDeepLinkPayload) => void>();
let authUnlisten: UnlistenFn | null = null;
let authListenPromise: Promise<void> | null = null;

const googleLiveMessageListeners = new Set<(message: any) => void>();
const googleLiveErrorListeners = new Set<(error: string) => void>();
let googleLiveSocket: WebSocket | null = null;
let googleLiveReady = false;

const notifyGoogleLiveError = (message: string) => {
    for (const listener of googleLiveErrorListeners) {
        try {
            listener(message);
        } catch {
        }
    }
};

const closeGoogleLiveSocket = (sendAudioEnd = true) => {
    const socket = googleLiveSocket;
    googleLiveSocket = null;
    googleLiveReady = false;
    if (!socket) return;
    try {
        if (sendAudioEnd && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}));
        }
        socket.close(1000, 'client stop');
    } catch {
    }
};

const stopGoogleLiveGracefully = async () => {
    const socket = googleLiveSocket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}));
            // Keep message listeners alive briefly so the final input
            // transcription/turn-complete frame is not discarded.
            await new Promise((resolve) => window.setTimeout(resolve, 400));
        } catch {
        }
    }
    if (googleLiveSocket === socket) closeGoogleLiveSocket(false);
    else {
        try {
            socket.close(1000, 'client stop');
        } catch {
        }
    }
};

const googleApi: AssistantAPI['google'] = {
    getLiveCapability: async () => {
        if (typeof WebSocket === 'undefined') {
            return {supported: false, configured: false, reason: 'WebSocket is unavailable in this WebView.', model: GOOGLE_LIVE_MODEL};
        }
        try {
            return await invoke('google_live_capability');
        } catch (error) {
            return {
                supported: false,
                configured: false,
                reason: error instanceof Error ? error.message : String(error),
                model: GOOGLE_LIVE_MODEL,
            };
        }
    },
    startLive: async (options) => {
        closeGoogleLiveSocket();
        if (typeof WebSocket === 'undefined') {
            throw new Error('Google Live is not supported by this WebView.');
        }

        // The long-lived Google key never crosses IPC. Rust provisions a
        // single-use, model-constrained ephemeral token for this connection.
        const auth = await invoke('google_live_create_token');
        if (!auth?.token) throw new Error('Google Live could not create a temporary session token.');

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const socket = new WebSocket(`${GOOGLE_LIVE_ENDPOINT}?access_token=${encodeURIComponent(auth.token)}`);
            googleLiveSocket = socket;
            const timeout = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                closeGoogleLiveSocket();
                reject(new Error('Google Live connection timed out.'));
            }, 10_000);

            const fail = (message: string) => {
                notifyGoogleLiveError(message);
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                reject(new Error(message));
            };

            socket.onopen = () => {
                try {
                    // Gemini 3.1 Flash Live requires an AUDIO response modality. Input
                    // transcription is delivered independently and is what the UI uses.
                    socket.send(JSON.stringify({
                        setup: {
                            model: `models/${auth.model || GOOGLE_LIVE_MODEL}`,
                            // The wire-level BidiGenerateContentSetup carries
                            // response modalities inside generationConfig. The
                            // higher-level SDK's LiveConnectConfig flattens this
                            // field, but that shape cannot be sent verbatim.
                            generationConfig: {
                                responseModalities: ['AUDIO'],
                            },
                            inputAudioTranscription: options.transcribeInput === false ? undefined : {},
                            outputAudioTranscription: options.transcribeOutput ? {} : undefined,
                        },
                    }));
                } catch (error) {
                    fail(error instanceof Error ? error.message : String(error));
                }
            };

            socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(String(event.data || '{}'));
                    if (message?.setupComplete && !settled) {
                        settled = true;
                        googleLiveReady = true;
                        window.clearTimeout(timeout);
                        resolve();
                    }
                    for (const listener of googleLiveMessageListeners) {
                        try {
                            listener(message);
                        } catch {
                        }
                    }
                } catch {
                    // Ignore malformed vendor frames while keeping the session alive.
                }
            };
            socket.onerror = () => fail('Google Live connection failed. Check the API key and network access.');
            socket.onclose = (event) => {
                const wasCurrent = googleLiveSocket === socket;
                if (wasCurrent) {
                    googleLiveSocket = null;
                    googleLiveReady = false;
                }
                if (!settled) {
                    fail(event.reason || `Google Live closed during setup (${event.code}).`);
                } else if (event.code !== 1000 && wasCurrent) {
                    notifyGoogleLiveError(event.reason || `Google Live connection closed (${event.code}).`);
                }
            };
        });
    },
    sendAudioChunk: ({data, mime}) => {
        const socket = googleLiveSocket;
        if (!socket || socket.readyState !== WebSocket.OPEN || !googleLiveReady) {
            return;
        }
        socket.send(JSON.stringify({
            realtimeInput: {
                audio: {
                    data,
                    mimeType: mime || 'audio/pcm;rate=16000',
                },
            },
        }));
    },
    stopLive: stopGoogleLiveGracefully,
    onMessage: (callback) => {
        googleLiveMessageListeners.add(callback);
        return () => googleLiveMessageListeners.delete(callback);
    },
    onError: (callback) => {
        googleLiveErrorListeners.add(callback);
        return () => googleLiveErrorListeners.delete(callback);
    },
};

const providersApi: AssistantAPI['providers'] = {
    testModel: (provider, model) => invoke('provider_test_model', {
        request: {provider, model},
    }),
};

const authApi: AssistantAPI['auth'] = {
    getMethods: () => invoke('auth_get_methods'),
    startOAuth: (provider) => invoke('auth_start_oauth', {provider}),
    cancelPendingOAuth: () => invoke('auth_cancel_pending'),
    onOAuthPayload: (cb) => {
        authListeners.add(cb);
        void ensureAuthSubscription();
        return () => {
            authListeners.delete(cb);
            if (!authListeners.size && authUnlisten) {
                void authUnlisten();
                authUnlisten = null;
                void invoke('auth_renderer_not_ready');
            }
        };
    },
    consumePendingOAuthPayloads: async () => {
        // Install the event listener before marking the renderer ready/draining the
        // queue. Pending payloads are returned to the caller and must not also be
        // dispatched here, otherwise a login is processed twice.
        await ensureAuthSubscription();
        return invoke('auth_consume_pending');
    },
};

const mediaApi: AssistantAPI['media'] = {
    getPrimaryDisplaySourceId: async () => null,
};

const localSpeechApi: AssistantAPI['localSpeech'] = {
    getStatus: () => invoke('local_speech_get_status'),
    checkHealth: () => invoke('local_speech_check_health'),
    install: () => invoke('local_speech_install'),
    start: () => invoke('local_speech_start'),
    restart: () => invoke('local_speech_restart'),
    reinstall: () => invoke('local_speech_reinstall'),
    stop: () => invoke('local_speech_stop'),
    checkModelDownloaded: (model: string) =>
        invoke('local_speech_check_model_downloaded', {model}),
};

const ollamaApi: AssistantAPI['ollama'] = {
    checkInstalled: () => invoke('ollama_check_installed'),
    listModels: () => invoke('ollama_list_models'),
    pullModel: (model: string) => invoke('ollama_pull_model', {model}),
    warmupModel: (model: string) => invoke('ollama_warmup_model', {model}),
    streamChat: (args, onEvent) => {
        const channel = new Channel<OllamaStreamEvent>();
        channel.onmessage = onEvent;
        return invoke('ollama_stream_chat', {...args, onEvent: channel});
    },
    cancelChat: (requestId: string) => invoke('ollama_cancel_chat', {requestId}),
};

const api: AssistantAPI = {
    assistant: assistantApi,
    hotkeys: hotkeysApi,
    settings: settingsApi,
    window: windowApi,
    loopback: loopbackApi,
    screen: screenApi,
    google: googleApi,
    providers: providersApi,
    auth: authApi,
    media: mediaApi,
    localSpeech: localSpeechApi,
    ollama: ollamaApi,
    audio: audioApi,
    diagnostics: diagnosticsApi,
    log: async (entry) => {
        const prefix = `[${entry.category}] ${entry.message}`;
        const data = entry.data;
        const consoleMethod = entry.level === 'error'
            ? console.error
            : entry.level === 'warn'
                ? console.warn
                : entry.level === 'debug'
                    ? console.debug
                    : console.info;
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
            console.groupCollapsed(prefix);
            consoleMethod(data);
            console.groupEnd();
        } else {
            consoleMethod(prefix);
        }
        try {
            await invoke('log_frontend', {entry});
        } catch (error) {
            console.warn('[logger] failed to write frontend log', error);
        }
    },
};

if (typeof window !== 'undefined') {
    (window as any).api = api;
}

async function ensureAuthSubscription() {
    if (authUnlisten || !authListeners.size) return;
    if (authListenPromise) return authListenPromise;
    authListenPromise = (async () => {
        const unlisten = await listen<AuthDeepLinkPayload>('auth:deep-link', (event) => {
            dispatchAuthPayload(event.payload);
        });
        if (!authListeners.size) {
            unlisten();
            void invoke('auth_renderer_not_ready');
            return;
        }
        authUnlisten = unlisten;
    })();
    try {
        await authListenPromise;
    } finally {
        authListenPromise = null;
    }
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
        await video.play().catch(() => {
        });
        const sourceWidth = video.videoWidth || 1920;
        const sourceHeight = video.videoHeight || 1080;
        const maxDimension = 1920;
        const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Unable to capture screen frame');
        }
        ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        const base64 = dataUrl.split(',')[1] || '';
        return {
            base64,
            width,
            height,
            mime: 'image/jpeg',
        };
    } finally {
        stream.getTracks().forEach((t) => t.stop());
    }
}
