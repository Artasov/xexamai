import {useSyncExternalStore} from 'react';
import {getAppStateSnapshot, subscribeAppState} from '../state/appState';
import {getStatusSnapshot, subscribeStatus} from '../ui/status';
import {getStopVisibilitySnapshot, subscribeStopVisibility} from '../ui/stopButton';

export function useRendererUiState() {
    const app = useSyncExternalStore(subscribeAppState, getAppStateSnapshot, getAppStateSnapshot);
    const status = useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot);
    const stopVisible = useSyncExternalStore(
        subscribeStopVisibility,
        getStopVisibilitySnapshot,
        getStopVisibilitySnapshot,
    );

    return {app, status, stopVisible};
}
