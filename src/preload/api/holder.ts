import {ipcRenderer} from 'electron';
import {AssistantAPI, IPCChannels} from '../../shared/ipc';

export function createHolderBridge(): AssistantAPI['holder'] {
    return {
        getStatus: (options) => ipcRenderer.invoke(IPCChannels.HolderGetStatus, options),
        createChallenge: () => ipcRenderer.invoke(IPCChannels.HolderCreateChallenge),
        verifySignature: (signature: string) => ipcRenderer.invoke(IPCChannels.HolderVerifySignature, signature),
        reset: () => ipcRenderer.invoke(IPCChannels.HolderReset),
    };
}
