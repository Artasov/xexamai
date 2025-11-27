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
    micPcmRing: PcmRingBuffer | null; // Для mixed режима
    systemPcmRing: PcmRingBuffer | null; // Для mixed режима
    currentAudioInputType: AudioInputType;
    persistentSystemAudioTrack: MediaStreamTrack | null;
    systemAudioStream: MediaStream | null; // Поток для системного звука из getDisplayMedia
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
    micPcmRing: null,
    systemPcmRing: null,
    currentAudioInputType: 'mixed',
    persistentSystemAudioTrack: null,
    systemAudioStream: null,
    rmsLevel: 0,
};
