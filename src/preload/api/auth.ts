import {ipcRenderer} from 'electron';
import {
    AssistantAPI,
    AuthDeepLinkPayload,
    AuthProvider,
    IPCChannels,
} from '../../shared/ipc';

export function createAuthBridge(): AssistantAPI['auth'] {
    const listeners = new Set<(payload: AuthDeepLinkPayload) => void>();

    const emit = (payload: AuthDeepLinkPayload) => {
        for (const listener of listeners) {
            try {
                listener(payload);
            } catch {
            }
        }
    };

    ipcRenderer.on(IPCChannels.AuthDeepLink, (_, payload: AuthDeepLinkPayload) => {
        emit(payload);
    });

    const consumePending = async () => {
        try {
            const payloads = await ipcRenderer.invoke(IPCChannels.AuthConsumeDeepLinks) as AuthDeepLinkPayload[];
            if (Array.isArray(payloads) && payloads.length) {
                for (const payload of payloads) {
                    emit(payload);
                }
            }
            return payloads;
        } catch {
            return [];
        }
    };

    return {
        startOAuth: async (provider: AuthProvider) => {
            await ipcRenderer.invoke(IPCChannels.AuthStartOAuth, provider);
        },
        onOAuthPayload: (cb: (payload: AuthDeepLinkPayload) => void) => {
            listeners.add(cb);
            void consumePending();
            return () => {
                listeners.delete(cb);
            };
        },
        consumePendingOAuthPayloads: async () => consumePending(),
    };
}
