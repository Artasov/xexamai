import {beforeEach, describe, expect, it, vi} from 'vitest';

const {invokeNative} = vi.hoisted(() => ({invokeNative: vi.fn()}));

vi.mock('../src/renderer/bridge/nativeInvoke', () => ({
    invokeNative,
    invokeNativeWithArgs: invokeNative,
}));

vi.mock('../src/renderer/utils/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import {AuthClient, AuthError} from '../src/renderer/services/authClient';

describe('login session preservation', () => {
    beforeEach(() => {
        invokeNative.mockReset();
    });

    it('keeps a securely established session when the profile request is temporarily offline', async () => {
        const client = new AuthClient('https://xlartas.com/api/v1');
        invokeNative.mockResolvedValueOnce({access: 'short-lived-access', user: {}});
        vi.spyOn(client, 'getCurrentUser').mockRejectedValueOnce(new AuthError('Network request failed'));

        await expect(client.login('person@example.com', 'password')).rejects.toThrow('Network request failed');

        expect(client.hasTokens()).toBe(true);
        expect(invokeNative).toHaveBeenCalledTimes(1);
        expect(invokeNative).not.toHaveBeenCalledWith('auth_session_logout', expect.anything());
    });

    it('invalidates an established session after a terminal profile response', async () => {
        const client = new AuthClient('https://xlartas.com/api/v1');
        invokeNative
            .mockResolvedValueOnce({access: 'short-lived-access', user: {}})
            .mockResolvedValueOnce(undefined);
        vi.spyOn(client, 'getCurrentUser').mockRejectedValueOnce(
            new AuthError('Session expired', 401),
        );

        await expect(client.login('person@example.com', 'password')).rejects.toThrow('Session expired');

        expect(client.hasTokens()).toBe(false);
        expect(invokeNative).toHaveBeenNthCalledWith(2, 'auth_session_logout', undefined);
    });
});
