import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer} from '../../audio/pcmRingBuffer';

export type AudioInputType = 'microphone' | 'system' | 'mixed';

export interface AudioSessionState {
    visualizer: AudioVisualizer | null;
    pcmRing: PcmRingBuffer | null;
    currentAudioInputType: AudioInputType;
}

export const audioSessionState: AudioSessionState = {
    visualizer: null,
    pcmRing: null,
    currentAudioInputType: 'microphone',
};
