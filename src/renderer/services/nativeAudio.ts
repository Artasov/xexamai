import {listen, UnlistenFn} from '@tauri-apps/api/event';
import type {AudioDeviceInfo} from '@shared/ipc';

export type AudioSourceKind = 'mic' | 'system' | 'mixed';

export type AudioChunk = {
    sampleRate: number;
    channels: number;
    samples: Float32Array[];
    rms: number;
};

type ChunkListener = (chunk: AudioChunk) => void;

let chunkUnlisten: UnlistenFn | null = null;
const listeners = new Set<ChunkListener>();
let chunkCounter = 0;

export async function listAudioDevices(): Promise<AudioDeviceInfo[]> {
    return (await window.api?.audio?.listDevices?.()) ?? [];
}

export async function startAudioCapture(source: AudioSourceKind, deviceId?: string): Promise<void> {
    console.log('[nativeAudio] startCapture', { source, deviceId });
    // Устанавливаем listener ПЕРЕД началом захвата, чтобы не пропустить первые чанки
    await ensureListener();
    await window.api?.audio?.startCapture?.(source, deviceId);
}

export async function stopAudioCapture(): Promise<void> {
    console.log('[nativeAudio] stopCapture');
    await window.api?.audio?.stopCapture?.();
    if (chunkUnlisten) {
        await chunkUnlisten();
        chunkUnlisten = null;
    }
    listeners.clear();
}

export function onAudioChunk(cb: ChunkListener): () => void {
    listeners.add(cb);
    void ensureListener();
    return () => {
        listeners.delete(cb);
    };
}

async function ensureListener(): Promise<void> {
    if (chunkUnlisten) return;
    console.log('[nativeAudio] ensuring listener for audio:chunk');
    chunkUnlisten = await listen<{
        sample_rate: number;
        channels: number;
        data_base64: string;
    }>('audio:chunk', (event) => {
        const payload = event.payload;
        if (!payload || !payload.data_base64) return;
        try {
            const bytes = Uint8Array.from(atob(payload.data_base64), (c) => c.charCodeAt(0));
            if (bytes.length === 0) return;
            
            // Data is interleaved i16: [L, R, L, R, ...] for stereo
            const channels = Math.max(1, payload.channels || 2);
            const totalSamples = bytes.length / 2;
            const samplesPerChannel = Math.floor(totalSamples / channels);
            
            if (samplesPerChannel === 0) return;
            
            const samples = new Int16Array(bytes.buffer, bytes.byteOffset, totalSamples);
            const perChannel: Float32Array[] = [];
            let totalSum = 0;
            
            for (let c = 0; c < channels; c++) {
                const chData = new Float32Array(samplesPerChannel);
                let chSum = 0;
                for (let i = 0; i < samplesPerChannel; i++) {
                    const idx = i * channels + c;
                    if (idx < samples.length) {
                        // Convert i16 [-32768, 32767] to float [-1.0, 1.0]
                        // Use 32767.0 to preserve symmetry
                        const v = samples[idx] / 32767.0;
                        chData[i] = v;
                        chSum += v * v;
                    }
                }
                perChannel.push(chData);
                totalSum += chSum;
            }
            
            const rms = Math.sqrt(totalSum / Math.max(1, totalSamples));
            const chunk: AudioChunk = {
                sampleRate: payload.sample_rate || 48000,
                channels,
                samples: perChannel,
                rms,
            };
            chunkCounter += 1;
            listeners.forEach((fn) => {
                try {
                    fn(chunk);
                } catch (error) {
                    console.error('[nativeAudio] listener failed', error);
                }
            });
        } catch (error) {
            console.error('[nativeAudio] failed to decode chunk', error);
        }
    });
}
