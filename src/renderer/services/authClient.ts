import type {NativeCommand, NativeCommandMap} from '../../shared/generated/NativeCommandMap';
import {invokeNativeWithArgs, type NativeCommandResult} from '../bridge/nativeInvoke';
import axios, {AxiosRequestConfig} from 'axios';
import {resolveAuthApiBaseUrl} from '@shared/appUrls';
import {logger} from '../utils/logger';
import {beginNativeRendererActivity} from '../state/rendererActivity';
import type {AuthUser, FeatureSchema, Tier, TierFeatures, TiersAndFeatures} from '@shared/auth';

export type {AuthUser, FeatureSchema, Tier, TierFeatures, TiersAndFeatures} from '@shared/auth';

export type AuthTokens = {
    access: string;
};

export class AuthError extends Error {
    public status?: number;
    public details?: unknown;
    public headers?: Record<string, unknown>;
    /** True only when a native login committed a new session before a later step failed. */
    public sessionEstablished?: boolean;

    constructor(message: string, status?: number, details?: unknown, headers?: Record<string, unknown>) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
        this.details = details;
        this.headers = headers;
    }
}

export type AuthSessionEvent = 'session-changed' | 'expired' | 'domain-changed' | 'signed-out';

type LegacyTokens = {
    access: string;
    refresh?: string;
};

const AUTH_STORAGE_KEY = 'xexamai.auth.tokens';
const FALLBACK_BASE_URL = 'https://xlartas.com/api/v1';
const JSON_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
};
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 45_000;

function normalizeAuthBaseUrl(value: string): string {
    const parsed = new URL(value);
    if (
        parsed.protocol !== 'https:' ||
        !['xlartas.com', 'xlartas.ru'].includes(parsed.hostname) ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname.replace(/\/+$/, '') !== '/api/v1'
    ) {
        throw new AuthError('Unsupported authentication server');
    }
    return `${parsed.origin}/api/v1`;
}

function initialBaseUrl(): string {
    try {
        return normalizeAuthBaseUrl(resolveAuthApiBaseUrl());
    } catch {
        return FALLBACK_BASE_URL;
    }
}

function takeLegacyTokens(): LegacyTokens | null {
    if (typeof window === 'undefined') return null;
    let parsed: LegacyTokens | null = null;
    try {
        const raw = window.localStorage?.getItem(AUTH_STORAGE_KEY);
        if (raw) {
            const candidate = JSON.parse(raw) as Partial<LegacyTokens> | null;
            if (candidate && typeof candidate.access === 'string' && candidate.access.trim()) {
                parsed = {
                    access: candidate.access,
                    refresh: typeof candidate.refresh === 'string' && candidate.refresh.trim()
                        ? candidate.refresh
                        : undefined,
                };
            }
        }
    } catch {
        // Corrupt legacy storage is discarded; never copy it into the credential store.
    } finally {
        try {
            window.localStorage?.removeItem(AUTH_STORAGE_KEY);
        } catch {
        }
    }
    return parsed;
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
    if (typeof payload === 'string') return payload.trim() || fallback;
    if (Array.isArray(payload) && payload.length) return extractMessage(payload[0], fallback);
    if (typeof payload !== 'object') return fallback;
    const record = payload as Record<string, unknown>;
    if (typeof record.detail === 'string' && record.detail.trim()) return record.detail.trim();
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
    if (Array.isArray(record.non_field_errors) && record.non_field_errors.length) {
        return extractMessage(record.non_field_errors[0], fallback);
    }
    const firstKey = Object.keys(record).find((key) => {
        const value = record[key];
        return typeof value === 'string' || (Array.isArray(value) && value.length);
    });
    return firstKey ? extractMessage(record[firstKey], fallback) : fallback;
}

function normalizeError(error: unknown): AuthError {
    if (error instanceof AuthError) return error;
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const payload = error.response?.data;
        const fallback = status ? `Request failed with status ${status}` : 'Network request failed';
        return new AuthError(
            extractMessage(payload, fallback),
            status,
            payload,
            error.response?.headers as Record<string, unknown>,
        );
    }
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        const message = typeof record.message === 'string' && record.message.trim()
            ? record.message
            : 'Authentication request failed';
        const status = typeof record.status === 'number' ? record.status : undefined;
        return new AuthError(message, status, record);
    }
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown authentication error';
    const statusMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    return new AuthError(message, status);
}

export function isAutomaticAuthRetryAllowed(config: AxiosRequestConfig): boolean {
    const method = (config.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method)) return true;
    const headers = config.headers as
        | (Record<string, unknown> & {get?: (name: string) => unknown})
        | undefined;
    const direct = headers?.get?.('Idempotency-Key');
    if (typeof direct === 'string' && direct.trim()) return true;
    return Object.entries(headers || {}).some(
        ([name, value]) =>
            name.toLowerCase() === 'idempotency-key' &&
            typeof value === 'string' &&
            Boolean(value.trim()),
    );
}

