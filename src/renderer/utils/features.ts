import type {AuthUser, TiersAndFeatures, TierFeatures, Tier} from '../services/authClient';

export function getUserTiersAndFeatures(user: AuthUser | null): TiersAndFeatures | null {
    if (!user?.tiers_and_features || !Array.isArray(user.tiers_and_features) || user.tiers_and_features.length === 0) {
        return null;
    }
    const preferred = user.tiers_and_features.find(
        (item) => (item.token_ticker || '').toUpperCase() === 'XEXAI'
    );
    return preferred || user.tiers_and_features[0] || null;
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
    if (!tiersAndFeatures) return null;
    const activeTier = tiersAndFeatures.active_tier;
    return {
        tier: activeTier?.name || 'No active tier',
        balance: tiersAndFeatures.balance,
        ticker: tiersAndFeatures.token_ticker,
    };
}

export function getMinTierForFeature(
    user: AuthUser | null,
    featureCode: 'screen_processing' | 'history' | 'promt_presets'
): { tier: Tier; threshold: string } | null {
    const tiersAndFeatures = getUserTiersAndFeatures(user);
    if (!tiersAndFeatures?.tiers || !Array.isArray(tiersAndFeatures.tiers)) {
        return null;
    }

    // Находим минимальный tier с нужной фичей (сортировка по position)
    const sortedTiers = [...tiersAndFeatures.tiers]
        .filter((tier) => tier.is_active && tier.features[featureCode] === true)
        .sort((a, b) => a.position - b.position);

    if (sortedTiers.length === 0) {
        return null;
    }

    const minTier = sortedTiers[0];
    return {
        tier: minTier,
        threshold: minTier.token_threshold,
    };
}

