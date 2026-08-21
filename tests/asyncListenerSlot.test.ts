import {describe, expect, it, vi} from 'vitest';
import {AsyncListenerSlot, type AsyncListenerDisposer} from '@renderer/bridge/asyncListenerSlot';

type DeferredRegistration<T> = {
    register: (emit: (value: T) => void) => Promise<AsyncListenerDisposer>;
    emit: (value: T) => void;
    resolve: (disposer: AsyncListenerDisposer) => void;
};

function deferredRegistration<T>(): DeferredRegistration<T> {
    let emit: (value: T) => void = () => undefined;
    let resolve!: (disposer: AsyncListenerDisposer) => void;
    return {
        register: (nextEmit) => {
            emit = nextEmit;
            return new Promise<AsyncListenerDisposer>((nextResolve) => {
                resolve = nextResolve;
            });
        },
        emit: (value) => emit(value),
        resolve: (disposer) => resolve(disposer),
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('AsyncListenerSlot', () => {
    it('disposes a listener that resolves after the owning session was cleared', async () => {
        const registration = deferredRegistration<number>();
        const listener = vi.fn();
        const unlisten = vi.fn();
        const slot = new AsyncListenerSlot<number>();

        slot.replace(registration.register, listener);
        await flushPromises();
        slot.clear();

        // A Tauri listener may already emit while its listen Promise is still
        // unresolved. The generation guard must suppress that stale callback.
        registration.emit(1);
        registration.resolve(unlisten);
        await flushPromises();

        expect(listener).not.toHaveBeenCalled();
        expect(unlisten).toHaveBeenCalledOnce();
    });

    it('keeps only the newest replacement active across out-of-order resolution', async () => {
        const first = deferredRegistration<string>();
        const second = deferredRegistration<string>();
        const firstUnlisten = vi.fn();
        const secondUnlisten = vi.fn();
        const listener = vi.fn();
        const slot = new AsyncListenerSlot<string>();

        slot.replace(first.register, listener);
        await flushPromises();
        slot.replace(second.register, listener);
        await flushPromises();

        second.resolve(secondUnlisten);
        first.resolve(firstUnlisten);
        await flushPromises();
        first.emit('stale');
        second.emit('current');

        expect(firstUnlisten).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith('current');

        slot.clear();
        await flushPromises();
        expect(secondUnlisten).toHaveBeenCalledOnce();
    });
});
