import {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {authClient, AuthError, AuthUser} from '../services/authClient';
import {logger} from '../utils/logger';
import type {AuthDeepLinkPayload, AuthProvider as OAuthProviderType} from '../types';

type AuthStatus =
    | 'initializing'
    | 'checking'
    | 'unauthenticated'
    | 'signing-in'
    | 'oauth'
    | 'authenticated';

type AuthContextValue = {
    status: AuthStatus;
    user: AuthUser | null;
    error: string | null;
    isAuthenticated: boolean;
    signIn: (email: string, password: string) => Promise<AuthUser>;
    startOAuth: (provider: OAuthProviderType) => Promise<void>;
    signOut: () => void;
    reloadUser: () => Promise<AuthUser | null>;
    clearError: () => void;
    isBusy: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

type AuthProviderProps = {
    children: ReactNode;
};

function normalizeAuthError(error: unknown): AuthError {
    if (error instanceof AuthError) return error;
    if (error instanceof Error) return new AuthError(error.message);
    return new AuthError(String(error ?? 'Unknown error'));
}

export function AuthProvider({ children }: AuthProviderProps) {
    const [status, setStatus] = useState<AuthStatus>('initializing');
    const [user, setUser] = useState<AuthUser | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const bootstrap = async () => {
            try {
                const tokens = authClient.initializeFromStorage();
                if (!tokens?.access) {
                    setStatus('unauthenticated');
                    setUser(null);
                    return;
                }

                setStatus('checking');
                const profile = await authClient.getCurrentUser(true);
                if (cancelled) return;
                setUser(profile);
                setStatus('authenticated');
                setError(null);
            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeAuthError(err);
                logger.warn('auth', 'Failed to restore session', { error: normalized.message, status: normalized.status });
                authClient.clearTokens();
                setUser(null);
                setStatus('unauthenticated');
                setError(null);
            }
        };

        bootstrap().catch((err) => {
            const normalized = normalizeAuthError(err);
            logger.error('auth', 'Session bootstrap failed', { error: normalized.message, status: normalized.status });
        });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!window.api?.auth) return;
        let cancelled = false;

        const handleOAuthPayload = (payload: AuthDeepLinkPayload) => {
            if (cancelled || !payload) return;
            if (payload.kind === 'success') {
                logger.info('auth', 'OAuth payload received', { provider: payload.provider });
                try {
                    authClient.storeTokens({
                        access: payload.tokens.access,
                        refresh: payload.tokens.refresh ?? null,
                    });
                } catch (error) {
                    const normalized = normalizeAuthError(error);
                    logger.error('auth', 'Failed to store OAuth tokens', { error: normalized.message });
                    authClient.clearTokens();
                    setStatus('unauthenticated');
                    setUser(null);
                    setError(normalized.message);
                    return;
                }

                setStatus('checking');
                setError(null);
                authClient.getCurrentUser(true)
                    .then((profile) => {
                        if (cancelled) return;
                        setUser(profile);
                        setStatus('authenticated');
                        setError(null);
                    })
                    .catch((err) => {
                        if (cancelled) return;
                        const normalized = normalizeAuthError(err);
                        logger.warn('auth', 'OAuth profile fetch failed', { error: normalized.message });
                        authClient.clearTokens();
                        setUser(null);
                        setStatus('unauthenticated');
                        setError(normalized.message);
                    });
            } else {
                logger.warn('auth', 'OAuth flow returned error', { provider: payload.provider, error: payload.error });
                authClient.clearTokens();
                setUser(null);
                setStatus('unauthenticated');
                setError(payload.error || 'OAuth authorization failed');
            }
        };

        const unsubscribe = window.api.auth.onOAuthPayload(handleOAuthPayload);
        window.api.auth.consumePendingOAuthPayloads().catch(() => {});

        return () => {
            cancelled = true;
            try {
                unsubscribe?.();
            } catch {
            }
        };
    }, []);

    const signIn = useCallback(async (email: string, password: string) => {
        setStatus('signing-in');
        setError(null);
        try {
            const profile = await authClient.login(email, password);
            setUser(profile);
            setStatus('authenticated');
            return profile;
        } catch (err) {
            const normalized = normalizeAuthError(err);
            setStatus('unauthenticated');
            setUser(null);
            setError(normalized.message);
            logger.error('auth', 'Sign-in failed', { error: normalized.message, status: normalized.status });
            throw normalized;
        }
    }, []);

    const startOAuth = useCallback(async (provider: OAuthProviderType) => {
        setError(null);
        setStatus('oauth');
        try {
            if (!window.api?.auth) {
                throw new AuthError('OAuth bridge unavailable');
            }
            await window.api.auth.startOAuth(provider);
        } catch (err) {
            const normalized = normalizeAuthError(err);
            logger.error('auth', 'Failed to initiate OAuth', { provider, error: normalized.message });
            setStatus('unauthenticated');
            setError(normalized.message);
            throw normalized;
        }
    }, []);

    const signOut = useCallback(() => {
        authClient.clearTokens();
        setUser(null);
        setStatus('unauthenticated');
        setError(null);
        logger.info('auth', 'User signed out');
    }, []);

    const reloadUser = useCallback(async () => {
        if (!authClient.hasTokens()) {
            authClient.clearTokens();
            setUser(null);
            setStatus('unauthenticated');
            return null;
        }

        setStatus('checking');
        try {
            const profile = await authClient.getCurrentUser(true);
            setUser(profile);
            setStatus('authenticated');
            setError(null);
            return profile;
        } catch (err) {
            const normalized = normalizeAuthError(err);
            logger.warn('auth', 'Failed to reload user', { error: normalized.message, status: normalized.status });
            authClient.clearTokens();
            setUser(null);
            setStatus('unauthenticated');
            setError(normalized.message);
            return null;
        }
    }, []);

    const clearError = useCallback(() => setError(null), []);

    const value = useMemo<AuthContextValue>(() => ({
        status,
        user,
        error,
        isAuthenticated: status === 'authenticated',
        signIn,
        startOAuth,
        signOut,
        reloadUser,
        clearError,
        isBusy:
            status === 'initializing' ||
            status === 'checking' ||
            status === 'signing-in' ||
            status === 'oauth',
    }), [status, user, error, signIn, startOAuth, signOut, reloadUser, clearError]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
