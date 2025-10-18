import {ipcRenderer} from 'electron';
import {AssistantAPI, IPCChannels} from '../../shared/ipc';

export function createHotkeysBridge(): AssistantAPI['hotkeys'] {
    return {
        onDuration: (cb) => {
            ipcRenderer.on(IPCChannels.HotkeyDuration, cb as any);
        },
        offDuration: () => {
            ipcRenderer.removeAllListeners(IPCChannels.HotkeyDuration);
        },
        onToggleInput: (cb) => {
            ipcRenderer.on(IPCChannels.HotkeyToggleInput, cb as any);
        },
        offToggleInput: () => {
            ipcRenderer.removeAllListeners(IPCChannels.HotkeyToggleInput);
        },
    };
}
