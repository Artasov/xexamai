// noinspection JSUnusedGlobalSymbols

import {audioSessionState} from './internalState';

export function registerPersistentSystemTrack(track: MediaStreamTrack | null): void {
    setPersistentSystemTrack(track);
}

export function clonePersistentSystemTrack(): MediaStreamTrack | null {
    const track = audioSessionState.persistentSystemAudioTrack;
    if (track && track.readyState === 'live') {
        try {
            return track.clone();
        } catch {
            return null;
        }
    }
    return null;
}

export function setPersistentSystemTrack(track: MediaStreamTrack | null): void {
    if (audioSessionState.persistentSystemAudioTrack && audioSessionState.persistentSystemAudioTrack !== track) {
        try {
            audioSessionState.persistentSystemAudioTrack.stop();
        } catch {
        }
    }
    audioSessionState.persistentSystemAudioTrack = track;
    if (audioSessionState.persistentSystemAudioTrack) {
        try {
            audioSessionState.persistentSystemAudioTrack.onended = () => {
                audioSessionState.persistentSystemAudioTrack = null;
            };
        } catch {
        }
    }
}
