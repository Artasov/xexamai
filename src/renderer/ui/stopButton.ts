import {createExternalStore} from '../state/externalStore';

const stopVisibilityStore = createExternalStore(false);

export const subscribeStopVisibility = stopVisibilityStore.subscribe;
export const getStopVisibilitySnapshot = stopVisibilityStore.getSnapshot;

export function showStopButton(): void {
    stopVisibilityStore.set(true);
}

export function hideStopButton(): void {
    stopVisibilityStore.set(false);
}
