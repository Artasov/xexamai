import {ipcRenderer} from 'electron';
import {
    AssistantAPI,
    IPCChannels,
    TranscriptionMode,
    LlmHost,
    WhisperModel,
    LocalDevice,
} from '../../shared/ipc';

async function enumerateAudioInputs() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
            .filter(device => device.kind === 'audioinput')
            .map(device => ({
                deviceId: device.deviceId,
                label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
                kind: 'audioinput' as const,
            }));
    } catch (error) {
        console.error('Error getting audio devices:', error);
        return [];
    }
}

export function createSettingsBridge(): AssistantAPI['settings'] {
    return {
        get: () => ipcRenderer.invoke(IPCChannels.GetSettings),
        setOpenaiApiKey: (key: string) => ipcRenderer.invoke(IPCChannels.SetOpenaiApiKey, key),
        setWindowOpacity: (opacity: number) => ipcRenderer.invoke(IPCChannels.SetWindowOpacity, opacity),
        setAlwaysOnTop: (alwaysOnTop: boolean) => ipcRenderer.invoke(IPCChannels.SetAlwaysOnTop, alwaysOnTop),
        setHideApp: (hideApp: boolean) => ipcRenderer.invoke(IPCChannels.SetHideApp, hideApp),
        setWindowSize: (size: { width: number; height: number }) => ipcRenderer.invoke(IPCChannels.SetWindowSize, size),
        setWindowScale: (scale: number) => ipcRenderer.invoke(IPCChannels.SetWindowScale, scale),
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
        setLlmHost: (host: LlmHost) => ipcRenderer.invoke(IPCChannels.SetLlmHost, host),
        setLocalWhisperModel: (model: WhisperModel) => ipcRenderer.invoke(IPCChannels.SetLocalWhisperModel, model),
        setLocalDevice: (device: LocalDevice) => ipcRenderer.invoke(IPCChannels.SetLocalDevice, device),
        setApiSttTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke(IPCChannels.SetApiSttTimeoutMs, timeoutMs),
        setApiLlmTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke(IPCChannels.SetApiLlmTimeoutMs, timeoutMs),
        getAudioDevices: () => enumerateAudioInputs(),
        openConfigFolder: () => ipcRenderer.invoke(IPCChannels.OpenConfigFolder),
        setGoogleApiKey: (key: string) => ipcRenderer.invoke(IPCChannels.SetGoogleApiKey, key),
        setStreamMode: (mode: 'base' | 'stream') => ipcRenderer.invoke(IPCChannels.SetStreamMode, mode),
        setStreamSendHotkey: (key: string) => ipcRenderer.invoke(IPCChannels.SetStreamSendHotkey, key),
        setScreenProcessingModel: (provider: 'openai' | 'google') => ipcRenderer.invoke(IPCChannels.SetScreenProcessingModel, provider),
        setScreenProcessingPrompt: (prompt: string) => ipcRenderer.invoke(IPCChannels.SetScreenProcessingPrompt, prompt),
        setScreenProcessingTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke(IPCChannels.SetScreenProcessingTimeoutMs, timeoutMs),
        setWelcomeModalDismissed: (dismissed: boolean) => ipcRenderer.invoke(IPCChannels.SetWelcomeModalDismissed, dismissed),
    };
}
