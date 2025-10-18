import {ipcRenderer} from 'electron';
import {
    AssistantAPI,
    AssistantResponse,
    IPCChannels,
} from '../../shared/ipc';

function bufferFromArgs(arrayBuffer: ArrayBuffer | undefined): Buffer | null {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
        return null;
    }
    return Buffer.from(new Uint8Array(arrayBuffer));
}

export function createAssistantBridge(): AssistantAPI['assistant'] {
    return {
        processAudio: async (args) => {
            const buffer = bufferFromArgs(args.arrayBuffer);
            if (!buffer) {
                return { ok: false, error: 'Empty audio' } as AssistantResponse;
            }
            return ipcRenderer.invoke(IPCChannels.AssistantProcess, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
            });
        },
        processAudioStream: async (args) => {
            const buffer = bufferFromArgs(args.arrayBuffer);
            if (!buffer) {
                return { ok: false, error: 'Empty audio' } as AssistantResponse;
            }
            return ipcRenderer.invoke(IPCChannels.AssistantProcessStream, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
                requestId: args.requestId,
            });
        },
        transcribeOnly: async (args) => {
            const buffer = bufferFromArgs(args.arrayBuffer);
            if (!buffer) {
                return { ok: false, error: 'Empty audio' };
            }
            return ipcRenderer.invoke(IPCChannels.AssistantTranscribeOnly, {
                audio: buffer,
                mime: args.mime,
                filename: args.filename ?? `lastN.${args.mime === 'audio/ogg' ? 'ogg' : 'webm'}`,
                audioSeconds: args.audioSeconds,
            });
        },
        askChat: async (args) => {
            await ipcRenderer.invoke(IPCChannels.AssistantAskChat, {
                text: args.text,
                requestId: args.requestId,
            });
        },
        stopStream: async (args) => {
            await ipcRenderer.invoke(IPCChannels.AssistantStopStream, {
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
    };
}
