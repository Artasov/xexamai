import {audioSessionState} from './audioSession/internalState';
import {
    startRecording,
    stopRecording,
    getLastSecondsFloats,
    recordFromStream,
    updateVisualizerBars,
    rebuildRecorderWithStream,
    rebuildAudioGraph,
    getSystemAudioStream,
} from './audioSession/recorder';
import {switchAudioInput} from './audioSession/audioInput';
import {registerPersistentSystemTrack, clonePersistentSystemTrack} from './audioSession/systemTrack';
import type {SwitchAudioResult, SwitchOptions} from './audioSession/types';
import type {PcmRingBuffer} from '../audio/pcmRingBuffer';
import type {AudioRingBuffer} from '../audio/ringBuffer';

export type {SwitchAudioResult, SwitchOptions};
export {
    startRecording,
    stopRecording,
    getLastSecondsFloats,
    recordFromStream,
    updateVisualizerBars,
    switchAudioInput,
    registerPersistentSystemTrack,
    clonePersistentSystemTrack,
    rebuildRecorderWithStream,
    rebuildAudioGraph,
    getSystemAudioStream,
};

export function getAudioInputType(): 'microphone' | 'system' {
    return audioSessionState.currentAudioInputType;
}

export function setAudioInputType(type: 'microphone' | 'system'): void {
    audioSessionState.currentAudioInputType = type;
}

export function getCurrentStream(): MediaStream | null {
    return audioSessionState.currentStream;
}

export function getPcmBuffer(): PcmRingBuffer | null {
    return audioSessionState.pcmRing;
}

export function getRingBuffer(): AudioRingBuffer | null {
    return audioSessionState.ring;
}

export function getPersistentSystemTrack(): MediaStreamTrack | null {
    return audioSessionState.persistentSystemAudioTrack;
}
