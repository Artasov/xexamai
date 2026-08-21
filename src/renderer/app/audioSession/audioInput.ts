import {AudioInputType, audioSessionState} from './internalState';
import type {SwitchAudioResult} from './types';
import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {settingsStore} from '../../state/settingsStore';
import {rebuildRecorderWithStream, restartRecordingCapture} from './recorder';
import {invokeNative} from '../../bridge/nativeInvoke';
import {runCaptureSwitchTransaction} from './switchTransaction';

let switchQueue: Promise<void> = Promise.resolve();

/** Serializes live switches and rolls the native capture back if the new source fails. */
export function switchAudioInput(newType: AudioInputType, newDeviceId?: string): Promise<SwitchAudioResult> {
    const result = switchQueue.then(
        () => performSwitch(newType, newDeviceId),
        () => performSwitch(newType, newDeviceId),
    );
    switchQueue = result.then(() => undefined, () => undefined);
    return result;
}

async function performSwitch(newType: AudioInputType, requestedDeviceId?: string): Promise<SwitchAudioResult> {
    const previousType = audioSessionState.currentAudioInputType;
    const previousDeviceId = currentDeviceId();
    const newDeviceId = requestedDeviceId === undefined ? previousDeviceId : requestedDeviceId.trim();
    if (newType === previousType && newDeviceId === previousDeviceId) {
        return {
            success: true,
            activeType: previousType,
            previousType,
            activeDeviceId: previousDeviceId,
            previousDeviceId,
        };
    }

    if (!appState.isRecording) {
        audioSessionState.currentAudioInputType = newType;
        try {
            await persistAudioTarget(newType, newDeviceId);
        } catch (error) {
            audioSessionState.currentAudioInputType = previousType;
            throw error;
        }
        return {
            success: true,
            activeType: newType,
            previousType,
            activeDeviceId: newDeviceId,
            previousDeviceId,
        };
    }

    const applyRuntimeTarget = (type: AudioInputType, deviceId: string): void => {
        audioSessionState.currentAudioInputType = type;
        settingsStore.patch({audioInputType: type, audioInputDeviceId: deviceId});
    };
    const sourceChanged = newType !== previousType;
    const activeDeviceChanged = newType !== 'system' && newDeviceId !== previousDeviceId;
    const captureSwitchRequired = sourceChanged || activeDeviceChanged;

    applyRuntimeTarget(newType, newDeviceId);
    const transaction = await runCaptureSwitchTransaction({
        switchRequired: captureSwitchRequired,
        switchToNew: restartRecordingCapture,
        persistNew: () => persistAudioTarget(newType, newDeviceId),
        switchBack: async () => {
            applyRuntimeTarget(previousType, previousDeviceId);
            await restartRecordingCapture();
        },
    });

    if (transaction.state === 'applied') {
        return {
            success: true,
            activeType: newType,
            previousType,
            activeDeviceId: newDeviceId,
            previousDeviceId,
        };
    }

    const switchError = errorMessage(transaction.error);
    console.error('Error switching audio input', transaction.error);
    if (transaction.state === 'new-active') {
        // The attempted rollback is itself transactional, so Rust leaves the
        // successfully started new generation running when the old source
        // cannot be restored. Keep renderer state aligned with reality.
        applyRuntimeTarget(newType, newDeviceId);
        await rebuildRecorderWithStream();
        try {
            await persistAudioTarget(newType, newDeviceId);
        } catch (persistError) {
            console.error('The active audio source could not be persisted', persistError);
        }
        const rollbackMessage = errorMessage(transaction.rollbackError);
        setStatus('Previous audio source could not be restored; continuing with the new source for this session.', 'error');
        return {
            success: false,
            activeType: newType,
            previousType,
            activeDeviceId: newDeviceId,
            previousDeviceId,
            rolledBack: false,
            error: switchError,
            rollbackError: rollbackMessage,
        };
    }

    applyRuntimeTarget(previousType, previousDeviceId);
    await rebuildRecorderWithStream();
    let rollbackPersistenceError: unknown;
    if (transaction.state === 'rolled-back') {
        try {
            // The failed command may have persisted the new value before a
            // later response/event error. Best-effort restore the disk state.
            await persistAudioTarget(previousType, previousDeviceId);
        } catch (error) {
            rollbackPersistenceError = error;
            console.error('Previous audio source was restored but its settings could not be persisted', error);
        }
    }

    const persistenceSuffix = rollbackPersistenceError
        ? ' Capture was restored for this session, but the setting could not be saved.'
        : '';
    setStatus(`Failed to switch audio input; restored ${label(previousType)}.${persistenceSuffix}`, 'error');
    return {
        success: false,
        activeType: previousType,
        previousType,
        activeDeviceId: previousDeviceId,
        previousDeviceId,
        rolledBack: true,
        error: switchError,
        rollbackError: rollbackPersistenceError ? errorMessage(rollbackPersistenceError) : undefined,
    };
}

function currentDeviceId(): string {
    try {
        return settingsStore.get().audioInputDeviceId?.trim() || '';
    } catch {
        return '';
    }
}

async function persistAudioTarget(type: AudioInputType, deviceId: string): Promise<void> {
    await invokeNative('config_update', {
        payload: {audioInputType: type, audioInputDeviceId: deviceId},
    });
    settingsStore.patch({audioInputType: type, audioInputDeviceId: deviceId});
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function label(type: AudioInputType): string {
    if (type === 'microphone') return 'microphone';
    if (type === 'system') return 'system audio';
    return 'mixed audio';
}
