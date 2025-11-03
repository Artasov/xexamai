import type {AuthUser, TiersAndFeatures, TierFeatures} from '../services/authClient';

export function getUserTiersAndFeatures(user: AuthUser | null): TiersAndFeatures | null {
    if (!user?.tiers_and_features || !Array.isArray(user.tiers_and_features) || user.tiers_and_features.length === 0) {
        return null;
    }
    return user.tiers_and_features[0] || null;
}

export function hasFeatureAccess(user: AuthUser | null, featureCode: 'screen_processing' | 'history' | 'promt_presets'): boolean {
    const tiersAndFeatures = getUserTiersAndFeatures(user);
    if (!tiersAndFeatures?.active_features) {
        return false;
    }
    return tiersAndFeatures.active_features[featureCode] === true;
}

export function getActiveTier(user: AuthUser | null): { tier: string; balance: string; ticker: string } | null {
    const tiersAndFeatures = getUserTiersAndFeatures(user);
    if (!tiersAndFeatures?.active_tier) {
        return null;
    }
    return {
        tier: tiersAndFeatures.active_tier.name,
        balance: tiersAndFeatures.balance,
        ticker: tiersAndFeatures.token_ticker,
    };
}

