import {MouseEvent, useEffect, useMemo, useState} from 'react';
import {invokeNative as invoke} from '../bridge/nativeInvoke';
import {
    Box,
    Button,
    ButtonBase,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Stack,
    Typography,
} from '@mui/material';

type CommunityLink = {
    label: string;
    url: string;
    icon: string | string[];
};

type WelcomeDialogProps = {
    open: boolean;
    onClose: (options: { dismiss?: boolean }) => void;
};

const COMMUNITY_LINKS: CommunityLink[] = [
    {
        label: 'Website',
        url: 'https://artasov.github.io/xexamai/',
        icon: ['../../brand/logo_white.png', 'brand/logo_white.png'],
    },
    {
        label: 'X Community',
        url: 'https://x.com/i/communities/1978030402209034469',
        icon: 'img/icons/community/x.svg',
    },
    {
        label: 'Telegram',
        url: 'https://t.me/xexamai',
        icon: 'img/icons/community/telegram.svg',
    },
    {
        label: 'GitHub',
        url: 'https://github.com/Artasov/xexamai',
        icon: 'img/icons/community/github.svg',
    },
    {
        label: 'Pump.fun',
        url: 'https://pump.fun/coin/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/pumpfun.webp',
    },
    {
        label: 'Dexscreener',
        url: 'https://dexscreener.com/solana/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/dexscreener.svg',
    },
    {
        label: 'YouTube',
        url: 'https://www.youtube.com/watch?v=ilKcTjacg78',
        icon: 'img/icons/community/youtube.svg',
    },
    {
        label: 'LinkedIn',
        url: 'https://www.linkedin.com/in/xlartas',
        icon: 'img/icons/community/linkedin.svg',
    },
    {
        label: 'Discord',
        url: 'https://discord.gg/mcUKZmcB',
        icon: 'img/icons/community/discrod.svg',
    },
    {
        label: 'X Developer',
        url: 'https://x.com/xlartasov',
        icon: 'img/icons/community/x.svg',
    },
];

async function openLink(url: string) {
    try {
        await invoke('open_external_url', {url});
    } catch (error) {
        console.error('Failed to open link', {url, error});
    }
}

function CommunityTile({link}: { link: CommunityLink }) {
    const iconCandidates = useMemo(
        () => (Array.isArray(link.icon) ? link.icon : [link.icon]),
        [link.icon],
    );
    const [iconIndex, setIconIndex] = useState(0);
    const iconSrc = iconCandidates[Math.min(iconIndex, iconCandidates.length - 1)];

    const handleIconError = () => {
        setIconIndex((prev) => Math.min(prev + 1, iconCandidates.length - 1));
    };

    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        void openLink(link.url);
    };

    return (
        <Box component="div" sx={{width: '100%'}}>
            <ButtonBase
                onClick={handleClick}
                sx={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 1.5,
                    borderRadius: 3,
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                        backgroundColor: 'rgba(148, 163, 184, 0.12)',
                        borderColor: 'rgba(148, 163, 184, 0.35)',
                    },
                }}
            >
                <Box
                    component="img"
                    src={iconSrc}
                    alt={link.label}
                    onError={handleIconError}
                    sx={{
                        width: 32,
                        height: 32,
                        objectFit: 'contain',
                        filter: 'drop-shadow(0 4px 12px rgba(15,23,42,0.55))',
                    }}
                />
                <Typography variant="subtitle2" fontWeight={600} color="text.primary">
                    {link.label}
                </Typography>
            </ButtonBase>
        </Box>
    );
}

function WelcomeDialog({open, onClose}: WelcomeDialogProps) {
    const [dismiss, setDismiss] = useState(false);

    useEffect(() => {
        if (open) {
            setDismiss(false);
        }
    }, [open]);

    if (!open) {
        return null;
    }

    return (
        <Dialog open={open} onClose={() => onClose({dismiss})} maxWidth="md" fullWidth>
            <DialogTitle>
                <Typography variant="h5" component="h2">
                    Welcome to XEXAMAI
                </Typography>
                <Typography variant="body2" color="text.secondary" mt={1.5}>
                    You will find a complete guide on our website. Connect with the community, follow project updates,
                    and get the latest resources in one place.
                </Typography>
            </DialogTitle>
            <DialogContent dividers>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                            xs: 'repeat(1, minmax(0, 1fr))',
                            sm: 'repeat(2, minmax(0, 1fr))',
                            md: 'repeat(3, minmax(0, 1fr))',
                        },
                        gap: 1.5,
                    }}
                >
                    {COMMUNITY_LINKS.map((link) => (
                        <CommunityTile key={link.label} link={link}/>
                    ))}
                </Box>
            </DialogContent>
            <DialogActions sx={{flexDirection: 'column', alignItems: 'stretch', gap: 1.5}}>
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={dismiss}
                            onChange={(event) => setDismiss(event.target.checked)}
                            sx={{color: 'rgba(148, 163, 184, 0.7)'}}
                        />
                    }
                    label="Don't show again"
                    sx={{
                        alignSelf: 'stretch',
                        m: 0,
                        opacity: 1,
                    }}
                />
                <Stack direction="row" gap={1.5} alignSelf="stretch">
                    <Button
                        variant="outlined"
                        fullWidth
                        onClick={() => onClose({dismiss})}
                    >
                        Close
                    </Button>
                    <Button
                        variant="contained"
                        fullWidth
                        onClick={() => onClose({dismiss})}
                    >
                        Continue
                    </Button>
                </Stack>
            </DialogActions>
        </Dialog>
    );
}

export function WelcomeModal() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let active = true;
        void window.api.settings.get()
            .then((settings) => {
                if (active && !settings?.welcomeModalDismissed) setOpen(true);
            })
            .catch((error) => {
                console.warn('Unable to read welcome modal setting, falling back to showing the modal', error);
                if (active) setOpen(true);
            });
        return () => {
            active = false;
        };
    }, []);

    const handleClose = async (options: {dismiss?: boolean}) => {
        setOpen(false);
        if (!options.dismiss) return;
        try {
            await window.api.settings.setWelcomeModalDismissed(true);
        } catch (error) {
            console.error('Failed to persist welcome modal dismissal', error);
        }
    };

    return <WelcomeDialog open={open} onClose={handleClose}/>;
}
