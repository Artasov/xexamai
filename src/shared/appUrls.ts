export const BACKEND_DOMAINS = ['xlartas.com', 'xlartas.ru'] as const;
export type BackendDomain = (typeof BACKEND_DOMAINS)[number];
export const DEFAULT_BACKEND_DOMAIN: BackendDomain = 'xlartas.com';

const BACKEND_DOMAIN_STORAGE_KEY = 'xexamai.backend.domain';

type EnvRecord = Record<string, string | undefined>;

function readFromProcessEnv(name: string): string | undefined {
    if (typeof process === 'undefined' || !process?.env) return undefined;
    const value = process.env[name];
    return typeof value === 'string' && value.trim().length ? value.trim() : undefined;
}

function readFromGlobalEnv(name: string): string | undefined {
    const globalEnv = (globalThis as { __XEXAMAI_ENV__?: EnvRecord } | undefined)?.__XEXAMAI_ENV__;
    if (!globalEnv) return undefined;
    const value = globalEnv[name];
    return typeof value === 'string' && value.trim().length ? value.trim() : undefined;
}

function normalizeBase(url?: string | null): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed.length) return null;
    try {
        const normalized = new URL(trimmed);
        normalized.pathname = normalized.pathname.replace(/\/+$/, '');
        if (!normalized.pathname) {
            normalized.pathname = '';
        }
        normalized.search = '';
        normalized.hash = '';
        const result = normalized.toString();
        return result.replace(/\/$/, '');
    } catch {
        return trimmed.replace(/\/+$/, '') || null;
    }
}

function readEnv(name: string): string | undefined {
    return readFromProcessEnv(name) ?? readFromGlobalEnv(name);
}

function resolveBackendDomain(domain: string | null | undefined): BackendDomain {
    return domain === 'xlartas.ru' ? 'xlartas.ru' : DEFAULT_BACKEND_DOMAIN;
}

function readStoredBackendDomain(): BackendDomain {
    if (typeof window === 'undefined') {
        return DEFAULT_BACKEND_DOMAIN;
    }
    try {
        return resolveBackendDomain(window.localStorage?.getItem(BACKEND_DOMAIN_STORAGE_KEY));
    } catch {
        return DEFAULT_BACKEND_DOMAIN;
    }
}

function persistBackendDomain(domain: BackendDomain): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage?.setItem(BACKEND_DOMAIN_STORAGE_KEY, domain);
    } catch {
    }
}

let currentBackendDomain: BackendDomain = readStoredBackendDomain();

export function getBackendDomain(): BackendDomain {
    return currentBackendDomain;
}

export function setBackendDomain(domain: string | null | undefined): BackendDomain {
    const resolved = resolveBackendDomain(domain);
    currentBackendDomain = resolved;
    persistBackendDomain(resolved);
    return resolved;
}

export function getSiteBaseUrl(domain?: string | null): string {
    const resolved = resolveBackendDomain(domain ?? currentBackendDomain);
    return `https://${resolved}`;
}

export function getWsBaseUrl(domain?: string | null): string {
    const resolved = resolveBackendDomain(domain ?? currentBackendDomain);
    return `wss://${resolved}`;
}

export function getAuthApiBaseUrl(domain?: string | null): string {
    return `${getSiteBaseUrl(domain)}/api/v1`;
}

// noinspection JSUnusedGlobalSymbols
export function resolveSiteBaseUrl(): string {
    const envValue = readEnv('XEXAMAI_SITE_BASE_URL') ??
        readEnv('APP_BASE_URL') ??
        readEnv('OAUTH_BASE_URL');
    return normalizeBase(envValue) ?? getSiteBaseUrl();
}

export function resolveAuthApiBaseUrl(): string {
    const envValue = readEnv('XEXAMAI_AUTH_API_BASE_URL') ??
        readEnv('XEXAMAI_API_BASE_URL') ??
        readEnv('API_BASE_URL');
    return normalizeBase(envValue) ?? getAuthApiBaseUrl();
}
