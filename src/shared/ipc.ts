// noinspection JSUnusedGlobalSymbols
import type {BackendDomain} from './appUrls';

export type SttProcessRequest = {
    audio: Buffer | Uint8Array | ArrayBuffer | { type?: 'Buffer'; data?: number[] };
    mime: string;
    filename?: string;
    requestId?: string;
};

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'large-v2' | 'large-v3';

export type TranscriptionMode = 'api' | 'local';

export type LlmHost = 'api' | 'local';

export type LocalDevice = 'auto' | 'cpu' | 'cuda' | 'metal' | 'gpu';

export type AppSettings = {
    configVersion?: number;
    durations: number[];
    durationHotkeys?: Record<number, string>;
    toggleInputHotkey?: string;
    openaiApiKey?: string;
    windowOpacity?: number;
    alwaysOnTop?: boolean;
    hideApp?: boolean;
    welcomeModalDismissed?: boolean;
    windowWidth?: number;
    windowHeight?: number;
    windowScale?: number;
    audioInputDeviceId?: string | null;
    audioInputType?: 'microphone' | 'system' | 'mixed';
    transcriptionModel?: string;
    transcriptionPrompt?: string;
    llmModel?: string;
    apiLlmModel?: string;
    localLlmModel?: string;
    llmPrompt?: string;
    transcriptionMode?: TranscriptionMode;
    llmHost?: LlmHost;
    localWhisperModel?: WhisperModel;
    localDevice?: LocalDevice;
    apiSttTimeoutMs?: number;
    apiLlmTimeoutMs?: number;
    googleApiKey?: string;
    hasOpenaiApiKey?: boolean;
    hasGoogleApiKey?: boolean;
    streamSendHotkey?: string;
    backendDomain?: BackendDomain;
    /** Default for the per-report redacted diagnostics checkbox; never enables content logging. */
    diagnosticsEnabled?: boolean;
};

export const DEFAULT_LLM_PROMPT =
    'You are a seasoned technical interview coach for software engineers. Provide detailed, precise answers with technical terminology, example code';

export const DefaultSettings: AppSettings = {
    configVersion: 1,
    durations: [5, 10, 15, 20, 30, 60],
    toggleInputHotkey: 'g',
    windowOpacity: 100,
    alwaysOnTop: false,
    hideApp: false,
    welcomeModalDismissed: false,
    audioInputType: 'microphone',
    transcriptionMode: 'api',
    llmHost: 'api',
    llmModel: 'gpt-4.1-nano',
    apiLlmModel: 'gpt-4.1-nano',
    localLlmModel: 'gpt-oss:20b',
    localWhisperModel: 'base',
    localDevice: 'cpu',
    streamSendHotkey: '~',
    apiSttTimeoutMs: 150000,
    apiLlmTimeoutMs: 150000,
    backendDomain: 'xlartas.com',
    diagnosticsEnabled: false,
};

export const IPCChannels = {
    AssistantTranscribeOnly: 'assistant:transcribe:only',
    AssistantAskChat: 'assistant:ask:chat',
    AssistantStopStream: 'assistant:stop:stream',
    AssistantStreamTranscript: 'assistant:stream:transcript',
    AssistantStreamDelta: 'assistant:stream:delta',
    AssistantStreamDone: 'assistant:stream:done',
    AssistantStreamError: 'assistant:stream:error',
    GetSettings: 'settings:get',
    SetOpenaiApiKey: 'settings:set:openai-api-key',
    SetWindowOpacity: 'settings:set:window-opacity',
    SetAlwaysOnTop: 'settings:set:always-on-top',
    SetHideApp: 'settings:set:hide-app',
    SetWindowSize: 'settings:set:window-size',
    SetWindowScale: 'settings:set:window-scale',
    SetDurations: 'settings:set:durations',
    SetDurationHotkeys: 'settings:set:duration-hotkeys',
    SetToggleInputHotkey: 'settings:set:toggle-input-hotkey',
    HotkeyDuration: 'hotkeys:duration',
    HotkeyToggleInput: 'hotkeys:toggle-input',
    SetAudioInputDevice: 'settings:set:audio-input-device',
    SetAudioInputType: 'settings:set:audio-input-type',
    SetTranscriptionModel: 'settings:set:transcription-model',
    SetTranscriptionPrompt: 'settings:set:transcription-prompt',
    SetLlmModel: 'settings:set:llm-model',
    SetLlmPrompt: 'settings:set:llm-prompt',
    SetTranscriptionMode: 'settings:set:transcription-mode',
    SetLlmHost: 'settings:set:llm-host',
    SetLocalWhisperModel: 'settings:set:local-whisper-model',
    SetLocalDevice: 'settings:set:local-device',
    SetApiSttTimeoutMs: 'settings:set:api-stt-timeout-ms',
    SetApiLlmTimeoutMs: 'settings:set:api-llm-timeout-ms',
    SetWelcomeModalDismissed: 'settings:set:welcome-modal-dismissed',
    GetAudioDevices: 'settings:get:audio-devices',
    OpenConfigFolder: 'settings:open-config-folder',
    SetGoogleApiKey: 'settings:set:google-api-key',
    SetStreamSendHotkey: 'settings:set:stream-send-hotkey',
    AuthStartOAuth: 'auth:start-oauth',
    AuthConsumeDeepLinks: 'auth:consume-deep-links',
    AuthDeepLink: 'auth:deep-link',
    Log: 'log:entry',
    ScreenCapture: 'screen:capture',
} as const;

