export type SttProcessRequest = {
    audio: Buffer | Uint8Array | ArrayBuffer | { type?: 'Buffer'; data?: number[] };
    mime: string;
    filename?: string;
    requestId?: string;
};

export type AssistantResponse = {
    ok: true;
    text: string;
    answer: string;
} | {
    ok: false;
    error: string;
};

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'large-v2' | 'large-v3';

export type TranscriptionMode = 'api' | 'local';

export type LlmHost = 'api' | 'local';

export type LocalDevice = 'cpu' | 'gpu';

export type ScreenProcessingProvider = 'openai' | 'google';

export type AppSettings = {
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
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
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
    screenProcessingTimeoutMs?: number;
    googleApiKey?: string;
    streamMode?: 'base' | 'stream';
    streamSendHotkey?: string;
    screenProcessingModel?: ScreenProcessingProvider;
    screenProcessingPrompt?: string;
};

export const DEFAULT_LLM_PROMPT =
    'You are a seasoned technical interview coach for software engineers. Provide detailed, precise answers with technical terminology, example code';

export const DEFAULT_SCREEN_PROMPT =
    'You are assisting with a technical interview. Analyze the screenshot and extract key information that could help answer questions about the candidate\'s environment, tools, or work. Focus on actionable insights.';

export const DefaultSettings: AppSettings = {
    durations: [5, 10, 15, 20, 30, 60],
    toggleInputHotkey: 'g',
    windowOpacity: 100,
    alwaysOnTop: false,
    welcomeModalDismissed: false,
    transcriptionMode: 'api',
    llmHost: 'api',
    llmModel: 'gpt-4.1-nano',
    apiLlmModel: 'gpt-4.1-nano',
    localLlmModel: 'gpt-oss:20b',
    localWhisperModel: 'base',
    localDevice: 'cpu',
    streamMode: 'base',
    streamSendHotkey: '~',
    screenProcessingModel: 'openai',
    screenProcessingPrompt: DEFAULT_SCREEN_PROMPT,
    screenProcessingTimeoutMs: 50000,
};

export const IPCChannels = {
    AssistantProcess: 'assistant:process',
    AssistantProcessStream: 'assistant:process:stream',
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
    SetStreamMode: 'settings:set:stream-mode',
    SetStreamSendHotkey: 'settings:set:stream-send-hotkey',
    AuthStartOAuth: 'auth:start-oauth',
    AuthConsumeDeepLinks: 'auth:consume-deep-links',
    AuthDeepLink: 'auth:deep-link',
    Log: 'log:entry',
    SetScreenProcessingModel: 'settings:set:screen-processing-model',
    SetScreenProcessingPrompt: 'settings:set:screen-processing-prompt',
    ScreenProcess: 'screen:process',
    ScreenCapture: 'screen:capture',
    SetScreenProcessingTimeoutMs: 'settings:set:screen-processing-timeout-ms',
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
};

export type AskChatRequest = {
    text: string;
    requestId?: string;
};

export type StopStreamRequest = {
    requestId?: string;
};

export type ScreenProcessRequest = {
    imageBase64: string;
    mime: string;
    width?: number;
    height?: number;
};

export type ScreenProcessResponse = {
    ok: boolean;
    answer?: string;
    error?: string;
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

export type AuthProvider = 'google' | 'github' | 'discord';

export type AuthTokensPayload = {
    access: string;
    refresh?: string | null;
};

export type AuthDeepLinkPayload =
    | {
        kind: 'success';
        provider: AuthProvider | string;
        tokens: AuthTokensPayload;
        user?: Record<string, unknown> | null;
    }
    | {
        kind: 'error';
        provider: AuthProvider | string;
        error: string;
    };

export type AssistantAPI = {
    assistant: {
        processAudio: (args: ProcessAudioArgs) => Promise<AssistantResponse>;
        processAudioStream: (args: ProcessAudioArgs) => Promise<AssistantResponse>;
        transcribeOnly: (args: TranscribeOnlyArgs) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
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
        setAudioInputType: (type: 'microphone' | 'system') => Promise<void>;
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
        setScreenProcessingModel: (provider: ScreenProcessingProvider) => Promise<void>;
        setScreenProcessingPrompt: (prompt: string) => Promise<void>;
        setScreenProcessingTimeoutMs: (timeoutMs: number) => Promise<void>;
        setWelcomeModalDismissed: (dismissed: boolean) => Promise<void>;
        setGoogleApiKey: (key: string) => Promise<void>;
        setStreamMode: (mode: 'base' | 'stream') => Promise<void>;
        setStreamSendHotkey: (key: string) => Promise<void>;
        setWindowScale: (scale: number) => Promise<void>;
        setHideApp: (hideApp: boolean) => Promise<void>;
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
        process: (payload: ScreenProcessRequest) => Promise<ScreenProcessResponse>;
    };
    google: {
        startLive: (opts: { apiKey: string; response: 'TEXT' | 'AUDIO'; transcribeInput?: boolean; transcribeOutput?: boolean }) => Promise<void>;
        sendAudioChunk: (params: { data: string; mime: string }) => void;
        stopLive: () => void;
        onMessage: (cb: (message: any) => void) => void;
        onError: (cb: (error: string) => void) => void;
    };
    auth: {
        startOAuth: (provider: AuthProvider) => Promise<void>;
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
    };
    log: (entry: LogEntry) => Promise<void>;
};

export type FastWhisperStatus = {
    installed: boolean;
    running: boolean;
    phase: string;
    message: string;
    error?: string | null;
    lastAction?: string | null;
    lastSuccessAt?: number | null;
    logLine?: string | null;
    updatedAt: number;
};
