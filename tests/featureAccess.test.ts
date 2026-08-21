import {describe, expect, it} from 'vitest';
import type {AuthUser, TiersAndFeatures} from '../src/shared/auth';
import {getUserTiersAndFeatures, hasFeatureAccess} from '../src/renderer/utils/features';

function product(ticker: string, value: boolean | string): TiersAndFeatures {
    return {
        token_id: 1,
        token_ticker: ticker,
        balance: '0',
        tiers: [],
        active_tier: null,
        active_features: {history: value},
        feature_schema: [],
    };
}

function user(products: TiersAndFeatures[]): AuthUser {
    return {
        id: 1,
        username: null,
        email: 'test@example.com',
        first_name: null,
        last_name: null,
        middle_name: null,
        birth_date: null,
        avatar: null,
        timezone: null,
        is_email_confirmed: true,
        tiers_and_features: products,
    };
}

describe('feature access trust boundary', () => {
    it('never falls back to entitlements from another product', () => {
        const account = user([product('OTHER', true)]);
        expect(getUserTiersAndFeatures(account)).toBeNull();
        expect(hasFeatureAccess(account, 'history')).toBe(false);
    });

    it('requires a literal boolean true from the XEXAI product', () => {
        expect(hasFeatureAccess(user([product('XEXAI', 'false')]), 'history')).toBe(false);
        expect(hasFeatureAccess(user([product('xexai', true)]), 'history')).toBe(true);
    });
});
