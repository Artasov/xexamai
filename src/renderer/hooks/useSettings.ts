import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '../types';
import { DefaultSettings } from '../types';
import { settingsStore } from '../state/settingsStore';
import { logger } from '../utils/logger';

type UseSettingsResult = {
    settings: AppSettings;
    loading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
    patchLocal: (partial: Partial<AppSettings>) => void;
};

export function useSettings(): UseSettingsResult {
    const [settings, setSettings] = useState<AppSettings>(DefaultSettings);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const snapshot = await settingsStore.load();
            setSettings(snapshot);
            setError(null);
        } catch (err) {
            const normalized = err instanceof Error ? err : new Error(String(err));
            logger.error('settings', 'Failed to load settings', { error: normalized.message });
            setError(normalized);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let unsubscribe: (() => void) | undefined;
        let cancelled = false;

        refresh().then(() => {
            if (cancelled) return;
            unsubscribe = settingsStore.subscribe((snapshot) => {
                if (!cancelled) {
                    setSettings(snapshot);
                }
            });
        }).catch(() => {
            // setError already handled in refresh
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [refresh]);

    const patchLocal = useCallback((partial: Partial<AppSettings>) => {
        settingsStore.patch(partial);
        setSettings((prev) => ({ ...prev, ...partial }));
    }, []);

    return useMemo(() => ({
        settings,
        loading,
        error,
        refresh,
        patchLocal,
    }), [settings, loading, error, refresh, patchLocal]);
}
