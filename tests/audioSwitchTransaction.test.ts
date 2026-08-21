import {describe, expect, it, vi} from 'vitest';
import {runCaptureSwitchTransaction} from '../src/renderer/app/audioSession/switchTransaction';

describe('live audio capture transaction', () => {
    it('switches the native capture back when persistence fails after a successful replacement', async () => {
        const calls: string[] = [];
        const result = await runCaptureSwitchTransaction({
            switchRequired: true,
            switchToNew: vi.fn(async () => {
                calls.push('switch-new');
            }),
            persistNew: vi.fn(async () => {
                calls.push('persist-new');
                throw new Error('disk full');
            }),
            switchBack: vi.fn(async () => {
                calls.push('switch-old');
            }),
        });

        expect(calls).toEqual(['switch-new', 'persist-new', 'switch-old']);
        expect(result).toMatchObject({state: 'rolled-back'});
    });

    it('reports that the new source remains active when transactional rollback cannot start the old source', async () => {
        const result = await runCaptureSwitchTransaction({
            switchRequired: true,
            switchToNew: vi.fn(async () => undefined),
            persistNew: vi.fn(async () => {
                throw new Error('settings unavailable');
            }),
            switchBack: vi.fn(async () => {
                throw new Error('old endpoint disappeared');
            }),
        });

        expect(result).toMatchObject({
            state: 'new-active',
            error: expect.any(Error),
            rollbackError: expect.any(Error),
        });
    });
});
