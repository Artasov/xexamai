import type {AssistantAPI} from '../shared/ipc';

declare global {
    interface Window {
        api: AssistantAPI;
        marked: {
            parse: (text: string) => string;
        };
    }
}

export {};
