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

let micStream: MediaStream | null = null;
let systemStream: MediaStream | null = null;
let micAudioContext: AudioContext | null = null;
let systemAudioContext: AudioContext | null = null;
let micSourceNode: MediaStreamAudioSourceNode | null = null;
let systemSourceNode: MediaStreamAudioSourceNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let systemProcessor: ScriptProcessorNode | null = null;
let micGainNode: GainNode | null = null;
let systemGainNode: GainNode | null = null;

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

async function startMicCapture(deviceId?: string): Promise<void> {
    if (micStream) {
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

        micStream = await navigator.mediaDevices.getUserMedia(constraints);
        micAudioContext = new AudioContext({sampleRate: 48000});
        micSourceNode = micAudioContext.createMediaStreamSource(micStream);
        const micChannelCount = micStream.getAudioTracks()[0]?.getSettings().channelCount || 2;
        micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, micChannelCount, micChannelCount);
        micGainNode = micAudioContext.createGain();
        micGainNode.gain.value = 0; // Тихий выход, чтобы не было слышно

        micProcessor.onaudioprocess = (event) => {
            if (event.inputBuffer) {
                processAudioChunk(event.inputBuffer, 'mic', micListeners);
            }
        };

        micSourceNode.connect(micProcessor);
        micProcessor.connect(micGainNode);
        micGainNode.connect(micAudioContext.destination);

        logger.info('browserAudio', 'Mic capture started');
    } catch (error) {
        logger.error('browserAudio', 'Failed to start mic capture', {error});
        throw error;
    }
}

async function startSystemCapture(): Promise<void> {
    if (systemStream) {
        return;
    }

    try {
        // В Tauri нужно запросить и video, и audio, даже если video нам не нужен
        // Многие реализации требуют video: true для работы audio
        systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'monitor',
            } as MediaTrackConstraints,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            } as MediaTrackConstraints,
        });

        // Останавливаем видеотреки, они нам не нужны
        systemStream.getVideoTracks().forEach((track) => {
            track.stop();
        });

        // Проверяем наличие аудиотреков
        const audioTracks = systemStream.getAudioTracks();
        if (audioTracks.length === 0) {
            throw new Error('No audio tracks available in system capture stream');
        }

        systemAudioContext = new AudioContext({sampleRate: 48000});
        systemSourceNode = systemAudioContext.createMediaStreamSource(systemStream);
        const systemChannelCount = audioTracks[0]?.getSettings().channelCount || 2;
        systemProcessor = systemAudioContext.createScriptProcessor(BUFFER_SIZE, systemChannelCount, systemChannelCount);
        systemGainNode = systemAudioContext.createGain();
        systemGainNode.gain.value = 0; // Тихий выход, чтобы не было слышно

        systemProcessor.onaudioprocess = (event) => {
            if (event.inputBuffer) {
                processAudioChunk(event.inputBuffer, 'system', systemListeners);
            }
        };

        systemSourceNode.connect(systemProcessor);
        systemProcessor.connect(systemGainNode);
        systemGainNode.connect(systemAudioContext.destination);

        // Обработка остановки трека пользователем
        systemStream.getAudioTracks().forEach((track) => {
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
    if (micGainNode) {
        try {
            micGainNode.disconnect();
        } catch {
        }
        micGainNode = null;
    }
    if (micProcessor) {
        try {
            micProcessor.disconnect();
        } catch {
        }
        micProcessor = null;
    }
    if (micSourceNode) {
        try {
            micSourceNode.disconnect();
        } catch {
        }
        micSourceNode = null;
    }
    if (micAudioContext) {
        micAudioContext.close().catch(() => {});
        micAudioContext = null;
    }
    if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
    }
    micListeners.clear();
}

function stopSystemCapture(): void {
    if (systemGainNode) {
        try {
            systemGainNode.disconnect();
        } catch {
        }
        systemGainNode = null;
    }
    if (systemProcessor) {
        try {
            systemProcessor.disconnect();
        } catch {
        }
        systemProcessor = null;
    }
    if (systemSourceNode) {
        try {
            systemSourceNode.disconnect();
        } catch {
        }
        systemSourceNode = null;
    }
    if (systemAudioContext) {
        systemAudioContext.close().catch(() => {});
        systemAudioContext = null;
    }
    if (systemStream) {
        systemStream.getTracks().forEach((t) => t.stop());
        systemStream = null;
    }
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

