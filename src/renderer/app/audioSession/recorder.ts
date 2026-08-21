// noinspection JSUnusedGlobalSymbols

import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer, type PcmWindow} from '../../audio/pcmRingBuffer';
import {getWaveCanvas} from '../../ui/waveform';
import {state as appState} from '../../state/appState';
import {logger} from '../../utils/logger';
import {audioSessionState} from './internalState';
import {
    AudioSourceKind,
    onAudioChunk,
    onAudioState,
    startAudioCapture,
    stopAudioCapture,
} from '../../services/nativeAudio';
import {settingsStore} from '../../state/settingsStore';
import {setStatus} from '../../ui/status';

let audioUnsubscribe: (() => void) | null = null;
let audioStateUnsubscribe: (() => void) | null = null;

export async function startRecording(): Promise<void> {
    logger.info('recording', 'Starting recording');

    audioSessionState.pcmRing = null;

    const waveCanvas = getWaveCanvas();
    if (!waveCanvas) throw new Error('Waveform canvas is unavailable');
    if (!audioSessionState.visualizer) {
        audioSessionState.visualizer = new AudioVisualizer();
    }
    audioSessionState.visualizer.startFromLevels(waveCanvas, {bars: 72, smoothing: 0.75});

    // Use native Rust capture for all modes (WASAPI loopback for system and mixed)
    await startNativeRecording();
}


async function startNativeRecording(options: {reuseBuffer?: boolean; allowMixedFallback?: boolean} = {}): Promise<void> {
    const inputType = audioSessionState.currentAudioInputType;

    if (!options.reuseBuffer || !audioSessionState.pcmRing) {
        audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
    } else {
        audioSessionState.pcmRing.setWindowSeconds(appState.durationSec);
    }
    logger.info('audioSession', 'Initialized pcmRing for native recording', {
        inputType,
        durationSec: appState.durationSec,
        hasPcmRing: !!audioSessionState.pcmRing
    });

    subscribeToNativeAudio(inputType);

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
        if (source === 'mixed' && options.allowMixedFallback !== false) {
            logger.warn('audioSession', 'Mixed capture failed, retrying with microphone only', {
                error: error instanceof Error ? error.message : String(error),
                deviceId,
            });
            try {
                await stopAudioCapture();
            } catch {
            }
            await fallbackToMicrophone(deviceId, error);
            return;
        }
        logger.error('recording', 'Failed to start native capture', {error});
        const description =
            error instanceof Error
                ? error.message
                : 'Failed to start audio capture';
        setStatus(description, 'error');
        throw error;
    }
}

/** Restarts only the native source, preserving the ring and visualizer across a live switch. */
export async function restartRecordingCapture(): Promise<void> {
    // Rust keeps the current capture alive until the replacement source has
    // completed its readiness handshake, then atomically swaps generations.
    await startNativeRecording({reuseBuffer: true, allowMixedFallback: false});
}

async function fallbackToMicrophone(deviceId: string | undefined, originalError: unknown): Promise<void> {
    audioSessionState.currentAudioInputType = 'microphone';
    settingsStore.patch({audioInputType: 'microphone'});
    try {
        await window.api.settings.setAudioInputType('microphone');
    } catch {
    }

    await startAudioCapture('mic', deviceId);
    logger.info('audioSession', 'Microphone fallback started after mixed capture failure', {
        deviceId,
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
    });
    setStatus('System audio unavailable. Switched to microphone only.', 'ready');
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping recording');

    let stopError: unknown;
    try {
        // Rust flushes and emits producer tails before the stopped state handshake.
        await stopAudioCapture();
    } catch (error) {
        stopError = error;
        logger.error('audioSession', 'Native audio shutdown failed', {error});
    } finally {
        unsubscribeFromNativeAudio();
    }

    audioSessionState.pcmRing = null;
    if (audioSessionState.visualizer) {
        audioSessionState.visualizer.stop();
    }
    if (stopError) throw stopError;
}

export function getLastSecondsFloats(seconds: number): PcmWindow | null {
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

export function updateVisualizerBars(options: { bars: number; smoothing: number }) {
    const waveCanvas = getWaveCanvas();
    if (!audioSessionState.visualizer || !waveCanvas) return;
    audioSessionState.visualizer.startFromLevels(waveCanvas, {
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

    subscribeToNativeAudio(inputType);
}

function subscribeToNativeAudio(inputType: typeof audioSessionState.currentAudioInputType): void {
    unsubscribeFromNativeAudio();
    audioUnsubscribe = onAudioChunk((chunk) => {
        try {
            const frames = chunk.samples[0]?.length || 0;
            if (!audioSessionState.pcmRing) {
                logger.warn('audioSession', 'Received audio chunk but pcmRing is null', {
                    inputType,
                    frames,
                    channels: chunk.channels,
                });
                return;
            }
            audioSessionState.pcmRing.push(chunk.samples, frames, chunk.sampleRate);
            const visualizerLevel = inputType === 'system' ? chunk.rms * 0.1 : chunk.rms;
            audioSessionState.visualizer?.ingestLevel(visualizerLevel);
        } catch (error) {
            logger.error('audioSession', 'failed to push pcm chunk', {error, inputType});
        }
    });
    audioStateUnsubscribe = onAudioState((captureState) => {
        if (captureState.state !== 'error') return;
        const message = captureState.message || 'Native audio capture stopped unexpectedly';
        logger.error('audioSession', 'Native audio worker failed', {
            generation: captureState.generation,
            source: captureState.source,
            message,
        });
        if (appState.isRecording) setStatus(message, 'error');
    });
}

function unsubscribeFromNativeAudio(): void {
    audioUnsubscribe?.();
    audioStateUnsubscribe?.();
    audioUnsubscribe = null;
    audioStateUnsubscribe = null;
}
