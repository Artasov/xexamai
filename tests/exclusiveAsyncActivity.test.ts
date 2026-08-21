import {describe, expect, it, vi} from 'vitest';
import {ExclusiveAsyncActivity, type AsyncActivityRelease} from '../src/renderer/auth/exclusiveAsyncActivity';

describe('ExclusiveAsyncActivity', () => {
    it('rejects a concurrent begin before the first acquisition resolves', async () => {
        let finishAcquire!: (release: AsyncActivityRelease) => void;
        const release = vi.fn(async () => undefined);
        const activity = new ExclusiveAsyncActivity('already active');
        const first = activity.begin(() => new Promise((resolve) => {
            finishAcquire = resolve;
        }));

        await expect(activity.begin(async () => release)).rejects.toThrow('already active');
        finishAcquire(release);
        await first;
        await activity.end();

        expect(release).toHaveBeenCalledTimes(1);
        expect(activity.active).toBe(false);
    });

    it('retains a lease when release fails so cleanup can be retried', async () => {
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('temporary IPC failure'))
            .mockResolvedValueOnce(undefined);
        const activity = new ExclusiveAsyncActivity('already active');
        await activity.begin(async () => release);

        await expect(activity.end()).rejects.toThrow('temporary IPC failure');
        expect(activity.active).toBe(true);
        await activity.end();
        expect(activity.active).toBe(false);
        expect(release).toHaveBeenCalledTimes(2);
    });
});
