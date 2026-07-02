import axios, {AxiosRequestConfig} from 'axios';
import {resolveAuthApiBaseUrl} from '@shared/appUrls';
import {logger} from '../utils/logger';

export type AuthTokens = {
    access: string;
    refresh?: string | null;
};

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

export class AuthError extends Error {
    public status?: number;
    public details?: unknown;
    public headers?: Record<string, unknown>;

    constructor(message: string, status?: number, details?: unknown, headers?: Record<string, unknown>) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
        this.details = details;
        this.headers = headers;
    }
}

const AUTH_STORAGE_KEY = 'xexamai.auth.tokens';
const DEFAULT_BASE_URL = resolveAuthApiBaseUrl();
const JSON_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
};

type TokenResponsePayload = {
    access?: unknown;
    refresh?: unknown;
    [key: string]: unknown;
};

function readStorage(): AuthTokens | null {
    if (typeof window === 'undefined') return null;
    try {
        window.localStorage?.removeItem(AUTH_STORAGE_KEY);
    } catch (error) {
        logger.warn('auth', 'Failed to clear legacy token storage', {error});
    }
    return null;
}

function writeStorage(tokens: AuthTokens | null): void {
    if (typeof window === 'undefined') return;
    try {
        void tokens;
        window.localStorage?.removeItem(AUTH_STORAGE_KEY);
    } catch (error) {
        logger.warn('auth', 'Failed to clear token storage', {error});
    }
}

function redactUserForLog(user: AuthUser): Record<string, unknown> {
    return {
        id: user.id,
        hasEmail: Boolean(user.email),
        tiersAndFeaturesCount: Array.isArray(user.tiers_and_features)
            ? user.tiers_and_features.length
            : 0,
    };
}

function extractMessage(payload: unknown, fallback: string): string {
    if (!payload) return fallback;

    if (typeof payload === 'string') {
        return payload.trim().length ? payload.trim() : fallback;
    }

    if (Array.isArray(payload) && payload.length) {
        return extractMessage(payload[0], fallback);
    }

    if (typeof payload !== 'object') {
        return fallback;
    }

    const record = payload as Record<string, unknown>;

    if (typeof record.detail === 'string' && record.detail.trim()) {
        return record.detail.trim();
    }

    if (typeof record.message === 'string' && record.message.trim()) {
        return record.message.trim();
    }

    if (Array.isArray(record.non_field_errors) && record.non_field_errors.length) {
        return extractMessage(record.non_field_errors[0], fallback);
    }

    const firstKey = Object.keys(record).find((key) => {
        const value = record[key];
        return typeof value === 'string' || (Array.isArray(value) && value.length);
    });

    if (firstKey) {
        const value = record[firstKey];
        return extractMessage(value, fallback);
    }

    return fallback;
}

function normalizeError(error: unknown): AuthError {
    if (error instanceof AuthError) return error;

    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const payload = error.response?.data;
        const fallback = status
            ? `Request failed with status ${status}`
            : 'Network request failed';
        const message = extractMessage(payload, fallback);
        return new AuthError(message || fallback, status, payload, error.response?.headers as Record<string, unknown>);
    }
    if (error instanceof Error) {
        return new AuthError(error.message);
    }

    return new AuthError(String(error ?? 'Unknown error'));
}

export class AuthClient {
    private tokens: AuthTokens | null = null;
    private refreshPromise: Promise<string | null> | null = null;
    private baseUrl: string;

