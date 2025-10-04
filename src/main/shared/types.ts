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

export type AppSettings = {
    durations: number[]; // seconds
    openaiApiKey?: string;
    windowOpacity?: number;
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
};

export const DefaultSettings: AppSettings = {
    durations: [5, 10, 15, 20, 30, 60],
    windowOpacity: 100,
};

export const IPCChannels = {
    AssistantProcess: 'assistant:process',
    AssistantProcessStream: 'assistant:process:stream',
    AssistantTranscribeOnly: 'assistant:transcribe:only',
    AssistantAskChat: 'assistant:ask:chat',
    AssistantStreamTranscript: 'assistant:stream:transcript',
    AssistantStreamDelta: 'assistant:stream:delta',
    AssistantStreamDone: 'assistant:stream:done',
    AssistantStreamError: 'assistant:stream:error',
    GetSettings: 'settings:get',
    SetOpenaiApiKey: 'settings:set:openai-api-key',
    SetWindowOpacity: 'settings:set:window-opacity',
    SetDurations: 'settings:set:durations',
    SetAudioInputDevice: 'settings:set:audio-input-device',
    SetAudioInputType: 'settings:set:audio-input-type',
    GetAudioDevices: 'settings:get:audio-devices',
    OpenConfigFolder: 'settings:open-config-folder',
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

export type AudioDevice = {
    deviceId: string;
    label: string;
    kind: 'audioinput' | 'audiooutput';
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
        onStreamTranscript: (cb: (e: unknown, payload: { requestId?: string; delta: string }) => void) => void;
        onStreamDelta: (cb: (e: unknown, payload: { requestId?: string; delta: string }) => void) => void;
        onStreamDone: (cb: (e: unknown, payload: { requestId?: string; full: string }) => void) => void;
        onStreamError: (cb: (e: unknown, payload: { requestId?: string; error: string }) => void) => void;
        offStreamTranscript: () => void;
        offStreamDelta: () => void;
        offStreamDone: () => void;
        offStreamError: () => void;
    };
    settings: {
        get: () => Promise<AppSettings>;
        setOpenaiApiKey: (key: string) => Promise<void>;
        setWindowOpacity: (opacity: number) => Promise<void>;
        setDurations: (durations: number[]) => Promise<void>;
        setAudioInputDevice: (deviceId: string) => Promise<void>;
        setAudioInputType: (type: 'microphone' | 'system') => Promise<void>;
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
};