export type ProcessAudioArgs = {
    arrayBuffer: ArrayBuffer;
    mime: string;
    filename?: string;
    requestId?: string;
};

export type TranscribeOnlyRequest = {
    audio: Buffer | Uint8Array | ArrayBuffer | { type?: 'Buffer'; data?: number[] };
    mime: string;
    filename?: string;
    audioSeconds?: number;
};

export type TranscribeOnlyArgs = {
    arrayBuffer: ArrayBuffer;
    mime: string;
    filename?: string;
    audioSeconds?: number;
    requestId?: string;
};

export type AskChatRequest = {
    text: string;
    requestId?: string;
    history?: ChatHistoryMessage[];
    images?: PromptImageAttachment[];
};

export type PromptImageAttachment = {
    id: string;
    mime: string;
    base64: string;
    name?: string;
    width?: number;
    height?: number;
};

export type ChatHistoryMessage = {
    role: 'user' | 'assistant';
    content: string;
};

export type StopStreamRequest = {
    requestId?: string;
};

export type ScreenCaptureResponse = {
    ok: boolean;
    base64?: string;
    width?: number;
    height?: number;
    mime?: string;
    error?: string;
};

export type AudioDevice = {
    deviceId: string;
    label: string;
    kind: 'audioinput' | 'audiooutput';
};

export type LogEntry = {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    category: string;
    message: string;
    data?: any;
};

export type AuthProvider = 'google' | 'github' | 'discord' | 'yandex';

export type AuthMethodsResponse = {
    countryCode: string;
    countryKnown: boolean;
    allowedOAuthProviders: string[];
    allowedOauthProviders?: string[];
    emailPasswordAllowed: boolean;
    allowedEmailDomains: string[];
};

