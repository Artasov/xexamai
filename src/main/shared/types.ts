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

export type LocalDevice = 'cpu' | 'gpu';

export type AppSettings = {
    durations: number[]; // seconds
    durationHotkeys?: Record<number, string>; // digit or letter key, combined with Ctrl
    openaiApiKey?: string;
    windowOpacity?: number;
    alwaysOnTop?: boolean;
    windowWidth?: number;
    windowHeight?: number;
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
    transcriptionModel?: string;
    transcriptionPrompt?: string;
    llmModel?: string;
    llmPrompt?: string;
    transcriptionMode?: TranscriptionMode;
    localWhisperModel?: WhisperModel;
    localDevice?: LocalDevice;
    apiSttTimeoutMs?: number;
    apiLlmTimeoutMs?: number;
};

export const DEFAULT_LLM_PROMPT = 'You are a seasoned technical interview coach for software engineers. Provide detailed, precise answers with technical terminology, example code';

export const DefaultSettings: AppSettings = {
    durations: [5, 10, 15, 20, 30, 60],
    windowOpacity: 100,
    alwaysOnTop: false,
    transcriptionMode: 'api',
    localWhisperModel: 'base',
    localDevice: 'cpu',
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
    SetWindowSize: 'settings:set:window-size',
    SetDurations: 'settings:set:durations',
    SetDurationHotkeys: 'settings:set:duration-hotkeys',
    HotkeyDuration: 'hotkeys:duration', // main -> renderer event with { sec }
    SetAudioInputDevice: 'settings:set:audio-input-device',
    SetAudioInputType: 'settings:set:audio-input-type',
    SetTranscriptionModel: 'settings:set:transcription-model',
    SetTranscriptionPrompt: 'settings:set:transcription-prompt',
    SetLlmModel: 'settings:set:llm-model',
    SetLlmPrompt: 'settings:set:llm-prompt',
    SetTranscriptionMode: 'settings:set:transcription-mode',
    SetLocalWhisperModel: 'settings:set:local-whisper-model',
    SetLocalDevice: 'settings:set:local-device',
    SetApiSttTimeoutMs: 'settings:set:api-stt-timeout-ms',
    SetApiLlmTimeoutMs: 'settings:set:api-llm-timeout-ms',
    GetAudioDevices: 'settings:get:audio-devices',
    OpenConfigFolder: 'settings:open-config-folder',
    Log: 'log:entry',
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
    hotkeys: {
        onDuration: (cb: (e: unknown, payload: { sec: number }) => void) => void;
        offDuration: () => void;
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
        setAudioInputType: (type: 'microphone' | 'system') => Promise<void>;
        setTranscriptionModel: (model: string) => Promise<void>;
        setTranscriptionPrompt: (prompt: string) => Promise<void>;
        setLlmModel: (model: string) => Promise<void>;
        setLlmPrompt: (prompt: string) => Promise<void>;
        setTranscriptionMode: (mode: TranscriptionMode) => Promise<void>;
        setLocalWhisperModel: (model: WhisperModel) => Promise<void>;
        setLocalDevice: (device: LocalDevice) => Promise<void>;
        setApiSttTimeoutMs: (timeoutMs: number) => Promise<void>;
        setApiLlmTimeoutMs: (timeoutMs: number) => Promise<void>;
        getAudioDevices: () => Promise<AudioDevice[]>;
        openConfigFolder: () => Promise<void>;
    };
    window: {
        minimize: () => Promise<void>;
        close: () => Promise<void>;
    };
    loopback: {
        enable: () => Promise<{ success: boolean; error?: string }>;
        disable: () => Promise<{ success: boolean; error?: string }>;
    };
    log: (entry: LogEntry) => Promise<void>;
};