async function invokeWithTimeout<C extends NativeCommand>(
    command: C,
    args: NativeCommandMap[C]['args'],
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<NativeCommandResult<C>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            invokeNativeWithArgs(command, args),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new AuthError('Authentication operation timed out')), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export class AuthClient {
    private accessToken: string | null = null;
    private refreshPromise: {epoch: number; promise: Promise<string | null>} | null = null;
    private baseUrl: string;
    private sessionEpoch = 0;
    private readonly activeRequests = new Set<AbortController>();
    private readonly listeners = new Set<(event: AuthSessionEvent) => void>();

    constructor(baseUrl: string = initialBaseUrl()) {
        this.baseUrl = normalizeAuthBaseUrl(baseUrl);
    }

    public subscribe(listener: (event: AuthSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public setBaseUrl(baseUrl: string, options: {notify?: boolean} = {}): void {
        const normalized = normalizeAuthBaseUrl(baseUrl);
        if (normalized === this.baseUrl) return;
        this.baseUrl = normalized;
        this.invalidateMemory(options.notify === false ? undefined : 'domain-changed');
    }

    public getBackendOrigin(): string {
        return new URL(this.baseUrl).origin;
    }

    public async initializeSession(): Promise<AuthTokens | null> {
        const epoch = this.beginOperation();
        const legacy = takeLegacyTokens();
        try {
            const capability = legacy
                ? await invokeWithTimeout('auth_session_import_legacy', {tokens: legacy})
                : await invokeWithTimeout('auth_session_bootstrap', undefined);
            if (!this.isCurrent(epoch)) return null;
            this.accessToken = capability?.access?.trim() || null;
            if (this.accessToken) this.notify('session-changed');
            return this.getTokens();
        } catch (error) {
            if (this.isCurrent(epoch)) this.accessToken = null;
            throw normalizeError(error);
        }
    }

    public getTokens(): AuthTokens | null {
        return this.accessToken ? {access: this.accessToken} : null;
    }

    public hasTokens(): boolean {
        return Boolean(this.accessToken);
    }

    public async login(email: string, password: string): Promise<AuthUser> {
        const epoch = this.beginOperation(true);
        let sessionEstablished = false;
        logger.info('auth', 'Sign-in started', {baseUrl: this.baseUrl, hasEmail: Boolean(email)});
        try {
            const result = await invokeWithTimeout('auth_session_login', {email, password});
            if (!this.isCurrent(epoch)) throw new AuthError('Authentication operation was superseded');
            this.accessToken = result.access;
            sessionEstablished = true;
            this.notify('session-changed');
            const user = await this.getCurrentUser(true, epoch);
            logger.info('auth', 'User signed in', redactUserForLog(user));
            return user;
        } catch (error) {
            const normalized = normalizeError(error);
            normalized.sessionEstablished = sessionEstablished;
            // A profile/network failure after the native login committed a token
            // pair must not destroy the recoverable secure session. Only a
            // terminal response for that established session invalidates it.
            if (
                sessionEstablished &&
                this.isCurrent(epoch) &&
                normalized.status != null &&
                [400, 401, 403].includes(normalized.status)
            ) {
                await this.logout(false);
            }
            throw normalized;
        }
    }

    public async adoptOAuthSession(): Promise<AuthTokens | null> {
        const epoch = this.beginOperation(true);
        const capability = await invokeWithTimeout('auth_session_bootstrap', undefined);
        if (!this.isCurrent(epoch)) return null;
        this.accessToken = capability?.access?.trim() || null;
        if (this.accessToken) this.notify('session-changed');
        return this.getTokens();
    }

    public async logout(notify: boolean = true): Promise<void> {
        this.invalidateMemory(notify ? 'signed-out' : undefined);
        try {
            await invokeWithTimeout('auth_session_logout', undefined, 10_000);
        } catch (error) {
            // Local memory is already invalidated and Rust clears keyring before its
            // best-effort backend logout. Logging out must remain deterministic.
            logger.warn('auth', 'Secure session cleanup reported an error', {
                error: normalizeError(error).message,
            });
        }
    }

    public async getCurrentUser(
        includeTiersAndFeatures: boolean = false,
        expectedEpoch: number = this.sessionEpoch,
    ): Promise<AuthUser> {
        const path = includeTiersAndFeatures ? '/me/?tiers_and_features=XEXAI' : '/me/';
        const user = await this.authenticatedRequest<AuthUser>({url: path, method: 'GET'}, true, expectedEpoch);
        logger.info('auth', 'Profile loaded', redactUserForLog(user));
        return user;
    }

    public async refreshAccessToken(): Promise<string | null> {
        const epoch = this.sessionEpoch;
        if (this.refreshPromise?.epoch === epoch) return this.refreshPromise.promise;
        const promise = (async () => {
            try {
                const capability = await invokeWithTimeout('auth_session_refresh', undefined);
                if (!this.isCurrent(epoch)) return null;
                this.accessToken = capability.access;
                this.notify('session-changed');
                return capability.access;
            } catch (error) {
                const normalized = normalizeError(error);
                if (
                    this.isCurrent(epoch) &&
                    normalized.status != null &&
                    [400, 401, 403].includes(normalized.status)
                ) {
                    this.invalidateMemory('expired');
                    void invokeWithTimeout('auth_session_logout', undefined, 10_000).catch(() => undefined);
                }
                throw normalized;
            }
        })();
        this.refreshPromise = {epoch, promise};
        try {
            return await promise;
        } finally {
            if (this.refreshPromise?.promise === promise) this.refreshPromise = null;
        }
    }

    public async wsTicket(): Promise<string> {
        const payload = await this.authenticatedRequest<{access?: unknown}>({
            url: '/auth/ws-ticket/',
            method: 'POST',
            // Ticket creation is safe to replay after a 401; the first request did
            // not authenticate and therefore could not create a ticket.
            headers: {'Idempotency-Key': crypto.randomUUID()},
        });
        if (typeof payload.access !== 'string' || !payload.access.trim()) {
            throw new AuthError('Missing WebSocket ticket in response');
        }
        return payload.access;
    }

    public async request<T>(config: AxiosRequestConfig): Promise<T> {
        return this.authenticatedRequest<T>(config);
    }

    private buildHeaders(baseHeaders?: AxiosRequestConfig['headers'], accessToken?: string): Record<string, string> {
        const headers: Record<string, string> = {...JSON_HEADERS};
        const provided = baseHeaders as Record<string, unknown> | undefined;
        if (provided) {
            for (const [key, value] of Object.entries(provided)) {
                if (typeof value === 'string' && !['authorization', 'cookie'].includes(key.toLowerCase())) {
                    headers[key] = value;
                }
            }
        }
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        return headers;
    }

    private async authenticatedRequest<T>(
        config: AxiosRequestConfig,
        allowRetry: boolean = true,
        expectedEpoch: number = this.sessionEpoch,
    ): Promise<T> {
        const url = config.url || '';
        if (!url.startsWith('/') || url.startsWith('//')) {
            throw new AuthError('Unsupported authenticated API path');
        }
        if (!this.accessToken) throw new AuthError('No authentication session', 401);
        if (!this.isCurrent(expectedEpoch)) throw new AuthError('Authentication operation was superseded');

        const controller = new AbortController();
        const userSignal = config.signal;
        const abortFromUser = () => controller.abort((userSignal as AbortSignal & {reason?: unknown})?.reason);
        if (userSignal?.aborted) abortFromUser();
        else userSignal?.addEventListener?.('abort', abortFromUser, {once: true});
        this.activeRequests.add(controller);
        const method = (config.method || 'GET').toUpperCase();
        let releaseActivity: (() => Promise<void>) | null = null;
        try {
            releaseActivity = await beginNativeRendererActivity(`${method} backend request`);
            const response = await axios.request<T>({
                ...config,
                url,
                baseURL: this.baseUrl,
                headers: this.buildHeaders(config.headers, this.accessToken),
                timeout: Math.min(Math.max(config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS, 1_000), 300_000),
                signal: controller.signal,
            });
            if (!this.isCurrent(expectedEpoch)) throw new AuthError('Authentication operation was superseded');
            logger.info('network', `${method} ${url} → success`, {status: response.status});
            return response.data;
        } catch (error) {
            if (
                allowRetry &&
                isAutomaticAuthRetryAllowed(config) &&
                this.isCurrent(expectedEpoch) &&
                axios.isAxiosError(error) &&
                error.response?.status === 401
            ) {
                const refreshed = await this.refreshAccessToken();
                if (refreshed && this.isCurrent(expectedEpoch)) {
                    return this.authenticatedRequest<T>(config, false, expectedEpoch);
                }
            }
            throw normalizeError(error);
        } finally {
            this.activeRequests.delete(controller);
            userSignal?.removeEventListener?.('abort', abortFromUser);
            if (releaseActivity) {
                await releaseActivity().catch((error) => {
                    logger.warn('activity', 'Failed to release backend activity lease', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
        }
    }

    private beginOperation(invalidateExisting: boolean = false): number {
        if (invalidateExisting) {
            this.invalidateMemory(undefined);
        }
        return this.sessionEpoch;
    }

    private isCurrent(epoch: number): boolean {
        return this.sessionEpoch === epoch;
    }

    private invalidateMemory(event?: AuthSessionEvent): void {
        this.sessionEpoch += 1;
        this.accessToken = null;
        this.refreshPromise = null;
        for (const controller of this.activeRequests) controller.abort('session-invalidated');
        this.activeRequests.clear();
        if (event) this.notify(event);
    }

    private notify(event: AuthSessionEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
            }
        }
    }
}

export const authClient = new AuthClient();
