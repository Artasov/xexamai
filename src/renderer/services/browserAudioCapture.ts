// noinspection JSUnusedGlobalSymbols

import {logger} from '../utils/logger';

export type BrowserAudioSource = 'mic' | 'system' | 'mixed';

export type BrowserAudioChunk = {
    sampleRate: number;
    channels: number;
    samples: Float32Array[];
    rms: number;
    source: 'mic' | 'system';
};

type ChunkListener = (chunk: BrowserAudioChunk) => void;

type AudioResources = {
    stream: MediaStream | null;
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    processor: ScriptProcessorNode | null;
    gain: GainNode | null;
};

const mic: AudioResources = {
    stream: null,
    context: null,
    source: null,
    processor: null,
    gain: null,
};

const system: AudioResources = {
    stream: null,
    context: null,
    source: null,
    processor: null,
    gain: null,
};

const micListeners = new Set<ChunkListener>();
const systemListeners = new Set<ChunkListener>();

const BUFFER_SIZE = 4096;

function processAudioChunk(
    audioBuffer: AudioBuffer,
    source: 'mic' | 'system',
    listeners: Set<ChunkListener>
): void {
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;

    const perChannel: Float32Array[] = [];
    let totalSum = 0;

    for (let c = 0; c < channels; c++) {
        const channelData = audioBuffer.getChannelData(c);
        const copied = new Float32Array(channelData);
        perChannel.push(copied);

        for (let i = 0; i < length; i++) {
            totalSum += channelData[i] * channelData[i];
        }
    }

    const rms = Math.sqrt(totalSum / Math.max(1, length * channels));
    const chunk: BrowserAudioChunk = {
        sampleRate,
        channels,
        samples: perChannel,
        rms,
        source,
    };

    listeners.forEach((fn) => {
        try {
            fn(chunk);
        } catch (error) {
            console.error('[browserAudio] listener failed', error);
        }
    });
}

const closeAudioContext = (ctx: AudioContext | null) => {
    if (!ctx) return;
    ctx.close().catch(() => {
    });
};

const stopTracks = (stream: MediaStream | null) => {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
};

const disconnectChain = (resources: AudioResources) => {
    try {
        resources.source?.disconnect();
    } catch {
    }
    try {
        resources.processor?.disconnect();
    } catch {
    }
    try {
        resources.gain?.disconnect();
    } catch {
    }
    closeAudioContext(resources.context);
    stopTracks(resources.stream);
    resources.stream = null;
    resources.context = null;
    resources.source = null;
    resources.processor = null;
    resources.gain = null;
};

async function startMicCapture(deviceId?: string): Promise<void> {
    if (mic.stream) {
        return;
    }

    try {
        const constraints: MediaStreamConstraints = {
            audio: deviceId
                ? {
                    deviceId: {exact: deviceId},
                }
                : true,
        };

        mic.stream = await navigator.mediaDevices.getUserMedia(constraints);
        mic.context = new AudioContext({sampleRate: 48000});
        mic.source = mic.context.createMediaStreamSource(mic.stream);
        const micChannelCount = mic.stream.getAudioTracks()[0]?.getSettings().channelCount || 2;
        mic.processor = mic.context.createScriptProcessor(BUFFER_SIZE, micChannelCount, micChannelCount);
        mic.gain = mic.context.createGain();
        mic.gain.gain.value = 0; // Silent output to avoid playback

        mic.processor.onaudioprocess = (event) => {
            if (event.inputBuffer) {
                processAudioChunk(event.inputBuffer, 'mic', micListeners);
            }
        };

        mic.source.connect(mic.processor);
        mic.processor.connect(mic.gain);
        mic.gain.connect(mic.context.destination);

        logger.info('browserAudio', 'Mic capture started');
    } catch (error) {
        logger.error('browserAudio', 'Failed to start mic capture', {error});
        throw error;
    }
}

async function startSystemCapture(): Promise<void> {
    if (system.stream) {
        return;
    }

    try {
        // In Tauri we must request both video and audio even if video is unused
        // Some implementations require video: true for audio to work
        system.stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'monitor',
            } as MediaTrackConstraints,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            } as MediaTrackConstraints,
        });

        // Stop video tracks; we do not need them
        system.stream.getVideoTracks().forEach((track) => {
            track.stop();
        });

        // Ensure audio tracks exist
        const audioTracks = system.stream.getAudioTracks();
        if (audioTracks.length === 0) {
            throw new Error('No audio tracks available in system capture stream');
        }

        system.context = new AudioContext({sampleRate: 48000});
        system.source = system.context.createMediaStreamSource(system.stream);
        const systemChannelCount = audioTracks[0]?.getSettings().channelCount || 2;
        system.processor = system.context.createScriptProcessor(BUFFER_SIZE, systemChannelCount, systemChannelCount);
        system.gain = system.context.createGain();
        system.gain.gain.value = 0; // Silent output to avoid playback

        system.processor.onaudioprocess = (event) => {
            if (event.inputBuffer) {
                processAudioChunk(event.inputBuffer, 'system', systemListeners);
            }
        };

        system.source.connect(system.processor);
        system.processor.connect(system.gain);
        system.gain.connect(system.context.destination);

        // Handle user stopping the track
        system.stream.getAudioTracks().forEach((track) => {
            track.onended = () => {
                logger.info('browserAudio', 'System audio track ended by user');
                stopSystemCapture();
            };
        });

        logger.info('browserAudio', 'System capture started');
    } catch (error) {
        logger.error('browserAudio', 'Failed to start system capture', {error});
        throw error;
    }
}

function stopMicCapture(): void {
    disconnectChain(mic);
    micListeners.clear();
}

function stopSystemCapture(): void {
    disconnectChain(system);
    systemListeners.clear();
}

export async function startBrowserAudioCapture(source: BrowserAudioSource, deviceId?: string): Promise<void> {
    logger.info('browserAudio', 'Starting browser capture', {source, deviceId});

    if (source === 'mic') {
        await startMicCapture(deviceId);
    } else if (source === 'system') {
        await startSystemCapture();
    } else if (source === 'mixed') {
        await startMicCapture(deviceId);
        await startSystemCapture();
    }
}

export function stopBrowserAudioCapture(): void {
    logger.info('browserAudio', 'Stopping browser capture');
    stopMicCapture();
    stopSystemCapture();
}

export function onBrowserAudioChunk(source: 'mic' | 'system', cb: ChunkListener): () => void {
    if (source === 'mic') {
        micListeners.add(cb);
    } else {
        systemListeners.add(cb);
    }
    return () => {
        if (source === 'mic') {
            micListeners.delete(cb);
        } else {
            systemListeners.delete(cb);
        }
    };
}

