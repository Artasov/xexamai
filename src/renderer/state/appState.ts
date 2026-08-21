import {createExternalStore} from './externalStore';

export type AppState = {
    isRecording: boolean;
    isProcessing: boolean; // lock UI while transcription/response runs
    durationSec: number; // capture window in seconds
    mime: string;
};

const initialState: AppState = {
    isRecording: false,
    isProcessing: false,
    durationSec: 15,
    mime: 'audio/webm',
};

// Keep the read-only-by-convention object for service code that performs cheap
// synchronous guards. All writes go through the setters below so React gets a
// matching immutable snapshot.
export const state: AppState = {...initialState};
const appStateStore = createExternalStore<AppState>({...initialState});

export const subscribeAppState = appStateStore.subscribe;
export const getAppStateSnapshot = appStateStore.getSnapshot;

function publish(): void {
    appStateStore.set({...state});
}

export function setDuration(sec: number) {
    if (state.durationSec === sec) return;
    state.durationSec = sec;
    publish();
}

export function setRecording(v: boolean) {
    if (state.isRecording === v) return;
    state.isRecording = v;
    publish();
}

export function setProcessing(v: boolean) {
    if (state.isProcessing === v) return;
    state.isProcessing = v;
    publish();
}

export function resetAppState(): void {
    Object.assign(state, initialState);
    appStateStore.set({...initialState});
}
