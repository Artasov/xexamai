import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer} from '../../audio/pcmRingBuffer';
import {ensureWave, hideWave, showWave} from '../../ui/waveform';
import {state as appState} from '../../state/appState';
import {logger} from '../../utils/logger';
import {audioSessionState} from './internalState';
import {startAudioCapture, stopAudioCapture, onAudioChunk, AudioSourceKind} from '../../services/nativeAudio';
import {settingsStore} from '../../state/settingsStore';
import {setStatus} from '../../ui/status';

let audioUnsubscribe: (() => void) | null = null;

export async function startRecording(): Promise<void> {
    logger.info('recording', 'Starting native recording');

    cleanupRecorder();
    await cleanupAudioGraph();

    audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
    audioSessionState.ring = null;

    const wave = ensureWave();
    audioSessionState.waveWrap = wave.wrap;
    audioSessionState.waveCanvas = wave.canvas;
    showWave(audioSessionState.waveWrap);
    if (!audioSessionState.visualizer) {
        audioSessionState.visualizer = new AudioVisualizer();
    }
    audioSessionState.visualizer.startFromLevels(audioSessionState.waveCanvas, { bars: 72, smoothing: 0.75 });

    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    audioUnsubscribe = onAudioChunk((chunk) => {
        try {
            const frames = chunk.samples[0]?.length || 0;
            audioSessionState.pcmRing?.push(chunk.samples, frames, chunk.sampleRate);
            audioSessionState.rmsLevel = chunk.rms;
            audioSessionState.visualizer?.ingestLevel(chunk.rms);
        } catch (error) {
            console.error('[audioSession] failed to push pcm chunk', error);
        }
    });

    const source: AudioSourceKind =
        audioSessionState.currentAudioInputType === 'system'
            ? 'system'
            : audioSessionState.currentAudioInputType === 'mixed'
                ? 'mixed'
                : 'mic';

    let deviceId: string | undefined;
    if (source === 'mic' || source === 'mixed') {
        try {
            const settings = settingsStore.get();
            deviceId = settings.audioInputDeviceId || undefined;
        } catch {
            try {
                const settings = await settingsStore.load();
                deviceId = settings.audioInputDeviceId || undefined;
            } catch {
            }
        }
    }

    try {
        await startAudioCapture(source, deviceId);
    } catch (error) {
        logger.error('recording', 'Failed to start native capture', {error});
        setStatus('Не удалось запустить захват аудио', 'error');
        throw error;
    }
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping native recording');
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    await stopAudioCapture();
    audioSessionState.currentStream = null;
    await cleanupAudioGraph();
    if (audioSessionState.visualizer) {
        audioSessionState.visualizer.stop();
    }
    if (audioSessionState.waveWrap) {
        hideWave(audioSessionState.waveWrap);
    }
}

export function getLastSecondsFloats(seconds: number): { channels: Float32Array[]; sampleRate: number } | null {
    if (!audioSessionState.pcmRing) return null;
    return audioSessionState.pcmRing.getLastSecondsFloats(seconds);
}

export async function recordFromStream(): Promise<Blob> {
    throw new Error('recordFromStream is not supported with native capture');
}

export function updateVisualizerBars(options: { bars: number; smoothing: number }) {
    if (!audioSessionState.visualizer || !audioSessionState.waveCanvas) return;
    audioSessionState.visualizer.startFromLevels(audioSessionState.waveCanvas, {
        bars: options.bars,
        smoothing: options.smoothing,
    });
}

export async function rebuildRecorderWithStream(): Promise<void> {
    // no-op for native capture
}

export async function rebuildAudioGraph(): Promise<void> {
    // no-op for native capture
}

export async function getSystemAudioStream(): Promise<MediaStream> {
    throw new Error('System audio stream is not available with native capture');
}

function cleanupRecorder() {
    try {
        audioSessionState.media?.stop();
    } catch {
    }
    try {
        audioSessionState.media?.stream.getTracks().forEach((t) => t.stop());
    } catch {
    }
    audioSessionState.media = null;
}

async function cleanupAudioGraph() {
    try {
        audioSessionState.scriptNode?.disconnect();
    } catch {
    }
    try {
        audioSessionState.srcNode?.disconnect();
    } catch {
    }
    try {
        await audioSessionState.audioCtx?.close();
    } catch {
    }
    audioSessionState.audioCtx = null;
    audioSessionState.srcNode = null;
    audioSessionState.scriptNode = null;
    audioSessionState.pcmRing = null;
}
