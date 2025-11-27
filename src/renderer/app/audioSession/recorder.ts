import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer} from '../../audio/pcmRingBuffer';
import {ensureWave, hideWave, showWave} from '../../ui/waveform';
import {state as appState} from '../../state/appState';
import {logger} from '../../utils/logger';
import {audioSessionState} from './internalState';
import {startAudioCapture, stopAudioCapture, onAudioChunk, AudioSourceKind} from '../../services/nativeAudio';
import {getSystemAudioStream, hasSystemAudioPermission} from '../../services/systemAudioCapture';
import {settingsStore} from '../../state/settingsStore';
import {setStatus} from '../../ui/status';

let audioUnsubscribe: (() => void) | null = null;
let systemAudioUnsubscribe: (() => void) | null = null;

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

    // Для system и mixed используем браузерный захват из getDisplayMedia
    if (inputType === 'system' || inputType === 'mixed') {
        await startSystemRecording(inputType);
    } else {
        // Для mic используем нативный Rust захват
        await startNativeRecording();
    }
}

async function startSystemRecording(inputType: 'system' | 'mixed'): Promise<void> {
    // Проверяем наличие разрешения на системный звук
    if (!hasSystemAudioPermission()) {
        const error = 'System audio permission not granted. Please allow screen sharing with audio when prompted at startup.';
        logger.error('recording', error);
        setStatus('Разрешение на системный звук не предоставлено', 'error');
        throw new Error(error);
    }

    // Используем сохранённый поток из audioSessionState или получаем новый
    let systemStream: MediaStream | null = audioSessionState.systemAudioStream;
    if (!systemStream || !systemStream.active) {
        // Пытаемся получить поток из systemAudioCapture
        systemStream = getSystemAudioStream();
        if (systemStream) {
            audioSessionState.systemAudioStream = systemStream;
        } else {
            const error = 'System audio stream not available. Please allow screen sharing with audio when prompted at startup.';
            logger.error('recording', error);
            setStatus('Системный аудиопоток недоступен. Разрешите захват экрана с аудио при старте программы.', 'error');
            throw new Error(error);
        }
    }
    
    // Проверяем, что это действительно MediaStream
    if (!(systemStream instanceof MediaStream)) {
        const error = 'System audio stream is not a valid MediaStream';
        logger.error('recording', error, {stream: systemStream});
        setStatus('Неверный формат системного аудиопотока', 'error');
        throw new Error(error);
    }

    // Инициализируем буферы
    if (inputType === 'mixed') {
        // Для mixed режима создаём отдельные буферы для mic и system
        audioSessionState.micPcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        audioSessionState.systemPcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        audioSessionState.pcmRing = null;
    } else {
        // Для system режима используем один буфер
        audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        audioSessionState.micPcmRing = null;
        audioSessionState.systemPcmRing = null;
    }
    audioSessionState.ring = null;

    // Очищаем предыдущие подписки
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    if (systemAudioUnsubscribe) {
        systemAudioUnsubscribe();
        systemAudioUnsubscribe = null;
    }

    // Создаём AudioContext для обработки системного аудио
    // Используем sample rate из потока, если доступен, иначе 48000
    const audioTrack = systemStream.getAudioTracks()[0];
    const trackSettings = audioTrack?.getSettings();
    const preferredSampleRate = trackSettings?.sampleRate || 48000;
    
    const audioContext = new AudioContext({sampleRate: preferredSampleRate});
    const sourceNode = audioContext.createMediaStreamSource(systemStream);
    
    // Используем меньший buffer size для меньшей задержки и лучшей синхронизации
    // ScriptProcessorNode работает лучше с меньшими буферами
    const bufferSize = 2048;
    const channels = trackSettings?.channelCount || 2;
    const processor = audioContext.createScriptProcessor(bufferSize, channels, channels);
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0; // Тихий выход

    processor.onaudioprocess = (event) => {
        if (event.inputBuffer) {
            const inputChannels = event.inputBuffer.numberOfChannels;
            const length = event.inputBuffer.length;
            const sampleRate = event.inputBuffer.sampleRate;

            const perChannel: Float32Array[] = [];
            let totalSum = 0;

            // Копируем данные каналов напрямую, без дополнительных преобразований
            for (let c = 0; c < inputChannels; c++) {
                const channelData = event.inputBuffer.getChannelData(c);
                // Создаём копию для хранения
                const copied = new Float32Array(channelData);
                perChannel.push(copied);

                // Вычисляем RMS
                for (let i = 0; i < length; i++) {
                    totalSum += channelData[i] * channelData[i];
                }
            }

            const rms = Math.sqrt(totalSum / Math.max(1, length * inputChannels));
            
            // Нормализуем RMS для системного звука (он обычно громче)
            const normalizedRms = rms * 0.4;

            if (inputType === 'mixed') {
                // Для mixed режима сохраняем в system буфер
                audioSessionState.systemPcmRing?.push(perChannel, length, sampleRate);
                // Обновляем RMS на основе обоих буферов
                updateMixedRMS();
            } else {
                // Для system режима сохраняем в основной буфер
                audioSessionState.pcmRing?.push(perChannel, length, sampleRate);
                audioSessionState.rmsLevel = normalizedRms;
                audioSessionState.visualizer?.ingestLevel(normalizedRms);
            }
        }
    };

    sourceNode.connect(processor);
    processor.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Сохраняем ссылку на processor для последующей очистки
    systemAudioUnsubscribe = () => {
        try {
            processor.disconnect();
            gainNode.disconnect();
            sourceNode.disconnect();
            audioContext.close().catch(() => {});
        } catch {
        }
    };

    // Для mixed режима также запускаем захват микрофона
    if (inputType === 'mixed') {
        let deviceId: string | undefined;
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

        try {
            await startAudioCapture('mic', deviceId);
            audioUnsubscribe = onAudioChunk((chunk) => {
                try {
                    const frames = chunk.samples[0]?.length || 0;
                    audioSessionState.micPcmRing?.push(chunk.samples, frames, chunk.sampleRate);
                    updateMixedRMS();
                } catch (error) {
                    console.error('[audioSession] failed to push mic chunk', error);
                }
            });
        } catch (error) {
            logger.error('recording', 'Failed to start mic capture for mixed mode', {error});
        }
    }

    logger.info('recording', 'System audio recording started', {inputType});
}

