// whisper-local.service.ts
import {env, Pipeline, pipeline} from '@xenova/transformers';
import {logger} from './logger.service';
import {WhisperModel} from '../shared/types';
import os from 'node:os';
import path from 'node:path';

type AsrOptions = {
    language?: string;
    task?: 'transcribe' | 'translate';
    chunk_length_s?: number;
    stride_length_s?: number;
};

export class WhisperLocalService {
    private static instance: WhisperLocalService;
    private pipeline: Pipeline | null = null;
    private currentModel: WhisperModel | null = null;
    private isInitialized = false;

    private constructor() {
    }

    public static getInstance(): WhisperLocalService {
        if (!WhisperLocalService.instance) {
            WhisperLocalService.instance = new WhisperLocalService();
        }
        return WhisperLocalService.instance;
    }

    public async initialize(model: WhisperModel): Promise<void> {
        if (this.isInitialized && this.currentModel === model) {
            logger.info('whisper-local', 'Model already initialized', {model});
            return;
        }

        try {
            // === ВАЖНО: стабильная конфигурация transformers.js для Node/Electron ===
            // 1) Отключаем proxy/worker-режим ONNX в Node, чтобы не висло на воркерах
            // 2) Включаем SIMD и задаём потоки
            // 3) Фиксируем кеш-папку (чтобы не было гонок)
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.simd = true;
            env.backends.onnx.wasm.numThreads = Math.max(1, os.cpus().length - 1);
            env.allowLocalModels = true;
            env.useBrowserCache = false;
            env.useFSCache = true;
            env.cacheDir = path.join(os.homedir(), '.cache', 'huggingface', 'hub');

            logger.info('whisper-local', 'Initializing Whisper model', {
                model,
                cacheLocation: env.cacheDir,
                wasmProxy: env.backends.onnx.wasm.proxy,
                wasmSIMD: env.backends.onnx.wasm.simd,
                wasmThreads: env.backends.onnx.wasm.numThreads
            });

            if (this.pipeline) {
                this.pipeline = null;
            }

            const modelName = `Xenova/whisper-${model}`;

            this.pipeline = await pipeline('automatic-speech-recognition', modelName, {
                quantized: true,
                // device: 'cpu',
                // progress_callback: (p: any) => logger.info('whisper-local', 'load-progress', p),
            });

            this.currentModel = model;
            this.isInitialized = true;

            logger.info('whisper-local', 'Whisper model initialized successfully', {
                model,
                modelName,
                cacheLocation: env.cacheDir
            });
        } catch (error) {
            logger.error('whisper-local', 'Failed to initialize Whisper model', {
                model,
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(
                `Failed to initialize Whisper model ${model}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async transcribe(audioBuffer: Buffer, options?: AsrOptions): Promise<string> {
        if (!this.pipeline) {
            throw new Error('Whisper pipeline not initialized. Call initialize() first.');
        }

        try {
            logger.info('whisper-local', 'Starting local transcription', {
                audioSize: audioBuffer.length,
                model: this.currentModel,
                options
            });

            const startTime = Date.now();

            // Корректная декодировка WAV (fmt/data-чанки) → mono float32 @16k
            const {floatMono16k, srcInfo} = this.decodeWavToMono16k(audioBuffer);

            logger.info('whisper-local', 'Audio converted, starting transcription', {
                srcSampleRate: srcInfo.sampleRate,
                srcChannels: srcInfo.numChannels,
                srcBitsPerSample: srcInfo.bitsPerSample,
                srcFormatTag: srcInfo.audioFormat,
                targetSampleRate: 16000,
                frames: floatMono16k.length
            });

            // Жёсткий таймаут с AbortController: не даём пайплайну "повиснуть"
            const ac = new AbortController();
            const timeout = setTimeout(() => ac.abort(), 60_000);

            // Для короткого аудио chunk уменьшаем, чтобы не запускать лишнюю сегментацию
            const chunkLen = Math.min(Math.max(options?.chunk_length_s ?? 15, 5), 30);

            const result = await this.pipeline(floatMono16k, {
                sampling_rate: 16000,
                language: options?.language || 'ru',
                task: options?.task || 'transcribe',
                chunk_length_s: chunkLen,
                stride_length_s: options?.stride_length_s ?? 5,
                // return_timestamps: false,
                signal: ac.signal as any, // поддержка abort в transformers.js
            } as any).finally(() => clearTimeout(timeout)) as any;

            const processingTime = Date.now() - startTime;
            const text = result?.text || '';

            logger.info('whisper-local', 'Local transcription completed', {
                textLength: text.length,
                processingTime,
                model: this.currentModel
            });

            return text;
        } catch (error) {
            logger.error('whisper-local', 'Local transcription failed', {
                error: error instanceof Error ? error.message : String(error),
                model: this.currentModel
            });
            throw new Error(
                `Local transcription failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    // === WAV parser + resample ===
    private decodeWavToMono16k(buffer: Buffer): {
        floatMono16k: Float32Array;
        srcInfo: { sampleRate: number; numChannels: number; bitsPerSample: number; audioFormat: number };
    } {
        if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
            logger.warn('whisper-local', 'Input is not RIFF/WAVE', {
                first12: buffer.toString('hex', 0, 12),
                len: buffer.length
            });
            throw new Error('Unsupported audio format: not a RIFF/WAVE file');
        }

        let offset = 12;
        let audioFormat = 1;
        let numChannels = 1;
        let sampleRate = 16000;
        let bitsPerSample = 16;
        let dataOffset = -1;
        let dataSize = 0;

        while (offset + 8 <= buffer.length) {
            const chunkId = buffer.toString('ascii', offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);
            const next = offset + 8 + chunkSize;

            if (chunkId === 'fmt ') {
                audioFormat = buffer.readUInt16LE(offset + 8);
                numChannels = buffer.readUInt16LE(offset + 10);
                sampleRate = buffer.readUInt32LE(offset + 12);
                bitsPerSample = buffer.readUInt16LE(offset + 22);
            } else if (chunkId === 'data') {
                dataOffset = offset + 8;
                dataSize = chunkSize;
            }

            offset = next;
        }

        if (dataOffset < 0 || dataSize <= 0) {
            throw new Error('WAV data chunk not found');
        }

        let interleaved: Float32Array;

        if (audioFormat === 1 && bitsPerSample === 16) {
            const samples = new Int16Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 2);
            interleaved = new Float32Array(samples.length);
            for (let i = 0; i < samples.length; i++) interleaved[i] = samples[i] / 32768.0;
        } else if (audioFormat === 3 && bitsPerSample === 32) {
            interleaved = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 4);
        } else {
            throw new Error(`Unsupported WAV format: audioFormat=${audioFormat} bitsPerSample=${bitsPerSample}`);
        }

        const mono = this.downmixToMono(interleaved, numChannels);
        const mono16k = sampleRate === 16000 ? mono : this.resampleLinear(mono, sampleRate, 16000);

        return {
            floatMono16k: mono16k,
            srcInfo: {sampleRate, numChannels, bitsPerSample, audioFormat}
        };
    }

    private downmixToMono(interleaved: Float32Array, channels: number): Float32Array {
        if (channels === 1) return interleaved;
        const frames = Math.floor(interleaved.length / channels);
        const mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
            mono[i] = sum / channels;
        }
        return mono;
    }

    private resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
        if (srcRate === dstRate) return src;
        const ratio = dstRate / srcRate;
        const dstLength = Math.max(1, Math.round(src.length * ratio));
        const dst = new Float32Array(dstLength);

        for (let i = 0; i < dstLength; i++) {
            const srcPos = i / ratio;
            const i0 = Math.floor(srcPos);
            const i1 = Math.min(i0 + 1, src.length - 1);
            const t = srcPos - i0;
            dst[i] = (1 - t) * src[i0] + t * src[i1];
        }
        return dst;
    }

