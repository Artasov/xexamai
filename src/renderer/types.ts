export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'large-v2' | 'large-v3';

export type TranscriptionMode = 'api' | 'local';

export type LlmHost = 'api' | 'local';

export type LocalDevice = 'cpu' | 'gpu';

export type AppSettings = {
    durations: number[]; // seconds
    durationHotkeys?: Record<number, string>;
    toggleInputHotkey?: string;
    openaiApiKey?: string;
    windowOpacity?: number;
    alwaysOnTop?: boolean;
    hideApp?: boolean;
    windowWidth?: number;
    windowHeight?: number;
    windowScale?: number; // window scale factor (default: 1)
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
    transcriptionModel?: string;
    transcriptionPrompt?: string;
    llmModel?: string;
    llmPrompt?: string;
    transcriptionMode?: TranscriptionMode;
    llmHost?: LlmHost;
    localWhisperModel?: WhisperModel;
    localDevice?: LocalDevice;
    apiSttTimeoutMs?: number;
    apiLlmTimeoutMs?: number;
    // New Gemini settings
    geminiApiKey?: string;
    streamMode?: 'base' | 'stream';
    streamSendHotkey?: string;
};

export type AssistantResponse = {
    ok: true;
    text: string;
    answer: string;
} | {
    ok: false;
    error: string;
};

export type ProcessAudioArgs = {
    arrayBuffer: ArrayBuffer;
    mime: string;
    filename?: string;
    requestId?: string;
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

export type AssistantAPI = {
    assistant: {
        processAudio: (args: ProcessAudioArgs) => Promise<AssistantResponse>;
        processAudioStream: (args: ProcessAudioArgs) => Promise<AssistantResponse>;
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
    gemini: {
        startLive: (opts: { apiKey: string; response: 'TEXT' | 'AUDIO'; transcribeInput?: boolean; transcribeOutput?: boolean }) => Promise<void>;
        sendAudioChunk: (params: { data: string; mime: string }) => void;
        stopLive: () => void;
        onMessage: (cb: (message: any) => void) => void;
        onError: (cb: (error: string) => void) => void;
    };
    settings: {
        get: () => Promise<AppSettings>;
        setOpenaiApiKey: (key: string) => Promise<void>;
        setWindowOpacity: (opacity: number) => Promise<void>;
        setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>;
        setHideApp: (hideApp: boolean) => Promise<void>;
        setWindowSize: (size: { width: number; height: number }) => Promise<void>;
        setWindowScale: (scale: number) => Promise<void>;
        setDurations: (durations: number[]) => Promise<void>;
        setDurationHotkeys: (map: Record<number, string>) => Promise<void>;
        setAudioInputDevice: (deviceId: string) => Promise<void>;
        setToggleInputHotkey: (key: string) => Promise<void>;
        setAudioInputType: (type: 'microphone' | 'system') => Promise<void>;
        setTranscriptionModel: (model: string) => Promise<void>;
        setTranscriptionPrompt: (prompt: string) => Promise<void>;
        setLlmModel: (model: string) => Promise<void>;
        setLlmPrompt: (prompt: string) => Promise<void>;
        setTranscriptionMode: (mode: TranscriptionMode) => Promise<void>;
        setLlmHost: (host: LlmHost) => Promise<void>;
        setLocalWhisperModel: (model: WhisperModel) => Promise<void>;
        setLocalDevice: (device: LocalDevice) => Promise<void>;
        setApiSttTimeoutMs: (timeoutMs: number) => Promise<void>;
        setApiLlmTimeoutMs: (timeoutMs: number) => Promise<void>;
        getAudioDevices: () => Promise<AudioDevice[]>;
        openConfigFolder: () => Promise<void>;
        // New Gemini settings
        setGeminiApiKey: (key: string) => Promise<void>;
        setStreamMode: (mode: 'base' | 'stream') => Promise<void>;
        setStreamSendHotkey: (key: string) => Promise<void>;
    };
    hotkeys: {
        onDuration: (cb: (e: unknown, payload: { sec: number }) => void) => void;
        offDuration: () => void;
        onToggleInput: (cb: () => void) => void;
        offToggleInput: () => void;
    };
    window: {
        minimize: () => Promise<void>;
        close: () => Promise<void>;
    };
    loopback: {
        enable: () => Promise<{ success: boolean; error?: string }>;
        disable: () => Promise<{ success: boolean; error?: string }>;
    };
    media?: {
        getPrimaryDisplaySourceId: () => Promise<string | null>;
    };
    log: (entry: LogEntry) => Promise<void>;
};

declare global {
    interface Window {
        api: AssistantAPI;
        marked: {
            parse: (text: string) => string;
        };
    }
}

export {};
