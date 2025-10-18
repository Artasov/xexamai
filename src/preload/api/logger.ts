import {ipcRenderer} from 'electron';
import {AssistantAPI, IPCChannels, LogEntry} from '../../shared/ipc';

export function createLoggerBridge(): AssistantAPI['log'] {
    return (entry: LogEntry) => ipcRenderer.invoke(IPCChannels.Log, entry);
}