    public async isModelLoaded(model: WhisperModel): Promise<boolean> {
        return this.isInitialized && this.currentModel === model;
    }

    public getCurrentModel(): WhisperModel | null {
        return this.currentModel;
    }

    public async cleanup(): Promise<void> {
        if (this.pipeline) {
            this.pipeline = null;
        }
        this.currentModel = null;
        this.isInitialized = false;
        logger.info('whisper-local', 'Whisper service cleaned up');
    }

    public getModelInfo(model: WhisperModel): {
        name: string;
        size: string;
        description: string;
    } {
        const modelInfo = {
            tiny: {name: 'Whisper Tiny', size: '~39 MB', description: 'Быстрая, но менее точная'},
            base: {name: 'Whisper Base', size: '~74 MB', description: 'Баланс скорости и точности'},
            small: {name: 'Whisper Small', size: '~244 MB', description: 'Хорошая точность'},
            medium: {name: 'Whisper Medium', size: '~769 MB', description: 'Высокая точность'},
            large: {name: 'Whisper Large', size: '~1550 MB', description: 'Очень высокая точность'},
            'large-v2': {name: 'Whisper Large V2', size: '~1550 MB', description: 'Улучшенная версия Large'},
            'large-v3': {name: 'Whisper Large V3', size: '~1550 MB', description: 'Последняя версия Large'},
        } as const;

        return modelInfo[model];
    }

    public getCacheInfo(): {
        location: string;
        models: string[];
    } {
        const cacheDir = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
        return {
            location: cacheDir,
            models: ['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3']
        };
    }
}

export const whisperLocalService = WhisperLocalService.getInstance();
