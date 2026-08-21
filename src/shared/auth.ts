export type FeatureSchema = {
    id: number;
    code: string;
    label: string;
    description: string;
    kind: 'boolean' | string;
};

export type TierFeatures = {
    [code: string]: boolean | number | string | null | undefined;
};

export type Tier = {
    id: number;
    token_id: number | null;
    name: string;
    slug: string;
    token_threshold: string;
    position: number;
    is_active: boolean;
    description: string;
    features: TierFeatures;
};

export type TiersAndFeatures = {
    token_id: number | null;
    token_ticker: string;
    balance: string;
    tiers: Tier[];
    active_tier: Tier | null;
    active_features: TierFeatures;
    feature_schema: FeatureSchema[];
};

export type AuthUser = {
    id: number;
    username: string | null;
    email: string;
    first_name: string | null;
    last_name: string | null;
    middle_name: string | null;
    birth_date: string | null;
    avatar: string | null;
    timezone: string | Record<string, unknown> | null;
    is_email_confirmed: boolean;
    tiers_and_features?: TiersAndFeatures[];
};
