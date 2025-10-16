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
    durations: number[]; // seconds
    durationHotkeys?: Record<number, string>; // digit or letter key, combined with Ctrl
    toggleInputHotkey?: string; // single letter/digit for Ctrl-<key>
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
    screenProcessingTimeoutMs?: number;
    // New Gemini settings
    geminiApiKey?: string;
    streamMode?: 'base' | 'stream';
    streamSendHotkey?: string; // single letter/digit for Ctrl-<key>
    screenProcessingModel?: ScreenProcessingProvider;
    screenProcessingPrompt?: string;
};

export const DEFAULT_LLM_PROMPT = 'You are a seasoned technical interview coach for software engineers. Provide detailed, precise answers with technical terminology, example code';
export const DEFAULT_SCREEN_PROMPT = 'You are assisting with a technical interview. Analyze the screenshot and extract key information that could help answer questions about the candidate\'s environment, tools, or work. Focus on actionable insights.';

export const DefaultSettings: AppSettings = {
    durations: [5, 10, 15, 20, 30, 60],
    toggleInputHotkey: 'g',
    windowOpacity: 100,
    alwaysOnTop: false,
    transcriptionMode: 'api',
    llmHost: 'api',
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
    HotkeyDuration: 'hotkeys:duration', // main -> renderer event with { sec }
    HotkeyToggleInput: 'hotkeys:toggle-input', // main -> renderer event with no payload
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
    GetAudioDevices: 'settings:get:audio-devices',
    OpenConfigFolder: 'settings:open-config-folder',
    // New Gemini settings
    SetGeminiApiKey: 'settings:set:gemini-api-key',
    SetStreamMode: 'settings:set:stream-mode',
    SetStreamSendHotkey: 'settings:set:stream-send-hotkey',
    Log: 'log:entry',
    HolderGetStatus: 'holder:get-status',
    HolderCreateChallenge: 'holder:create-challenge',
    HolderVerifySignature: 'holder:verify-signature',
    HolderReset: 'holder:reset',
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

export type HolderChallengeInfo = {
    deeplink: string;
    reference: string;
    createdAt: string;
    expiresAt: string;
    qrSvg?: string;
};

export type HolderStatus = {
    isAuthorized: boolean;
    wallet?: string;
    lastVerified?: string;
    needsSignature: boolean;
    challenge?: HolderChallengeInfo;
    error?: string;
    checkingBalance?: boolean;
    tokenBalance?: string;
};

export type HolderVerificationResult = {
    ok: boolean;
    wallet?: string;
    lastVerified?: string;
    message?: string;
    error?: string;
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
        setScreenProcessingModel: (provider: ScreenProcessingProvider) => Promise<void>;
        setScreenProcessingPrompt: (prompt: string) => Promise<void>;
        setScreenProcessingTimeoutMs: (timeoutMs: number) => Promise<void>;
    };
    window: {
        minimize: () => Promise<void>;
        close: () => Promise<void>;
    };
    loopback: {
        enable: () => Promise<{ success: boolean; error?: string }>;
        disable: () => Promise<{ success: boolean; error?: string }>;
    };
    screen: {
        capture: () => Promise<{ base64: string; width: number; height: number; mime: string }>;
        process: (payload: ScreenProcessRequest) => Promise<ScreenProcessResponse>;
    };
    holder: {
        getStatus: (options?: { refreshBalance?: boolean }) => Promise<HolderStatus>;
        createChallenge: () => Promise<HolderStatus>;
        verifySignature: (signature: string) => Promise<HolderVerificationResult>;
        reset: () => Promise<void>;
    };
    log: (entry: LogEntry) => Promise<void>;
};
