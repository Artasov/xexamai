export type StoreListener = () => void;

export type ExternalStore<T> = {
    getSnapshot: () => T;
    subscribe: (listener: StoreListener) => () => void;
    set: (next: T | ((current: T) => T)) => void;
    reset: () => void;
};

/** Small framework-neutral store designed for React.useSyncExternalStore. */
export function createExternalStore<T>(initialValue: T): ExternalStore<T> {
    let current = initialValue;
    const listeners = new Set<StoreListener>();

    return {
        getSnapshot: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next) {
            const value = typeof next === 'function'
                ? (next as (current: T) => T)(current)
                : next;
            if (Object.is(value, current)) return;
            current = value;
            for (const listener of [...listeners]) listener();
        },
        reset() {
            if (Object.is(current, initialValue)) return;
            current = initialValue;
            for (const listener of [...listeners]) listener();
        },
    };
}
