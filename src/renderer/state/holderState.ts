import type {HolderStatus} from '../types.js';

export type HolderState = {
    status: HolderStatus | null;
    loading: boolean;
};

const state: HolderState = {
    status: null,
    loading: false,
};

type Listener = (snapshot: HolderState) => void;

const listeners = new Set<Listener>();

function notify() {
    const snapshot: HolderState = {
        status: state.status ? {...state.status} : null,
        loading: state.loading,
    };
    for (const listener of Array.from(listeners)) {
        try {
            listener(snapshot);
        } catch (error) {
            console.error('[holderState] listener error', error);
        }
    }
}

export function subscribeHolderState(listener: Listener): () => void {
    listeners.add(listener);
    // Deliver current state immediately
    listener({
        status: state.status ? {...state.status} : null,
        loading: state.loading,
    });
    return () => {
        listeners.delete(listener);
    };
}

export function setHolderStatus(status: HolderStatus | null) {
    if (status && state.status?.challenge && !status.challenge && status.needsSignature) {
        status = {
            ...status,
            challenge: state.status.challenge,
        };
    }
    state.status = status ? {...status} : null;
    notify();
}

export function setHolderLoading(loading: boolean) {
    if (state.loading === loading) return;
    state.loading = loading;
    notify();
}

export function getHolderState(): HolderState {
    return {
        status: state.status ? {...state.status} : null,
        loading: state.loading,
    };
}
