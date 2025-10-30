import {useMemo} from 'react';
import {useAuth} from '../../../auth';

function formatFullName(user: ReturnType<typeof useAuth>['user']) {
    if (!user) return null;
    const parts = [user.first_name, user.middle_name, user.last_name].filter(Boolean);
    if (!parts.length) return null;
    return parts.join(' ');
}

export function ProfileView() {
    const {user, signOut} = useAuth();

    const fullName = useMemo(() => formatFullName(user), [user]);
    const initials = useMemo(() => {
        if (!user) return '';
        const source = fullName || user.email || user.username || '';
        return source
            .split(/[\s@._-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part.charAt(0)?.toUpperCase())
            .join('');
    }, [fullName, user]);

    if (!user) {
        return (
            <div className="card fccc gap-4 p-8 text-center">
                <p className="text-sm text-gray-400">User information is not available.</p>
            </div>
        );
    }

    return (
        <div className="fc gap-4">
            <div className="card fc gap-1 p-6 text-center">
                <div className={'frsc gap-4'}>
                    <div
                        className="frcc h-20 w-20 rounded-full border border-white/10 bg-white/5 text-2xl font-semibold">
                        {user.avatar ? <img className={'rounded-full'} src={user.avatar} alt=""/> : '👤'}
                    </div>
                    <div className={'fc gap-2'}>
                        <div className={'fcss gap-0'}>
                            <h2 className="text-xl font-semibold text-white">
                                {user.username || user.email}
                            </h2>
                            <p className="text-sm text-gray-400">{user.email}</p>
                        </div>
                        <div className="frcc flex-wrap gap-2 text-xs text-gray-300">
                            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1">
                                Email confirmed: {user.is_email_confirmed ? 'Yes' : 'No'}
                            </span>
                            {user.timezone ? (
                                <span className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-1">
                                    Timezone: {typeof user.timezone === 'string' ? user.timezone : 'Custom'}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
                <button className="btn btn-secondary ml-1 mt-2 px-4 py-2 w-fit" type="button" onClick={signOut}>
                    Log out
                </button>
            </div>

            {/*<div className="card grid gap-4 p-5 md:grid-cols-2">*/}
            {/*    <ProfileField label="Username" value={user.username} />*/}
            {/*    <ProfileField label="First name" value={user.first_name} />*/}
            {/*    <ProfileField label="Last name" value={user.last_name} />*/}
            {/*    <ProfileField label="Middle name" value={user.middle_name} />*/}
            {/*    <ProfileField label="Birth date" value={user.birth_date} emptyPlaceholder="Not set" />*/}
            {/*    <ProfileField label="Avatar" value={user.avatar} emptyPlaceholder="Not uploaded" />*/}
            {/*</div>*/}
        </div>
    );
}

type ProfileFieldProps = {
    label: string;
    value?: string | null;
    emptyPlaceholder?: string;
};

function ProfileField({label, value, emptyPlaceholder = '—'}: ProfileFieldProps) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-gray-400">{label}</span>
            <span className="rounded-md border border-white/5 bg-white/5 px-3 py-2 text-sm text-gray-100">
                {value && value.trim().length ? value : emptyPlaceholder}
            </span>
        </div>
    );
}

export default ProfileView;
