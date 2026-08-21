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
                    minHeight: 42,
                    gap: 1,
                    px: 1.25,
                    py: 0.65,
                    borderRadius: 2,
                    backgroundColor: 'rgba(255, 255, 255, 0.045)',
                    border: '1px solid rgba(148, 163, 184, 0.16)',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                        backgroundColor: 'rgba(148, 163, 184, 0.1)',
                        borderColor: 'rgba(148, 163, 184, 0.3)',
                    },
                }}
            >
                <Box
                    component="img"
                    src={iconSrc}
                    alt={link.label}
                    onError={handleIconError}
                    sx={{
                        width: 23,
                        height: 23,
                        flex: '0 0 23px',
                        objectFit: 'contain',
                        filter: 'drop-shadow(0 2px 6px rgba(15,23,42,0.5))',
                    }}
                />
                <Typography
                    noWrap
                    title={link.label}
                    variant="body2"
                    fontWeight={600}
                    color="text.primary"
                    sx={{minWidth: 0, fontSize: '0.78rem'}}
                >
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
            <DialogContent dividers sx={{px: 2, py: 1.5}}>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                            xs: 'repeat(2, minmax(0, 1fr))',
                            md: 'repeat(3, minmax(0, 1fr))',
                        },
                        gap: 0.75,
                    }}
                >
                    {COMMUNITY_LINKS.map((link) => (
                        <CommunityTile key={link.label} link={link}/>
                    ))}
                </Box>
            </DialogContent>
            <DialogActions
                sx={{
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    px: 2,
                    py: 1,
                }}
            >
                <FormControlLabel
                    control={
                        <Checkbox
                            size="small"
                            checked={dismiss}
                            onChange={(event) => setDismiss(event.target.checked)}
                            sx={{color: 'rgba(148, 163, 184, 0.7)', p: 0.75}}
                        />
                    }
                    label="Don't show again"
                    sx={{
                        m: 0,
                        opacity: 1,
                        '& .MuiFormControlLabel-label': {fontSize: '0.82rem'},
                    }}
                />
                <Button
                    variant="contained"
                    size="small"
                    onClick={() => onClose({dismiss})}
                    sx={{minWidth: 112, minHeight: 32}}
                >
                    Continue
                </Button>
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
