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
    logger.info('recording', 'Starting recording');

    cleanupRecorder();
    await cleanupAudioGraph();

    const wave = ensureWave();
    audioSessionState.waveWrap = wave.wrap;
    audioSessionState.waveCanvas = wave.canvas;
    showWave(audioSessionState.waveWrap);
    if (!audioSessionState.visualizer) {
        audioSessionState.visualizer = new AudioVisualizer();
    }
    audioSessionState.visualizer.startFromLevels(audioSessionState.waveCanvas, { bars: 72, smoothing: 0.75 });

    const inputType = audioSessionState.currentAudioInputType;

    // Use native Rust capture for all modes (WASAPI loopback for system and mixed)
    await startNativeRecording();
}


async function startNativeRecording(): Promise<void> {
    const inputType = audioSessionState.currentAudioInputType;
    
    // Initialize shared buffer regardless of mode
    audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
    audioSessionState.ring = null;

    logger.info('audioSession', 'Initialized pcmRing for native recording', {
        inputType,
        durationSec: appState.durationSec,
        hasPcmRing: !!audioSessionState.pcmRing
    });

    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    // Set listener before starting capture to avoid missing early chunks
    audioUnsubscribe = onAudioChunk((chunk) => {
        try {
            const frames = chunk.samples[0]?.length || 0;
            if (!audioSessionState.pcmRing) {
                logger.warn('audioSession', 'Received audio chunk but pcmRing is null', {
                    inputType,
                    frames,
                    channels: chunk.channels
                });
                return;
            }
            audioSessionState.pcmRing.push(chunk.samples, frames, chunk.sampleRate);
            audioSessionState.rmsLevel = chunk.rms;
            const visualizerLevel =
                inputType === 'system'
                    ? chunk.rms * 0.1
                    : chunk.rms;
            audioSessionState.visualizer?.ingestLevel(visualizerLevel);
        } catch (error) {
            logger.error('audioSession', 'failed to push pcm chunk', {error, inputType});
            console.error('[audioSession] failed to push pcm chunk', error);
        }
    });

    // Ensure listener is registered before starting capture
    await new Promise(resolve => setTimeout(resolve, 50));

    const source: AudioSourceKind =
        inputType === 'system'
            ? 'system'
            : inputType === 'mixed'
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
        logger.info('audioSession', 'Starting native audio capture', {source, deviceId, inputType});
        await startAudioCapture(source, deviceId);
        logger.info('audioSession', 'Native audio capture started successfully', {source, inputType});
    } catch (error) {
        logger.error('recording', 'Failed to start native capture', {error});
        const description =
            error instanceof Error
                ? error.message
                : 'Failed to start audio capture';
        setStatus(description, 'error');
        throw error;
    }
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping recording');
    
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }

    const inputType = audioSessionState.currentAudioInputType;
    if (inputType === 'system' || inputType === 'mixed') {
        // For system and mixed stop only mic capture if it was running
        if (inputType === 'mixed') {
            await stopAudioCapture();
        }
    } else {
        // For mic stop the native Rust capture
        await stopAudioCapture();
    }

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
    const inputType = audioSessionState.currentAudioInputType;
    const ring = audioSessionState.pcmRing;

    if (!ring) {
        logger.warn('audioSession', 'getLastSecondsFloats: no pcmRing', {
            seconds,
            inputType,
            hasPcmRing: !!ring
        });
        return null;
    }

    const result = ring.getLastSecondsFloats(seconds);
    if (!result) {
        logger.warn('audioSession', 'pcmRing.getLastSecondsFloats returned null', {
            seconds,
            inputType,
            hasPcmRing: !!ring
        });
    }
    return result;
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
    // Re-subscribe to chunks when switching during recording
    if (!appState.isRecording) return;
    
    const inputType = audioSessionState.currentAudioInputType;
    
    // Ensure shared buffer exists
    if (!audioSessionState.pcmRing) {
        audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
    }
    
    // Clear previous subscriptions
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    
    // All modes now use Rust capture; resubscribe to native chunks
    if (inputType === 'mixed') {
        // Mixed mode: Rust mixes streams, so use a single buffer
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
    } else {
        // Mic and system modes
        audioUnsubscribe = onAudioChunk((chunk) => {
            try {
                const frames = chunk.samples[0]?.length || 0;
                audioSessionState.pcmRing?.push(chunk.samples, frames, chunk.sampleRate);
                audioSessionState.rmsLevel = chunk.rms;
                const visualizerLevel =
                    inputType === 'system'
                        ? chunk.rms * 0.1
                        : chunk.rms;
                audioSessionState.visualizer?.ingestLevel(visualizerLevel);
            } catch (error) {
                console.error('[audioSession] failed to push pcm chunk', error);
            }
        });
    }
}

export async function rebuildAudioGraph(): Promise<void> {
    // no-op for native capture
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
