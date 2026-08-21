import {describe, expect, it, vi} from 'vitest';
import {DisposableScope} from '../src/renderer/app/disposableScope';

describe('DisposableScope', () => {
    it('disposes registered effects once in reverse ownership order', async () => {
        const calls: string[] = [];
        const scope = new DisposableScope();
        scope.add(() => {
            calls.push('first');
        });
        scope.add(async () => {
            await Promise.resolve();
            calls.push('second');
        });

        await Promise.all([scope.dispose(), scope.dispose()]);

        expect(calls).toEqual(['second', 'first']);
    });

    it('immediately cleans up subscriptions that resolve after unmount', async () => {
        const cleanup = vi.fn();
        const scope = new DisposableScope();
        await scope.dispose();

        scope.add(cleanup);
        await Promise.resolve();

        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('isolates cleanup failures so all resources are released', async () => {
        const cleanup = vi.fn();
        const scope = new DisposableScope();
        scope.add(cleanup);
        scope.add(() => {
            throw new Error('cleanup failure');
        });

        await expect(scope.dispose()).resolves.toBeUndefined();
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
