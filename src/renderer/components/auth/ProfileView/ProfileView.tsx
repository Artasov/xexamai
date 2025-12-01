import {useMemo} from 'react';
import {useAuth} from '../../../auth';
import {getActiveTier, getUserTiersAndFeatures} from '../../../utils/features';
import {IconButton, Tooltip} from "@mui/material";
import {Logout} from "@mui/icons-material";


function formatBalance(balance: string): string {
    const num = parseFloat(balance);
    if (isNaN(num)) return balance;
    return new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}).format(num);
}

export function ProfileView() {
    const {user, signOut} = useAuth();

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
            <div className="card fc gap-1 p-6 text-center">
                <div className={'frsc gap-4'}>
                    <div
                        className="frcc h-20 w-20 rounded-full border border-white/10 bg-white/5 text-2xl font-semibold">
                        {user.avatar ? <img className={'rounded-full'} src={user.avatar} alt=""/> : '👤'}
                    </div>
                    <div className={'fc gap-2'}>
                        <div className={'fcss gap-0'}>
                            <div className={'frcc'}>
                                <h2 className="text-xl font-semibold text-white">
                                    {user.username || user.email}
                                </h2>
                                <div className="frcc mt-2">
                                    <Tooltip title="Log out" arrow>
                                        <IconButton
                                            size={'small'}
                                            onClick={signOut}
                                            sx={{
                                                mb: '4px',
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
                            <p className="text-sm text-gray-400">{user.email}</p>
                        </div>
                        <div className="frcc flex-wrap gap-2 text-xs text-gray-300">
                            {user.is_email_confirmed &&
                                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1">
                                Email confirmed
                            </span>}
                            {user.timezone ? (
                                <span className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-1">
                                    Timezone: {typeof user.timezone === 'string' ? user.timezone : 'Custom'}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>

            {tiersAndFeatures ? (
                <div className="card fc gap-4 p-6">
                    <h3 className="text-lg font-semibold text-white">XEXAI Token & Tier</h3>
                    <div className="fc gap-3">
                        <div className="frbc gap-4 p-3 rounded-md border border-white/10 bg-white/5">
                            <span className="text-sm text-gray-400">Balance</span>
                            <span className="text-base font-semibold text-white">
                                {formatBalance((activeTierInfo?.balance) || '0')} {activeTierInfo?.ticker || ''}
                            </span>
                        </div>
                        <div className="frbc gap-4 p-3 rounded-md border border-white/10 bg-white/5">
                            <span className="text-sm text-gray-400">Active Tier</span>
                            <span className="text-base font-semibold text-white">
                                {activeTierInfo?.tier || 'No active tier'}
                            </span>
                        </div>
                        {tiersAndFeatures.active_tier?.description ? (
                            <p className="text-sm text-gray-400 italic">{tiersAndFeatures.active_tier.description}</p>
                        ) : null}
                    </div>
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
