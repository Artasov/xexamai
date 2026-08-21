import {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {shutdownRendererSession} from '../app/sessionShutdown';
import {authClient, AuthError, AuthUser} from '../services/authClient';
import {logger} from '../utils/logger';
import {setChatHistoryScope} from '../ui/outputs';
import type {AuthDeepLinkPayload, AuthProvider as OAuthProviderType} from '../types';
import {resolveAuthApiBaseUrl, setBackendDomain} from '@shared/appUrls';
import {hasFeatureAccess} from '../utils/features';
import {beginNativeRendererActivity} from '../state/rendererActivity';
import {ExclusiveAsyncActivity} from './exclusiveAsyncActivity';

type AuthStatus =
    | 'initializing'
    | 'checking'
    | 'restore-failed'
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
    cancelOAuth: () => Promise<void>;
    retrySessionRestore: () => Promise<void>;
    signOut: () => Promise<void>;
    reloadUser: (options?: {throwOnFailure?: boolean}) => Promise<AuthUser | null>;
    clearError: () => void;
    isBusy: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function normalizeAuthError(error: unknown): AuthError {
    if (error instanceof AuthError) return error;
    if (error instanceof Error) return new AuthError(error.message);
    return new AuthError(String(error ?? 'Unknown error'));
}

const isTerminalAuthError = (error: AuthError): boolean =>
    error.status === 400 || error.status === 401 || error.status === 403;

function applyHistoryScope(user: AuthUser | null): void {
    setChatHistoryScope(
        user?.id ?? null,
        authClient.getBackendOrigin(),
        hasFeatureAccess(user, 'history'),
    );
}

export function statusAfterOAuthExit(
    hasUser: boolean,
    hasTokens: boolean,
    previousStatus?: AuthStatus,
): AuthStatus {
    if (hasUser) return 'authenticated';
    // A failed session restore can leave a valid refresh credential in the OS
    // store while no access token exists in renderer memory. Cancelling an
    // alternative OAuth attempt must return to the recoverable Retry screen.
    if (previousStatus === 'restore-failed') return 'restore-failed';
    return hasTokens ? 'restore-failed' : 'unauthenticated';
}

export function AuthProvider({children}: {children: ReactNode}) {
    const [status, setStatus] = useState<AuthStatus>('initializing');
    const [user, setUser] = useState<AuthUser | null>(null);
    const [error, setError] = useState<string | null>(null);
    const operationRef = useRef(0);
    const userRef = useRef<AuthUser | null>(null);
    const oauthReturnStatusRef = useRef<AuthStatus>('unauthenticated');
    const oauthActivityRef = useRef<ExclusiveAsyncActivity | null>(null);
    if (!oauthActivityRef.current) {
        oauthActivityRef.current = new ExclusiveAsyncActivity('An OAuth sign-in attempt is already active');
    }

    useEffect(() => {
        userRef.current = user;
    }, [user]);

    const beginUiOperation = useCallback(() => {
        operationRef.current += 1;
        return operationRef.current;
    }, []);
    const isCurrent = useCallback((operation: number) => operationRef.current === operation, []);
    const statusAfterCancelledOAuth = useCallback((): AuthStatus => {
        return statusAfterOAuthExit(
            userRef.current !== null,
            authClient.hasTokens(),
            oauthReturnStatusRef.current,
        );
    }, []);
    const beginOAuthActivity = useCallback(async () => {
        await oauthActivityRef.current!.begin(() => beginNativeRendererActivity('OAuth sign-in'));
    }, []);
    const endOAuthActivity = useCallback(async () => {
        await oauthActivityRef.current!.end();
    }, []);

    useEffect(() => () => {
        void endOAuthActivity().catch((caught) => {
            logger.warn('auth', 'Failed to release OAuth activity during unmount', {
                error: normalizeAuthError(caught).message,
            });
        });
    }, [endOAuthActivity]);

    useEffect(() => authClient.subscribe((event) => {
        if (!['expired', 'domain-changed', 'signed-out'].includes(event)) return;
        void endOAuthActivity().catch((caught) => {
            logger.warn('auth', 'Failed to release interrupted OAuth activity', {
                error: normalizeAuthError(caught).message,
            });
        });
        beginUiOperation();
        applyHistoryScope(null);
        setUser(null);
        setStatus('unauthenticated');
        setError(event === 'expired' ? 'Your session expired. Please sign in again.' : null);
        if (event === 'expired') void shutdownRendererSession('session-expired');
        if (event === 'domain-changed') void shutdownRendererSession('domain-changed');
    }), [beginUiOperation, endOAuthActivity]);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const settings = await window.api?.settings?.get();
                if (settings?.backendDomain) {
                    setBackendDomain(settings.backendDomain);
                    authClient.setBaseUrl(resolveAuthApiBaseUrl(), {notify: false});
                }
            } catch (caught) {
                logger.warn('auth', 'Failed to load backend domain before session restore', {
                    error: normalizeAuthError(caught).message,
                });
            }
            if (!mounted) return;
            applyHistoryScope(null);
            const operation = beginUiOperation();
            try {
                const tokens = await authClient.initializeSession();
                if (!mounted || !isCurrent(operation)) return;
                if (!tokens?.access) {
                    applyHistoryScope(null);
                    setUser(null);
                    setStatus('unauthenticated');
                    setError(null);
                    return;
                }
                setStatus('checking');
                const profile = await authClient.getCurrentUser(true);
                if (!mounted || !isCurrent(operation)) return;
                applyHistoryScope(profile);
                setUser(profile);
                setStatus('authenticated');
                setError(null);
            } catch (caught) {
                if (!mounted || !isCurrent(operation)) return;
                const normalized = normalizeAuthError(caught);
                logger.warn('auth', 'Failed to restore session', {
                    error: normalized.message,
                    status: normalized.status,
                });
                const terminal = isTerminalAuthError(normalized);
                if (terminal) await authClient.logout(false);
                if (!mounted || !isCurrent(operation)) return;
                applyHistoryScope(null);
                setUser(null);
                setStatus(terminal ? 'unauthenticated' : 'restore-failed');
                setError(terminal ? null : normalized.message);
            }
        })();
        return () => {
            mounted = false;
        };
    }, [beginUiOperation, isCurrent]);

    useEffect(() => {
        if (!window.api?.auth) return;
        let mounted = true;

        const handleOAuthPayload = async (payload: AuthDeepLinkPayload) => {
            if (!mounted || !payload) return;
            if (payload.kind === 'error') {
                // A failed replacement flow must never clear a valid current session.
                await endOAuthActivity().catch((caught) => {
                    logger.warn('auth', 'Failed to release rejected OAuth activity', {
                        error: normalizeAuthError(caught).message,
                    });
                });
                logger.warn('auth', 'OAuth flow returned an error', {provider: payload.provider});
                setStatus(statusAfterCancelledOAuth());
                setError(payload.error || 'OAuth authorization failed');
                return;
            }

            const operation = beginUiOperation();
            logger.info('auth', 'OAuth session is ready', {provider: payload.provider});
            setStatus('checking');
            setError(null);
            try {
                const tokens = await authClient.adoptOAuthSession();
                if (!mounted || !isCurrent(operation)) return;
                if (!tokens?.access) throw new AuthError('OAuth session was not stored');
                const profile = await authClient.getCurrentUser(true);
                if (!mounted || !isCurrent(operation)) return;
                applyHistoryScope(profile);
                setUser(profile);
                setStatus('authenticated');
                setError(null);
            } catch (caught) {
                if (!mounted || !isCurrent(operation)) return;
                const normalized = normalizeAuthError(caught);
                logger.warn('auth', 'OAuth profile fetch failed', {error: normalized.message});
                const terminal = isTerminalAuthError(normalized);
                if (terminal) await authClient.logout(false);
                if (!mounted || !isCurrent(operation)) return;
                applyHistoryScope(null);
                setUser(null);
                setStatus(!terminal && authClient.hasTokens() ? 'restore-failed' : 'unauthenticated');
                setError(normalized.message);
            } finally {
                await endOAuthActivity().catch((caught) => {
                    logger.warn('auth', 'Failed to release completed OAuth activity', {
                        error: normalizeAuthError(caught).message,
                    });
                });
            }
        };

        const unsubscribe = window.api.auth.onOAuthPayload((payload) => {
            void handleOAuthPayload(payload);
        });
        void window.api.auth.consumePendingOAuthPayloads()
            .then((payloads) => Promise.allSettled(payloads.map(handleOAuthPayload)))
            .catch((caught) => {
                logger.warn('auth', 'Failed to consume pending OAuth callbacks', {
                    error: normalizeAuthError(caught).message,
                });
            });

        return () => {
            mounted = false;
            unsubscribe?.();
        };
    }, [beginUiOperation, endOAuthActivity, isCurrent, statusAfterCancelledOAuth]);

    const signIn = useCallback(async (email: string, password: string) => {
        const returnStatus = status === 'restore-failed' ? 'restore-failed' : 'unauthenticated';
        const operation = beginUiOperation();
        setStatus('signing-in');
        setError(null);
        try {
            const profile = await authClient.login(email, password);
            if (!isCurrent(operation)) throw new AuthError('Authentication operation was superseded');
            applyHistoryScope(profile);
            setUser(profile);
            setStatus('authenticated');
            return profile;
        } catch (caught) {
            const normalized = normalizeAuthError(caught);
            if (isCurrent(operation)) {
                applyHistoryScope(null);
                setStatus(statusAfterOAuthExit(
                    false,
                    authClient.hasTokens(),
                    normalized.sessionEstablished ? undefined : returnStatus,
                ));
                setUser(null);
                setError(normalized.message);
            }
            logger.error('auth', 'Sign-in failed', {error: normalized.message, status: normalized.status});
            throw normalized;
        }
    }, [beginUiOperation, isCurrent, status]);

    const startOAuth = useCallback(async (provider: OAuthProviderType) => {
        if (oauthActivityRef.current!.active) {
            throw new AuthError('An OAuth sign-in attempt is already active');
        }
        const returnStatus: AuthStatus = userRef.current !== null
            ? 'authenticated'
            : status === 'restore-failed'
                ? 'restore-failed'
                : 'unauthenticated';
        setError(null);
        let activityStarted = false;
        try {
            await beginOAuthActivity();
            activityStarted = true;
            oauthReturnStatusRef.current = returnStatus;
            setStatus('oauth');
            if (!window.api?.auth) throw new AuthError('OAuth bridge unavailable');
            await window.api.auth.startOAuth(provider);
        } catch (caught) {
            const normalized = normalizeAuthError(caught);
            if (activityStarted) {
                await endOAuthActivity().catch((releaseError) => {
                    logger.warn('auth', 'Failed to release OAuth activity after start failure', {
                        error: normalizeAuthError(releaseError).message,
                    });
                });
            }
            logger.error('auth', 'Failed to initiate OAuth', {provider, error: normalized.message});
            setStatus(statusAfterOAuthExit(
                userRef.current !== null,
                authClient.hasTokens(),
                returnStatus,
            ));
            setError(normalized.message);
            throw normalized;
        }
    }, [beginOAuthActivity, endOAuthActivity, status, statusAfterCancelledOAuth]);

    const cancelOAuth = useCallback(async () => {
        beginUiOperation();
        try {
            await window.api?.auth?.cancelPendingOAuth();
        } catch (caught) {
            logger.warn('auth', 'Failed to cancel pending OAuth attempts', {
                error: normalizeAuthError(caught).message,
            });
        } finally {
            await endOAuthActivity().catch((caught) => {
                logger.warn('auth', 'Failed to release cancelled OAuth activity', {
                    error: normalizeAuthError(caught).message,
                });
            });
        }
        setStatus(statusAfterCancelledOAuth());
        setError(null);
    }, [beginUiOperation, endOAuthActivity, statusAfterCancelledOAuth]);

    const retrySessionRestore = useCallback(async () => {
        const operation = beginUiOperation();
        setStatus('checking');
        setError(null);
        try {
            const tokens = await authClient.initializeSession();
            if (!isCurrent(operation)) return;
            if (!tokens?.access) {
                applyHistoryScope(null);
                setUser(null);
                setStatus('unauthenticated');
                return;
            }
            const profile = await authClient.getCurrentUser(true);
            if (!isCurrent(operation)) return;
            applyHistoryScope(profile);
            setUser(profile);
            setStatus('authenticated');
            setError(null);
        } catch (caught) {
            if (!isCurrent(operation)) return;
            const normalized = normalizeAuthError(caught);
            const terminal = isTerminalAuthError(normalized);
            if (terminal) await authClient.logout(false);
            if (!isCurrent(operation)) return;
            applyHistoryScope(null);
            setUser(null);
            setStatus(terminal ? 'unauthenticated' : 'restore-failed');
            setError(terminal ? null : normalized.message);
        }
    }, [beginUiOperation, isCurrent]);

    const signOut = useCallback(async () => {
        beginUiOperation();
        await endOAuthActivity().catch((caught) => {
            logger.warn('auth', 'Failed to release OAuth activity before sign-out', {
                error: normalizeAuthError(caught).message,
            });
        });
        applyHistoryScope(null);
        setUser(null);
        setStatus('unauthenticated');
        setError(null);
        await shutdownRendererSession('sign-out');
        await authClient.logout();
        logger.info('auth', 'User signed out');
    }, [beginUiOperation, endOAuthActivity]);

    const reloadUser = useCallback(async (options?: {throwOnFailure?: boolean}) => {
        const operation = beginUiOperation();
        const previousUser = user;
        const preserveAuthenticatedUi = previousUser !== null && status === 'authenticated';
        if (!authClient.hasTokens()) {
            applyHistoryScope(null);
            setUser(null);
            setStatus('unauthenticated');
            return null;
        }
        if (!preserveAuthenticatedUi) setStatus('checking');
        try {
            const profile = await authClient.getCurrentUser(true);
            if (!isCurrent(operation)) return null;
            applyHistoryScope(profile);
            setUser(profile);
            setStatus('authenticated');
            setError(null);
            return profile;
        } catch (caught) {
            const normalized = normalizeAuthError(caught);
            const terminal = isTerminalAuthError(normalized);
            if (terminal) await authClient.logout(false);
            if (!isCurrent(operation)) return null;
            if (!terminal && preserveAuthenticatedUi) {
                setUser(previousUser);
                setStatus('authenticated');
                setError(normalized.message);
                if (options?.throwOnFailure) throw normalized;
                return previousUser;
            }
            applyHistoryScope(null);
            setUser(null);
            setStatus('unauthenticated');
            setError(normalized.message);
            if (options?.throwOnFailure) throw normalized;
            return null;
        }
    }, [beginUiOperation, isCurrent, status, user]);

    // Start at zero so returning from a purchase/upgrade flow immediately after
    // sign-in still refreshes the authoritative entitlement snapshot. The short
    // debounce only coalesces the paired focus/visibility events browsers emit.
    const backgroundRefreshAt = useRef(0);
    const backgroundRefreshInFlight = useRef(false);
    useEffect(() => {
        if (status !== 'authenticated') return;
        const refreshIfStale = async () => {
            if (
                backgroundRefreshInFlight.current ||
                Date.now() - backgroundRefreshAt.current < 5_000
            ) return;
            backgroundRefreshInFlight.current = true;
            try {
                await reloadUser();
                backgroundRefreshAt.current = Date.now();
            } finally {
                backgroundRefreshInFlight.current = false;
            }
        };
        const onFocus = () => void refreshIfStale();
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void refreshIfStale();
        };
        const interval = window.setInterval(() => {
            if (document.visibilityState === 'visible') void refreshIfStale();
        }, 5 * 60_000);
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [reloadUser, status]);

    const clearError = useCallback(() => setError(null), []);
    const value = useMemo<AuthContextValue>(() => ({
        status,
        user,
        error,
        isAuthenticated: status === 'authenticated',
        signIn,
        startOAuth,
        cancelOAuth,
        retrySessionRestore,
        signOut,
        reloadUser,
        clearError,
        isBusy: ['initializing', 'checking', 'signing-in', 'oauth'].includes(status),
    }), [status, user, error, signIn, startOAuth, cancelOAuth, retrySessionRestore, signOut, reloadUser, clearError]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth must be used within an AuthProvider');
    return context;
}
