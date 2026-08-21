import {describe, expect, it} from 'vitest';

import {isAutomaticAuthRetryAllowed} from '../src/renderer/services/authClient';

describe('authenticated request retry policy', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])(
        'allows replay of idempotent %s requests after refresh',
        (method) => {
            expect(isAutomaticAuthRetryAllowed({url: '/resource', method})).toBe(true);
        },
    );

    it.each(['POST', 'PATCH'])('does not replay non-idempotent %s requests', (method) => {
        expect(isAutomaticAuthRetryAllowed({url: '/resource', method})).toBe(false);
    });

    it('allows a non-idempotent request only with an explicit idempotency key', () => {
        expect(
            isAutomaticAuthRetryAllowed({
                url: '/resource',
                method: 'POST',
                headers: {'Idempotency-Key': 'operation-123'},
            }),
        ).toBe(true);
    });
});
