// noinspection JSUnusedGlobalSymbols

import {listen, UnlistenFn} from '@tauri-apps/api/event';
import type {AudioDeviceInfo} from '@shared/ipc';

export type AudioSourceKind = 'mic' | 'system' | 'mixed';

export type AudioChunk = {
    generation: number;
    sampleRate: number;
    channels: number;
    samples: Float32Array[];
    rms: number;
};

export type AudioCaptureState = {
    generation: number;
    source: AudioSourceKind;
    state: 'starting' | 'ready' | 'stopped' | 'error';
    message?: string;
};

type ChunkListener = (chunk: AudioChunk) => void;
type StateListener = (state: AudioCaptureState) => void;

let stateUnlisten: UnlistenFn | null = null;
let listenerSetup: Promise<void> | null = null;
let activeGeneration: number | null = null;
let lastGenerationSeen = 0;
const readyGenerations = new Set<number>();
const startingGenerations = new Set<number>();
const chunkListeners = new Set<ChunkListener>();
const stateListeners = new Set<StateListener>();
const stateWaiters = new Set<StateWaiter>();

export async function listAudioDevices(): Promise<AudioDeviceInfo[]> {
    return (await window.api?.audio?.listDevices?.()) ?? [];
}

/** Resolves only after the Rust source has completed its readiness handshake. */
export async function startAudioCapture(source: AudioSourceKind, deviceId?: string): Promise<void> {
    console.log('[nativeAudio] startCapture', {source, deviceId});
    await ensureListeners();
    const startCapture = window.api?.audio?.startCapture;
    if (!startCapture) throw new Error('Native audio capture is unavailable');

    const minimumGeneration = lastGenerationSeen + 1;
    const ready = waitForState(
        (state) => state.generation >= minimumGeneration
            && state.source === source
            && (state.state === 'ready' || state.state === 'error'),
        'audio source readiness',
    );
    try {
        const [, terminalState] = await Promise.all([
            startCapture(source, deviceId, handleChunkPacket),
            ready.promise,
        ]);
        if (terminalState.state === 'error') {
            throw new Error(terminalState.message || `Failed to start ${source} audio capture`);
        }
    } finally {
        ready.cancel();
    }
}

/** Stops and joins native workers. Global Tauri listeners intentionally stay installed. */
export async function stopAudioCapture(): Promise<void> {
    console.log('[nativeAudio] stopCapture');
    await ensureListeners();
    const stopCapture = window.api?.audio?.stopCapture;
    if (!stopCapture) return;

    const generation = activeGeneration;
    if (generation === null) {
        await stopCapture();
        return;
    }

    const stopped = waitForState(
        (state) => state.generation === generation && state.state === 'stopped',
        'audio source shutdown',
    );
    try {
        await Promise.all([stopCapture(), stopped.promise]);
    } finally {
        stopped.cancel();
    }
}

export function onAudioChunk(listener: ChunkListener): () => void {
    chunkListeners.add(listener);
    void ensureListeners();
    return () => chunkListeners.delete(listener);
}

export function onAudioState(listener: StateListener): () => void {
    stateListeners.add(listener);
    void ensureListeners();
    return () => stateListeners.delete(listener);
}

/** Intended only for renderer teardown, not capture stop/start or fallback. */
export async function disposeNativeAudioListeners(): Promise<void> {
    const pending = listenerSetup;
    if (pending) {
        try {
            await pending;
        } catch {
        }
    }
    const unlisten = [stateUnlisten];
    stateUnlisten = null;
    listenerSetup = null;
    activeGeneration = null;
    startingGenerations.clear();
    readyGenerations.clear();
    await Promise.all(unlisten.filter(Boolean).map((callback) => callback!()));
}

async function ensureListeners(): Promise<void> {
    if (stateUnlisten) return;
    if (listenerSetup) return listenerSetup;

    listenerSetup = (async () => {
        console.log('[nativeAudio] installing audio event listeners');
        if (!stateUnlisten) {
            stateUnlisten = await listen<NativeStatePayload>('audio:state', handleState);
        }
    })();

    try {
        await listenerSetup;
    } finally {
        listenerSetup = null;
    }
}

