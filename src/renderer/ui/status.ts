import {createExternalStore} from '../state/externalStore';

export type StatusType = 'ready' | 'recording' | 'sending' | 'processing' | 'error';
export type StatusSnapshot = {text: string; type: StatusType};

const initialStatus: StatusSnapshot = {text: 'Ready', type: 'ready'};
const statusStore = createExternalStore<StatusSnapshot>(initialStatus);

export const subscribeStatus = statusStore.subscribe;
export const getStatusSnapshot = statusStore.getSnapshot;

export function setStatus(text: string, type: StatusType = 'ready') {
    const current = statusStore.getSnapshot();
    if (current.text !== text || current.type !== type) {
        statusStore.set({text, type});
    }
}

export function resetStatus(): void {
    statusStore.reset();
}