function updateMixedRMS(): void {
    const micData = audioSessionState.micPcmRing?.getLastSecondsFloats(0.1);
    const systemData = audioSessionState.systemPcmRing?.getLastSecondsFloats(0.1);

    if (!micData && !systemData) return;

    let micSum = 0;
    let micSamples = 0;
    let systemSum = 0;
    let systemSamples = 0;

    if (micData) {
        for (const channel of micData.channels) {
            for (let i = 0; i < channel.length; i++) {
                micSum += channel[i] * channel[i];
                micSamples++;
            }
        }
    }

    if (systemData) {
        for (const channel of systemData.channels) {
            for (let i = 0; i < channel.length; i++) {
                systemSum += channel[i] * channel[i];
                systemSamples++;
            }
        }
    }

    if (micSamples > 0 || systemSamples > 0) {
        const micRms = micSamples > 0 ? Math.sqrt(micSum / micSamples) : 0;
        const systemRms = systemSamples > 0 ? Math.sqrt(systemSum / systemSamples) * 0.4 : 0; // Нормализуем системный звук
        
        // Смешиваем RMS с весами (можно настроить)
        const mixedRms = Math.sqrt(micRms * micRms + systemRms * systemRms);
        audioSessionState.rmsLevel = mixedRms;
        audioSessionState.visualizer?.ingestLevel(mixedRms);
    }
}

async function startNativeRecording(): Promise<void> {
    const inputType = audioSessionState.currentAudioInputType;
    
    // Инициализируем буферы
    if (inputType === 'mixed') {
        // В mixed режиме Rust смешивает потоки, используем один буфер
        audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        audioSessionState.micPcmRing = null;
        audioSessionState.systemPcmRing = null;
    } else {
        audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        audioSessionState.micPcmRing = null;
        audioSessionState.systemPcmRing = null;
    }
    audioSessionState.ring = null;

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
        await startAudioCapture(source, deviceId);
    } catch (error) {
        logger.error('recording', 'Failed to start native capture', {error});
        setStatus('Не удалось запустить захват аудио', 'error');
        throw error;
    }
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping recording');
    
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    if (systemAudioUnsubscribe) {
        systemAudioUnsubscribe();
        systemAudioUnsubscribe = null;
    }

    const inputType = audioSessionState.currentAudioInputType;
    if (inputType === 'system' || inputType === 'mixed') {
        // Для system и mixed останавливаем только mic захват (если был)
        if (inputType === 'mixed') {
            await stopAudioCapture();
        }
    } else {
        // Для mic останавливаем нативный Rust захват
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
    
    if (inputType === 'mixed') {
        // Для mixed режима смешиваем mic и system
        return getMixedLastSecondsFloats(seconds);
    } else if (audioSessionState.pcmRing) {
        return audioSessionState.pcmRing.getLastSecondsFloats(seconds);
    }
    
    return null;
}

