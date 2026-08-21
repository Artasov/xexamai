// noinspection JSUnusedGlobalSymbols

import {audioSessionState} from './audioSession/internalState';
import {getLastSecondsFloats, startRecording, stopRecording, updateVisualizerBars,} from './audioSession/recorder';
import {switchAudioInput} from './audioSession/audioInput';
import type {SwitchAudioResult} from './audioSession/types';

export type {SwitchAudioResult};
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