    constructor(baseUrl: string = DEFAULT_BASE_URL) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.tokens = readStorage();
    }

    public setBaseUrl(baseUrl: string): void {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    private buildHeaders(baseHeaders?: AxiosRequestConfig['headers'], accessToken?: string): Record<string, string> {
        const headers: Record<string, string> = {...JSON_HEADERS};
        const provided = baseHeaders as Record<string, unknown> | undefined;
        if (provided) {
            for (const [key, value] of Object.entries(provided)) {
                if (typeof value === 'string') {
                    headers[key] = value;
                }
            }
        }
        if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`;
        }
        return headers;
    }

    public initializeFromStorage(): AuthTokens | null {
        this.tokens = readStorage();
        return this.tokens;
    }

    public getTokens(): AuthTokens | null {
        return this.tokens ? {...this.tokens} : null;
    }

    public hasTokens(): boolean {
        return Boolean(this.tokens?.access);
    }

    public clearTokens(): void {
        this.tokens = null;
        writeStorage(null);
    }

    public storeTokens(tokens: AuthTokens): void {
        this.updateTokens(tokens);
    }

    public async login(email: string, password: string): Promise<AuthUser> {
        logger.info('network', 'POST /auth/login/ → start', {baseUrl: this.baseUrl, hasEmail: Boolean(email)});
        try {
            const {data} = await axios.post(`${this.baseUrl}/auth/login/`, {email, password}, {
                headers: {...JSON_HEADERS},
            });
            const tokens = this.parseTokenResponse(data);
            this.updateTokens(tokens);
            logger.info('network', 'POST /auth/login/ → success');
        } catch (error) {
            const normalized = normalizeError(error);
            logger.error('network', 'POST /auth/login/ → error', {
                status: normalized.status,
                message: normalized.message,
            });
            throw normalized;
        }

        try {
            const user = await this.getCurrentUser(true);
            logger.info('auth', 'User signed in');
            return user;
        } catch (error) {
            this.clearTokens();
            throw normalizeError(error);
        }
    }

    public async getCurrentUser(includeTiersAndFeatures: boolean = false): Promise<AuthUser> {
        const path = includeTiersAndFeatures ? '/me/?tiers_and_features=XEXAI' : '/me/';
        const label = `GET ${path}`;

        logger.info('auth', `${label} → start`);
        try {
            const user = await this.authenticatedRequest<AuthUser>({
                url: path,
                method: 'GET',
            });
            logger.info('auth', `${label} → success`, redactUserForLog(user));
            return user;
        } catch (error) {
            const normalized = normalizeError(error);
            logger.error('auth', `${label} → error`, {
                status: normalized.status,
                message: normalized.message,
            });
            throw normalized;
        }
    }

    public async refreshAccessToken(): Promise<string | null> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        const refreshToken = this.tokens?.refresh;
        if (!refreshToken) {
            this.clearTokens();
            return null;
        }

        this.refreshPromise = (async () => {
            logger.info('network', 'POST /auth/refresh/ → start', {baseUrl: this.baseUrl});
            try {
                const {data} = await axios.post(`${this.baseUrl}/auth/refresh/`, {refresh: refreshToken}, {
                    headers: {...JSON_HEADERS},
                });

                const tokens = this.parseTokenResponse(data);
                this.updateTokens(tokens);
                logger.debug('auth', 'Access token refreshed');
                logger.info('network', 'POST /auth/refresh/ → success');
                return tokens.access;
            } catch (error) {
                const normalized = normalizeError(error);
                logger.error('network', 'POST /auth/refresh/ → error', {
                    status: normalized.status,
                    message: normalized.message,
                });
                throw normalized;
            }
        })();

        try {
            return await this.refreshPromise;
        } catch (error) {
            this.clearTokens();
            throw normalizeError(error);
        } finally {
            this.refreshPromise = null;
        }
    }

    public async wsTicket(): Promise<string> {
        const payload = await this.authenticatedRequest<TokenResponsePayload>({
            url: '/auth/ws-ticket/',
            method: 'POST',
        });
        if (typeof payload.access !== 'string' || !payload.access.trim()) {
            throw new AuthError('Missing WebSocket ticket in response');
        }
        return payload.access;
    }

    public async request<T>(config: AxiosRequestConfig): Promise<T> {
        return this.authenticatedRequest<T>(config);
    }

    private updateTokens(next: AuthTokens): void {
        if (!next.access) {
            throw new AuthError('Missing access token in response');
        }

        const normalized: AuthTokens = {
            access: next.access,
            refresh: next.refresh ?? this.tokens?.refresh ?? null,
        };
        this.tokens = normalized;
        writeStorage(normalized);
    }

    private parseTokenResponse(payload: unknown): AuthTokens {
        if (!payload || typeof payload !== 'object') {
            throw new AuthError('Invalid token response');
        }

        const data = payload as TokenResponsePayload;
        if (typeof data.access !== 'string' || !data.access.trim()) {
            throw new AuthError('Missing access token in response');
        }

        return {
            access: data.access,
            refresh: typeof data.refresh === 'string' && data.refresh.length
                ? data.refresh
                : this.tokens?.refresh ?? null,
        };
    }

    private async authenticatedRequest<T>(config: AxiosRequestConfig, allowRetry: boolean = true): Promise<T> {
        const baseConfig: AxiosRequestConfig = {...config};
        const headers = this.buildHeaders(baseConfig.headers, this.tokens?.access || undefined);
        const method = (baseConfig.method || 'GET').toUpperCase();
        const url = baseConfig.url || '';

        const finalConfig: AxiosRequestConfig = {
            ...baseConfig,
            baseURL: this.baseUrl,
            headers,
        };

        logger.info('network', `${method} ${url} → start`, {baseUrl: this.baseUrl});
        try {
            const response = await axios.request<T>(finalConfig);
            logger.info('network', `${method} ${url} → success`, {status: response.status});
            return response.data;
        } catch (error) {
            if (allowRetry && axios.isAxiosError(error) && error.response?.status === 401) {
                logger.warn('network', `${method} ${url} → unauthorized, refreshing token`);
                try {
                    const refreshed = await this.refreshAccessToken();
                    if (refreshed) {
                        return this.authenticatedRequest<T>(config, false);
                    }
                } catch (refreshError) {
                    throw normalizeError(refreshError);
                }
            }

            const normalized = normalizeError(error);
            logger.error('network', `${method} ${url} → error`, {
                status: normalized.status,
                message: normalized.message,
            });
            throw normalized;
        }
    }
}

export const authClient = new AuthClient();
