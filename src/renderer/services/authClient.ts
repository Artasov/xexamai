import axios, {AxiosRequestConfig} from 'axios';
import {resolveAuthApiBaseUrl} from '../../shared/appUrls';
import {logger} from '../utils/logger';

export type AuthTokens = {
    access: string;
    refresh?: string | null;
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
};

export class AuthError extends Error {
    public status?: number;
    public details?: unknown;

    constructor(message: string, status?: number, details?: unknown) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
        this.details = details;
    }
}

const AUTH_STORAGE_KEY = 'xexamai.auth.tokens';
const DEFAULT_BASE_URL = resolveAuthApiBaseUrl();

type TokenResponsePayload = {
    access?: unknown;
    refresh?: unknown;
    [key: string]: unknown;
};

function readStorage(): AuthTokens | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage?.getItem(AUTH_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as AuthTokens;
        if (!parsed || typeof parsed.access !== 'string') return null;
        return {
            access: parsed.access,
            refresh: typeof parsed.refresh === 'string' ? parsed.refresh : null,
        };
    } catch (error) {
        logger.warn('auth', 'Failed to read tokens from storage', { error });
        return null;
    }
}

function writeStorage(tokens: AuthTokens | null): void {
    if (typeof window === 'undefined') return;
    try {
        if (!tokens) {
            window.localStorage?.removeItem(AUTH_STORAGE_KEY);
            return;
        }
        window.localStorage?.setItem(
            AUTH_STORAGE_KEY,
            JSON.stringify({
                access: tokens.access,
                refresh: tokens.refresh ?? null,
            }),
        );
    } catch (error) {
        logger.warn('auth', 'Failed to write tokens to storage', { error });
    }
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
        return new AuthError(message || fallback, status, payload);
    }

    if (error instanceof Error) {
        return new AuthError(error.message);
    }

    return new AuthError(String(error ?? 'Unknown error'));
}

export class AuthClient {
    private tokens: AuthTokens | null = null;
    private refreshPromise: Promise<string | null> | null = null;
    private readonly baseUrl: string;

    constructor(baseUrl: string = DEFAULT_BASE_URL) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.tokens = readStorage();
    }

    public initializeFromStorage(): AuthTokens | null {
        this.tokens = readStorage();
        return this.tokens;
    }

    public getTokens(): AuthTokens | null {
        return this.tokens ? { ...this.tokens } : null;
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
        try {
            const { data } = await axios.post(`${this.baseUrl}/auth/login/`, { email, password }, {
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            });
            const tokens = this.parseTokenResponse(data);
            this.updateTokens(tokens);
        } catch (error) {
            throw normalizeError(error);
        }

        try {
            const user = await this.getCurrentUser();
            logger.info('auth', 'User signed in');
            return user;
        } catch (error) {
            this.clearTokens();
            throw normalizeError(error);
        }
    }

    public async getCurrentUser(): Promise<AuthUser> {
        return this.authenticatedRequest<AuthUser>({
            url: '/me/',
            method: 'GET',
        });
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
            try {
                const { data } = await axios.post(`${this.baseUrl}/auth/refresh/`, { refresh: refreshToken }, {
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                });

                const tokens = this.parseTokenResponse(data);
                this.updateTokens(tokens);
                logger.debug('auth', 'Access token refreshed');
                return tokens.access;
            } catch (error) {
                throw normalizeError(error);
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

        const next: AuthTokens = {
            access: data.access,
            refresh: typeof data.refresh === 'string' && data.refresh.length
                ? data.refresh
                : this.tokens?.refresh ?? null,
        };

        return next;
    }

    private async authenticatedRequest<T>(config: AxiosRequestConfig, allowRetry: boolean = true): Promise<T> {
        const baseConfig: AxiosRequestConfig = { ...config };
        const headers: Record<string, string> = {
            Accept: 'application/json',
        };

        const providedHeaders = baseConfig.headers as Record<string, string> | undefined;
        if (providedHeaders) {
            for (const [key, value] of Object.entries(providedHeaders)) {
                if (typeof value === 'string') {
                    headers[key] = value;
                }
            }
        }

        if (this.tokens?.access) {
            headers.Authorization = `Bearer ${this.tokens.access}`;
        }

        const finalConfig: AxiosRequestConfig = {
            ...baseConfig,
            baseURL: this.baseUrl,
            headers,
        };

        try {
            const response = await axios.request<T>(finalConfig);
            return response.data;
        } catch (error) {
            if (allowRetry && axios.isAxiosError(error) && error.response?.status === 401) {
                try {
                    const refreshed = await this.refreshAccessToken();
                    if (refreshed) {
                        return this.authenticatedRequest<T>(config, false);
                    }
                } catch (refreshError) {
                    throw normalizeError(refreshError);
                }
            }

            throw normalizeError(error);
        }
    }
}

export const authClient = new AuthClient();
