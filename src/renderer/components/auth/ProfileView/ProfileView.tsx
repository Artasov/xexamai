import {useCallback, useMemo, useRef, useState} from 'react';
import {useAuth} from '../../../auth';
import {getActiveTier, getUserTiersAndFeatures} from '../../../utils/features';
import {IconButton, Tooltip} from '@mui/material';
import {Logout, Refresh} from '@mui/icons-material';


function formatBalance(balance: string): string {
    const num = parseFloat(balance);
    if (isNaN(num)) return balance;
    return new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}).format(num);
}

export function ProfileView() {
    const {user, signOut, reloadUser} = useAuth();
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const refreshInFlight = useRef(false);

    const refreshProfile = useCallback(async () => {
        if (refreshInFlight.current) return;
        refreshInFlight.current = true;
        setRefreshing(true);
        setRefreshError(null);
        try {
            const refreshed = await reloadUser({throwOnFailure: true});
            if (!refreshed) setRefreshError('Could not refresh account information.');
        } catch (caught) {
            setRefreshError(caught instanceof Error ? caught.message : 'Could not refresh account information.');
        } finally {
            refreshInFlight.current = false;
            setRefreshing(false);
        }
    }, [reloadUser]);

    const tiersAndFeatures = useMemo(() => getUserTiersAndFeatures(user), [user]);
    const activeTierInfo = useMemo(() => getActiveTier(user), [user]);

    if (!user) {
        return (
            <div className="card fccc gap-4 p-8 text-center">
                <p className="text-sm text-gray-400">User information is not available.</p>
            </div>
        );
    }

    return (
        <div className="fc gap-2">
            <div className="card p-4">
                <div className="flex items-center gap-3">
                    <div
                        className="frcc h-16 w-16 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/5 text-xl font-semibold">
                        {user.avatar ? (
                            <img className="h-full w-full object-cover" src={user.avatar} alt=""/>
                        ) : '👤'}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                            <h2 className="truncate text-lg font-semibold leading-tight text-white">
                                {user.username || user.email}
                            </h2>
                            <div className="flex shrink-0 items-center gap-0.5">
                                    <Tooltip title="Refresh account" arrow>
                                        <span>
                                            <IconButton
                                                size="small"
                                                disabled={refreshing}
                                                onClick={() => void refreshProfile()}
                                                aria-label="Refresh account"
                                                sx={{
                                                    p: 0.5,
                                                    color: 'rgba(255, 255, 255, 0.7)',
                                                    '&:hover': {
                                                        color: 'rgba(255, 255, 255, 0.9)',
                                                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                                    },
                                                }}
                                            >
                                                <Refresh
                                                    className={refreshing ? 'animate-spin' : undefined}
                                                    sx={{
                                                        width: 16,
                                                        height: 16,
                                                    }}
                                                />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                    <Tooltip title="Log out" arrow>
                                        <IconButton
                                            size={'small'}
                                            onClick={signOut}
                                            aria-label="Log out"
                                            sx={{
                                                p: 0.5,
                                                color: 'rgba(255, 255, 255, 0.7)',
                                                '&:hover': {
                                                    color: 'rgba(255, 255, 255, 0.9)',
                                                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                                },
                                            }}
                                        >
                                            <Logout sx={{width: 16, height: 16}}/>
                                        </IconButton>
                                    </Tooltip>
                            </div>
                        </div>
                        <p className="mt-1 truncate text-sm text-gray-400">{user.email}</p>
                        {refreshError ? <p className="mt-1 text-xs text-amber-300">{refreshError}</p> : null}
                    </div>
                </div>
            </div>

            {tiersAndFeatures ? (
                <div className="card fc gap-2.5 p-4">
                    <h3 className="text-base font-semibold text-white">XEXAI Token & Tier</h3>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="min-w-0 rounded-md border border-white/10 bg-white/5 px-3 py-2">
                            <span className="block text-xs text-gray-400">Balance</span>
                            <span className="mt-0.5 block truncate text-sm font-semibold text-white">
                                {formatBalance((activeTierInfo?.balance) || '0')} {activeTierInfo?.ticker || ''}
                            </span>
                        </div>
                        <div className="min-w-0 rounded-md border border-white/10 bg-white/5 px-3 py-2">
                            <span className="block text-xs text-gray-400">Active Tier</span>
                            <span className="mt-0.5 block truncate text-sm font-semibold text-white">
                                {activeTierInfo?.tier || 'No active tier'}
                            </span>
                        </div>
                    </div>
                    {tiersAndFeatures.active_tier?.description ? (
                        <p className="text-xs text-gray-400 italic">{tiersAndFeatures.active_tier.description}</p>
                    ) : null}
                </div>
            ) : null}

            {tiersAndFeatures ? (
                <div className="card fc gap-4 p-6">
                    <h3 className="text-lg font-semibold text-white">Available Features</h3>
                    <div className="fc gap-2">
                        {tiersAndFeatures.feature_schema?.map((feature) => {
                            const isEnabled = tiersAndFeatures.active_features?.[feature.code as keyof typeof tiersAndFeatures.active_features] === true;
                            return (
                                <div key={feature.id}
                                     className="frbc gap-4 p-3 rounded-md border border-white/10 bg-white/5">
                                    <div className="fc gap-1">
                                        <span className="text-sm font-medium text-white">{feature.label}</span>
                                        {feature.description ? (
                                            <span className="text-xs text-gray-400">{feature.description}</span>
                                        ) : null}
                                    </div>
                                    <span
                                        className={`text-sm font-semibold ${isEnabled ? 'text-emerald-400' : 'text-gray-500'}`}>
                                        {isEnabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

        </div>
    );
}
