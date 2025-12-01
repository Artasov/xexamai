// noinspection JSUnusedGlobalSymbols

import {audioSessionState} from './audioSession/internalState';
import {getLastSecondsFloats, startRecording, stopRecording, updateVisualizerBars,} from './audioSession/recorder';
import {switchAudioInput} from './audioSession/audioInput';
import type {SwitchAudioResult, SwitchOptions} from './audioSession/types';
import type {PcmRingBuffer} from '../audio/pcmRingBuffer';
import type {AudioRingBuffer} from '../audio/ringBuffer';

export type {SwitchAudioResult, SwitchOptions};
export {
    startRecording,
    stopRecording,
    getLastSecondsFloats,
    updateVisualizerBars,
    switchAudioInput,
};

export function getAudioInputType(): 'microphone' | 'system' | 'mixed' {
    return audioSessionState.currentAudioInputType;
}

export function setAudioInputType(type: 'microphone' | 'system' | 'mixed'): void {
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
