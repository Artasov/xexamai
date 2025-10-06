import {contextBridge, ipcRenderer} from 'electron';
import {marked} from 'marked';
import {AssistantResponse, IPCChannels, LogEntry, TranscriptionMode, WhisperModel, LocalDevice} from '../main/shared/types';
import type {AssistantAPI} from '../renderer/types';

export const api: AssistantAPI = {
    assistant: {
        processAudio: async (args): Promise<AssistantResponse> => {
            try {
                console.debug('[preload.processAudio] arrayBuffer bytes:', args.arrayBuffer?.byteLength, 'mime:', args.mime, 'filename:', args.filename);
            } catch {
            }
            if (!(args.arrayBuffer instanceof ArrayBuffer) || args.arrayBuffer.byteLength === 0) {
                try {
                    console.warn('[preload.processAudio] empty arrayBuffer, skip invoke');
                } catch {
                }
                return {ok: false, error: 'Пустое аудио'} as AssistantResponse;
            }
            const buffer = Buffer.from(new Uint8Array(args.arrayBuffer));
            try {
                console.debug('[preload.processAudio] buffer length:', buffer.length);
            } catch {
            }
            return ipcRenderer.invoke(IPCChannels.AssistantProcess, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
            });
        },
        processAudioStream: async (args): Promise<AssistantResponse> => {
            if (!(args.arrayBuffer instanceof ArrayBuffer) || args.arrayBuffer.byteLength === 0) {
                return {ok: false, error: 'Пустое аудио'} as AssistantResponse;
            }
            const buffer = Buffer.from(new Uint8Array(args.arrayBuffer));
            return ipcRenderer.invoke(IPCChannels.AssistantProcessStream, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
                requestId: args.requestId,
            });
        },
        transcribeOnly: async (args): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
            if (!(args.arrayBuffer instanceof ArrayBuffer) || args.arrayBuffer.byteLength === 0) {
                return {ok: false, error: 'Пустое аудио'};
            }
            const buffer = Buffer.from(new Uint8Array(args.arrayBuffer));
            return ipcRenderer.invoke(IPCChannels.AssistantTranscribeOnly, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
                audioSeconds: args.audioSeconds,
            });
        },
        askChat: async (args): Promise<void> => {
            return ipcRenderer.invoke(IPCChannels.AssistantAskChat, {
                text: args.text,
                requestId: args.requestId,
            });
        },
        stopStream: async (args): Promise<void> => {
            return ipcRenderer.invoke(IPCChannels.AssistantStopStream, {
                requestId: args.requestId,
            });
        },
        onStreamTranscript: (cb) => {
            ipcRenderer.on(IPCChannels.AssistantStreamTranscript, cb as any);
        },
        onStreamDelta: (cb) => {
            ipcRenderer.on(IPCChannels.AssistantStreamDelta, cb as any);
        },
        onStreamDone: (cb) => {
            ipcRenderer.on(IPCChannels.AssistantStreamDone, cb as any);
        },
        onStreamError: (cb) => {
            ipcRenderer.on(IPCChannels.AssistantStreamError, cb as any);
        },
        offStreamTranscript: () => {
            ipcRenderer.removeAllListeners(IPCChannels.AssistantStreamTranscript);
        },
        offStreamDelta: () => {
            ipcRenderer.removeAllListeners(IPCChannels.AssistantStreamDelta);
        },
        offStreamDone: () => {
            ipcRenderer.removeAllListeners(IPCChannels.AssistantStreamDone);
        },
        offStreamError: () => {
            ipcRenderer.removeAllListeners(IPCChannels.AssistantStreamError);
        },
    },
    settings: {
        get: async () => ipcRenderer.invoke(IPCChannels.GetSettings),
        setOpenaiApiKey: (key: string) => ipcRenderer.invoke(IPCChannels.SetOpenaiApiKey, key),
        setWindowOpacity: (opacity: number) => ipcRenderer.invoke(IPCChannels.SetWindowOpacity, opacity),
        setAlwaysOnTop: (alwaysOnTop: boolean) => ipcRenderer.invoke(IPCChannels.SetAlwaysOnTop, alwaysOnTop),
        setWindowSize: (size: { width: number; height: number }) => ipcRenderer.invoke(IPCChannels.SetWindowSize, size),
        setDurations: (durations: number[]) => ipcRenderer.invoke(IPCChannels.SetDurations, durations),
        setDurationHotkeys: (map: Record<number, string>) => ipcRenderer.invoke(IPCChannels.SetDurationHotkeys, map),
        setToggleInputHotkey: (key: string) => ipcRenderer.invoke(IPCChannels.SetToggleInputHotkey, key),
        setAudioInputDevice: (deviceId: string) => ipcRenderer.invoke(IPCChannels.SetAudioInputDevice, deviceId),
        setAudioInputType: (type: 'microphone' | 'system') => ipcRenderer.invoke(IPCChannels.SetAudioInputType, type),
        setTranscriptionModel: (model: string) => ipcRenderer.invoke(IPCChannels.SetTranscriptionModel, model),
        setTranscriptionPrompt: (prompt: string) => ipcRenderer.invoke(IPCChannels.SetTranscriptionPrompt, prompt),
        setLlmModel: (model: string) => ipcRenderer.invoke(IPCChannels.SetLlmModel, model),
        setLlmPrompt: (prompt: string) => ipcRenderer.invoke(IPCChannels.SetLlmPrompt, prompt),
        setTranscriptionMode: (mode: TranscriptionMode) => ipcRenderer.invoke(IPCChannels.SetTranscriptionMode, mode),
        setLocalWhisperModel: (model: WhisperModel) => ipcRenderer.invoke(IPCChannels.SetLocalWhisperModel, model),
        setLocalDevice: (device: LocalDevice) => ipcRenderer.invoke(IPCChannels.SetLocalDevice, device),
        setApiSttTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke(IPCChannels.SetApiSttTimeoutMs, timeoutMs),
        setApiLlmTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke(IPCChannels.SetApiLlmTimeoutMs, timeoutMs),
        getAudioDevices: async () => {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                return devices
                    .filter(device => device.kind === 'audioinput')
                    .map(device => ({
                        deviceId: device.deviceId,
                        label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
                        kind: 'audioinput' as const
                    }));
            } catch (error) {
                console.error('Error getting audio devices:', error);
                return [];
            }
        },
        openConfigFolder: () => ipcRenderer.invoke(IPCChannels.OpenConfigFolder),
    },
    hotkeys: {
        onDuration: (cb) => {
            ipcRenderer.on(IPCChannels.HotkeyDuration, cb as any);
        },
        offDuration: () => {
            ipcRenderer.removeAllListeners(IPCChannels.HotkeyDuration);
        },
        onToggleInput: (cb: () => void) => {
            ipcRenderer.on(IPCChannels.HotkeyToggleInput, cb as any);
        },
        offToggleInput: () => {
            ipcRenderer.removeAllListeners(IPCChannels.HotkeyToggleInput);
        },
    },
    window: {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        close: () => ipcRenderer.invoke('window:close'),
    },
    loopback: {
        enable: () => ipcRenderer.invoke('enable-loopback-audio'),
        disable: () => ipcRenderer.invoke('disable-loopback-audio'),
    },
    // capture removed: using standard getDisplayMedia in renderer
    log: (entry: LogEntry) => ipcRenderer.invoke(IPCChannels.Log, entry),
};

declare global {
    interface Window {
        api: typeof api;
        marked: {
            parse: (text: string) => string;
        };
    }
}

// Настройка marked
marked.setOptions({
    breaks: true,
    gfm: true,
});

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('marked', {
    parse: (text: string) => marked.parse(text) as string
});