function handleState(event: {payload: NativeStatePayload}): void {
    const payload = event.payload;
    if (!payload || !Number.isSafeInteger(payload.generation)) return;
    const generation = payload.generation;
    lastGenerationSeen = Math.max(lastGenerationSeen, generation);

    const wasStarting = startingGenerations.has(generation);
    if (payload.state === 'starting') {
        startingGenerations.add(generation);
    } else if (payload.state === 'ready') {
        startingGenerations.delete(generation);
        activeGeneration = generation;
        readyGenerations.add(generation);
    } else if (payload.state === 'stopped') {
        startingGenerations.delete(generation);
        readyGenerations.delete(generation);
        if (generation === activeGeneration) activeGeneration = null;
    } else if (payload.state === 'error') {
        startingGenerations.delete(generation);
        if (generation === activeGeneration && !readyGenerations.has(generation)) {
            activeGeneration = null;
        }
    }

    const state: AudioCaptureState = {
        generation,
        source: payload.source,
        state: payload.state,
        message: payload.message ?? undefined,
    };
    const relevantToCurrentCapture = payload.state !== 'error'
        || generation === activeGeneration
        || wasStarting;
    if (relevantToCurrentCapture) {
        for (const listener of stateListeners) {
            try {
                listener(state);
            } catch (error) {
                console.error('[nativeAudio] state listener failed', error);
            }
        }
    }
    for (const waiter of [...stateWaiters]) {
        if (waiter.predicate(state)) waiter.resolve(state);
    }

}

function waitForState(
    predicate: (state: AudioCaptureState) => boolean,
    label: string,
): {promise: Promise<AudioCaptureState>; cancel: () => void} {
    let settled = false;
    let waiter!: StateWaiter;
    const promise = new Promise<AudioCaptureState>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            stateWaiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}`));
        }, 6_000);
        waiter = {
            predicate,
            timer,
            resolve: (state) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                stateWaiters.delete(waiter);
                resolve(state);
            },
        };
        stateWaiters.add(waiter);
    });
    return {
        promise,
        cancel: () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(waiter.timer);
            stateWaiters.delete(waiter);
        },
    };
}

export function decodeAudioChunkPacket(packet: ArrayBuffer | Uint8Array): AudioChunk | null {
    try {
        const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
        if (bytes.byteLength < 24) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, false) !== 0x58415544 || view.getUint16(4, true) !== 1) return null;
        const channels = view.getUint16(6, true);
        const sampleRate = view.getUint32(8, true);
        const generationBigInt = view.getBigUint64(16, true);
        if (channels < 1 || channels > 32 || sampleRate < 8_000 || sampleRate > 384_000) return null;
        if (generationBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        const generation = Number(generationBigInt);
        const pcmLength = bytes.byteLength - 24;
        if (pcmLength === 0 || pcmLength % (channels * 2) !== 0) return null;
        const totalSamples = pcmLength / 2;
        const samplesPerChannel = Math.floor(totalSamples / channels);
        if (samplesPerChannel === 0) return null;

        const perChannel = Array.from({length: channels}, () => new Float32Array(samplesPerChannel));
        let sumSquared = 0;
        for (let frame = 0; frame < samplesPerChannel; frame++) {
            for (let channel = 0; channel < channels; channel++) {
                const sample = view.getInt16(24 + (frame * channels + channel) * 2, true);
                const normalized = sample < 0 ? sample / 32_768 : sample / 32_767;
                perChannel[channel][frame] = normalized;
                sumSquared += normalized * normalized;
            }
        }

        const chunk: AudioChunk = {
            generation,
            sampleRate,
            channels,
            samples: perChannel,
            rms: Math.sqrt(sumSquared / Math.max(1, samplesPerChannel * channels)),
        };
        return chunk;
    } catch {
        return null;
    }
}

function handleChunkPacket(packet: ArrayBuffer | Uint8Array): void {
    try {
        const chunk = decodeAudioChunkPacket(packet);
        if (!chunk || chunk.generation !== activeGeneration) return;
        for (const listener of chunkListeners) {
            try {
                listener(chunk);
            } catch (error) {
                console.error('[nativeAudio] chunk listener failed', error);
            }
        }
    } catch (error) {
        console.error('[nativeAudio] failed to decode binary chunk', error);
    }
}

type NativeStatePayload = {
    generation: number;
    source: AudioSourceKind;
    state: AudioCaptureState['state'];
    message?: string | null;
};

type StateWaiter = {
    predicate: (state: AudioCaptureState) => boolean;
    resolve: (state: AudioCaptureState) => void;
    timer: number;
};