export type AssistantAPI = {
    assistant: {
        transcribeOnly: (args: TranscribeOnlyArgs) => Promise<{ ok: true; text: string } | {
            ok: false;
            error: string
        }>;
        askChat: (args: AskChatRequest) => Promise<void>;
        stopStream: (args: StopStreamRequest) => Promise<void>;
        onStreamTranscript: (cb: (e: unknown, payload: { requestId?: string; delta: string }) => void) => void;
        onStreamDelta: (cb: (e: unknown, payload: { requestId?: string; delta: string }) => void) => void;
        onStreamDone: (cb: (e: unknown, payload: { requestId?: string; full: string }) => void) => void;
        onStreamError: (cb: (e: unknown, payload: { requestId?: string; error: string }) => void) => void;
        offStreamTranscript: () => void;
        offStreamDelta: () => void;
        offStreamDone: () => void;
        offStreamError: () => void;
    };
    hotkeys: {
        onDuration: (cb: (e: unknown, payload: { sec: number }) => void) => void;
        offDuration: () => void;
        onToggleInput: (cb: () => void) => void;
        offToggleInput: () => void;
    };
    settings: {
        get: () => Promise<AppSettings>;
        setOpenaiApiKey: (key: string) => Promise<void>;
        setWindowOpacity: (opacity: number) => Promise<void>;
        setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>;
        setWindowSize: (size: { width: number; height: number }) => Promise<void>;
        setDurations: (durations: number[]) => Promise<void>;
        setDurationHotkeys: (map: Record<number, string>) => Promise<void>;
        setAudioInputDevice: (deviceId: string) => Promise<void>;
        setToggleInputHotkey: (key: string) => Promise<void>;
        setAudioInputType: (type: 'microphone' | 'system' | 'mixed') => Promise<void>;
        setTranscriptionModel: (model: string) => Promise<void>;
        setTranscriptionPrompt: (prompt: string) => Promise<void>;
        setLlmModel: (model: string, host?: 'api' | 'local') => Promise<void>;
        setLlmPrompt: (prompt: string) => Promise<void>;
        setTranscriptionMode: (mode: TranscriptionMode) => Promise<void>;
        setLlmHost: (host: LlmHost) => Promise<void>;
        setLocalWhisperModel: (model: WhisperModel) => Promise<void>;
        setLocalDevice: (device: LocalDevice) => Promise<void>;
        setApiSttTimeoutMs: (timeoutMs: number) => Promise<void>;
        setApiLlmTimeoutMs: (timeoutMs: number) => Promise<void>;
        getAudioDevices: () => Promise<AudioDevice[]>;
        openConfigFolder: () => Promise<void>;
        openLogsFolder: () => Promise<void>;
        getLogPath: () => Promise<string>;
        setWelcomeModalDismissed: (dismissed: boolean) => Promise<void>;
        setGoogleApiKey: (key: string) => Promise<void>;
        setStreamSendHotkey: (key: string) => Promise<void>;
        setWindowScale: (scale: number) => Promise<void>;
        setHideApp: (hideApp: boolean) => Promise<void>;
        setBackendDomain: (domain: BackendDomain) => Promise<void>;
        setDiagnosticsEnabled: (enabled: boolean) => Promise<void>;
    };
    window: {
        minimize: () => Promise<void>;
        close: () => Promise<void>;
        getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>;
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
    };
    loopback: {
        enable: () => Promise<{ success: boolean; error?: string }>;
        disable: () => Promise<{ success: boolean; error?: string }>;
    };
    screen: {
        capture: () => Promise<{ base64: string; width: number; height: number; mime: string }>;
    };
    google: {
        getLiveCapability: () => Promise<{ supported: boolean; configured: boolean; reason?: string | null; model: string }>;
        startLive: (opts: {
            response: 'TEXT' | 'AUDIO';
            transcribeInput?: boolean;
            transcribeOutput?: boolean
        }) => Promise<void>;
        sendAudioChunk: (params: { data: string; mime: string }) => void;
        stopLive: () => Promise<void>;
        onMessage: (cb: (message: any) => void) => () => void;
        onError: (cb: (error: string) => void) => () => void;
    };
    openai: {
        getLiveCapability: () => Promise<{ supported: boolean; configured: boolean; reason?: string | null; model: string }>;
        startLive: (opts: {prompt?: string}) => Promise<void>;
        sendAudioChunk: (params: {data: string}) => void;
        stopLive: () => Promise<void>;
        onMessage: (cb: (message: Record<string, any>) => void) => () => void;
        onError: (cb: (error: string) => void) => () => void;
    };
    providers: {
        testModel: (provider: 'openai' | 'google', model: string) => Promise<{
            available: boolean;
            status: number;
            message: string;
        }>;
    };
    auth: {
        getMethods: () => Promise<AuthMethodsResponse>;
        startOAuth: (provider: AuthProvider) => Promise<void>;
        cancelPendingOAuth: () => Promise<void>;
        onOAuthPayload: (cb: (payload: AuthDeepLinkPayload) => void) => () => void;
        consumePendingOAuthPayloads: () => Promise<AuthDeepLinkPayload[]>;
    };
    media: {
        getPrimaryDisplaySourceId: () => Promise<string | null>;
    };
    localSpeech: {
        getStatus: () => Promise<FastWhisperStatus>;
        checkHealth: () => Promise<FastWhisperStatus>;
        install: () => Promise<FastWhisperStatus>;
        start: () => Promise<FastWhisperStatus>;
        restart: () => Promise<FastWhisperStatus>;
        reinstall: () => Promise<FastWhisperStatus>;
        stop: () => Promise<FastWhisperStatus>;
        checkModelDownloaded: (model: string) => Promise<boolean>;
    };
    ollama: {
        checkInstalled: () => Promise<boolean>;
        listModels: () => Promise<string[]>;
        pullModel: (model: string) => Promise<void>;
        warmupModel: (model: string) => Promise<void>;
        streamChat: (
            args: {
                requestId: string;
                body: string;
                connectTimeoutMs?: number;
                idleTimeoutMs?: number;
                totalTimeoutMs?: number;
            },
            onEvent: (event: OllamaStreamEvent) => void,
        ) => Promise<void>;
        cancelChat: (requestId: string) => Promise<void>;
    };
    audio: {
        listDevices: () => Promise<AudioDeviceInfo[]>;
        startCapture: (
            source: 'mic' | 'system' | 'mixed',
            deviceId: string | undefined,
            onChunk: (packet: ArrayBuffer | Uint8Array) => void,
        ) => Promise<void>;
        stopCapture: () => Promise<void>;
    };
    diagnostics: {
        snapshot: () => Promise<DiagnosticsSnapshot>;
    };
    log: (entry: LogEntry) => Promise<void>;
};

import type {
    AudioDeviceInfo,
    AuthDeepLinkPayload,
    DiagnosticsSnapshot,
    FastWhisperStatus,
    OllamaStreamEvent,
} from './generated/NativeBindings';

export type {AudioDeviceInfo, AuthDeepLinkPayload, DiagnosticsSnapshot, FastWhisperStatus};