function getMixedLastSecondsFloats(seconds: number): { channels: Float32Array[]; sampleRate: number } | null {
    const micData = audioSessionState.micPcmRing?.getLastSecondsFloats(seconds);
    const systemData = audioSessionState.systemPcmRing?.getLastSecondsFloats(seconds);

    if (!micData && !systemData) return null;

    const sampleRate = micData?.sampleRate || systemData?.sampleRate || 48000;
    const needFrames = Math.floor(seconds * sampleRate);

    const micChannels = micData?.channels.length || 0;
    const systemChannels = systemData?.channels.length || 0;
    const maxChannels = Math.max(micChannels, systemChannels, 2);

    const micLength = micData?.channels[0]?.length || 0;
    const systemLength = systemData?.channels[0]?.length || 0;
    const maxLength = Math.max(micLength, systemLength, needFrames);

    const mixed: Float32Array[] = [];
    for (let ch = 0; ch < maxChannels; ch++) {
        const channel = new Float32Array(maxLength);
        
        if (micData && micData.channels[ch]) {
            const micChannel = micData.channels[ch];
            const micSampleRate = micData.sampleRate;
            
            // Если sample rate отличается, ресемплируем
            if (micSampleRate === sampleRate) {
                // Прямое копирование если sample rate совпадает
                for (let i = 0; i < Math.min(micChannel.length, maxLength); i++) {
                    channel[i] += micChannel[i];
                }
            } else {
                // Линейная интерполяция при разном sample rate
                const ratio = micSampleRate / sampleRate;
                for (let i = 0; i < maxLength; i++) {
                    const srcIdx = i * ratio;
                    const srcIdxFloor = Math.floor(srcIdx);
                    const srcIdxCeil = Math.min(srcIdxFloor + 1, micChannel.length - 1);
                    const t = srcIdx - srcIdxFloor;
                    
                    if (srcIdxFloor < micChannel.length) {
                        const val = micChannel[srcIdxFloor] * (1 - t) + micChannel[srcIdxCeil] * t;
                        channel[i] += val;
                    }
                }
            }
        }
        
        if (systemData && systemData.channels[ch]) {
            const systemChannel = systemData.channels[ch];
            const systemSampleRate = systemData.sampleRate;
            
            // Если sample rate отличается, ресемплируем
            if (systemSampleRate === sampleRate) {
                // Прямое копирование если sample rate совпадает
                for (let i = 0; i < Math.min(systemChannel.length, maxLength); i++) {
                    channel[i] += systemChannel[i];
                }
            } else {
                // Линейная интерполяция при разном sample rate
                const ratio = systemSampleRate / sampleRate;
                for (let i = 0; i < maxLength; i++) {
                    const srcIdx = i * ratio;
                    const srcIdxFloor = Math.floor(srcIdx);
                    const srcIdxCeil = Math.min(srcIdxFloor + 1, systemChannel.length - 1);
                    const t = srcIdx - srcIdxFloor;
                    
                    if (srcIdxFloor < systemChannel.length) {
                        const val = systemChannel[srcIdxFloor] * (1 - t) + systemChannel[srcIdxCeil] * t;
                        channel[i] += val;
                    }
                }
            }
        }
        
        // Нормализуем, чтобы избежать клиппинга
        let maxAmp = 0;
        for (let i = 0; i < maxLength; i++) {
            maxAmp = Math.max(maxAmp, Math.abs(channel[i]));
        }
        if (maxAmp > 1.0) {
            const gain = 1.0 / maxAmp;
            for (let i = 0; i < maxLength; i++) {
                channel[i] *= gain;
            }
        }
        
        mixed.push(channel);
    }

    return { channels: mixed, sampleRate };
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
    // Переподписываемся на чанки при переключении во время записи
    if (!appState.isRecording) return;
    
    const inputType = audioSessionState.currentAudioInputType;
    
    // Инициализируем буферы
    if (inputType === 'mixed') {
        if (!audioSessionState.micPcmRing) {
            audioSessionState.micPcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        }
        if (!audioSessionState.systemPcmRing) {
            audioSessionState.systemPcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        }
        audioSessionState.pcmRing = null;
    } else if (inputType === 'system') {
        if (!audioSessionState.pcmRing) {
            audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        }
        audioSessionState.micPcmRing = null;
        audioSessionState.systemPcmRing = null;
    } else {
        if (!audioSessionState.pcmRing) {
            audioSessionState.pcmRing = new PcmRingBuffer(48_000, 2, appState.durationSec);
        }
        audioSessionState.micPcmRing = null;
        audioSessionState.systemPcmRing = null;
    }
    
    // Очищаем предыдущие подписки
    if (audioUnsubscribe) {
        audioUnsubscribe();
        audioUnsubscribe = null;
    }
    
    // Для system и mixed режимов не нужно переподписываться на Rust чанки
    // Они используют браузерный getDisplayMedia
    if (inputType === 'mic') {
        // Переподписываемся на нативные чанки только для mic
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
    } else if (inputType === 'mixed') {
        // Для mixed режима переподписываемся только на mic чанки
        audioUnsubscribe = onAudioChunk((chunk) => {
            try {
                const frames = chunk.samples[0]?.length || 0;
                audioSessionState.micPcmRing?.push(chunk.samples, frames, chunk.sampleRate);
                updateMixedRMS();
            } catch (error) {
                console.error('[audioSession] failed to push mic chunk', error);
            }
        });
    }
}

export async function rebuildAudioGraph(): Promise<void> {
    // no-op for native capture
}

// getSystemAudioStream теперь импортируется из systemAudioCapture.ts

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
    audioSessionState.micPcmRing = null;
    audioSessionState.systemPcmRing = null;
}
