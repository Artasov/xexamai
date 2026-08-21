import {describe, expect, it} from 'vitest';
import {LatestIntentQueue} from '../src/renderer/app/latestIntentQueue';

describe('LatestIntentQueue', () => {
    it('serializes transitions and prevents an older awaited start from publishing stale state', async () => {
        const queue = new LatestIntentQueue();
        const events: string[] = [];
        let finishStart!: () => void;
        const start = queue.run(async (isCurrent) => {
            events.push('start-begin');
            await new Promise<void>((resolve) => {
                finishStart = resolve;
            });
            if (isCurrent()) events.push('start-published');
        });
        await Promise.resolve();
        const stop = queue.run(async (isCurrent) => {
            events.push('stop-begin');
            if (isCurrent()) events.push('stop-published');
        });

        finishStart();
        await Promise.all([start, stop]);

        expect(events).toEqual(['start-begin', 'stop-begin', 'stop-published']);
    });
});
