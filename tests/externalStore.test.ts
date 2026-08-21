import {describe, expect, it, vi} from 'vitest';
import {createExternalStore} from '../src/renderer/state/externalStore';

describe('createExternalStore', () => {
    it('publishes immutable snapshots and supports unsubscribe', () => {
        const store = createExternalStore({count: 0});
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        store.set((snapshot) => ({...snapshot, count: snapshot.count + 1}));
        expect(store.getSnapshot()).toEqual({count: 1});
        expect(listener).toHaveBeenCalledOnce();

        unsubscribe();
        store.set({count: 2});
        expect(listener).toHaveBeenCalledOnce();
    });

    it('does not notify when the snapshot identity is unchanged', () => {
        const initial = {ready: true};
        const store = createExternalStore(initial);
        const listener = vi.fn();
        store.subscribe(listener);

        store.set(initial);

        expect(listener).not.toHaveBeenCalled();
    });
});
