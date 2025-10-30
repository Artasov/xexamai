import {AuthProvider} from '../../shared/ipc';
import {resolveSiteBaseUrl} from '../../shared/appUrls';

function normalizeBase(url?: string): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed.length) return null;
    try {
        const normalized = new URL(trimmed);
        normalized.pathname = normalized.pathname.replace(/\/+$/, '');
        normalized.search = '';
        normalized.hash = '';
        return normalized.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function getEnv(name: string): string | undefined {
    const value = process.env[name];
    if (!value || !value.trim().length) return undefined;
    return value.trim();
}

export function resolveOAuthRedirectBase(): string {
    const defaultBase = resolveSiteBaseUrl();
    const fromEnv =
        normalizeBase(getEnv('OAUTH_REDIRECT_BASE_URL')) ??
        normalizeBase(getEnv('OAUTH_BASE_URL')) ??
        normalizeBase(getEnv('APP_BASE_URL')) ??
        normalizeBase(defaultBase) ??
        defaultBase;
    return fromEnv;
}

export function resolveOAuthStartBase(): string {
    const defaultBase = resolveSiteBaseUrl();
    const fromEnv =
        normalizeBase(getEnv('OAUTH_START_BASE_URL')) ??
        normalizeBase(getEnv('OAUTH_SITE_URL')) ??
        normalizeBase(getEnv('OAUTH_BASE_URL')) ??
        normalizeBase(getEnv('APP_BASE_URL')) ??
        normalizeBase(defaultBase) ??
        defaultBase;
    return fromEnv;
}

function providerOverride(provider: AuthProvider): string | undefined {
    const key = `OAUTH_PROVIDER_URL_${provider.toUpperCase()}`;
    return getEnv(key);
}

export function buildOAuthStartUrl(provider: AuthProvider): string {
    const override = providerOverride(provider);
    if (override) {
        return override;
    }

    const startBase = resolveOAuthStartBase();
    const url = new URL(`/auth/oauth/${provider}/start`, startBase);
    url.searchParams.set('app_auth', 'xexamai');
    return url.toString();
}
