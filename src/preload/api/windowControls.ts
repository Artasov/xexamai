import {ipcRenderer} from 'electron';
import {AssistantAPI} from '../../shared/ipc';

export function createWindowControlsBridge(): AssistantAPI['window'] {
    return {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        close: () => ipcRenderer.invoke('window:close'),
    };
}
