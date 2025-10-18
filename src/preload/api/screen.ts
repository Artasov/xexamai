import {ipcRenderer} from 'electron';
import {AssistantAPI, IPCChannels} from '../../shared/ipc';

export function createScreenBridge(): AssistantAPI['screen'] {
    return {
        capture: async () => {
            const result = await ipcRenderer.invoke(IPCChannels.ScreenCapture);
            if (!result || !result.ok || !result.base64) {
                throw new Error(result?.error || 'Screen capture failed');
            }
            return {
                base64: result.base64,
                width: result.width || 0,
                height: result.height || 0,
                mime: result.mime || 'image/png',
            };
        },
        process: (payload) => ipcRenderer.invoke(IPCChannels.ScreenProcess, payload),
    };
}
