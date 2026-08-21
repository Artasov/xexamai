// noinspection JSUnusedGlobalSymbols

import axios from 'axios';
import {FAST_WHISPER_BASE_URL, LOCAL_TRANSCRIBE_ALIASES, LOCAL_TRANSCRIBE_MODEL_DETAILS,} from '@shared/constants';
import {settingsStore} from '../state/settingsStore';
import {beginNativeRendererActivity} from '../state/rendererActivity';

const MODELS_DOWNLOAD_ENDPOINT = '/v1/models/download';
const MODELS_WARMUP_ENDPOINT = '/v1/models/warmup';
const MODELS_EXISTS_ENDPOINT = '/download/model/exists';

const resolveBaseUrl = async (): Promise<string> => {
    try {
        const status = await window.api?.localSpeech?.getStatus();
        const dynamic = status?.baseUrl?.trim().replace(/\/$/, '');
        if (dynamic) return dynamic;
    } catch {
    }
    return FAST_WHISPER_BASE_URL;
};

const resolveDevice = async (): Promise<'auto' | 'cpu' | 'cuda'> => {
    try {
        let settings;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }
        const device = settings.localDevice?.toLowerCase();
        if (device === 'cpu') return 'cpu';
        if (device === 'cuda' || device === 'gpu') return 'cuda';
    } catch {
    }
    return 'auto';
};

type WarmupListener = (models: Set<string>) => void;

const warmupModels = new Set<string>();
const warmupListeners = new Set<WarmupListener>();
const modelCache = new Map<string, boolean>();

export type LocalModelDownloadResponse = {
    status: 'downloaded' | 'already_present';
    model: string;
    model_path: string;
    download_root: string;
    elapsed: number;
};

export type LocalModelWarmupResponse = {
    status: 'ready';
    model: string;
    device: string;
    compute_type: string;
    load_time: number;
};

export const normalizeLocalWhisperModel = (value?: string | null): string => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
        return '';
    }
    const alias = LOCAL_TRANSCRIBE_ALIASES[trimmed as keyof typeof LOCAL_TRANSCRIBE_ALIASES];
    return (alias ?? trimmed).toLowerCase();
};

export const getLocalWhisperMetadata = (
    model: string,
): { id: string; label: string; size: string } | null => {
    const normalized = normalizeLocalWhisperModel(model);
    if (!normalized) {
        return null;
    }
    const details = LOCAL_TRANSCRIBE_MODEL_DETAILS[normalized as keyof typeof LOCAL_TRANSCRIBE_MODEL_DETAILS];
    if (!details) {
        return null;
    }
    return {id: normalized, label: details.label, size: details.size};
};

const notifyWarmup = () => {
    const snapshot = new Set(warmupModels);
    warmupListeners.forEach((listener) => {
        try {
            listener(snapshot);
        } catch (error) {
            console.error('[localSpeechModels] warmup listener failed', error);
        }
    });
};

export const subscribeToLocalModelWarmup = (listener: WarmupListener): (() => void) => {
    warmupListeners.add(listener);
    listener(new Set(warmupModels));
    return () => {
        warmupListeners.delete(listener);
    };
};

export const isLocalModelWarming = (model: string): boolean =>
    warmupModels.has(normalizeLocalWhisperModel(model));

export const checkLocalModelDownloaded = async (
    model: string,
    options: { force?: boolean } = {},
): Promise<boolean> => {
    const normalized = normalizeLocalWhisperModel(model);
    if (!normalized) {
        return false;
    }
    if (!options.force && modelCache.has(normalized)) {
        return Boolean(modelCache.get(normalized));
    }

    try {
        const exists = await window.api?.localSpeech?.checkModelDownloaded(normalized);
        if (exists !== undefined) {
            const result = Boolean(exists);
            modelCache.set(normalized, result);
            return result;
        }
    } catch (error) {
        console.warn('[localSpeechModels] fallback to HTTP check', error);
    }

    try {
        const releaseActivity = await beginNativeRendererActivity('Checking local speech model');
        try {
            const {data} = await axios.get<{ exists: boolean }>(`${await resolveBaseUrl()}${MODELS_EXISTS_ENDPOINT}`, {
                params: {model: normalized},
                timeout: 10_000,
            });
            const exists = Boolean(data?.exists);
            modelCache.set(normalized, exists);
            return exists;
        } finally {
            await releaseActivity();
        }
    } catch (error) {
        console.error('[localSpeechModels] failed to verify model via HTTP', error);
        modelCache.set(normalized, false);
        return false;
    }
};

export const downloadLocalSpeechModel = async (model: string): Promise<LocalModelDownloadResponse> => {
    const normalized = normalizeLocalWhisperModel(model);
    if (!normalized) {
        throw new Error('Model name is missing.');
    }
    const releaseActivity = await beginNativeRendererActivity('Downloading local speech model');
    try {
        const {data} = await axios.post<LocalModelDownloadResponse>(
            `${await resolveBaseUrl()}${MODELS_DOWNLOAD_ENDPOINT}`,
            {model: normalized},
            {
                headers: {'Content-Type': 'application/json'},
                timeout: 30 * 60 * 1000,
            },
        );
        modelCache.set(normalized, true);
        return data;
    } finally {
        await releaseActivity();
    }
};

export const warmupLocalSpeechModel = async (
    model: string,
): Promise<LocalModelWarmupResponse> => {
    const normalized = normalizeLocalWhisperModel(model);
    if (!normalized) {
        throw new Error('Model name is missing.');
    }
    if (warmupModels.has(normalized)) {
        throw new Error('Model warmup already in progress.');
    }
    warmupModels.add(normalized);
    notifyWarmup();
    let releaseActivity: (() => Promise<void>) | null = null;
    try {
        releaseActivity = await beginNativeRendererActivity('Warming local speech model');
        const {data} = await axios.post<LocalModelWarmupResponse>(
            `${await resolveBaseUrl()}${MODELS_WARMUP_ENDPOINT}`,
            {model: normalized, device: await resolveDevice()},
            {
                headers: {'Content-Type': 'application/json'},
                timeout: 2 * 60 * 1000,
            },
        );
        return data;
    } finally {
        await releaseActivity?.();
        warmupModels.delete(normalized);
        notifyWarmup();
    }
};

export const markLocalModelUnknown = (model: string) => {
    const normalized = normalizeLocalWhisperModel(model);
    if (!normalized) {
        return;
    }
    modelCache.delete(normalized);
};
