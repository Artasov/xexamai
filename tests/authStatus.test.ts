import {describe, expect, it} from 'vitest';
import {statusAfterOAuthExit} from '../src/renderer/auth/auth-context';

describe('OAuth UI status recovery', () => {
    it('never mounts an authenticated app without a restored user snapshot', () => {
        expect(statusAfterOAuthExit(false, true)).toBe('restore-failed');
        expect(statusAfterOAuthExit(false, false)).toBe('unauthenticated');
        expect(statusAfterOAuthExit(true, true)).toBe('authenticated');
        expect(statusAfterOAuthExit(false, false, 'restore-failed')).toBe('restore-failed');
    });
});
