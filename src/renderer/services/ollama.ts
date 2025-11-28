const MODEL_CACHE_TTL = 15_000;

type ModelCache = {
    models: string[];
    timestamp: number;
};

let installedModelCache: ModelCache | null = null;
const downloadingModels = new Set<string>();
const warmingModels = new Set<string>();
const downloadListeners = new Set<(models: Set<string>) => void>();
const warmupListeners = new Set<(models: Set<string>) => void>();

const notifyDownloads = () => {
    const snapshot = new Set(downloadingModels);
    downloadListeners.forEach((listener) => {
        try {
            listener(snapshot);
        } catch (error) {
            console.error('[ollama] download listener error', error);
        }
    });
};

const notifyWarmup = () => {
    const snapshot = new Set(warmingModels);
    warmupListeners.forEach((listener) => {
        try {
            listener(snapshot);
        } catch (error) {
            console.error('[ollama] warmup listener error', error);
        }
    });
};

export const normalizeOllamaModelName = (model: string): string => model?.trim().toLowerCase() || '';

export const checkOllamaInstalled = async (): Promise<boolean> => {
    try {
        return (await window.api?.ollama?.checkInstalled?.()) ?? false;
    } catch (error) {
        console.error('[ollama] Failed to check installation', error);
        throw error;
    }
};

export const listInstalledOllamaModels = async (options: { force?: boolean } = {}): Promise<string[]> => {
    if (!options.force && installedModelCache && Date.now() - installedModelCache.timestamp < MODEL_CACHE_TTL) {
        return installedModelCache.models;
    }
    try {
        const models = (await window.api?.ollama?.listModels?.()) ?? [];
        const normalized = models.map(normalizeOllamaModelName).filter(Boolean);
        installedModelCache = {models: normalized, timestamp: Date.now()};
        return normalized;
    } catch (error) {
        console.error('[ollama] Failed to list models', error);
        throw error;
    }
};

export const invalidateOllamaModelCache = () => {
    installedModelCache = null;
};

export const checkOllamaModelDownloaded = async (
    model: string,
    options: { force?: boolean } = {},
): Promise<boolean> => {
    const normalized = normalizeOllamaModelName(model);
    if (!normalized) {
        return false;
    }
    const models = await listInstalledOllamaModels(options);
    return models.includes(normalized);
};

const setDownloading = (model: string, active: boolean) => {
    const normalized = normalizeOllamaModelName(model);
    if (!normalized) {
        return;
    }
    if (active) {
        downloadingModels.add(normalized);
    } else {
        downloadingModels.delete(normalized);
    }
    notifyDownloads();
};

const setWarming = (model: string, active: boolean) => {
    const normalized = normalizeOllamaModelName(model);
    if (!normalized) {
        return;
    }
    if (active) {
        warmingModels.add(normalized);
    } else {
        warmingModels.delete(normalized);
    }
    notifyWarmup();
};

export const subscribeToOllamaDownloads = (
    listener: (models: Set<string>) => void,
): (() => void) => {
    downloadListeners.add(listener);
    listener(new Set(downloadingModels));
    return () => {
        downloadListeners.delete(listener);
    };
};

export const subscribeToOllamaWarmup = (listener: (models: Set<string>) => void): (() => void) => {
    warmupListeners.add(listener);
    listener(new Set(warmingModels));
    return () => {
        warmupListeners.delete(listener);
    };
};

export const isOllamaModelDownloading = (model: string): boolean =>
    downloadingModels.has(normalizeOllamaModelName(model));

export const isOllamaModelWarming = (model: string): boolean =>
    warmingModels.has(normalizeOllamaModelName(model));

export const downloadOllamaModel = async (model: string): Promise<void> => {
    const normalized = normalizeOllamaModelName(model);
    if (!normalized) {
        throw new Error('Model name is required.');
    }
    setDownloading(normalized, true);
    try {
        await window.api?.ollama?.pullModel?.(model);
        invalidateOllamaModelCache();
    } finally {
        setDownloading(normalized, false);
    }
};

export const warmupOllamaModel = async (model: string): Promise<void> => {
    const normalized = normalizeOllamaModelName(model);
    if (!normalized) {
        throw new Error('Model name is required.');
    }
    setWarming(normalized, true);
    try {
        await window.api?.ollama?.warmupModel?.(model);
    } finally {
        setWarming(normalized, false);
    }
};
