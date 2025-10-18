import {ipcRenderer} from 'electron';
import {AssistantAPI} from '../../shared/ipc';

export function createLoopbackBridge(): AssistantAPI['loopback'] {
    return {
        enable: () => ipcRenderer.invoke('enable-loopback-audio'),
        disable: () => ipcRenderer.invoke('disable-loopback-audio'),
    };
}
