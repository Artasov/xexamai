import type {AppSettings} from '../types';

type SettingsListener = (settings: AppSettings) => void;

class SettingsStore {
    private current: AppSettings | null = null;
    private listeners = new Set<SettingsListener>();

    async load(): Promise<AppSettings> {
        this.current = await window.api.settings.get();
        this.notify();
        return this.get();
    }

    get(): AppSettings {
        if (!this.current) {
            throw new Error('Settings store not initialized');
        }
        return {...this.current};
    }

    subscribe(listener: SettingsListener): () => void {
        this.listeners.add(listener);
        if (this.current) {
            listener(this.get());
        }
        return () => {
            this.listeners.delete(listener);
        };
    }

    patch(partial: Partial<AppSettings>): void {
        if (!this.current) return;
        this.current = {...this.current, ...partial};
        this.notify();
    }

    async refresh(): Promise<void> {
        await this.load();
    }

    private notify(): void {
        if (!this.current) return;
        const snapshot = this.get();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
            }
        }
    }
}

export const settingsStore = new SettingsStore();
