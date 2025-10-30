import {FormEvent, useCallback, useEffect, useMemo, useState} from 'react';
import {useAuth} from '../../../auth';
import type {AuthProvider as OAuthProviderType} from '../../../types';
import GoogleIcon from '@mui/icons-material/Google';
import GitHubIcon from '@mui/icons-material/GitHub';
import TwitterIcon from '@mui/icons-material/Twitter';
import SvgIcon, {SvgIconProps} from '@mui/material/SvgIcon';
import {WindowResizer} from '../../common/WindowResizer/WindowResizer';

function DiscordIcon(props: SvgIconProps) {
    return (
        <SvgIcon {...props} viewBox="0 0 24 24">
            <path d="M20.32 4.37A17.22 17.22 0 0 0 15.54 3l-.55 1.17a15.61 15.61 0 0 0-5-.01L9.43 3a16.97 16.97 0 0 0-4.78 1.35 18.45 18.45 0 0 0-2.97 12.4 16.41 16.41 0 0 0 5.84 2.96l.82-2.65-1.37-.46.36-1.16c1.47.49 2.94.73 4.4.73 1.46 0 2.93-.24 4.4-.73l.37 1.16-1.38.46.82 2.65a16.4 16.4 0 0 0 5.84-2.96 18.46 18.46 0 0 0-2.94-12.37zM8.88 14.47c-.85 0-1.54-.82-1.54-1.83s.69-1.82 1.54-1.82c.85 0 1.54.82 1.54 1.82 0 1.01-.69 1.83-1.54 1.83zm6.24 0c-.85 0-1.54-.82-1.54-1.83s.69-1.82 1.54-1.82 1.54.82 1.54 1.82-.69 1.83-1.54 1.83z" />
        </SvgIcon>
    );
}

