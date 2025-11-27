import {AudioRingBuffer} from '../../audio/ringBuffer';
import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer} from '../../audio/pcmRingBuffer';

export type AudioInputType = 'microphone' | 'system' | 'mixed';

export interface AudioSessionState {
    media: MediaRecorder | null;
    ring: AudioRingBuffer | null;
    mimeSelected: string;
    visualizer: AudioVisualizer | null;
    waveWrap: HTMLDivElement | null;
    waveCanvas: HTMLCanvasElement | null;
    currentStream: MediaStream | null;
    audioCtx: AudioContext | null;
    srcNode: MediaStreamAudioSourceNode | null;
    scriptNode: ScriptProcessorNode | null;
    pcmRing: PcmRingBuffer | null;
    currentAudioInputType: AudioInputType;
    persistentSystemAudioTrack: MediaStreamTrack | null;
    rmsLevel: number;
}

export const audioSessionState: AudioSessionState = {
    media: null,
    ring: null,
    mimeSelected: 'audio/webm',
    visualizer: null,
    waveWrap: null,
    waveCanvas: null,
    currentStream: null,
    audioCtx: null,
    srcNode: null,
    scriptNode: null,
    pcmRing: null,
    currentAudioInputType: 'microphone',
    persistentSystemAudioTrack: null,
    rmsLevel: 0,
};
