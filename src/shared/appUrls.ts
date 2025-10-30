// const DEFAULT_SITE_BASE_URL = 'https://xldev.ru';
// const DEFAULT_AUTH_API_BASE_URL = 'https://xldev.ru/api/v1';
const DEFAULT_SITE_BASE_URL = 'http://localhost:3000';
const DEFAULT_AUTH_API_BASE_URL = 'http://localhost:8000/api/v1';

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

export function resolveSiteBaseUrl(): string {
    return (
        normalizeBase(
            readEnv('XEXAMAI_SITE_BASE_URL') ??
            readEnv('APP_BASE_URL') ??
            readEnv('OAUTH_BASE_URL'),
        ) ?? DEFAULT_SITE_BASE_URL
    );
}

export function resolveAuthApiBaseUrl(): string {
    const envValue = readEnv('XEXAMAI_AUTH_API_BASE_URL') ?? readEnv('XEXAMAI_API_BASE_URL') ?? readEnv('API_BASE_URL');
    const normalized = normalizeBase(envValue);
    return normalized ?? DEFAULT_AUTH_API_BASE_URL;
}