export function LoginView() {
    const { signIn, startOAuth, status, error, clearError } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [localError, setLocalError] = useState<string | null>(null);
    const [oauthProvider, setOauthProvider] = useState<OAuthProviderType | null>(null);

    const isSubmitting = status === 'signing-in';
    const isOAuthInProgress = status === 'oauth';
    const formDisabled = isSubmitting;

    const oauthProviders = useMemo(
        () => [
            {
                id: 'google' as OAuthProviderType,
                label: 'Sign in with Google',
                className: 'oauth-button--google',
                Icon: GoogleIcon,
            },
            {
                id: 'github' as OAuthProviderType,
                label: 'Sign in with GitHub',
                className: 'oauth-button--github',
                Icon: GitHubIcon,
            },
            {
                id: 'discord' as OAuthProviderType,
                label: 'Sign in with Discord',
                className: 'oauth-button--discord',
                Icon: DiscordIcon,
            },
            {
                id: 'twitter' as OAuthProviderType,
                label: 'Sign in with X (Twitter)',
                className: 'oauth-button--twitter',
                Icon: TwitterIcon,
            },
        ],
        [],
    );

    const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setLocalError(null);

        if (!email.trim() || !password.trim()) {
            setLocalError('Please fill in both fields');
            return;
        }

        try {
            await signIn(email.trim(), password);
        } catch {
            // error is handled via context state
        }
    }, [email, password, signIn]);

    const handleOAuth = useCallback(async (provider: OAuthProviderType) => {
        setLocalError(null);
        clearError();
        setOauthProvider(provider);
        try {
            await startOAuth(provider);
        } catch (err) {
            setOauthProvider(null);
            const message = err instanceof Error ? err.message : 'Failed to start OAuth flow';
            setLocalError(message);
        }
    }, [clearError, startOAuth]);

    useEffect(() => {
        if (status !== 'oauth') {
            setOauthProvider(null);
        }
    }, [status]);

    const handleClose = useCallback(() => {
        try {
            window.api?.window?.close();
        } catch {
        }
    }, []);

    const combinedError = localError || error;

    return (
        <div className="relative h-screen min-w-[330px] text-gray-100">
            <WindowResizer />
            <div
                className="rainbow pointer-events-none"
                style={{ position: 'absolute', width: '520px', height: '520px' }}
            />

            <header className="drag-region absolute top-0 left-0 right-0 flex items-center justify-between px-3 py-2" style={{ zIndex: 5 }}>
                <div className="frsc pointer-events-none gap-2">
                    <div className="relative" style={{ width: '32px', height: '32px' }}>
                        <img
                            src="brand/logo_white.png"
                            alt="xexamai"
                            className="absolute inset-0 h-full w-full"
                            onError={(event) => {
                                const target = event.currentTarget;
                                if (target.src.includes('brand/logo_white.png')) {
                                    target.src = '../../brand/logo_white.png';
                                } else {
                                    target.style.display = 'none';
                                }
                            }}
                        />
                        <div
                            className="rainbow"
                            style={{ position: 'absolute', top: 0, left: 0, filter: 'blur(25px) saturate(1.5)' }}
                        />
                    </div>
                    <h1 className="text-lg font-semibold">xexamai</h1>
                </div>
                <div className="window-controls no-drag -mr-1 flex items-center">
                    <button
                        className="close mr-[11px]"
                        title="Close"
                        type="button"
                        onClick={handleClose}
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" fill="none" />
                        </svg>
                    </button>
                </div>
            </header>

            <div className="disable-tap-select relative flex h-full flex-col items-center justify-center gap-6 px-6" style={{ zIndex: 4 }}>
                <div className="fccc pointer-events-none gap-2 text-center">
                    <img
                        src="brand/logo_white.png"
                        alt="xexamai"
                        className="w-28 opacity-90"
                        onError={(event) => {
                            const target = event.currentTarget;
                            if (target.src.includes('brand/logo_white.png')) {
                                target.src = '../../brand/logo_white.png';
                            } else {
                                target.style.display = 'none';
                            }
                        }}
                    />
                    <div className="text-2xl font-semibold tracking-wide">Welcome back</div>
                    <p className="text-sm text-gray-400">Sign in with your account to continue</p>
                </div>

                <form
                    className="card flex w-full max-w-[360px] flex-col gap-4 bg-black/30 p-6"
                    onSubmit={handleSubmit}
                >
                    <div className="flex flex-col gap-2">
                        <label className="text-sm text-gray-300" htmlFor="auth-email">
                            Email
                        </label>
                        <input
                            id="auth-email"
                            type="email"
                            autoComplete="email"
                            className="input-field w-full bg-gray-800/70"
                            placeholder="name@example.com"
                            value={email}
                            onChange={(event) => {
                                if (combinedError) {
                                    clearError();
                                    setLocalError(null);
                                }
                                setEmail(event.target.value);
                            }}
                            disabled={isSubmitting}
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="text-sm text-gray-300" htmlFor="auth-password">
                            Password
                        </label>
                        <input
                            id="auth-password"
                            type="password"
                            autoComplete="current-password"
                            className="input-field w-full bg-gray-800/70"
                            placeholder="••••••••"
                            value={password}
                            onChange={(event) => {
                                if (combinedError) {
                                    clearError();
                                    setLocalError(null);
                                }
                                setPassword(event.target.value);
                            }}
                            disabled={isSubmitting}
                        />
                    </div>

                    {combinedError ? (
                        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                            {combinedError}
                        </div>
                    ) : null}

                    <button
                        className="btn btn-primary mt-2 py-2 text-base"
                        type="submit"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? 'Signing in…' : 'Sign In'}
                    </button>

                    <div className="flex flex-col gap-3">
                        <div className="text-xs uppercase tracking-wide text-gray-400">Or continue with</div>
                        <div className="flex items-center gap-3">
                            {oauthProviders.map((provider) => {
                                const isActive = oauthProvider === provider.id && isOAuthInProgress;
                                const IconComponent = provider.Icon;
                                return (
                                    <button
                                        key={provider.id}
                                        type="button"
                                        className={`oauth-button ${provider.className} ${isActive ? 'oauth-button--active' : ''}`}
                                        disabled={isSubmitting}
                                        onClick={() => handleOAuth(provider.id)}
                                        aria-label={provider.label}
                                        title={provider.label}
                                    >
                                        <IconComponent fontSize="small" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {isOAuthInProgress ? (
                        <div className="rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200">
                            Finish authentication in your browser. This window will update automatically once the flow completes.
                        </div>
                    ) : null}
                </form>

                <p className="text-xs text-gray-500">
                    API: <span className="font-mono text-gray-300">http://localhost:8000</span>
                </p>
            </div>
        </div>
    );
}

export default LoginView;
